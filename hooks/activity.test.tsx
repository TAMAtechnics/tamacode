// 今やってることの帯・待ってていいかの判定・履歴（/log）・迷走検知・Spinner のテスト。`claude plugin test .` で走る。
import { test, expect, mock } from "claude-code/testing";
import type { Engine, MockClock } from "claude-code/testing";
import type { On } from "claude-code";
import { CAT, describeTool, isLongBash, jpDuration, judge, readFilesInCommand } from "./activity";

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 6, bodyColumns: 100 } as any;
const WORKING = { ...BAND_PROPS, isWorking: true };
const PANE_PROPS = { title: "やったこと", isFocused: true, bodyColumns: 60, placement: "dock", scroll: { top: 0 }, view: {} } as any;
const RUN = { origin: { kind: "composer" }, presentation: { isFullscreen: true, columns: 120 } } as const;
const MESSAGE = "Claudeが迷ってます。目的をもう一度言い直すか、/plan で整理すると抜けやすいです";
const T0 = 1_800_000_000_000;

type SetupOptions = {
  /** Bash の底が返すエラー文。指定するとエラー扱い */
  bashError?: string | ((cmd: string) => string | null);
  /** Bash の底が結果を返すまでに待つミリ秒（実行中の帯を見るため） */
  bashTakes?: number;
  toasts?: string[];
};

function setup(on: On, opts: SetupOptions = {}) {
  mock.store(on, {});
  const clock = mock.clock(on, { now: T0 });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("session.cwd", () => ({ value: "/proj" }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.log", () => ({ value: undefined }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.toast", (_$, e) => {
    opts.toasts?.push(e.text);
    return { value: undefined };
  });
  on("env.get", () => ({ value: "/home/tama" }));
  on("fs.read", () => ({ value: "const a = 1;\n" }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  // 帯に出す物が無いとき、プラグインは next(e) でエンジンに任せる。ここではエンジンの代わりに空の箱を描く
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Box } = $.ui.resolve(e);
    return <Box />;
  });
  // Spinner のエンジン側: 言葉と末尾をそのまま 1 行に
  on("ui.render", { component: "Spinner" }, ($, e) => {
    const { Text } = $.ui.resolve(e);
    return (
      <Text>
        {e.props.word}
        {e.props.suffix}
      </Text>
    );
  });
  on("tool.call", { tool: "Read" }, (_$, e) => ({ result: { file: { filePath: (e as any).file_path, content: "x", numLines: 1, startLine: 1, totalLines: 1 } } as any }));
  on("tool.call", { tool: "AskUserQuestion" }, async () => {
    await clock.sleep(400_000);
    return { result: { answers: {} } as any };
  });
  on("tool.call", { tool: "Bash" }, async (_$, e) => {
    if (opts.bashTakes !== undefined) await clock.sleep(opts.bashTakes);
    const cmd = String((e as any).command ?? "");
    const err = typeof opts.bashError === "function" ? opts.bashError(cmd) : (opts.bashError ?? null);
    if (err !== null) return { isError: true, result: err, text: err } as any;
    return { result: { stdout: "ok", stderr: "", interrupted: false } as any };
  });
  return clock;
}

const mountBand = ($: Engine, props = BAND_PROPS) => $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "AbovePrompt", props });

// 帯の Text を読んで、すぐ外す（何度も見るため）
const bandText = async ($: Engine, props = BAND_PROPS) => {
  const ui = await mountBand($, props);
  const texts = (await ui.findAll({ type: "Text" })).map((t) => t.text);
  await ui.unmount();
  return texts;
};

const read = ($: Engine, file: string) => $.tool.call({ tool: "Read", file_path: file });
const bash = ($: Engine, command: string) => $.tool.call({ tool: "Bash", command });

// 道具を始めて（結果は待たず）、帯を見る
const startAndPeek = async ($: Engine, clock: MockClock, call: Promise<unknown>) => {
  void call.catch(() => undefined);
  await clock.settle();
  return bandText($, WORKING);
};

