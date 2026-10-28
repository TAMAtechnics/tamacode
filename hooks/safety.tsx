// 【7】危険操作の前に自動バックアップ ＋ 見張り（止める／警告。判定は watch.ts）
//
// Edit / Write / MultiEdit / NotebookEdit / Bash が動く前に、対象が
// 「削除・データベース・認証・支払い・.env・rm・git push --force・migration」に当たるか判定する。
// 当たったら:
//   - ファイル系: そのファイルを .tama-backup/<日時>/<相対パス> にコピーしてから通す
//   - Bash: 対象ファイルが分からないので `git stash create` でスナップショットを取り、`git stash store` で残す
// 帯に「(=｀･q･´=)ﾉ 大事な所を触ります。念のため控えを取りました」と出す（notice state。activity.tsx が描く）。
// .tama-backup は .gitignore に足す。7 日より古い控えは最初の道具のときに消す。
// 控えの一覧は backups state（と $.store）に残し、/戻す（【6】）が使う。

import type { EngineInterface, Register } from "claude-code";
import type { TamacodeBackup, TamacodeFinding, TamacodeNotice, TamacodeWatchStats } from "../types/tamacode";
import { CAT, rel, short } from "./activity";
import { RISK_PATH_RULES, RISK_TEXT_RULES } from "./changes";
import { t } from "./locale";
import { countHighVulns, evaluateBash, evaluateWrite, isInstallCommand, weekStart, type Finding } from "./watch";

const NOTICE = { plugin: "tamacode", key: "notice" } as const;
const BACKUPS = { plugin: "tamacode", key: "backups" } as const;

export const BACKUP_DIR = ".tama-backup";
const STORE_KEY = "backups";
const KEEP_DAYS = 7;
const LIMIT = 100;

type Dollar = EngineInterface;

// ---------- 判定（純粋） ----------

const EXTRA_PATH_RULES: RegExp[] = [/(^|[\\/])migrations?([\\/]|$)/i, /(^|[\\/])(schema|seed)\.(prisma|sql)$/i, /(^|[\\/])\.env(\.|$)/i];

const BASH_RULES: RegExp[] = [
  /\b(rm|rmdir|rimraf|unlink|shred)\b/,
  /\bgit\s+push\b[^|;&]*(\s--force\b|\s-f\b|\s\+\S)/,
  /\bgit\s+(reset\s+--hard|checkout\s+--\s|clean\b|branch\s+-D|rebase|filter-branch|stash\s+drop|stash\s+clear)/,
  /\b(drop|truncate)\s+(table|database|schema)\b/i,
  /\bmigrat(e|ion|ions)\b|\bprisma\s+(db|migrate)\b|\bsupabase\s+db\b|\bknex\b.*migrate|\bdrizzle-kit\b/i,
  /\.env\b/,
  /\bsudo\b|\bkill(all)?\b|\bchmod\s+-R\b|\bchown\s+-R\b/,
  /\bgit\s+push\b/, // push 自体も「大事な所」（取り消しにくい）
];

/** Bash が危ない操作なら理由の鍵、そうでなければ null */
export function dangerOfBash(cmd: string): string | null {
  const c = String(cmd ?? "");
  return BASH_RULES.some((re) => re.test(c)) ? "backup.reason.bash" : null;
}

/** ファイル系の道具が危ない所を触るなら理由の鍵、そうでなければ null */
export function dangerOfFile(file: string, texts: string[]): string | null {
  const f = String(file ?? "");
  if (f === "") return null;
  if ([...RISK_PATH_RULES, ...EXTRA_PATH_RULES].some((re) => re.test(f))) return "backup.reason.path";
  // ファイル名（auth.ts など）と書き換える文字の両方を見る
  const hay = [f.split(/[\\/]/).pop() ?? "", ...texts.map((s) => String(s ?? ""))].join("\n");
  if (RISK_TEXT_RULES.some((re) => re.test(hay))) return "backup.reason.text";
  return null;
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** 控えのフォルダ名: 2026-10-29_153012（ローカル時刻） */
export function stamp(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

/** フォルダ名から時刻を読む。形が違えば null */
export function parseStamp(name: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})(\d{2})$/.exec(name);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
}

