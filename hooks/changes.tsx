// 変更履歴ペイン（/changes）
//
// Edit / Write / MultiEdit の tool.call を捕まえて、ファイル名と変更前後の文字を取り、
// 軽いモデル（haiku）に「プログラムを知らない人向け」の日本語2文要約を頼む。
// /changes で「たま」ペインの「変更」タブを開くと、新しい順に「時刻・ファイル名・要約・＋n行 −n行」が並ぶ（描画は pane.tsx）。
//
// 保存: 表示用は $.state（ホットリロードまで残る）、再起動対策は $.store（セッションをまたいで残る）。
// 起動時に $.store から読み戻して $.state に載せる。50件を超えたら古いものから消す。
// 要約の呼び出しが失敗しても、要約なし（ファイル名＋行数だけ）で止まらない。

import type { EngineInterface, Register } from "claude-code";
import { LOCALE_FILE, USER_LOCALE_FILE, applyLocale, markLocaleLoaded } from "./locale";

type Change = {
  id: string;
  at: number;
  tool: string;
  file: string;
  name: string;
  added: number;
  removed: number;
  diff: string;
  isTruncated: boolean;
  summary: string | null;
  isRisky: boolean;
};

type Op = { kind: " " | "+" | "-"; text: string };

// $.state の参照。plugin と key はリテラルでないと validate が読めない。
const CHANGES = { plugin: "tamacode", key: "changes" } as const;
const PANE_TAB = { plugin: "tamacode", key: "paneTab" } as const; // 「たま」ペインのタブ（描画は pane.tsx）

const PANE_ID = "tama";
const STORE_KEY = "changes";
const LIMIT = 50;
const MAX_DIFF_CHARS = 9000; // Code 部品の上限は 10000 文字
const MAX_LINE_CHARS = 300;
const MAX_LCS_CELLS = 1500 * 1500; // これより大きい差分は LCS を諦めて「全部消して全部足した」扱い
const CONTEXT_LINES = 3;
const SUMMARY_MODEL = "haiku";
const SUMMARY_DIFF_CHARS = 3000;
export const RISK_NOTE = "※壊れると困る所です。不安なら戻してと言ってください";
export const RISK_FACE = "(=｀･q･´=)ﾉ"; // 危ない操作の猫（activity.tsx の CAT.danger と同じ顔）

// 危険判定: パスと変更行（+/-）に対して当てる
export const RISK_PATH_RULES: RegExp[] = [/(^|[\\/])\.env(\.|$)/i, /(^|[\\/])migrations?([\\/]|$)/i];
export const RISK_TEXT_RULES: RegExp[] = [
  /\b(rm|rmdir|rimraf|unlink)\b/i,
  /\b(delete|remove|drop|destroy|truncate|purge)\b|削除/i,
  /\b(database|db|sql|prisma|supabase|migration|migrate|schema|mongo|postgres|mysql|sqlite)\b|データベース/i,
  /\b(auth|login|logout|signin|signup|session|password|passwd|token|jwt|oauth|credential|secret)\b|認証|ログイン/i,
  /\b(payment|billing|stripe|checkout|invoice|subscription|price|purchase|refund)\b|支払|決済|課金/i,
];

// ---------- 小さな道具 ----------

const basename = (p: string): string => {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1]! : String(p);
};

