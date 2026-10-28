// 【4】エラー翻訳（純粋な部分）
//
// 1. エラーかどうかは AI に任せず機械的に決める（isToolError）:
//    Bash は 終了コードが 0 以外、または（読むだけのコマンドでなければ）出力に Error / ERR! / failed / Traceback /
//    EACCES / ENOENT / 401 / 403 / 500 を含むときだけ。sed / grep / cat の正常な出力や、表示が「…」で切れた物は
//    エラー扱いしない。grep が何も見つからず終了コード 1 なのもエラーではない。Bash 以外は isError のときだけ。
// 2. 1 行目は必ず「⚠ どこで」: 失敗した道具と対象（ファイル名かコマンドの要約）。
// 3. Claude が自分で直せる種類（構文・型・テスト失敗・import 漏れ）は 1 行「エラーが出ましたがClaudeが直してます」だけ。
//    詳細は [+] で開く。
// 4. 「あなたがやること」を出すのは 4 種類だけ: ログインが必要 / API キーや .env が無い / 権限がない / 道具が入ってない。
// 6. 同じエラーが 3 回続いたら「同じ所で3回詰まってます」に変える（回数は activity.tsx が数える）。
// $ は使わない。呼ぶのは activity.tsx。

import type { TamacodeErrorInfo } from "../types/tamacode";
import { bashLabelFromDescription, bashVerb, tail2 } from "./live";
import { t } from "./locale";

export type ErrorKind = "self" | "you" | "other";
export type YouReason = "login" | "key" | "permission" | "tool";
export type FixKind = "syntax" | "type" | "test" | "import" | "code";

export type ErrorClass = { kind: "self"; fix: FixKind } | { kind: "you"; reason: YouReason; name: string | null } | { kind: "other" };

export type ToolResultLike = { isError?: true; deny?: string; text?: string; result?: unknown };

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const tidy = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").trim();

/** 結果の文（text が無ければ result が文字列のときだけ） */
export const resultText = (result: ToolResultLike): string => (typeof result.text === "string" ? result.text : typeof result.result === "string" ? result.result : "");

// ---------- 1. 機械的な判定 ----------

/** Bash の終了コード。result のフィールドか、文中の「Exit code N」から。分からなければ null */
export function exitCodeOf(result: ToolResultLike): number | null {
  const r = result.result;
  if (r && typeof r === "object") {
    for (const k of ["exitCode", "exit_code", "returnCode", "code", "status"]) {
      const v = (r as Record<string, unknown>)[k];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
  }
  const m = /\bExit code:?\s*(\d+)\b/i.exec(resultText(result));
  return m ? Number(m[1]) : null;
}

/** 出力にエラーの印があるか: Error / ERR! / failed / Traceback / EACCES / ENOENT / 401 / 403 / 500（数字は文脈つき） */
export function hasErrorKeyword(text: string): boolean {
  const s = String(text ?? "");
  if (s.trim() === "") return false;
  return /Error\b|\bERR!|\bfailed\b|\bFAILED\b|\bTraceback\b|\bEACCES\b|\bENOENT\b|\b(status|HTTP|code|error|Error)\s*[:=]?\s*(401|403|500)\b|\b(401|403|500)\s+(Unauthorized|Forbidden|Internal Server Error)\b/.test(s);
}

const firstVerb = (cmd: string): string[] => {
  // 最初の区切りまで。cd と環境変数の代入は飛ばす
  const segs = String(cmd ?? "")
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim().split(/\s+/).filter((x) => x !== "" && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x)))
    .filter((s) => s.length > 0 && (s[0]!.split("/").pop() ?? "") !== "cd");
  return segs[0] ?? [];
};

/** 読むだけのコマンドか（出力の中の Error という字は中身であってエラーではない） */
export function isReadOnlyBash(cmd: string): boolean {
  const seg = firstVerb(cmd);
  const verb = seg[0]?.split("/").pop() ?? "";
  if (/^(cat|sed|head|tail|less|more|bat|awk|nl|wc|grep|rg|ag|find|fd|ls|tree|echo|printf|which|type|pwd|stat|file|diff)$/.test(verb)) return true;
  if (verb === "git" && /^(status|diff|log|show|blame|branch|ls-files)$/.test(seg[1] ?? "")) return true;
  return false;
}

