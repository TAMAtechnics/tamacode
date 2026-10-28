// 操作盤ペイン（/panel）と、そこから使う機能
//   【2】もっと簡単に（/kantan）     : 今の説明を小学生向けに言い直してもらう
//   【3】読む（/yomu）               : 直近に触ったファイルを選ぶと、段落ごとのやさしい説明を頼む。結果は「読む」タブに残る
//   【1】おねがいウィザード（/onegai）: 何を／どこで／成功の条件 の 3 つを埋めて送る。直近 5 件は履歴から再利用
//   【6】戻すのプレビュー（/modosu） : git の履歴 10 件と控え（.tama-backup）から選び、「消えるもの」を見てから戻す
//   【8】おわり（/owari）            : 作業日誌とコミットと次回の下書きを頼み、終わったら帯を「今日はここまで」に
//   確認して（/kakunin）             : ビルドとテストを回して合格／不合格と原因一言
// Claude が作業中（isBusy）はボタンを押せない。入力途中や履歴は $.state（と $.store）に残す。
// コマンド名は英数字しか使えない（Claude Code の決まり）ので、ローマ字にしてある。

import type { EngineInterface, Register } from "claude-code";
import type { TamacodeBackup, TamacodeChange, TamacodeFinding, TamacodeLogEntry, TamacodeNotice, TamacodeRead, TamacodeRequest, TamacodeRestore, TamacodeServer, TamacodeTenken, TamacodeTerms, TamacodeWatchStats, TamacodeWizardDraft } from "../types/tamacode";
import { planDev, urlOf } from "./server";
import { CAT, isTurnRunningNow, rel, short } from "./activity";
import { RISK_FACE, RISK_NOTE } from "./changes";
import { USER_FILE, buildTerms, serializeUser, setUser, withKnown } from "./terms";
import { t } from "./locale";
import { findSecrets, getRules, isExcludedPath, isScannableFile, scanFileText, weekStart, type Finding } from "./watch";

export const PANE_ID = "tama";

// $.state の参照。plugin と key はリテラルでないと validate が読めない。
const PANE_TAB = { plugin: "tamacode", key: "paneTab" } as const;
const TAMA_OPEN = { plugin: "tamacode", key: "tamaOpen" } as const;
const BAND_ENABLED = { plugin: "tamacode", key: "bandEnabled" } as const;
const AUTO_OPEN = { plugin: "tamacode", key: "autoOpen" } as const;
const TERMS = { plugin: "tamacode", key: "terms" } as const;
const TERMS_OPEN = { plugin: "tamacode", key: "termsOpen" } as const;
const CHANGES = { plugin: "tamacode", key: "changes" } as const;
const OPEN_ID = { plugin: "tamacode", key: "openId" } as const;
const LOG = { plugin: "tamacode", key: "log" } as const;
const STORE_SETTINGS = "settings";
const CHANGES_LIMIT = 50;
const LOG_LIMIT = 200;
const NARROW_PANE_COLUMNS = 44; // これより狭いペインでは操作盤だけ
const NARROW_TERMINAL_COLUMNS = 110; // これより狭い端末では /tama が操作盤だけで開く
const BUSY = { plugin: "tamacode", key: "isBusy" } as const;
const NOTICE = { plugin: "tamacode", key: "notice" } as const;
const RECENT = { plugin: "tamacode", key: "recentFiles" } as const;
const READS = { plugin: "tamacode", key: "reads" } as const;
const READ_PENDING = { plugin: "tamacode", key: "readPending" } as const;
const END_PENDING = { plugin: "tamacode", key: "endPending" } as const;
const DRAFT = { plugin: "tamacode", key: "wizardDraft" } as const;
const DRAFT_ERROR = { plugin: "tamacode", key: "wizardError" } as const;
const REQUESTS = { plugin: "tamacode", key: "requests" } as const;
const RESTORE = { plugin: "tamacode", key: "restore" } as const;
const BACKUPS = { plugin: "tamacode", key: "backups" } as const;
const READ_OPEN = { plugin: "tamacode", key: "readOpen" } as const;
const TENKEN = { plugin: "tamacode", key: "tenken" } as const;
const SERVER = { plugin: "tamacode", key: "server" } as const;
const WATCH_SEEN = { plugin: "tamacode", key: "watchSeen" } as const;
const WATCH_STATS = { plugin: "tamacode", key: "watchStats" } as const;
const STORE_SEEN = "watchSeen";
const STORE_STATS = "watchStats";

const STORE_READS = "reads";
const STORE_REQUESTS = "requests";
const STORE_BACKUPS = "backups";
const REQUESTS_LIMIT = 5;
const READS_LIMIT = 20;
const GIT_LOG_LIMIT = 10;
const SUMMARY_MODEL = "haiku";

type Dollar = EngineInterface;
type PanelTab = "panel" | "terms" | "changes" | "yomu" | "onegai" | "modosu" | "tenken" | "log";

const TABS: Array<[PanelTab, string]> = [
  ["panel", "panel.tab.panel"],
  ["terms", "panel.tab.terms"],
  ["changes", "panel.tab.changes"],
  ["yomu", "panel.tab.yomu"],
  ["onegai", "panel.tab.onegai"],
  ["modosu", "panel.tab.modosu"],
  ["tenken", "panel.tab.tenken"],
  ["log", "panel.tab.log"],
];
const ALL_TABS: PanelTab[] = TABS.map(([id]) => id);

// ---------- 送る文（純粋） ----------

export const buildSimplePrompt = (): string => t("prompt.simple");
export const buildReadPrompt = (file: string): string => t("prompt.read", { file });
export const buildEndPrompt = (): string => t("prompt.end");
export const buildCheckPrompt = (): string => t("prompt.check");

export const EMPTY_DRAFT: TamacodeWizardDraft = { what: "", where: "", success: "" };

/** 空のままの欄 */
export function missingFields(d: TamacodeWizardDraft): Array<keyof TamacodeWizardDraft> {
  const out: Array<keyof TamacodeWizardDraft> = [];
  if (d.what.trim() === "") out.push("what");
  if (d.where.trim() === "") out.push("where");
  if (d.success.trim() === "") out.push("success");
  return out;
}

export function buildRequestPrompt(d: TamacodeWizardDraft): string {
  return t("prompt.request", { what: d.what.trim(), where: d.where.trim(), success: d.success.trim() });
}

