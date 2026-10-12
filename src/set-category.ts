import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import { isDateInRange, parseDateRange, type DateRange } from "./date-range.js";

type Target = {
  description: string;
  account: string;
  amount: number;
  largeCategory: string;
  middleCategory: string;
};

type Transaction = {
  id: string;
  date: string;
  description: string;
  accountName: string;
  amount: number;
  month: string;
  largeCategory: string;
  middleCategory: string;
};

type HistoryScan = {
  transactions: Transaction[];
  complete: boolean;
  stopReason: string | null;
};

const cashFlowUrl = "https://moneyforward.com/cf";
const updateUrl = new URL("https://moneyforward.com/cf/update");
const authStatePath = fileURLToPath(new URL("../data/auth-state.json", import.meta.url));

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "");
}

function getTarget(arguments_: string[]): Target {
  const options = new Map<string, string>();
  for (const argument of arguments_) {
    const separator = argument.indexOf("=");
    if (separator < 0) continue;
    const key = argument.slice(0, separator);
    if (options.has(key)) throw new Error(`${key} は1回だけ指定できます。`);
    options.set(key, argument.slice(separator + 1));
  }

  const description = options.get("--description")?.trim() ?? "";
  const account = options.get("--account")?.trim() ?? "";
  const amountText = options.get("--amount")?.replaceAll(",", "").trim() ?? "";
  const largeCategory = options.get("--large-category")?.trim() ?? "";
  const middleCategory = options.get("--middle-category")?.trim() ?? "";
  const amount = Number(amountText);
  if (!description || !account || !amountText || !Number.isSafeInteger(amount) || amount === 0) {
    throw new Error("--description、--account、--amount（0以外の整数円）を指定してください。");
  }
  if (!largeCategory || !middleCategory) {
    throw new Error("--large-category と --middle-category を指定してください。");
  }
  return { description, account, amount, largeCategory, middleCategory };
}

async function getDisplayedMonth(page: Page): Promise<string> {
  await page.waitForFunction(
    () => /^\d{4}\/\d{1,2}\/\d{1,2}\s+-/.test(
      document.querySelector(".fc-header-title.in-out-header-title")?.textContent?.trim() ?? "",
    ),
    undefined,
    { timeout: 15000 },
  );
  const title = (await page.locator(".fc-header-title.in-out-header-title").innerText()).trim();
  const match = title.match(/^(\d{4})\/(\d{1,2})\/\d{1,2}\s+-/);
  if (!match) throw new Error("家計簿の表示月を確認できません。");
  return `${match[1]}-${match[2].padStart(2, "0")}`;
}

async function moveOneMonth(page: Page, direction: "previous" | "next"): Promise<string | null> {
  const selector = direction === "previous" ? "button.fc-button-prev, span.fc-button-prev" : "button.fc-button-next, span.fc-button-next";
  const button = page.locator(selector).first();
  if ((await button.count()) === 0) throw new Error("家計簿の月移動ボタンが見つかりません。");
  const [className, disabled, ariaDisabled] = await Promise.all([
    button.getAttribute("class"),
    button.getAttribute("disabled"),
    button.getAttribute("aria-disabled"),
  ]);
  if (direction === "previous" && (disabled !== null || ariaDisabled === "true" || className?.includes("fc-state-disabled"))) {
    return null;
  }

  const currentMonth = await getDisplayedMonth(page);
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/cf/fetch") && response.status() === 200,
    { timeout: 15000 },
  );
  await button.click();
  const response = await responsePromise;
  const failure = await response.finished();
  if (failure) throw failure;
  const nextMonth = await getDisplayedMonth(page);
  if (direction === "previous" ? nextMonth >= currentMonth : nextMonth <= currentMonth) {
    throw new Error("家計簿の月を移動できません。");
  }
  return nextMonth;
}

async function navigateToMonth(page: Page, targetMonth: string): Promise<void> {
  let currentMonth = await getDisplayedMonth(page);
  for (let attempt = 0; currentMonth !== targetMonth && attempt < 1200; attempt++) {
    const nextMonth = await moveOneMonth(page, currentMonth > targetMonth ? "previous" : "next");
    if (!nextMonth) throw new Error("対象月より前に利用可能な明細期間が終了しました。");
    currentMonth = nextMonth;
  }
  if (currentMonth !== targetMonth) throw new Error("対象月へ移動できません。");
}

