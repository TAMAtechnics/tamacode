// 【4】エラー翻訳のテスト。`claude plugin test .` で走る。
import { test, expect, mock } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";
import { buildErrorInfo, classifyError, exitCodeOf, hasErrorKeyword, isToolError, parseWhat, whereText } from "../hooks/errors";

const BAND = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } as any;
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

type BashAnswer = { text: string; exitCode?: number; isError?: boolean };

function setup(on: On, opts: { model?: string | "fail"; bash?: (cmd: string) => BashAnswer | null; models?: string[] } = {}) {
  mock.store(on, {});
  const clock = mock.clock(on, { now: 1_800_000_000_000 });
  on("session.cwd", () => ({ value: "/proj" }));
  on("ui.log", () => ({ value: undefined }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("env.get", () => ({ value: "/home/tama" }));
  on("fs.read", () => ({ deny: "ENOENT" }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Box } = $.ui.resolve(e);
    return <Box />;
  });
  on("model.complete", (_$, e) => {
    opts.models?.push(e.prompt);
    if (opts.model === "fail") return { value: { isAnswered: false, reason: "api-error", status: 500, error: "server_error", usage: USAGE } };
    return { value: { isAnswered: true, text: opts.model ?? "何が起きた: 接続先が返事をしませんでした", usage: USAGE } };
  });
  on("tool.call", { tool: "Bash" }, (_$, e) => {
    const cmd = String((e as any).command ?? "");
    const a = opts.bash?.(cmd) ?? null;
    if (a === null) return { result: { stdout: "ok", stderr: "", interrupted: false } as any, text: "ok" } as any;
    const code = a.exitCode ?? (a.isError ? 1 : 0);
    const text = code !== 0 ? `${a.text}${a.text === "" ? "" : "\n"}Exit code ${code}` : a.text;
    if (code !== 0) return { isError: true, result: { stdout: a.text, stderr: "", interrupted: false, exitCode: code } as any, text } as any;
    return { result: { stdout: a.text, stderr: "", interrupted: false } as any, text } as any;
  });
  return clock;
}

const bandText = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "AbovePrompt", props: BAND });
  const texts = (await ui.findAll({ type: "Text" })).map((t) => t.text);
  await ui.unmount();
  return texts;
};
const bandButtons = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "AbovePrompt", props: BAND });
  const labels = (await ui.findAll({ type: "Button" })).map((b: any) => b.props?.label ?? b.label);
  await ui.unmount();
  return labels;
};

const bash = (cmd: string, input: Record<string, unknown> = {}) => ({ command: cmd, ...input });

// ---------- 1. 判定は機械的に ----------

test("判定: 終了コードが 0 以外ならエラー。0 なら（読むだけのコマンド以外で）Error / ERR! / failed / Traceback / EACCES / ENOENT / 401 / 403 / 500 を含むときだけ", () => {
  const ok = (text: string) => ({ text, result: { stdout: text, stderr: "", interrupted: false } });
  const bad = (text: string, code = 1) => ({ isError: true as const, text: `${text}\nExit code ${code}`, result: { stdout: text, stderr: "", interrupted: false, exitCode: code } });
  expect(isToolError("Bash", bash("npm run build"), bad("error TS2322: Type 'string' is not assignable"))).toBe(true);
  expect(isToolError("Bash", bash("npm install"), ok("npm WARN deprecated\nnpm ERR! code ERESOLVE"))).toBe(true); // 終了 0 でも ERR!
  expect(isToolError("Bash", bash("npm test"), ok("3 passed, 0 failed"))).toBe(true); // 「failed」を含む（機械的なので拾う）
  expect(isToolError("Bash", bash("npm test"), ok("3 passed"))).toBe(false);
  expect(isToolError("Bash", bash("python app.py"), ok("Traceback (most recent call last):\n  File x"))).toBe(true);
  expect(isToolError("Bash", bash("curl -s https://x"), ok("HTTP 500 Internal Server Error"))).toBe(true);
  expect(isToolError("Bash", bash("echo hi"), ok("hi"))).toBe(false);
  expect(hasErrorKeyword("line 500 of file")).toBe(false); // 数字だけでは拾わない
  expect(hasErrorKeyword("status: 401")).toBe(true);
  // 中断・止めた物はエラーではない
  expect(isToolError("Bash", bash("npm run dev"), { text: "", result: { stdout: "", stderr: "", interrupted: true } })).toBe(false);
  expect(isToolError("Bash", bash("rm -rf x"), { deny: "見張りが止めました" })).toBe(false);
  // Bash 以外は isError のときだけ。読んだファイルの中身に Error と書いてあっても拾わない
  expect(isToolError("Read", { file_path: "/proj/hooks/errors.ts" }, { text: "export function looksLikeError() { throw new Error('x') }" })).toBe(false);
  expect(isToolError("Read", { file_path: "/proj/x.ts" }, { isError: true, text: "File does not exist." })).toBe(true);
  expect(isToolError("Edit", { file_path: "/proj/x.ts" }, { isError: true, text: "String to replace not found in file." })).toBe(true);
  expect(exitCodeOf({ text: "boom\nExit code 2" })).toBe(2);
  expect(exitCodeOf({ text: "boom" })).toBeNull();
});

