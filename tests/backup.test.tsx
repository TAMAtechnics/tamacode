// 【7】危険操作の前の自動バックアップのテスト。`claude plugin test .` で走る。
import { test, expect, mock } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";
import { backupRelPath, dangerOfBash, dangerOfFile, parseStamp, stamp } from "../hooks/safety";

const BAND = { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: 120 } as any;
const T0 = new Date(2026, 9, 29, 15, 30, 12).getTime();
const ENV_FILE = "KEY=1\n";

type Rec = {
  writes: Array<{ path: string; text: string }>;
  runs: string[][];
};

function setup(on: On, opts: { gitignore?: string | null; files?: Record<string, string>; oldDirs?: string[]; gitExit?: number } = {}): Rec & { clock: ReturnType<typeof mock.clock> } {
  const rec: Rec = { writes: [], runs: [] };
  mock.store(on, {});
  const clock = mock.clock(on, { now: T0 });
  on("session.cwd", () => ({ value: "/proj" }));
  on("ui.log", () => ({ value: undefined }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("env.get", () => ({ value: "/home/tama" }));
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Box } = $.ui.resolve(e);
    return <Box />;
  });
  on("fs.read", (_$, e) => {
    if (e.path === "/proj/.gitignore") {
      if (opts.gitignore === null || opts.gitignore === undefined) return { deny: "ENOENT" };
      return { value: opts.gitignore };
    }
    const files = { "/proj/.env": ENV_FILE, "/proj/src/hello.ts": "console.log('hi');\n", ...(opts.files ?? {}) };
    if (e.path in files) return { value: files[e.path as keyof typeof files] };
    return { deny: "ENOENT" };
  });
  on("fs.write", (_$, e) => {
    rec.writes.push({ path: e.path, text: e.text });
    return { value: undefined };
  });
  on("fs.exists", () => ({ value: (opts.oldDirs ?? []).length > 0 }));
  on("fs.list", () => ({ value: (opts.oldDirs ?? []).map((name) => ({ name, kind: "dir", size: 0 })) }));
  on("process.run", (_$, e) => {
    rec.runs.push([...e.argv]);
    const isCreate = e.argv[0] === "git" && e.argv[1] === "stash" && e.argv[2] === "create";
    return { value: { exitCode: opts.gitExit ?? 0, stdout: isCreate ? "abc1234\n" : "", stderr: "", isStdoutTruncated: false } };
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

test(".env を書き換える前に控えを取り、.gitignore に足し、帯に知らせる。道具自体は通る", async ($, on) => {
  const rec = setup(on);
  await $.turn.start({ text: "設定を直して", turnId: "t1" });
  const r = await $.tool.call({ tool: "Edit", file_path: "/proj/.env", old_string: "KEY=1", new_string: "KEY=2" });
  expect((r as any).result.filePath).toBe("/proj/.env");

  const copy = rec.writes.find((w) => /^\/proj\/\.tama-backup\/2026-10-29_153012\/\.env$/.test(w.path));
  expect(copy?.text).toBe(ENV_FILE);
  const memo = rec.writes.find((w) => w.path === "/proj/.tama-backup/2026-10-29_153012/memo.txt");
  expect(memo?.text.includes("理由: 壊れると困るファイル")).toBe(true);
  const ignore = rec.writes.find((w) => w.path === "/proj/.gitignore");
  expect(ignore?.text.includes(".tama-backup/")).toBe(true);
  // 控えのフォルダは mkdir -p で作る
  expect(rec.runs.some((a) => a[0] === "mkdir" && a[1] === "-p" && a[2] === "/proj/.tama-backup/2026-10-29_153012")).toBe(true);

  const lines = await bandText($);
  expect(lines.some((l) => l.includes("(=｀･q･´=)ﾉ 大事な所を触ります。念のため控えを取りました（.tama-backup/2026-10-29_153012）"))).toBe(true);
});

test("ふつうのファイルのふつうの書き換えでは何もしない", async ($, on) => {
  const rec = setup(on, { gitignore: "node_modules/\n" });
  await $.turn.start({ text: "直して", turnId: "t1" });
  await $.tool.call({ tool: "Edit", file_path: "/proj/src/hello.ts", old_string: "hi", new_string: "hello" });
  expect(rec.writes).toEqual([]);
  expect(rec.runs).toEqual([]);
});

test("ふつうのファイルでも『削除』や認証に触る書き換えなら控えを取る", async ($, on) => {
  const rec = setup(on, { gitignore: "node_modules/\n.tama-backup/\n" });
  await $.turn.start({ text: "直して", turnId: "t1" });
  await $.tool.call({ tool: "Edit", file_path: "/proj/src/hello.ts", old_string: "hi", new_string: "await db.user.delete({ where: { id } })" });
  expect(rec.writes.some((w) => w.path === "/proj/.tama-backup/2026-10-29_153012/src/hello.ts")).toBe(true);
  // .gitignore に既にあれば書き足さない
  expect(rec.writes.some((w) => w.path === "/proj/.gitignore")).toBe(false);
});

test("危ない Bash（rm）の前は git stash でスナップショットを取る", async ($, on) => {
  const rec = setup(on, { gitignore: ".tama-backup/\n" });
  await $.turn.start({ text: "消して", turnId: "t1" });
  await $.tool.call({ tool: "Bash", command: "rm -rf dist" });
  expect(rec.runs.some((a) => a.join(" ") === "git stash create")).toBe(true);
  const store = rec.runs.find((a) => a[0] === "git" && a[1] === "stash" && a[2] === "store");
  expect(store?.[store.length - 1]).toBe("abc1234");
  expect(rec.writes.some((w) => w.path === "/proj/.tama-backup/2026-10-29_153012/git-stash.txt" && w.text.startsWith("abc1234"))).toBe(true);
  expect((await bandText($)).some((l) => l.includes("今の状態を git に控えました"))).toBe(true);
});

test("git の管理外なら、その旨を帯に出して道具は通す", async ($, on) => {
  setup(on, { gitignore: ".tama-backup/\n", gitExit: 128 });
  await $.turn.start({ text: "消して", turnId: "t1" });
  const r = await $.tool.call({ tool: "Bash", command: "git push --force origin main" });
  expect((r as any).result.stdout).toBe("ok");
  expect((await bandText($)).some((l) => l.includes("git の管理外なので取れませんでした"))).toBe(true);
});

test("7 日より古い控えは最初の道具のときに消す。新しい物は残す", async ($, on) => {
  const rec = setup(on, { gitignore: ".tama-backup/\n", oldDirs: ["2026-10-20_090000", "2026-10-28_090000", "memo.txt"] });
  await $.turn.start({ text: "直して", turnId: "t1" });
  await $.tool.call({ tool: "Write", file_path: "/proj/.env", content: "KEY=3\n" });
  const removed = rec.runs.filter((a) => a[0] === "rm").map((a) => a[2]);
  expect(removed).toEqual(["/proj/.tama-backup/2026-10-20_090000"]);
});

test("判定の小道具", () => {
  expect(dangerOfBash("rm -rf node_modules")).toBe("backup.reason.bash");
  expect(dangerOfBash("git push --force origin main")).toBe("backup.reason.bash");
  expect(dangerOfBash("npx prisma migrate dev")).toBe("backup.reason.bash");
  expect(dangerOfBash("npm test")).toBeNull();
  expect(dangerOfBash("cat README.md")).toBeNull();
  expect(dangerOfFile("/proj/.env.local", [])).toBe("backup.reason.path");
  expect(dangerOfFile("/proj/prisma/migrations/0001_init/migration.sql", [])).toBe("backup.reason.path");
  expect(dangerOfFile("/proj/src/auth.ts", ["x"])).toBe("backup.reason.text");
  expect(dangerOfFile("/proj/src/hello.ts", ["const a = 1;"])).toBeNull();
  expect(stamp(T0)).toBe("2026-10-29_153012");
  expect(parseStamp("2026-10-29_153012")).toBe(T0);
  expect(parseStamp("memo.txt")).toBeNull();
  expect(backupRelPath("/proj/src/a.ts", "/proj")).toBe("src/a.ts");
  expect(backupRelPath("/etc/hosts", "/proj")).toBe("_outside/etc/hosts");
});