function parseDate(dateText: string, displayedMonth: string): string | null {
  const normalizedDate = normalize(dateText);
  const [, displayedYear, displayedMonthNumber] = displayedMonth.match(/^(\d{4})-(\d{2})$/) ?? [];
  const fullDate = normalizedDate.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (fullDate) return `${fullDate[1]}-${fullDate[2].padStart(2, "0")}-${fullDate[3].padStart(2, "0")}`;

  const shortDate = normalizedDate.match(/^(\d{1,2})\/(\d{1,2})/);
  if (!shortDate) return null;
  let year = Number(displayedYear);
  const month = Number(shortDate[1]);
  const displayMonth = Number(displayedMonthNumber);
  if (month - displayMonth > 6) year--;
  if (displayMonth - month > 6) year++;
  const date = new Date(Date.UTC(year, month - 1, Number(shortDate[2])));
  if (date.getUTCMonth() !== month - 1) return null;
  return `${year}-${String(month).padStart(2, "0")}-${String(shortDate[2]).padStart(2, "0")}`;
}

async function readTransaction(row: Locator, month: string): Promise<Transaction | null> {
  const rowId = await row.getAttribute("id");
  if (!rowId?.startsWith("js-transaction-")) return null;
  const cells = row.locator("td");
  if ((await cells.count()) < 9) throw new Error("明細行の列数が想定と異なります。");
  const [dateText, description, amountText, accountName, largeCategory, middleCategory] = await Promise.all([
    cells.nth(1).innerText(),
    cells.nth(2).innerText(),
    cells.nth(3).innerText(),
    getAccountName(cells.nth(4)),
    row.locator(".v_l_ctg").innerText(),
    row.locator(".v_m_ctg").innerText(),
  ]);
  const date = parseDate(dateText, month);
  const amountDigits = (normalize(amountText).match(/[\d,]+/) ?? [""])[0].replace(/\D/g, "");
  if (!date || !amountDigits) throw new Error("明細の日付または金額を確認できません。");
  return {
    id: rowId.slice("js-transaction-".length),
    date,
    description: description.trim(),
    accountName,
    amount: (/-|−|▲|△/.test(normalize(amountText)) ? -1 : 1) * Number(amountDigits),
    month,
    largeCategory: largeCategory.replace(/\s+/g, " ").trim(),
    middleCategory: middleCategory.replace(/\s+/g, " ").trim(),
  };
}

async function getAccountName(cell: Locator): Promise<string> {
  const transferBox = cell.locator(".transfer_account_box");
  if ((await transferBox.count()) > 0) return (await transferBox.innerText()).trim();
  const accountLabel = cell.locator("div.noform span");
  if ((await accountLabel.count()) > 0) return (await accountLabel.first().innerText()).trim();
  return (await cell.innerText()).trim();
}

function matches(transaction: Transaction, target: Target, dateRange: DateRange): boolean {
  return (
    isDateInRange(transaction.date, dateRange) &&
    normalize(transaction.description) === normalize(target.description) &&
    normalize(transaction.accountName) === normalize(target.account) &&
    transaction.amount === target.amount
  );
}

async function collectMonth(page: Page, month: string, target: Target, dateRange: DateRange): Promise<Transaction[]> {
  const rows = page.locator("#cf-detail-table tbody tr[id^='js-transaction-']");
  const transactions: Transaction[] = [];
  for (let index = 0; index < (await rows.count()); index++) {
    const row = rows.nth(index);
    if ((await row.locator(".v_m_ctg").count()) !== 1) continue;
    const transaction = await readTransaction(row, month);
    if (transaction && matches(transaction, target, dateRange)) transactions.push(transaction);
  }
  return transactions;
}

async function collectHistory(page: Page, target: Target, dateRange: DateRange): Promise<HistoryScan> {
  let displayedMonth = await getDisplayedMonth(page);
  const latestMonth = dateRange.to.slice(0, 7);
  if (displayedMonth > latestMonth) {
    await navigateToMonth(page, latestMonth);
    displayedMonth = latestMonth;
  }
  const earliestMonth = dateRange.from?.slice(0, 7) ?? null;
  const transactions: Transaction[] = [];
  const seenIds = new Set<string>();
  let scannedMonths = 0;
  let stopReason: string | null = null;
  while (earliestMonth === null || displayedMonth >= earliestMonth) {
    scannedMonths++;
    for (const transaction of await collectMonth(page, displayedMonth, target, dateRange)) {
      if (seenIds.has(transaction.id)) throw new Error("同じ明細IDが複数月に現れたため停止しました。");
      seenIds.add(transaction.id);
      transactions.push(transaction);
    }
    console.log(JSON.stringify({ scannedMonth: displayedMonth, scannedMonths, matchedCount: transactions.length, operation: "dry-run-progress" }));
    if (displayedMonth === earliestMonth) break;
    try {
      const previousMonth = await moveOneMonth(page, "previous");
      if (!previousMonth) break;
      displayedMonth = previousMonth;
    } catch (error: unknown) {
      stopReason = error instanceof Error ? error.message : "前月へ移動できませんでした。";
      break;
    }
  }
  transactions.sort((left, right) => left.date.localeCompare(right.date));
  return { transactions, complete: stopReason === null, stopReason };
}

