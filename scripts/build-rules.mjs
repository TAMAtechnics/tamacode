#!/usr/bin/env node
// rules/security.json から hooks/rules.defaults.ts を作る（locales と同じ理由: hooks module は JSON を import できない）。
// 実行時には rules/security.json（と ~/.claude/tamacode-rules.json）を読んで上書きする。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "rules", "security.json");
const dst = join(root, "hooks", "rules.defaults.ts");

const json = JSON.parse(readFileSync(src, "utf8"));
delete json._comment;
writeFileSync(
  dst,
  `// 自動生成: scripts/build-rules.mjs が rules/security.json から作る。直接編集しない。\n` +
    `export const RULES_DEFAULTS: Record<string, unknown> = ${JSON.stringify(json, null, 2)};\n`,
);
console.log(`rules.defaults.ts を書き出しました（${Object.keys(json).length} 項目）`);
