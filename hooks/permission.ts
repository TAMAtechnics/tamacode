// 【5】許可プロンプトの翻訳（純粋な部分）
//
// 許可確認（PermissionRequest）の内容を「何をするか／消えて困るものがあるか／危険度 低・中・高／おすすめの返事」の
// 4 行にする。まず規則で即答（permissionGuess）、裏で軽いモデルに言い直してもらう（permissionPrompt / parsePermission）。
// $ は使わない。呼ぶのは activity.tsx。

import { describeTool, rel, short } from "./activity";
import { t } from "./locale";
import { dangerOfBash, dangerOfFile } from "./safety";

export type Level = "low" | "mid" | "high";

export type PermissionLines = {
  /** 何をするか */
  what: string;
  /** 消えて困るものがあるか */
  lose: string;
  level: Level;
  /** おすすめの返事 */
  recommend: string;
};

const LEVEL_LABEL: Record<Level, string> = { low: "permission.level.low", mid: "permission.level.mid", high: "permission.level.high" };

export const levelLabel = (level: Level): string => t(LEVEL_LABEL[level]);

// 消しても作り直せる物（部品置き場・組み立て結果・一時ファイル）
const REGEN_DIRS: Array<[RegExp, string]> = [
  [/\bnode_modules\b/, "permission.what.rmNodeModules"],
  [/\b(dist|build|out|\.next|\.nuxt|\.svelte-kit|target)\b/, "permission.what.rmBuild"],
  [/\b(\.cache|cache|coverage|tmp|temp|\.turbo)\b/, "permission.what.rmCache"],
];