// ---------- 今やってること・待ってていいか ----------

test("A 実行中: 時間がかかる Bash は「待ってOK」。60 秒を超えても変わらない", async ($, on) => {
  const clock = setup(on, { bashTakes: 100_000 });
  await $.turn.start({ text: "ビルドして", turnId: "t1" });

  const call = bash($, "npm run build");
  expect(await startAndPeek($, clock, call)).toEqual([`${CAT.run} ビルド中: npm run build　0秒　時間がかかる作業なので待ってOK`]);

  await clock.advance(65_000);
  expect(await bandText($, WORKING)).toEqual([`${CAT.run} ビルド中: npm run build　1分5秒　時間がかかる作業なので待ってOK`]);

  await clock.advance(35_000);
  await call;
  // 終わったら「次を考えてる」
  expect(await bandText($, WORKING)).toEqual([`${CAT.think} 次を考えてる　0秒`]);
});

test("A→D: 時間がかかる系でない Bash は 60 秒で「動いてないかも」、120 秒で「Esc で止めて」になる", async ($, on) => {
  const clock = setup(on, { bashTakes: 200_000 });
  await $.turn.start({ text: "見て", turnId: "t1" });

  const call = bash($, "cat -n hooks/terms.tsx");
  expect(await startAndPeek($, clock, call)).toEqual([`${CAT.read} ファイルの中身を見てる: cat -n hooks/terms.tsx　0秒`]);

  await clock.advance(61_000);
  expect(await bandText($, WORKING)).toEqual([`${CAT.error} ファイルの中身を見てる: cat -n hooks/terms.tsx　1分1秒　動いてないかも`]);

  await clock.advance(60_000);
  expect(await bandText($, WORKING)).toEqual([`${CAT.stopped} ファイルの中身を見てる: cat -n hooks/terms.tsx　2分1秒　Escで止めて続きを頼むのが安全`]);
  await clock.advance(100_000);
  await call;
});

test("C 返事待ち: 質問で止まっているときは「あなたの番です」。いくら経っても変わらない", async ($, on) => {
  const clock = setup(on);
  await $.turn.start({ text: "決めて", turnId: "t1" });

  const call = $.tool.call({ tool: "AskUserQuestion", questions: [] } as any);
  expect(await startAndPeek($, clock, call)).toEqual([`${CAT.sleep} 質問に答えてください　0秒　あなたの番です`]);
  await clock.advance(300_000);
  expect(await bandText($, WORKING)).toEqual([`${CAT.sleep} 質問に答えてください　5分　あなたの番です`]);
  await clock.advance(100_000);
  await call;
});

test("D 無反応: 道具が終わってから何も起きないと 60 秒で「動いてないかも」", async ($, on) => {
  const clock = setup(on);
  await $.turn.start({ text: "見て", turnId: "t1" });
  await read($, "/proj/hooks/changes.tsx");
  expect(await bandText($, WORKING)).toEqual([`${CAT.think} 次を考えてる　0秒`]);
  await clock.advance(61_000);
  expect(await bandText($, WORKING)).toEqual([`${CAT.error} 次を考えてる　1分1秒　動いてないかも`]);
});

test("エラーで終わった道具はエラーの猫と見出しを出す。拒否されたら「止めました」", async ($, on) => {
  setup(on, { bashError: "Error: Cannot find module './config'\n    at line 3" });
  on("tool.call", { tool: "Grep" }, () => ({ deny: "許可されていません" }));
  await $.turn.start({ text: "テストして", turnId: "t1" });

  await bash($, "npm test");
  expect(await bandText($, WORKING)).toEqual([`${CAT.error} エラーが出ました: Error: Cannot find module './config'　0秒`]);

  await $.tool.call({ tool: "Grep", pattern: "x" } as any);
  expect(await bandText($, WORKING)).toEqual([`${CAT.stopped} 止めました: 許可されていません　0秒`]);
});

