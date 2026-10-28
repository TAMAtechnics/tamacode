// 【4】エラー翻訳（純粋な部分）
//
// 道具の結果にエラーが含まれていたら「何が起きた／Claudeが直せるか／あなたがやること（ある場合だけ）」の
// 3 行にする。まず規則で即答（errorGuess）、裏で軽いモデルに言い直してもらう（errorPrompt / parseErrorLines）。
// 同じエラーが 3 回続いたら「同じ所で詰まってます」に変える（activity.tsx が回数を見て切り替える）。
// $ は使わない。呼ぶのは activity.tsx。

import { t } from "./locale";

export type CanFix = "yes" | "maybe" | "you";

export type ErrorLines = {
  /** 何が起きた */
  what: string;
  /** Claude が直せるか */
  canFix: CanFix;
  /** あなたがやること。無ければ null */
  action: string | null;
};

/** 結果の文がエラーらしいか（isError でない成功結果の中のエラー文も拾う） */
export function looksLikeError(text: string): boolean {
  const s = String(text ?? "");
  if (s.trim() === "") return false;
  // ERR! や panic: は末尾が記号なので \b を付けない
  return /\b(Error|FAILED|failed|TypeError|ReferenceError|SyntaxError|RangeError|EACCES|ENOENT|ECONNREFUSED|ETIMEDOUT|EPERM|Traceback)\b|\bERR!|\bpanic:|\bfatal:|\b(status|HTTP|code|Error)\s*[:=]?\s*(401|403|404|500|502|503)\b|\b(401|403|404|500|502|503)\s+(Unauthorized|Forbidden|Not Found|Internal Server Error|Bad Gateway|Service Unavailable)\b|エラー|失敗/i.test(
    s,
  );
}

/** エラー文の見出し（先頭の意味のある 1 行） */
export function errorHeadline(text: string, max = 70): string {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l !== "");
  // 「Error:」「ERR!」「failed」を含む行を優先。無ければ先頭行
  const hit = lines.find((l) => /\b(Error|failed|FAILED|Exception)\b|\bERR!|\bfatal:|エラー|失敗/i.test(l)) ?? lines[0] ?? "";
  return hit.length > max ? hit.slice(0, max - 1) + "…" : hit;
}

/** 規則だけで作る 3 行。モデルの返事が来るまでの即答 */
export function errorGuess(text: string, tool: string): ErrorLines {
  const s = String(text ?? "");
  const head = errorHeadline(s);
  const what = head === "" ? t("error.what.unknown", { tool }) : t("error.what.raw", { head });

  // あなたの作業が必要な物（ログイン・鍵・ブラウザで承認・権限）
  if (/\b(401|unauthorized|authentication|not logged in|login required|invalid[_ ]token|token expired|expired token|credentials?)\b|ログインして|認証に失敗/i.test(s)) {
    return { what: t("error.what.auth"), canFix: "you", action: t("error.action.login") };
  }
  if (/\b(api[_ ]?key|secret|missing (key|token)|no (api )?key|ANTHROPIC_API_KEY|OPENAI_API_KEY|env(ironment)? variable .* (missing|not set|undefined))\b/i.test(s)) {
    return { what: t("error.what.key"), canFix: "you", action: t("error.action.key") };
  }
  if (/\b(open (the|your) browser|visit .*https?:\/\/|approve|authorize|oauth|device code|consent)\b/i.test(s)) {
    return { what: t("error.what.browser"), canFix: "you", action: t("error.action.browser") };
  }
  if (/\b(EACCES|EPERM|permission denied|operation not permitted|403|forbidden)\b/i.test(s)) {
    return { what: t("error.what.permission"), canFix: "you", action: t("error.action.permission") };
  }
  if (/\b(ECONNREFUSED|ETIMEDOUT|ENOTFOUND|network|timed? ?out|connection (refused|reset)|502|503|getaddrinfo)\b/i.test(s)) {
    return { what: t("error.what.network"), canFix: "maybe", action: t("error.action.network") };
  }
  // Claude が直せる物
  if (/\b(TypeError|ReferenceError|SyntaxError|RangeError|Cannot find module|is not defined|is not a function|Unexpected token|type error|TS\d{4})\b/i.test(s)) {
    return { what: t("error.what.code", { head }), canFix: "yes", action: null };
  }
  if (/\b(test|tests|spec|expect|assert)\b.*\b(fail|failed|FAILED)\b|\b(fail|failed)\b.*\b(test|tests)\b|AssertionError/i.test(s)) {
    return { what: t("error.what.test"), canFix: "yes", action: null };
  }
  if (/\b(ENOENT|no such file|not found|404|does not exist)\b/i.test(s)) {
    return { what: t("error.what.missing", { head }), canFix: "maybe", action: null };
  }
  if (/\b(disk full|ENOSPC|out of memory|heap)\b/i.test(s)) {
    return { what: t("error.what.resource"), canFix: "you", action: t("error.action.resource") };
  }
  return { what, canFix: "maybe", action: null };
}

export const canFixLabel = (c: CanFix): string => t(c === "yes" ? "error.fix.yes" : c === "maybe" ? "error.fix.maybe" : "error.fix.you");

/** 帯に出す行（ラベル付き。あなたがやることは有る時だけ） */
export function errorLines(g: ErrorLines): string[] {
  const out = [`${t("error.label.what")}: ${g.what}`, `${t("error.label.canFix")}: ${canFixLabel(g.canFix)}`];
  if (g.action !== null && g.action !== "") out.push(`${t("error.label.action")}: ${g.action}`);
  return out;
}

/** 軽いモデルへのお願い文 */
export function errorPrompt(text: string, tool: string, guess: ErrorLines): string {
  const body = String(text ?? "").slice(0, 3000);
  return [
    "Claude Code の道具がエラーを返しました。プログラムを知らない人向けに、日本語で 3 行以内で説明してください。",
    "1 行目「何が起きた: 」身近な言葉で 40 字以内。",
    "2 行目「Claudeが直せるか: 」は 直せる／たぶん直せる／あなたの作業が必要 のどれか。",
    "3 行目「あなたがやること: 」は、その人がやる必要がある時だけ（ログインし直す、鍵を入れる、ブラウザで承認する、など）。無ければ 3 行目は書かない。",
    "専門用語は禁止（使うなら括弧で一言説明）。前置き・記号・空行は不要。",
    "",
    `道具: ${tool}`,
    `参考（規則による仮の判定）: ${canFixLabel(guess.canFix)}`,
    "エラーの文:",
    body,
  ].join("\n");
}

/** モデルの返事を整える。拾えなければ null */
export function parseErrorLines(text: string): ErrorLines | null {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s\-・*•#>]+/, "").trim())
    .filter((l) => l !== "");
  const pick = (labels: string[]): string | null => {
    for (const l of lines) for (const label of labels) if (l.startsWith(label)) return l.slice(label.length).replace(/^[\s:：]+/, "").trim();
    return null;
  };
  const what = pick(["何が起きた", "何が起きたか"]);
  const fix = pick(["Claudeが直せるか", "Claude が直せるか", "直せるか"]);
  const action = pick(["あなたがやること", "あなたのやること"]);
  if (what === null || fix === null) return null;
  const canFix: CanFix = /あなた|必要/.test(fix) ? "you" : /たぶん|多分|おそらく/.test(fix) ? "maybe" : "yes";
  const cut = (s: string) => (s.length > 60 ? s.slice(0, 59) + "…" : s);
  return { what: cut(what), canFix, action: action === null || /^(無し|なし|特になし|ありません)/.test(action) ? null : cut(action) };
}
