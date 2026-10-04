import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import { excludeFromCalculation } from "./actions/exclude-from-calculation.js";
import { isDateInRange, parseDateRange, type DateRange } from "./date-range.js";

type Candidate = {
  id: string;
  date: string;
  description: string;
  amount: number;
  accountName: string;
  month: string;
};

type TransactionDetails = Candidate & {
  isTransfer: boolean;
  isExcludedFromCalculation: boolean;
};

const cashFlowUrl = "https://moneyforward.com/cf";
const authStatePath = fileURLToPath(new URL("../data/auth-state.json", import.meta.url));

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "");
}

function getTargetAccount(): string {
  const argument = process.argv.slice(2).find((value) => value.startsWith("--account="));
  const account = argument?.slice("--account=".length).trim();
  if (!account) throw new Error("--account=口座名を指定してください。");
  return account;
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
  const year = match?.[1];
  const month = Number(match?.[2]);
  if (!year || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new Error("家計簿の表示月を確認できません。");
  }
  return `${year}-${String(month).padStart(2, "0")}`;
}

async function moveOneMonth(page: Page, direction: "previous" | "next"): Promise<string | null> {
  const selector =
    direction === "previous"
      ? "button.fc-button-prev, span.fc-button-prev"
      : "button.fc-button-next, span.fc-button-next";
  const button = page.locator(selector).first();
  if ((await button.count()) === 0) throw new Error("家計簿の月移動ボタンが見つかりません。");
  const [className, disabled, ariaDisabled] = await Promise.all([
    button.getAttribute("class"),
    button.getAttribute("disabled"),
    button.getAttribute("aria-disabled"),
  ]);
  if (
    direction === "previous" &&
    (disabled !== null || ariaDisabled === "true" || className?.includes("fc-state-disabled"))
  ) {
    return null;
  }
  const currentMonth = await getDisplayedMonth(page);
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/cf/fetch"),
    { timeout: 15000 },
  );
  await button.click();
  const response = await responsePromise;
  const failure = await response.finished();
  if (failure) throw failure;
  if (!response.ok()) throw new Error(`家計簿の月移動に失敗しました (HTTP ${response.status()})。`);

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
    if (!nextMonth) throw new Error("対象月より前に利用可能な明細期間が終了しています。");
    currentMonth = nextMonth;
  }
  if (currentMonth !== targetMonth) throw new Error("対象月へ移動できません。");
}

