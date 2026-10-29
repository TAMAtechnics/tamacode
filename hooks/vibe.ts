// 雰囲気モード（/kakkoii）の純粋な部分: 設定、HUD の文字列と SVG、進捗バー、起動ロゴ。
// 数字はすべて実データ（vibeStats）。見せかけの％やダミーは入れない。$ は使わない。

import type { TamacodeNow, TamacodeVibeStats } from "../types/tamacode";
import { VIBE_DEFAULTS } from "./vibe.defaults";

export type VibeConfig = {
  color: string;
  logLines: number;
  bootAnimation: boolean;
  barWidth: number;
  tokensPerBlock: number;
  secondsPerBlock: number;
  hudColumns: number;
};

let config: VibeConfig = VIBE_DEFAULTS as unknown as VibeConfig;
export const getVibeConfig = (): VibeConfig => config;

/** config/vibe.json の中身で上書き。読めた項目数（壊れていれば 0） */
export function applyVibeConfig(jsonText: string): number {
  let got: unknown;
  try {
    got = JSON.parse(jsonText);
  } catch {
    return 0;
  }
  if (!got || typeof got !== "object") return 0;
  const next: Record<string, unknown> = { ...(config as unknown as Record<string, unknown>) };
  let n = 0;
  for (const [k, v] of Object.entries(got as Record<string, unknown>)) {
    if (k.startsWith("_") || !(k in (VIBE_DEFAULTS as Record<string, unknown>))) continue;
    if (typeof v === typeof (VIBE_DEFAULTS as Record<string, unknown>)[k]) {
      next[k] = v;
      n++;
    }
  }
  config = next as unknown as VibeConfig;
  return n;
}

export function resetVibeConfig(): void {
  config = VIBE_DEFAULTS as unknown as VibeConfig;
}

export const EMPTY_STATS: TamacodeVibeStats = { startedAt: 0, inputTokens: 0, outputTokens: 0, filesRead: [], edits: 0, errors: 0, turnOutputTokens: 0 };

// ---------- 整形 ----------

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 00:12:34 */
export function hms(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
}

