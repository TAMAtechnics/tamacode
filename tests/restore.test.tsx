// 【6】戻すのプレビュー のテスト。`claude plugin test .` で走る。
import { test, expect } from "claude-code/testing";
import { parseGitLog } from "../hooks/panel";
import { fresh, RUN, bandText, mountPanel, setupPanel, texts } from "./_panel-setup";

const GIT = (argv: readonly string[]) => {
  const s = argv.join(" ");
  if (s.startsWith("git log")) return { stdout: "abc1234 ログインを直した\ndef5678 最初のコミット\n" };
  if (s.startsWith("git diff --name-status")) return { stdout: "M\tsrc/a.ts\nD\tsrc/b.ts\n" };
  if (s.startsWith("git diff --stat")) return { stdout: " src/a.ts | 2 +-\n src/b.ts | 10 ----------\n" };
  if (s === "git stash create") return { stdout: "snap111\n" };
  return { stdout: "" };
};

const BACKUP = {
  stamp: "2026-10-28_101010",
  dir: "/proj/.tama-backup/2026-10-28_101010",
  kind: "files",
  files: [".env"],
  stashSha: null,
  reason: "壊れると困るファイル",
  tool: "Edit",
  target: ".env",
  at: 1,
};

test("git の履歴 10 件と控えが候補に並ぶ", async ($, on) => {
  await fresh($, on, { run: GIT, store: { backups: [BACKUP] } });
  expect((await $.command.run({ command: "modosu", args: "", ...RUN })).text.startsWith("「戻す」タブを開きました")).toBe(true);
  const ui = await mountPanel($);
  const picks = (await ui.findAll({ type: "Button" })).filter((b: any) => String(b.props?.key ?? b.key ?? "").startsWith("modosu:pick:"));
  const labels = picks.map((b: any) => String(b.props.label));
  expect(labels).toEqual(["[ ] abc1234 ログインを直した", "[ ] def5678 最初のコミット", "[ ] 控え 2026-10-28 101010（.env）"]);
  expect(parseGitLog("abc1234 x\n\nzzz\n")).toEqual([{ sha: "abc1234", message: "x" }]);
});

test("選ぶと「ここに戻すと消えるもの」が 3 行出て、「戻す」を押したときだけ実行される。実行前に控えを取る", async ($, on) => {
  const rec = await fresh($, on, { run: GIT, model: "src/a.ts の今日の直しが元に戻ります\nsrc/b.ts が復活します\n今日の作業の一部が消えます" });
  await $.command.run({ command: "modosu", args: "", ...RUN });
  const ui = await mountPanel($);
  await ui.press({ key: "modosu:pick:abc1234" });

  const lines = await texts(ui);
  expect(lines.some((t) => t.includes("ここに戻すと消えるもの（abc1234 ログインを直した）"))).toBe(true);
  expect(lines.some((t) => t.includes("src/b.ts が復活します"))).toBe(true);
  expect(rec.runs.some((a) => a.join(" ") === "git diff --name-status abc1234")).toBe(true);
  // まだ戻していない
  expect(rec.runs.some((a) => a[0] === "git" && a[1] === "restore")).toBe(false);

  await ui.press({ key: "modosu:run" });
  const i = rec.runs.findIndex((a) => a.join(" ") === "git stash create");
  const j = rec.runs.findIndex((a) => a.join(" ") === "git restore --source=abc1234 --staged --worktree -- .");
  expect(i).toBeGreaterThanOrEqual(0);
  expect(j).toBeGreaterThan(i);
  expect((await bandText($)).some((t) => t.includes("戻しました（abc1234 ログインを直した）"))).toBe(true);
});

test("モデルが失敗しても、変わるファイル名で 3 行を出す。「やめる」で選択が消える", async ($, on) => {
  const rec = await fresh($, on, { run: GIT, model: "fail" });
  await $.command.run({ command: "modosu", args: "", ...RUN });
  const ui = await mountPanel($);
  await ui.press({ key: "modosu:pick:abc1234" });
  expect((await texts(ui)).some((t) => t.includes("変わるファイル: src/a.ts、src/b.ts（全部で 2 件）"))).toBe(true);
  await ui.press({ key: "modosu:cancel" });
  expect({ heading: (await texts(ui)).filter((t) => t.includes("ここに戻すと消えるもの（")), restored: rec.runs.filter((a) => a[0] === "git" && a[1] === "restore") }).toEqual({ heading: [], restored: [] });
});

test("控え（ファイルのコピー）に戻すと、控えの中身を元の場所に書き戻す", async ($, on) => {
  const rec = await fresh($, on, { run: GIT, store: { backups: [BACKUP] }, files: { "/proj/.tama-backup/2026-10-28_101010/.env": "KEY=old\n" } });
  await $.command.run({ command: "modosu", args: "", ...RUN });
  const ui = await mountPanel($);
  await ui.press({ key: "modosu:pick:2026-10-28_101010" });
  await ui.press({ key: "modosu:run" });
  expect(rec.writes).toEqual([{ path: "/proj/.env", text: "KEY=old\n" }]);
});
