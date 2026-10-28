// 用語翻訳ペインのテスト。`claude plugin test .` で走る。
import { test, expect, mock } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";

const HOME = "/home/tama";
const USER_FILE = `${HOME}/.claude/tamacode-terms.json`;
const PANE_PROPS = {
  title: "用語",
  isFocused: true,
  bodyColumns: 48,
  placement: "dock",
  scroll: { top: 0 },
  view: {},
} as any;
const RUN = { origin: { kind: "composer" }, presentation: { isFullscreen: true, columns: 120 } } as const;

type SetupOptions = {
  /** 辞書ファイルの中身。null なら「まだ無い」 */
  userFile?: string | null;
  /** 書き込みをここに記録する */
  writes?: Array<{ path: string; text: string }>;
  home?: string | undefined;
};

// テストの「底」: エンジンの代わりに答えるフック
function setup(on: On, opts: SetupOptions = {}) {
  mock.store(on, {});
  const clock = mock.clock(on, { now: 1_800_000_000_000 });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.log", () => ({ value: undefined }));
  on("env.get", () => ({ value: "home" in opts ? opts.home : HOME }));
  on("fs.read", (_$, e) => {
    if (e.path === USER_FILE) {
      if (opts.userFile === null || opts.userFile === undefined) return { deny: "ENOENT: no such file" };
      return { value: opts.userFile };
    }
    return { deny: "ENOENT: no such file" };
  });
  on("fs.write", (_$, e) => {
    opts.writes?.push({ path: e.path, text: e.text });
    return { value: undefined };
  });
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  return clock;
}

const start = ($: Engine) => $.session.start({ cwd: "/proj", surface: "terminal", isInteractive: true });

const answer = ($: Engine, text: string, extra: Record<string, unknown> = {}) =>
  $.turn.complete({ answer: text, reason: "answer", durationMs: 1000, isAborted: false, turnId: "t1", ...extra } as any);

const mountPane = ($: Engine) =>
  $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "Pane", requestId: "terms", props: PANE_PROPS });

// ペインに並んでいる用語名（太字の Text）だけを順に取り出す
const terms = async (ui: Awaited<ReturnType<typeof mountPane>>) =>
  (await ui.findAll({ type: "Text" }))
    .filter((t) => t.props.bold === true && !t.text.startsWith("📘"))
    .map((t) => t.text);

test("返事に出た専門用語を、出てきた順に一言説明つきで並べる", async ($, on) => {
  setup(on);
  await start($);
  await answer($, "まず環境変数を設定してから、ビルドして本番にデプロイします。マイグレーションも忘れずに。");

  const ui = await mountPane($);
  expect(await terms(ui)).toEqual(["環境変数", "ビルド", "本番環境", "デプロイ", "マイグレーション"]);
  expect(await ui.find({ type: "Text", text: "作ったものを本番のサーバーに置いて、みんなが使える状態にすること。" })).toBeDefined();
});

test("英語表記（deploy / .env）でも拾い、単語の一部（deployed の中など）には反応しない", async ($, on) => {
  setup(on);
  await start($);
  await answer($, "Run `vercel deploy` after editing .env. (undeployed は無視)");
  const ui = await mountPane($);
  expect(await terms(ui)).toEqual(["デプロイ", "環境変数"]);
});

test("コードブロックの中の単語は拾わない。カタカナは別の語の一部なら拾わない（ログイン ≠ ログ）", async ($, on) => {
  setup(on);
  await start($);
  await answer($, "ログイン画面を直しました。\n```\nnpm run build && git push\n```\n");
  const ui = await mountPane($);
  // 「ログ」は「ログイン」の一部なので出ない（「ログイン」自体は「認証」として出る）。build/push はコードブロック内なので出ない
  expect(await terms(ui)).toEqual(["認証"]);
});

test("紛らわしい物は拾わない: 典型（型）、index.ts（インデックス）、パスワード（パス）", async ($, on) => {
  setup(on);
  await start($);
  await answer($, "典型的な例です。index.ts にパスワードの確認を足しました。");
  const ui = await mountPane($);
  expect(await terms(ui)).toEqual([]);
});

