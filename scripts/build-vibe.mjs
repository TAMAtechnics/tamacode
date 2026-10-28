#!/usr/bin/env node
// config/vibe.json から hooks/vibe.defaults.ts を作る（locales と同じ理由: hooks module は JSON を import できない）。
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const json = JSON.parse(readFileSync(join(root, "config", "vibe.json"), "utf8"));
delete json._comment;
writeFileSync(
  join(root, "hooks", "vibe.defaults.ts"),
  `// 自動生成: scripts/build-vibe.mjs が config/vibe.json から作る。直接編集しない。\n` +
    `export const VIBE_DEFAULTS: Record<string, unknown> = ${JSON.stringify(json, null, 2)};\n`,
);
console.log(`vibe.defaults.ts を書き出しました（${Object.keys(json).length} 項目）`);