test("返事が終わる（isWorking でない）と帯の「今やってること」は出ない", async ($, on) => {
  setup(on);
  await $.turn.start({ text: "見て", turnId: "t1" });
  await bash($, "cat -n hooks/terms.tsx");
  expect(await bandText($, BAND_PROPS)).toEqual([]);

  await $.turn.complete({ answer: "見ました", reason: "answer", durationMs: 1000, isAborted: false, turnId: "t1" } as any);
  expect(await bandText($, WORKING)).toEqual([]);
});

test("judge: 書き出し中は「待ってOK」、60 秒文字が増えなければ D になる", () => {
  const now = { phase: "writing", face: CAT.pause, text: "返事を書いてる", tool: null, isLong: true, startedAt: T0, at: T0 } as const;
  expect(judge(now, T0 + 5_000).line).toBe(`${CAT.pause} 返事を書いてる　5秒　書き出し中なので待ってOK`);
  expect(judge({ ...now, at: T0 + 30_000 }, T0 + 95_000).line).toBe(`${CAT.error} 返事を書いてる　1分35秒　動いてないかも`);
  expect(judge(now, T0 + 130_000).verdict).toBe("Escで止めて続きを頼むのが安全");
});

test("/log で履歴ペインが開き、同じことが続いたら ×n にまとまる。エラーも残る", async ($, on) => {
  setup(on, { bashError: (cmd) => (cmd === "npm test" ? "Error: boom" : null) });
  await $.turn.start({ text: "見て", turnId: "t1" });
  await bash($, "cat -n hooks/terms.tsx");
  await bash($, "cat -n hooks/terms.tsx");
  await bash($, "cat -n hooks/terms.tsx");
  await bash($, "npm test");

  expect((await $.command.run({ command: "log", args: "", ...RUN })).text).toBe(`${CAT.idle} やったことペインを開きました（3件）。Esc で閉じます`);
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "Pane", requestId: "log", props: PANE_PROPS });
  const texts = (await ui.findAll({ type: "Text" })).map((t) => t.text);
  expect(texts.some((t) => t.includes(`${CAT.read} ファイルの中身を見てる: cat -n hooks/terms.tsx`) && t.includes("×3"))).toBe(true);
  expect(texts.some((t) => t.includes(`${CAT.run} テスト中: npm test`))).toBe(true);
  expect(texts.some((t) => t.includes(`${CAT.error} エラーが出ました: Error: boom`))).toBe(true);
  // 新しい順
  const i = texts.findIndex((t) => t.includes("エラーが出ました"));
  const j = texts.findIndex((t) => t.includes("ファイルの中身を見てる"));
  expect(i).toBeLessThan(j);
});

test("Spinner は猫と日本語になり、道具を動かしている間は帯と同じ文になる", async ($, on) => {
  setup(on);
  const spinner = async (mode: string) => {
    const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "Spinner", requestId: "main", props: { word: "Flowing", message: null, suffix: "…", mode } as any });
    const texts = (await ui.findAll({ type: "Text" })).map((t) => t.text);
    await ui.unmount();
    return texts;
  };

  expect(await spinner("thinking")).toEqual([`${CAT.think} 考え中…`]);
  expect(await spinner("responding")).toEqual([`${CAT.pause} 書いてます…`]);
  expect(await spinner("tool-use")).toEqual([`${CAT.run} 作業中…`]);

  await $.turn.start({ text: "見て", turnId: "t1" });
  await bash($, "cat -n hooks/terms.tsx");
  expect(await spinner("tool-use")).toEqual([`${CAT.think} 次を考えてる…`]);
});

test("返事の最後の行（Crunched for 4s）は「完了」の猫と秒数になる", async ($, on) => {
  setup(on);
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "TurnDuration", requestId: "m1", props: { word: "Crunched", durationMs: 64_000 } as any });
  expect((await ui.findAll({ type: "Text" })).map((t) => t.text)).toEqual([`${CAT.done} 1分4秒で完了`]);
  expect(jpDuration(4_000)).toBe("4秒");
  expect(jpDuration(120_000)).toBe("2分");
  expect(jpDuration(3_720_000)).toBe("1時間2分");
});

