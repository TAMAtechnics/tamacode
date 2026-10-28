// 【8】おわり と「確認して」のテスト。`claude plugin test .` で走る。
import { test, expect } from "claude-code/testing";
import { fresh, RUN, answer, bandText, setupPanel } from "./_panel-setup";

test("/owari で作業日誌の頼みが送られ、返事が終わると帯が「今日はここまで」になる（作業中でなくても出る）", async ($, on) => {
  const rec = await fresh($, on);
  expect((await $.command.run({ command: "owari", args: "", ...RUN })).text).toBe("「おわり」を送りました。作業日誌とコミットが終わると帯に知らせます");
  await rec.clock.advance(0); // コマンドからの送信は次の瞬間に行われる
  expect(rec.prompts).toEqual([
    "今日の作業を『やったこと／途中のもの／次回の最初の一手』で docs/作業日誌.md に日付付きで追記して、日本語メッセージでコミットして、次回用の依頼文の下書きを1つ作って docs/次回.md に置いて。",
  ]);

  await $.turn.start({ text: rec.prompts[0]!, turnId: "t1" });
  expect(await bandText($)).toEqual([]);
  await answer($, "作業日誌に追記してコミットしました。次回の下書きは docs/次回.md にあります。");
  expect(await bandText($)).toEqual(["(=^‥q‥^=)ﾉ 今日はここまで。次回は docs/次回.md から"]);

  // 次に話しかけると消える
  await $.turn.start({ text: "次", turnId: "t2" });
  expect(await bandText($)).toEqual([]);
});

test("/kakunin でビルドとテストの頼みが送られる", async ($, on) => {
  const rec = await fresh($, on);
  await $.command.run({ command: "kakunin", args: "", ...RUN });
  await rec.clock.advance(0);
  expect(rec.prompts[0]!.startsWith("ビルド（組み立て）とテスト（動作の自動確認）を回して")).toBe(true);
});
