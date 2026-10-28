// 【2】もっと簡単に のテスト。`claude plugin test .` で走る。
import { test, expect } from "claude-code/testing";
import { buildSimplePrompt } from "../hooks/panel";
import { fresh, RUN, mountPanel, setupPanel, texts } from "./_panel-setup";

const SIMPLE = "今の説明を小学生にも分かる言い方で言い直して。長さは半分に。専門用語は使わない。";

test("/kantan で言い直しの頼みが送られる", async ($, on) => {
  const rec = await fresh($, on);
  const r = await $.command.run({ command: "kantan", args: "", ...RUN });
  await rec.clock.advance(0); // コマンドからの送信は次の瞬間に行われる
  expect(rec.prompts).toEqual([SIMPLE]);
  expect(buildSimplePrompt()).toBe(SIMPLE);
  expect(r.text).toBe("「もっと簡単に」を送りました。言い直しを待ってください");
});

test("操作盤の「もっと簡単に」ボタンでも送れる。作業中はボタンが無い", async ($, on) => {
  const rec = await fresh($, on);
  await $.command.run({ command: "panel", args: "", ...RUN });
  let ui = await mountPanel($);
  await ui.press({ key: "act:kantan" });
  expect(rec.prompts).toEqual([SIMPLE]);
  await ui.unmount();

  await $.turn.start({ text: "作業して", turnId: "t1" });
  ui = await mountPanel($);
  expect((await ui.findAll({ type: "Button" })).some((b: any) => String(b.props?.key ?? b.key ?? "") === "act:kantan")).toBe(false);
  expect((await texts(ui)).some((t) => t.includes("Claude が作業中なので"))).toBe(true);
});

test("用語タブの上にも「もっと簡単に」がある", async ($, on) => {
  const rec = await fresh($, on);
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "Pane", requestId: "tama", props: { title: "たま", isFocused: true, bodyColumns: 48, placement: "dock", scroll: { top: 0 }, view: {} } as any });
  await ui.press({ key: "terms:kantan" });
  expect(rec.prompts).toEqual([SIMPLE]);
});