// Code 部品はタブと改行以外の制御文字を受け付けないので落とす
const clean = (s: string): string =>
  String(s ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");

const toLines = (s: string): string[] => {
  const t = s.endsWith("\n") ? s.slice(0, -1) : s;
  return t === "" ? [] : t.split("\n");
};

const cutLine = (s: string): string => (s.length > MAX_LINE_CHARS ? s.slice(0, MAX_LINE_CHARS - 1) + "…" : s);

// ---------- 行の差分 ----------

function diffLines(a: string[], b: string[]): Op[] {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const ops: Op[] = [];
  for (let i = 0; i < start; i++) ops.push({ kind: " ", text: a[i]! });

  const n = midA.length;
  const m = midB.length;
  if (n * m > MAX_LCS_CELLS) {
    for (const text of midA) ops.push({ kind: "-", text });
    for (const text of midB) ops.push({ kind: "+", text });
  } else {
    // LCS 表（後ろから）
    const rows: Uint32Array[] = [];
    for (let i = 0; i <= n; i++) rows.push(new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      const cur = rows[i]!;
      const below = rows[i + 1]!;
      for (let j = m - 1; j >= 0; j--) {
        cur[j] = midA[i] === midB[j] ? below[j + 1]! + 1 : Math.max(below[j]!, cur[j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push({ kind: " ", text: midA[i]! });
        i++;
        j++;
      } else if (rows[i + 1]![j]! >= rows[i]![j + 1]!) {
        ops.push({ kind: "-", text: midA[i]! });
        i++;
      } else {
        ops.push({ kind: "+", text: midB[j]! });
        j++;
      }
    }
    while (i < n) ops.push({ kind: "-", text: midA[i++]! });
    while (j < m) ops.push({ kind: "+", text: midB[j++]! });
  }

  for (let i = endA; i < a.length; i++) ops.push({ kind: " ", text: a[i]! });
  return ops;
}

// ops を unified diff のハンクにする。startLine は ops[0] の旧ファイル上の行番号（1始まり）。
// 文字数の上限を超えたら途中で切り、切った後の行数でヘッダを作り直す（Code 部品が拒否しないように）。
function toUnifiedDiff(ops: Op[], startLine: number): { diff: string; isTruncated: boolean } {
  const changed: number[] = [];
  ops.forEach((op, i) => {
    if (op.kind !== " ") changed.push(i);
  });
  if (changed.length === 0) return { diff: "", isTruncated: false };

  // 旧・新それぞれの行番号を各 op に振る
  const oldNo: number[] = [];
  const newNo: number[] = [];
  let o = startLine;
  let nn = startLine;
  for (const op of ops) {
    oldNo.push(o);
    newNo.push(nn);
    if (op.kind !== "+") o++;
    if (op.kind !== "-") nn++;
  }

  // 変更をグループ化（コンテキスト 3 行、間が空きすぎたら別ハンク）
  const groups: Array<[number, number]> = [];
  let first = changed[0]!;
  let last = changed[0]!;
  for (let k = 1; k < changed.length; k++) {
    const c = changed[k]!;
    if (c - last > CONTEXT_LINES * 2 + 1) {
      groups.push([first, last]);
      first = c;
    }
    last = c;
  }
  groups.push([first, last]);

  let out = "";
  let isTruncated = false;
  for (const [f, l] of groups) {
    const from = Math.max(0, f - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, l + CONTEXT_LINES);
    const body: string[] = [];
    let kept = from - 1;
    let size = 0;
    for (let k = from; k <= to; k++) {
      const line = `${ops[k]!.kind}${cutLine(ops[k]!.text)}\n`;
      if (out.length + size + line.length + 40 > MAX_DIFF_CHARS) {
        isTruncated = true;
        break;
      }
      body.push(line);
      size += line.length;
      kept = k;
    }
    if (body.length === 0) {
      isTruncated = true;
      break;
    }
    let oc = 0;
    let nc = 0;
    for (let k = from; k <= kept; k++) {
      if (ops[k]!.kind !== "+") oc++;
      if (ops[k]!.kind !== "-") nc++;
    }
    out += `@@ -${oldNo[from]},${oc} +${newNo[from]},${nc} @@\n${body.join("")}`;
    if (isTruncated) break;
  }
  return { diff: out, isTruncated };
}

// ---------- 変更の組み立て ----------

type EditSpec = { old_string: string; new_string: string; replace_all?: boolean };

function applyEdits(text: string, edits: EditSpec[]): string {
  let cur = text;
  for (const ed of edits) {
    const oldS = String(ed.old_string ?? "");
    const newS = String(ed.new_string ?? "");
    if (oldS === "") continue;
    cur = ed.replace_all ? cur.split(oldS).join(newS) : cur.replace(oldS, () => newS);
  }
  return cur;
}

function isRiskyChange(file: string, ops: Op[], added: number, removed: number): boolean {
  if (RISK_PATH_RULES.some((re) => re.test(file))) return true;
  if (removed >= 10 && added === 0) return true; // まとまった削除
  const changedText = ops
    .filter((op) => op.kind !== " ")
    .map((op) => op.text)
    .join("\n");
  const hay = `${basename(file)}\n${changedText}`;
  return RISK_TEXT_RULES.some((re) => re.test(hay));
}

function buildChange(args: { id: string; at: number; tool: string; file: string; before: string; after: string }): Change {
  const before = clean(args.before);
  const after = clean(args.after);
  const ops = diffLines(toLines(before), toLines(after));
  const added = ops.filter((op) => op.kind === "+").length;
  const removed = ops.filter((op) => op.kind === "-").length;
  const { diff, isTruncated } = toUnifiedDiff(ops, 1);
  return {
    id: args.id,
    at: args.at,
    tool: args.tool,
    file: args.file,
    name: basename(args.file),
    added,
    removed,
    diff,
    isTruncated,
    summary: null,
    isRisky: isRiskyChange(args.file, ops, added, removed),
  };
}

// ---------- 要約 ----------

function summaryPrompt(change: Change): string {
  const diff = change.diff.length > SUMMARY_DIFF_CHARS ? change.diff.slice(0, SUMMARY_DIFF_CHARS) + "\n…(以下省略)" : change.diff;
  return [
    "次のファイル変更を、プログラムを知らない人向けに、日本語で2文以内に要約してください。",
    "1文目は「何をしたか」、2文目は「それで何が変わるか」。",
    "専門用語は禁止です（関数・変数・クラス・API・インポート・コンポーネント・データベース・リクエストなどの言葉も使わず、身近な言葉で言い換える）。",
    "出力は要約の文だけ。前置き・見出し・記号・改行は不要です。",
    "",
    `ファイル名: ${change.name}`,
    `増えた行: ${change.added} / 減った行: ${change.removed}`,
    "変更内容（- が消した行、+ が足した行、それ以外は変わっていない行）:",
    diff === "" ? "（内容に変化なし）" : diff,
  ].join("\n");
}

function tidySummary(text: string): string | null {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  // 2文まで
  const parts = flat.split(/(?<=[。！？])/).filter((s) => s.trim() !== "");
  let out = parts.slice(0, 2).join("");
  if (out === "") out = flat;
  if (out.length > 140) out = out.slice(0, 139) + "…";
  return out;
}

// ---------- state と store ----------

type Dollar = EngineInterface;

async function readChanges($: Dollar): Promise<{ list: Change[]; version: number }> {
  const got = await $.state.get(CHANGES);
  return { list: Array.isArray(got.value) ? (got.value as Change[]) : [], version: got.version };
}

// 起動直後（まだ state に何もない）なら $.store から読み戻す
async function ensureLoaded($: Dollar): Promise<void> {
  const { version } = await readChanges($);
  if (version !== 0) return;
  let saved: unknown = undefined;
  try {
    saved = await $.store.get(STORE_KEY);
  } catch {
    saved = undefined;
  }
  const list = Array.isArray(saved) ? (saved as Change[]).slice(0, LIMIT) : [];
  await $.state.set(CHANGES, list, { ifVersion: 0 });
}

// state を読んで→直して→書く。間に誰かが書いていたらやり直す。store にも同じものを置く。
async function updateChanges($: Dollar, fn: (list: Change[]) => Change[]): Promise<Change[]> {
  await ensureLoaded($);
  let next: Change[] = [];
  for (let attempt = 0; attempt < 8; attempt++) {
    const { list, version } = await readChanges($);
    next = fn(list).slice(0, LIMIT);
    const r = await $.state.set(CHANGES, next, { ifVersion: version });
    if (r.isSet) break;
  }
  try {
    await $.store.set(STORE_KEY, next);
  } catch (err) {
    $.ui.log(`変更履歴の保存に失敗: ${String(err)}`, { to: "debug" });
  }
  return next;
}

async function summarize($: Dollar, change: Change): Promise<void> {
  let summary: string | null = null;
  try {
    const r = await $.model.complete({
      model: SUMMARY_MODEL,
      system: "あなたは、プログラムを知らない人に向けて、ファイルの変更をやさしい日本語で説明する係です。",
      prompt: summaryPrompt(change),
      effort: "low",
      maxTokens: 200,
      timeoutMs: 20000,
    });
    if (r.isAnswered) summary = tidySummary(r.text);
    else $.ui.log(`変更履歴の要約なし（${change.name}）: ${r.reason}`, { to: "debug" });
  } catch (err) {
    $.ui.log(`変更履歴の要約に失敗（${change.name}）: ${String(err)}`, { to: "debug" });
  }
  if (summary === null) return; // 要約なしのまま（ファイル名＋行数だけ表示）
  await updateChanges($, (list) => list.map((c) => (c.id === change.id ? { ...c, summary } : c)));
}

// ---------- 登録 ----------

// 文言ファイルを読んで上書きする（プラグインの場所の locales/ja.json → ~/.claude/tamacode-ja.json の順）
async function loadLocale($: Dollar): Promise<void> {
  // $.env.get は名前をリテラルで書く決まり（validate が読むため）
  const candidates: string[] = [];
  try {
    const root = await $.env.get("CLAUDE_PLUGIN_ROOT");
    if (root) candidates.push(`${root.replace(/[\\/]+$/, "")}/${LOCALE_FILE}`);
  } catch {
    // 無ければ飛ばす
  }
  try {
    const home = await $.env.get("HOME");
    if (home) candidates.push(`${home.replace(/[\\/]+$/, "")}/${USER_LOCALE_FILE}`);
  } catch {
    // 無ければ飛ばす
  }
  for (const path of candidates) {
    try {
      const n = applyLocale(await $.fs.read(path));
      if (n > 0) $.ui.log(`文言を読みました: ${path}（${n} 件）`, { to: "debug" });
    } catch {
      // ファイルが無いのはふつう
    }
  }
  markLocaleLoaded();
}

// 起動時: 文言を読み、store から読み戻し、/changes と /log を登録
async function onSessionStart($: Dollar): Promise<void> {
  await loadLocale($);
  try {
    await ensureLoaded($);
  } catch (err) {
    $.ui.log(`変更履歴の読み戻しに失敗: ${String(err)}`, { to: "debug" });
  }
  // /log（activity.tsx）もここで登録する。マッチャー無しの session.start は module 全体で 1 回しか持てないため。
  for (const cmd of [
    { name: "changes", description: "変更履歴ペインを開く（やさしい日本語の要約つき）" },
    { name: "log", description: "やったことの履歴ペインを開く（帯に出た一言の履歴）" },
  ]) {
    try {
      await $.command.register(cmd);
    } catch (err) {
      $.ui.log(`/${cmd.name} の登録に失敗: ${String(err)}`, { to: "debug" });
    }
  }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await onSessionStart($);
    return next(e);
  });

  // Edit / Write / MultiEdit を捕まえて記録する
  on("tool.call", { tool: ["Edit", "Write", "MultiEdit"] }, async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>;
    const file = String(input.file_path ?? "");
    if (file === "") return next(e);

    // 変更前の中身（読めなければ空＝新規扱い、Edit は old_string だけで組む）
    let before: string | null = null;
    try {
      before = await $.fs.read(file);
    } catch {
      before = null;
    }

    const result = await next(e);
    if (result.deny !== undefined || result.isError) return result;

    let oldText: string;
    let newText: string;
    if (e.tool === "Write") {
      oldText = before ?? "";
      newText = String(input.content ?? "");
    } else {
      const edits: EditSpec[] =
        e.tool === "MultiEdit" && Array.isArray(input.edits)
          ? (input.edits as EditSpec[])
          : [{ old_string: String(input.old_string ?? ""), new_string: String(input.new_string ?? ""), replace_all: Boolean(input.replace_all) }];
      if (before !== null && edits.every((ed) => before!.includes(String(ed.old_string ?? "")))) {
        oldText = before;
        newText = applyEdits(before, edits);
      } else {
        oldText = edits.map((ed) => String(ed.old_string ?? "")).join("\n");
        newText = edits.map((ed) => String(ed.new_string ?? "")).join("\n");
      }
    }

    const change = buildChange({
      id: crypto.randomUUID(),
      at: await $.clock.now(),
      tool: e.tool,
      file,
      before: oldText,
      after: newText,
    });
    await updateChanges($, (list) => [change, ...list]);
    // 要約は裏で。ツールの結果は待たせない。
    // このフックの dispatch が終わると途中の $ 呼び出しは打ち切られうるので、タイマーで別の dispatch に載せる。
    $.clock.after(0, () => {
      void summarize($, change);
    });
    return result;
  });

  // /changes: 「たま」ペインの「変更」タブを開く
  on("command.run", { command: "changes" }, async ($) => {
    await ensureLoaded($);
    const { list } = await readChanges($);
    await $.state.set(PANE_TAB, "changes");
    const opened = await $.ui.open({ id: PANE_ID, title: "たま", focus: true, closeOnEscape: true, columns: 64, rows: 24 });
    if (!opened.isPlaced) return { text: `📜 変更（${list.length}件）は待機中です: ${opened.reason}` };
    return { text: `📜 変更タブを開きました（${list.length}件）。Esc で閉じます` };
  });
};