/** 控えの中でのパス。cwd の下なら相対、外なら _outside/ 以下に絶対パスを畳む */
export function backupRelPath(file: string, cwd: string | null): string {
  const base = (cwd ?? "").replace(/[\\/]+$/, "");
  if (base !== "" && file.startsWith(base + "/")) return file.slice(base.length + 1);
  if (file.startsWith("/")) return `_outside${file}`;
  return file.replace(/^(\.\/)+/, "");
}

const parentDir = (p: string): string => p.replace(/[\\/][^\\/]*$/, "");

// ---------- $ を使う処理 ----------

let cwd: string | null = null;
let hasEnsuredGitignore = false;
let hasCleaned = false;

async function getCwd($: Dollar): Promise<string | null> {
  if (cwd !== null) return cwd;
  try {
    cwd = await $.session.cwd();
  } catch {
    cwd = null;
  }
  return cwd;
}

async function writeFile($: Dollar, path: string, text: string): Promise<void> {
  await $.process.run(["mkdir", "-p", parentDir(path)]);
  await $.fs.write(path, text);
}

// .gitignore に .tama-backup/ を足す（無ければ作る）
async function ensureGitignore($: Dollar, base: string): Promise<void> {
  if (hasEnsuredGitignore) return;
  hasEnsuredGitignore = true;
  const path = `${base}/.gitignore`;
  let cur = "";
  try {
    cur = await $.fs.read(path);
  } catch {
    cur = "";
  }
  if (cur.split(/\r?\n/).some((l) => l.trim() === `${BACKUP_DIR}/` || l.trim() === BACKUP_DIR)) return;
  const sep = cur === "" || cur.endsWith("\n") ? "" : "\n";
  await $.fs.write(path, `${cur}${sep}\n# TAMACODE の自動バックアップ\n${BACKUP_DIR}/\n`);
}

// 7 日より古い控えを消す（フォルダ名の日時で判断。.tama-backup の直下だけ）
async function cleanupOld($: Dollar, base: string, now: number): Promise<void> {
  if (hasCleaned) return;
  hasCleaned = true;
  const dir = `${base}/${BACKUP_DIR}`;
  let entries: Array<{ name: string; kind: string }> = [];
  try {
    if (!(await $.fs.exists(dir))) return;
    entries = await $.fs.list(dir);
  } catch {
    return;
  }
  const limit = now - KEEP_DAYS * 24 * 60 * 60 * 1000;
  for (const en of entries) {
    if (en.kind !== "dir") continue;
    const at = parseStamp(en.name);
    if (at === null || at > limit) continue;
    const target = `${dir}/${en.name}`;
    try {
      await $.process.run(["rm", "-rf", target]);
      $.ui.log(t("backup.cleanup.log", { days: KEEP_DAYS, dir: `${BACKUP_DIR}/${en.name}` }), { to: "debug" });
    } catch (err) {
      $.ui.log(`控えの掃除に失敗（${target}）: ${String(err)}`, { to: "debug" });
    }
  }
}

async function readBackups($: Dollar): Promise<TamacodeBackup[]> {
  const got = await $.state.get(BACKUPS);
  if (Array.isArray(got.value)) return got.value as TamacodeBackup[];
  // 起動直後は store から読み戻す
  try {
    const saved = await $.store.get(STORE_KEY);
    return Array.isArray(saved) ? (saved as TamacodeBackup[]) : [];
  } catch {
    return [];
  }
}

async function recordBackup($: Dollar, b: TamacodeBackup): Promise<void> {
  const list = [b, ...(await readBackups($))].slice(0, LIMIT);
  await $.state.set(BACKUPS, list);
  try {
    await $.store.set(STORE_KEY, list);
  } catch (err) {
    $.ui.log(`控えの一覧の保存に失敗: ${String(err)}`, { to: "debug" });
  }
}

async function notify($: Dollar, text: string, at: number): Promise<void> {
  await $.state.set(NOTICE, { face: CAT.danger, text, at } satisfies TamacodeNotice);
}

type Target = { tool: string; reasonKey: string; file: string | null; command: string | null };

