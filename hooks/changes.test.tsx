// 変更履歴ペインのテスト。`claude plugin test .` で走る。
import { test, expect, mock } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
const PANE_PROPS = {
  title: "変更履歴",
  isFocused: true,
  bodyColumns: 64,
  placement: "dock",
  scroll: { top: 0 },
  view: {},
} as any;
const SAMPLE_FILE = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
const RUN = { origin: { kind: "composer" }, presentation: { isFullscreen: true, columns: 120 } } as const;

type SetupOptions = {
  summary?: string | "fail";
  store?: Record<string, unknown>;
  /** 指定すると mock.store の代わりに、書き込みをこの配列に記録する自前の store を使う */
  storeWrites?: unknown[];
  file?: string | null;
};

// テストの「底」: エンジンの代わりに答えるフック
function setup(on: On, opts: SetupOptions = {}) {
  if (opts.storeWrites) {
    const mem = new Map<string, unknown>(Object.entries(opts.store ?? {}));
    on("store.get", (_$, e) => ({ value: mem.get(e.key) }));
    on("store.set", (_$, e) => {
      mem.set(e.key, e.value);
      opts.storeWrites!.push(e.value);
      return { value: undefined };
    });
  } else {
    mock.store(on, opts.store ?? {});
  }
  const clock = mock.clock(on, { now: 1_800_000_000_000 });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.log", () => ({ value: undefined }));
  on("fs.read", () => {
    if (opts.file === null) return { deny: "ENOENT: no such file" };
    return { value: opts.file ?? SAMPLE_FILE };
  });
  on("tool.call", { tool: ["Edit", "Write"] }, (_$, e) => ({ result: { filePath: (e as any).file_path } as any }));
  on("model.complete", () => {
    if (opts.summary === "fail") {
      return { value: { isAnswered: false, reason: "api-error", status: 500, error: "server_error", usage: USAGE } };
    }
    return { value: { isAnswered: true, text: opts.summary ?? "数字をひとつ直しました。画面に出る値が変わります。", usage: USAGE } };
  });
  return clock;
}

// 変更の行（タブのボタンは除く）
const rowsOf = async (ui: { findAll: (q: any) => Promise<any[]> }) =>
  (await ui.findAll({ type: "Button" })).filter((b: any) => String(b.props?.key ?? b.key ?? "").startsWith("row:"));

// /changes で「変更」タブにしてから「たま」ペインを描く
const mountPane = async ($: Engine) => {
  await $.command.run({ command: "changes", args: "", ...RUN });
  return $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "Pane", requestId: "tama", props: PANE_PROPS });
};

test("Edit を記録して、時刻・ファイル名・要約・行数が出る（20 行以上の変更は要約つき）", async ($, on) => {
  const clock = setup(on);
  const big = "const b = 20;" + "\nconst x = 1;".repeat(20);
  await $.tool.call({ tool: "Edit", file_path: "/proj/src/api.ts", old_string: "const b = 2;", new_string: big });
  await clock.settle();

  const ui = await mountPane($);
  const rows = await rowsOf(ui);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.text).toMatch(/^▸ \d\d:\d\d  api\.ts  \+21行 −1行$/);
  expect(await ui.find({ type: "Text", text: "数字をひとつ直しました。画面に出る値が変わります。" })).toBeDefined();
  expect(await ui.find({ type: "Code" })).toBeUndefined();
});

test("要約が失敗しても、ファイル名と行数だけで止まらない。20 行未満の変更は最初から要約を頼まない", async ($, on) => {
  const clock = setup(on, { summary: "fail" });
  await $.tool.call({ tool: "Edit", file_path: "/proj/src/api.ts", old_string: "const b = 2;", new_string: "const b = 20;" });
  await clock.settle();

  const ui = await mountPane($);
  const rows = await rowsOf(ui);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.text).toMatch(/api\.ts  \+1行 −1行$/);
  // 要約の行は出ない（見出しと注意書きだけ）
  const texts = (await ui.findAll({ type: "Text" })).map((t) => t.text);
  expect(texts.filter((t) => !t.startsWith("📜") && !t.startsWith("押すと") && !t.startsWith("　"))).toHaveLength(0);
});

