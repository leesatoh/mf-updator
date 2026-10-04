import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const accountsUrl = new URL("https://moneyforward.com/accounts");
const authStatePath = fileURLToPath(new URL("../data/auth-state.json", import.meta.url));
const loginTimeout = 10 * 60 * 1000;

function isAuthenticatedUrl(url: URL): boolean {
  return (
    url.origin === accountsUrl.origin &&
    (url.pathname === accountsUrl.pathname || url.pathname.startsWith(`${accountsUrl.pathname}/`))
  );
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: false });

  try {
    const context = await browser.newContext({
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      ...(existsSync(authStatePath) ? { storageState: authStatePath } : {}),
    });

    try {
      const page = await context.newPage();
      await page.goto(accountsUrl.href, { waitUntil: "domcontentloaded" });

      console.log("ブラウザーでMoney Forward MEに手動ログインしてください。");
      console.log("ログイン完了後、口座ページへの到達を確認して認証状態を保存します。");

      await page.waitForURL(isAuthenticatedUrl, { timeout: loginTimeout });
      await mkdir(dirname(authStatePath), { recursive: true });
      await context.storageState({ path: authStatePath });
      console.log("認証状態をローカルに保存しました。次回起動時に再利用します。");
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

main().catch(() => {
  console.error("ログインを確認できませんでした。画面での手動ログイン後にもう一度お試しください。");
  process.exitCode = 1;
});