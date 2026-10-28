// スピナーの実況（live.ts）のテスト: 対象の取り方・Bash の動詞・目的の拾い方・幅に合わせた削り方。`claude plugin test .` で走る。
import { test, expect } from "claude-code/testing";
import { bashLabelFromDescription, bashVerb, cells, composeLive, editNote, fmtElapsed, liveForPrep, liveForTool, liveForWriting, purposeFrom, tail2 } from "./live";

const CAT = "(=^･q･^=)";

test("対象: ファイルはパスの末尾 2 階層", () => {
  expect(tail2("/Users/tara/proj/hooks/activity.tsx")).toBe("hooks/activity.tsx");
  expect(tail2("README.md")).toBe("README.md");
  expect(tail2("")).toBe("ファイル");
});

test("Bash: 先頭の動詞と対象を日本語に（cd は飛ばす）", () => {
  expect(bashVerb("cd /proj && cat hooks/activity.tsx")).toBe("hooks/activity.tsx の中身を見る");
  expect(bashVerb("sed -n 100,120p hooks/vibe.ts")).toBe("hooks/vibe.ts の中身を見る");
  expect(bashVerb("grep -rn NOTICE_REF hooks")).toBe("「NOTICE_REF」を探す");
  expect(bashVerb("npm run build")).toBe("ビルドする");
  expect(bashVerb("bun test")).toBe("テストする");
  expect(bashVerb("claude plugin test .")).toBe("テストする");
  expect(bashVerb("git add -A && git commit -m x")).toBe("git にセーブする");
  expect(bashVerb("git status")).toBe("git の状態を見る");
  expect(bashVerb("which figlet")).toBe("figlet が入ってるか確認する");
  expect(bashVerb("node scripts/build-locale.mjs")).toBe("scripts/build-locale.mjs を動かす");
  expect(bashVerb("")).toBe("コマンドを実行する");
});

test("Bash: description があればそれを「○○する」に整えて使う", () => {
  expect(bashLabelFromDescription("figlet とお知らせの描画幅を確認")).toBe("figlet とお知らせの描画幅を確認する");
  expect(bashLabelFromDescription("起動ロゴの場所を探す")).toBe("起動ロゴの場所を探す");
  expect(bashLabelFromDescription("テストを実行します")).toBe("テストを実行する");
  expect(bashLabelFromDescription("検証とテストを実行")).toBe("検証とテストを実行する");
  expect(bashLabelFromDescription("  ")).toBeNull();
  const live = liveForTool("Bash", { command: "which figlet", description: "figlet が入ってるか確認" }, null);
  expect(live.mid).toBe("figlet が入ってるか確認するコマンドを実行中");
  expect(live.brief).toBe("コマンドを実行中");
});

test("目的: 直前の発言の最後の文の最後の句を 1 フレーズ。質問・空は null", () => {
  expect(purposeFrom("起動ロゴのコードを探して、表示を「TAMAコード」に変えます。\n")).toBe("表示を「TAMAコード」に変えます");
  expect(purposeFrom("**ロゴ**の描画位置を探して")).toBe("ロゴの描画位置を探してます");
  expect(purposeFrom("まず `hooks/vibe.ts` を読んで。\n```\ncode\n```\n")).toBe("まず hooks/vibe.ts を読んでます");
  expect(purposeFrom("どちらにしますか？")).toBeNull();
  expect(purposeFrom("")).toBeNull();
  expect(purposeFrom("はい。")).toBeNull();
});