test("誤判定しない 1: sed -n の正常な出力が「…」で切れていて、中に Error という字があってもエラーではない", () => {
  const out = [
    "   20\t// エラー翻訳（純粋な部分）",
    "   21\texport function looksLikeError(text: string): boolean {",
    "   22\t  return /\\b(Error|FAILED|failed)\\b/.test(text);",
    "   23\t  throw new Error('failed to parse')",
    "   24\t  // ENOENT や EACCES も拾う …",
  ].join("\n");
  const r = { text: out, result: { stdout: out, stderr: "", interrupted: false } };
  expect(isToolError("Bash", bash("sed -n 20,40p hooks/errors.ts"), r)).toBe(false);
  expect(isToolError("Bash", bash("cd /proj && cat -n hooks/errors.ts | head -50"), r)).toBe(false);
  expect(isToolError("Bash", bash("grep -rn 'Error' hooks/"), r)).toBe(false);
  expect(isToolError("Bash", bash("git log --oneline -5"), { text: "a1b2c3 fix: Error handling failed case …" })).toBe(false);
});

test("誤判定しない 2: grep が何も見つからず終了コード 1 で終わってもエラーではない（diff / test も同じ）", () => {
  const r = { isError: true as const, text: "Exit code 1", result: { stdout: "", stderr: "", interrupted: false, exitCode: 1 } };
  expect(isToolError("Bash", bash("grep -rn NOTICE_REF hooks/"), r)).toBe(false);
  expect(isToolError("Bash", bash("cd /proj && rg 'foo' src"), r)).toBe(false);
  expect(isToolError("Bash", bash("diff a.txt b.txt"), { isError: true, text: "1c1\n< a\n---\n> b\nExit code 1" })).toBe(false);
  // 同じ grep でも終了コード 2（引数の間違いなど）はエラー
  expect(isToolError("Bash", bash("grep -rn NOTICE_REF nothere/"), { isError: true, text: "grep: nothere/: No such file or directory\nExit code 2" })).toBe(true);
  // grep 以外の終了コード 1 はエラー
  expect(isToolError("Bash", bash("npm test"), r)).toBe(true);
});

// ---------- 2〜4. 文の形 ----------

test("1 行目は「⚠ どこで」: 道具と対象（ファイルはパスの末尾 2 階層、Bash は description か動詞）", () => {
  expect(whereText("Edit", { file_path: "/proj/hooks/activity.tsx" })).toBe("hooks/activity.tsx を書き換える処理が失敗");
  expect(whereText("Write", { file_path: "/proj/README.md" })).toBe("proj/README.md を書く処理が失敗"); // 末尾 2 階層
  expect(whereText("Read", { file_path: "/proj/config/vibe.json" })).toBe("config/vibe.json を読む処理が失敗");
  expect(whereText("Bash", { command: "npm run build", description: "ビルドを実行" })).toBe("ビルドを実行するコマンドが失敗");
  expect(whereText("Bash", { command: "npm run build" })).toBe("ビルドするコマンドが失敗");
  expect(whereText("Grep", { pattern: "NOTICE_REF" })).toBe("「NOTICE_REF」を探す処理が失敗");
  expect(whereText("mcp__claude-in-chrome__navigate", {})).toBe("claude-in-chrome への頼みごと「navigate」が失敗");
  const info = buildErrorInfo({ at: 1, tool: "Edit", input: { file_path: "/proj/hooks/activity.tsx" }, text: "String to replace not found in file.", sameCount: 1 });
  expect(info.lines[0]).toBe("⚠ hooks/activity.tsx を書き換える処理が失敗");
});