/** `git log --oneline` の出力を読む */
export function parseGitLog(stdout: string): Array<{ sha: string; message: string }> {
  return String(stdout ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .map((l) => {
      const m = /^([0-9a-f]{6,40})\s+(.*)$/.exec(l);
      return m ? { sha: m[1]!, message: m[2]! } : null;
    })
    .filter((x): x is { sha: string; message: string } => x !== null);
}

// ---------- 小さな $ 付きの道具 ----------

// state の isBusy と、activity.tsx の中の値の両方が「作業中」のときだけ作業中とみなす
async function isBusy($: Dollar): Promise<boolean> {
  const got = await $.state.get(BUSY);
  return got.value === true && isTurnRunningNow();
}

async function readTab($: Dollar): Promise<PanelTab> {
  const got = await $.state.get(PANE_TAB);
  const v = got.value;
  return typeof v === "string" && (ALL_TABS as string[]).includes(v) ? (v as PanelTab) : "terms";
}

async function notify($: Dollar, face: string, text: string): Promise<void> {
  await $.state.set(NOTICE, { face, text, at: await $.clock.now() } satisfies TamacodeNotice);
}

// プロンプトを送る。送れたら true。
// ペインのボタンから（fromButton）のときだけ「作業中か」を見る。コマンド（/kantan など）は、
// 打った時点でターンは終わっている（作業中は順番待ちになる）ので見ない。
// ただしコマンドの処理の中から直接 prompt.submit は呼べない（そのコマンドが持っているターンを待ってしまう）ので、
// タイマーで次の瞬間に送る。
async function send($: Dollar, text: string, fromButton = false): Promise<boolean> {
  if (fromButton && (await isBusy($))) {
    await notify($, CAT.sleep, t("panel.busy"));
    return false;
  }
  const submit = async (): Promise<boolean> => {
    try {
      await $.prompt.submit({ text });
      return true;
    } catch (err) {
      $.ui.log(`送信に失敗: ${String(err)}`, { to: "debug" });
      await notify($, CAT.error, t("panel.sendFailed", { error: short(String(err), 60) }));
      return false;
    }
  };
  if (fromButton) return submit();
  $.clock.after(0, () => {
    void submit();
  });
  return true;
}

async function openPanel($: Dollar, tab: PanelTab): Promise<{ isPlaced: boolean; reason?: string }> {
  await $.state.set(PANE_TAB, tab);
  const opened = await $.ui.open({ id: PANE_ID, title: t("pane.title"), focus: true, closeOnEscape: true, columns: 64, rows: 28 });
  return opened.isPlaced ? { isPlaced: true } : { isPlaced: false, reason: opened.reason };
}

// state に無ければ store から読む（再起動しても残すため）。$.state の参照はリテラルで書く決まりなので、種類ごとに関数を分ける
async function readReads($: Dollar): Promise<TamacodeRead[]> {
  const got = await $.state.get(READS);
  if (Array.isArray(got.value)) return got.value as TamacodeRead[];
  try {
    const saved = await $.store.get(STORE_READS);
    return Array.isArray(saved) ? (saved as TamacodeRead[]) : [];
  } catch {
    return [];
  }
}

async function readRequests($: Dollar): Promise<TamacodeRequest[]> {
  const got = await $.state.get(REQUESTS);
  if (Array.isArray(got.value)) return got.value as TamacodeRequest[];
  try {
    const saved = await $.store.get(STORE_REQUESTS);
    return Array.isArray(saved) ? (saved as TamacodeRequest[]) : [];
  } catch {
    return [];
  }
}

async function writeRequests($: Dollar, list: TamacodeRequest[]): Promise<void> {
  await $.state.set(REQUESTS, list);
  try {
    await $.store.set(STORE_REQUESTS, list);
  } catch (err) {
    $.ui.log(`依頼の履歴の保存に失敗: ${String(err)}`, { to: "debug" });
  }
}

async function readBackups($: Dollar): Promise<TamacodeBackup[]> {
  const got = await $.state.get(BACKUPS);
  if (Array.isArray(got.value)) return got.value as TamacodeBackup[];
  try {
    const saved = await $.store.get(STORE_BACKUPS);
    return Array.isArray(saved) ? (saved as TamacodeBackup[]) : [];
  } catch {
    return [];
  }
}

async function readDraft($: Dollar): Promise<TamacodeWizardDraft> {
  const got = await $.state.get(DRAFT);
  const v = got.value as Partial<TamacodeWizardDraft> | null | undefined;
  return v && typeof v === "object" ? { what: String(v.what ?? ""), where: String(v.where ?? ""), success: String(v.success ?? "") } : { ...EMPTY_DRAFT };
}

const pad2 = (n: number): string => String(n).padStart(2, "0");
const hhmm = (ms: number): string => {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};

// 語を「知ってる」にする: 辞書を差し替え、ファイルに保存し、今の用語を拾い直す。
// （$.command.run で /terms know を呼ぶと自分のプラグインのフックは飛ばされて届かないので、ここで直接やる）
async function knowTerm($: Dollar, term: string): Promise<void> {
  const next = withKnown(term);
  setUser(next);
  let home: string | undefined;
  try {
    home = await $.env.get("HOME");
  } catch {
    home = undefined;
  }
  if (home) await $.fs.write(`${home.replace(/[\\/]+$/, "")}/${USER_FILE}`, serializeUser(next));
  const cur = await readTerms($);
  if (cur !== null) await $.state.set(TERMS, buildTerms(cur.answer, cur.outputs, await $.clock.now()));
}

async function readTerms($: Dollar): Promise<TamacodeTerms | null> {
  const got = await $.state.get(TERMS);
  const v = got.value as Partial<TamacodeTerms> | null | undefined;
  if (!v || typeof v !== "object" || !Array.isArray(v.found)) return null;
  return { at: v.at ?? 0, answer: v.answer ?? "", outputs: Array.isArray(v.outputs) ? v.outputs : [], found: v.found };
}

// ---------- 設定（起動時に自動で開くか。既定はオン） ----------

async function readAutoOpen($: Dollar): Promise<boolean> {
  const got = await $.state.get(AUTO_OPEN);
  if (typeof got.value === "boolean") return got.value;
  try {
    const saved = (await $.store.get(STORE_SETTINGS)) as { autoOpen?: boolean } | undefined;
    return saved?.autoOpen !== false;
  } catch {
    return true;
  }
}

async function setAutoOpen($: Dollar, on: boolean): Promise<void> {
  await $.state.set(AUTO_OPEN, on);
  try {
    const saved = ((await $.store.get(STORE_SETTINGS)) as Record<string, unknown> | undefined) ?? {};
    await $.store.set(STORE_SETTINGS, { ...saved, autoOpen: on });
  } catch (err) {
    $.ui.log(`設定の保存に失敗: ${String(err)}`, { to: "debug" });
  }
}

// ---------- 【1】おねがい ----------

async function sendRequest($: Dollar): Promise<void> {
  const d = await readDraft($);
  const missing = missingFields(d);
  if (missing.length > 0) {
    await $.state.set(DRAFT_ERROR, missing);
    return;
  }
  await $.state.set(DRAFT_ERROR, []);
  const text = buildRequestPrompt(d);
  if (!(await send($, text, true))) return;
  const list = await readRequests($);
  const next = [{ ...d, text, at: await $.clock.now() }, ...list.filter((r) => r.text !== text)].slice(0, REQUESTS_LIMIT);
  await writeRequests($, next);
  await $.state.set(DRAFT, { ...EMPTY_DRAFT });
}

// ---------- 【3】読む ----------

async function sendRead($: Dollar, file: string): Promise<void> {
  const cwd = await $.session.cwd().catch(() => null);
  const text = buildReadPrompt(rel(file, cwd));
  if (!(await send($, text, true))) return;
  await $.state.set(READ_PENDING, { file, at: await $.clock.now() });
}

// ---------- 【3'】点検（/tenken）: プロジェクト全体を見張りの規則で見る ----------

async function readSeen($: Dollar): Promise<string[]> {
  const got = await $.state.get(WATCH_SEEN);
  if (Array.isArray(got.value)) return got.value as string[];
  try {
    const saved = await $.store.get(STORE_SEEN);
    return Array.isArray(saved) ? (saved as string[]) : [];
  } catch {
    return [];
  }
}

async function markOk($: Dollar, sig: string): Promise<void> {
  const list = Array.from(new Set([...(await readSeen($)), sig])).slice(-500);
  await $.state.set(WATCH_SEEN, list);
  try {
    await $.store.set(STORE_SEEN, list);
  } catch (err) {
    $.ui.log(`「大丈夫」の保存に失敗: ${String(err)}`, { to: "debug" });
  }
  const cur = await readTenken($);
  if (cur !== null) await $.state.set(TENKEN, { ...cur, items: cur.items.filter((i) => i.sig !== sig) });
}

async function readStats($: Dollar, now: number): Promise<TamacodeWatchStats> {
  const got = await $.state.get(WATCH_STATS);
  let v = got.value as TamacodeWatchStats | null | undefined;
  if (!v || typeof v !== "object") {
    try {
      v = (await $.store.get(STORE_STATS)) as TamacodeWatchStats | undefined;
    } catch {
      v = undefined;
    }
  }
  const ws = weekStart(now);
  return v && typeof v === "object" && v.weekStart === ws ? v : { weekStart: ws, blocked: 0, warned: 0 };
}

async function readTenken($: Dollar): Promise<TamacodeTenken | null> {
  const got = await $.state.get(TENKEN);
  const v = got.value as TamacodeTenken | null | undefined;
  return v && typeof v === "object" && Array.isArray(v.items) ? v : null;
}

// フォルダを歩いてテキストのファイルを集める（対象外と大きすぎる物は飛ばす）
async function collectFiles($: Dollar, base: string): Promise<Array<{ path: string; size: number }>> {
  const rules = getRules();
  const out: Array<{ path: string; size: number }> = [];
  const queue: string[] = [base];
  while (queue.length > 0 && out.length < rules.scanMaxFiles) {
    const dir = queue.shift()!;
    let entries: Array<{ name: string; kind: string; size: number }> = [];
    try {
      entries = await $.fs.list(dir);
    } catch {
      continue;
    }
    for (const en of entries) {
      const full = `${dir}/${en.name}`;
      const relPath = full.slice(base.length + 1);
      if (en.kind === "dir") {
        if (en.name.startsWith(".") && en.name !== ".github") continue;
        if (!isExcludedPath(relPath + "/")) queue.push(full);
      } else if (en.kind === "file") {
        if (isExcludedPath(relPath) || !isScannableFile(en.name) || en.size > rules.scanMaxBytes) continue;
        out.push({ path: full, size: en.size });
        if (out.length >= rules.scanMaxFiles) break;
      }
    }
  }
  return out;
}

async function runTenken($: Dollar): Promise<void> {
  const at = await $.clock.now();
  const base = await $.session.cwd().catch(() => null);
  await $.state.set(TENKEN, { at, isRunning: true, files: 0, items: [], oks: [], isGit: false } satisfies TamacodeTenken);
  if (base === null) return;
  const seen = await readSeen($);
  const items: Finding[] = [];
  const oks: string[] = [];
  let count = 0;

  // ファイルを 1 つずつ
  const files = await collectFiles($, base);
  let hasSecret = false;
  for (const f of files) {
    let text: string;
    try {
      text = await $.fs.read(f.path);
    } catch {
      continue;
    }
    count++;
    for (const found of scanFileText(f.path, text, base)) {
      if (found.rule === "secret") hasSecret = true;
      if (!seen.includes(found.sig)) items.push(found);
    }
    if (count % 50 === 0) {
      await $.state.set(TENKEN, { at, isRunning: true, files: count, items: items.map((i) => ({ ...i, at })), oks, isGit: false });
      $.ui.invalidate("ui.render");
    }
  }
  if (!hasSecret) oks.push(t("tenken.ok.secrets"));

  // .gitignore に .env
  let gitignore = "";
  try {
    gitignore = await $.fs.read(`${base}/.gitignore`);
  } catch {
    gitignore = "";
  }
  if (gitignore.split(/\r?\n/).some((l) => /^\.env(\*|\.\*|$)/.test(l.trim()))) oks.push(t("tenken.ok.gitignore"));
  else if (!seen.includes("gitignore:.env")) items.push({ rule: "gitignore", kind: "warn", sig: "gitignore:.env", file: ".gitignore", text: t("watch.gitignore.text"), hint: null, fixPrompt: t("watch.gitignore.fix"), options: [] });

  // git の履歴に鍵が無いか（直近 200 コミットの差分）
  let isGit = false;
  try {
    const r = await $.process.run(["git", "log", "-p", "--all", "-n", "200", "--no-color"], { cwd: base, timeoutMs: 60000 });
    if (r.exitCode === 0) {
      isGit = true;
      const hits = findSecrets(r.stdout);
      if (hits.length === 0) oks.push(t("tenken.ok.history"));
      else if (!seen.includes("git-history")) items.push({ rule: "git-history", kind: "block", sig: "git-history", file: null, text: t("watch.history.text", { n: hits.length }), hint: t("watch.history.hint"), fixPrompt: t("watch.history.fix"), options: [] });
    }
  } catch (err) {
    $.ui.log(`git log に失敗: ${String(err)}`, { to: "debug" });
  }

  await $.state.set(TENKEN, { at, isRunning: false, files: count, items: items.map((i) => ({ ...i, at })), oks, isGit } satisfies TamacodeTenken);
  $.ui.invalidate("ui.render");
}

// ---------- 【6】戻す ----------

async function loadRestore($: Dollar): Promise<void> {
  const cwd = await $.session.cwd().catch(() => null);
  const candidates: TamacodeRestore["candidates"] = [];
  if (cwd !== null) {
    try {
      const r = await $.process.run(["git", "log", "--oneline", `-${GIT_LOG_LIMIT}`], { cwd, timeoutMs: 10000 });
      if (r.exitCode === 0) for (const c of parseGitLog(r.stdout)) candidates.push({ kind: "commit", id: c.sha, label: `${c.sha.slice(0, 7)} ${short(c.message, 50)}` });
    } catch (err) {
      $.ui.log(`git log に失敗: ${String(err)}`, { to: "debug" });
    }
  }
  const backups = await readBackups($);
  for (const b of backups) {
    if (b.kind === "none") continue;
    candidates.push({ kind: "backup", id: b.stamp, label: t("restore.backupLabel", { stamp: b.stamp.replace("_", " "), target: short(b.target, 30) }) });
  }
  await $.state.set(RESTORE, { candidates, selected: null, lines: null, isLoading: false } satisfies TamacodeRestore);
}

async function readRestore($: Dollar): Promise<TamacodeRestore> {
  const got = await $.state.get(RESTORE);
  const v = got.value as TamacodeRestore | null | undefined;
  return v && typeof v === "object" && Array.isArray(v.candidates) ? v : { candidates: [], selected: null, lines: null, isLoading: false };
}

// 「ここに戻すと消えるもの」を 3 行で（差分をモデルに要約させる。失敗したらファイル名の一覧）
async function previewRestore($: Dollar, id: string): Promise<void> {
  const cur = await readRestore($);
  const picked = cur.candidates.find((c) => c.id === id);
  if (picked === undefined) return;
  await $.state.set(RESTORE, { ...cur, selected: picked, lines: null, isLoading: true });
  const cwd = await $.session.cwd().catch(() => null);

  let detail = "";
  let fallback: string[] = [];
  if (picked.kind === "commit" && cwd !== null) {
    try {
      const names = await $.process.run(["git", "diff", "--name-status", picked.id], { cwd, timeoutMs: 10000 });
      const stat = await $.process.run(["git", "diff", "--stat", picked.id], { cwd, timeoutMs: 10000 });
      const files = names.stdout
        .split(/\r?\n/)
        .filter((l) => l.trim() !== "")
        .map((l) => l.split(/\t/).pop() ?? l);
      detail = `${names.stdout.slice(0, 3000)}\n${stat.stdout.slice(0, 2000)}`;
      fallback =
        files.length === 0
          ? [t("restore.noDiff")]
          : [t("restore.fallback.files", { files: files.slice(0, 5).join("、"), n: files.length }), t("restore.fallback.commit"), t("restore.fallback.keep")];
    } catch (err) {
      $.ui.log(`git diff に失敗: ${String(err)}`, { to: "debug" });
      fallback = [t("restore.fallback.unknown")];
    }
  } else {
    const backups = await readBackups($);
    const b = backups.find((x) => x.stamp === picked.id);
    const files = b?.files ?? [];
    detail = `控え: ${picked.id}\n理由: ${b?.reason ?? ""}\n対象: ${b?.target ?? ""}\nファイル:\n${files.join("\n")}${b?.kind === "stash" ? "\n（git stash のスナップショット）" : ""}`;
    fallback =
      b?.kind === "stash"
        ? [t("restore.fallback.stash"), t("restore.fallback.reason", { reason: b.reason }), t("restore.fallback.keep")]
        : [t("restore.fallback.files", { files: files.slice(0, 5).join("、"), n: files.length }), t("restore.fallback.reason", { reason: b?.reason ?? "" }), t("restore.fallback.keep")];
  }

  let lines: string[] = fallback;
  if (detail.trim() !== "") {
    try {
      const r = await $.model.complete({
        model: SUMMARY_MODEL,
        system: "あなたは、プログラムを知らない人に向けて、ファイルの変更をやさしい日本語で説明する係です。",
        prompt: [
          "作業中のフォルダを、下の状態に戻そうとしています。戻すと今の作業から消えるもの（失われる変更）を、日本語で 3 行以内で書いてください。",
          "ファイル名は出してよい。専門用語は括弧で一言説明。前置き・記号・空行は不要。消えるものが無ければ「消えるものはありません」と 1 行。",
          "",
          detail,
        ].join("\n"),
        effort: "low",
        maxTokens: 300,
        timeoutMs: 15000,
      });
      if (r.isAnswered) {
        const got = r.text
          .split(/\r?\n/)
          .map((l) => l.replace(/^[\s\-・*•#>]+/, "").trim())
          .filter((l) => l !== "")
          .slice(0, 3);
        if (got.length > 0) lines = got;
      }
    } catch (err) {
      $.ui.log(`戻すの要約に失敗: ${String(err)}`, { to: "debug" });
    }
  }
  const now = await readRestore($);
  if (now.selected?.id !== id) return;
  await $.state.set(RESTORE, { ...now, lines, isLoading: false });
  $.ui.invalidate("ui.render");
}

// 実行の前に、今の状態を git に控える（【7】と同じやり方。$ は跨げないのでここに持つ）
async function snapshot($: Dollar, cwd: string, label: string): Promise<void> {
  try {
    const created = await $.process.run(["git", "stash", "create"], { cwd, timeoutMs: 10000 });
    const sha = created.stdout.trim();
    if (created.exitCode === 0 && sha !== "") {
      await $.process.run(["git", "stash", "store", "-m", `tama-backup before-restore: ${label}`, sha], { cwd, timeoutMs: 10000 });
    }
  } catch (err) {
    $.ui.log(`戻す前の控えに失敗: ${String(err)}`, { to: "debug" });
  }
}

// 実行: 履歴は消さず、作業ツリーに差し戻す
async function runRestore($: Dollar): Promise<void> {
  const cur = await readRestore($);
  const picked = cur.selected;
  if (picked === null) return;
  const cwd = await $.session.cwd().catch(() => null);
  if (cwd === null) return;
  await snapshot($, cwd, picked.label);
  try {
    if (picked.kind === "commit") {
      const r = await $.process.run(["git", "restore", `--source=${picked.id}`, "--staged", "--worktree", "--", "."], { cwd, timeoutMs: 30000 });
      if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `exit ${r.exitCode}`);
    } else {
      const backups = await readBackups($);
      const b = backups.find((x) => x.stamp === picked.id);
      if (b === undefined) throw new Error("控えが見つかりません");
      if (b.kind === "stash" && b.stashSha !== null) {
        const r = await $.process.run(["git", "stash", "apply", b.stashSha], { cwd, timeoutMs: 30000 });
        if (r.exitCode !== 0) throw new Error(r.stderr.trim() || `exit ${r.exitCode}`);
      } else {
        for (const relPath of b.files) {
          const text = await $.fs.read(`${b.dir}/${relPath}`);
          const dest = relPath.startsWith("_outside/") ? `/${relPath.slice("_outside/".length)}` : `${cwd}/${relPath}`;
          await $.process.run(["mkdir", "-p", dest.replace(/[\\/][^\\/]*$/, "")]);
          await $.fs.write(dest, text);
        }
      }
    }
    await notify($, CAT.done, t("restore.done", { label: picked.label }));
    await $.state.set(RESTORE, { ...cur, selected: null, lines: null, isLoading: false });
  } catch (err) {
    await notify($, CAT.error, t("restore.failed", { error: short(String(err), 60) }));
  }
}


const SERVER_POLL_MS = 10_000; // 動いている間の確認間隔
const SERVER_STARTUP_POLL_MS = 1_000; // 起動待ちの確認間隔
const STARTUP_MAX_TRIES = 90; // 起動待ちは最長 90 秒

// ---------- 「ブラウザで見る」（/miru）: 動いていれば開く、無ければ起動して開く、動いている間は状態行を光らせる ----------

let poller: { cancel: () => void } | null = null;
let startupTries = 0;

async function readServer($: Dollar): Promise<TamacodeServer | null> {
  const got = await $.state.get(SERVER);
  const v = got.value as TamacodeServer | null | undefined;
  return v && typeof v === "object" && typeof v.port === "number" ? v : null;
}

// そのポートで何か答えるか（curl の HTTP コード。000 なら誰もいない）
async function isUp($: Dollar, port: number): Promise<boolean> {
  try {
    const r = await $.process.run(["curl", "-s", "-o", "/dev/null", "-m", "1", "-w", "%{http_code}", urlOf(port)], { timeoutMs: 3000 });
    const code = r.stdout.trim();
    return r.exitCode === 0 && code !== "" && code !== "000";
  } catch {
    return false;
  }
}

async function findUp($: Dollar, ports: number[]): Promise<number | null> {
  for (const p of ports) if (await isUp($, p)) return p;
  return null;
}

async function openBrowser($: Dollar, url: string): Promise<boolean> {
  for (const argv of [
    ["open", url],
    ["xdg-open", url],
    ["cmd", "/c", "start", "", url],
  ]) {
    try {
      const r = await $.process.run(argv, { timeoutMs: 5000 });
      if (r.exitCode === 0) return true;
    } catch {
      // 次の方法へ
    }
  }
  return false;
}

// 状態行の印
function light($: Dollar, server: TamacodeServer | null): void {
  if (server !== null && server.isUp) $.ui.status(t("server.status", { host: `localhost:${server.port}` }));
  else $.ui.status(undefined);
}

async function setServer($: Dollar, next: TamacodeServer | null): Promise<void> {
  await $.state.set(SERVER, next);
  light($, next);
  $.ui.invalidate("ui.render");
}

// 動いている間（と起動待ちの間）定期的に確かめる
function ensurePoller($: Dollar): void {
  if (poller !== null) return;
  poller = $.clock.every(SERVER_STARTUP_POLL_MS, () => {
    void tick($);
  });
}

let tickCount = 0;
async function tick($: Dollar): Promise<void> {
  const cur = await readServer($);
  if (cur === null) return;
  tickCount++;
  if (cur.isStarting) {
    startupTries++;
    const up = await isUp($, cur.port);
    if (up) {
      const next: TamacodeServer = { ...cur, isUp: true, isStarting: false, at: await $.clock.now() };
      await setServer($, next);
      const opened = await openBrowser($, urlOf(cur.port));
      await notify($, CAT.done, opened ? t("server.opened", { url: urlOf(cur.port) }) : t("server.upNoBrowser", { url: urlOf(cur.port) }));
    } else if (startupTries >= STARTUP_MAX_TRIES) {
      await setServer($, { ...cur, isStarting: false, isUp: false });
      await notify($, CAT.error, t("server.startTimeout", { command: cur.command ?? "" }));
    }
    return;
  }
  // 動いている間は 10 秒ごと（1 秒刻みの 10 回に 1 回）
  if (tickCount % Math.round(SERVER_POLL_MS / SERVER_STARTUP_POLL_MS) !== 0) return;
  const up = await isUp($, cur.port);
  if (up !== cur.isUp) await setServer($, { ...cur, isUp: up, at: await $.clock.now() });
}

/** 「ブラウザで見る」の本体。戻り値は人に見せる一言 */
async function viewInBrowser($: Dollar): Promise<string> {
  const base = await $.session.cwd().catch(() => null);
  let packageJson: string | null = null;
  let envText: string | null = null;
  const lockfiles: string[] = [];
  if (base !== null) {
    try {
      packageJson = await $.fs.read(`${base}/package.json`);
    } catch {
      packageJson = null;
    }
    try {
      envText = await $.fs.read(`${base}/.env`);
    } catch {
      envText = null;
    }
    for (const lf of ["pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "package-lock.json"]) {
      try {
        if (await $.fs.exists(`${base}/${lf}`)) lockfiles.push(lf);
      } catch {
        // 無視
      }
    }
  }
  const plan = planDev(packageJson, lockfiles, envText);

  // 1. もう動いている？
  const known = await readServer($);
  const ports = known !== null ? [known.port, ...plan.ports.filter((p) => p !== known.port)] : plan.ports;
  const upPort = await findUp($, ports);
  if (upPort !== null) {
    await setServer($, { port: upPort, url: urlOf(upPort), isUp: true, isStarting: false, command: plan.command, at: await $.clock.now() });
    ensurePoller($);
    const opened = await openBrowser($, urlOf(upPort));
    const text = opened ? t("server.opened", { url: urlOf(upPort) }) : t("server.upNoBrowser", { url: urlOf(upPort) });
    await notify($, CAT.done, text);
    return text;
  }

  // 2. 起動方法が分からない → Claude に頼む文を次の瞬間に送る
  if (plan.command === null) {
    const text = t("server.unknown");
    await notify($, CAT.think, text);
    $.clock.after(0, () => {
      void $.prompt.submit({ text: t("prompt.startServer") }).catch((err) => $.ui.log(`送信に失敗: ${String(err)}`, { to: "debug" }));
    });
    return text;
  }

  // 3. 起動して、立ち上がりを待って開く
  const port = plan.ports[0] ?? 3000;
  await setServer($, { port, url: urlOf(port), isUp: false, isStarting: true, command: plan.command, at: await $.clock.now() });
  startupTries = 0;
  ensurePoller($);
  try {
    await $.tool.call({ tool: "Bash", command: plan.command, run_in_background: true, description: t("server.toolDescription") } as never);
  } catch (err) {
    $.ui.log(`開発サーバーの起動に失敗: ${String(err)}`, { to: "debug" });
    await setServer($, null);
    const text = t("server.startFailed", { error: short(String(err), 60) });
    await notify($, CAT.error, text);
    return text;
  }
  const text = t("server.starting", { command: plan.command, url: urlOf(port) });
  await notify($, CAT.web, text);
  return text;
}


// ---------- 登録 ----------

export const register: Register = (on) => {
  on("command.run", { command: "miru" }, async ($) => ({ text: await viewInBrowser($) }));

  // Claude が自分で開発サーバーを起動したときも、光る印を出す
  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const result = await next(e);
    const cmd = String((e as unknown as { command?: string }).command ?? "");
    if ((e as unknown as { agentId?: string }).agentId === undefined && /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)\b|\b(next|vite|astro|nuxt)\s+dev\b|\bnpx\s+(next|vite|astro)\b/.test(cmd)) {
      const cur = await readServer($);
      if (cur === null || !cur.isUp) {
        const base = await $.session.cwd().catch(() => null);
        let pkg: string | null = null;
        try {
          pkg = base === null ? null : await $.fs.read(`${base}/package.json`);
        } catch {
          pkg = null;
        }
        const plan = planDev(pkg, [], null);
        const port = plan.ports[0] ?? 3000;
        await setServer($, { port, url: urlOf(port), isUp: false, isStarting: true, command: cmd, at: await $.clock.now() });
        startupTries = 0;
        ensurePoller($);
      }
    }
    return result;
  });

  // /tama: 帯オン＋ペインを開く。もう一度で全部閉じる。/tama auto on|off で起動時に自動で開くか
  on("command.run", { command: "tama" }, async ($, e) => {
    const arg = String(e.args ?? "").trim();
    if (/^auto\b/.test(arg)) {
      const word = arg.replace(/^auto\s*/, "").trim().toLowerCase();
      if (word !== "on" && word !== "off") {
        const cur = await readAutoOpen($);
        return { text: t("tama.auto.usage", { state: cur ? "on" : "off" }) };
      }
      await setAutoOpen($, word === "on");
      return { text: word === "on" ? t("tama.auto.on") : t("tama.auto.off") };
    }
    let isOpen = false;
    try {
      isOpen = (await $.ui.panes()).some((p) => p.id === PANE_ID && p.isShown);
    } catch {
      isOpen = (await $.state.get(TAMA_OPEN)).value === true;
    }
    if (isOpen) {
      await $.ui.close({ id: PANE_ID });
      await Promise.all([$.state.set(TAMA_OPEN, false), $.state.set(BAND_ENABLED, false)]);
      return { text: t("tama.closed") };
    }
    const narrow = e.presentation.columns < NARROW_TERMINAL_COLUMNS;
    await Promise.all([$.state.set(BAND_ENABLED, true), $.state.set(PANE_TAB, narrow ? "panel" : "terms")]);
    const opened = await $.ui.open({ id: PANE_ID, title: t("pane.title"), focus: true, closeOnEscape: true, columns: narrow ? 48 : 64, rows: 28 });
    await $.state.set(TAMA_OPEN, true);
    $.ui.invalidate("ui.render");
    return { text: opened.isPlaced ? t("tama.opened") : t("tama.waiting", { reason: opened.reason }) };
  });

  on("command.run", { command: "panel" }, async ($) => {
    const r = await openPanel($, "panel");
    return { text: r.isPlaced ? t("panel.opened") : t("panel.waiting", { reason: r.reason ?? "" }) };
  });

  // 【2】もっと簡単に
  on("command.run", { command: "kantan" }, async ($) => {
    return { text: (await send($, buildSimplePrompt())) ? t("simple.sent") : t("panel.sendFailed", { error: "" }) };
  });

  // 【3】読む
  on("command.run", { command: "yomu" }, async ($) => {
    const r = await openPanel($, "yomu");
    return { text: r.isPlaced ? t("read.opened") : t("panel.waiting", { reason: r.reason ?? "" }) };
  });

  // 【1】おねがい
  on("command.run", { command: "onegai" }, async ($) => {
    const r = await openPanel($, "onegai");
    return { text: r.isPlaced ? t("wizard.opened") : t("panel.waiting", { reason: r.reason ?? "" }) };
  });

  // 【6】戻す
  on("command.run", { command: "modosu" }, async ($) => {
    await loadRestore($);
    const r = await openPanel($, "modosu");
    return { text: r.isPlaced ? t("restore.opened") : t("panel.waiting", { reason: r.reason ?? "" }) };
  });

  // 【8】おわり
  on("command.run", { command: "owari" }, async ($) => {
    if (!(await send($, buildEndPrompt()))) return { text: t("panel.sendFailed", { error: "" }) };
    await $.state.set(END_PENDING, true);
    return { text: t("end.sent") };
  });

  // 点検
  on("command.run", { command: "tenken" }, async ($) => {
    const r = await openPanel($, "tenken");
    $.clock.after(0, () => {
      void runTenken($);
    });
    return { text: r.isPlaced ? t("tenken.opened") : t("panel.waiting", { reason: r.reason ?? "" }) };
  });

  // 確認して
  on("command.run", { command: "kakunin" }, async ($) => {
    return { text: (await send($, buildCheckPrompt())) ? t("check.sent") : t("panel.sendFailed", { error: "" }) };
  });

  on("ui.render", { component: "Pane", requestId: PANE_ID }, async ($, e) => {
    // 入力欄（Input）と選択（Select）はスマホ画面には無い
    if (e.surface === "mobile") {
      const { Box, Text } = $.ui.resolve(e);
      return (
        <Box paddingX={1}>
          <Text dimColor>{t("panel.noMobile")}</Text>
        </Box>
      );
    }
    const { Box, Text, Button, Input, Select, Code } = $.ui.resolve(e);
    const narrow = e.props.bodyColumns < NARROW_PANE_COLUMNS; // 狭いときは操作盤だけ（タブも隠す）
    const [storedTab, busy] = await Promise.all([readTab($), isBusy($)]);
    const tab: PanelTab = narrow ? "panel" : storedTab;

    // タブは幅に合わせて折り返す（1 行に収まらないと文字が重なって見えるため、各タブを 1 つの箱にして flexWrap）
    const tabs = narrow ? null : (
      <Box flexWrap="wrap" columnGap={1}>
        {TABS.map(([id, key]) => (
          <Box>
            <Button
              plain
              key={`ptab:${id}`}
              label={id === tab ? `●${t(key)}` : `○${t(key)}`}
              onPress={() => {
                void $.state.set(PANE_TAB, id);
                if (id === "modosu") void loadRestore($);
              }}
            />
          </Box>
        ))}
      </Box>
    );
    const busyNote = busy ? (
      <Box marginTop={1}>
        <Text color="yellow">
          {CAT.sleep} {t("panel.busy")}
        </Text>
      </Box>
    ) : null;

    // ---------- 用語 ----------
    if (tab === "terms") {
      const [cur, openGot] = await Promise.all([readTerms($), $.state.get(TERMS_OPEN)]);
      const found = cur?.found ?? [];
      const isOpen = openGot.value === true;
      return (
        <Box flexDirection="column" paddingX={1}>
          {tabs}
          <Box marginTop={1}>
            <Text bold>📘 用語（新しい語が上）　</Text>
            {found.length > 0 ? (
              <Button
                plain
                key="terms:toggle"
                label={isOpen ? "説明をたたむ" : "説明を開く"}
                onPress={() => {
                  void $.state.set(TERMS_OPEN, !isOpen);
                }}
              />
            ) : null}
          </Box>
          <Text dimColor>語を押すと「知ってる」になり次から出ません。＊はツールの出力から、†は自分の辞書</Text>
          <Box>
            {busy ? (
              <Text dimColor>{t("panel.btn.kantan")}（{t("panel.busy")}）</Text>
            ) : (
              <Button
                key="terms:kantan"
                label={t("panel.btn.kantan")}
                onPress={() => {
                  void send($, buildSimplePrompt(), true);
                }}
              />
            )}
          </Box>
          {cur === null ? (
            <Box marginTop={1}>
              <Text dimColor>{CAT.sleep} Claude の返事やツールのエラーが出ると、ここに専門用語が並びます。</Text>
            </Box>
          ) : found.length === 0 ? (
            <Box marginTop={1}>
              <Text dimColor>この返事に、辞書にある専門用語はありませんでした。</Text>
            </Box>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              {found.map((t) => (
                <Box flexDirection="column">
                  <Box>
                    <Button
                      plain
                      key={`know:${t.term}`}
                      label={t.term}
                      onPress={() => {
                        void knowTerm($, t.term).catch((err) => {
                          $.ui.log(`「知ってる」に失敗（${t.term}）: ${String(err)}`, { to: "debug" });
                        });
                      }}
                    />
                    {t.from === "tool" ? <Text dimColor>＊</Text> : null}
                    {t.isUser ? <Text dimColor>†</Text> : null}
                    {!isOpen ? (
                      <Text dimColor wrap="truncate-end">
                        　{t.meaning}
                      </Text>
                    ) : null}
                  </Box>
                  {isOpen ? (
                    <Box paddingLeft={2}>
                      <Text wrap="wrap">{t.meaning}</Text>
                    </Box>
                  ) : null}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      );
    }

    // ---------- 変更 ----------
    if (tab === "changes") {
      const [cGot, oGot] = await Promise.all([$.state.get(CHANGES), $.state.get(OPEN_ID)]);
      const list = Array.isArray(cGot.value) ? (cGot.value as TamacodeChange[]) : [];
      const openId = typeof oGot.value === "string" ? oGot.value : null;
      return (
        <Box flexDirection="column" paddingX={1}>
          {tabs}
          <Box marginTop={1}>
            <Text bold>📜 変更（新しい順・最大{CHANGES_LIMIT}件）</Text>
          </Box>
          <Text dimColor>押すと元の差分を開閉。{RISK_FACE} は壊れると困る所</Text>
          {list.length === 0 ? (
            <Box marginTop={1}>
              <Text dimColor>{CAT.sleep} まだ変更はありません。</Text>
            </Box>
          ) : (
            list.map((c) => {
              const isOpen = openId === c.id;
              const label = `${c.isRisky ? `${RISK_FACE} ` : ""}${isOpen ? "▾" : "▸"} ${hhmm(c.at)}  ${c.name}  +${c.added}行 −${c.removed}行`;
              const summary = c.summary === null ? (c.isRisky ? RISK_NOTE : "") : `${c.summary}${c.isRisky ? ` ${RISK_NOTE}` : ""}`;
              return (
                <Box flexDirection="column" marginTop={1}>
                  <Button
                    plain
                    key={`row:${c.id}`}
                    label={label}
                    onPress={() => {
                      void $.state.set(OPEN_ID, isOpen ? null : c.id);
                    }}
                  />
                  {summary !== "" ? (
                    <Box paddingLeft={2}>
                      <Text wrap="wrap">{summary}</Text>
                    </Box>
                  ) : null}
                  {isOpen ? (
                    <Box flexDirection="column" paddingLeft={2} marginTop={1}>
                      {c.diff === "" ? <Text dimColor>（中身に変化はありませんでした）</Text> : <Code source={c.diff} format="diff" path={c.file} />}
                      {c.isTruncated ? <Text dimColor>…長いので途中まで表示しています</Text> : null}
                    </Box>
                  ) : null}
                </Box>
              );
            })
          )}
        </Box>
      );
    }

    // ---------- やったこと ----------
    if (tab === "log") {
    const lGot = await $.state.get(LOG);
    const log = Array.isArray(lGot.value) ? (lGot.value as TamacodeLogEntry[]) : [];
    return (
      <Box flexDirection="column" paddingX={1}>
        {tabs}
        <Box marginTop={1}>
          <Text bold>{CAT.idle} やったこと（新しい順・最大{LOG_LIMIT}件）</Text>
        </Box>
        <Text dimColor>同じことが続いたときは ×n にまとめています</Text>
        {log.length === 0 ? (
          <Box marginTop={1}>
            <Text dimColor>{CAT.sleep} まだ何もしていません。</Text>
          </Box>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {log.map((l) => (
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
    }

    // ---------- 操作盤 ----------
    if (tab === "panel") {
      const server = ((await $.state.get(SERVER)).value as TamacodeServer | null | undefined) ?? null;
      const actions: Array<[string, string, () => void]> = [
        [
          "act:miru",
          "panel.btn.miru",
          () => {
            void viewInBrowser($).catch((err) => $.ui.log(`ブラウザで見るに失敗: ${String(err)}`, { to: "debug" }));
          },
        ],
        ["act:onegai", "panel.btn.onegai", () => void $.state.set(PANE_TAB, "onegai")],
        ["act:yomu", "panel.btn.yomu", () => void $.state.set(PANE_TAB, "yomu")],
        [
          "act:modosu",
          "panel.btn.modosu",
          () => {
            void $.state.set(PANE_TAB, "modosu");
            void loadRestore($);
          },
        ],
        [
          "act:owari",
          "panel.btn.owari",
          () => {
            void (async () => {
              if (await send($, buildEndPrompt(), true)) await $.state.set(END_PENDING, true);
            })();
          },
        ],
        [
          "act:tenken",
          "tenken.btn",
          () => {
            void $.state.set(PANE_TAB, "tenken");
            void runTenken($);
          },
        ],
        ["act:kantan", "panel.btn.kantan", () => void send($, buildSimplePrompt(), true)],
        ["act:kakunin", "panel.btn.kakunin", () => void send($, buildCheckPrompt(), true)],
      ];
      return (
        <Box flexDirection="column" paddingX={1}>
          {tabs}
          <Box marginTop={1}>
            <Text bold>
              {CAT.idle} {t("panel.heading")}
            </Text>
          </Box>
          <Text dimColor>{t("panel.hint")}</Text>
          {server !== null && (server.isUp || server.isStarting) ? (
            <Box marginTop={1}>
              <Text color="green" bold>
                {server.isUp ? t("server.panel.up", { url: server.url }) : t("server.panel.starting", { url: server.url })}
              </Text>
            </Box>
          ) : null}
          {busyNote}
          <Box flexDirection="column" marginTop={1}>
            {actions.map(([key, labelKey, onPress]) =>
              busy ? (
                <Text dimColor>　{t(labelKey)}</Text>
              ) : (
                <Box>
                  <Button key={key} label={t(labelKey)} onPress={onPress} />
                </Box>
              ),
            )}
          </Box>
        </Box>
      );
    }

    // ---------- おねがい ----------
    if (tab === "onegai") {
      const [draft, errGot, history] = await Promise.all([readDraft($), $.state.get(DRAFT_ERROR), readRequests($)]);
      const missing = Array.isArray(errGot.value) ? (errGot.value as string[]) : [];
      const field = (key: keyof TamacodeWizardDraft, labelKey: string, placeholderKey: string) => (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>{t(labelKey)}</Text>
          <Input
            key={`onegai:${key}`}
            value={draft[key]}
            placeholder={t(placeholderKey)}
            submitLabel={t("wizard.next")}
            onInput={(value) => {
              void (async () => {
                const d = await readDraft($);
                await $.state.set(DRAFT, { ...d, [key]: value });
              })();
            }}
            onSubmit={(value) => {
              void (async () => {
                const d = await readDraft($);
                await $.state.set(DRAFT, { ...d, [key]: value });
              })();
            }}
          />
          {missing.includes(key) ? <Text color="red">{t("wizard.fill")}</Text> : null}
        </Box>
      );
      return (
        <Box flexDirection="column" paddingX={1}>
          {tabs}
          <Box marginTop={1}>
            <Text bold>
              {CAT.idle} {t("wizard.heading")}
            </Text>
          </Box>
          <Text dimColor>{t("wizard.hint")}</Text>
          {busyNote}
          {field("what", "wizard.what", "wizard.what.placeholder")}
          {field("where", "wizard.where", "wizard.where.placeholder")}
          {field("success", "wizard.success", "wizard.success.placeholder")}
          <Box marginTop={1}>
            {busy ? (
              <Text dimColor>　{t("wizard.send")}</Text>
            ) : (
              <Button
                key="onegai:send"
                variant="primary"
                label={t("wizard.send")}
                onPress={() => {
                  void sendRequest($);
                }}
              />
            )}
          </Box>
          {history.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>{t("wizard.history")}</Text>
              {history.map((r, i) => (
                <Box>
                  <Button
                    plain
                    key={`onegai:reuse:${i}`}
                    label={`▸ ${short(r.what, 40)}`}
                    onPress={() => {
                      void $.state.set(DRAFT, { what: r.what, where: r.where, success: r.success });
                      void $.state.set(DRAFT_ERROR, []);
                    }}
                  />
                  <Text dimColor>　{t("wizard.reuseHint")}</Text>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      );
    }

    // ---------- 読む ----------
    if (tab === "yomu") {
      const cwd = await $.session.cwd().catch(() => null);
      const [recentGot, reads, openGot] = await Promise.all([$.state.get(RECENT), readReads($), $.state.get(READ_OPEN)]);
      const recent = Array.isArray(recentGot.value) ? (recentGot.value as string[]) : [];
      const openAt = typeof openGot.value === "number" ? openGot.value : null;
      return (
        <Box flexDirection="column" paddingX={1}>
          {tabs}
          <Box marginTop={1}>
            <Text bold>
              {CAT.read} {t("read.heading")}
            </Text>
          </Box>
          <Text dimColor>{t("read.hint")}</Text>
          {busyNote}
          {recent.length === 0 ? (
            <Box marginTop={1}>
              <Text dimColor>{t("read.noRecent")}</Text>
            </Box>
          ) : busy ? null : (
            <Box marginTop={1}>
              <Select
                key="yomu:file"
                label={t("read.pick")}
                options={recent.map((f) => ({ value: f, label: rel(f, cwd) }))}
                onSelect={(value) => {
                  void sendRead($, value);
                }}
              />
            </Box>
          )}
          {reads.length > 0 ? (
            <Box flexDirection="column" marginTop={1}>
              <Text bold>{t("read.saved")}</Text>
              {reads.map((r) => (
                <Box flexDirection="column">
                  <Button
                    plain
                    key={`yomu:open:${r.at}`}
                    label={`${openAt === r.at ? "▾" : "▸"} ${rel(r.file, cwd)}`}
                    onPress={() => {
                      void $.state.set(READ_OPEN, openAt === r.at ? null : r.at);
                    }}
                  />
                  {openAt === r.at ? (
                    <Box paddingLeft={2}>
                      <Text wrap="wrap">{r.answer}</Text>
                    </Box>
                  ) : null}
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      );
    }

    // ---------- 点検 ----------
    if (tab === "tenken") {
      const now = await $.clock.now();
      const [res, stats] = await Promise.all([readTenken($), readStats($, now)]);
      const reds = res?.items.filter((i) => i.kind === "block") ?? [];
      const yellows = res?.items.filter((i) => i.kind === "warn") ?? [];
      const row = (i: TamacodeFinding, color: "red" | "yellow") => (
        <Box flexDirection="column" marginTop={1}>
          <Text color={color} wrap="wrap">
            {color === "red" ? CAT.stopped : CAT.danger} {i.text}
          </Text>
          {i.hint !== null ? <Text dimColor wrap="wrap">　{i.hint}</Text> : null}
          <Box>
            <Text>　</Text>
            {!busy && i.fixPrompt !== null ? (
              <Button
                key={`tenken:fix:${i.sig}`}
                variant="primary"
                label={t("watch.btn.fixIt")}
                onPress={() => {
                  void send($, i.fixPrompt ?? "", true);
                }}
              />
            ) : null}
            <Text>　</Text>
            <Button
              key={`tenken:ok:${i.sig}`}
              label={t("watch.btn.ok")}
              onPress={() => {
                void markOk($, i.sig);
              }}
            />
          </Box>
        </Box>
      );
      return (
        <Box flexDirection="column" paddingX={1}>
          {tabs}
          <Box marginTop={1}>
            <Text bold>
              {CAT.read} {t("tenken.heading")}
            </Text>
          </Box>
          <Text>{t("tenken.stats", { blocked: stats.blocked, warned: stats.warned })}</Text>
          <Text dimColor>{t("tenken.hint")}</Text>
          {busyNote}
          {res === null ? (
            <Box marginTop={1}>
              <Button
                key="tenken:run"
                label={t("tenken.btn")}
                onPress={() => {
                  void runTenken($);
                }}
              />
            </Box>
          ) : res.isRunning ? (
            <Box marginTop={1}>
              <Text dimColor>{t("tenken.running", { n: res.files })}</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              {reds.length === 0 && yellows.length === 0 ? (
                <Box marginTop={1}>
                  <Text color="green" bold>
                    {CAT.done} {t("tenken.allGreen")}
                  </Text>
                </Box>
              ) : null}
              {reds.length > 0 ? (
                <Box marginTop={1}>
                  <Text color="red" bold>
                    {t("tenken.red")}（{reds.length}）
                  </Text>
                </Box>
              ) : null}
              {reds.map((i) => row(i, "red"))}
              {yellows.length > 0 ? (
                <Box marginTop={1}>
                  <Text color="yellow" bold>
                    {t("tenken.yellow")}（{yellows.length}）
                  </Text>
                </Box>
              ) : null}
              {yellows.map((i) => row(i, "yellow"))}
              {res.oks.length > 0 ? (
                <Box flexDirection="column" marginTop={1}>
                  <Text color="green" bold>
                    {t("tenken.green")}（{res.oks.length}）
                  </Text>
                  {res.oks.map((o) => (
                    <Text color="green">　{o}</Text>
                  ))}
                </Box>
              ) : null}
              {!res.isGit ? <Text dimColor>{t("tenken.notGit")}</Text> : null}
              <Box marginTop={1}>
                <Button
                  key="tenken:rerun"
                  label={t("tenken.rerun")}
                  onPress={() => {
                    void runTenken($);
                  }}
                />
              </Box>
            </Box>
          )}
        </Box>
      );
    }

    // ---------- 戻す ----------
    const restore = await readRestore($);
    return (
      <Box flexDirection="column" paddingX={1}>
        {tabs}
        <Box marginTop={1}>
          <Text bold>
            {CAT.idle} {t("restore.heading")}
          </Text>
        </Box>
        <Text dimColor>{t("restore.hint")}</Text>
        {busyNote}
        {restore.candidates.length === 0 ? (
          <Box marginTop={1}>
            <Text dimColor>{t("restore.none")}</Text>
          </Box>
        ) : busy ? null : (
          <Box marginTop={1}>
            <Select
              key="modosu:pick"
              label={t("restore.pick")}
              options={restore.candidates.map((c) => ({ value: c.id, label: c.label }))}
              value={restore.selected?.id}
              onSelect={(value) => {
                void previewRestore($, value);
              }}
            />
          </Box>
        )}
        {restore.selected !== null ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>{t("restore.willLose", { label: restore.selected.label })}</Text>
            {restore.isLoading ? <Text dimColor>{t("restore.loading")}</Text> : null}
            {(restore.lines ?? []).map((l) => (
              <Text wrap="wrap">　{l}</Text>
            ))}
            {!restore.isLoading && restore.lines !== null && !busy ? (
              <Box marginTop={1}>
                <Button
                  key="modosu:run"
                  variant="primary"
                  label={t("restore.run")}
                  onPress={() => {
                    void runRestore($);
                  }}
                />
                <Text>　</Text>
                <Button
                  key="modosu:cancel"
                  label={t("restore.cancel")}
                  onPress={() => {
                    void $.state.set(RESTORE, { ...restore, selected: null, lines: null, isLoading: false });
                  }}
                />
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>
    );
  });
};