test("道具ごとの実況: 読む・探す・書く（行数つき）・ネット・MCP。英語の道具名は出ない", () => {
  const read = liveForTool("Read", { file_path: "/proj/hooks/activity.tsx" }, "ロゴの描画位置を探してます");
  expect(read.long).toBe("hooks/activity.tsx を読んで、ロゴの描画位置を探してます");
  expect(read.mid).toBe("hooks/activity.tsx を読んでます");
  expect(read.brief).toBe("ファイルを読んでます");
  expect(liveForTool("Grep", { pattern: "NOTICE_REF" }, null).mid).toBe("「NOTICE_REF」という言葉をプロジェクト内から探してます");
  expect(liveForTool("Grep", { pattern: "NOTICE_REF", path: "/proj/hooks" }, null).mid).toBe("「NOTICE_REF」という言葉をproj/hooksから探してます");
  const edit = liveForTool("Edit", { file_path: "/proj/hooks/activity.tsx", old_string: "a\nb", new_string: "a\nb\nc\nd" }, null);
  expect(edit.mid).toBe("hooks/activity.tsx を書き換えてます");
  expect(edit.note).toBe("+2行");
  expect(edit.long).toBeNull();
  expect(editNote("Edit", { old_string: "a\nb\nc", new_string: "a" })).toBe("−2行");
  expect(editNote("Write", { content: "x\ny\nz" })).toBe("3行");
  expect(liveForTool("WebSearch", { query: "figlet font" }, null).mid).toBe("「figlet font」をネットで検索してます");
  expect(liveForTool("mcp__claude-in-chrome__navigate", { url: "x" }, null).mid).toBe("claude-in-chrome に「navigate」を頼んでます");
  expect(JSON.stringify(liveForTool("Bash", { command: "ls" }, null))).not.toMatch(/Bash/);
});

test("書き出し中の実況: 考えてる（まだ触ってない）・返事を書いてる（文字数）・道具の指示を書いてる", () => {
  expect(liveForWriting("thinking", { touched: false, chars: 0 }).mid).toBe("次の手を考えてます。まだ何も触ってません");
  expect(liveForWriting("thinking", { touched: true, chars: 0 }).mid).toBe("次の手を考えてます");
  expect(liveForWriting("text", { touched: true, chars: 1800 }).note).toBe("↓1.8k文字");
  expect(liveForWriting("text", { touched: true, chars: 820 }).note).toBe("↓820文字");
  expect(liveForPrep("Edit", { file: "/proj/hooks/activity.tsx" }).mid).toBe("hooks/activity.tsx を書き換える手順を書いてます");
  expect(liveForPrep("Bash", { command: "npm run build" }).mid).toBe("コマンドを組み立ててます: npm run build");
  expect(liveForPrep("", {}).mid).toBe("次の作業を準備してます");
});

test("1 行に組む: 幅に収まらなければ 目的 → 対象 の順に削る。猫・動作・時間は残る", () => {
  const live = liveForTool("Read", { file_path: "/proj/hooks/activity.tsx" }, "ロゴの描画位置を探してます");
  expect(composeLive(CAT, live, 12_000, 200)).toBe(`${CAT} hooks/activity.tsx を読んで、ロゴの描画位置を探してます（12s）`);
  expect(composeLive(CAT, live, 12_000, 110)).toBe(`${CAT} hooks/activity.tsx を読んでます（12s）`);
  expect(composeLive(CAT, live, 12_000, 70)).toBe(`${CAT} ファイルを読んでます（12s）`);
  expect(composeLive(CAT, live, 12_000, 10)).toBe(`${CAT} ファイルを読んでます（12s）`); // それでも入らなければ短い版をそのまま
  expect(composeLive(CAT, live, null, 0).endsWith("探してます")).toBe(true); // 時間が無ければ付けない
  const edit = liveForTool("Edit", { file_path: "/proj/hooks/activity.tsx", old_string: "", new_string: "a\nb" }, null);
  expect(composeLive("ฅ(=^･q･^=)ฅ", edit, 40_000, 200)).toBe("ฅ(=^･q･^=)ฅ hooks/activity.tsx を書き換えてます（+2行）（40s）");
  expect(fmtElapsed(65_000)).toBe("1m05s");
  expect(fmtElapsed(3_720_000)).toBe("1h02m");
  expect(cells("あa")).toBe(3);
});
