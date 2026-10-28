// 【3】読む のテスト。`claude plugin test .` で走る。
import { test, expect } from "claude-code/testing";
import { fresh, RUN, answer, mountPanel, setupPanel, texts } from "./_panel-setup";

test("直近に Read / Edit したファイルが選べて、選ぶと説明の頼みが送られ、返事が「読む」タブに残る", async ($, on) => {
  const rec = await fresh($, on);
  await $.turn.start({ text: "見て", turnId: "t1" });
  await $.tool.call({ tool: "Read", file_path: "/proj/src/api.ts" });
  await $.tool.call({ tool: "Edit", file_path: "/proj/README.md", old_string: "a", new_string: "b" });
  await $.tool.call({ tool: "Read", file_path: "/proj/src/api.ts" }); // 同じ物は 1 つにまとまり、新しい方が上
  await answer($, "見ました。");

  expect((await $.command.run({ command: "yomu", args: "", ...RUN })).text).toBe("「読む」タブを開きました。ファイルを選んでください");
  let ui = await mountPanel($);
  const select = await ui.find({ type: "Select" });
  expect(select).toBeDefined();
  expect((select!.props as any).options.map((o: any) => o.label)).toEqual(["src/api.ts", "README.md"]);

  await ui.select({ key: "yomu:file", value: "/proj/README.md" });
  expect(rec.prompts).toEqual(["README.md を、プログラムを知らない人向けに段落ごとに日本語で説明して。各段落は『ここは何をしている』『どこから呼ばれる』『壊すとどうなる』の3点。専門用語は括弧で一言。"]);
  await ui.unmount();

  // 返事が来ると保存される
  await $.turn.start({ text: "README.md を説明して", turnId: "t2" });
  await answer($, "この文書は、使い方を書いた案内です。", "t2");
  ui = await mountPanel($);
  const open = (await ui.findAll({ type: "Button" })).find((b: any) => String(b.props?.key ?? b.key ?? "").startsWith("yomu:open:"));
  expect(open).toBeDefined();
  expect(String((open as any).props.label)).toBe("▸ README.md");
  await ui.press({ key: String((open as any).props.key) });
  expect((await texts(ui)).some((t) => t.includes("この文書は、使い方を書いた案内です。"))).toBe(true);
});

test("まだ何も読んでいなければ、その旨を出す", async ($, on) => {
  await fresh($, on);
  await $.command.run({ command: "yomu", args: "", ...RUN });
  const ui = await mountPanel($);
  expect((await texts(ui)).some((t) => t.includes("まだ最近のファイルがありません"))).toBe(true);
  expect(await ui.find({ type: "Select" })).toBeUndefined();
});
