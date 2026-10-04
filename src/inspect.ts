import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright";

const cashFlowUrl = "https://moneyforward.com/cf";
const authStatePath = fileURLToPath(new URL("../data/auth-state.json", import.meta.url));

export type Transaction = {
  id: string;
  date: string;
  accountName: string;
  description: string;
  amount: number;
  isTransfer: boolean;
  isExcludedFromCalculation: boolean;
};

async function getCellText(cell: Locator): Promise<string> {
  return (await cell.innerText()).trim();
}

async function getAccountName(cell: Locator): Promise<string> {
  const transferBox = cell.locator(".transfer_account_box");
  if ((await transferBox.count()) > 0) return getCellText(transferBox);

  const accountLabel = cell.locator("div.noform span");
  if ((await accountLabel.count()) > 0) return getCellText(accountLabel.first());
  return getCellText(cell);
}

async function readTransaction(page: Page, transferOnly: boolean): Promise<Transaction> {
  const rows = page.locator("#cf-detail-table tbody tr[id^='js-transaction-']");
  const rowCount = await rows.count();

  for (let index = 0; index < rowCount; index++) {
    const row = rows.nth(index);
    await row.waitFor({ state: "visible", timeout: 10000 });

    const idAttribute = await row.getAttribute("id");
    const id = idAttribute?.replace(/^js-transaction-/, "");
    const cells = row.locator("td");
    if (!id || (await cells.count()) < 7) {
      throw new Error("明細行のIDまたは必要な列を確認できません。");
    }

    const category = await getCellText(cells.nth(5));
    const isTransfer = category.length === 0;
    if (transferOnly && !isTransfer) continue;

    const [date, description, amountText, accountName, rowClass] = await Promise.all([
      getCellText(cells.nth(1)),
      getCellText(cells.nth(2)),
      getCellText(cells.nth(3)),
      getAccountName(cells.nth(4)),
      row.getAttribute("class"),
    ]);
    const digits = amountText.replace(/\D/g, "");
    if (!date || digits.length === 0) {
      throw new Error("明細の日付または金額を確認できません。");
    }

    return {
      id,
      date,
      accountName,
      description,
      amount: Number.parseInt(digits, 10),
      isTransfer,
      isExcludedFromCalculation: (rowClass ?? "").includes("mf-grayout"),
    };
  }

  throw new Error(transferOnly ? "表示中に振替明細がありません。" : "表示中に明細がありません。");
}

async function main(): Promise<void> {
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

      const transferOnly = process.argv.includes("--transfer");
      const transaction = await readTransaction(page, transferOnly);
      console.log(transferOnly ? "読み取り専用: 表示中の振替候補1件" : "読み取り専用: 表示中の先頭1件");
      console.log(JSON.stringify(transaction, null, 2));
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "明細を読み取れませんでした。";
  console.error(message);
  process.exitCode = 1;
});