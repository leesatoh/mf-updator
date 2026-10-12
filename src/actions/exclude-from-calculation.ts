import type { Locator, Page } from "playwright";

const updateUrl = new URL("https://moneyforward.com/cf/update");

export async function setCalculationTarget(
  page: Page,
  row: Locator,
  shouldBeTarget: boolean,
): Promise<void> {
  const rowClass = (await row.getAttribute("class")) ?? "";
  const isCurrentlyExcluded = rowClass.includes("mf-grayout");
  if (isCurrentlyExcluded === !shouldBeTarget) throw new Error("対象明細は既に指定された状態です。");

  const form = row.locator("form.new_user_asset_act");
  const transactionId = await form.locator("input[name='user_asset_act[id]']").inputValue();
  const targetInput = form.locator("#user_asset_act_is_target");
  const targetValue = await targetInput.inputValue();
  const expectedCurrentValue = shouldBeTarget ? "0" : "1";
  const requestedTargetValue = shouldBeTarget ? "1" : "0";
  const action = await form.getAttribute("action");
  const formUrl = action ? new URL(action, page.url()) : null;
  if (
    !transactionId ||
    targetValue !== expectedCurrentValue ||
    isCurrentlyExcluded !== (targetValue === "0") ||
    formUrl?.origin !== updateUrl.origin ||
    formUrl.pathname !== updateUrl.pathname
  ) {
    throw new Error("更新フォームのID・対象フラグ・URLが想定と異なるため停止しました。");
  }

  const toggle = row.locator(".js-v-is-target");
  if ((await toggle.count()) !== 1) {
    throw new Error("計算対象スイッチを一意に特定できません。");
  }

  const responsePromise = page.waitForResponse(
    (response) => {
      const request = response.request();
      if (new URL(response.url()).pathname !== updateUrl.pathname || request.method() !== "PUT") {
        return false;
      }
      const body = request.postData();
      if (!body) return false;
      const fields = new URLSearchParams(body);
      return (
        fields.get("user_asset_act[id]") === transactionId &&
        fields.get("user_asset_act[is_target]") === requestedTargetValue
      );
    },
    { timeout: 30000 },
  );

  await toggle.click();
  const response = await responsePromise;
  if (!response.ok()) {
    throw new Error(`計算対象フラグの更新に失敗しました (HTTP ${response.status()})。`);
  }

  const updatedClass = (await row.getAttribute("class")) ?? "";
  const updatedTargetValue = await targetInput.inputValue();
  const shouldBeExcluded = !shouldBeTarget;
  if (updatedClass.includes("mf-grayout") !== shouldBeExcluded || updatedTargetValue !== requestedTargetValue) {
    throw new Error(`画面上で計算対象${shouldBeTarget ? "ON" : "OFF"}を確認できませんでした。`);
  }
}
