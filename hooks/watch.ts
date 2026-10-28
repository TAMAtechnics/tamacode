// 見張り（純粋な部分）。AI は使わず、文字列のパターン照合だけ。
//
// ルールは rules/security.json（初期値は hooks/rules.defaults.ts に生成）。applyRules() で上書きできる。
// 【1】止める: 秘密の鍵の直書き / 秘密のファイルの git add・commit・push / service_role を画面側へ / 公開リポジトリ作成 / 本番への破壊操作
// 【2】警告:   RLS 無しの create table / 本人確認の無い API 入口・use server / 無防備な管理画面 / ログに個人情報 /（install 後の npm audit は safety.tsx）
// 【3】点検:   上の全部をプロジェクト全体に（scanFileText）。
// $ は使わない。呼ぶのは safety.tsx（道具の前後）と panel.tsx（/tenken）。

import { t } from "./locale";
import { RULES_DEFAULTS } from "./rules.defaults";

export type Rules = {
  exclude: string[];
  excludeFiles: string[];
  secretPatterns: string[];
  secretAllowContext: string[];
  secretFiles: string[];
  secretFilesExcept: string[];
  clientDirs: string[];
  serviceRoleWords: string[];
  publicRepoPatterns: string[];
  prodMarkers: string[];
  prodProjectIds: string[];
  destructivePatterns: string[];
  migrationsDirs: string[];
  apiRoutePattern: string;
  serverActionMarker: string;
  adminPattern: string;
  authWords: string[];
  logPattern: string;
  piiWords: string[];
  installPatterns: string[];
  scanMaxFiles: number;
  scanMaxBytes: number;
  scanTextExtensions: string[];
};

let rules: Rules = RULES_DEFAULTS as unknown as Rules;

export const getRules = (): Rules => rules;

/** rules/security.json の中身で上書きする。読めた項目数を返す（壊れていれば 0） */
export function applyRules(jsonText: string): number {
  let got: unknown;
  try {
    got = JSON.parse(jsonText);
  } catch {
    return 0;
  }
  if (!got || typeof got !== "object") return 0;
  const next: Record<string, unknown> = { ...(rules as unknown as Record<string, unknown>) };
  let n = 0;
  for (const [k, v] of Object.entries(got as Record<string, unknown>)) {
    if (k.startsWith("_")) continue;
    if (k in (RULES_DEFAULTS as Record<string, unknown>)) {
      next[k] = v;
      n++;
    }
  }
  rules = next as unknown as Rules;
  return n;
}

export function resetRules(): void {
  rules = RULES_DEFAULTS as unknown as Rules;
}

// ---------- 道具 ----------

const re = (src: string, flags = "i"): RegExp | null => {
  try {
    return new RegExp(src, flags);
  } catch {
    return null;
  }
};
const anyMatch = (patterns: string[], text: string, flags = "i"): boolean => patterns.some((p) => re(p, flags)?.test(text) === true);
const basename = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

/** 対象外のパスか（tests/ docs/ node_modules/ .tama-backup/ .env.example など） */
export function isExcludedPath(path: string): boolean {
  const p = path.replace(/\\/g, "/");
  const slashed = p.endsWith("/") ? p : p + "/";
  if (rules.exclude.some((d) => slashed.includes(`/${d}`) || slashed.startsWith(d))) return true;
  return rules.excludeFiles.includes(basename(p));
}

const relOf = (path: string, cwd: string | null): string => {
  const p = path.replace(/\\/g, "/");
  const base = (cwd ?? "").replace(/[\\/]+$/, "");
  return base !== "" && p.startsWith(base + "/") ? p.slice(base.length + 1) : p;
};

export type Finding = {
  /** ルール名（secret / secret-file / service-role / public-repo / prod-destroy / rls / api-auth / admin-auth / pii-log / audit / gitignore / git-history） */
  rule: string;
  /** 止める（block）か警告（warn）か */
  kind: "block" | "warn";
  /** 同じ箇所を見分ける鍵（再表示を 1 回にする） */
  sig: string;
  /** 対象ファイル（相対）。無ければ null */
  file: string | null;
  /** 帯や点検に出す文（日本語） */
  text: string;
  /** 代案や注意（日本語）。無ければ null */
  hint: string | null;
  /** 「直して」で Claude に送る文。無ければ null */
  fixPrompt: string | null;
  /** 止めたときの選択肢（ボタンの文言と動き） */
  options: Array<{ key: string; label: string; action: "fix" | "allow" | "cancel" }>;
};

const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;

// ---------- 【1】止める ----------

