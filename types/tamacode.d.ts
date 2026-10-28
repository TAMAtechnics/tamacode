// TAMACODE の型契約。plugin.json の "types" から参照される。
// $.state に置く値の型を宣言する（claude plugin validate が読む）。

export type TamacodeChange = {
  /** 一意な ID */
  id: string;
  /** 記録時刻（エポックミリ秒） */
  at: number;
  /** 使ったツール名（Edit / Write / MultiEdit） */
  tool: string;
  /** フルパス */
  file: string;
  /** ファイル名（末尾のみ） */
  name: string;
  /** 増えた行数 */
  added: number;
  /** 減った行数 */
  removed: number;
  /** unified diff（Code 部品の format: "diff" でそのまま描ける形） */
  diff: string;
  /** 差分が長くて途中で切ったか */
  isTruncated: boolean;
  /** 軽いモデルが作った日本語要約。失敗したら null */
  summary: string | null;
  /** 壊れると困る所（削除・DB・認証・支払い・.env・rm）に触れたか */
  isRisky: boolean;
};

/** 用語ペインに並べる1語 */
export type TamacodeTerm = {
  /** 表示名（例: デプロイ） */
  term: string;
  /** 一言説明 */
  meaning: string;
  /** 自分の辞書（~/.claude/tamacode-terms.json）の語か */
  isUser: boolean;
  /** どこに出てきた語か。answer: Claude の返事 / tool: ツールの出力（エラー文など） */
  from: "answer" | "tool";
};

/** 直近の返事（とそのターンのツール出力）から拾った用語 */
export type TamacodeTerms = {
  /** 拾った時刻（エポックミリ秒） */
  at: number;
  /** 拾う元になった返事の本文（辞書を育てた直後に拾い直すために持つ） */
  answer: string;
  /** このターンに出たツールの出力のうち、エラーらしい部分。新しいターンが始まると空になる */
  outputs: string[];
  /** 出てきた順（返事の語が先、ツール出力の語が後）。最大 40 語 */
  found: TamacodeTerm[];
};

/** 迷走検知の帯に出す内容 */
export type TamacodeWander = {
  /** read: 同じファイルを読みすぎ / error: 同じエラーが続いている */
  kind: "read" | "error";
  /** 帯に出す補足（例: api.ts を 5 回読んでいます） */
  detail: string;
  /** 回数 */
  count: number;
  /** 検知した時刻（エポックミリ秒） */
  at: number;
};

/**
 * 「今やってること」（帯と Spinner に出す）。
 * phase は 4 つの状態のうち「分かっている方」:
 *   running = A 実行中（道具が動いていて結果がまだ）
 *   writing = B 書き出し中（モデルの文字が増えている）
 *   waiting = C 返事待ち（許可ダイアログや質問で止まっている）
 *   between = 道具が終わって次を考えている（A〜C のどれでもない）
 * D 無反応は保存せず、at からの経過で描くときに判定する。
 */
export type TamacodeNow = {
  phase: "running" | "writing" | "waiting" | "between";
  /** 状態の猫（判定で上書きされうる） */
  face: string;
  /** いま何をしているか（道具の名前は日本語、対象のファイルやコマンドつき） */
  text: string;
  /** 元になった道具の名前。道具でなければ null */
  tool: string | null;
  /** 時間がかかる作業と言ってよいか（Bash は install/build/test/dev などのときだけ） */
  isLong: boolean;
  /** この状態になった時刻（経過時間の起点） */
  startedAt: number;
  /** 最後に変化があった時刻（tool.call / 結果 / 文字の増加 / ダイアログ表示で更新） */
  at: number;
};

/** /log ペインに並べる1行 */
export type TamacodeLogEntry = {
  /** 最後にこの行を出した時刻（エポックミリ秒） */
  at: number;
  /** 表示した文（猫つき） */
  text: string;
  /** 同じ文が続いた回数（1 なら1回だけ） */
  count: number;
};

declare module 'claude-code' {
  interface PluginState {
    tamacode: {
      /** 変更履歴。新しい順、最大 50 件 */
      changes: TamacodeChange[];
      /** 差分を展開中の変更の id。閉じているときは null */
      openId: string | null;
      /** 直近の返事から拾った用語。返事がまだ無ければ null */
      terms: TamacodeTerms | null;
      /** 迷走検知。何も無ければ null */
      wander: TamacodeWander | null;
      /** 今やってること。ターンが終わると null */
      now: TamacodeNow | null;
      /** やったことの履歴。新しい順、最大 200 件 */
      log: TamacodeLogEntry[];
    };
  }
}
