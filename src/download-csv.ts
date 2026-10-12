import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { parseDateRange } from "./date-range.js";
import { combineCsvContents } from "./csv-combine.js";

const cashFlowUrl = "https://moneyforward.com/cf";
const authStatePath = fileURLToPath(new URL("../data/auth-state.json", import.meta.url));
const downloadDirectory = fileURLToPath(new URL("../data/csv-downloads/", import.meta.url));

function getMonths(from: string, to: string): string[] {
  const months: string[] = [];
  const firstMonth = from.slice(0, 7);
  const lastMonth = to.slice(0, 7);
  let year = Number(firstMonth.slice(0, 4));
  let month = Number(firstMonth.slice(5, 7));
  while (`${year}-${String(month).padStart(2, "0")}` <= lastMonth) {
    months.push(`${year}-${String(month).padStart(2, "0")}`);
    month++;
    if (month > 12) {
      month = 1;
      year++;
    }
  }
  return months;
}

function getCsvUrl(month: string): URL {
  const [year, monthNumber] = month.split("-");
  const url = new URL("/cf/csv", cashFlowUrl);
  url.searchParams.set("from", `${year}/${monthNumber}/01`);
  url.searchParams.set("month", String(Number(monthNumber)));
  url.searchParams.set("year", year);
  return url;
}

async function combineCsvFiles(months: string[]): Promise<{ outputPath: string; rowCount: number; columnCount: number }> {
  const files = await Promise.all(months.map(async (month) => ({
    month,
    content: await readFile(join(downloadDirectory, `${month}.csv`)),
  })));
  const combined = combineCsvContents(files);
  const outputPath = join(downloadDirectory, "combined.csv");
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, combined.content, "utf8");
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return { outputPath, rowCount: combined.rowCount, columnCount: combined.columnCount };
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const combine = arguments_.includes("--combine");
  const dateRange = parseDateRange(arguments_);
  if (!dateRange.from) throw new Error("CSV取得には--from=YYYY-MM-DDを指定してください。");
  if (!arguments_.some((argument) => argument.startsWith("--to="))) {
    throw new Error("CSV取得には--to=YYYY-MM-DDを指定してください。");
  }
  if (!existsSync(authStatePath)) {
    throw new Error("認証状態がありません。先に npm run login を実行してください。");
  }

  await mkdir(downloadDirectory, { recursive: true });
  const months = getMonths(dateRange.from, dateRange.to);
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({
      storageState: authStatePath,
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
    });
    try {
      let downloaded = 0;
      for (const month of months) {
        const response = await context.request.get(getCsvUrl(month).toString(), { timeout: 30000 });
        if (!response.ok()) {
          throw new Error(`${month}のCSV取得に失敗しました (HTTP ${response.status()})。`);
        }
        const contentType = response.headers()["content-type"] ?? "";
        if (!contentType.toLowerCase().includes("text/csv")) {
          throw new Error(`${month}の応答がCSVではありません (${contentType || "Content-Typeなし"})。`);
        }
        const body = await response.body();
        const outputPath = join(downloadDirectory, `${month}.csv`);
        await writeFile(outputPath, body);
        downloaded++;
        console.log(JSON.stringify({ month, bytes: body.length, operation: "csv-downloaded" }));
      }
      const combined = combine ? await combineCsvFiles(months) : null;
      console.log(
        JSON.stringify({
          downloaded,
          directory: downloadDirectory,
          firstMonth: months[0],
          lastMonth: months.at(-1),
          ...(combined ? {
            combinedFile: combined.outputPath,
            combinedRows: combined.rowCount,
            combinedColumns: combined.columnCount,
          } : {}),
          operation: "csv-download-complete",
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
  const message = error instanceof Error ? error.message : "CSVを取得できませんでした。";
  console.error(message);
  process.exitCode = 1;
});