async function findRowById(page: Page, id: string): Promise<Locator | null> {
  const rows = page.locator(`#cf-detail-table tbody tr#js-transaction-${id}`);
  return (await rows.count()) === 1 ? rows.first() : null;
}

async function chooseMiddleCategory(
  page: Page,
  row: Locator,
  transaction: Transaction,
  target: Target,
): Promise<void> {
  const form = row.locator("form.new_user_asset_act");
  const transactionId = await form.locator("input[name='user_asset_act[id]']").inputValue();
  const action = await form.getAttribute("action");
  const formUrl = action ? new URL(action, page.url()) : null;
  if (transactionId !== transaction.id || formUrl?.origin !== updateUrl.origin || formUrl.pathname !== updateUrl.pathname) {
    throw new Error("分類更新フォームのIDまたはURLが想定と異なります。");
  }

  await row.locator(".v_l_ctg").click();
  const menu = page.locator(".dropdown-menu.main_menu:visible").last();
  await menu.waitFor({ state: "visible", timeout: 5000 });
  const groups = menu.locator("li.dropdown-submenu");
  const matchingOptions: Array<{ largeId: string; middleId: string }> = [];
  for (let groupIndex = 0; groupIndex < (await groups.count()); groupIndex++) {
    const group = groups.nth(groupIndex);
    const largeOption = group.locator(".l_c_name");
    const largeName = (await largeOption.innerText()).trim();
    if (normalize(largeName) !== normalize(target.largeCategory)) continue;
    const largeId = await largeOption.getAttribute("id");
    if (!largeId) continue;
    const middleItems = group.locator(".m_c_name");
    for (let middleIndex = 0; middleIndex < (await middleItems.count()); middleIndex++) {
      const middle = middleItems.nth(middleIndex);
      if (normalize(await middle.innerText()) === normalize(target.middleCategory)) {
        const middleId = await middle.getAttribute("id");
        if (middleId) matchingOptions.push({ largeId, middleId });
      }
    }
  }
  if (matchingOptions.length !== 1) {
    await page.keyboard.press("Escape");
    throw new Error(`指定した大項目・中項目が一意に見つかりません (${matchingOptions.length}件)。`);
  }
  const selected = matchingOptions[0];

  const largeInput = form.locator("input.h_l_ctg");
  const middleInput = form.locator("input.h_m_ctg");
  const responsePromise = page.waitForResponse((response) => {
    const request = response.request();
    if (new URL(response.url()).pathname !== updateUrl.pathname || request.method() !== "PUT") return false;
    const body = request.postData();
    if (!body) return false;
    const fields = new URLSearchParams(body);
    return (
      fields.get("user_asset_act[id]") === transaction.id &&
      fields.get("user_asset_act[large_category_id]") === selected.largeId &&
      fields.get("user_asset_act[middle_category_id]") === selected.middleId
    );
  }, { timeout: 15000 });
  const selectedGroup = menu.locator(`li.dropdown-submenu:has(.l_c_name[id="${selected.largeId}"])`);
  await selectedGroup.hover();
  const selectedMiddle = selectedGroup.locator(`.m_c_name[id="${selected.middleId}"]`);
  await selectedMiddle.waitFor({ state: "visible", timeout: 5000 });
  await selectedMiddle.click();
  const response = await responsePromise;
  if (!response.ok()) throw new Error(`分類更新に失敗しました (HTTP ${response.status()})。`);
  if (await middleInput.inputValue() !== selected.middleId || await largeInput.inputValue() !== selected.largeId) {
    throw new Error("分類更新後のフォーム値を確認できません。");
  }
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const dateRange = parseDateRange(arguments_);
  if (!dateRange.from || !arguments_.some((argument) => argument.startsWith("--to="))) {
    throw new Error("安全のため--fromと--toを両方指定してください。");
  }
  const target = getTarget(arguments_);
  const apply = arguments_.includes("--apply");
  const summaryOnly = arguments_.includes("--summary-only");
  if (!existsSync(authStatePath)) throw new Error("認証状態がありません。先に npm run login を実行してください。");

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ storageState: authStatePath, locale: "ja-JP", timezoneId: "Asia/Tokyo" });
    try {
      const page = await context.newPage();
      const response = await page.goto(cashFlowUrl, { waitUntil: "domcontentloaded" });
      if (response && !response.ok()) throw new Error(`家計簿ページを読み込めませんでした (HTTP ${response.status()})。`);
      await page.locator("#cf-detail-table").waitFor({ state: "visible", timeout: 15000 });
      const scan = await collectHistory(page, target, dateRange);

      if (!apply) {
        if (!summaryOnly) {
          for (const transaction of scan.transactions) {
            console.log(JSON.stringify({
              id: transaction.id,
              date: transaction.date,
              accountName: transaction.accountName,
              description: transaction.description,
              amount: transaction.amount,
              currentLargeCategory: transaction.largeCategory,
              currentMiddleCategory: transaction.middleCategory,
              targetLargeCategory: target.largeCategory,
              targetMiddleCategory: target.middleCategory,
              alreadySet: normalize(transaction.largeCategory) === normalize(target.largeCategory) && normalize(transaction.middleCategory) === normalize(target.middleCategory),
              operation: "dry-run-set-category",
            }));
          }
        }
        console.log(JSON.stringify({ matchedCount: scan.transactions.length, complete: scan.complete, stopReason: scan.stopReason, operation: scan.complete ? "dry-run-set-category" : "dry-run-set-category-incomplete" }));
        return;
      }
      if (!scan.complete) throw new Error(`走査が未完了のためApplyを中止しました: ${scan.stopReason ?? "不明な停止理由"}`);
      if (scan.transactions.length === 0) {
        console.log(JSON.stringify({ matchedCount: 0, succeeded: 0, operation: "apply-set-category" }));
        return;
      }

      const refreshed = await page.goto(cashFlowUrl, { waitUntil: "domcontentloaded" });
      if (refreshed && !refreshed.ok()) throw new Error(`家計簿ページを再読み込みできませんでした (HTTP ${refreshed.status()})。`);
      await page.locator("#cf-detail-table").waitFor({ state: "visible", timeout: 15000 });
      let succeeded = 0;
      for (const transaction of scan.transactions) {
        try {
          await navigateToMonth(page, transaction.month);
          const row = await findRowById(page, transaction.id);
          if (!row) throw new Error("対象明細が見つかりません。");
          const current = await readTransaction(row, transaction.month);
          if (
            !current ||
            !matches(current, target, dateRange) ||
            current.date !== transaction.date ||
            current.accountName !== transaction.accountName
          ) throw new Error("適用直前に明細が変化しました。");
          if (normalize(current.largeCategory) === normalize(target.largeCategory) && normalize(current.middleCategory) === normalize(target.middleCategory)) {
            succeeded++;
            console.log(JSON.stringify({ id: transaction.id, date: transaction.date, status: "already-set" }));
            continue;
          }

          await chooseMiddleCategory(page, row, transaction, target);
          const reloaded = await page.goto(cashFlowUrl, { waitUntil: "domcontentloaded" });
          if (reloaded && !reloaded.ok()) throw new Error(`更新後ページを再読み込みできませんでした (HTTP ${reloaded.status()})。`);
          await page.locator("#cf-detail-table").waitFor({ state: "visible", timeout: 15000 });
          await navigateToMonth(page, transaction.month);
          const updatedRow = await findRowById(page, transaction.id);
          if (!updatedRow) throw new Error("更新後の明細が見つかりません。");
          const updated = await readTransaction(updatedRow, transaction.month);
          if (
            !updated ||
            !matches(updated, target, dateRange) ||
            normalize(updated.largeCategory) !== normalize(target.largeCategory) ||
            normalize(updated.middleCategory) !== normalize(target.middleCategory)
          ) throw new Error("再読み込み後の分類を確認できません。");
          succeeded++;
          console.log(JSON.stringify({ id: transaction.id, date: transaction.date, status: "success" }));
        } catch (error: unknown) {
          console.log(JSON.stringify({ id: transaction.id, date: transaction.date, status: "failed", reason: error instanceof Error ? error.message : "不明なエラー", stop: true }));
          throw new Error("分類設定に失敗したため残りの対象を停止しました。");
        }
      }
      console.log(JSON.stringify({ matchedCount: scan.transactions.length, succeeded, operation: "apply-set-category-complete" }));
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "分類設定を完了できませんでした。");
  process.exitCode = 1;
});