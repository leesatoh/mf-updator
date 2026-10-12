import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import { isDateInRange, parseDateRange, type DateRange } from "./date-range.js";

type Target = {
  description: string;
  account: string;
  counterAccount: string;
};

type Transaction = {
  id: string;
  date: string;
  description: string;
  amount: number;
  accountName: string;
  month: string;
  isTransfer: boolean;
};

const cashFlowUrl = "https://moneyforward.com/cf";
const authStatePath = fileURLToPath(new URL("../data/auth-state.json", import.meta.url));

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").replace(/／/g, "/");
}

function parseOptions(arguments_: string[]): Map<string, string> {
  const options = new Map<string, string>();
  for (const argument of arguments_) {
    const separator = argument.indexOf("=");
    if (separator < 0) continue;
    const key = argument.slice(0, separator);
    if (options.has(key)) throw new Error(`${key} は1回だけ指定できます。`);
    options.set(key, argument.slice(separator + 1));
  }
  return options;
}

function getTarget(options: Map<string, string>): Target {
  const description = options.get("--description") ?? "";
  const account = options.get("--account") ?? "";
  const counterAccount = options.get("--counter-account") ?? "";
  if (!description || !account || !counterAccount) {
    throw new Error("--description、--account、--counter-account を指定してください。");
  }
  return { description, account, counterAccount };
}

function accountParts(account: string): string[] {
  return account.split("/").map(normalize).filter(Boolean);
}

function accountMatches(accountName: string, targetAccount: string): boolean {
  const targetName = targetAccount.split("/").at(-1) ?? targetAccount;
  return normalize(accountName) === normalize(targetName);
}