/** 秘密の鍵らしい文字列（process.env や例示の近くにある物は除く） */
export function findSecrets(text: string): Array<{ match: string; line: number }> {
  const out: Array<{ match: string; line: number }> = [];
  for (const p of rules.secretPatterns) {
    const r = re(p, "g");
    if (!r) continue;
    for (const m of text.matchAll(r)) {
      const idx = m.index ?? 0;
      const lineStart = text.lastIndexOf("\n", idx) + 1;
      const lineEnd = text.indexOf("\n", idx);
      const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
      if (anyMatch(rules.secretAllowContext, line, "")) continue;
      out.push({ match: m[0], line: lineOf(text, idx) });
    }
  }
  return out;
}

const mask = (s: string): string => (s.length <= 8 ? "****" : `${s.slice(0, 4)}…${s.slice(-2)}`);

/** 秘密のファイルか（.env .env.* *.pem *.key credentials.json。.env.example は除く） */
export function isSecretFile(path: string): boolean {
  const name = basename(path.replace(/\\/g, "/"));
  if (anyMatch(rules.secretFilesExcept, name, "")) return false;
  return anyMatch(rules.secretFiles, name, "");
}

/** git add / commit / push の対象に秘密のファイルがあれば、その名前 */
export function secretFilesInGitCommand(cmd: string): string[] {
  const out: string[] = [];
  for (const seg of String(cmd ?? "").split(/&&|\|\||;|\|/)) {
    const tokens = seg.trim().split(/\s+/);
    const gi = tokens.indexOf("git");
    if (gi === -1 || !/^(add|commit|push)$/.test(tokens[gi + 1] ?? "")) continue;
    for (const tok of tokens.slice(gi + 2)) {
      const clean = tok.replace(/^["']|["']$/g, "");
      if (clean.startsWith("-")) continue;
      if (isSecretFile(clean) && !out.includes(clean)) out.push(clean);
    }
  }
  return out;
}

/** 画面側（app/ components/ pages/ public/）のファイルか */
export function isClientSide(path: string, cwd: string | null): boolean {
  const r = relOf(path, cwd);
  return rules.clientDirs.some((d) => r.startsWith(d) || r.includes(`/${d}`));
}

export const hasServiceRole = (text: string): boolean => rules.serviceRoleWords.some((w) => text.includes(w));

/** 公開リポジトリを作る／公開先を足すコマンドか */
export const isPublicRepoCommand = (cmd: string): boolean => anyMatch(rules.publicRepoPatterns, cmd);

/** 本番に対する破壊操作か（本番の印と壊す動詞が同じコマンドにある） */
export function isProdDestructive(cmd: string): boolean {
  const c = String(cmd ?? "");
  const isProd = anyMatch(rules.prodMarkers, c) || rules.prodProjectIds.some((id) => id !== "" && c.includes(id));
  return isProd && anyMatch(rules.destructivePatterns, c);
}

// ---------- 【2】警告 ----------

/** migrations の create table に、同じテーブルの enable row level security が無い */
export function tablesWithoutRls(sql: string): string[] {
  const out: string[] = [];
  const created = [...sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:"?[\w]+"?\.)?"?([\w]+)"?/gi)].map((m) => m[1]!);
  for (const table of created) {
    const rls = new RegExp(`alter\\s+table\\s+(?:only\\s+)?(?:"?[\\w]+"?\\.)?"?${table}"?\\s+enable\\s+row\\s+level\\s+security`, "i");
    if (!rls.test(sql) && !out.includes(table)) out.push(table);
  }
  return out;
}

export const isMigrationFile = (path: string, cwd: string | null): boolean => {
  const r = relOf(path, cwd);
  return /\.sql$/i.test(r) && rules.migrationsDirs.some((d) => r.startsWith(d) || r.includes(`/${d}`));
};

export const isApiRoute = (path: string, cwd: string | null): boolean => re(rules.apiRoutePattern, "i")?.test(relOf(path, cwd)) === true;
export const isServerAction = (text: string): boolean => re(rules.serverActionMarker, "i")?.test(text.slice(0, 500)) === true;
export const isAdminPath = (path: string, cwd: string | null): boolean => re(rules.adminPattern, "i")?.test(relOf(path, cwd)) === true;
export const hasAuthWord = (text: string): boolean => rules.authWords.some((w) => new RegExp(`\\b${w}\\b`).test(text) || text.includes(w));