/** 控えを取る。/戻す（【6】）の実行前にも使う */
export async function takeBackup($: Dollar, target: Target): Promise<TamacodeBackup | null> {
  const base = await getCwd($);
  if (base === null) return null;
  const at = await $.clock.now();
  const name = stamp(at);
  const dir = `${base}/${BACKUP_DIR}/${name}`;
  const shown = `${BACKUP_DIR}/${name}`;
  const reason = t(target.reasonKey);
  const label = target.file !== null ? rel(target.file, base) : short(target.command ?? "", 60);

  await ensureGitignore($, base);
  await cleanupOld($, base, at);

  let backup: TamacodeBackup = { stamp: name, dir, kind: "none", files: [], stashSha: null, reason, tool: target.tool, target: label, at };
  try {
    if (target.file !== null) {
      let before: string | null = null;
      try {
        before = await $.fs.read(target.file);
      } catch {
        before = null; // まだ無いファイル（新規作成）。控える物が無い
      }
      if (before !== null) {
        const relPath = backupRelPath(target.file, base);
        await writeFile($, `${dir}/${relPath}`, before);
        backup = { ...backup, kind: "files", files: [relPath] };
      }
    } else {
      const created = await $.process.run(["git", "stash", "create"], { cwd: base });
      const sha = created.stdout.trim();
      if (created.exitCode !== 0) {
        backup = { ...backup, kind: "none" };
      } else if (sha !== "") {
        await $.process.run(["git", "stash", "store", "-m", `tama-backup ${name}: ${short(target.command ?? "", 60)}`, sha], { cwd: base });
        await writeFile($, `${dir}/git-stash.txt`, `${sha}\n${target.command ?? ""}\n`);
        backup = { ...backup, kind: "stash", stashSha: sha };
      } else {
        backup = { ...backup, kind: "stash", stashSha: null }; // 変更が無いので控える物も無い
      }
    }
    await writeFile($, `${dir}/memo.txt`, t("backup.memo", { when: name, reason, tool: target.tool, target: label }));
    await recordBackup($, backup);

    const key = backup.kind === "files" || (backup.kind === "stash" && backup.stashSha !== null) ? (backup.kind === "files" ? "backup.notice.files" : "backup.notice.stash") : backup.kind === "none" && target.file === null ? "backup.notice.nogit" : "backup.notice.files";
    await notify($, t(key, { dir: shown }), at);
    return backup;
  } catch (err) {
    $.ui.log(`控えに失敗: ${String(err)}`, { to: "debug" });
    await notify($, t("backup.notice.failed", { error: short(String(err), 60) }), at);
    return null;
  }
}

// ---------- 見張り（watch.ts の判定を道具の前後に当てる） ----------

const WATCH_BLOCK = { plugin: "tamacode", key: "watchBlock" } as const;
const WATCH_WARNINGS = { plugin: "tamacode", key: "watchWarnings" } as const;
const WATCH_SEEN = { plugin: "tamacode", key: "watchSeen" } as const;
const WATCH_ALLOW = { plugin: "tamacode", key: "watchAllow" } as const;
const WATCH_STATS = { plugin: "tamacode", key: "watchStats" } as const;
const STORE_SEEN = "watchSeen";
const STORE_STATS = "watchStats";
const WARNINGS_LIMIT = 10;

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

async function addSeen($: Dollar, sigs: string[]): Promise<void> {
  const list = Array.from(new Set([...(await readSeen($)), ...sigs])).slice(-500);
  await $.state.set(WATCH_SEEN, list);
  try {
    await $.store.set(STORE_SEEN, list);
  } catch (err) {
    $.ui.log(`見張りの記録の保存に失敗: ${String(err)}`, { to: "debug" });
  }
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
  if (!v || typeof v !== "object" || v.weekStart !== ws) return { weekStart: ws, blocked: 0, warned: 0 };
  return v;
}

async function bumpStats($: Dollar, kind: "blocked" | "warned", n: number, now: number): Promise<void> {
  const cur = await readStats($, now);
  const next = { ...cur, [kind]: cur[kind] + n };
  await $.state.set(WATCH_STATS, next);
  try {
    await $.store.set(STORE_STATS, next);
  } catch (err) {
    $.ui.log(`見張りの回数の保存に失敗: ${String(err)}`, { to: "debug" });
  }
}

async function pushWarnings($: Dollar, warns: Finding[], at: number): Promise<void> {
  const got = await $.state.get(WATCH_WARNINGS);
  const cur = Array.isArray(got.value) ? (got.value as TamacodeFinding[]) : [];
  await $.state.set(WATCH_WARNINGS, [...warns.map((w) => ({ ...w, at })), ...cur].slice(0, WARNINGS_LIMIT));
}