async function getAccountName(cell: Locator): Promise<string> {
  const transferBox = cell.locator(".transfer_account_box");
  if ((await transferBox.count()) > 0) return (await transferBox.innerText()).trim();
  const accountLabel = cell.locator("div.noform span");
  if ((await accountLabel.count()) > 0) return (await accountLabel.first().innerText()).trim();
  return (await cell.innerText()).trim();
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

async function moveOneMonth(page: Page): Promise<string> {
  const button = page.locator("button.fc-button-prev, span.fc-button-prev").first();
  if ((await button.count()) === 0) throw new Error("家計簿の前月ボタンが見つかりません。");
  const [className, disabled, ariaDisabled] = await Promise.all([
    button.getAttribute("class"),
    button.getAttribute("disabled"),
    button.getAttribute("aria-disabled"),
  ]);
  if (disabled !== null || ariaDisabled === "true" || className?.includes("fc-state-disabled")) {
    throw new Error("指定期間の走査前に利用可能な明細期間が終了しました。");
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

  const previousMonth = await getDisplayedMonth(page);
  if (previousMonth >= currentMonth) throw new Error("家計簿の前月へ移動できません。");
  return previousMonth;
}

async function navigateToMonth(page: Page, targetMonth: string): Promise<void> {
  let currentMonth = await getDisplayedMonth(page);
  for (let attempt = 0; currentMonth !== targetMonth && attempt < 1200; attempt++) {
    currentMonth = await moveOneMonth(page);
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

async function readTransaction(row: Locator, month: string): Promise<Transaction | null> {
  const rowId = await row.getAttribute("id");
  if (!rowId?.startsWith("js-transaction-")) return null;
  const cells = row.locator("td");
  if ((await cells.count()) < 9) throw new Error("明細行の列数が想定と異なります。");

  const [dateText, description, amountText, accountName, category] = await Promise.all([
    cells.nth(1).innerText(),
    cells.nth(2).innerText(),
    cells.nth(3).innerText(),
    getAccountName(cells.nth(4)),
    cells.nth(5).innerText(),
  ]);
  const date = parseDate(dateText, month);
  const amountDigits = (amountText.match(/[\d,]+/) ?? [""])[0].replace(/\D/g, "");
  if (!date || amountDigits.length === 0) {
    throw new Error("明細の日付または金額を確認できません。走査を停止しました。");
  }

  return {
    id: rowId.slice("js-transaction-".length),
    date,
    description: description.trim(),
    amount: (/-|−|▲|△/.test(amountText) ? -1 : 1) * Number(amountDigits),
    accountName: accountName.trim(),
    month,
    isTransfer: category.trim() === "",
  };
}

async function collectCurrentMonth(page: Page, month: string, dateRange: DateRange): Promise<Transaction[]> {
  const rows = page.locator("#cf-detail-table tbody tr[id^='js-transaction-']");
  const transactions: Transaction[] = [];
  for (let index = 0; index < (await rows.count()); index++) {
    const transaction = await readTransaction(rows.nth(index), month);
    if (transaction && isDateInRange(transaction.date, dateRange)) transactions.push(transaction);
  }
  return transactions;
}

async function collectHistory(page: Page, dateRange: DateRange): Promise<Transaction[]> {
  if (!dateRange.from) throw new Error("安全のため訂正候補の確認には--fromを指定してください。");
  let displayedMonth = await getDisplayedMonth(page);
  const latestMonth = dateRange.to.slice(0, 7);
  if (displayedMonth > latestMonth) {
    await navigateToMonth(page, latestMonth);
    displayedMonth = latestMonth;
  }

  const earliestMonth = dateRange.from.slice(0, 7);
  const transactions: Transaction[] = [];
  const seenIds = new Set<string>();
  let scannedMonths = 0;
  while (displayedMonth >= earliestMonth) {
    scannedMonths++;
    for (const transaction of await collectCurrentMonth(page, displayedMonth, dateRange)) {
      if (seenIds.has(transaction.id)) throw new Error("同じ明細IDが複数月に現れたため停止しました。");
      seenIds.add(transaction.id);
      transactions.push(transaction);
    }
    console.log(JSON.stringify({ scannedMonth: displayedMonth, scannedMonths, operation: "dry-run-progress" }));
    if (displayedMonth === earliestMonth) break;
    displayedMonth = await moveOneMonth(page);
  }
  return transactions;
}

function findMatches(transactions: Transaction[], target: Target) {
  const sources = transactions.filter(
    (transaction) =>
      transaction.isTransfer &&
      normalize(transaction.description) === normalize(target.description) &&
      accountMatches(transaction.accountName, target.account),
  );
  const counterpartTransactions = transactions.filter(
    (transaction) => !transaction.isTransfer && accountMatches(transaction.accountName, target.counterAccount),
  );

  return sources.map((source) => {
    const matches = counterpartTransactions.filter(
      (candidate) =>
        candidate.date === source.date && Math.abs(candidate.amount) === Math.abs(source.amount),
    );
    return { source, matches };
  });
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (arguments_.includes("--apply")) {
    throw new Error("振替訂正のApplyは未対応です。候補表示のみ実行できます。");
  }
  const options = parseOptions(arguments_);
  const dateRange = parseDateRange(arguments_);
  const target = getTarget(options);
  const summaryOnly = arguments_.includes("--summary-only");
  if (!dateRange.from) throw new Error("安全のため--fromを指定してください。");
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
      const transactions = await collectHistory(page, dateRange);
      const results = findMatches(transactions, target);
      let uniqueCount = 0;
      let unmatchedCount = 0;
      let ambiguousCount = 0;

      for (const { source, matches } of results) {
        const status = matches.length === 1 ? "unique-candidate" : matches.length === 0 ? "no-match" : "ambiguous";
        if (matches.length === 1) uniqueCount++;
        else if (matches.length === 0) unmatchedCount++;
        else ambiguousCount++;
        if (summaryOnly) continue;
        console.log(
          JSON.stringify({
            source: {
              id: source.id,
              date: source.date,
              accountName: source.accountName,
              description: source.description,
              amount: source.amount,
            },
            status,
            candidateCount: matches.length,
            candidates: matches.map((candidate) => ({
              id: candidate.id,
              date: candidate.date,
              accountName: candidate.accountName,
              description: candidate.description,
              amount: candidate.amount,
            })),
            operation: "dry-run-correct-transfer",
          }),
        );
      }
      console.log(
        JSON.stringify({
          sourceCount: results.length,
          uniqueCount,
          unmatchedCount,
          ambiguousCount,
          operation: "dry-run-correct-transfer",
        }),
      );
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "振替訂正候補を確認できませんでした。";
  console.error(message);
  process.exitCode = 1;
});