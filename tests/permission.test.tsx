// 【5】許可プロンプトの翻訳のテスト。`claude plugin test .` で走る。
import { test, expect, mock } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";
import { CAT } from "../hooks/activity";
import { parsePermission, permissionGuess, permissionLines, permissionPrompt } from "../hooks/permission";

const BAND = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } as any;
const T0 = 1_800_000_000_000;

function setup(on: On, opts: { model?: string | "fail" } = {}) {
  mock.store(on, {});
  const clock = mock.clock(on, { now: T0 });
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
  on("classic.PermissionRequest", () => ({}));
  on("model.complete", () => {
    if (opts.model === "fail") return { value: { isAnswered: false, reason: "api-error", status: 500, error: "server_error", usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } };
    return {
      value: {
        isAnswered: true,
        text: opts.model ?? "何をするか: 部品置き場を消して入れ直します\n消えて困るもの: 消えて困るものはありません\n危険度: 低\nおすすめ: OKでいいです",
        usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    };
  });
  return clock;
}

const bandText = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "AbovePrompt", props: BAND });
  const texts = (await ui.findAll({ type: "Text" })).map((t) => t.text);
  await ui.unmount();
  return texts;
};

const permission = ($: Engine, tool_name: string, tool_input: Record<string, unknown>) =>
  ($ as any).classic.PermissionRequest({ hook_event_name: "PermissionRequest", session_id: "s", transcript_path: "/t", cwd: "/proj", tool_name, tool_input });

test("規則の即答: rm -rf node_modules は低・OK、.env の書き換えは高、push は中", () => {
  const nm = permissionGuess("Bash", { command: "rm -rf node_modules" }, "/proj");
  expect(nm.level).toBe("low");
  expect(permissionLines(nm)).toEqual(["何をするか: 部品置き場（node_modules）を消して入れ直します", "消えて困るもの: 消えて困るものはありません", "危険度: 低", "おすすめ: OKでいいです"]);

  const rm = permissionGuess("Bash", { command: "rm -rf docs" }, "/proj");
  expect(rm.level).toBe("high");
  expect(rm.recommend).toBe("分からなければNOで。あとで聞き直せます");

  expect(permissionGuess("Write", { file_path: "/proj/.env", content: "KEY=1" }, "/proj").level).toBe("high");
  expect(permissionGuess("Bash", { command: "git push origin main" }, "/proj").level).toBe("mid");
  expect(permissionGuess("Bash", { command: "git push --force origin main" }, "/proj").level).toBe("high");
  expect(permissionGuess("Edit", { file_path: "/proj/src/hello.ts", old_string: "a", new_string: "b" }, "/proj").level).toBe("low");
  expect(permissionGuess("Edit", { file_path: "/proj/src/auth.ts", old_string: "a", new_string: "b" }, "/proj").level).toBe("mid");
  expect(permissionGuess("Bash", { command: "npm install" }, "/proj").what).toBe("必要な部品（パッケージ）を入れます");
});

test("モデルの返事の整形。足りなければ null", () => {
  expect(parsePermission("- 何をするか：Aします\n消えて困るもの: なし\n危険度: 中\nおすすめ: 一度見てからOK")).toEqual({ what: "Aします", lose: "なし", level: "mid", recommend: "一度見てからOK" });
  expect(parsePermission("よく分かりません")).toBeNull();
  expect(permissionPrompt("Bash", { command: "rm -rf dist" }, "/proj", permissionGuess("Bash", { command: "rm -rf dist" }, "/proj")).includes("コマンド: rm -rf dist")).toBe(true);
});

test("許可確認が出ると、帯が黄色になり 4 行の説明が付く。モデルの返事で言い直される", async ($, on) => {
  const clock = setup(on, { model: "何をするか: 部品置き場を空にして入れ直します\n消えて困るもの: ありません\n危険度: 低\nおすすめ: OKでいいです" });
  await $.turn.start({ text: "入れ直して", turnId: "t1" });
  await permission($, "Bash", { command: "rm -rf node_modules" });

  let lines = await bandText($);
  expect(lines.some((l) => l.includes(`${CAT.sleep} 許可を待ってる: ファイルを削除してる: rm -rf node_modules`) && l.includes("あなたの番です。上を見て"))).toBe(true);
  expect(lines).toContain("何をするか: 部品置き場（node_modules）を消して入れ直します");
  expect(lines).toContain("危険度: 低");

  await clock.advance(0);
  lines = await bandText($);
  expect(lines).toContain("何をするか: 部品置き場を空にして入れ直します");
  expect(lines).toContain("おすすめ: OKでいいです");
});

test("危険度が高いときは怒り顔になり「分からなければNOで」が付く。モデルが失敗しても規則の 4 行は残る", async ($, on) => {
  const clock = setup(on, { model: "fail" });
  await $.turn.start({ text: "消して", turnId: "t1" });
  await permission($, "Bash", { command: "rm -rf docs" });
  await clock.advance(0);
  const lines = await bandText($);
  expect(lines.some((l) => l.startsWith(`${CAT.danger} 許可を待ってる`))).toBe(true);
  expect(lines).toContain("危険度: 高");
  expect(lines.some((l) => l.includes("分からなければNOで。あとで聞き直せます"))).toBe(true);
});

test("許可が下りて道具が動き出すと、4 行は消える", async ($, on) => {
  setup(on);
  on("tool.call", { tool: "Bash" }, () => ({ result: { stdout: "", stderr: "", interrupted: false } as any }));
  await $.turn.start({ text: "入れ直して", turnId: "t1" });
  await permission($, "Bash", { command: "rm -rf node_modules" });
  await $.tool.call({ tool: "Bash", command: "rm -rf node_modules" });
  const lines = await bandText($);
  expect(lines.some((l) => l.startsWith("何をするか"))).toBe(false);
});