test("Claude が直せる種類（構文・型・テスト失敗・import 漏れ）は 1 行だけ。詳細は [+] の中", () => {
  const cases: Array<[string, string]> = [
    ["SyntaxError: Unexpected token '}'", "構文エラー（書き方の間違い）"],
    ["src/app.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.", "型エラー（データの種類の食い違い）"],
    ["Tests: 1 failed, 3 passed\nAssertionError: expected 1 to be 2", "テスト失敗（動作の自動確認が通らない）"],
    ["Error: Cannot find module './config'\n    at line 3", "import 漏れ（部品の読み込み忘れ）"],
    ["ReferenceError: foo is not defined", "プログラムの書き間違い"],
  ];
  for (const [text, kind] of cases) {
    const info = buildErrorInfo({ at: 1, tool: "Bash", input: { command: "npm test" }, text, sameCount: 1 });
    expect(info.kind).toBe("self");
    expect(info.lines).toEqual(["⚠ テストするコマンドが失敗。エラーが出ましたがClaudeが直してます"]);
    expect(info.details[0]).toBe(`種類: ${kind}`);
    expect(info.details.length).toBeGreaterThan(1);
    expect(info.isLoading).toBe(false); // モデルには頼まない
  }
});

test("「あなたがやること」が出るのは 4 種類だけ: ログイン・API キーや .env・権限・道具が入ってない", () => {
  const you = (text: string) => buildErrorInfo({ at: 1, tool: "Bash", input: { command: "npm install" }, text, sameCount: 1 });
  expect(you("npm ERR! 401 Unauthorized - GET https://registry.npmjs.org/x").lines).toEqual([
    "⚠ パッケージを入れるコマンドが失敗",
    "何が起きた: ログインが必要です（合言葉が通りませんでした）",
    "あなたがやること: もう一度ログインするか、合言葉を入れ直してください",
  ]);
  expect(you("Error: Missing API key. Set ANTHROPIC_API_KEY in .env").lines[2]).toBe("あなたがやること: 合鍵（API キー）を .env などの設定ファイルに入れてください");
  expect(you("EACCES: permission denied, open '/etc/hosts'").lines[2]).toBe("あなたがやること: その場所を触ってよいか確認し、必要なら権限（触ってよい許可）を出してください");
  expect(you("zsh: command not found: brew").lines).toEqual([
    "⚠ パッケージを入れるコマンドが失敗",
    "何が起きた: 道具「brew」がこのパソコンに入っていません",
    "あなたがやること: brew をインストールしてください（入れ方は Claude に聞けます）",
  ]);
  expect(classifyError("/bin/sh: node: command not found")).toEqual({ kind: "you", reason: "tool", name: "node" });
  // それ以外（ネット・ファイルが無い・不明）では「あなたがやること」は出さない
  for (const text of ["Error: connect ECONNREFUSED 127.0.0.1:5432", "Error: ENOENT: no such file or directory, open 'config.json'", "Error: something strange happened"]) {
    const info = buildErrorInfo({ at: 1, tool: "Bash", input: { command: "node x.js" }, text, sameCount: 1 });
    expect(info.kind).toBe("other");
    expect(info.lines.some((l) => l.startsWith("あなたがやること"))).toBe(false);
    expect(info.lines).toHaveLength(3);
  }
});

test("帯: それ以外のエラーは 3 行＋[+]。モデルは「何が起きた」だけ言い直し、失敗しても規則の行が残る", async ($, on) => {
  const prompts: string[] = [];
  const clock = setup(on, { models: prompts, bash: () => ({ text: "Error: connect ECONNREFUSED 127.0.0.1:5432\n    at TCPConnectWrap", exitCode: 1 }) });
  await $.turn.start({ text: "動かして", turnId: "t1" });
  await $.tool.call({ tool: "Bash", command: "node server.js", description: "サーバーを起動" });

  let lines = await bandText($);
  expect(lines).toContain("⚠ サーバーを起動するコマンドが失敗");
  expect(lines).toContain("何が起きた: Error: connect ECONNREFUSED 127.0.0.1:5432");
  expect(lines).toContain("Claudeが直せるか: たぶん直せる");
  expect(await bandButtons($)).toEqual(["[+]"]);
  expect(lines.some((l) => l.includes("at TCPConnectWrap"))).toBe(false); // 閉じている間は詳細は出ない

  await clock.advance(0);
  lines = await bandText($);
  expect(lines).toContain("何が起きた: 接続先が返事をしませんでした");
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toContain("やるべきことや直し方は書かないでください");

  // [+] を押すと詳細が開き、[−] になる（同じ描画の中で変わる）
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "AbovePrompt", props: BAND });
  await ui.press({ key: "error:toggle" });
  const opened = (await ui.findAll({ type: "Text" })).map((t) => t.text);
  expect(opened.some((l) => l.includes("at TCPConnectWrap"))).toBe(true);
  expect((await ui.findAll({ type: "Button" })).map((b: any) => b.props?.label ?? b.label)).toEqual(["[−]"]);
  await ui.unmount();
});

