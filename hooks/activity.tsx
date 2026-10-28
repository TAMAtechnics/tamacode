// 今やってること・待ってていいかの判定・ひと区切りの 3 行まとめ・迷走検知・Spinner の日本語化
//
// 帯（入力欄の上）に 1 行だけ上書きで出す:
//   猫の顔 ＋ いま何をしているか（道具の名前は日本語、対象のファイルやコマンドつき）＋ 最後の動きからの時間 ＋ 待っていいかの一言
//
// 状態は 4 つ:
//   A 実行中     tool.call が来て結果がまだ。時間がかかる作業（Bash は install/build/test/dev など）なら「待ってOK」
//   B 書き出し中 turn.step の文字が増えている → 「待ってOK」。道具の指示を書いている間は「次の作業の準備中（LICENSE を作る手順を書いてます）」
//   C 返事待ち   許可ダイアログや質問で止まっている → 帯を黄色にして「あなたの番です。上を見て」
//   D 無反応     A〜C のどれでもなく、最後の変化から 60 秒超 → 「動いてないかも」、120 秒超 → 「Escで止めて続きを頼むのが安全」
//     時間がかかる作業でない Bash が 60 秒を超えたときも D と同じ扱い。
// 「最後に変化があった時刻」は tool.call・結果・文字の増加・ダイアログ表示で更新する。
//
// ターンが終わると（turn.complete）、軽いモデルに「やったこと／確認の仕方／次にやること」の 3 行を頼み、
// 返事の最後の行（Crunched for 4s → (=^‥q‥^=)ﾉ 4秒で完了）の下に出す。
//
// そのほか: 迷走検知（同じファイルを READ_LIMIT 回以上、同じエラーを ERROR_LIMIT 回以上）、
// ツール出力のエラー文を用語（terms.tsx）へ渡す、/log の履歴。描画は pane.tsx の「たま」ペインのタブ。
// ツールの実行は一切止めない（見せるだけ）。

import type { EngineInterface, Register } from "claude-code";
import type { TamacodeErrorInfo, TamacodeFinding, TamacodeLogEntry, TamacodeNotice, TamacodeNow, TamacodePermission, TamacodeRead, TamacodeSummary, TamacodeTerms, TamacodeWander } from "../types/tamacode";
import { errorGuess, errorLines, errorPrompt, looksLikeError, parseErrorLines, errorHeadline as errorHeadlineLong } from "./errors";
import { t } from "./locale";
import { parsePermission, permissionGuess, permissionLines, permissionPrompt } from "./permission";
import { buildTerms, pickErrorLines } from "./terms";

// $.state の参照。plugin と key はリテラルでないと validate が読めない。
const NOW = { plugin: "tamacode", key: "now" } as const;
const LOG = { plugin: "tamacode", key: "log" } as const;
const WANDER = { plugin: "tamacode", key: "wander" } as const;
const TERMS = { plugin: "tamacode", key: "terms" } as const;
const SUMMARY = { plugin: "tamacode", key: "summary" } as const;
const NOTICE = { plugin: "tamacode", key: "notice" } as const;
const PERMISSION = { plugin: "tamacode", key: "permission" } as const;
const ERROR_INFO = { plugin: "tamacode", key: "errorInfo" } as const;
const BUSY = { plugin: "tamacode", key: "isBusy" } as const;
const RECENT = { plugin: "tamacode", key: "recentFiles" } as const;
const READS = { plugin: "tamacode", key: "reads" } as const;
const READ_PENDING = { plugin: "tamacode", key: "readPending" } as const;
const END_PENDING = { plugin: "tamacode", key: "endPending" } as const;
const WATCH_BLOCK = { plugin: "tamacode", key: "watchBlock" } as const;
const WATCH_WARNINGS = { plugin: "tamacode", key: "watchWarnings" } as const;
const WATCH_ALLOW = { plugin: "tamacode", key: "watchAllow" } as const;
const PENDING_PROMPT = { plugin: "tamacode", key: "pendingPrompt" } as const;
const BAND_ENABLED = { plugin: "tamacode", key: "bandEnabled" } as const;
const RECENT_LIMIT = 10;
const READS_LIMIT = 20;
const PANE_TAB = { plugin: "tamacode", key: "paneTab" } as const;