test("サブエージェントの返事や、途中で止まった返事は見ない", async ($, on) => {
  setup(on);
  await start($);
  await answer($, "デプロイしました", { agentId: "agent-1" });
  await answer($, "デプロイしました", { reason: "aborted", isAborted: true });
  const ui = await mountPane($);
  expect(await ui.find({ type: "Text", text: /ここに専門用語の説明が並びます/ })).toBeDefined();
});

test("専門用語が無い返事なら、その旨だけ出る", async ($, on) => {
  setup(on);
  await start($);
  await answer($, "はい、できました。");
  const ui = await mountPane($);
  expect(await ui.find({ type: "Text", text: "この返事に、辞書にある専門用語はありませんでした。" })).toBeDefined();
});

test("自分の辞書（ファイル）は組み込みより優先され、known の語は出ない", async ($, on) => {
  setup(on, {
    userFile: JSON.stringify({ terms: { デプロイ: "うちでは「公開」のこと。", たまコード: "このプラグインの名前。" }, known: ["ビルド"] }),
  });
  await start($);
  await answer($, "ビルドしてデプロイしました。たまコードも更新。");
  const ui = await mountPane($);
  expect(await terms(ui)).toEqual(["デプロイ", "たまコード"]);
  expect(await ui.find({ type: "Text", text: "うちでは「公開」のこと。" })).toBeDefined();
  expect(await ui.find({ type: "Text", text: "　自分の辞書" })).toBeDefined();
});

test("辞書ファイルが壊れていても止まらず、組み込み辞書で動く", async ($, on) => {
  setup(on, { userFile: "{ this is not json" });
  await start($);
  await answer($, "デプロイしました");
  const ui = await mountPane($);
  expect(await terms(ui)).toEqual(["デプロイ"]);
});

test("/terms add で辞書に足すとファイルに保存され、直近の返事にもすぐ反映される", async ($, on) => {
  const writes: Array<{ path: string; text: string }> = [];
  setup(on, { writes });
  await start($);
  await answer($, "ペインを開いてください。");
  const ui = await mountPane($);
  expect(await terms(ui)).toEqual([]);

  const { text } = await $.command.run({ command: "terms", args: "add ペイン 画面の右側に出る小窓のこと", ...RUN });
  expect(text).toBe("📘 「ペイン」を自分の辞書に足しました");
  expect(writes).toHaveLength(1);
  expect(writes[0]!.path).toBe(USER_FILE);
  expect(JSON.parse(writes[0]!.text)).toEqual({ terms: { ペイン: "画面の右側に出る小窓のこと" }, known: [] });

  // 開いているペインにもすぐ反映される
  expect(await terms(ui)).toEqual(["ペイン"]);
  expect(await ui.find({ type: "Text", text: "画面の右側に出る小窓のこと" })).toBeDefined();
});

test("/terms add は「用語: 説明」の形でも受け付ける", async ($, on) => {
  const writes: Array<{ path: string; text: string }> = [];
  setup(on, { writes });
  await start($);
  await $.command.run({ command: "terms", args: "add API キー: 外部サービスの合鍵", ...RUN });
  expect(JSON.parse(writes[0]!.text).terms).toEqual({ "API キー": "外部サービスの合鍵" });
});

test("/terms know で「知ってる」にすると次から出ず、unknow で戻る", async ($, on) => {
  const writes: Array<{ path: string; text: string }> = [];
  setup(on, { writes });
  await start($);
  await answer($, "ビルドしてデプロイしました。");
  const ui = await mountPane($);

  expect((await $.command.run({ command: "terms", args: "know ビルド", ...RUN })).text).toBe("🙆 「ビルド」はもう出しません");
  expect(await terms(ui)).toEqual(["デプロイ"]);
  expect(JSON.parse(writes[writes.length - 1]!.text)).toEqual({ terms: {}, known: ["ビルド"] });

  await $.command.run({ command: "terms", args: "unknow ビルド", ...RUN });
  expect(await terms(ui)).toEqual(["ビルド", "デプロイ"]);
});

test("ペインの「知ってる」ボタンでも消える", async ($, on) => {
  const writes: Array<{ path: string; text: string }> = [];
  setup(on, { writes });
  await start($);
  await answer($, "ビルドしてデプロイしました。");

  const ui = await mountPane($);
  await ui.press({ key: "know:ビルド" });
  expect(await terms(ui)).toEqual(["デプロイ"]);
  expect(JSON.parse(writes[writes.length - 1]!.text).known).toEqual(["ビルド"]);
});

