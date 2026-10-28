// TAMACODE の hooks module の入口。
// hooks.json の `modules` はプラグインにつき 1 つしか書けないので、ここで各機能の register をまとめて呼ぶ。
// 注意: マッチャー無しの同じイベントは module 全体で 1 回しか登録できない
// （session.start は changes.tsx、tool.call / turn.start / turn.complete は activity.tsx が持つ。他はマッチャー付きで登録する）。
//   - changes.tsx  : 変更履歴ペイン（/changes）。/log のコマンド登録もここ
//   - terms.tsx    : 用語翻訳ペイン（/terms）
//   - activity.tsx : 今やってることの帯・3 行まとめ・履歴（/log）・迷走検知・Spinner の日本語化
//   - pane.tsx     : 「たま」ペイン（用語 / 変更 / やったこと のタブ）の描画
//   - safety.tsx   : 【7】危険操作の前の自動バックアップ（.tama-backup/）
//   - locale.ts    : 文言（locales/ja.json）の取り出し口 t()

import type { Register } from "claude-code";
import { register as registerChanges } from "./changes";
import { register as registerTerms } from "./terms";
import { register as registerActivity } from "./activity";
import { register as registerPane } from "./pane";
import { register as registerSafety } from "./safety";

export const register: Register = (on, options) => {
  registerChanges(on, options);
  registerTerms(on, options);
  registerActivity(on, options);
  registerPane(on, options);
  registerSafety(on, options);
};
