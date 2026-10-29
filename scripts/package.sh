#!/bin/sh
# 販売用の zip を作る。実行: sh scripts/package.sh
# 出来上がり: dist/tamacode-<版>.zip（展開すると tamacode/ フォルダ 1 つ）
# 入れない物: .git、node_modules、生成した型定義、控え、販売用の原稿、MIT の LICENSE（代わりに 利用規約.md を同梱）
set -e
cd "$(dirname "$0")/.."
VERSION=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' .claude-plugin/plugin.json | head -1)
OUT="dist/tamacode-$VERSION.zip"
STAGE=$(mktemp -d)
mkdir -p dist "$STAGE/tamacode"
rsync -a \
  --exclude '.git' --exclude 'node_modules' --exclude 'dist' --exclude '.tama-backup' \
  --exclude '.claude-plugin/types/*' --exclude '*.tsbuildinfo' --exclude '.DS_Store' \
  --exclude 'docs/販売' --exclude 'LICENSE' --exclude '.claude' \
  ./ "$STAGE/tamacode/"
cp docs/販売/利用規約.md "$STAGE/tamacode/利用規約.md"
cp docs/販売/商品説明.md "$STAGE/tamacode/はじめに.md"
rm -f "$OUT"
# zip / ditto だと日本語のファイル名が Windows で化けたり __MACOSX が混ざったりするので、python3 で作る（UTF-8 の印が付く）
python3 - "$STAGE" "$OUT" <<'PY'
import os, sys, zipfile
stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(os.path.join(stage, "tamacode")):
        dirs.sort()
        for f in sorted(files):
            p = os.path.join(root, f)
            z.write(p, os.path.relpath(p, stage))
PY
rm -rf "$STAGE"
echo "作りました: $OUT"
unzip -l "$OUT" | tail -1
