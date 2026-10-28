// 「ブラウザで見る」（/miru）のテスト。`claude plugin test .` で走る。
import { test, expect, mock } from "claude-code/testing";
import type { Engine } from "claude-code/testing";
import type { On } from "claude-code";
import { planDev } from "../hooks/server";

const RUN = { origin: { kind: "composer" }, presentation: { isFullscreen: true, columns: 120 } } as const;
const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as any;

type Rec = { runs: string[][]; tools: Array<Record<string, unknown>>; statuses: Array<string | undefined>; prompts: string[] };

function setup(on: On, opts: { files?: Record<string, string>; up?: (port: string) => boolean } = {}): Rec & { clock: ReturnType<typeof mock.clock> } {
  const rec: Rec = { runs: [], tools: [], statuses: [], prompts: [] };
  mock.store(on, {});
  const clock = mock.clock(on, { now: 1_800_000_000_000 });
  on("session.cwd", () => ({ value: "/proj" }));
  on("command.register", (_$, e) => ({ value: { command: e.name } }));
  on("ui.open", () => ({ value: { isPlaced: true } }));
  on("ui.log", () => ({ value: undefined }));
  on("ui.invalidate", () => ({ value: undefined }));
  on("ui.toast", () => ({ value: undefined }));
  on("ui.status", (_$, e) => {
    rec.statuses.push(e.text);
    return { value: undefined };
  });
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
  on("fs.exists", (_$, e) => ({ value: (opts.files ?? {})[e.path] !== undefined }));
  on("process.run", (_$, e) => {
    rec.runs.push([...e.argv]);
    if (e.argv[0] === "curl") {
      const port = String(e.argv[e.argv.length - 1]).split(":").pop() ?? "";
      const up = opts.up?.(port) ?? false;
      return { value: { exitCode: 0, stdout: up ? "200" : "000", stderr: "", isStdoutTruncated: false } };
    }
    return { value: { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false } };
  });
  on("tool.call", { tool: "Bash" }, (_$, e) => {
    rec.tools.push({ ...(e as unknown as Record<string, unknown>) });
    return { result: { stdout: "", stderr: "", interrupted: false } as any };
  });
  return { ...rec, clock };
}

const bandText = async ($: Engine) => {
  const ui = await $.ui.mount({ plugin: "tamacode", surface: "terminal", component: "AbovePrompt", props: BAND });
  const texts = (await ui.findAll({ type: "Text" })).map((t) => t.text);
  await ui.unmount();
  return texts;
};

const NEXT_PKG = JSON.stringify({ scripts: { dev: "next dev -p 3001", build: "next build" }, dependencies: { next: "15.0.0" } });

test("起動方法とポートの見当: package.json の dev と部品から決める", () => {
  expect(planDev(NEXT_PKG, ["pnpm-lock.yaml"], null)).toMatchObject({ command: "pnpm run dev", ports: expect.arrayContaining([3001, 3000]) });
  expect(planDev(NEXT_PKG, [], null).command).toBe("npm run dev");
  expect(planDev(NEXT_PKG, ["yarn.lock"], "PORT=4010\n").ports[0]).toBe(4010);
  expect(planDev(JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "4" } }), [], null)).toMatchObject({ command: "npm run start" });
  expect(planDev(null, [], null).command).toBeNull();
  expect(planDev(JSON.stringify({ dependencies: { vite: "5" }, scripts: { dev: "vite" } }), ["bun.lockb"], null)).toMatchObject({ command: "bun run dev", ports: expect.arrayContaining([5173]) });
});

test("もう動いていれば、そのままブラウザで開き、状態行が光る", async ($, on) => {
  const rec = setup(on, { files: { "/proj/package.json": NEXT_PKG }, up: (p) => p === "3001" });
  const r = await $.command.run({ command: "miru", args: "", ...RUN });
  expect(r.text).toBe("ブラウザで開きました: http://localhost:3001");
  expect(rec.runs.some((a) => a[0] === "open" && a[1] === "http://localhost:3001")).toBe(true);
  expect(rec.tools).toEqual([]); // 起動はしていない
  expect(rec.statuses[rec.statuses.length - 1]).toBe("🟢 サーバー起動中 localhost:3001");
  expect((await bandText($)).some((l) => l.includes("ブラウザで開きました: http://localhost:3001"))).toBe(true);
});

test("動いていなければ dev を裏で起動し、立ち上がったら開く", async ($, on) => {
  let up = false;
  const rec = setup(on, { files: { "/proj/package.json": NEXT_PKG }, up: (p) => up && p === "3001" });
  const r = await $.command.run({ command: "miru", args: "", ...RUN });
  expect(r.text).toBe("開発サーバー（作ったものを手元で動かす係）を起動しています: npm run dev　立ち上がったら http://localhost:3001 を開きます");
  expect(rec.tools).toHaveLength(1);
  expect(rec.tools[0]).toMatchObject({ tool: "Bash", command: "npm run dev", run_in_background: true });
  expect(rec.runs.some((a) => a[0] === "open")).toBe(false);

  // 3 秒後に立ち上がる
  await rec.clock.advance(2000);
  expect(rec.runs.some((a) => a[0] === "open")).toBe(false);
  up = true;
  await rec.clock.advance(1000);
  expect(rec.runs.some((a) => a[0] === "open" && a[1] === "http://localhost:3001")).toBe(true);
  expect(rec.statuses[rec.statuses.length - 1]).toBe("🟢 サーバー起動中 localhost:3001");

  // 止まると印が消える
  up = false;
  await rec.clock.advance(10_000);
  expect(rec.statuses[rec.statuses.length - 1]).toBeUndefined();
});

test("起動方法が分からなければ、Claude に頼む文を送る", async ($, on) => {
  const rec = setup(on);
  const r = await $.command.run({ command: "miru", args: "", ...RUN });
  expect(r.text).toBe("開発サーバー（作ったものを手元で動かす係）の起動方法が分かりませんでした。Claude に頼みます");
  await rec.clock.advance(0);
  expect(rec.prompts[0]!.startsWith("開発サーバーを起動して")).toBe(true);
  expect(rec.tools).toEqual([]);
});
