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
  /** スピナー（猫の横）に出す実況。無ければ null（エンジンの mode から仮の文を出す） */
  live?: TamacodeLive | null;
};

/**
 * スピナー（猫の横）の実況。「猫 ＋ 動作 ＋ 対象 ＋ 目的 ＋ 経過時間」のうち、猫と時間は描くときに足す。
 * 端末幅に収まらなければ long → mid → brief の順に短い方を使う（目的 → 対象 の順に削る）。
 */
export type TamacodeLive = {
  /** 動作＋対象＋目的（直前の発言から拾った 1 フレーズ）。拾えなければ null */
  long: string | null;
  /** 動作＋対象 */
  mid: string;
  /** 動作だけ（必ず残す） */
  brief: string;
  /** 補足（+14行、↓1.8k文字 など）。無ければ null */
  note: string | null;
};

/** ひと区切りの 3 行まとめ（やったこと／確認の仕方／次にやること） */
export type TamacodeSummary = {
  /** まとめたターンの id */
  turnId: string;
  /** そのターンの長さ（ミリ秒）。完了行（TurnDuration）と突き合わせる鍵 */
  durationMs: number;
  /** 頼んだ時刻（エポックミリ秒） */
  at: number;
  /** 3 行（ラベル付き）。まだ無い／作れなかったときは null */
  lines: string[] | null;
  /** モデルに頼んでいる最中か */
  isLoading: boolean;
};

/** 帯に出す知らせ（控えを取った、今日はここまで、など）。次のターンが始まるまで残る */
export type TamacodeNotice = {
  /** 猫 */
  face: string;
  /** 文 */
  text: string;
  /** 出した時刻（エポックミリ秒） */
  at: number;
};

/** 自動バックアップ 1 件（.tama-backup/<日時>/） */
export type TamacodeBackup = {
  /** フォルダ名（2026-10-29_153012） */
  stamp: string;
  /** フォルダの絶対パス */
  dir: string;
  /** files: ファイルのコピー / stash: git stash のスナップショット / none: 控える物が無かった（git 管理外など） */
  kind: "files" | "stash" | "none";
  /** コピーしたファイル（控えの中の相対パス） */
  files: string[];
  /** stash のコミット id。無ければ null */
  stashSha: string | null;
  /** なぜ控えたか（日本語） */
  reason: string;
  /** きっかけの道具 */
  tool: string;
  /** 対象（ファイル名やコマンド） */
  target: string;
  /** 取った時刻（エポックミリ秒） */
  at: number;
};

/** 許可プロンプトの翻訳（帯の黄色い行の下に出す 4 行） */
export type TamacodePermission = {
  /** 出た時刻（エポックミリ秒） */
  at: number;
  /** 許可を求めている道具 */
  tool: string;
  /** 何をするか／消えて困るもの／危険度／おすすめ（ラベル付き 4 行） */
  lines: string[];
  /** 危険度 */
  level: "low" | "mid" | "high";
  /** モデルの言い直しを待っているか */
  isLoading: boolean;
};

/** エラー翻訳（帯に出す物。1 行目は必ず「⚠ どこで」） */
export type TamacodeErrorInfo = {
  /** 出た時刻（エポックミリ秒） */
  at: number;
  /** 失敗した道具 */
  tool: string;
  /** 「⚠ どこで」の行（失敗した道具と対象） */
  where: string;
  /** self: Claude が直せる（1 行だけ） / you: あなたの作業が必要（4 種類） / other: それ以外 / stuck: 同じ所で 3 回 */
  kind: "self" | "you" | "other" | "stuck";
  /** 帯に出す行（3 行以内。折り返して出す） */
  lines: string[];
  /** [+] で開く詳細（生のエラーの見出し）。無ければ [] */
  details: string[];
  /** 同じエラーが続いた回数 */
  sameCount: number;
  /** モデルの言い直し（何が起きた）を待っているか */
  isLoading: boolean;
};

/** 【3】読む: 保存した説明 */
export type TamacodeRead = {
  /** 説明してもらったファイル（絶対パス） */
  file: string;
  /** Claude の返事（説明の本文） */
  answer: string;
  /** 頼んだ時刻（エポックミリ秒） */
  at: number;
};

/** 【1】おねがいウィザードの入力 */
export type TamacodeWizardDraft = {
  what: string;
  where: string;
  success: string;
};

/** 【1】送った依頼（履歴。直近 5 件） */
export type TamacodeRequest = TamacodeWizardDraft & {
  /** 組み立てて送った文 */
  text: string;
  /** 送った時刻（エポックミリ秒） */
  at: number;
};

/** 【6】戻すの候補と選択 */
export type TamacodeRestore = {
  /** commit: git の履歴 / backup: .tama-backup の控え */
  candidates: Array<{ kind: "commit" | "backup"; id: string; label: string }>;
  /** 選んだ物。無ければ null */
  selected: { kind: "commit" | "backup"; id: string; label: string } | null;
  /** 「ここに戻すと消えるもの」。調べる前は null */
  lines: string[] | null;
  /** 調べている最中か */
  isLoading: boolean;
};

/** 見張りの指摘 1 件 */
export type TamacodeFinding = {
  rule: string;
  kind: "block" | "warn";
  sig: string;
  file: string | null;
  text: string;
  hint: string | null;
  fixPrompt: string | null;
  options: Array<{ key: string; label: string; action: "fix" | "allow" | "cancel" }>;
  /** 出た時刻（エポックミリ秒） */
  at: number;
};