/** console.log / logger に個人情報らしい変数が入っている行 */
export function piiLogLines(text: string): Array<{ line: number; word: string }> {
  const out: Array<{ line: number; word: string }> = [];
  const logRe = re(rules.logPattern, "i");
  if (!logRe) return out;
  text.split("\n").forEach((l, i) => {
    if (!logRe.test(l)) return;
    const word = rules.piiWords.find((w) => new RegExp(`\\b${w}\\b`, "i").test(l));
    if (word !== undefined) out.push({ line: i + 1, word });
  });
  return out;
}

export const isInstallCommand = (cmd: string): boolean => anyMatch(rules.installPatterns, cmd);

// ---------- まとめて判定 ----------

const blockOptions = (fixLabelKey: string, allowLabelKey: string | null): Finding["options"] => {
  const out: Finding["options"] = [{ key: "fix", label: t(fixLabelKey), action: "fix" }];
  if (allowLabelKey !== null) out.push({ key: "allow", label: t(allowLabelKey), action: "allow" });
  out.push({ key: "cancel", label: t("watch.btn.cancel"), action: "cancel" });
  return out;
};

/** ファイルを書く道具（Edit / Write / MultiEdit）の判定。texts は書き込まれる文字（new_string / content） */
export function evaluateWrite(path: string, texts: string[], cwd: string | null): Finding[] {
  if (isExcludedPath(relOf(path, cwd))) return [];
  const file = relOf(path, cwd);
  const body = texts.join("\n");
  const out: Finding[] = [];

  const secrets = findSecrets(body);
  if (secrets.length > 0 && !isSecretFile(path)) {
    out.push({
      rule: "secret",
      kind: "block",
      sig: `secret:${file}:${mask(secrets[0]!.match)}`,
      file,
      text: t("watch.secret.text"),
      hint: t("watch.secret.hint", { sample: mask(secrets[0]!.match) }),
      fixPrompt: t("watch.secret.fix", { file }),
      options: blockOptions("watch.btn.yes", "watch.btn.passAnyway"),
    });
  }
  if (isClientSide(path, cwd) && hasServiceRole(body)) {
    out.push({
      rule: "service-role",
      kind: "block",
      sig: `service-role:${file}`,
      file,
      text: t("watch.serviceRole.text"),
      hint: t("watch.serviceRole.hint"),
      fixPrompt: t("watch.serviceRole.fix", { file }),
      options: blockOptions("watch.btn.fix", null),
    });
  }
  if (out.length > 0) return out;

  // 警告
  if (isMigrationFile(path, cwd)) {
    for (const table of tablesWithoutRls(body)) {
      out.push({ rule: "rls", kind: "warn", sig: `rls:${file}:${table}`, file, text: t("watch.rls.text", { table }), hint: t("watch.rls.hint"), fixPrompt: t("watch.rls.fix", { file, table }), options: [] });
    }
  }
  if ((isApiRoute(path, cwd) || isServerAction(body)) && body.trim() !== "" && !hasAuthWord(body)) {
    out.push({ rule: "api-auth", kind: "warn", sig: `api-auth:${file}`, file, text: t("watch.apiAuth.text"), hint: t("watch.apiAuth.hint"), fixPrompt: t("watch.apiAuth.fix", { file }), options: [] });
  }
  if (isAdminPath(path, cwd) && /\.(tsx?|jsx?|vue|svelte)$/i.test(file) && body.trim() !== "" && !hasAuthWord(body)) {
    out.push({ rule: "admin-auth", kind: "warn", sig: `admin-auth:${file}`, file, text: t("watch.adminAuth.text"), hint: t("watch.adminAuth.hint"), fixPrompt: t("watch.adminAuth.fix", { file }), options: [] });
  }
  for (const hit of piiLogLines(body)) {
    out.push({ rule: "pii-log", kind: "warn", sig: `pii-log:${file}:${hit.word}`, file, text: t("watch.piiLog.text", { word: hit.word }), hint: t("watch.piiLog.hint"), fixPrompt: t("watch.piiLog.fix", { file, word: hit.word }), options: [] });
  }
  return out;
}

