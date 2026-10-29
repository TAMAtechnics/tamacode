// 見張りのテスト（キー直書き・.env コミット・service_role 画面側・RLS なし・認証なし API ＋ 点検）。`claude plugin test .` で走る。
import { test, expect, mock } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";
import { blockSignature, evaluateBash, evaluateWrite, findSecrets, isPublicRepoCommand, isProdDestructive, tablesWithoutRls } from "../hooks/watch";

const BAND = { hasSurvey: false, isWorking: true, maxRows: 12, bodyColumns: 140 } as any;
const PANE_PROPS = { title: "たま", isFocused: true, bodyColumns: 64, placement: "dock", scroll: { top: 0 }, view: {} } as any;
const RUN = { origin: { kind: "composer" }, presentation: { isFullscreen: true, columns: 120 } } as const;
const T0 = new Date(2026, 9, 29, 15, 30, 12).getTime();

type Rec = { writes: Array<{ path: string; text: string }>; runs: string[][]; prompts: string[] };

function setup(on: On, opts: { files?: Record<string, string>; tree?: Record<string, Array<{ name: string; kind: "file" | "dir"; size: number }>>; gitLog?: string } = {}): Rec & { clock: ReturnType<typeof mock.clock> } {
  const rec: Rec = { writes: [], runs: [], prompts: [] };
  mock.store(on, {});
  const clock = mock.clock(on, { now: T0 });
  on("session.cwd", () => ({ value: "/proj" }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.log", () => ({ value: undefined }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("env.get", () => ({ value: "/home/tama" }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("prompt.submit", (_$, e) => {
    rec.prompts.push(e.text);
    return { text: e.text };
  });
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Box } = $.ui.resolve(e);
    return <Box />;
  });
  on("fs.read", (_$, e) => {
    const files = opts.files ?? {};
    if (e.path in files) return { value: files[e.path]! };
    return { deny: "ENOENT" };
  });
  on("fs.write", (_$, e) => {
    rec.writes.push({ path: e.path, text: e.text });
    return { value: undefined };
  });
  on("fs.exists", () => ({ value: false }));
  on("fs.list", (_$, e) => ({ value: (opts.tree ?? {})[String(e.path ?? "")] ?? [] }));
  on("process.run", (_$, e) => {
    rec.runs.push([...e.argv]);
    const s = e.argv.join(" ");
    if (s.startsWith("git log")) return { value: { exitCode: 0, stdout: opts.gitLog ?? "", stderr: "", isStdoutTruncated: false } };
    if (s === "git stash create") return { value: { exitCode: 0, stdout: "snap1\n", stderr: "", isStdoutTruncated: false } };
    return { value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false } };
  });
  on("tool.call", { tool: ["Edit", "Write"] }, (_$, e) => ({ result: { filePath: (e as any).file_path } as any }));
  on("tool.call", { tool: "Bash" }, () => ({ result: { stdout: "ok", stderr: "", interrupted: false } as any }));
  return { ...rec, clock };
}

const bandText = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "AbovePrompt", props: BAND });
  const texts = (await ui.findAll({ type: "Text" })).map((t) => t.text);
  await ui.unmount();
  return texts;
};

test("1. キーの直書き: 止めて、帯に理由と代案とボタンが出る。控えは取らない", async ($, on) => {
  const rec = setup(on);
  await $.turn.start({ text: "直して", turnId: "t1" });
  const r = await $.tool.call({ tool: "Edit", file_path: "/proj/src/lib/openai.ts", old_string: "const key = ''", new_string: 'const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789"' });
  expect(typeof (r as any).deny).toBe("string");
  expect(String((r as any).deny).includes("秘密の鍵")).toBe(true);
  expect(rec.writes).toEqual([]); // 止めたのでバックアップ無し

  const lines = await bandText($);
  expect(lines.some((l) => l.includes("止めました") && l.includes("秘密の鍵（API キー＝外部サービスの合鍵）がコードに入りそうです"))).toBe(true);
  expect(lines.some((l) => l.includes(".env（鍵を入れておく隠しファイル）に入れて process.env で読む形にします？"))).toBe(true);
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "AbovePrompt", props: BAND });
  const keys = (await ui.findAll({ type: "Button" })).map((b: any) => String(b.props?.key ?? ""));
  expect(keys).toEqual(expect.arrayContaining(["watch:fix", "watch:allow", "watch:cancel"]));

  // 「はい」= 直す。作業中なので、返事が終わってから送られる
  await ui.press({ key: "watch:fix" });
  await ui.unmount();
  expect(rec.prompts).toEqual([]);
  await $.turn.complete({ answer: "止められました。", reason: "answer", durationMs: 1000, isAborted: false, turnId: "t1" } as any);
  await rec.clock.advance(0);
  expect(rec.prompts.length).toBe(1);
  expect(rec.prompts[0]!.includes("src/lib/openai.ts に直書きされている秘密の鍵を .env に移して")).toBe(true);
});