const PANE_ID = "tama";
const LOG_LIMIT = 200;
const MAX_OUTPUTS = 10; // 用語ペインに渡すツール出力は、ターン内で新しい方から 10 個まで
const READ_LIMIT = 5;
const ERROR_LIMIT = 3;
const STALL_MS = 60_000; // これを超えて変化が無ければ「動いてないかも」
const ESC_MS = 120_000; // これを超えたら「Esc で止めて」
const TICK_MS = 1000; // 帯の経過時間を描き直す間隔
const TOKEN_WRITE_MS = 1000; // 文字の増加で state を書く間隔（毎チャンクは書かない）
const SUMMARY_MODEL = "haiku";
const SUMMARY_MIN_ANSWER = 40; // これより短い返事はまとめない
const SUMMARY_MAX_CHARS = 6000;
const MESSAGE = (): string => t("wander.message");

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

export const short = (s: unknown, n = 40): string => {
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

// ---------- 書き出し中の言い換え ----------

// 道具の指示（引数の JSON）を書いている途中から、対象（ファイル名やコマンド）を抜く
export function extractTarget(partialJson: string): { file?: string; command?: string } {
  const out: { file?: string; command?: string } = {};
  const m1 = /"(file_path|notebook_path)"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(partialJson);
  if (m1 && m1[2] !== "") out.file = m1[2]!.replace(/\\"/g, '"');
  const m2 = /"command"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(partialJson);
  if (m2 && m2[1] !== "") out.command = m2[1]!.replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  return out;
}

// 「道具の指示を書いてる」を素人向けに。対象が分かれば入れる（LICENSE を作る手順を書いてます）
export function prepText(tool: string, target: { file?: string; command?: string }, cwd: string | null): string {
  if (tool === "") return "次の作業を準備中";
  const file = target.file !== undefined ? rel(target.file, cwd) : null;
  const cmd = target.command !== undefined ? short(target.command, 40) : null;
  let what: string;
  switch (tool) {
    case "Write":
      what = file === null ? "ファイルを作る手順を書いてます" : `${file} を作る手順を書いてます`;
      break;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      what = file === null ? "ファイルを書き換える手順を書いてます" : `${file} を書き換える手順を書いてます`;
      break;
    case "Bash":
      what = cmd === null ? "コマンドを組み立ててます" : `コマンドを組み立ててます: ${cmd}`;
      break;
    case "Read":
      what = file === null ? "読むファイルを決めてます" : `${file} を読む準備`;
      break;
    case "Grep":
    case "Glob":
      what = "探す条件を書いてます";
      break;
    case "Agent":
    case "Task":
      what = "サブエージェントへの指示を書いてます";
      break;
    case "AskUserQuestion":
      what = "質問を用意してます";
      break;
    default: {
      const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool);
      what = m ? `${m[1]} への頼みごとを書いてます` : `${tool} の準備`;
    }
  }
  return `次の作業の準備中（${what}）`;
}

// ---------- 待ってていいかの判定 ----------

export type Verdict = {
  /** 判定後の猫 */
  face: string;
  /** 帯の 1 行（猫 ＋ 何をしているか ＋ 最後の動きからの時間 ＋ 一言） */
  line: string;
  /** 一言だけ */
  verdict: string;
  /** あなたの番（帯を黄色にして目を向けてもらう） */
  isYourTurn: boolean;
};

// now と現在時刻から、帯に出す 1 行を決める
export function judge(now: TamacodeNow, clock: number): Verdict {
  const silence = Math.max(0, clock - now.at);
  let face: string = now.face;
  let verdict = "";
  let isYourTurn = false;
  if (now.phase === "waiting") {
    face = CAT.sleep;
    verdict = t("band.yourTurn");
    isYourTurn = true;
  } else if (now.phase === "running" && now.isLong) {
    verdict = t("band.waitLong");
  } else if (silence > ESC_MS) {
    face = CAT.stopped;
    verdict = t("band.esc");
  } else if (silence > STALL_MS) {
    face = CAT.error;
    verdict = t("band.stall");
  } else if (now.phase === "writing") {
    verdict = t("band.waitWriting");
  }
  // 帯の時間は「最後に動きがあってから」。Spinner の時間（ターン開始から）と区別がつくように言葉を添える
  const line = `${face} ${now.text}　${t("band.lastMove", { time: jpDuration(silence) })}${verdict === "" ? "" : `　${verdict}`}`;
  return { face, line, verdict, isYourTurn };
}

// Spinner は猫だけ（文言と時間は帯に寄せる。同じ文が 2 か所に出ると煩い）
export function spinnerFace(mode: string, now: TamacodeNow | null): string {
  if (now !== null && now.text !== "") return judge(now, now.at).face;
  if (mode === "tool-use" || mode === "tool-input") return CAT.run;
  if (mode === "responding") return CAT.pause;
  return CAT.think;
}

// ---------- ひと区切りの 3 行まとめ ----------

const SUMMARY_LABELS = ["やったこと", "確認の仕方", "次にやること"] as const;

export function summaryPrompt(prompt: string, answer: string): string {
  const cut = (s: string) => (s.length > SUMMARY_MAX_CHARS ? s.slice(0, SUMMARY_MAX_CHARS) + "\n…(以下省略)" : s);
  return [
    "Claude が今の作業を終えました。プログラムを知らない人向けに、日本語で次の 3 行だけを書いてください。",
    "1 行目は「やったこと: 」、2 行目は「確認の仕方: 」、3 行目は「次にやること: 」で始め、各行 40 字以内。",
    "専門用語は禁止（関数・変数・API・コンポーネント・データベース・リクエスト・コミットなどの言葉は身近な言葉に言い換える）。",
    "確認の仕方は、その人が自分の目で確かめられる具体的な動作（画面を開く、ボタンを押す、ファイルを見る）にする。",
    "次にやることが無ければ「次にやること: 特になし。満足なら終わりでOK」と書く。",
    "出力は 3 行だけ。前置き・見出し・記号・空行は不要。",
    "",
    prompt.trim() === "" ? "" : `頼まれたこと:\n${cut(prompt)}\n`,
    `Claude の返事:\n${cut(answer)}`,
  ].join("\n");
}

// モデルの返事を 3 行（ラベル付き）に整える。拾えなければ null
export function tidySummary(text: string): string[] | null {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s\-・*•#>]+/, "").trim())
    .filter((l) => l !== "");
  const out: string[] = [];
  for (const label of SUMMARY_LABELS) {
    const hit = lines.find((l) => l.startsWith(label));
    if (hit === undefined) continue;
    const body = hit
      .slice(label.length)
      .replace(/^[\s:：]+/, "")
      .trim();
    if (body !== "") out.push(`${label}: ${body.length > 60 ? body.slice(0, 59) + "…" : body}`);
  }
  return out.length === 0 ? null : out;
}

async function summarizeTurn($: Dollar, req: { turnId: string; durationMs: number; prompt: string; answer: string }): Promise<void> {
  let lines: string[] | null = null;
  try {
    const r = await $.model.complete({
      model: SUMMARY_MODEL,
      system: "あなたは、プログラムを知らない人に向けて、作業の区切りをやさしい日本語で 3 行にまとめる係です。",
      prompt: summaryPrompt(req.prompt, req.answer),
      effort: "low",
      maxTokens: 300,
      timeoutMs: 20000,
    });
    if (r.isAnswered) lines = tidySummary(r.text);
    else $.ui.log(`3 行まとめなし: ${r.reason}`, { to: "debug" });
  } catch (err) {
    $.ui.log(`3 行まとめに失敗: ${String(err)}`, { to: "debug" });
  }
  // 別のターンがもう始まっていたら上書きしない
  const cur = await readSummary($);
  if (cur === null || cur.turnId !== req.turnId) return;
  await $.state.set(SUMMARY, { ...cur, lines, isLoading: false });
  $.ui.invalidate("ui.render");
}

async function readSummary($: Dollar): Promise<TamacodeSummary | null> {
  const got = await $.state.get(SUMMARY);
  const v = got.value as TamacodeSummary | null | undefined;
  return v && typeof v === "object" && typeof v.turnId === "string" ? v : null;
}

// ---------- 【5】許可プロンプトの翻訳 ----------

async function readPermission($: Dollar): Promise<TamacodePermission | null> {
  const got = await $.state.get(PERMISSION);
  const v = got.value as TamacodePermission | null | undefined;
  return v && typeof v === "object" && Array.isArray(v.lines) ? v : null;
}

// 規則で即答して帯に出し、裏で軽いモデルに言い直してもらう
async function explainPermission($: Dollar, tool: string, input: Record<string, unknown>, at: number): Promise<void> {
  const guess = permissionGuess(tool, input, cwd);
  await $.state.set(PERMISSION, { at, tool, lines: permissionLines(guess), level: guess.level, isLoading: true } satisfies TamacodePermission);
  const prompt = permissionPrompt(tool, input, cwd, guess);
  $.clock.after(0, () => {
    void (async () => {
      let refined = null as ReturnType<typeof parsePermission>;
      try {
        const r = await $.model.complete({
          model: SUMMARY_MODEL,
          system: "あなたは、プログラムを知らない人に向けて、コンピュータの操作の中身と危なさをやさしい日本語で説明する係です。",
          prompt,
          effort: "low",
          maxTokens: 300,
          timeoutMs: 15000,
        });
        if (r.isAnswered) refined = parsePermission(r.text);
        else $.ui.log(`許可の言い直しなし: ${r.reason}`, { to: "debug" });
      } catch (err) {
        $.ui.log(`許可の言い直しに失敗: ${String(err)}`, { to: "debug" });
      }
      const cur = await readPermission($);
      if (cur === null || cur.at !== at || !cur.isLoading) return; // もう別の許可に移っている
      // 危険度は規則の判定より下げない（モデルが甘く見ても「高」は「高」のまま）
      const rank = { low: 0, mid: 1, high: 2 } as const;
      const level = refined !== null && rank[refined.level] > rank[guess.level] ? refined.level : guess.level;
      const lines = refined !== null ? permissionLines({ ...refined, level }) : cur.lines;
      await $.state.set(PERMISSION, { ...cur, lines, level, isLoading: false });
      $.ui.invalidate("ui.render");
    })();
  });
}

// ---------- 見張りのボタンから Claude に頼む ----------

// 作業中なら turn.complete で送る。終わっていれば今すぐ送る
async function queuePrompt($: Dollar, text: string): Promise<void> {
  if (isTurnRunning) {
    await $.state.set(PENDING_PROMPT, text);
    await $.state.set(NOTICE, { face: CAT.pause, text: t("watch.queued"), at: await $.clock.now() } satisfies TamacodeNotice);
    return;
  }
  $.clock.after(0, () => {
    void $.prompt.submit({ text }).catch((err) => $.ui.log(`送信に失敗: ${String(err)}`, { to: "debug" }));
  });
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
/** Claude が今まさに作業中か（このモジュールの中の値。state の isBusy と合わせて使う） */
export const isTurnRunningNow = (): boolean => isTurnRunning;
let lastPrompt = "";
let ticker: { cancel: () => void } | null = null;
let lastTokenWrite = 0; // Date.now() 基準（state を書く間隔の制御だけに使う）
let lastTokenText = "";

const flag = async ($: Dollar, w: TamacodeWander) => {
  await $.state.set(WANDER, w);
  if (!hasToasted) {
    hasToasted = true;
    $.ui.toast(`${CAT.lost} ${MESSAGE()}`);
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

// エラーなら同じエラーの回数を数えて返す（エラーでなければ 0）
async function countError($: Dollar, result: ToolResultLike): Promise<number> {
  const text = resultText(result);
  if (result.isError !== true && !looksLikeError(text)) return 0;
  const sig = errorSignature(text);
  if (sig === "") return 0;
  const n = (errors.get(sig) ?? 0) + 1;
  errors.set(sig, n);
  if (n >= ERROR_LIMIT) {
    const head = errorHeadline(text);
    await flag($, { kind: "error", detail: `同じエラーが ${n} 回続いています${head === "" ? "" : `: ${head}`}`, count: n, at: await $.clock.now() });
  }
  return n;
}

// ---------- 【4】エラー翻訳 ----------

async function readErrorInfo($: Dollar): Promise<TamacodeErrorInfo | null> {
  const got = await $.state.get(ERROR_INFO);
  const v = got.value as TamacodeErrorInfo | null | undefined;
  return v && typeof v === "object" && Array.isArray(v.lines) ? v : null;
}

// 規則で即答して帯に出し、裏で軽いモデルに 3 行で言い直してもらう。同じエラーが 3 回続いたら「詰まってます」
async function explainError($: Dollar, text: string, tool: string, sameCount: number, at: number): Promise<void> {
  if (sameCount >= ERROR_LIMIT) {
    await $.state.set(ERROR_INFO, { at, tool, lines: [t("error.stuck")], mode: "stuck", sameCount, isLoading: false } satisfies TamacodeErrorInfo);
    return;
  }
  const guess = errorGuess(text, tool);
  await $.state.set(ERROR_INFO, { at, tool, lines: errorLines(guess), mode: "lines", sameCount, isLoading: true } satisfies TamacodeErrorInfo);
  const prompt = errorPrompt(text, tool, guess);
  $.clock.after(0, () => {
    void (async () => {
      let refined = null as ReturnType<typeof parseErrorLines>;
      let failed = false;
      try {
        const r = await $.model.complete({
          model: SUMMARY_MODEL,
          system: "あなたは、プログラムを知らない人に向けて、コンピュータのエラーをやさしい日本語で説明する係です。",
          prompt,
          effort: "low",
          maxTokens: 300,
          timeoutMs: 15000,
        });
        if (r.isAnswered) refined = parseErrorLines(r.text);
        else failed = true;
      } catch (err) {
        failed = true;
        $.ui.log(`エラーの言い直しに失敗: ${String(err)}`, { to: "debug" });
      }
      const cur = await readErrorInfo($);
      if (cur === null || cur.at !== at || !cur.isLoading) return; // もう別のエラー・消えた・「詰まってます」に変わった
      if (failed) {
        const head = errorHeadlineLong(text);
        await $.state.set(ERROR_INFO, { ...cur, lines: [head === "" ? t("error.what.unknown", { tool }) : head, t("error.rawStuck")], mode: "raw", isLoading: false });
      } else {
        await $.state.set(ERROR_INFO, { ...cur, lines: refined !== null ? errorLines(refined) : cur.lines, isLoading: false });
      }
      $.ui.invalidate("ui.render");
    })();
  });
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
    lastPrompt = e.text;
    lastTokenText = "";
    if (ticker === null) {
      ticker = $.clock.every(TICK_MS, () => {
        if (isTurnRunning) $.ui.invalidate("ui.render");
      });
    }
    const at = await $.clock.now();
    await Promise.all([$.state.set(WANDER, null), $.state.set(NOW, null), $.state.set(NOTICE, null), $.state.set(PERMISSION, null), $.state.set(ERROR_INFO, null), $.state.set(BUSY, true), $.state.set(WATCH_BLOCK, null), $.state.set(WATCH_WARNINGS, []), forgetOutputs($, at)]);
    return next(e);
  });

  // 返事が終わったら「今やってること」を消し、3 行まとめを裏で頼む
  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) {
      isTurnRunning = false;
      await Promise.all([$.state.set(NOW, null), $.state.set(BUSY, false)]);
      // 【3】読む: 説明を頼んでいたら、返事を「読む」タブに残す
      try {
        const pending = (await $.state.get(READ_PENDING)).value as { file: string; at: number } | null | undefined;
        if (pending && typeof pending === "object" && e.reason === "answer" && e.answer.trim() !== "") {
          const got = await $.state.get(READS);
          let list: TamacodeRead[] = Array.isArray(got.value) ? (got.value as TamacodeRead[]) : [];
          if (!Array.isArray(got.value)) {
            try {
              const saved = await $.store.get("reads");
              list = Array.isArray(saved) ? (saved as TamacodeRead[]) : [];
            } catch {
              list = [];
            }
          }
          const updated = [{ file: pending.file, answer: e.answer, at: pending.at }, ...list].slice(0, READS_LIMIT);
          await $.state.set(READS, updated);
          try {
            await $.store.set("reads", updated);
          } catch (err) {
            $.ui.log(`「読む」の保存に失敗: ${String(err)}`, { to: "debug" });
          }
        }
        if (pending) await $.state.set(READ_PENDING, null);
      } catch (err) {
        $.ui.log(`「読む」の記録に失敗: ${String(err)}`, { to: "debug" });
      }
      // 見張りのボタンで予約した文があれば、作業が終わった今送る
      try {
        const pending = (await $.state.get(PENDING_PROMPT)).value;
        if (typeof pending === "string" && pending !== "") {
          await $.state.set(PENDING_PROMPT, null);
          const text = pending;
          $.clock.after(0, () => {
            void $.prompt.submit({ text }).catch((err) => $.ui.log(`予約した文の送信に失敗: ${String(err)}`, { to: "debug" }));
          });
        }
      } catch (err) {
        $.ui.log(`予約した文の確認に失敗: ${String(err)}`, { to: "debug" });
      }
      // 【8】おわり: 作業日誌の返事が終わったら帯を「今日はここまで」に
      try {
        if ((await $.state.get(END_PENDING)).value === true) {
          await $.state.set(END_PENDING, false);
          if (e.reason === "answer") await $.state.set(NOTICE, { face: CAT.done, text: t("end.notice"), at: await $.clock.now() } satisfies TamacodeNotice);
        }
      } catch (err) {
        $.ui.log(`「おわり」の知らせに失敗: ${String(err)}`, { to: "debug" });
      }
      if (e.reason === "answer" && e.answer.trim().length >= SUMMARY_MIN_ANSWER) {
        const req = { turnId: e.turnId, durationMs: e.durationMs, prompt: lastPrompt, answer: e.answer };
        await $.state.set(SUMMARY, { turnId: e.turnId, durationMs: e.durationMs, at: await $.clock.now(), lines: null, isLoading: true } satisfies TamacodeSummary);
        // このフックの dispatch が終わると途中の $ 呼び出しは打ち切られうるので、タイマーで別の dispatch に載せる
        $.clock.after(0, () => {
          void summarizeTurn($, req);
        });
      } else {
        await $.state.set(SUMMARY, null);
      }
    }
    return next(e);
  });

  // B 書き出し中: モデルの文字が増えるたびに「最後の変化」を更新する（state は 1 秒に 1 回まで）
  on("turn.step", async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e);
    const toolByBlock = new Map<number, string>(); // 道具の指示ブロックごとの道具名
    const jsonByBlock = new Map<number, string>(); // 同じく、ここまで届いた引数の JSON
    for await (const chunk of next(e)) {
      try {
        let text: string | null = null;
        let face: string = CAT.write;
        if (chunk.kind === "thinking") {
          text = "考えてる";
          face = CAT.think;
        } else if (chunk.kind === "text") {
          text = "返事を書いてる";
          face = CAT.pause;
        } else if (chunk.kind === "tool") {
          toolByBlock.set(chunk.index, chunk.name);
          jsonByBlock.set(chunk.index, "");
          text = prepText(chunk.name, {}, cwd);
        } else if (chunk.kind === "input") {
          const json = (jsonByBlock.get(chunk.index) ?? "") + chunk.json;
          jsonByBlock.set(chunk.index, json.length > 4000 ? json.slice(0, 4000) : json);
          text = prepText(toolByBlock.get(chunk.index) ?? "", extractTarget(json), cwd);
        }
        if (text !== null) {
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
      const tool = String(e.tool_name ?? "");
      const input = (e.tool_input ?? {}) as Record<string, unknown>;
      const desc = describeTool(tool, input, cwd);
      const now = await setNow($, { phase: "waiting", face: CAT.sleep, text: `${t("band.waitingPermission")}: ${desc.text}`, tool, isLong: false }, { log: true });
      await explainPermission($, tool, input, now.at);
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
          await setNow($, { phase: "waiting", face: CAT.sleep, text: t("band.waitingPermission"), tool: null, isLong: false }, { log: true });
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
    await Promise.all([$.state.set(PERMISSION, null), $.state.set(ERROR_INFO, null)]); // 許可が下りた／次の道具に移ったので、翻訳は消す
    if (desc.text !== "") {
      await setNow($, { phase: desc.isWaiting ? "waiting" : "running", face: desc.face, text: desc.text, tool: like.tool, isLong: desc.isLong }, { log: true });
    }
    for (const f of desc.readFiles) await countRead($, f);
    // 【3】読む: 直近に触ったファイルを覚える
    if (["Read", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(like.tool)) {
      const input = like as unknown as Record<string, unknown>;
      const file = String(input.file_path ?? input.notebook_path ?? "");
      if (file !== "") {
        const got = await $.state.get(RECENT);
        const list = Array.isArray(got.value) ? (got.value as string[]) : [];
        await $.state.set(RECENT, [file, ...list.filter((f) => f !== file)].slice(0, RECENT_LIMIT));
      }
    }

    const result = await next(e);
    const r = result as ToolResultLike;

    // 結果: 止められた / エラー / ふつうに終わって次を考えている
    try {
      if (r.deny !== undefined) {
        await setNow($, { phase: "between", face: CAT.stopped, text: t("band.stopped", { reason: short(r.deny, 50) }), tool: like.tool, isLong: false }, { log: true });
      } else if (r.isError === true) {
        const head = errorHeadline(resultText(r));
        await setNow($, { phase: "between", face: CAT.error, text: t("band.error", { head: head === "" ? "" : `: ${head}` }), tool: like.tool, isLong: false }, { log: true });
      } else {
        await setNow($, { phase: "between", face: CAT.think, text: t("band.thinkingNext"), tool: null, isLong: false });
      }
    } catch (err) {
      $.ui.log(`結果の表示に失敗: ${String(err)}`, { to: "debug" });
    }

    const sameCount = await countError($, r);
    if (sameCount > 0) {
      try {
        await explainError($, resultText(r), like.tool, sameCount, at);
      } catch (err) {
        $.ui.log(`エラー翻訳に失敗: ${String(err)}`, { to: "debug" });
      }
    }
    try {
      await collectTerms($, r, at);
    } catch (err) {
      $.ui.log(`ツール出力からの用語抽出に失敗: ${String(err)}`, { to: "debug" });
    }
    return result;
  });

  // /log: 「たま」ペインの「やったこと」タブを開く
  on("command.run", { command: "log" }, async ($) => {
    const list = await readLog($);
    await $.state.set(PANE_TAB, "log");
    const opened = await $.ui.open({ id: PANE_ID, title: "たま", focus: true, closeOnEscape: true, columns: 60, rows: 24 });
    if (!opened.isPlaced) return { text: `${CAT.idle} やったこと（${list.length}件）は待機中です: ${opened.reason}` };
    return { text: `${CAT.idle} やったことタブを開きました（${list.length}件）。Esc で閉じます` };
  });

  // 入力欄の上の帯: 今やってること＋待ってていいか（1 行、上書き。あなたの番なら黄色）＋ 迷走の注意
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    const [now, wGot, nGot, perm, errInfo, bGot, wsGot, enabledGot, clock] = await Promise.all([readNow($), $.state.get(WANDER), $.state.get(NOTICE), readPermission($), readErrorInfo($), $.state.get(WATCH_BLOCK), $.state.get(WATCH_WARNINGS), $.state.get(BAND_ENABLED), $.clock.now()]);
    // /tama で帯をオフにしているときは、見張りが止めた物だけ出す（安全のため）
    if (enabledGot.value === false) {
      const onlyBlock = (bGot.value as TamacodeFinding | null | undefined) ?? null;
      if (onlyBlock === null || e.props.hasSurvey) return next(e);
    }
    const bandOff = enabledGot.value === false;
    const shown = !bandOff && e.props.isWorking && now !== null && now.text !== "" ? judge(now, clock) : null;
    const w = bandOff ? null : ((wGot.value as TamacodeWander | null | undefined) ?? null);
    const notice = bandOff ? null : ((nGot.value as TamacodeNotice | null | undefined) ?? null);
    const errShown = !bandOff && e.props.isWorking ? errInfo : null;
    const block = (bGot.value as TamacodeFinding | null | undefined) ?? null;
    const warnings = bandOff ? [] : Array.isArray(wsGot.value) ? (wsGot.value as TamacodeFinding[]) : [];
    if (e.props.hasSurvey || (shown === null && w === null && notice === null && errShown === null && block === null && warnings.length === 0)) return next(e);

    // 見張りのボタン: 直す（Claude に修正を頼む。作業中なら終わってから送る）／このまま通す（1 回だけ通し、やり直しを頼む）／やめる
    const actOnBlock = (action: "fix" | "allow" | "cancel") => {
      void (async () => {
        if (block === null) return;
        try {
          if (action === "fix" && block.fixPrompt !== null) await queuePrompt($, block.fixPrompt);
          if (action === "allow") {
            const cur = (await $.state.get(WATCH_ALLOW)).value;
            const list = Array.isArray(cur) ? (cur as string[]) : [];
            await $.state.set(WATCH_ALLOW, Array.from(new Set([...list, block.sig])));
            await queuePrompt($, t("watch.retryPrompt"));
          }
        } catch (err) {
          $.ui.log(`見張りのボタンに失敗: ${String(err)}`, { to: "debug" });
        }
        await $.state.set(WATCH_BLOCK, null);
      })();
    };
    // 許可待ちのときだけ、4 行の翻訳を黄色い行の下に出す。危険度が高ければ怒り顔
    const permShown = shown !== null && shown.isYourTurn && perm !== null ? perm : null;
    const mainLine = permShown !== null && permShown.level === "high" ? shown!.line.replace(CAT.sleep, CAT.danger) : shown?.line;

    const { Box, Text, Button } = $.ui.resolve(e);
    return (
      <Box flexDirection="column" paddingX={1}>
        {block !== null ? (
          <Box flexDirection="column">
            <Text color="red" bold wrap="wrap">
              {CAT.stopped} {t("watch.blocked.heading")}: {block.text}
            </Text>
            {block.hint !== null ? <Text wrap="wrap">　{block.hint}</Text> : null}
            <Box>
              <Text>　</Text>
              {block.options.map((o) => (
                <Box>
                  <Button key={`watch:${o.key}`} label={o.label} variant={o.action === "fix" ? "primary" : undefined} onPress={() => actOnBlock(o.action)} />
                  <Text>　</Text>
                </Box>
              ))}
            </Box>
          </Box>
        ) : null}
        {warnings.map((wn) => (
          <Text color="red" wrap="truncate-end">
            {CAT.danger} {wn.text}{wn.hint === null ? "" : `　${wn.hint}`}
          </Text>
        ))}
        {notice !== null ? (
          <Box>
            <Text color={notice.face === CAT.danger ? "red" : "green"} wrap="truncate-end">
              {notice.face} {notice.text}
            </Text>
          </Box>
        ) : null}
        {shown !== null ? (
          <Box>
            <Text color={shown.isYourTurn ? "yellow" : "cyan"} bold={shown.isYourTurn} wrap="truncate-end">
              {mainLine}
            </Text>
          </Box>
        ) : null}
        {permShown !== null ? (
          <Box flexDirection="column" paddingLeft={2}>
            {permShown.lines.map((l) => (
              <Text color={permShown.level === "high" && l.startsWith(t("permission.label.level")) ? "red" : undefined} wrap="truncate-end">
                {l}
              </Text>
            ))}
            {permShown.level === "high" ? (
              <Text color="red" bold>
                {CAT.danger} {t("permission.highHint")}
              </Text>
            ) : null}
            {permShown.isLoading ? <Text dimColor>{t("permission.loading")}</Text> : null}
          </Box>
        ) : null}
        {errShown !== null ? (
          <Box flexDirection="column" paddingLeft={2}>
            {errShown.lines.map((l) => (
              <Text color={errShown.mode === "stuck" ? "yellow" : undefined} bold={errShown.mode === "stuck"} dimColor={errShown.mode === "raw"} wrap="truncate-end">
                {l}
              </Text>
            ))}
            {errShown.isLoading ? <Text dimColor>{t("error.loading")}</Text> : null}
          </Box>
        ) : null}
        {w !== null ? (
          <Box flexDirection="column">
            <Box>
              <Text color="yellow" bold>
                {CAT.lost} {MESSAGE()}
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

  // Spinner（Flowing… など）は猫だけにする（文言と時間は帯に）
  on("ui.render", { component: "Spinner" }, async ($, e, next) => {
    const now = await readNow($);
    return next({ ...e, props: { ...e.props, word: spinnerFace(e.props.mode, now), suffix: "" } });
  });

  // 返事の最後の行（Crunched for 4s）を猫と日本語に。その下に 3 行まとめ
  on("ui.render", { component: "TurnDuration" }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    const sum = await readSummary($);
    const mine = sum !== null && Math.abs(sum.durationMs - e.props.durationMs) <= 1500 ? sum : null;
    return (
      <Box flexDirection="column">
        <Text dimColor>
          {CAT.done} {jpDuration(e.props.durationMs)}で完了
          {mine !== null && mine.isLoading ? "　（3 行まとめを用意中…）" : ""}
        </Text>
        {mine !== null && mine.lines !== null ? (
          <Box flexDirection="column" paddingLeft={2}>
            {mine.lines.map((l) => (
              <Text wrap="wrap">{l}</Text>
            ))}
          </Box>
        ) : null}
      </Box>
    );
  });
};
