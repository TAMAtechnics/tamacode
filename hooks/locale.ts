// 文言の取り出し口。
// 初期値は hooks/locale.defaults.ts（locales/ja.json から生成）。起動時に次の順で上書きする:
//   1. <プラグインの場所>/locales/ja.json
//   2. ~/.claude/tamacode-ja.json（自分用の言い換え。こちらが優先）
// 読み込み（$.fs.read）は $ を持つ側（changes.tsx の session.start など）が行い、中身の文字列だけをここに渡す。

import { DEFAULTS } from "./locale.defaults";

export const LOCALE_FILE = "locales/ja.json"; // プラグインの場所からの相対
export const USER_LOCALE_FILE = ".claude/tamacode-ja.json"; // HOME からの相対

let table: Record<string, string> = { ...DEFAULTS };
let isLoaded = false;

/** 文言を取り出す。{name} は vars で差し込む。無い鍵は鍵そのものを返す（見れば分かるように） */
export function t(key: string, vars: Record<string, string | number> = {}): string {
  const raw = table[key] ?? DEFAULTS[key] ?? key;
  return raw.replace(/\{(\w+)\}/g, (_m, k: string) => (k in vars ? String(vars[k]) : `{${k}}`));
}

/** JSON 文字列を読んで上書きする。文字列の値だけ採用。読めた件数を返す（壊れていれば 0） */
export function applyLocale(jsonText: string): number {
  let got: unknown;
  try {
    got = JSON.parse(jsonText);
  } catch {
    return 0;
  }
  if (!got || typeof got !== "object") return 0;
  let n = 0;
  for (const [k, v] of Object.entries(got as Record<string, unknown>)) {
    if (k.startsWith("_") || typeof v !== "string") continue;
    table[k] = v;
    n++;
  }
  isLoaded = true;
  return n;
}

export const localeLoaded = (): boolean => isLoaded;
export const markLocaleLoaded = (): void => {
  isLoaded = true;
};

/** テスト用: 初期値に戻す */
export function resetLocale(): void {
  table = { ...DEFAULTS };
  isLoaded = false;
}
