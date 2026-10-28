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
import type { TamacodeBackup, TamacodeFinding, TamacodeNotice, TamacodeRead, TamacodeRequest, TamacodeRestore, TamacodeTenken, TamacodeWatchStats, TamacodeWizardDraft } from "../types/tamacode";
import { CAT, isTurnRunningNow, rel, short } from "./activity";
import { t } from "./locale";
import { findSecrets, getRules, isExcludedPath, isScannableFile, scanFileText, weekStart, type Finding } from "./watch";

export const PANEL_ID = "panel";

// $.state の参照。plugin と key はリテラルでないと validate が読めない。
const PANEL_TAB = { plugin: "tamacode", key: "panelTab" } as const;
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
type PanelTab = "panel" | "onegai" | "yomu" | "modosu" | "tenken";

const TABS: Array<[PanelTab, string]> = [
  ["panel", "panel.tab.panel"],
  ["onegai", "panel.tab.onegai"],
  ["yomu", "panel.tab.yomu"],
  ["modosu", "panel.tab.modosu"],
  ["tenken", "panel.tab.tenken"],
];

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
  const got = await $.state.get(PANEL_TAB);
  const v = got.value;
  return v === "onegai" || v === "yomu" || v === "modosu" || v === "tenken" || v === "panel" ? v : "panel";
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
  await $.state.set(PANEL_TAB, tab);
  const opened = await $.ui.open({ id: PANEL_ID, title: t("panel.title"), focus: true, closeOnEscape: true, columns: 64, rows: 28 });
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

// ---------- 登録 ----------

export const register: Register = (on) => {
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

  on("ui.render", { component: "Pane", requestId: PANEL_ID }, async ($, e) => {
    // 入力欄（Input）と選択（Select）はスマホ画面には無い
    if (e.surface === "mobile") {
      const { Box, Text } = $.ui.resolve(e);
      return (
        <Box paddingX={1}>
          <Text dimColor>{t("panel.noMobile")}</Text>
        </Box>
      );
    }
    const { Box, Text, Button, Input, Select } = $.ui.resolve(e);
    const [tab, busy] = await Promise.all([readTab($), isBusy($)]);

    const tabs = (
      <Box>
        {TABS.map(([id, key], i) => (
          <Box>
            {i > 0 ? <Text dimColor>　</Text> : null}
            <Button
              plain
              key={`ptab:${id}`}
              label={id === tab ? `●${t(key)}` : `○${t(key)}`}
              onPress={() => {
                void $.state.set(PANEL_TAB, id);
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

    // ---------- 操作盤 ----------
    if (tab === "panel") {
      const actions: Array<[string, string, () => void]> = [
        ["act:onegai", "panel.btn.onegai", () => void $.state.set(PANEL_TAB, "onegai")],
        ["act:yomu", "panel.btn.yomu", () => void $.state.set(PANEL_TAB, "yomu")],
        [
          "act:modosu",
          "panel.btn.modosu",
          () => {
            void $.state.set(PANEL_TAB, "modosu");
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
            void $.state.set(PANEL_TAB, "tenken");
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
