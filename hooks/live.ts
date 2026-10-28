// スピナー（オレンジの猫の横）の実況: 「猫 ＋ 動作 ＋ 対象 ＋ 目的 ＋ 経過時間」の文を作る純粋な部分。
// 帯（activity.tsx の judge）は「待っていいか」の判定役、こちらは「いま何を・どうしてるか」の実況役。
//   - 対象は道具の引数から（ファイルはパスの末尾 2 階層、Bash は先頭の動詞と対象を日本語に）
//   - 目的は直前の Claude の発言から 1 フレーズ（拾えなければ省略）
//   - 長すぎたら 目的 → 対象 の順に削る。猫と動作と時間は必ず残す
//   - 英語の道具名（Read / Edit / Bash）は出さない

import type { TamacodeLive } from "../types/tamacode";

/** 猫と時間の右側に出るエンジンの飾り（経過時間・トークン・esc の案内）ぶんの余白（セル） */
const ENGINE_RESERVE = 40;
/** 端末幅が分からないときの仮の幅 */
const DEFAULT_COLUMNS = 120;
/** 目的フレーズの上限（文字） */
const PURPOSE_MAX = 40;

const tidy = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();
const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** パスの末尾 2 階層（hooks/activity.tsx）。空なら「ファイル」 */
export function tail2(p: unknown): string {
  const parts = String(p ?? "")
    .split(/[\\/]+/)
    .filter((x) => x !== "" && x !== ".");
  return parts.length === 0 ? "ファイル" : parts.slice(-2).join("/");
}

/** 1 文字の表示幅（全角は 2）。半角カナと記号は 1 */
function cellsOf(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x1100) return 1;
  if (cp >= 0xff61 && cp <= 0xffdc) return 1; // 半角カナ
  if (cp >= 0x0e00 && cp <= 0x0e7f) return 1; // タイ文字（ฅ）
  return 2;
}

/** 文字列の表示幅（セル） */
export function cells(s: string): number {
  let n = 0;
  for (const ch of s) n += cellsOf(ch);
  return n;
}

/** 経過時間を「12s」「1m05s」「1h02m」に */
export function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** 文字数を「820文字」「1.8k文字」に */
export function fmtChars(n: number): string {
  return n < 1000 ? `${n}文字` : `${(n / 1000).toFixed(1)}k文字`;
}

// ---------- 目的（直前の発言から 1 フレーズ） ----------

/** 「〜て」「〜で」で終わる句には「ます」を足す。「〜ます」「〜中」はそのまま */
function closePhrase(p: string): string {
  const s = p.replace(/[。．.!！]+$/, "").trim();
  if (s === "") return "";
  if (/[てで]$/.test(s)) return `${s}ます`;
  return s;
}

