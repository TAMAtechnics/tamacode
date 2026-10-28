// 【4】エラー翻訳のテスト。`claude plugin test .` で走る。
import { test, expect, mock } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";
import { errorGuess, errorLines, looksLikeError, parseErrorLines } from "../hooks/errors";

const BAND = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } as any;
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

function setup(on: On, opts: { model?: string | "fail"; bashError?: (cmd: string) => string | null; bashText?: string } = {}) {
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
  on("model.complete", () => {
    if (opts.model === "fail") return { value: { isAnswered: false, reason: "api-error", status: 500, error: "server_error", usage: USAGE } };
    return { value: { isAnswered: true, text: opts.model ?? "何が起きた: ログインの期限が切れました\nClaudeが直せるか: あなたの作業が必要\nあなたがやること: もう一度ログインしてください", usage: USAGE } };
  });
  on("tool.call", { tool: "Bash" }, (_$, e) => {
    const cmd = String((e as any).command ?? "");
    const err = opts.bashError?.(cmd) ?? null;
    if (err !== null) return { isError: true, result: err, text: err } as any;
    const out = opts.bashText ?? "ok";
    return { result: { stdout: out, stderr: "", interrupted: false } as any, text: out } as any;
  });
  return clock;
}

const bandText = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "AbovePrompt", props: BAND });
  const texts = (await ui.findAll({ type: "Text" })).map((t) => t.text);
  await ui.unmount();
  return texts;
};

test("規則の即答: 401 はあなたの作業（ログイン）、TypeError は直せる、ENOENT はたぶん直せる", () => {
  const auth = errorGuess("npm ERR! 401 Unauthorized - GET https://registry.npmjs.org/x", "Bash");
  expect(auth.canFix).toBe("you");
  expect(errorLines(auth)).toEqual(["何が起きた: ログインや合言葉（認証）が通りませんでした", "Claudeが直せるか: あなたの作業が必要", "あなたがやること: もう一度ログインするか、合言葉を入れ直してください"]);

  const code = errorGuess("TypeError: Cannot read properties of undefined (reading 'map')\n    at App (src/App.tsx:12:5)", "Bash");
  expect(code.canFix).toBe("yes");
  expect(errorLines(code)).toHaveLength(2);

  expect(errorGuess("Error: ENOENT: no such file or directory, open 'config.json'", "Read").canFix).toBe("maybe");
  expect(errorGuess("Error: connect ECONNREFUSED 127.0.0.1:5432", "Bash").action).toBe("ネットや接続先が動いているか確認してください");
  expect(errorGuess("EACCES: permission denied, open '/etc/hosts'", "Bash").canFix).toBe("you");
  expect(looksLikeError("all good\n3 passed")).toBe(false);
  expect(looksLikeError("npm ERR! code ELIFECYCLE")).toBe(true);
  expect(looksLikeError("GET /api/users 404 Not Found")).toBe(true);
});

test("モデルの返事の整形。『あなたがやること: 特になし』は 2 行扱い", () => {
  expect(parseErrorLines("- 何が起きた：設定ファイルが見つかりません\nClaudeが直せるか: たぶん直せる\nあなたがやること: 特になし")).toEqual({ what: "設定ファイルが見つかりません", canFix: "maybe", action: null });
  expect(parseErrorLines("意味不明")).toBeNull();
});

test("エラーが出ると帯に 3 行が出て、モデルの返事で言い直される", async ($, on) => {
  const clock = setup(on, { bashError: () => "npm ERR! 401 Unauthorized - GET https://registry.npmjs.org/x\nnpm ERR! A complete log of this run can be found in: /x.log" });
  await $.turn.start({ text: "入れて", turnId: "t1" });
  await $.tool.call({ tool: "Bash", command: "npm install" });

  let lines = await bandText($);
  expect(lines.some((l) => l.startsWith("(=T_q_T=) エラーが出ました"))).toBe(true);
  expect(lines).toContain("何が起きた: ログインや合言葉（認証）が通りませんでした");
  expect(lines).toContain("Claudeが直せるか: あなたの作業が必要");

  await clock.advance(0);
  lines = await bandText($);
  expect(lines).toContain("何が起きた: ログインの期限が切れました");
  expect(lines).toContain("あなたがやること: もう一度ログインしてください");
});

test("成功した結果の中のエラー文（exit 0 の npm ERR!）も拾う", async ($, on) => {
  const clock = setup(on, { bashText: "npm WARN deprecated\nnpm ERR! code ERESOLVE\nnpm ERR! ERESOLVE unable to resolve dependency tree" });
  await $.turn.start({ text: "入れて", turnId: "t1" });
  await $.tool.call({ tool: "Bash", command: "npm install" });
  await clock.advance(0);
  const lines = await bandText($);
  expect(lines.some((l) => l.startsWith("何が起きた:"))).toBe(true);
});

test("同じエラーが 3 回続くと「同じ所で詰まってます」に変わる", async ($, on) => {
  const clock = setup(on, { bashError: () => "Error: Cannot find module './config'\n    at line 3" });
  await $.turn.start({ text: "テストして", turnId: "t1" });
  for (let i = 0; i < 3; i++) await $.tool.call({ tool: "Bash", command: "npm test" });
  await clock.advance(0);
  const lines = await bandText($);
  expect(lines.some((l) => l.includes("同じ所で詰まってます。目的を言い直すか /onegai（おねがい）で整理を"))).toBe(true);
  expect(lines.some((l) => l.startsWith("何が起きた:"))).toBe(false);
});

test("モデルが失敗したら、生のエラー 1 行＋「詰まってます」だけ出す", async ($, on) => {
  const clock = setup(on, { model: "fail", bashError: () => "Error: something strange happened\nmore" });
  await $.turn.start({ text: "x", turnId: "t1" });
  await $.tool.call({ tool: "Bash", command: "node x.js" });
  await clock.advance(0);
  const lines = await bandText($);
  expect(lines).toContain("Error: something strange happened");
  expect(lines).toContain("詰まってます");
  expect(lines.some((l) => l.startsWith("何が起きた:"))).toBe(false);
});

test("次の道具が動き出すとエラーの 3 行は消える", async ($, on) => {
  setup(on, { bashError: (cmd) => (cmd === "npm test" ? "Error: boom" : null) });
  await $.turn.start({ text: "x", turnId: "t1" });
  await $.tool.call({ tool: "Bash", command: "npm test" });
  await $.tool.call({ tool: "Bash", command: "echo hi" });
  const lines = await bandText($);
  expect(lines.some((l) => l.startsWith("何が起きた:"))).toBe(false);
});
