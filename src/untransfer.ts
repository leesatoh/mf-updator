import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page } from "playwright";
import { isDateInRange, parseDateRange, type DateRange } from "./date-range.js";

type Target = {
  description: string;
  account: string;
};

type Candidate = {
  id: string;
  date: string;
  description: string;
  amount: number;
  accountName: string;
  month: string;
};

const cashFlowUrl = "https://moneyforward.com/cf";
const authStatePath = fileURLToPath(new URL("../data/auth-state.json", import.meta.url));

function normalize(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, "").replace(/／/g, "/");
}

function getTarget(): Target {
  const options = new Map(
    process.argv.slice(2).flatMap((argument) => {
      const separator = argument.indexOf("=");
      if (separator < 0) return [];
      return [[argument.slice(0, separator), argument.slice(separator + 1)]];
    }),
  );
  const description = options.get("--description") ?? "";
  const account = options.get("--account") ?? "";
  if (!description || !account) {
    throw new Error("--description と --account を指定してください。");
  }
  return { description, account };
}

function getTargetAccountParts(target: Target): string[] {
  return target.account.split("/").map(normalize).filter(Boolean);
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

async function readCandidateDetails(
  row: Locator,
  month: string,
): Promise<Omit<Candidate, "month"> | null> {
  const rowId = await row.getAttribute("id");
  if (!rowId?.startsWith("js-transaction-")) return null;
  const cells = row.locator("td");
  if ((await cells.count()) < 9) return null;

  const [dateText, description, amountText, accountName, category] = await Promise.all([
    cells.nth(1).innerText(),
    cells.nth(2).innerText(),
    cells.nth(3).innerText(),
    cells.nth(4).innerText(),
    cells.nth(5).innerText(),
  ]);
  const date = parseDate(dateText, month);
  const amountDigits = (amountText.match(/[\d,]+/) ?? [""])[0].replace(/\D/g, "");
  if (!date || amountDigits.length === 0) return null;

  return {
    id: rowId.slice("js-transaction-".length),
    date,
    description,
    amount: (/-|−|▲/.test(amountText) ? -1 : 1) * Number(amountDigits),
    accountName,
  };
}

function matchesTarget(candidate: Omit<Candidate, "month">, target: Target): boolean {
  const accountText = normalize(candidate.accountName);
  return (
    normalize(candidate.description) === normalize(target.description) &&
    getTargetAccountParts(target).every((part) => accountText.includes(part))
  );
}

async function collectCurrentMonth(
  page: Page,
  target: Target,
  month: string,
  dateRange: DateRange,
): Promise<Candidate[]> {
  const rows = page.locator("#cf-detail-table tbody tr[id^='js-transaction-']");
  const candidates: Candidate[] = [];
  for (let index = 0; index < (await rows.count()); index++) {
    const row = rows.nth(index);
    const details = await readCandidateDetails(row, month);
    if (!details || !isDateInRange(details.date, dateRange) || !matchesTarget(details, target)) continue;
    if ((await row.locator("td").nth(5).innerText()).trim() !== "") continue;
    candidates.push({ ...details, month });
  }
  return candidates;
}

async function collectHistory(page: Page, target: Target, dateRange: DateRange): Promise<Candidate[]> {
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
    for (const candidate of await collectCurrentMonth(page, target, displayedMonth, dateRange)) {
      if (seenIds.has(candidate.id)) {
        throw new Error("同じ明細IDが複数月に現れたため停止しました。");
      }
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

async function applyUntransfer(page: Page, target: Target, candidate: Candidate): Promise<void> {
  await navigateToMonth(page, candidate.month);
  let row = await findRowById(page, candidate.id);
  if (!row) throw new Error("適用直前に対象明細が見つかりません。");

  let details = await readCandidateDetails(row, candidate.month);
  if (
    !details ||
    !matchesTarget(details, target) ||
    details.date !== candidate.date ||
    details.amount !== candidate.amount ||
    (await row.locator("td").nth(5).innerText()).trim() !== ""
  ) {
    throw new Error("適用直前に明細が変化したため停止しました。");
  }

  const toggle = row.locator("td:nth-child(9) .js-switch-transfer");
  if ((await toggle.count()) !== 1) throw new Error("振替操作を特定できません。");
  await toggle.click();
  await page.locator(".js-transfer-switch-dialog.is-visible").waitFor({
    state: "visible",
    timeout: 3000,
  });

  const message = normalize(
    await page.locator(".js-transfer-switch-dialog-action-msg").innerText(),
  );
  const proceed = page.locator(".js-transfer-switch-dialog-btn-proceed");
  const href = await proceed.getAttribute("href");
  const actionUrl = href ? new URL(href, page.url()) : null;
  if (!/(振替.*解除|解除.*振替)/.test(message)) {
    await page.locator(".js-transfer-switch-dialog-btn-cancel").click();
    throw new Error("確認文言が振替解除を示さないため停止しました。");
  }
  if (!actionUrl || actionUrl.origin !== new URL(cashFlowUrl).origin) {
    await page.locator(".js-transfer-switch-dialog-btn-cancel").click();
    throw new Error("確認リンクがMoney Forward内ではないため停止しました。");
  }

  const responsePromise = page
    .waitForResponse(
      (response) =>
        new URL(response.url()).pathname === actionUrl.pathname && response.request().method() !== "OPTIONS",
      { timeout: 15000 },
    )
    .catch(() => null);
  await proceed.click();
  const response = await responsePromise;
  if (response && response.status() >= 400) {
    throw new Error(`解除リクエストが失敗しました (HTTP ${response.status()})。`);
  }

  await page.goto(cashFlowUrl, { waitUntil: "domcontentloaded" });
  await page.locator("#cf-detail-table").waitFor({ state: "visible", timeout: 15000 });
  await navigateToMonth(page, candidate.month);
  row = await findRowById(page, candidate.id);
  if (!row) throw new Error("解除後の対象明細が見つかりません。");
  details = await readCandidateDetails(row, candidate.month);
  if (
    !details ||
    normalize(details.description) !== normalize(candidate.description) ||
    details.date !== candidate.date ||
    details.amount !== candidate.amount ||
    !getTargetAccountParts(target).some((part) => normalize(details.accountName).includes(part)) ||
    (await row.locator("td").nth(5).innerText()).trim() === ""
  ) {
    throw new Error("解除後の画面状態を確認できません。");
  }
}

async function main(): Promise<void> {
  const dateRange = parseDateRange(process.argv.slice(2));
  const target = getTarget();
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
      const candidates = await collectHistory(page, target, dateRange);

      if (!apply) {
        if (!summaryOnly) {
          for (const candidate of candidates) {
            console.log(
              JSON.stringify({
                date: candidate.date,
                accountName: candidate.accountName,
                description: candidate.description,
                amount: candidate.amount,
                action: "untransfer",
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

      console.log(JSON.stringify({ matchedCount: candidates.length, operation: "apply-start" }));
      let succeeded = 0;
      for (const candidate of candidates) {
        try {
          await applyUntransfer(page, target, candidate);
          succeeded++;
          console.log(JSON.stringify({ date: candidate.date, status: "success" }));
        } catch {
          console.log(JSON.stringify({ date: candidate.date, status: "failed", stop: true }));
          throw new Error("解除に失敗したため残りの対象を停止しました。");
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
