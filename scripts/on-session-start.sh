#!/usr/bin/env bash
# SessionStart フック。stdin にイベント JSON が渡される。
# stdout に出した文字列はセッション開始時のコンテキストとして Claude に渡される。
cat >/dev/null  # イベントは今は使わない
cat <<'MSG'
TAMACODE plugin loaded.
Rule for this session: when you call the Bash tool, write the `description` field in short, plain Japanese (例: 「ビルドを実行」「git の状態を確認」「テストを実行」). Keep it under 20 characters. This only affects the label shown to the user, not what you do.
MSG