/** 「見つからなかった」を終了コード 1 で表すコマンドか（grep / rg / diff / cmp / test） */
export function isNoMatchExit(cmd: string, code: number | null): boolean {
  if (code !== 1) return false;
  const verb = firstVerb(cmd)[0]?.split("/").pop() ?? "";
  return /^(grep|rg|ag|egrep|fgrep|diff|cmp|test|\[)$/.test(verb);
}

/** 道具の結果がエラーか（機械的に。AI は使わない） */
export function isToolError(tool: string, input: Record<string, unknown>, result: ToolResultLike): boolean {
  if (result.deny !== undefined) return false; // 止めたのはエラーではない
  const r = result.result;
  if (r && typeof r === "object" && (r as { interrupted?: unknown }).interrupted === true) return false; // 中断もエラーではない
  if (tool !== "Bash") return result.isError === true;
  const cmd = String(input.command ?? "");
  const code = exitCodeOf(result);
  const nonZero = code !== null ? code !== 0 : result.isError === true;
  if (nonZero) return !isNoMatchExit(cmd, code);
  if (isReadOnlyBash(cmd)) return false;
  return hasErrorKeyword(resultText(result));
}

// ---------- 2. どこで ----------

/** 「⚠ どこで」の本文: 失敗した道具と対象 */
export function whereText(tool: string, input: Record<string, unknown>): string {
  switch (tool) {
    case "Edit":
    case "MultiEdit":
      return t("error.where.edit", { file: tail2(input.file_path) });
    case "NotebookEdit":
      return t("error.where.edit", { file: tail2(input.notebook_path) });
    case "Write":
      return t("error.where.write", { file: tail2(input.file_path) });
    case "Read":
      return t("error.where.read", { file: tail2(input.file_path) });
    case "Bash": {
      const fromDesc = typeof input.description === "string" ? bashLabelFromDescription(input.description) : null;
      return t("error.where.bash", { label: fromDesc ?? bashVerb(String(input.command ?? "")) });
    }
    case "Grep":
    case "Glob":
      return t("error.where.search", { pattern: cut(tidy(input.pattern), 24) });
    case "WebFetch":
      return t("error.where.web", { url: cut(tidy(input.url), 40) });
    case "WebSearch":
      return t("error.where.websearch", { query: cut(tidy(input.query), 24) });
    case "Agent":
    case "Task":
      return t("error.where.agent", { name: cut(tidy(input.description), 24) });
    default: {
      const m = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(tool);
      if (m) return t("error.where.mcp", { server: m[1]!, name: cut(m[2]!, 24) });
      return t("error.where.tool", { tool: cut(tool, 24) });
    }
  }
}

// ---------- 3 と 4. 種類分け ----------

const TOOL_NAMES = "node|npm|npx|pnpm|yarn|bun|bunx|git|brew|python3?|pip3?|docker|gh|vercel|supabase|cargo|go|java|ruby|gem|make|tsc|figlet|jq|rg|deno";

/** 入っていない道具の名前を拾う。無ければ null */
function missingToolName(s: string): string | null {
  const pats = [
    /command not found: ([\w.-]+)/, // zsh: command not found: brew（シェル名ではなく道具名を取る）
    /(?:^|[\s:])([\w.-]+): command not found/m,
    /'([\w.-]+)' is not recognized as an internal or external command/,
    /spawn ([\w.-]+) ENOENT/,
    /\b([\w.-]+) is not installed\b/,
    new RegExp(`\\b(${TOOL_NAMES})\\b[^\\n]*No such file or directory`),
    new RegExp(`No such file or directory[^\\n]*\\b(${TOOL_NAMES})\\b`),
  ];
  for (const re of pats) {
    const m = re.exec(s);
    if (m && m[1] !== undefined && m[1] !== "") return m[1];
  }
  return null;
}

/** エラー文を「Claude が直せる／あなたの作業が必要（4 種類）／それ以外」に分ける */
export function classifyError(text: string): ErrorClass {
  const s = String(text ?? "");
  // あなたの作業が必要な 4 種類（文字列が具体的なので先に見る）
  const toolName = missingToolName(s);
  if (toolName !== null) return { kind: "you", reason: "tool", name: toolName };
  if (/api[_ -]?key|\.env\b|ANTHROPIC_API_KEY|OPENAI_API_KEY|\benv(ironment)? var(iable)?s?\b[^\n]*(missing|not set|undefined|required|is not defined)|missing (api )?(key|token|secret)\b|\bsecret\b[^\n]*(missing|not set)/i.test(s)) {
    return { kind: "you", reason: "key", name: null };
  }
  if (/\b401\b|unauthori[sz]ed|not logged in|login required|please (log ?in|sign ?in)|invalid[_ ]token|token (has )?expired|expired token|authentication (failed|required|error)|bad credentials|認証に失敗|ログインして/i.test(s)) {
    return { kind: "you", reason: "login", name: null };
  }
  if (/\bEACCES\b|\bEPERM\b|permission denied|operation not permitted|\b403\b|\bforbidden\b|insufficient permissions|access (is )?denied/i.test(s)) {
    return { kind: "you", reason: "permission", name: null };
  }
  // Claude が自分で直せる種類
  if (/Cannot find module|Module not found|ModuleNotFoundError|ImportError|has no exported member|cannot resolve|is not exported|does not provide an export|Could not resolve/i.test(s)) {
    return { kind: "self", fix: "import" };
  }
  if (/SyntaxError|Unexpected token|Parse error|Parsing error|Unexpected end of (input|file)|unterminated/i.test(s)) return { kind: "self", fix: "syntax" };
  if (/\bTS\d{4}\b|\btype error\b|is not assignable|TypeError|Property '.*' does not exist on type|Argument of type|type mismatch|mismatched types/i.test(s)) {
    return { kind: "self", fix: "type" };
  }
  if (/\b(tests?|specs?) failed\b|\b\d+ (failed|failing)\b|\bfail(ed)?\b[^\n]*\b(tests?|specs?)\b|\b(tests?|specs?)\b[^\n]*\bfail(ed)?\b|AssertionError|\(fail\)|✗|✖|FAIL\b/i.test(s)) {
    return { kind: "self", fix: "test" };
  }
  if (/ReferenceError|is not defined|is not a function|Build failed|Compilation failed|error\[E\d+\]|eslint|\d+ errors? found/i.test(s)) return { kind: "self", fix: "code" };
  return { kind: "other" };
}

/** エラー文の見出し（意味のある行を数行。Error / ERR! / failed を含む行を優先） */
export function errorHeadlines(text: string, max = 5, width = 160): string[] {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !/^Exit code:?\s*\d+$/i.test(l));
  const isHit = (l: string) => hasErrorKeyword(l) || /Exception|fatal:|panic:|エラー|失敗/.test(l);
  const picked = [...lines.filter(isHit), ...lines.filter((l) => !isHit(l))].slice(0, max);
  return picked.map((l) => cut(l, width));
}