test("道具の一言: 名前は日本語、対象つき。Bash はコマンドを見せ、長い系と危ない系を見分ける", () => {
  expect(describeTool("Read", { file_path: "/proj/src/api.ts" }, "/proj")).toMatchObject({ face: CAT.read, text: "ファイルを読んでる: src/api.ts", readFiles: ["/proj/src/api.ts"], isLong: false });
  expect(describeTool("Read", { file_path: "/etc/hosts" }, "/proj").text).toBe("ファイルを読んでる: hosts");
  expect(describeTool("Edit", { file_path: "/proj/a.ts" }, "/proj")).toMatchObject({ face: CAT.write, text: "ファイルを書き換えてる: a.ts" });
  expect(describeTool("WebSearch", { query: "bun test" }, "/proj")).toMatchObject({ face: CAT.web, isLong: true });
  expect(describeTool("AskUserQuestion", {}, "/proj")).toMatchObject({ face: CAT.sleep, isWaiting: true });
  expect(describeTool("TodoWrite", {}, "/proj").face).toBe(CAT.pause);
  expect(describeTool("Bash", { command: "npm install" }, "/proj")).toMatchObject({ face: CAT.run, text: "パッケージを入れてる: npm install", isLong: true });
  expect(describeTool("Bash", { command: "rm -rf dist" }, "/proj")).toMatchObject({ face: CAT.danger, text: "ファイルを削除してる: rm -rf dist", isLong: false });
  expect(describeTool("Bash", { command: "git push origin main" }, "/proj").face).toBe(CAT.danger);
  expect(describeTool("Bash", { command: "head -20 README.md" }, "/proj")).toMatchObject({ face: CAT.read, text: "ファイルの中身を見てる: head -20 README.md", readFiles: ["/proj/README.md"] });
  expect(describeTool("Bash", { command: "echo hi" }, "/proj")).toMatchObject({ face: CAT.run, text: "コマンドを実行してる: echo hi", isLong: false });
  expect(describeTool("mcp__plugin_context7_context7__authenticate", {}, null).text).toBe("plugin_context7_context7 に頼んでる: authenticate");
  expect(isLongBash("bunx tsc -p tsconfig.json")).toBe(true);
  expect(isLongBash("ls -la")).toBe(false);
});

test("コマンドからファイル名を抜く: オプション・sed のアドレス・リダイレクト・変数は無視する", () => {
  expect(readFilesInCommand("cat -n hooks/terms.tsx")).toEqual(["hooks/terms.tsx"]);
  expect(readFilesInCommand("sed -n 100,330p hooks/terms.tsx 2>/dev/null")).toEqual(["hooks/terms.tsx"]);
  expect(readFilesInCommand('cd "/proj" && cat -n "hooks/a.tsx" hooks/b.tsx | grep foo')).toEqual(["hooks/a.tsx", "hooks/b.tsx"]);
  expect(readFilesInCommand('for f in a b; do cat -n "$f"; done')).toEqual([]);
  expect(readFilesInCommand("npm test")).toEqual([]);
});

// ---------- 迷走検知 ----------

test("同じファイルを 5 回読むと帯が出る（4 回では出ない）", async ($, on) => {
  const toasts: string[] = [];
  setup(on, { toasts });
  await $.turn.start({ text: "直して", turnId: "t1" });

  for (let i = 0; i < 4; i++) await read($, "/proj/src/api.ts");
  expect(await bandText($)).toEqual([]);

  await read($, "/proj/src/api.ts");
  const lines = await bandText($);
  expect(lines.some((t) => t.includes(MESSAGE))).toBe(true);
  expect(lines.some((t) => t.includes("api.ts を 5 回読んでいます"))).toBe(true);
  expect(toasts).toEqual([`${CAT.lost} ${MESSAGE}`]);
});

