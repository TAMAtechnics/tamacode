// /tama（帯オン＋ペインをまとめて開く／もう一度で全部閉じる）のテスト。`claude plugin test .` で走る。
import { test, expect } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import { fresh, mountPanel, texts } from "./_panel-setup";

const WORKING = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } as any;
const run = (columns: number) => ({ origin: { kind: "composer" }, presentation: { isFullscreen: true, columns } }) as const;

const bandText = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "AbovePrompt", props: WORKING });
  const out = (await ui.findAll({ type: "Text" })).map((t) => t.text);
  await ui.unmount();
  return out;
};

test("/tama で帯オン＋ペイン（用語タブ）が開き、もう一度で全部閉じる", async ($, on) => {
  const pane = await fresh($, on);

  expect((await $.command.run({ command: "tama", args: "", ...run(120) })).text).toBe("たまを開きました（帯オン＋右のペイン）。もう一度 /tama で全部閉じます");
  expect(pane.opens).toEqual(["tama"]);
  let ui = await mountPanel($);
  expect((await ui.findAll({ type: "Button" })).some((b: any) => String(b.props?.label ?? "") === "●用語")).toBe(true);
  await ui.unmount();

  // 帯はオン
  await $.turn.start({ text: "見て", turnId: "t1" });
  await $.tool.call({ tool: "Bash", command: "echo hi" });
  expect((await bandText($)).length).toBeGreaterThan(0);

  // もう一度で閉じる（帯もオフ）
  expect((await $.command.run({ command: "tama", args: "", ...run(120) })).text).toBe("たまを閉じました（帯もオフ）。/tama でまた開けます");
  expect(pane.closes).toEqual(["tama"]);
  await $.tool.call({ tool: "Bash", command: "echo hi" });
  expect(await bandText($)).toEqual([]);

  // 3 回目でまた開く
  await $.command.run({ command: "tama", args: "", ...run(120) });
  expect(pane.opens).toEqual(["tama", "tama"]);
  await $.tool.call({ tool: "Bash", command: "echo hi" });
  expect((await bandText($)).length).toBeGreaterThan(0);
});

test("狭い画面では操作盤だけ（タブを隠す）", async ($, on) => {
  await fresh($, on);
  await $.command.run({ command: "tama", args: "", ...run(80) });
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "Pane", requestId: "tama", props: { title: "たま", isFocused: true, bodyColumns: 40, placement: "dock", scroll: { top: 0 }, view: {} } as any });
  const keys = (await ui.findAll({ type: "Button" })).map((b: any) => String(b.props?.key ?? ""));
  expect(keys.some((k) => k.startsWith("ptab:"))).toBe(false);
  expect((await texts(ui)).some((t) => t.includes("操作盤（押すだけで頼めます）"))).toBe(true);
  expect(keys).toContain("act:miru");
});

test("/tama auto off で起動時に開かなくなり、on で戻る（設定は残る）", async ($, on) => {
  const pane = await fresh($, on);
  expect((await $.command.run({ command: "tama", args: "auto", ...run(120) })).text).toBe("使い方: /tama auto on または /tama auto off（今は on）");

  expect((await $.command.run({ command: "tama", args: "auto off", ...run(120) })).text).toBe("起動時には開かないようにしました（/tama で開けます）");
  await $.session.start({ cwd: "/proj", surface: "terminal", isInteractive: true });
  expect(pane.opens).toEqual([]);

  expect((await $.command.run({ command: "tama", args: "auto on", ...run(120) })).text).toBe("起動時に自動で開くようにしました");
  await $.session.start({ cwd: "/proj", surface: "terminal", isInteractive: true });
  expect(pane.opens).toEqual(["tama"]);
});