/** 先頭の見出し 1 行 */
export function errorHeadline(text: string, max = 70): string {
  return cut(errorHeadlines(text, 1)[0] ?? "", max);
}

export const fixKindLabel = (fix: FixKind): string => t(`error.kind.${fix}`);

/** 帯に出す物を組む（3 行以内。1 行目は ⚠ どこで。詳細は [+] で） */
export function buildErrorInfo(args: { at: number; tool: string; input: Record<string, unknown>; text: string; sameCount: number }): TamacodeErrorInfo {
  const where = `⚠ ${whereText(args.tool, args.input)}`;
  const details = errorHeadlines(args.text);
  const base = { at: args.at, tool: args.tool, where, details, sameCount: args.sameCount, isLoading: false };
  if (args.sameCount >= 3) return { ...base, kind: "stuck", lines: [where, t("error.stuck", { n: args.sameCount })] };
  const c = classifyError(args.text);
  if (c.kind === "self") {
    return { ...base, kind: "self", lines: [`${where}。${t("error.selfFixing")}`], details: [t("error.detail.kind", { kind: fixKindLabel(c.fix) }), ...details] };
  }
  if (c.kind === "you") {
    const name = c.name ?? "";
    return {
      ...base,
      kind: "you",
      lines: [where, `${t("error.label.what")}: ${t(`error.what.${c.reason}`, { name })}`, `${t("error.label.action")}: ${t(`error.action.${c.reason}`, { name })}`],
    };
  }
  const head = details[0] ?? "";
  return {
    ...base,
    kind: "other",
    lines: [where, `${t("error.label.what")}: ${head === "" ? t("error.what.unknown") : head}`, `${t("error.label.canFix")}: ${t("error.fix.maybe")}`],
    isLoading: head !== "",
  };
}

// ---------- 「何が起きた」の言い直し（other のときだけ、軽いモデルに 1 行頼む） ----------

/** 軽いモデルへのお願い文 */
export function errorPrompt(text: string, where: string): string {
  const body = String(text ?? "").slice(0, 3000);
  return [
    "Claude Code の道具がエラーを返しました。プログラムを知らない人向けに、何が起きたかを日本語 1 行で説明してください。",
    "「何が起きた: 」で始めて 40 字以内。専門用語は禁止（使うなら括弧で一言説明）。前置き・記号・空行は不要。",
    "やるべきことや直し方は書かないでください（別の仕組みで出します）。",
    "",
    `どこで: ${where}`,
    "エラーの文:",
    body,
  ].join("\n");
}

/** モデルの返事から「何が起きた」を拾う。拾えなければ null */
export function parseWhat(text: string): string | null {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s\-・*•#>]+/, "").trim())
    .filter((l) => l !== "");
  for (const l of lines) {
    for (const label of ["何が起きた", "何が起きたか"]) {
      if (l.startsWith(label)) {
        const v = l.slice(label.length).replace(/^[\s:：]+/, "").trim();
        return v === "" ? null : cut(v, 60);
      }
    }
  }
  return null;
}
