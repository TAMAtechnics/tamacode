// 雰囲気モード（/kakkoii）のテスト: HUD の数字が tool.call / tool.result / turn で正しく増える。`claude plugin test .` で走る。
import { test, expect, mock } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";
import { bar, barForNow, ctxGauge, firstLineOf, hms, hudLines, logLineFor, pulseLine, pushHistory, sparkline } from "../hooks/vibe";

const T0 = 1_800_000_000_000;
const RUN = { origin: { kind: "composer" }, presentation: { isFullscreen: true, columns: 120 } } as const;
const HUD_PROPS = { title: "HUD", isFocused: false, bodyColumns: 40, placement: "dock", scroll: { top: 0 }, view: {} } as any;
const USAGE = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, model: "x" };

function setup(on: On, opts: { bashTakes?: number } = {}) {
  const rec = { opens: [] as string[], closes: [] as string[] };
  mock.store(on, {});
  const clock = mock.clock(on, { now: T0 });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("session.cwd", () => ({ value: "/proj" }));
  on("session.usage", () => ({ value: { startedAt: T0 - 60_000, context: { window: 200000, tokens: 76000, percent: 38 }, rateLimits: [] } }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("ui.open", (_$, e) => {
    rec.opens.push(e.id);
    return { value: { isPlaced: true } };
  });
  on("ui.close", (_$, e) => {
    rec.closes.push(e.id);
    return { value: undefined };
  });
  on("ui.panes", () => ({ value: [] }));
  on("ui.log", () => ({ value: undefined }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("ui.status", () => ({ value: undefined }));
  on("env.get", () => ({ value: "/home/tama" }));
  on("fs.read", () => ({ deny: "ENOENT" }));
  on("fs.exists", () => ({ value: false }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Box } = $.ui.resolve(e);
    return <Box />;
  });
  on("tool.call", { tool: "Read" }, (_$, e) => ({ result: { file: { filePath: (e as any).file_path, content: "x", numLines: 1, startLine: 1, totalLines: 1 } } as any }));
  on("tool.call", { tool: ["Edit", "Write"] }, (_$, e) => ({ result: { filePath: (e as any).file_path } as any }));
  on("tool.call", { tool: "Bash" }, async (_$, e) => {
    if (opts.bashTakes !== undefined) await clock.sleep(opts.bashTakes);
    const cmd = String((e as any).command ?? "");
    if (cmd === "npm test") return { isError: true, result: "Error: 1 failed", text: "Error: 1 failed" } as any;
    return { result: { stdout: "ok", stderr: "", interrupted: false } as any };
  });
  return { ...rec, clock };
}

const hudTexts = async ($: Engine, surface: "terminal" | "desktop" = "terminal") => {
  const ui = await $.ui.mount({ plugin: "tamacode", surface, component: "Pane", requestId: "hud", props: HUD_PROPS });
  const all = await ui.findAll({ type: surface === "terminal" ? "Text" : "Svg" });
  await ui.unmount();
  return all;
};

test("HUD の数字: FILES は読んだファイル（重複なし）、EDITS は編集回数、ERRORS は失敗、TOKENS はターンの使用量。ログは新しい順", async ($, on) => {
  setup(on);
  await $.turn.start({ text: "直して", turnId: "t1" });
  await $.tool.call({ tool: "Read", file_path: "/proj/src/a.ts" });
  await $.tool.call({ tool: "Read", file_path: "/proj/src/a.ts" });
  await $.tool.call({ tool: "Read", file_path: "/proj/src/b.ts" });
  await $.tool.call({ tool: "Edit", file_path: "/proj/src/c.ts", old_string: "a", new_string: "b" });
  await $.tool.call({ tool: "Bash", command: "npm test" });
  await $.turn.complete({ answer: "直しました。テストは失敗しています。", reason: "answer", durationMs: 5000, isAborted: false, turnId: "t1", usage: USAGE } as any);

  const texts = (await hudTexts($)).map((t: any) => String(t.text));
  expect(texts).toContain("SESSION  00:01:00");
  expect(texts).toContain("TOKENS   in 110  out 50");
  expect(texts).toContain("FILES    2");
  expect(texts).toContain("EDITS    1");
  expect(texts).toContain("ERRORS   1");
  const logLines = texts.filter((t) => /^\d\d:\d\d:\d\d /.test(t));
  expect(logLines[0]!.endsWith("Bash  npm test")).toBe(true);
  expect(logLines[1]!.endsWith("Edit  src/c.ts")).toBe(true);
  expect(logLines[4]!.endsWith("Read  src/a.ts")).toBe(true);

  // 次のターンでも累計は増え続ける（turn.step で数えた分は turn.complete で二重に足さない）
  await $.turn.start({ text: "もう一度", turnId: "t2" });
  await $.turn.complete({ answer: "はい。", reason: "answer", durationMs: 1000, isAborted: false, turnId: "t2", usage: USAGE } as any);
  expect((await hudTexts($)).map((t: any) => String(t.text))).toContain("TOKENS   in 220  out 100");
});

test("/kakkoii でオン（HUD を開く）、もう一度でオフ（閉じる）。帯には進捗バーが付く", async ($, on) => {
  const rec = setup(on, { bashTakes: 100_000 });
  expect((await $.command.run({ command: "kakkoii", args: "", ...RUN })).text.startsWith("雰囲気モード オン")).toBe(true);
  expect(rec.opens).toEqual(["hud"]);

  // 道具の実行中は経過秒のバー（実データ）
  await $.turn.start({ text: "ビルド", turnId: "t1" });
  const call = $.tool.call({ tool: "Bash", command: "npm run build" });
  void call.catch(() => undefined);
  await rec.clock.settle();
  await rec.clock.advance(25_000);
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "AbovePrompt", props: { hasSurvey: false, isWorking: true, maxRows: 8, bodyColumns: 120 } as any });
  const lines = (await ui.findAll({ type: "Text" })).map((t) => t.text);
  await ui.unmount();
  expect(lines[0]).toBe("[██░░░░░░] 25s"); // 10 秒で 1 マス、幅 8
  expect(lines.some((l) => l.includes("ビルド中: npm run build"))).toBe(true); // やさしい日本語の帯はそのまま
  await rec.clock.advance(80_000);
  await call;

  expect((await $.command.run({ command: "kakkoii", args: "", ...RUN })).text).toBe("雰囲気モード オフ。HUD を閉じました");
  expect(rec.closes).toEqual(["hud"]);
});

test("雰囲気モードをオンのまま起動・再読み込みすると HUD を開き直す（オフなら開かない）", async ($, on) => {
  const rec = setup(on);
  await $.session.start({ cwd: "/proj", surface: "terminal", isInteractive: true });
  expect(rec.opens.filter((id) => id === "hud")).toEqual([]);
  await $.command.run({ command: "kakkoii", args: "", ...RUN });
  expect(rec.opens.filter((id) => id === "hud")).toEqual(["hud"]);
  // 再読み込み（session.start がもう一度来る）
  await $.session.start({ cwd: "/proj", surface: "terminal", isInteractive: true });
  expect(rec.opens.filter((id) => id === "hud")).toEqual(["hud", "hud"]);
});

test("ハッカー風の行: CTX ゲージ・30 秒ごとのスパークライン・道具が動いている間の脈動行（全部実データ）", async ($, on) => {
  // 純粋な部分
  expect(ctxGauge(38)).toBe("CTX      [███░░░░░]  38%");
  expect(ctxGauge(null)).toBe("CTX      [????????]   --");
  let h = pushHistory(undefined, T0, 100);
  h = pushHistory(h, T0 + 30_000, 400);
  h = pushHistory(h, T0 + 60_000, 0); // 0 は足さない
  expect(h).toHaveLength(2);
  expect(sparkline(h, T0 + 60_000, 4)).toBe("▁▃█▁"); // 古い順に並ぶ。最後の区間はまだ 0
  expect(sparkline(undefined, T0, 4)).toBe("▁▁▁▁");
  expect(pushHistory(h, T0 + 30 * 60_000, 5)).toHaveLength(1); // 20 分より古い物は落ちる
  const running = { phase: "running" as const, face: "", text: "x", tool: "Bash", isLong: false, startedAt: T0, at: T0 };
  expect(pulseLine(running, T0 + 12_000)).toBe("▶ RUNNING  bash       00:12");
  expect(pulseLine(running, T0 + 13_000)).toBe("▷ RUNNING  bash       00:13");
  expect(pulseLine({ ...running, tool: "mcp__claude-in-chrome__navigate" }, T0)).toBe("▶ RUNNING  claude-in- 00:00");
  expect(pulseLine({ ...running, phase: "writing", tool: null }, T0 + 5_000)).toBe("▷ WRITING  claude     00:05");
  expect(pulseLine({ ...running, phase: "between", tool: null }, T0)).toBeNull();
  expect(pulseLine(null, T0)).toBeNull();

  // HUD に出る: CTX は session.usage から、脈動行は道具が動いている間だけ
  const rec = setup(on, { bashTakes: 100_000 });
  await $.command.run({ command: "kakkoii", args: "", ...RUN });
  await $.turn.start({ text: "ビルドして", turnId: "t1" });
  let texts = (await hudTexts($)).map((t: any) => String(t.text));
  expect(texts).toContain("CTX      [███░░░░░]  38%");
  expect(texts.some((t) => t.startsWith("OUT/30s  "))).toBe(true);
  expect(texts.some((t) => t.includes("RUNNING"))).toBe(false);

  const call = $.tool.call({ tool: "Bash", command: "npm run build" });
  void call.catch(() => undefined);
  await rec.clock.settle();
  await rec.clock.advance(12_000);
  texts = (await hudTexts($)).map((t: any) => String(t.text));
  expect(texts).toContain("▶ RUNNING  bash       00:12");
});

test("Desktop では SVG で描く（数字は実データ、棒は前回の値から動く）", async ($, on) => {
  setup(on);
  await $.turn.start({ text: "x", turnId: "t1" });
  await $.tool.call({ tool: "Read", file_path: "/proj/src/a.ts" });
  const svgs = await hudTexts($, "desktop");
  expect(svgs).toHaveLength(1);
  const p = (svgs[0] as any).props;
  expect(String(p.alt)).toContain("FILES    1");
  expect(String(p.source)).toContain("<svg");
  expect(String(p.source)).toContain("<animate attributeName=\"width\"");
  expect(String(p.source)).toContain("#FFB000");
});

test("純粋な部分: バー・時計・ロゴの 1 行目・ログの 1 行", () => {
  expect(bar(3, 8)).toBe("[███░░░░░]");
  expect(bar(99, 8)).toBe("[████████]");
  expect(hms(3_725_000)).toBe("01:02:05");
  const stats = { startedAt: T0, inputTokens: 1234, outputTokens: 56, filesRead: ["a"], edits: 2, errors: 0, turnOutputTokens: 450 };
  expect(hudLines(stats, T0 + 61_000)[1]).toBe("TOKENS   in 1,234  out 56");
  expect(barForNow({ phase: "writing", face: "", text: "返事を書いてる", tool: null, isLong: true, startedAt: T0, at: T0 }, stats, T0 + 5000)).toEqual({ bar: "[██░░░░░░]", label: "450 tok" });
  expect(barForNow({ phase: "between", face: "", text: "", tool: null, isLong: false, startedAt: T0, at: T0 }, stats, T0)).toBeNull();
  expect(firstLineOf("# 次回\n\n- ログイン画面の仕上げから\n")).toBe("次回");
  expect(firstLineOf("\n\n- ログイン画面の仕上げから\n")).toBe("ログイン画面の仕上げから");
  expect(firstLineOf(null)).toBeNull();
  expect(logLineFor("Bash", { command: "npm   test\n" }, (p) => p)).toBe("Bash  npm test");
  expect(logLineFor("Read", { file_path: "/proj/x.ts" }, (p) => p.replace("/proj/", ""))).toBe("Read  x.ts");
});