/** 12,345 */
export const num = (n: number): string => String(Math.max(0, Math.floor(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** HUD 上段（端末向け、等幅前提） */
export function hudLines(stats: TamacodeVibeStats, now: number): string[] {
  const session = stats.startedAt > 0 ? hms(now - stats.startedAt) : "--:--:--";
  return [
    `SESSION  ${session}`,
    `TOKENS   in ${num(stats.inputTokens)}  out ${num(stats.outputTokens)}`,
    `FILES    ${num(stats.filesRead.length)}`,
    `EDITS    ${num(stats.edits)}`,
    `ERRORS   ${num(stats.errors)}`,
  ];
}

// ---------- ハッカー風の追加行（全部実データ） ----------

const SPARK = "▁▂▃▄▅▆▇█";
export const HISTORY_KEEP_MS = 20 * 60 * 1000;

/** 出力トークンの履歴に 1 件足して、古い物を落とす */
export function pushHistory(history: Array<{ at: number; tokens: number }> | undefined, at: number, tokens: number): Array<{ at: number; tokens: number }> {
  if (tokens <= 0) return (history ?? []).filter((h) => at - h.at <= HISTORY_KEEP_MS);
  return [...(history ?? []), { at, tokens }].filter((h) => at - h.at <= HISTORY_KEEP_MS);
}

/** 直近 width 区間（bucketMs ごと）の出力トークン量を ▁▂▃▅▇ で。全部 0 なら ▁ が並ぶ */
export function sparkline(history: Array<{ at: number; tokens: number }> | undefined, now: number, width = 24, bucketMs = 30_000): string {
  const buckets = new Array<number>(width).fill(0);
  for (const h of history ?? []) {
    const idx = width - 1 - Math.floor((now - h.at) / bucketMs);
    if (idx >= 0 && idx < width) buckets[idx] = (buckets[idx] ?? 0) + h.tokens;
  }
  const max = Math.max(...buckets, 1);
  return buckets.map((v) => (v <= 0 ? SPARK[0] : SPARK[Math.min(7, 1 + Math.floor((v / max) * 6.999))])).join("");
}

/** 文脈の窓の使用率 CTX [████░░░░]  38%。分からなければ ? を並べる */
export function ctxGauge(percent: number | null, width = 8): string {
  if (percent === null) return `CTX      [${"?".repeat(width)}]   --`;
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return `CTX      ${bar((p / 100) * width, width)} ${String(p).padStart(3)}%`;
}

/** 道具が動いている間だけ出る脈動行: ▶ RUNNING  bash    00:12（1 秒ごとに ▶ ▷ が交互）。無ければ null */
export function pulseLine(now: TamacodeNow | null, clock: number): string | null {
  if (now === null) return null;
  const tick = Math.floor(clock / 1000) % 2 === 0 ? "▶" : "▷";
  const elapsed = hms(clock - now.startedAt).slice(3); // mm:ss
  if (now.phase === "running" && now.tool !== null) {
    const name = now.tool.replace(/^mcp__([^_]+(?:_[^_]+)*)__.*$/, "$1").toLowerCase();
    return `${tick} RUNNING  ${name.slice(0, 10).padEnd(10)} ${elapsed}`;
  }
  if (now.phase === "writing") return `${tick} WRITING  ${"claude".padEnd(10)} ${elapsed}`;
  return null;
}

/** HUD 上段の追加行（CTX ゲージ・スパークライン・脈動行）。順に並べて hudLines の後ろに付ける */
export function hudExtraLines(stats: TamacodeVibeStats, ctxPercent: number | null, now: TamacodeNow | null, clock: number): string[] {
  const out = [ctxGauge(ctxPercent), `OUT/30s  ${sparkline(stats.outHistory, clock)}`];
  const pulse = pulseLine(now, clock);
  if (pulse !== null) out.push(pulse);
  return out;
}

/** 進捗バー [████░░░░] */
export function bar(filled: number, width: number): string {
  const w = Math.max(1, Math.floor(width));
  const f = Math.max(0, Math.min(w, Math.floor(filled)));
  return `[${"█".repeat(f)}${"░".repeat(w - f)}]`;
}

/** 今の状態から進捗バーを決める。書き出し中はこのターンの出力トークン、道具の実行中は経過秒。どちらでもなければ null */
export function barForNow(now: TamacodeNow | null, stats: TamacodeVibeStats, clock: number, cfg: VibeConfig = config): { bar: string; label: string } | null {
  if (now === null) return null;
  if (now.phase === "writing") {
    const tok = stats.turnOutputTokens;
    return { bar: bar(tok / Math.max(1, cfg.tokensPerBlock), cfg.barWidth), label: `${num(tok)} tok` };
  }
  if (now.phase === "running") {
    const sec = Math.max(0, Math.floor((clock - now.startedAt) / 1000));
    return { bar: bar(sec / Math.max(1, cfg.secondsPerBlock), cfg.barWidth), label: `${sec}s` };
  }
  return null;
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Desktop 向け SVG。棒グラフの長さは前回の値から今の値へなめらかに動く（<animate>）。数字は実データのまま文字で描く */
export function hudSvg(stats: TamacodeVibeStats, prev: TamacodeVibeStats, now: number, log: Array<{ at: number; text: string }>, cfg: VibeConfig = config, extra: string[] = []): string {
  const color = esc(cfg.color);
  const width = 360;
  const rowH = 22;
  const top = [...hudLines(stats, now), ...extra];
  const maxTok = Math.max(1, stats.inputTokens + stats.outputTokens);
  const barLen = (v: number) => Math.round((Math.max(0, v) / maxTok) * 200);
  const rows = top
    .map((line, i) => `<text x="12" y="${28 + i * rowH}" font-family="ui-monospace, Menlo, monospace" font-size="13" fill="${color}">${esc(line)}</text>`)
    .join("");
  const bars = [
    ["in", prev.inputTokens, stats.inputTokens],
    ["out", prev.outputTokens, stats.outputTokens],
  ]
    .map(([_label, from, to], i) => {
      const y = 28 + top.length * rowH + 6 + i * 10;
      return `<rect x="12" y="${y}" height="4" width="${barLen(Number(to))}" fill="${color}" opacity="0.8"><animate attributeName="width" from="${barLen(Number(from))}" to="${barLen(Number(to))}" dur="0.5s" fill="freeze" /></rect>`;
    })
    .join("");
  const sepY = 28 + top.length * rowH + 30;
  const logRows = log
    .slice(0, cfg.logLines)
    .map((l, i) => `<text x="12" y="${sepY + 18 + i * 16}" font-family="ui-monospace, Menlo, monospace" font-size="11" fill="${color}" opacity="${i === 0 ? 1 : 0.7}">${esc(l.text)}</text>`)
    .join("");
  const height = sepY + 24 + cfg.logLines * 16;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect x="0.5" y="0.5" width="${width - 1}" height="${height - 1}" fill="none" stroke="${color}" stroke-width="1" /><text x="12" y="14" font-family="ui-monospace, Menlo, monospace" font-size="11" fill="${color}" opacity="0.8">TAMA HUD</text>${rows}${bars}<line x1="8" y1="${sepY}" x2="${width - 8}" y2="${sepY}" stroke="${color}" stroke-width="1" opacity="0.6" />${logRows}</svg>`;
}

/** 起動ロゴの文字部分（ASCII、5 行） */
export const LOGO_TEXT = [
  " _____   _     __  __     _     ____  ___   ____   _____",
  "|_   _| / \\   |  \\/  |   / \\   / ___|/ _ \\ |  _ \\ | ____|",
  "  | |  / _ \\  | |\\/| |  / _ \\ | |   | | | || | | ||  _|",
  "  | | / ___ \\ | |  | | / ___ \\| |___| |_| || |_| || |___",
  "  |_|/_/   \\_\\|_|  |_|/_/   \\_\\\\____|\\___/ |____/ |_____|",
];

/** ロゴの右に座る大きい猫（5 行）。「･」は幅が曖昧で行ごとにずれるので、ここは ASCII だけで描く */
export const LOGO_CAT = ["    /\\_/\\", "   (=^.q.^=)", "   (   ~   )", "    (  )  )", "   (__)(__)"];

const LOGO_WIDTH = Math.max(...LOGO_TEXT.map((l) => l.length));

/** 起動ロゴ: 文字の右に猫を並べた 5 行 */
export const LOGO = LOGO_TEXT.map((l, i) => `${l.padEnd(LOGO_WIDTH)}   ${LOGO_CAT[i] ?? ""}`);

/** docs/次回.md の最初の意味のある 1 行（見出し記号は外す）。無ければ null */
export function firstLineOf(text: string | null): string | null {
  if (text === null) return null;
  const line = text
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s#>*-]+/, "").trim())
    .find((l) => l !== "");
  return line === undefined ? null : line.length > 80 ? line.slice(0, 79) + "…" : line;
}

/** 道具の呼び出しを HUD のログ 1 行に（道具名＋対象） */
export function logLineFor(tool: string, input: Record<string, unknown>, relPath: (p: string) => string): string {
  const file = typeof input.file_path === "string" ? input.file_path : typeof input.notebook_path === "string" ? input.notebook_path : null;
  if (file !== null) return `${tool.padEnd(5)} ${relPath(file)}`;
  if (typeof input.command === "string") return `${tool.padEnd(5)} ${input.command.replace(/\s+/g, " ").trim().slice(0, 60)}`;
  if (typeof input.pattern === "string") return `${tool.padEnd(5)} ${input.pattern.slice(0, 40)}`;
  if (typeof input.url === "string") return `${tool.padEnd(5)} ${input.url.slice(0, 60)}`;
  if (typeof input.query === "string") return `${tool.padEnd(5)} ${input.query.slice(0, 40)}`;
  return tool;
}