test("1'. 「このまま通す」を押すと、同じ操作は 1 回だけ通る", async ($, on) => {
  const rec = setup(on);
  await $.turn.start({ text: "直して", turnId: "t1" });
  const call = () => $.tool.call({ tool: "Write", file_path: "/proj/src/config.ts", content: 'export const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";\n' });
  expect(typeof ((await call()) as any).deny).toBe("string");
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "AbovePrompt", props: BAND });
  await ui.press({ key: "watch:allow" });
  await ui.unmount();
  const r2 = await call();
  expect((r2 as any).deny).toBeUndefined();
  expect((r2 as any).result.filePath).toBe("/proj/src/config.ts");
  // 2 回目はまた止まる
  expect(typeof ((await call()) as any).deny).toBe("string");
  void rec;
});

test("1''. 止めた操作の印は「規則に当たった区切り」だけ。cd や確認コマンドを前後に足しても同じ操作として通る", async ($, on) => {
  // 純粋な部分: 前後が違っても同じ印、危険な部分が違えば別の印
  const a = 'cd "/Users/x/長い長いフォルダ名のプロジェクト" && gh auth status && gh repo create tamacode --public --source=. --push';
  const b = 'cd "/Users/x/長い長いフォルダ名のプロジェクト" && gh repo create tamacode   --public --source=. --push';
  const c = 'cd "/Users/x/長い長いフォルダ名のプロジェクト" && gh repo create other --public';
  expect(blockSignature("public-repo", a, isPublicRepoCommand)).toBe("public-repo:gh repo create tamacode --public --source=. --push");
  expect(blockSignature("public-repo", b, isPublicRepoCommand)).toBe(blockSignature("public-repo", a, isPublicRepoCommand));
  expect(blockSignature("public-repo", c, isPublicRepoCommand)).not.toBe(blockSignature("public-repo", a, isPublicRepoCommand));
  expect(evaluateBash(a)[0]!.sig).toBe(evaluateBash(b)[0]!.sig);

  // 帯で「このまま通す」→ 前に付いていた確認コマンドを外して再実行しても通る
  const rec = setup(on);
  await $.turn.start({ text: "公開して", turnId: "t1" });
  expect(typeof ((await $.tool.call({ tool: "Bash", command: a })) as any).deny).toBe("string");
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "AbovePrompt", props: BAND });
  await ui.press({ key: "watch:allow" });
  await ui.unmount();
  expect(((await $.tool.call({ tool: "Bash", command: b })) as any).deny).toBeUndefined();
  // 1 回通したあとはまた止まる
  expect(typeof ((await $.tool.call({ tool: "Bash", command: b })) as any).deny).toBe("string");
  void rec;
});

test("2. .env を git add / commit すると止める。.env.example は通す", async ($, on) => {
  setup(on);
  await $.turn.start({ text: "保存して", turnId: "t1" });
  const r = await $.tool.call({ tool: "Bash", command: "git add .env src/index.ts && git commit -m 'save'" });
  expect(String((r as any).deny).includes("秘密のファイル（.env）が一緒に入ります")).toBe(true);
  const ok = await $.tool.call({ tool: "Bash", command: "git add .env.example" });
  expect((ok as any).deny).toBeUndefined();
  expect(evaluateBash("git push origin main").length).toBe(0);
});