// install の後に npm audit を回し、high 以上があれば警告
async function auditAfterInstall($: Dollar, base: string, at: number): Promise<void> {
  try {
    const r = await $.process.run(["npm", "audit", "--json"], { cwd: base, timeoutMs: 60000 });
    const n = countHighVulns(r.stdout);
    if (n === null || n === 0) return;
    const f: Finding = { rule: "audit", kind: "warn", sig: `audit:${weekStart(at)}:${n}`, file: null, text: t("watch.audit.text", { n }), hint: t("watch.audit.hint"), fixPrompt: t("watch.audit.fix"), options: [] };
    const seen = await readSeen($);
    if (seen.includes(f.sig)) return;
    await pushWarnings($, [f], at);
    await bumpStats($, "warned", 1, at);
    await addSeen($, [f.sig]);
  } catch (err) {
    $.ui.log(`npm audit に失敗: ${String(err)}`, { to: "debug" });
  }
}

// ---------- 登録 ----------

export const register: Register = (on) => {
  on("tool.call", { tool: ["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"] }, async ($, e, next) => {
    const input = e as unknown as Record<string, unknown>;
    if (input.agentId !== undefined) return next(e);
    const base = await getCwd($);
    const at = await $.clock.now();

    // 見張り（止める／警告）と、控えの対象かの判定
    let target: Target | null = null;
    let findings: Finding[] = [];
    const cmd = e.tool === "Bash" ? String(input.command ?? "") : "";
    if (e.tool === "Bash") {
      findings = evaluateBash(cmd);
      const reasonKey = dangerOfBash(cmd);
      if (reasonKey !== null) target = { tool: e.tool, reasonKey, file: null, command: cmd };
    } else {
      const file = String(input.file_path ?? input.notebook_path ?? "");
      const texts: string[] = [];
      const written: string[] = [];
      for (const k of ["old_string", "new_string", "content", "new_source"]) if (typeof input[k] === "string") texts.push(input[k] as string);
      for (const k of ["new_string", "content", "new_source"]) if (typeof input[k] === "string") written.push(input[k] as string);
      if (Array.isArray(input.edits)) {
        for (const ed of input.edits as Array<Record<string, unknown>>) {
          texts.push(String(ed.old_string ?? ""), String(ed.new_string ?? ""));
          written.push(String(ed.new_string ?? ""));
        }
      }
      findings = file === "" ? [] : evaluateWrite(file, written, base);
      const reasonKey = dangerOfFile(file, texts);
      if (reasonKey !== null) target = { tool: e.tool, reasonKey, file, command: null };
    }

    // 【1】止める（「このまま通す」が押してあれば 1 回だけ通す）
    const allowGot = await $.state.get(WATCH_ALLOW);
    const allow = Array.isArray(allowGot.value) ? (allowGot.value as string[]) : [];
    const blocks = findings.filter((f) => f.kind === "block" && !allow.includes(f.sig));
    if (blocks.length > 0) {
      const b = blocks[0]!;
      await $.state.set(WATCH_BLOCK, { ...b, at } satisfies TamacodeFinding);
      await bumpStats($, "blocked", 1, at);
      return { deny: `${b.text}${b.hint === null ? "" : ` ${b.hint}`}${t("watch.deny.suffix")}` };
    }
    const used = findings.filter((f) => allow.includes(f.sig)).map((f) => f.sig);
    if (used.length > 0) await $.state.set(WATCH_ALLOW, allow.filter((s) => !used.includes(s)));

    // 【2】警告（同じ箇所は 1 回だけ）。通すので念のため控えも取る
    const seen = await readSeen($);
    const warns = findings.filter((f) => f.kind === "warn" && !seen.includes(f.sig));
    if (warns.length > 0) {
      await pushWarnings($, warns, at);
      await bumpStats($, "warned", warns.length, at);
      await addSeen($, warns.map((w) => w.sig));
      if (target === null) {
        const file = e.tool === "Bash" ? null : String(input.file_path ?? input.notebook_path ?? "");
        target = { tool: e.tool, reasonKey: "backup.reason.watch", file: file === "" ? null : file, command: e.tool === "Bash" ? cmd : null };
      }
    }

    if (target !== null) await takeBackup($, target);
    const result = await next(e);

    // install の後は npm audit
    if (e.tool === "Bash" && base !== null && isInstallCommand(cmd) && (result as { isError?: true }).isError !== true) {
      await auditAfterInstall($, base, at);
    }
    return result;
  });
};