/** 直前の Claude の発言から目的を 1 フレーズ拾う。拾えなければ null */
export function purposeFrom(said: string): string | null {
  const lines = String(said ?? "").split(/\r?\n/);
  let inFence = false;
  let last = "";
  for (const raw of lines) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const line = raw
      .replace(/^[\s#>*\-]+|^\s*\d+[.)]\s+/g, "")
      .replace(/\*\*|__|`/g, "")
      .trim();
    if (line === "" || line.startsWith("|")) continue;
    last = line;
  }
  if (last === "" || /[？?]$/.test(last)) return null; // 質問で終わる発言からは拾わない
  const sentences = last
    .split(/(?<=[。！!？?])|[。！!？?]$/)
    .map((s) => s.trim())
    .filter((s) => s !== "");
  const sentence = sentences[sentences.length - 1];
  if (sentence === undefined) return null;
  const clauses = sentence
    .split("、")
    .map((c) => c.trim())
    .filter((c) => c !== "");
  const clause = clauses[clauses.length - 1] ?? sentence;
  const phrase = closePhrase(clause);
  if (phrase.length < 4) return null;
  return cut(phrase, PURPOSE_MAX);
}

// ---------- Bash: 先頭の動詞と対象を日本語に ----------

const bashBasename = (t: string): string => t.split("/").pop() ?? t;

/** 引用符をざっくり尊重して、&& || ; | で区切る。cd と環境変数の代入は飛ばす */
function bashSegments(cmd: string): string[][] {
  const tokens = String(cmd ?? "").match(/"(?:\\.|[^"\\])*"|'[^']*'|\S+/g) ?? [];
  const segs: string[][] = [[]];
  for (const raw of tokens) {
    if (/^(&&|\|\||;|\||&)$/.test(raw)) {
      segs.push([]);
      continue;
    }
    const bare = raw.replace(/[;|&]+$/, "").replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1");
    if (bare !== "") segs[segs.length - 1]!.push(bare);
    if (bare !== raw.replace(/^"(.*)"$/s, "$1").replace(/^'(.*)'$/s, "$1")) segs.push([]);
  }
  return segs
    .map((s) => {
      let i = 0;
      while (i < s.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(s[i]!) || /^(do|then|else|sudo|time|exec|command|builtin)$/.test(s[i]!))) i++;
      return s.slice(i);
    })
    .filter((s) => s.length > 0 && bashBasename(s[0]!) !== "cd");
}

const isPathy = (t: string): boolean => t !== "" && !t.startsWith("-") && !t.startsWith("$") && !t.includes("://") && !/^[<>]/.test(t) && (t.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(t));
const firstArg = (seg: string[]): string | null => seg.slice(1).find((t) => !t.startsWith("-")) ?? null;
const firstPath = (seg: string[]): string | null => seg.slice(1).find(isPathy) ?? null;

/** コマンドから「○○する」の形の動作（対象つき）を作る */
export function bashVerb(cmd: string): string {
  const segs = bashSegments(cmd);
  const seg = segs[0];
  if (seg === undefined) return "コマンドを実行する";
  const verb = bashBasename(seg[0]!);
  const sub = seg[1] ?? "";
  switch (verb) {
    case "cat":
    case "head":
    case "tail":
    case "less":
    case "more":
    case "bat":
    case "sed":
    case "awk":
    case "nl":
    case "wc": {
      const p = firstPath(seg);
      return p === null ? "中身を見る" : `${tail2(p)} の中身を見る`;
    }
    case "grep":
    case "rg":
    case "ag": {
      const pat = firstArg(seg);
      return pat === null ? "探す" : `「${cut(pat, 24)}」を探す`;
    }
    case "find":
    case "fd":
    case "ls":
    case "tree":
      return "ファイルを探す";
    case "which":
    case "type":
    case "command":
      return sub === "" ? "入ってるか確認する" : `${sub} が入ってるか確認する`;
    case "git":
      if (/^(add|commit)$/.test(sub)) return "git にセーブする";
      if (/^(status|diff|log|show|branch|blame)$/.test(sub)) return "git の状態を見る";
      if (sub === "push") return "push する";
      if (/^(pull|fetch|clone)$/.test(sub)) return "git から取ってくる";
      if (/^(checkout|switch|merge|rebase|stash)$/.test(sub)) return "ブランチを操作する";
      return "git を操作する";
    case "npm":
    case "pnpm":
    case "yarn":
    case "bun":
    case "npx":
    case "bunx":
    case "pnpx": {
      const s = sub === "run" ? (seg[2] ?? "") : sub;
      if (s === "build") return "ビルドする";
      if (/^(test|vitest|jest)$/.test(s)) return "テストする";
      if (/^(dev|start)$/.test(s)) return "開発サーバーを起動する";
      if (/^(i|install|add|ci)$/.test(s)) return "パッケージを入れる";
      if (/^(lint|format)$/.test(s)) return "書き方をチェックする";
      if (verb === "bun" && isPathy(s)) return `${tail2(s)} を動かす`;
      return s === "" ? "スクリプトを動かす" : `${s} を動かす`;
    }
    case "tsc":
    case "vite":
    case "next":
    case "turbo":
      return sub === "dev" ? "開発サーバーを起動する" : "ビルドする";
    case "vitest":
    case "jest":
    case "pytest":
      return "テストする";
    case "claude":
      if (sub === "plugin" && seg[2] === "test") return "テストする";
      if (sub === "plugin" && seg[2] === "validate") return "プラグインを検証する";
      return "claude を動かす";
    case "mkdir":
      return "フォルダを作る";
    case "touch":
      return "ファイルを作る";
    case "mv":
      return "ファイルを移す";
    case "cp":
      return "ファイルを写す";
    case "rm":
    case "rmdir":
      return "ファイルを削除する";
    case "curl":
    case "wget":
      return "ネットから取ってくる";
    case "node":
    case "python":
    case "python3":
    case "deno":
    case "tsx":
    case "ruby":
    case "go": {
      const p = firstPath(seg);
      return p === null ? "スクリプトを動かす" : `${tail2(p)} を動かす`;
    }
    case "echo":
    case "printf":
      return "文字を出す";
    default:
      return `${verb} を実行する`;
  }
}

/** Bash の description（日本語の短い説明）を「○○する」の形に */
export function bashLabelFromDescription(description: string): string | null {
  const d = tidy(description).replace(/[。．.]+$/, "");
  if (d === "") return null;
  if (/する$/.test(d)) return d;
  if (/します$/.test(d)) return d.slice(0, -3) + "する";
  if (/を実行$/.test(d)) return d + "する";
  if (/[うくぐすつぬぶむる]$/.test(d)) return d; // 「探す」「見る」など辞書形で終わっている
  return d + "する";
}

// ---------- 道具ごとの実況 ----------

/** 「〜して」の形の動作と、その短い版から 3 段階（長・中・短）の文を組む */
function parts(stem: string, brief: string, purpose: string | null, note: string | null = null, done = `${stem}ます`): TamacodeLive {
  return { long: purpose === null ? null : `${stem}、${purpose}`, mid: done, brief, note };
}

const countLines = (s: unknown): number => (typeof s === "string" && s !== "" ? s.split("\n").length : 0);

/** Edit / Write の補足（+14行 / −3行 / 52行） */
export function editNote(tool: string, input: Record<string, unknown>): string | null {
  if (tool === "Write") {
    const n = countLines(input.content);
    return n === 0 ? null : `${n}行`;
  }
  let delta = 0;
  if (tool === "Edit") delta = countLines(input.new_string) - countLines(input.old_string);
  else if (tool === "MultiEdit" && Array.isArray(input.edits)) {
    for (const e of input.edits as Array<Record<string, unknown>>) delta += countLines(e.new_string) - countLines(e.old_string);
  } else return null;
  return delta > 0 ? `+${delta}行` : delta < 0 ? `−${-delta}行` : "±0行";
}

/** 道具が動き始めたときの実況 */
export function liveForTool(tool: string, input: Record<string, unknown>, purpose: string | null): TamacodeLive {
  switch (tool) {
    case "Read":
      return parts(`${tail2(input.file_path)} を読んで`, "ファイルを読んでます", purpose);
    case "Edit":
    case "MultiEdit":
      return parts(`${tail2(input.file_path)} を書き換えて`, "ファイルを書き換えてます", purpose, editNote(tool, input));
    case "Write":
      return parts(`${tail2(input.file_path)} を書いて`, "ファイルを書いてます", purpose, editNote(tool, input));
    case "NotebookEdit":
      return parts(`${tail2(input.notebook_path)} を書き換えて`, "ノートブックを書き換えてます", purpose);
    case "Grep": {
      const where = typeof input.path === "string" && input.path !== "" ? tail2(input.path) : "プロジェクト内";
      return parts(`「${cut(tidy(input.pattern), 24)}」という言葉を${where}から探して`, "文字列を探してます", purpose);
    }
    case "Glob":
      return parts(`「${cut(tidy(input.pattern), 24)}」という名前のファイルを探して`, "ファイルを探してます", purpose);
    case "Bash": {
      const fromDesc = typeof input.description === "string" ? bashLabelFromDescription(input.description) : null;
      const label = fromDesc ?? bashVerb(String(input.command ?? ""));
      return parts(`${label}コマンドを実行して`, "コマンドを実行中", purpose, null, `${label}コマンドを実行中`);
    }
    case "WebFetch":
      return parts(`${cut(tidy(input.url), 40)} を読んで`, "ネットで調べてます", purpose);
    case "WebSearch":
      return parts(`「${cut(tidy(input.query), 24)}」をネットで検索して`, "ネットで検索してます", purpose);
    case "Agent":
    case "Task":
      return parts(`「${cut(tidy(input.description), 24)}」を手伝いに任せて`, "手伝いに任せてます", purpose);
    case "Skill":
      return parts(`スキル「${cut(tidy(input.skill), 24)}」を使って`, "スキルを使ってます", purpose);
    case "TodoWrite":
      return parts("やることリストを更新して", "やることリストを更新してます", purpose);
    case "AskUserQuestion":
      return { long: null, mid: "質問の答えを待ってます", brief: "質問の答えを待ってます", note: null };
    case "EnterPlanMode":
    case "ExitPlanMode":
      return parts("作業の計画を立てて", "計画を立ててます", purpose);
    default:
      break;
  }
  const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool);
  if (m) return parts(`${m[1]} に「${cut(m[2]!, 24)}」を頼んで`, `${m[1]} に頼んでます`, purpose);
  return parts(`道具「${cut(tool, 24)}」を使って`, "道具を使ってます", purpose);
}

/** モデルが文字を出している最中の実況（考えてる／返事を書いてる） */
export function liveForWriting(kind: "thinking" | "text", opts: { touched: boolean; chars: number }): TamacodeLive {
  if (kind === "thinking") {
    return { long: null, mid: opts.touched ? "次の手を考えてます" : "次の手を考えてます。まだ何も触ってません", brief: "次の手を考えてます", note: null };
  }
  return { long: null, mid: "返事を書いてます", brief: "返事を書いてます", note: `↓${fmtChars(opts.chars)}` };
}

/** 道具の指示（引数）を書いている最中の実況 */
export function liveForPrep(tool: string, target: { file?: string; command?: string }): TamacodeLive {
  const file = target.file === undefined ? null : tail2(target.file);
  const one = (mid: string, brief = mid): TamacodeLive => ({ long: null, mid, brief, note: null });
  switch (tool) {
    case "":
      return one("次の作業を準備してます");
    case "Write":
      return one(file === null ? "ファイルを作る手順を書いてます" : `${file} を作る手順を書いてます`, "ファイルを作る手順を書いてます");
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return one(file === null ? "ファイルを書き換える手順を書いてます" : `${file} を書き換える手順を書いてます`, "ファイルを書き換える手順を書いてます");
    case "Bash":
      return one(target.command === undefined ? "コマンドを組み立ててます" : `コマンドを組み立ててます: ${cut(tidy(target.command), 40)}`, "コマンドを組み立ててます");
    case "Read":
      return one(file === null ? "読むファイルを決めてます" : `${file} を読む準備をしてます`, "読むファイルを決めてます");
    case "Grep":
    case "Glob":
      return one("探す条件を書いてます");
    case "Agent":
    case "Task":
      return one("手伝いへの指示を書いてます");
    case "AskUserQuestion":
      return one("質問を用意してます");
    default: {
      const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool);
      return one(m ? `${m[1]} への頼みごとを書いてます` : "次の作業を準備してます", "次の作業を準備してます");
    }
  }
}

/** 1 文だけの実況（次を考えてる／止めました／許可待ち など） */
export function liveOne(mid: string, brief = mid): TamacodeLive {
  return { long: null, mid, brief, note: null };
}

/** 道具もモデルの文字も無いとき（エンジンの mode から） */
export function liveFallback(mode: string): TamacodeLive {
  if (mode === "tool-use" || mode === "tool-input") return liveOne("道具を使ってます");
  if (mode === "responding") return liveOne("返事を書いてます");
  return liveOne("次の手を考えてます");
}

/** 猫・実況・経過時間を 1 行に。端末幅に収まるまで 目的 → 対象 の順に削る（猫・動作・時間は残す） */
export function composeLive(face: string, live: TamacodeLive, elapsedMs: number | null, columns: number): string {
  const budget = (columns > 0 ? columns : DEFAULT_COLUMNS) - ENGINE_RESERVE;
  const tailText = `${live.note === null ? "" : `（${live.note}）`}${elapsedMs === null ? "" : `（${fmtElapsed(elapsedMs)}）`}`;
  const candidates = [live.long, live.mid, live.brief].filter((c): c is string => c !== null && c !== "");
  const lines = candidates.map((c) => `${face} ${c}${tailText}`);
  return lines.find((l) => cells(l) <= budget) ?? lines[lines.length - 1] ?? face;
}