test("3. service_role を画面側（app/）に書くと止める。サーバー側なら通す", async ($, on) => {
  setup(on);
  await $.turn.start({ text: "作って", turnId: "t1" });
  const r = await $.tool.call({ tool: "Write", file_path: "/proj/app/page.tsx", content: "const supabase = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY)" });
  expect(String((r as any).deny).includes("管理者用の強い鍵")).toBe(true);
  const ok = await $.tool.call({ tool: "Write", file_path: "/proj/lib/server/admin.ts", content: "const supabase = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY)" });
  expect((ok as any).deny).toBeUndefined();
});

test("4. RLS の無い create table は通すが、帯に赤で警告し、控えを取る。同じ箇所は 1 回だけ", async ($, on) => {
  const rec = setup(on);
  await $.turn.start({ text: "テーブル作って", turnId: "t1" });
  const sql = "create table public.orders (id uuid primary key, user_id uuid);\ncreate table profiles (id uuid primary key);\nalter table profiles enable row level security;\n";
  const r = await $.tool.call({ tool: "Write", file_path: "/proj/supabase/migrations/0002_orders.sql", content: sql });
  expect((r as any).deny).toBeUndefined();
  const lines = await bandText($);
  expect(lines.some((l) => l.includes("テーブル orders は誰でも全部見える状態です（RLS＝自分の分しか見えない決まり が無い）"))).toBe(true);
  expect(lines.some((l) => l.includes("profiles"))).toBe(false);
  // 控え（migrations は【7】の規則でも対象なので、理由はどちらでもよい）
  expect(rec.writes.some((w) => w.path.includes("/.tama-backup/") && w.path.endsWith("memo.txt"))).toBe(true);
  // 警告だけの箇所（API の入口）でも控えを取る
  rec.writes.length = 0;
  await $.tool.call({ tool: "Write", file_path: "/proj/app/api/x/route.ts", content: "export async function GET() { return Response.json([]); }" });
  expect(rec.writes.some((w) => w.path.endsWith("memo.txt") && w.text.includes("見張りが警告した書き換え"))).toBe(true);
  expect(tablesWithoutRls(sql)).toEqual(["orders"]);

  // 同じ箇所は次のターンで出ない
  await $.turn.start({ text: "もう一度", turnId: "t2" });
  await $.tool.call({ tool: "Write", file_path: "/proj/supabase/migrations/0002_orders.sql", content: sql });
  expect((await bandText($)).some((l) => l.includes("orders"))).toBe(false);
});

test("5. 本人確認の無い API 入口は警告。auth があれば出ない。tests/ は対象外", async ($, on) => {
  setup(on);
  await $.turn.start({ text: "API 作って", turnId: "t1" });
  await $.tool.call({ tool: "Write", file_path: "/proj/app/api/users/route.ts", content: "export async function GET() { return Response.json(await db.users.findMany()); }" });
  expect((await bandText($)).some((l) => l.includes("この入口（API）は本人確認なしで誰でも叩けます"))).toBe(true);

  await $.turn.start({ text: "直した", turnId: "t2" });
  await $.tool.call({ tool: "Write", file_path: "/proj/app/api/items/route.ts", content: "export async function GET() { const { data } = await supabase.auth.getUser(); if (!data.user) return new Response('', { status: 401 }); }" });
  await $.tool.call({ tool: "Write", file_path: "/proj/tests/api/route.test.ts", content: "export async function GET() { return Response.json([]); }" });
  expect((await bandText($)).some((l) => l.includes("本人確認なし"))).toBe(false);
});

