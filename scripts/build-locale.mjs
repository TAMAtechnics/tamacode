#!/usr/bin/env node
// locales/ja.json から hooks/locale.defaults.ts を作る。
// hooks module は JSON を import できないので、文言の「初期値」をコードに焼き込む。
// 実行時には locales/ja.json（と ~/.claude/tamacode-ja.json）を読んで上書きするので、
// JSON を直しただけでも Claude を起動し直せば反映される。ここを走らせるのは初期値も揃えたいとき。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "locales", "ja.json");
const dst = join(root, "hooks", "locale.defaults.ts");

const json = JSON.parse(readFileSync(src, "utf8"));
const entries = Object.entries(json).filter(([k, v]) => !k.startsWith("_") && typeof v === "string");
const body = entries.map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n");
writeFileSync(
  dst,
  `// 自動生成: scripts/build-locale.mjs が locales/ja.json から作る。直接編集しない。\n` +
    `export const DEFAULTS: Record<string, string> = {\n${body}\n};\n`,
);
console.log(`locale.defaults.ts を書き出しました（${entries.length} 件）`);
