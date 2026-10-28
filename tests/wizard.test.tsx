// 【1】おねがいウィザード のテスト。`claude plugin test .` で走る。
import { test, expect } from "claude-code/testing";
import { buildRequestPrompt, missingFields } from "../hooks/panel";
import { fresh, RUN, mountPanel, setupPanel, texts } from "./_panel-setup";

const fill = async (ui: Awaited<ReturnType<typeof mountPanel>>, what: string, where: string, success: string) => {
  await ui.input({ key: "onegai:what", text: what, kind: "change" });
  await ui.input({ key: "onegai:where", text: where, kind: "change" });
  await ui.input({ key: "onegai:success", text: success, kind: "change" });
};

test("空のまま送ると送らず、「ここを埋めてください」が赤く出る", async ($, on) => {
  const rec = await fresh($, on);
  await $.command.run({ command: "onegai", args: "", ...RUN });
  const ui = await mountPanel($);
  await fill(ui, "ログインしないと見られないページ", "", "");
  await ui.press({ key: "onegai:send" });
  expect(rec.prompts).toEqual([]);
  const reds = (await ui.findAll({ type: "Text" })).filter((t: any) => t.text === "ここを埋めてください" && t.props.color === "red");
  expect(reds).toHaveLength(2);
});

test("3 つ埋めて送ると依頼文が組み立てられ、履歴に残り、欄は空に戻る", async ($, on) => {
  const rec = await fresh($, on);
  await $.command.run({ command: "onegai", args: "", ...RUN });
  const ui = await mountPanel($);
  await fill(ui, "ログインしないと見られないページ", "トップページの右上", "ログイン後に自分の名前が出る");
  await ui.press({ key: "onegai:send" });

  expect(rec.prompts).toEqual([
    "【やりたいこと】ログインしないと見られないページ\n【場所】トップページの右上\n【成功の条件】ログイン後に自分の名前が出る\nまず計画を3行で出して、私がOKと言ってから作業して。終わったら確認の仕方を3行で。",
  ]);
  expect(buildRequestPrompt({ what: "a", where: "b", success: "c" }).startsWith("【やりたいこと】a\n【場所】b\n【成功の条件】c")).toBe(true);
  expect(missingFields({ what: " ", where: "b", success: "" })).toEqual(["what", "success"]);

  // 履歴と空欄
  expect((await texts(ui)).some((t) => t.includes("前の依頼"))).toBe(true);
  const reuse = (await ui.findAll({ type: "Button" })).find((b: any) => String(b.props?.key ?? "") === "onegai:reuse:0");
  expect(String((reuse as any).props.label)).toBe("▸ ログインしないと見られないページ");
  const whatInput = (await ui.findAll({ type: "Input" })).find((i: any) => String(i.props?.key ?? "") === "onegai:what");
  expect(String((whatInput as any).props.value ?? "")).toBe("");

  // 履歴を押すと欄に戻る
  await ui.press({ key: "onegai:reuse:0" });
  const again = (await ui.findAll({ type: "Input" })).find((i: any) => String(i.props?.key ?? "") === "onegai:where");
  expect(String((again as any).props.value)).toBe("トップページの右上");
});

test("作業中は「送る」が押せない", async ($, on) => {
  const rec = await fresh($, on);
  await $.command.run({ command: "onegai", args: "", ...RUN });
  await $.turn.start({ text: "作業中", turnId: "t1" });
  const ui = await mountPanel($);
  expect((await ui.findAll({ type: "Button" })).some((b: any) => String(b.props?.key ?? "") === "onegai:send")).toBe(false);
  expect(rec.prompts).toEqual([]);
});