/** 規則だけで作る 4 行。モデルの返事が来るまでの即答 */
export function permissionGuess(tool: string, input: Record<string, unknown>, cwd: string | null): PermissionLines {
  const desc = describeTool(tool, input, cwd);
  let what = desc.text;
  let lose = t("permission.lose.none");
  let level: Level = "low";

  if (tool === "Bash") {
    const cmd = String(input.command ?? "");
    if (/\b(rm|rmdir|rimraf)\b/.test(cmd)) {
      const regen = REGEN_DIRS.find(([re]) => re.test(cmd));
      if (regen !== undefined) {
        what = t(regen[1]);
        lose = t("permission.lose.none");
        level = "low";
      } else {
        what = t("permission.what.rm", { target: short(cmd, 40) });
        lose = t("permission.lose.rm");
        level = "high";
      }
    } else if (/\bgit\s+push\b/.test(cmd)) {
      const isForce = /(\s--force\b|\s-f\b|\s\+\S)/.test(cmd);
      what = isForce ? t("permission.what.pushForce") : t("permission.what.push");
      lose = isForce ? t("permission.lose.pushForce") : t("permission.lose.push");
      level = isForce ? "high" : "mid";
    } else if (/\bgit\s+(reset\s+--hard|checkout\s+--\s|clean\b|branch\s+-D|stash\s+(drop|clear))/.test(cmd)) {
      what = t("permission.what.gitUndo", { target: short(cmd, 40) });
      lose = t("permission.lose.gitUndo");
      level = "high";
    } else if (/\b(drop|truncate)\s+(table|database|schema)\b|\bmigrat|\bprisma\s+(db|migrate)|\bsupabase\s+db\b/i.test(cmd)) {
      what = t("permission.what.db", { target: short(cmd, 40) });
      lose = t("permission.lose.db");
      level = "high";
    } else if (/\bsudo\b|\bkill(all)?\b|\bchmod\s+-R\b|\bchown\s+-R\b/.test(cmd)) {
      lose = t("permission.lose.system");
      level = "high";
    } else if (dangerOfBash(cmd) !== null) {
      lose = t("permission.lose.danger");
      level = "mid";
    } else if (/\b(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|\bpip3?\s+install\b|\bbrew\s+install\b/.test(cmd)) {
      what = t("permission.what.install");
      level = "low";
    }
  } else if (tool === "Edit" || tool === "Write" || tool === "MultiEdit" || tool === "NotebookEdit") {
    const file = String(input.file_path ?? input.notebook_path ?? "");
    const texts: string[] = [];
    for (const k of ["old_string", "new_string", "content", "new_source"]) if (typeof input[k] === "string") texts.push(input[k] as string);
    const reason = dangerOfFile(file, texts);
    if (/(^|[\\/])\.env(\.|$)/i.test(file)) {
      what = t("permission.what.env", { file: rel(file, cwd) });
      lose = t("permission.lose.env");
      level = "high";
    } else if (reason !== null) {
      lose = t("permission.lose.edit");
      level = "mid";
    } else {
      lose = t("permission.lose.editSafe");
      level = "low";
    }
  } else if (tool === "WebFetch" || tool === "WebSearch") {
    lose = t("permission.lose.none");
    level = "low";
  } else if (/^mcp__/.test(tool)) {
    lose = t("permission.lose.external");
    level = "mid";
  }

  return { what, lose, level, recommend: recommendFor(level) };
}

export function recommendFor(level: Level): string {
  return t(level === "low" ? "permission.recommend.low" : level === "mid" ? "permission.recommend.mid" : "permission.recommend.high");
}

/** 軽いモデルへのお願い文 */
export function permissionPrompt(tool: string, input: Record<string, unknown>, cwd: string | null, guess: PermissionLines): string {
  const file = typeof input.file_path === "string" ? rel(input.file_path, cwd) : typeof input.notebook_path === "string" ? rel(input.notebook_path, cwd) : null;
  const detail: string[] = [`道具: ${tool}`];
  if (typeof input.command === "string") detail.push(`コマンド: ${input.command.slice(0, 500)}`);
  if (file !== null) detail.push(`ファイル: ${file}`);
  for (const k of ["old_string", "new_string", "content"]) {
    const v = input[k];
    if (typeof v === "string" && v !== "") detail.push(`${k === "old_string" ? "消す文字" : k === "new_string" ? "足す文字" : "書く中身"}（先頭だけ）: ${v.slice(0, 300)}`);
  }
  return [
    "Claude Code が次の操作をしてよいか、プログラムを知らない人に許可を求めています。",
    "その人が判断できるよう、日本語で次の 4 行だけを書いてください。",
    "1 行目「何をするか: 」身近な言葉で。2 行目「消えて困るもの: 」無ければ「消えて困るものはありません」。",
    "3 行目「危険度: 」は 低・中・高 のどれか 1 文字。4 行目「おすすめ: 」は OK か NO かと、その一言。",
    "専門用語は禁止（使うなら括弧で一言説明）。各行 40 字以内。前置き・記号・空行は不要。",
    "",
    ...detail,
    "",
    `参考（規則による仮の判定）: 危険度 ${levelLabel(guess.level)}`,
  ].join("\n");
}

/** モデルの返事を 4 行に整える。拾えなければ null */
export function parsePermission(text: string): PermissionLines | null {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s\-・*•#>]+/, "").trim())
    .filter((l) => l !== "");
  const pick = (labels: string[]): string | null => {
    for (const l of lines) for (const label of labels) if (l.startsWith(label)) return l.slice(label.length).replace(/^[\s:：]+/, "").trim();
    return null;
  };
  const what = pick(["何をするか", "何をする"]);
  const lose = pick(["消えて困るもの", "消えて困る"]);
  const levelRaw = pick(["危険度"]);
  const recommend = pick(["おすすめ", "お勧め"]);
  if (what === null || lose === null || levelRaw === null) return null;
  const level: Level = /高/.test(levelRaw) ? "high" : /中/.test(levelRaw) ? "mid" : "low";
  const cut = (s: string) => (s.length > 60 ? s.slice(0, 59) + "…" : s);
  return { what: cut(what), lose: cut(lose), level, recommend: cut(recommend ?? recommendFor(level)) };
}

/** 帯に出す 4 行（ラベル付き） */
export function permissionLines(p: PermissionLines): string[] {
  return [
    `${t("permission.label.what")}: ${p.what}`,
    `${t("permission.label.lose")}: ${p.lose}`,
    `${t("permission.label.level")}: ${levelLabel(p.level)}`,
    `${t("permission.label.recommend")}: ${p.recommend}`,
  ];
}
