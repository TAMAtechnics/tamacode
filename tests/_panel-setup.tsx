// 操作盤まわりのテストで共通に使う「底」。各テストが import する（テストではない）。
import { mock } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";

export const T0 = 1_800_000_000_000;
export const RUN = { origin: { kind: "composer" }, presentation: { isFullscreen: true, columns: 120 } } as const;
export const PANE_PROPS = { title: "たま", isFocused: true, bodyColumns: 64, placement: "dock", scroll: { top: 0 }, view: {} } as any;
export const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as any;
const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };

export type Rec = {
  prompts: string[];
  runs: string[][];
  writes: Array<{ path: string; text: string }>;
  /** 開いたペインの id */
  opens: string[];
  /** 閉じたペインの id */
  closes: string[];
};

export type SetupOptions = {
  store?: Record<string, unknown>;
  /** process.run の返事を argv から決める */
  run?: (argv: readonly string[]) => { exitCode?: number; stdout?: string; stderr?: string } | null;
  model?: string | "fail";
  files?: Record<string, string>;
};

export function setupPanel(on: On, opts: SetupOptions = {}): Rec & { clock: ReturnType<typeof mock.clock> } {
  const rec: Rec = { prompts: [], runs: [], writes: [], opens: [], closes: [] };
  let shown: Array<{ id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }> = [];
  mock.store(on, opts.store ?? {});
  const clock = mock.clock(on, { now: T0 });
  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("session.cwd", () => ({ value: "/proj" }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("ui.open", (_$, e) => {
    rec.opens.push(e.id);
    shown = [{ id: e.id, title: String(e.title ?? ""), isShown: true, isFocused: true, isPlaced: true }];
    return { value: { isPlaced: true } };
  });
  on("ui.close", (_$, e) => {
    rec.closes.push(e.id);
    shown = [];
    return { value: undefined };
  });
  on("ui.panes", () => ({ value: shown }));
  on("ui.log", () => ({ value: undefined }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("env.get", () => ({ value: "/home/tama" }));
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
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", (_$, e) => ({ text: e.answer }));
  on("prompt.submit", (_$, e) => {
    rec.prompts.push(e.text);
    return { text: e.text };
  });
  on("process.run", (_$, e) => {
    rec.runs.push([...e.argv]);
    const r = opts.run?.(e.argv) ?? null;
    return { value: { exitCode: r?.exitCode ?? 0, stdout: r?.stdout ?? "", stderr: r?.stderr ?? "", isStdoutTruncated: false } };
  });
  on("model.complete", () => {
    if (opts.model === "fail") return { value: { isAnswered: false, reason: "api-error", status: 500, error: "server_error", usage: USAGE } };
    return { value: { isAnswered: true, text: opts.model ?? "一行目\n二行目\n三行目", usage: USAGE } };
  });
  on("ui.render", { component: "AbovePrompt" }, ($, e) => {
    const { Box } = $.ui.resolve(e);
    return <Box />;
  });
  on("tool.call", { tool: "Read" }, (_$, e) => ({ result: { file: { filePath: (e as any).file_path, content: "x", numLines: 1, startLine: 1, totalLines: 1 } } as any }));
  on("tool.call", { tool: ["Edit", "Write"] }, (_$, e) => ({ result: { filePath: (e as any).file_path } as any }));
  on("tool.call", { tool: "Bash" }, () => ({ result: { stdout: "", stderr: "", interrupted: false } as any }));
  return { ...rec, clock };
}

// $.state は同じ実行の中でテストをまたいで残るので、前のテストの「作業中」を消してから始める
export async function fresh($: Engine, on: On, opts: SetupOptions = {}): Promise<ReturnType<typeof setupPanel>> {
  const rec = setupPanel(on, opts);
  await $.turn.complete({ answer: "", reason: "aborted", durationMs: 0, isAborted: true, turnId: "reset" } as any);
  rec.prompts.length = 0;
  rec.runs.length = 0;
  rec.writes.length = 0;
  rec.opens.length = 0;
  rec.closes.length = 0;
  return rec;
}

export const mountPanel = ($: Engine) => $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "Pane", requestId: "tama", props: PANE_PROPS });

export const texts = async (ui: { findAll: (q: any) => Promise<any[]> }) => (await ui.findAll({ type: "Text" })).map((t: any) => String(t.text));

export const bandText = async ($: Engine, props = BAND) => {
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "AbovePrompt", props });
  const out = (await ui.findAll({ type: "Text" })).map((t) => t.text);
  await ui.unmount();
  return out;
};

export const answer = ($: Engine, text: string, turnId = "t1") =>
  $.turn.complete({ answer: text, reason: "answer", durationMs: 1000, isAborted: false, turnId } as any);