test("判定の小道具: 公開リポジトリ・本番への破壊操作・鍵の見分け", () => {
  expect(isPublicRepoCommand("gh repo create my-app --public --source=.")).toBe(true);
  expect(isPublicRepoCommand("gh repo create my-app --private")).toBe(false);
  expect(isProdDestructive("supabase db reset --linked --project-ref prod")).toBe(true);
  expect(isProdDestructive("rm -rf .env.production")).toBe(true);
  expect(isProdDestructive("rm -rf dist")).toBe(false);
  expect(findSecrets('const k = process.env.OPENAI_API_KEY ?? "sk-aaaaaaaaaaaaaaaaaaaaaaaa"').length).toBe(0); // process.env の行は除く
  expect(findSecrets('const k = "AKIAABCDEFGHIJKLMNOP"').length).toBe(1);
  expect(findSecrets("const hash = 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8'").length).toBe(1);
  expect(findSecrets("const word = 'hello world'").length).toBe(0);
  expect(evaluateWrite("/proj/.env", ["OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz0123456789"], "/proj").length).toBe(0); // .env 自体に書くのは正しい
  expect(evaluateWrite("/proj/docs/notes.md", ["sk-abcdefghijklmnopqrstuvwxyz0123456789"], "/proj").length).toBe(0); // docs/ は対象外
});

test("点検: 全体を見て赤・黄・緑に分け、冒頭に今週の回数。「大丈夫」で消える。緑だけなら完了の猫", async ($, on) => {
  const rec = setup(on, {
    tree: {
      "/proj": [
        { name: "app", kind: "dir", size: 0 },
        { name: "node_modules", kind: "dir", size: 0 },
        { name: ".gitignore", kind: "file", size: 10 },
        { name: "README.md", kind: "file", size: 10 },
      ],
      "/proj/app": [{ name: "page.tsx", kind: "file", size: 100 }],
    },
    files: {
      "/proj/app/page.tsx": 'const key = "sk-abcdefghijklmnopqrstuvwxyz0123456789"; console.log(user.email);',
      "/proj/README.md": "# hi",
      "/proj/.gitignore": "node_modules/\n",
    },
  });
  await $.turn.start({ text: "点検", turnId: "t0" });
  await $.tool.call({ tool: "Write", file_path: "/proj/src/x.ts", content: 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123456789"' }); // 止める → 今週 1 件
  await $.turn.complete({ answer: "x", reason: "answer", durationMs: 1, isAborted: false, turnId: "t0" } as any);

  expect((await $.command.run({ command: "tenken", args: "", ...RUN })).text).toBe("点検を始めました。結果は「点検」タブに出ます");
  await rec.clock.advance(0);
  let ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "Pane", requestId: "tama", props: PANE_PROPS });
  let texts = (await ui.findAll({ type: "Text" })).map((t) => t.text);
  expect(texts).toContain("今週止めた事故：1件　警告：0件");
  expect(texts.some((t) => t.includes("app/page.tsx の 1 行目に秘密の鍵らしい文字列があります"))).toBe(true);
  expect(texts.some((t) => t.includes("ログに個人情報（email）が出ます"))).toBe(true);
  expect(texts.some((t) => t.includes(".gitignore に .env が入っていません"))).toBe(true);
  expect(texts.some((t) => t.includes("git の履歴に秘密の鍵は見当たりません"))).toBe(true);
  expect(rec.runs.some((a) => a.join(" ").startsWith("git log -p --all"))).toBe(true);

  // 「直して」で修正の依頼が送られる（作業中でないので即送信）
  const fixKey = (await ui.findAll({ type: "Button" })).map((b: any) => String(b.props?.key ?? "")).find((k) => k.startsWith("tenken:fix:secret:"));
  expect(fixKey).toBeDefined();
  await ui.press({ key: fixKey! });
  expect(rec.prompts.length).toBe(1);
  expect(rec.prompts[0]!.includes("app/page.tsx に直書きされている秘密の鍵を .env に移して")).toBe(true);

  // 「大丈夫」で消える
  const okKeys = (await ui.findAll({ type: "Button" })).map((b: any) => String(b.props?.key ?? "")).filter((k) => k.startsWith("tenken:ok:"));
  for (const k of okKeys) await ui.press({ key: k });
  texts = (await ui.findAll({ type: "Text" })).map((t) => t.text);
  expect(texts.some((t) => t.includes("素人がやりがちな事故は見当たりません"))).toBe(true);
  await ui.unmount();
});
