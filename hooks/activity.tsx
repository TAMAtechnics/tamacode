// 今やってること・待ってていいかの判定・履歴・迷走検知（プロンプトの上の帯、/log、Spinner の日本語化）
//
// 帯（入力欄の上）に 1 行だけ上書きで出す:
//   猫の顔 ＋ いま何をしているか（道具の名前は日本語、対象のファイルやコマンドつき）＋ 経過時間 ＋ 待っていいかの一言
//
// 状態は 4 つ:
//   A 実行中     tool.call が来て結果がまだ。時間がかかる作業（Bash は install/build/test/dev など）なら「待ってOK」
//   B 書き出し中 turn.step の文字が増えている → 「待ってOK」
//   C 返事待ち   許可ダイアログや質問で止まっている → 「あなたの番です」
//   D 無反応     A〜C のどれでもなく、最後の変化から 60 秒超 → 「動いてないかも」、120 秒超 → 「Escで止めて続きを頼むのが安全」
//     時間がかかる作業でない Bash が 60 秒を超えたときも D と同じ扱い。
// 「最後に変化があった時刻」は tool.call・結果・文字の増加・ダイアログ表示で更新する。
//
// そのほか: 迷走検知（同じファイルを READ_LIMIT 回以上、同じエラーを ERROR_LIMIT 回以上）、
// ツール出力のエラー文を用語ペイン（terms.tsx）へ渡す、Spinner と「Crunched for 4s」の日本語化、/log の履歴ペイン。
// ツールの実行は一切止めない（見せるだけ）。

import type { EngineInterface, Register } from "claude-code";
import type { TamacodeLogEntry, TamacodeNow, TamacodeTerms, TamacodeWander } from "../types/tamacode";
import { buildTerms, pickErrorLines } from "./terms";

// $.state の参照。plugin と key はリテラルでないと validate が読めない。
const NOW = { plugin: "tamacode", key: "now" } as const;
const LOG = { plugin: "tamacode", key: "log" } as const;
const WANDER = { plugin: "tamacode", key: "wander" } as const;
const TERMS = { plugin: "tamacode", key: "terms" } as const;

const PANE_ID = "log";
const LOG_LIMIT = 200;
const MAX_OUTPUTS = 10; // 用語ペインに渡すツール出力は、ターン内で新しい方から 10 個まで
const READ_LIMIT = 5;
const ERROR_LIMIT = 3;
const STALL_MS = 60_000; // これを超えて変化が無ければ「動いてないかも」
const ESC_MS = 120_000; // これを超えたら「Esc で止めて」
const TICK_MS = 1000; // 帯の経過時間を描き直す間隔
const TOKEN_WRITE_MS = 1000; // 文字の増加で state を書く間隔（毎チャンクは書かない）
const MESSAGE = "Claudeが迷ってます。目的をもう一度言い直すか、/plan で整理すると抜けやすいです";

// 猫の顔（状態ごと）
export const CAT = {
  idle: "(=^･q･^=)", // 通常・待機
  read: "(=^･q･^=)", // 読んでる
  write: "ฅ(=^･q･^=)ฅ", // 書いてる
  think: "(=･q･=)?", // 考え中
  web: "(=^･q･^=)ゞ", // ネット検索
  run: "ヽ(=^･q･^=)ノ", // コマンド実行
  done: "(=^‥q‥^=)ﾉ", // 完了
  pause: "(=｡･q･｡=)", // ひと区切り
  error: "(=T_q_T=)", // エラー
  lost: "(=´･q･`=)", // 迷ってる
  danger: "(=｀･q･´=)ﾉ", // 危ない操作
  stopped: "(=｀q´=)つ", // 止めた
  sleep: "(=-q-=)zzZ", // 寝てる・待ち
} as const;

type Dollar = EngineInterface;

// ---------- 小さな道具 ----------

const basename = (p: string): string => {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : String(p);
};

const pad2 = (n: number): string => String(n).padStart(2, "0");

const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