/** 止めた回数・警告した回数（週ごと） */
export type TamacodeWatchStats = {
  /** 週の始まり（月曜 0:00）のエポックミリ秒 */
  weekStart: number;
  blocked: number;
  warned: number;
};

/** 点検の結果 */
export type TamacodeTenken = {
  at: number;
  isRunning: boolean;
  /** 見たファイル数 */
  files: number;
  /** 赤・黄の指摘 */
  items: TamacodeFinding[];
  /** 緑（OK だった項目）の文 */
  oks: string[];
  /** git 管理下か */
  isGit: boolean;
};

/** 開発サーバーの様子（「ブラウザで見る」） */
export type TamacodeServer = {
  port: number;
  url: string;
  /** 今答えているか */
  isUp: boolean;
  /** 起動して立ち上がりを待っている最中か */
  isStarting: boolean;
  /** 起動に使ったコマンド。分からなければ null */
  command: string | null;
  /** 最後に様子が変わった時刻（エポックミリ秒） */
  at: number;
};

/** 雰囲気モードの HUD の数字（全部実データ） */
export type TamacodeVibeStats = {
  /** セッションの始まり（エポックミリ秒）。0 なら未確定 */
  startedAt: number;
  /** 入力トークンの累計（キャッシュ分も含む） */
  inputTokens: number;
  /** 出力トークンの累計 */
  outputTokens: number;
  /** 読んだファイル（重複なし） */
  filesRead: string[];
  /** 編集した回数（Edit / Write / MultiEdit / NotebookEdit） */
  edits: number;
  /** 失敗した道具の回数 */
  errors: number;
  /** 今のターンの出力トークン（帯の進捗バー用） */
  turnOutputTokens: number;
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
      /** 用語タブで説明を開いているか */
      termsOpen: boolean;
      /** 「たま」ペインで開いているタブ */
      paneTab: "panel" | "terms" | "changes" | "yomu" | "onegai" | "modosu" | "tenken" | "log";
      /** /tama で開いているか */
      tamaOpen: boolean;
      /** 帯を出すか（/tama で切り替え。未設定は出す） */
      bandEnabled: boolean;
      /** 起動時に自動でペインを開くか（既定オン。$.store の settings にも保存） */
      autoOpen: boolean;
      /** 直近のターンの 3 行まとめ。無ければ null */
      summary: TamacodeSummary | null;
      /** 帯に出す知らせ。無ければ null */
      notice: TamacodeNotice | null;
      /** 許可プロンプトの翻訳。出ていなければ null */
      permission: TamacodePermission | null;
      /** エラー翻訳。直近の道具がエラーでなければ null */
      errorInfo: TamacodeErrorInfo | null;
      /** エラーの詳細を [+] で開いているか */
      errorOpen: boolean;
      /** Claude が作業中か（操作盤のボタンを無効にする） */
      isBusy: boolean;
      /** 直近に Read / Edit したファイル（絶対パス、新しい順、最大 10 件） */
      recentFiles: string[];
      /** 【3】保存した説明。新しい順、最大 20 件 */
      reads: TamacodeRead[];
      /** 【3】説明を頼んで返事待ちのファイル。無ければ null */
      readPending: { file: string; at: number } | null;
      /** 【3】開いている説明の at。閉じていれば null */
      readOpen: number | null;
      /** 【8】おわりを送って返事待ちか */
      endPending: boolean;
      /** 【1】入力途中の内容 */
      wizardDraft: TamacodeWizardDraft;
      /** 【1】埋まっていない欄 */
      wizardError: string[];
      /** 【1】送った依頼の履歴 */
      requests: TamacodeRequest[];
      /** 【6】戻すの候補と選択 */
      restore: TamacodeRestore;
      /** 見張りが止めた操作（帯にボタン付きで出す）。無ければ null */
      watchBlock: TamacodeFinding | null;
      /** 見張りの警告（帯に赤で出す）。新しい順 */
      watchWarnings: TamacodeFinding[];
      /** もう出さない箇所（sig）。「大丈夫」や一度出した警告 */
      watchSeen: string[];
      /** 「このまま通す」で 1 回だけ通す箇所（sig） */
      watchAllow: string[];
      /** 止めた回数・警告した回数 */
      watchStats: TamacodeWatchStats;
      /** 点検の結果。まだなら null */
      tenken: TamacodeTenken | null;
      /** Claude の作業が終わってから送る文。無ければ null */
      pendingPrompt: string | null;
      /** 開発サーバーの様子。知らなければ null */
      server: TamacodeServer | null;
      /** 雰囲気モードがオンか（$.store の settings.vibe にも保存） */
      vibeOn: boolean;
      /** HUD の数字 */
      vibeStats: TamacodeVibeStats;
      /** HUD 下段: 直近の道具呼び出し（新しい順） */
      vibeLog: Array<{ at: number; text: string }>;
      /** 自動バックアップの一覧。新しい順、最大 100 件 */
      backups: TamacodeBackup[];
      /** 迷走検知。何も無ければ null */
      wander: TamacodeWander | null;
      /** 今やってること。ターンが終わると null */
      now: TamacodeNow | null;
      /** やったことの履歴。新しい順、最大 200 件 */
      log: TamacodeLogEntry[];
    };
  }
}