test("/terms rm と list と file", async ($, on) => {
  const writes: Array<{ path: string; text: string }> = [];
  setup(on, { writes, userFile: JSON.stringify({ terms: { ペイン: "小窓" }, known: ["Git"] }) });
  await start($);

  expect((await $.command.run({ command: "terms", args: "list", ...RUN })).text).toBe(
    "📘 自分の辞書（1 語）\n  ペイン … 小窓\n🙆 知ってる（1 語）: Git",
  );
  expect(((await $.command.run({ command: "terms", args: "file", ...RUN })).text ?? "").startsWith(`📘 自分の辞書: ${USER_FILE}`)).toBe(true);
  expect((await $.command.run({ command: "terms", args: "rm ペイン", ...RUN })).text).toBe("📘 「ペイン」を自分の辞書から消しました");
  expect(JSON.parse(writes[0]!.text)).toEqual({ terms: {}, known: ["Git"] });
  expect((await $.command.run({ command: "terms", args: "rm ペイン", ...RUN })).text).toBe("「ペイン」は自分の辞書にありません（/terms list で確認）");
});

test("/terms だけならペインを開く。知らない指示なら使い方を出す", async ($, on) => {
  setup(on);
  await start($);
  expect((await $.command.run({ command: "terms", args: "", ...RUN })).text).toBe("📘 用語ペインを開きました（直近の返事から 0 語）。Esc で閉じます");
  expect(((await $.command.run({ command: "terms", args: "foo", ...RUN })).text ?? "").startsWith("「foo」は知らない指示です。")).toBe(true);
});

test("HOME が無くても落ちず、辞書はその場限りで使える", async ($, on) => {
  const writes: Array<{ path: string; text: string }> = [];
  setup(on, { writes, home: undefined });
  await start($);
  await answer($, "ペインを開いてください。");
  const { text } = await $.command.run({ command: "terms", args: "add ペイン 小窓", ...RUN });
  expect(text).toBe("📘 「ペイン」を自分の辞書に足しました（HOME が未設定なのでファイルには保存できませんでした）");
  expect(writes).toHaveLength(0);
  expect(await terms(await mountPane($))).toEqual(["ペイン"]);
});

test("ツールの出力（エラー文）に出た用語も拾う。返事の語が先、ツール出力の語が後。次のターンで忘れる", async ($, on) => {
  setup(on);
  on("session.cwd", () => ({ value: "/proj" }));
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Box } = $.ui.resolve(e);
    return <Box />;
  });
  on("tool.call", { tool: "Bash" }, (_$, e) => {
    const cmd = String((e as any).command ?? "");
    if (cmd === "npm test") {
      const err = "npm ERR! code ELIFECYCLE\nnpm ERR! Error: マイグレーション failed: prisma schema not found\n";
      return { isError: true, result: err, text: err } as any;
    }
    // 成功した出力でも、エラーらしい行だけは見る（ただの行は見ない）
    const out = "all green\nWarning: token expired\nビルド done";
    return { result: { stdout: out, stderr: "", interrupted: false } as any, text: out } as any;
  });
  await start($);
  await $.turn.start({ text: "テスト通して", turnId: "t1" });

  await $.tool.call({ tool: "Bash", command: "npm test" });
  let ui = await mountPane($);
  expect(await terms(ui)).toEqual(["npm", "マイグレーション", "ORM", "スキーマ"]);
  expect(await ui.find({ type: "Text", text: "　ツールの出力から" })).toBeDefined();
  await ui.unmount();

  await $.tool.call({ tool: "Bash", command: "npm run build" });
  ui = await mountPane($);
  // Warning の行から「トークン」は拾うが、普通の行の「ビルド」は拾わない
  expect(await terms(ui)).toEqual(["npm", "マイグレーション", "ORM", "スキーマ", "トークン"]);
  await ui.unmount();

  await answer($, "マイグレーションを直してデプロイしました。");
  ui = await mountPane($);
  expect(await terms(ui)).toEqual(["マイグレーション", "デプロイ", "npm", "ORM", "スキーマ", "トークン"]);
  await ui.unmount();

  await $.turn.start({ text: "次", turnId: "t2" });
  ui = await mountPane($);
  expect(await terms(ui)).toEqual(["マイグレーション", "デプロイ"]);
});