const short = (s: unknown, n = 40): string => {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

// cwd の下にあるファイルは cwd からの相対で、外なら末尾のファイル名だけで見せる
export function rel(file: string, cwd: string | null): string {
  const f = String(file ?? "");
  if (f === "") return "ファイル";
  if (cwd !== null && cwd !== "") {
    const base = cwd.replace(/[\\/]+$/, "");
    if (f.startsWith(base + "/") || f.startsWith(base + "\\")) return f.slice(base.length + 1);
  }
  return f.startsWith("/") ? basename(f) : f;
}

// 相対パスを cwd 基準の絶対パスにする（読み回数を Read ツールと同じ鍵で数えるため）
export function absolute(file: string, cwd: string | null): string {
  if (file.startsWith("/") || file.startsWith("~") || /^[A-Za-z]:[\\/]/.test(file)) return file;
  const base = (cwd ?? "").replace(/[\\/]+$/, "");
  const stripped = file.replace(/^(\.\/)+/, "");
  return base === "" ? stripped : `${base}/${stripped}`;
}

// ミリ秒を「4秒」「1分4秒」「1時間2分」にする
export function jpDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}秒`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r === 0 ? `${m}分` : `${m}分${r}秒`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm === 0 ? `${h}時間` : `${h}時間${rm}分`;
}

// ---------- Bash コマンドの読み取り ----------

// 「ファイルの中身を見る」コマンド。この引数に出たパスを「読んだファイル」として数える
const READ_VERBS = new Set(["cat", "head", "tail", "less", "more", "bat", "sed", "awk", "nl", "wc"]);

// 引用符を尊重してトークンに分け、&& || ; | の所で区切る。各区切りの先頭の環境変数代入や do/then は飛ばす
export function segments(cmd: string): string[][] {
  const tokens = String(cmd ?? "").match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? [];
  const segs: string[][] = [[]];
  for (const raw of tokens) {
    if (/^(&&|\|\||;|\||&)$/.test(raw)) {
      segs.push([]);
      continue;
    }
    const cut = raw.replace(/[;|&]+$/, "");
    const unquoted = cut.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
    if (unquoted !== "") segs[segs.length - 1]!.push(unquoted);
    if (cut !== raw) segs.push([]);
  }
  return segs
    .map((s) => {
      let i = 0;
      while (i < s.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s[i]!) || /^(do|then|else|sudo|time|exec|command|builtin)$/.test(s[i]!))) i++;
      return s.slice(i);
    })
    .filter((s) => s.length > 0);
}

// ファイルのパスらしいトークンか（オプション・変数・URL・数字・リダイレクトは除く）
export function looksLikePath(t: string): boolean {
  if (t === "" || t.startsWith("-") || t.startsWith("$") || t.includes("://")) return false;
  if (/^\d*[<>]/.test(t) || /^[<>]/.test(t)) return false;
  if (/^[\d,.:+-]+[a-z]?$/.test(t)) return false; // 100,330p のような sed のアドレス
  if (/^\.+$/.test(t)) return false;
  return t.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(t);
}

// 読み取り系のコマンドが開いているファイル
export function readFilesInCommand(cmd: string): string[] {
  const out: string[] = [];
  for (const seg of segments(cmd)) {
    if (!READ_VERBS.has(basename(seg[0]!))) continue;
    for (const t of seg.slice(1)) if (looksLikePath(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

// 時間がかかる系の Bash（install / build / test / dev など）。これ以外の Bash は 60 秒超で「動いてないかも」
export function isLongBash(cmd: string): boolean {
  return /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(build|test|dev|start|install|i|ci|add|update|upgrade)\b|\b(tsc|vitest|jest|pytest|cargo|make|docker|docker-compose|next|vite|turbo|nx)\b|\bgo\s+(test|build|run)\b|\bpip3?\s+install\b|\bbrew\s+(install|upgrade)\b|\bclaude\s+plugin\s+(test|validate)\b|\b(npx|bunx|pnpx)\s+\S|\b(curl|wget)\b|\b(vercel|gh|supabase)\s+/i.test(
    cmd,
  );
}

// 危ない操作（削除・push・履歴の巻き戻しなど）
export function isDangerousBash(cmd: string): boolean {
  return /\brm\b|\brmdir\b|\brimraf\b|\bgit\s+push\b|\bgit\s+reset\s+--hard\b|\bgit\s+checkout\s+--\s|\bgit\s+clean\b|\bgit\s+branch\s+-D\b|\bdrop\s+(table|database)\b|\btruncate\b|\bsudo\b|\bkill\b/i.test(cmd);
}

type BashRule = [RegExp, string, keyof typeof CAT];

const BASH_RULES: BashRule[] = [
  [/\b(npm|pnpm|yarn|bun)\s+(run\s+)?build\b|\bnext build\b|\btsc\b|\bvite build\b/, "ビルド中", "run"],
  [/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|vitest|jest)\b|\b(vitest|jest|pytest|go test|cargo test)\b|\bclaude\s+plugin\s+test\b/, "テスト中", "run"],
  [/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip3?\s+install\b|\bbrew install\b/, "パッケージを入れてる", "run"],
  [/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start)\b/, "開発サーバーを起動してる", "run"],
  [/\b(eslint|prettier|biome|ruff|black)\b|\b(npm|pnpm|yarn|bun)\s+run\s+(lint|format)\b/, "コードの書き方をチェック中", "run"],
  [/\bgit\s+(status|diff|log|show|branch)\b/, "git の状態を見てる", "read"],
  [/\bgit\s+(add|commit)\b/, "git にコミットしてる", "run"],
  [/\bgit\s+push\b/, "push してる", "danger"],
  [/\bgit\s+(pull|fetch|checkout|switch|merge|rebase)\b/, "git のブランチを操作してる", "run"],
  [/\bmkdir\b/, "フォルダを作ってる", "run"],
  [/\b(mv|cp)\b/, "ファイルを移動・コピーしてる", "run"],
  [/\brm\b/, "ファイルを削除してる", "danger"],
  [/\b(grep|rg|find|ls|tree)\b/, "ファイルや文字列を探してる", "read"],
  [/\b(curl|wget)\b/, "ネットから取ってきてる", "web"],
  [/\bclaude\s+plugin\s+validate\b/, "プラグインを検証してる", "run"],
  [/\b(vercel|gh|supabase)\s+/, "外部サービスを操作してる", "web"],
  [/\b(python3?|node|bun|npx|bunx|tsx|deno)\s+\S/, "スクリプトを実行してる", "run"],
];

// ---------- 道具の一言 ----------

export type Described = {
  /** 猫の顔 */
  face: string;
  /** 帯に出す文（道具の名前は日本語、対象つき）。出す物が無ければ "" */
  text: string;
  /** このツールが読んだファイル（迷走検知の読み回数に数える）。cwd 基準の絶対パス */
  readFiles: string[];
  /** 「時間がかかる作業なので待ってOK」と言ってよいか */
  isLong: boolean;
  /** 返事待ち（C）になる道具か（質問） */
  isWaiting: boolean;
};

const d = (face: string, text: string, extra: Partial<Described> = {}): Described => ({
  face,
  text,
  readFiles: [],
  isLong: false,
  isWaiting: false,
  ...extra,
});

export function describeTool(tool: string, input: Record<string, unknown>, cwd: string | null): Described {
  const file = (p: unknown): string => rel(String(p ?? ""), cwd);
  switch (tool) {
    case "Read": {
      const p = String(input.file_path ?? "");
      return d(CAT.read, `ファイルを読んでる: ${file(p)}`, { readFiles: p === "" ? [] : [absolute(p, cwd)] });
    }
    case "Edit":
    case "MultiEdit":
      return d(CAT.write, `ファイルを書き換えてる: ${file(input.file_path)}`);
    case "Write":
      return d(CAT.write, `ファイルを書いてる: ${file(input.file_path)}`);
    case "NotebookEdit":
      return d(CAT.write, `ノートブックを書き換えてる: ${file(input.notebook_path)}`);
    case "Grep":
      return d(CAT.read, `文字列を探してる: “${short(input.pattern, 30)}”`);
    case "Glob":
      return d(CAT.read, `ファイルを探してる: “${short(input.pattern, 30)}”`);
    case "Bash": {
      const cmd = String(input.command ?? "");
      const files = readFilesInCommand(cmd);
      let face: string = CAT.run;
      let label = "コマンドを実行してる";
      const rule = BASH_RULES.find(([re]) => re.test(cmd));
      if (rule) {
        label = rule[1];
        face = CAT[rule[2]];
      } else if (files.length > 0 || /\b(cat|head|tail|less|more|bat|sed)\b/.test(cmd)) {
        label = "ファイルの中身を見てる";
        face = CAT.read;
      }
      if (isDangerousBash(cmd)) face = CAT.danger;
      return d(face, `${label}: ${short(cmd, 50)}`, { readFiles: files.map((f) => absolute(f, cwd)), isLong: isLongBash(cmd) });
    }
    case "WebFetch":
      return d(CAT.web, `ネットで調べてる: ${short(input.url, 40)}`, { isLong: true });
    case "WebSearch":
      return d(CAT.web, `ネットで検索してる: “${short(input.query, 30)}”`, { isLong: true });
    case "Agent":
    case "Task":
      return d(CAT.run, `サブエージェントに任せてる: ${short(input.description, 30)}`, { isLong: true });
    case "Skill":
      return d(CAT.idle, `スキルを使ってる: ${short(input.skill, 30)}`);
    case "TodoWrite":
      return d(CAT.pause, "やることリストを更新してる");
    case "AskUserQuestion":
      return d(CAT.sleep, "質問に答えてください", { isWaiting: true });
    case "EnterPlanMode":
    case "ExitPlanMode":
      return d(CAT.think, "作業の計画を立ててる");
    default:
      break;
  }
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool);
  if (m) return d(CAT.web, `${m[1]} に頼んでる: ${short(m[2], 30)}`, { isLong: true });
  if (tool) return d(CAT.run, `${tool} を実行してる`);
  return d(CAT.idle, "");
}

// ---------- 待ってていいかの判定 ----------

export type Verdict = {
  /** 判定後の猫 */
  face: string;
  /** 帯の 1 行（猫 ＋ 何をしているか ＋ 経過 ＋ 一言） */
  line: string;
  /** 一言だけ */
  verdict: string;
};

// now と現在時刻から、帯に出す 1 行を決める
export function judge(now: TamacodeNow, clock: number): Verdict {
  const elapsed = Math.max(0, clock - now.startedAt);
  const silence = Math.max(0, clock - now.at);
  let face: string = now.face;
  let verdict = "";
  if (now.phase === "waiting") {
    face = CAT.sleep;
    verdict = "あなたの番です";
  } else if (now.phase === "running" && now.isLong) {
    verdict = "時間がかかる作業なので待ってOK";
  } else if (silence > ESC_MS) {
    face = CAT.stopped;
    verdict = "Escで止めて続きを頼むのが安全";
  } else if (silence > STALL_MS) {
    face = CAT.error;
    verdict = "動いてないかも";
  } else if (now.phase === "writing") {
    verdict = "書き出し中なので待ってOK";
  }
  const line = `${face} ${now.text}　${jpDuration(elapsed)}${verdict === "" ? "" : `　${verdict}`}`;
  return { face, line, verdict };
}

// Spinner の言葉。道具を動かしている間と書き出し中は帯と同じ文、それ以外は考え中/書いてます
export function spinnerWord(mode: string, now: TamacodeNow | null): string {
  if (now !== null && now.text !== "" && (mode === "tool-use" || mode === "tool-input" || now.phase === "writing" || now.phase === "waiting")) {
    return `${now.face} ${now.text}`;
  }
  if (mode === "tool-use" || mode === "tool-input") return `${CAT.run} 作業中`;
  if (mode === "responding") return `${CAT.pause} 書いてます`;
  return `${CAT.think} 考え中`;
}

// ---------- 迷走検知 ----------

// 「同じエラー」とみなすための署名。行番号や時刻のような数字は潰し、先頭の数行だけ見る。
export function errorSignature(text: string): string {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .slice(0, 3);
  return lines
    .join(" ")
    .toLowerCase()
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .slice(0, 200);
}

// エラー文の見出し（帯に出す用）
const errorHeadline = (text: string): string => {
  const first = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  const s = first ?? "";
  return s.length > 60 ? s.slice(0, 59) + "…" : s;
};

// ターンの中だけで数える（リロードやターン開始で消える）
let reads = new Map<string, number>();
let errors = new Map<string, number>();
let hasToasted = false;
let cwd: string | null = null;
let isTurnRunning = false;
let ticker: { cancel: () => void } | null = null;
let lastTokenWrite = 0; // Date.now() 基準（state を書く間隔の制御だけに使う）
let lastTokenText = "";

const flag = async ($: Dollar, w: TamacodeWander) => {
  await $.state.set(WANDER, w);
  if (!hasToasted) {
    hasToasted = true;
    $.ui.toast(`${CAT.lost} ${MESSAGE}`);
  }
};

async function countRead($: Dollar, file: string): Promise<void> {
  const n = (reads.get(file) ?? 0) + 1;
  reads.set(file, n);
  if (n >= READ_LIMIT) {
    await flag($, { kind: "read", detail: `${basename(file)} を ${n} 回読んでいます`, count: n, at: await $.clock.now() });
  }
}

type ToolCallLike = { tool: string; agentId?: string };
type ToolResultLike = { isError?: true; deny?: string; text?: string; result?: unknown };

const resultText = (result: ToolResultLike): string =>
  typeof result.text === "string" ? result.text : typeof result.result === "string" ? result.result : "";

async function countError($: Dollar, result: ToolResultLike): Promise<void> {
  if (result.isError !== true) return;
  const text = resultText(result);
  const sig = errorSignature(text);
  if (sig === "") return;
  const n = (errors.get(sig) ?? 0) + 1;
  errors.set(sig, n);
  if (n >= ERROR_LIMIT) {
    const head = errorHeadline(text);
    await flag($, { kind: "error", detail: `同じエラーが ${n} 回続いています${head === "" ? "" : `: ${head}`}`, count: n, at: await $.clock.now() });
  }
}

// ---------- 今やってること（state） ----------

async function readNow($: Dollar): Promise<TamacodeNow | null> {
  const got = await $.state.get(NOW);
  const v = got.value as TamacodeNow | null | undefined;
  return v && typeof v === "object" && typeof v.text === "string" ? v : null;
}

type NowPatch = Pick<TamacodeNow, "phase" | "face" | "text" | "tool" | "isLong">;

// 状態を置き換える。文が同じなら経過時間の起点は保ち、「最後の変化」だけ更新する
async function setNow($: Dollar, patch: NowPatch, options: { log?: boolean } = {}): Promise<TamacodeNow> {
  const at = await $.clock.now();
  const cur = await readNow($);
  const same = cur !== null && cur.phase === patch.phase && cur.text === patch.text;
  const next: TamacodeNow = { ...patch, startedAt: same ? cur.startedAt : at, at };
  await $.state.set(NOW, next);
  if (options.log === true && patch.text !== "") await appendLog($, `${patch.face} ${patch.text}`, at);
  return next;
}

// ---------- 履歴（/log） ----------

async function readLog($: Dollar): Promise<TamacodeLogEntry[]> {
  const got = await $.state.get(LOG);
  return Array.isArray(got.value) ? (got.value as TamacodeLogEntry[]) : [];
}

// 新しい順に持つ。先頭と同じ文なら回数を増やすだけ
async function appendLog($: Dollar, text: string, at: number): Promise<void> {
  const list = await readLog($);
  const head = list[0];
  const next =
    head !== undefined && head.text === text
      ? [{ ...head, at, count: head.count + 1 }, ...list.slice(1)]
      : [{ at, text, count: 1 }, ...list].slice(0, LOG_LIMIT);
  await $.state.set(LOG, next);
}

// ---------- 用語ペインへの受け渡し ----------

async function readTerms($: Dollar): Promise<TamacodeTerms | null> {
  const got = await $.state.get(TERMS);
  const v = got.value as Partial<TamacodeTerms> | null | undefined;
  if (!v || typeof v !== "object" || !Array.isArray(v.found)) return null;
  return { at: v.at ?? 0, answer: v.answer ?? "", outputs: Array.isArray(v.outputs) ? v.outputs : [], found: v.found };
}

// ツールの出力のうちエラーらしい部分を、用語ペインの「このターンの出力」に足す
async function collectTerms($: Dollar, result: ToolResultLike, at: number): Promise<void> {
  const picked = pickErrorLines(resultText(result), result.isError === true);
  if (picked === "") return;
  const cur = await readTerms($);
  const outputs = [...(cur?.outputs ?? []), picked].slice(-MAX_OUTPUTS);
  await $.state.set(TERMS, buildTerms(cur?.answer ?? "", outputs, at));
}

// 新しいターン: 前のターンのツール出力は忘れる（返事の語は残す）
async function forgetOutputs($: Dollar, at: number): Promise<void> {
  const cur = await readTerms($);
  if (cur === null || cur.outputs.length === 0) return;
  await $.state.set(TERMS, buildTerms(cur.answer, [], at));
}

// ---------- 登録 ----------

export const register: Register = (on) => {
  // 新しいターン（ユーザーが話しかけた）で数え直し。帯の「今やってること」も消す。経過時間を描き直すタイマーを回し始める
  on("turn.start", async ($, e, next) => {
    reads = new Map();
    errors = new Map();
    hasToasted = false;
    isTurnRunning = true;
    lastTokenText = "";
    if (ticker === null) {
      ticker = $.clock.every(TICK_MS, () => {
        if (isTurnRunning) $.ui.invalidate("ui.render");
      });
    }
    const at = await $.clock.now();
    await Promise.all([$.state.set(WANDER, null), $.state.set(NOW, null), forgetOutputs($, at)]);
    return next(e);
  });

  // 返事が終わったら「今やってること」を消す
  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false;
      await $.state.set(NOW, null);
    }
    return next(e);
  });

  // B 書き出し中: モデルの文字が増えるたびに「最後の変化」を更新する（state は 1 秒に 1 回まで）
  on("turn.step", async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e);
    for await (const chunk of next(e)) {
      try {
        if (chunk.kind === "text" || chunk.kind === "thinking" || chunk.kind === "input" || chunk.kind === "tool") {
          const text = chunk.kind === "thinking" ? "考えてる" : chunk.kind === "text" ? "返事を書いてる" : "道具の指示を書いてる";
          const face = chunk.kind === "thinking" ? CAT.think : chunk.kind === "text" ? CAT.pause : CAT.write;
          const wall = Date.now();
          if (text !== lastTokenText || wall - lastTokenWrite >= TOKEN_WRITE_MS) {
            lastTokenText = text;
            lastTokenWrite = wall;
            await setNow($, { phase: "writing", face, text, tool: null, isLong: true });
          }
        }
      } catch (err) {
        $.ui.log(`書き出し中の更新に失敗: ${String(err)}`, { to: "debug" });
      }
      yield chunk;
    }
  });

  // C 返事待ち: 許可ダイアログが出た
  on("classic.PermissionRequest", async ($, e, next) => {
    try {
      const desc = describeTool(String(e.tool_name ?? ""), (e.tool_input ?? {}) as Record<string, unknown>, cwd);
      await setNow($, { phase: "waiting", face: CAT.sleep, text: `許可を待ってる: ${desc.text}`, tool: e.tool_name, isLong: false }, { log: true });
    } catch (err) {
      $.ui.log(`許可待ちの表示に失敗: ${String(err)}`, { to: "debug" });
    }
    return next(e);
  });

  // C 返事待ち: 許可待ちの通知（PermissionRequest を通らない経路の保険）
  on("classic.Notification", async ($, e, next) => {
    if (e.notification_type === "permission_prompt") {
      try {
        const cur = await readNow($);
        if (cur === null || cur.phase !== "waiting") {
          await setNow($, { phase: "waiting", face: CAT.sleep, text: "許可を待ってる", tool: null, isLong: false }, { log: true });
        }
      } catch (err) {
        $.ui.log(`許可待ちの表示に失敗: ${String(err)}`, { to: "debug" });
      }
    }
    return next(e);
  });

  // A 実行中: すべての道具を見る（本線だけ。サブエージェントの道具は見ない）
  on("tool.call", async ($, e, next) => {
    const like = e as unknown as ToolCallLike;
    if (like.agentId !== undefined) return next(e);

    if (cwd === null) {
      try {
        cwd = await $.session.cwd();
      } catch {
        cwd = null;
      }
    }
    const desc = describeTool(like.tool, like as unknown as Record<string, unknown>, cwd);
    const at = await $.clock.now();
    if (desc.text !== "") {
      await setNow($, { phase: desc.isWaiting ? "waiting" : "running", face: desc.face, text: desc.text, tool: like.tool, isLong: desc.isLong }, { log: true });
    }
    for (const f of desc.readFiles) await countRead($, f);

    const result = await next(e);
    const r = result as ToolResultLike;

    // 結果: 止められた / エラー / ふつうに終わって次を考えている
    try {
      if (r.deny !== undefined) {
        await setNow($, { phase: "between", face: CAT.stopped, text: `止めました: ${short(r.deny, 50)}`, tool: like.tool, isLong: false }, { log: true });
      } else if (r.isError === true) {
        const head = errorHeadline(resultText(r));
        await setNow($, { phase: "between", face: CAT.error, text: `エラーが出ました${head === "" ? "" : `: ${head}`}`, tool: like.tool, isLong: false }, { log: true });
      } else {
        await setNow($, { phase: "between", face: CAT.think, text: "次を考えてる", tool: null, isLong: false });
      }
    } catch (err) {
      $.ui.log(`結果の表示に失敗: ${String(err)}`, { to: "debug" });
    }

    await countError($, r);
    try {
      await collectTerms($, r, at);
    } catch (err) {
      $.ui.log(`ツール出力からの用語抽出に失敗: ${String(err)}`, { to: "debug" });
    }
    return result;
  });

  // /log: 履歴ペインを開く
  on("command.run", { command: "log" }, async ($) => {
    const list = await readLog($);
    const opened = await $.ui.open({ id: PANE_ID, title: "やったこと", focus: true, closeOnEscape: true, columns: 60, rows: 24 });
    if (!opened.isPlaced) return { text: `${CAT.idle} やったこと（${list.length}件）は待機中です: ${opened.reason}` };
    return { text: `${CAT.idle} やったことペインを開きました（${list.length}件）。Esc で閉じます` };
  });

  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const list = await readLog($);
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text bold>{CAT.idle} やったこと（新しい順・最大{LOG_LIMIT}件）</Text>
        <Text dimColor>同じことが続いたときは ×n にまとめています。Esc で閉じる</Text>
        {list.length === 0 ? (
          <Box marginTop={1}>
            <Text dimColor>{CAT.sleep} まだ何もしていません。</Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {list.map((l) => (
              <Text wrap="truncate-end">
                <Text dimColor>{hhmm(l.at)} </Text>
                {l.text}
                {l.count > 1 ? <Text dimColor> ×{l.count}</Text> : null}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    );
  });

  // 入力欄の上の帯: 今やってること＋待ってていいか（1 行、上書き）＋ 迷走の注意
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const [now, wGot, clock] = await Promise.all([readNow($), $.state.get(WANDER), $.clock.now()]);
    const shown = e.props.isWorking && now !== null && now.text !== "" ? judge(now, clock) : null;
    const w = (wGot.value as TamacodeWander | null | undefined) ?? null;
    if (e.props.hasSurvey || (shown === null && w === null)) return next(e);

    const { Box, Text, Button } = $.ui.resolve(e);
    return (
      <Box flexDirection="column" paddingX={1}>
        {shown !== null ? (
          <Box>
            <Text color="cyan" wrap="truncate-end">
              {shown.line}
            </Text>
          </Box>
        ) : null}
        {w !== null ? (
          <Box flexDirection="column">
            <Box>
              <Text color="yellow" bold>
                {CAT.lost} {MESSAGE}
              </Text>
            </Box>
            <Box>
              <Text dimColor>{w.detail}　</Text>
              <Button
                plain
                key="wander:close"
                label="閉じる"
                onPress={() => {
                  void $.state.set(WANDER, null);
                }}
              />
            </Box>
          </Box>
        ) : null}
      </Box>
    );
  });

  // Spinner（Flowing… など）を猫と日本語に。道具を動かしている間は帯と同じ文
  on("ui.render", { component: "Spinner" }, async ($, e, next) => {
    const now = await readNow($);
    return next({ ...e, props: { ...e.props, word: spinnerWord(e.props.mode, now) } });
  });

  // 返事の最後の行（Crunched for 4s）を猫と日本語に
  on("ui.render", { component: "TurnDuration" }, async ($, e) => {
    const { Text } = $.ui.resolve(e);
    return (
      <Text dimColor>
        {CAT.done} {jpDuration(e.props.durationMs)}で完了
      </Text>
    );
  });
};