test("帯: 直せる種類は 1 行だけでモデルにも頼まない。あなたの作業が必要な種類は 3 行", async ($, on) => {
  const prompts: string[] = [];
  const clock = setup(on, { models: prompts, bash: (cmd) => (cmd === "npm test" ? { text: "FAIL src/app.test.ts\nAssertionError: expected 1 to be 2", exitCode: 1 } : { text: "npm ERR! 401 Unauthorized", exitCode: 1 }) });
  await $.turn.start({ text: "x", turnId: "t1" });
  await $.tool.call({ tool: "Bash", command: "npm test", description: "テストを実行" });
  await clock.advance(0);
  let lines = await bandText($);
  expect(lines).toContain("⚠ テストを実行するコマンドが失敗。エラーが出ましたがClaudeが直してます");
  expect(lines.some((l) => l.startsWith("何が起きた"))).toBe(false);
  expect(prompts).toHaveLength(0);

  await $.tool.call({ tool: "Bash", command: "npm publish" });
  lines = await bandText($);
  expect(lines).toContain("何が起きた: ログインが必要です（合言葉が通りませんでした）");
  expect(lines).toContain("あなたがやること: もう一度ログインするか、合言葉を入れ直してください");
  expect(prompts).toHaveLength(0);
});

test("モデルの返事は「何が起きた」だけ拾う", () => {
  expect(parseWhat("- 何が起きた：設定ファイルが見つかりません\nあなたがやること: 特になし")).toBe("設定ファイルが見つかりません");
  expect(parseWhat("意味不明")).toBeNull();
});

test("同じエラーが 3 回続くと「同じ所で3回詰まってます」に変わる", async ($, on) => {
  const clock = setup(on, { bash: () => ({ text: "Error: connect ECONNREFUSED 127.0.0.1:5432", exitCode: 1 }) });
  await $.turn.start({ text: "テストして", turnId: "t1" });
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: "Bash", command: "node x.js" });
  await clock.advance(0);
  const lines = await bandText($);
  expect(lines).toContain("⚠ x.js を動かすコマンドが失敗");
  expect(lines).toContain("同じ所で3回詰まってます。目的を言い直すか /onegai（おねがい）で整理");
  expect(lines.some((l) => l.startsWith("何が起きた:"))).toBe(false);
});

test("sed の「…」切れや grep の終了コード 1 では帯にエラーが出ない。次の道具が動き出すとエラーは消える", async ($, on) => {
  setup(on, {
    bash: (cmd) => {
      if (cmd.startsWith("sed")) return { text: "  12\tthrow new Error('failed') …", exitCode: 0 };
      if (cmd.startsWith("grep")) return { text: "", exitCode: 1 };
      if (cmd === "npm test") return { text: "Error: boom", exitCode: 1 };
      return null;
    },
  });
  await $.turn.start({ text: "x", turnId: "t1" });
  await $.tool.call({ tool: "Bash", command: "sed -n 10,20p hooks/errors.ts" });
  expect((await bandText($)).some((l) => l.startsWith("⚠"))).toBe(false);
  await $.tool.call({ tool: "Bash", command: "grep -rn nothing hooks/" });
  expect((await bandText($)).some((l) => l.startsWith("⚠"))).toBe(false);
  await $.tool.call({ tool: "Bash", command: "npm test" });
  expect((await bandText($)).some((l) => l.startsWith("⚠"))).toBe(true);
  await $.tool.call({ tool: "Bash", command: "echo hi" });
  expect((await bandText($)).some((l) => l.startsWith("⚠"))).toBe(false);
});
