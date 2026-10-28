// TAMACODE の hooks module の入口。
// hooks.json の `modules` はプラグインにつき 1 つしか書けないので、ここで各機能の register をまとめて呼ぶ。
// 注意: マッチャー無しの同じイベントは module 全体で 1 回しか登録できない
// （session.start は changes.tsx、tool.call / turn.start / turn.complete は activity.tsx が持つ。他はマッチャー付きで登録する）。
//   - changes.tsx  : 変更履歴ペイン（/changes）。/log のコマンド登録もここ
//   - terms.tsx    : 用語翻訳ペイン（/terms）
//   - activity.tsx : 今やってることの帯・3 行まとめ・履歴（/log）・迷走検知・Spinner の日本語化
//   - safety.tsx   : 【7】危険操作の前の自動バックアップ（.tama-backup/）
//   - locale.ts    : 文言（locales/ja.json）の取り出し口 t()
//   - permission.ts: 【5】許可プロンプトの翻訳（純粋な部分。フックは activity.tsx）
//   - errors.ts    : 【4】エラー翻訳（純粋な部分。フックは activity.tsx）
//   - panel.tsx    : 「たま」ペイン（操作盤/用語/変更/読む/おねがい/戻す/点検/履歴 のタブ）と /tama、各コマンド
//   - watch.ts     : 見張りの判定（純粋。rules/security.json）。道具の前後に当てるのは safety.tsx
//   - server.ts    : 「ブラウザで見る」の見当付け（純粋）。/miru と状態行の印は panel.tsx

import type { Register } from "claude-code";
import { register as registerChanges } from "./changes";
import { register as registerTerms } from "./terms";
import { register as registerActivity } from "./activity";
import { register as registerSafety } from "./safety";
import { register as registerPanel } from "./panel";

export const register: Register = (on, options) => {
  registerChanges(on, options);
  registerTerms(on, options);
  registerActivity(on, options);
  registerSafety(on, options);
  registerPanel(on, options);
};