/** Bash の判定 */
export function evaluateBash(cmd: string): Finding[] {
  const out: Finding[] = [];
  const files = secretFilesInGitCommand(cmd);
  if (files.length > 0) {
    out.push({
      rule: "secret-file",
      kind: "block",
      sig: `secret-file:${files.join(",")}`,
      file: files[0]!,
      text: t("watch.secretFile.text", { files: files.join("、") }),
      hint: t("watch.secretFile.hint"),
      fixPrompt: t("watch.secretFile.fix", { files: files.join("、") }),
      options: blockOptions("watch.btn.exclude", null),
    });
  }
  if (isProdDestructive(cmd)) {
    out.push({ rule: "prod-destroy", kind: "block", sig: `prod-destroy:${cmd.slice(0, 60)}`, file: null, text: t("watch.prodDestroy.text"), hint: t("watch.prodDestroy.hint"), fixPrompt: null, options: [{ key: "cancel", label: t("watch.btn.cancel"), action: "cancel" }] });
  }
  if (isPublicRepoCommand(cmd)) {
    out.push({
      rule: "public-repo",
      kind: "block",
      sig: `public-repo:${cmd.slice(0, 60)}`,
      file: null,
      text: t("watch.publicRepo.text"),
      hint: t("watch.publicRepo.hint"),
      fixPrompt: t("watch.publicRepo.fix"),
      options: blockOptions("watch.btn.makePrivate", "watch.btn.publicOk"),
    });
  }
  return out;
}

/** 点検用: ファイル 1 つの中身を全部の規則で見る（止める系も「赤」として出す） */
export function scanFileText(path: string, text: string, cwd: string | null): Finding[] {
  const file = relOf(path, cwd);
  if (isExcludedPath(file)) return [];
  const out: Finding[] = [];
  if (!isSecretFile(path)) {
    for (const s of findSecrets(text).slice(0, 3)) {
      out.push({ rule: "secret", kind: "block", sig: `secret:${file}:${mask(s.match)}`, file, text: t("watch.secret.scan", { file, line: s.line }), hint: t("watch.secret.hint", { sample: mask(s.match) }), fixPrompt: t("watch.secret.fix", { file }), options: [] });
    }
  }
  if (isClientSide(path, cwd) && hasServiceRole(text)) {
    out.push({ rule: "service-role", kind: "block", sig: `service-role:${file}`, file, text: t("watch.serviceRole.scan", { file }), hint: t("watch.serviceRole.hint"), fixPrompt: t("watch.serviceRole.fix", { file }), options: [] });
  }
  if (isMigrationFile(path, cwd)) {
    for (const table of tablesWithoutRls(text)) {
      out.push({ rule: "rls", kind: "warn", sig: `rls:${file}:${table}`, file, text: t("watch.rls.scan", { file, table }), hint: t("watch.rls.hint"), fixPrompt: t("watch.rls.fix", { file, table }), options: [] });
    }
  }
  if ((isApiRoute(path, cwd) || isServerAction(text)) && !hasAuthWord(text)) {
    out.push({ rule: "api-auth", kind: "warn", sig: `api-auth:${file}`, file, text: t("watch.apiAuth.scan", { file }), hint: t("watch.apiAuth.hint"), fixPrompt: t("watch.apiAuth.fix", { file }), options: [] });
  }
  if (isAdminPath(path, cwd) && /\.(tsx?|jsx?|vue|svelte)$/i.test(file) && !hasAuthWord(text)) {
    out.push({ rule: "admin-auth", kind: "warn", sig: `admin-auth:${file}`, file, text: t("watch.adminAuth.scan", { file }), hint: t("watch.adminAuth.hint"), fixPrompt: t("watch.adminAuth.fix", { file }), options: [] });
  }
  for (const hit of piiLogLines(text).slice(0, 3)) {
    out.push({ rule: "pii-log", kind: "warn", sig: `pii-log:${file}:${hit.word}`, file, text: t("watch.piiLog.scan", { file, line: hit.line, word: hit.word }), hint: t("watch.piiLog.hint"), fixPrompt: t("watch.piiLog.fix", { file, word: hit.word }), options: [] });
  }
  return out;
}

/** 点検でテキストとして読むファイルか */
export function isScannableFile(name: string): boolean {
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  return rules.scanTextExtensions.includes(ext) || /^\.env(\..+)?$/.test(name);
}

/** npm audit --json の結果から high 以上の件数 */
export function countHighVulns(json: string): number | null {
  try {
    const got = JSON.parse(json) as { metadata?: { vulnerabilities?: Record<string, number> } };
    const v = got.metadata?.vulnerabilities;
    if (!v) return null;
    return (v.high ?? 0) + (v.critical ?? 0);
  } catch {
    return null;
  }
}

/** 週の始まり（月曜 0:00、ローカル）のエポックミリ秒 */
export function weekStart(ms: number): number {
  const d = new Date(ms);
  const day = (d.getDay() + 6) % 7; // 月曜=0
  d.setHours(0, 0, 0, 0);
  return d.getTime() - day * 24 * 60 * 60 * 1000;
}