test("Bash の cat も同じファイルの読みとして数える（Read と合わせて 5 回）", async ($, on) => {
  setup(on);
  await $.turn.start({ text: "直して", turnId: "t1" });
  for (let i = 0; i < 3; i++) await bash($, "cat -n src/api.ts");
  await read($, "/proj/src/api.ts");
  expect(await bandText($)).toEqual([]);
  await read($, "/proj/src/api.ts");
  expect((await bandText($)).some((t) => t.includes("api.ts を 5 回読んでいます"))).toBe(true);
});

test("別々のファイルを読んでいるだけなら出ない", async ($, on) => {
  setup(on);
  await $.turn.start({ text: "調べて", turnId: "t1" });
  for (let i = 0; i < 8; i++) await read($, `/proj/src/f${i}.ts`);
  expect(await bandText($)).toEqual([]);
});

test("同じエラーが 3 回続くと帯が出る。行番号が違っても同じエラーとみなす", async ($, on) => {
  const toasts: string[] = [];
  let n = 0;
  setup(on, { toasts, bashError: () => `Error: Cannot find module './config'\n    at line ${++n}` });
  await $.turn.start({ text: "テスト通して", turnId: "t1" });

  await bash($, "npm test");
  await bash($, "npm test");
  expect(await bandText($)).toEqual([]);

  await bash($, "npm test");
  const lines = await bandText($);
  expect(lines.some((t) => t.includes(MESSAGE))).toBe(true);
  expect(lines.some((t) => t.includes("同じエラーが 3 回続いています: Error: Cannot find module './config'"))).toBe(true);
  // 回数が増えても帯は更新され、お知らせ（トースト）は 1 回だけ
  await bash($, "npm test");
  expect((await bandText($)).some((t) => t.includes("同じエラーが 4 回続いています"))).toBe(true);
  expect(toasts).toHaveLength(1);
});

test("違うエラーが続いても出ない。成功した道具も数えない", async ($, on) => {
  let n = 0;
  setup(on, { bashError: (cmd) => (cmd === "ok" ? null : `Error ${String.fromCharCode(65 + n++)}: something`) });
  await $.turn.start({ text: "x", turnId: "t1" });
  for (let i = 0; i < 4; i++) await bash($, "fail");
  for (let i = 0; i < 4; i++) await bash($, "ok");
  expect(await bandText($)).toEqual([]);
});

test("新しいターンが始まると数え直しで帯も消える", async ($, on) => {
  setup(on);
  await $.turn.start({ text: "直して", turnId: "t1" });
  for (let i = 0; i < 5; i++) await read($, "/proj/src/api.ts");
  expect((await bandText($)).length).toBeGreaterThan(0);

  await $.turn.start({ text: "目的はこうです", turnId: "t2" });
  expect(await bandText($)).toEqual([]);
  for (let i = 0; i < 4; i++) await read($, "/proj/src/api.ts");
  expect(await bandText($)).toEqual([]);
});

test("「閉じる」で帯が消える", async ($, on) => {
  setup(on);
  await $.turn.start({ text: "直して", turnId: "t1" });
  for (let i = 0; i < 5; i++) await read($, "/proj/src/api.ts");

  const ui = await mountBand($);
  await ui.press({ key: "wander:close" });
  expect(await ui.findAll({ type: "Text" })).toEqual([]);
});

test("サブエージェントの道具は数えないし、帯にも出さない", async ($, on) => {
  setup(on);
  await $.turn.start({ text: "調べて", turnId: "t1" });
  for (let i = 0; i < 6; i++) await $.tool.call({ tool: "Read", file_path: "/proj/src/api.ts", agentId: "agent-1" } as any);
  expect(await bandText($)).toEqual([]);
  expect(await bandText($, WORKING)).toEqual([]);
});