function parseDate(dateText: string, displayedMonth: string): string | null {
  const normalizedDate = normalize(dateText);
  const [, displayedYear, displayedMonthNumber] = displayedMonth.match(/^(\d{4})-(\d{2})$/) ?? [];
  const fullDate = normalizedDate.match(/^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (fullDate) {
    return `${fullDate[1]}-${fullDate[2].padStart(2, "0")}-${fullDate[3].padStart(2, "0")}`;
  }

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

async function getAccountName(cell: Locator): Promise<string> {
  const transferBox = cell.locator(".transfer_account_box");
  if ((await transferBox.count()) > 0) return (await transferBox.innerText()).trim();
  const accountLabel = cell.locator("div.noform span");
  if ((await accountLabel.count()) > 0) return (await accountLabel.first().innerText()).trim();
  return (await cell.innerText()).trim();
}

async function readTransactionDetails(row: Locator, month: string): Promise<TransactionDetails> {
  const rowId = await row.getAttribute("id");
  if (!rowId?.startsWith("js-transaction-")) {
    throw new Error("明細行のIDを確認できません。");
  }
  const cells = row.locator("td");
  if ((await cells.count()) < 7) throw new Error("明細行の列数が想定と異なります。");

  const [dateText, description, amountText, accountName, category] = await Promise.all([
    cells.nth(1).innerText(),
    cells.nth(2).innerText(),
    cells.nth(3).innerText(),
    getAccountName(cells.nth(4)),
    cells.nth(5).innerText(),
  ]);
  const date = parseDate(dateText, month);
  const amountDigits = (normalize(amountText).match(/[\d,]+/) ?? [""])[0].replace(/\D/g, "");
  if (!date || amountDigits.length === 0) {
    throw new Error("明細の日付または金額を確認できません。走査を停止しました。");
  }

  const rowClass = (await row.getAttribute("class")) ?? "";
  const isExcludedFromCalculation = rowClass.includes("mf-grayout");
  const isTransfer = category.trim().length === 0;
  const targetInput = row.locator("#user_asset_act_is_target");
  const targetInputCount = await targetInput.count();
  if (targetInputCount === 1) {
    const targetValue = await targetInput.inputValue();
    if (
      (isExcludedFromCalculation && targetValue !== "0") ||
      (!isExcludedFromCalculation && targetValue !== "1")
    ) {
      throw new Error("計算対象フラグと明細表示が一致しません。");
    }
  } else if (targetInputCount !== 0 || !isTransfer || !isExcludedFromCalculation) {
    throw new Error("計算対象フラグを確認できません。");
  }

  return {
    id: rowId.slice("js-transaction-".length),
    date,
    description: description.trim(),
    amount: (/-|−|▲|△/.test(normalize(amountText)) ? -1 : 1) * Number(amountDigits),
    accountName,
    isTransfer,
    isExcludedFromCalculation,
    month,
  };
}

function isTarget(
  details: TransactionDetails,
  targetAccount: string,
  dateRange: DateRange,
): boolean {
  return (
    isDateInRange(details.date, dateRange) &&
    normalize(details.accountName) === normalize(targetAccount) &&
    details.amount < 0 &&
    !details.isTransfer
  );
}

async function collectCurrentMonth(
  page: Page,
  month: string,
  targetAccount: string,
  dateRange: DateRange,
): Promise<Candidate[]> {
  const rows = page.locator("#cf-detail-table tbody tr[id^='js-transaction-']");
  const candidates: Candidate[] = [];
  for (let index = 0; index < (await rows.count()); index++) {
    const details = await readTransactionDetails(rows.nth(index), month);
    if (!isTarget(details, targetAccount, dateRange) || details.isExcludedFromCalculation) continue;
    const { isTransfer: _isTransfer, isExcludedFromCalculation: _isExcluded, ...candidate } = details;
    candidates.push(candidate);
  }
  return candidates;
}

async function collectHistory(
  page: Page,
  targetAccount: string,
  dateRange: DateRange,
): Promise<Candidate[]> {
  let currentMonth = await getDisplayedMonth(page);
  const latestMonth = dateRange.to.slice(0, 7);
  if (currentMonth > latestMonth) {
    await navigateToMonth(page, latestMonth);
    currentMonth = latestMonth;
  }
  const earliestMonth = dateRange.from?.slice(0, 7) ?? null;

  const candidates: Candidate[] = [];
  const seenIds = new Set<string>();
  let scannedMonths = 0;
  let displayedMonth = currentMonth;
  while (earliestMonth === null || displayedMonth >= earliestMonth) {
    scannedMonths++;
    for (const candidate of await collectCurrentMonth(page, displayedMonth, targetAccount, dateRange)) {
      if (seenIds.has(candidate.id)) throw new Error("同じ明細IDが複数月に現れたため停止しました。");
      seenIds.add(candidate.id);
      candidates.push(candidate);
    }
    console.log(
      JSON.stringify({
        scannedMonth: displayedMonth,
        scannedMonths,
        matchedCount: candidates.length,
        operation: "dry-run-progress",
      }),
    );
    if (displayedMonth === earliestMonth) break;
    const previousMonth = await moveOneMonth(page, "previous");
    if (!previousMonth) break;
    displayedMonth = previousMonth;
  }

  candidates.sort((left, right) => left.date.localeCompare(right.date));
  return candidates;
}

async function findRowById(page: Page, id: string): Promise<Locator | null> {
  const rows = page.locator("#cf-detail-table tbody tr[id^='js-transaction-']");
  for (let index = 0; index < (await rows.count()); index++) {
    const row = rows.nth(index);
    if ((await row.getAttribute("id")) === `js-transaction-${id}`) return row;
  }
  return null;
}

async function applyCandidate(
  page: Page,
  candidate: Candidate,
  targetAccount: string,
  dateRange: DateRange,
): Promise<void> {
  await navigateToMonth(page, candidate.month);
  const row = await findRowById(page, candidate.id);
  if (!row) throw new Error("適用直前に対象明細が見つかりません。");

  const details = await readTransactionDetails(row, candidate.month);
  if (
    !isTarget(details, targetAccount, dateRange) ||
    details.isExcludedFromCalculation ||
    details.date !== candidate.date ||
    details.description !== candidate.description ||
    details.amount !== candidate.amount ||
    normalize(details.accountName) !== normalize(candidate.accountName)
  ) {
    throw new Error("適用直前に明細が変化したため停止しました。");
  }
  await excludeFromCalculation(page, row);
}

async function main(): Promise<void> {
  const targetAccount = getTargetAccount();
  const dateRange = parseDateRange(process.argv.slice(2));
  const apply = process.argv.includes("--apply");
  const summaryOnly = process.argv.includes("--summary-only");
  if (!existsSync(authStatePath)) {
    throw new Error("認証状態がありません。先に npm run login を実行してください。");
  }

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({
      storageState: authStatePath,
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
    });
    try {
      const page = await context.newPage();
      const response = await page.goto(cashFlowUrl, { waitUntil: "domcontentloaded" });
      if (response && !response.ok()) {
        throw new Error(`家計簿ページを読み込めませんでした (HTTP ${response.status()})。`);
      }
      await page.locator("#cf-detail-table").waitFor({ state: "visible", timeout: 15000 });
      const candidates = await collectHistory(page, targetAccount, dateRange);

      if (!apply) {
        if (!summaryOnly) {
          for (const candidate of candidates) {
            console.log(
              JSON.stringify({
                date: candidate.date,
                accountName: candidate.accountName,
                description: candidate.description,
                amount: candidate.amount,
                action: "exclude-from-calculation",
              }),
            );
          }
        }
        console.log(JSON.stringify({ matchedCount: candidates.length, operation: "dry-run" }));
        return;
      }

      if (candidates.length === 0) {
        console.log(JSON.stringify({ matchedCount: 0, operation: "apply", succeeded: 0 }));
        return;
      }

      const refreshResponse = await page.goto(cashFlowUrl, { waitUntil: "domcontentloaded" });
      if (refreshResponse && !refreshResponse.ok()) {
        throw new Error(`家計簿ページを再読み込みできませんでした (HTTP ${refreshResponse.status()})。`);
      }
      await page.locator("#cf-detail-table").waitFor({ state: "visible", timeout: 15000 });
      console.log(JSON.stringify({ matchedCount: candidates.length, operation: "apply-start" }));
      let succeeded = 0;
      for (const candidate of [...candidates].reverse()) {
        try {
          await applyCandidate(page, candidate, targetAccount, dateRange);
          succeeded++;
          console.log(JSON.stringify({ date: candidate.date, status: "success" }));
        } catch (error: unknown) {
          console.log(
            JSON.stringify({
              date: candidate.date,
              status: "failed",
              reason: error instanceof Error ? error.message : "不明なエラー",
              stop: true,
            }),
          );
          throw new Error("計算対象OFFに失敗したため残りの対象を停止しました。");
        }
      }
      console.log(JSON.stringify({ matchedCount: candidates.length, succeeded, operation: "apply-complete" }));
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "対象明細を処理できませんでした。";
  console.error(message);
  process.exitCode = 1;
});