test("壊れると困る所（.env）には危ない操作の猫と注意書きが付く", async ($, on) => {
  const clock = setup(on, { file: null, summary: "設定を書きました。動き方が変わります。" });
  await $.tool.call({ tool: "Write", file_path: "/proj/.env", content: Array.from({ length: 20 }, (_, i) => `KEY${i}=1`).join("\n") + "\n" });
  await clock.settle();

  const ui = await mountPane($);
  const rows = await rowsOf(ui);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.text.startsWith("(=｀･q･´=)ﾉ ")).toBe(true);
  expect(rows[0]!.text).toMatch(/\.env  \+20行 −0行$/);
  const note = await ui.find({ type: "Text", text: /※壊れると困る所です。不安なら戻してと言ってください$/ });
  expect(note).toBeDefined();
  expect(note!.text.startsWith("設定を書きました。動き方が変わります。")).toBe(true);
});

test("ふつうのファイルには危ない操作の猫が付かない", async ($, on) => {
  const clock = setup(on, { file: null });
  await $.tool.call({ tool: "Write", file_path: "/proj/src/hello.ts", content: "console.log('hi');\n" });
  await clock.settle();

  const ui = await mountPane($);
  const rows = await rowsOf(ui);
  expect(rows[0]!.text.startsWith("▸")).toBe(true);
  expect(await ui.find({ type: "Text", text: /※壊れると困る所です/ })).toBeUndefined();
});

test("1件を選ぶと元の差分（Code 部品）が開き、もう一度で閉じる", async ($, on) => {
  const clock = setup(on);
  await $.tool.call({ tool: "Edit", file_path: "/proj/src/api.ts", old_string: "const b = 2;", new_string: "const b = 20;" });
  await clock.settle();

  const ui = await mountPane($);
  const row = (await rowsOf(ui))[0]!;
  await ui.press({ key: row.key! });

  const code = await ui.find({ type: "Code" });
  expect(code).toBeDefined();
  expect(code!.props.format).toBe("diff");
  expect(code!.props.source).toBe("@@ -1,3 +1,3 @@\n const a = 1;\n-const b = 2;\n+const b = 20;\n const c = 3;\n");
  expect((await rowsOf(ui))[0]!.text.startsWith("▾")).toBe(true);

  await ui.press({ key: row.key! });
  expect(await ui.find({ type: "Code" })).toBeUndefined();
});

test("新しい順に並び、50件を超えたら古いものから消える", async ($, on) => {
  const writes: any[] = [];
  const clock = setup(on, { file: null, storeWrites: writes });
  for (let i = 0; i < 55; i++) {
    await $.tool.call({ tool: "Write", file_path: `/proj/f${i}.ts`, content: `export const n = ${i};\n` });
  }
  await clock.settle();

  const ui = await mountPane($);
  const names = (await rowsOf(ui)).map((b: any) => b.text);
  expect(names).toHaveLength(50);
  expect(names[0]).toMatch(/ f54\.ts /);
  expect(names[49]).toMatch(/ f5\.ts /);
  expect(names.some((n) => / f4\.ts /.test(n))).toBe(false);

  // store にも同じものが書かれている（再起動対策）
  const saved = writes[writes.length - 1] as any[];
  expect(saved).toHaveLength(50);
  expect(saved[0].name).toBe("f54.ts");
});

test("再起動後は store から読み戻す", async ($, on) => {
  const entry = {
    id: "old-1",
    at: 1_800_000_000_000,
    tool: "Edit",
    file: "/proj/src/before.ts",
    name: "before.ts",
    added: 2,
    removed: 1,
    diff: "@@ -1,1 +1,2 @@\n-x\n+y\n+z\n",
    isTruncated: false,
    summary: "前のセッションの変更です。",
    isRisky: false,
  };
  setup(on, { store: { changes: [entry] } });
  await $.session.start({ cwd: "/proj", surface: "terminal", isInteractive: true });

  const ui = await mountPane($);
  const rows = await rowsOf(ui);
  expect(rows).toHaveLength(1);
  expect(rows[0]!.text).toMatch(/before\.ts  \+2行 −1行$/);
  expect(await ui.find({ type: "Text", text: "前のセッションの変更です。" })).toBeDefined();
});

test("/changes でペインを開く", async ($, on) => {
  setup(on);
  const { text } = await $.command.run({
    command: "changes",
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: true, columns: 120 },
  });
  expect(text).toBe("📜 変更タブを開きました（0件）。Esc で閉じます");
});

test("何もないときは案内だけ出る", async ($, on) => {
  setup(on);
  const ui = await mountPane($);
  expect(await ui.find({ type: "Text", text: "まだ変更はありません。" })).toBeDefined();
  expect(await rowsOf(ui)).toHaveLength(0);
});
