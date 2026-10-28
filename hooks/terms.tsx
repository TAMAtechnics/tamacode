// 用語翻訳ペイン（/terms）
//
// Claude の返事が終わるたび（turn.complete）に本文を読み、辞書にある専門用語を拾って
// 「一言説明」を右側のペインに並べる。読み飛ばさずに済むようにするための物。
//
// 辞書は2つ:
//   - 組み込み辞書（このファイルの BUILTIN）
//   - 自分の辞書（~/.claude/tamacode-terms.json）。/terms add で育てる。手で編集してもよい。
// 描画は pane.tsx（「たま」ペインの「用語」タブ）。ここは辞書・抽出・コマンドだけ。
//     形: { "terms": { "用語": "説明" }, "known": ["もう知ってる用語"] }
//     "known" に入れた用語は表示しない（/terms know で入れる）。自分の辞書は組み込みより優先。
//
// 表示用の値は $.state（tamacode.terms）に置く。ファイルは起動時に読み、コマンドで書き換える。
// ツールの出力（エラー文など）に出た用語は activity.tsx が拾って、同じ state に足す（buildTerms / pickErrorLines はそのための道具）。

import type { EngineInterface, Register } from "claude-code";
import type { TamacodeTerm, TamacodeTerms } from "../types/tamacode";

type Entry = { term: string; aliases: string[]; meaning: string; isUser: boolean };
type UserFile = { terms: Record<string, string>; known: string[] };

const TERMS = { plugin: "tamacode", key: "terms" } as const;
const PANE_TAB = { plugin: "tamacode", key: "paneTab" } as const; // 「たま」ペインのタブ（描画は pane.tsx）

const PANE_ID = "tama";
export const USER_FILE = ".claude/tamacode-terms.json"; // HOME からの相対
const MAX_FOUND = 40;
const MAX_TEXT_CHARS = 60000;
const MAX_OUTPUT_CHARS = 4000; // ツール出力 1 回ぶんから用語ペインに渡す上限

// ---------- 組み込み辞書 ----------
// term: 表示名 / aliases: 本文中でこう書かれていたら拾う（表示名も含める）/ meaning: 一言説明

const BUILTIN: Array<[string, string[], string]> = [
  // 作業の流れ
  ["デプロイ", ["デプロイ", "deploy", "deployment", "デプロイメント"], "作ったものを本番のサーバーに置いて、みんなが使える状態にすること。"],
  ["ビルド", ["ビルド", "build"], "書いたプログラムを、実際に動く形に組み立てる作業。"],
  ["コンパイル", ["コンパイル", "compile"], "人が書いたプログラムを、コンピュータが読める形に変換すること。ビルドの一部。"],
  ["テスト", ["テスト", "test", "tests", "ユニットテスト", "unit test"], "プログラムが思った通りに動くかを自動で確かめる仕組み。"],
  ["リント", ["リント", "lint", "linter", "eslint", "ESLint"], "コードの書き方の乱れやありがちなミスを自動で指摘する道具。"],
  ["フォーマッター", ["フォーマッター", "フォーマット", "prettier", "Prettier", "formatter"], "コードの見た目（改行や空白）を自動でそろえる道具。"],
  ["リファクタリング", ["リファクタリング", "リファクタ", "refactor", "refactoring"], "動きは変えずに、中身を読みやすく・直しやすく整理すること。"],
  ["ロールバック", ["ロールバック", "rollback"], "問題が出たときに、前のうまく動いていた状態に戻すこと。"],
  ["マイグレーション", ["マイグレーション", "migration", "migrate", "マイグレート"], "データベースの構造（表や列）を変更する手順書。実行すると保存の形が変わる。"],
  ["CI", ["CI", "CI/CD", "GitHub Actions", "継続的インテグレーション"], "コードを更新するたびに、テストやビルドを自動で走らせる仕組み。"],
  ["ホットリロード", ["ホットリロード", "hot reload", "ホットリロード", "HMR"], "ファイルを保存すると、アプリを立ち上げ直さずに変更が反映されること。"],
  ["キャッシュ", ["キャッシュ", "cache", "caching"], "一度取ってきたものを手元に置いておき、次回は速く出す仕組み。古い物が残ることもある。"],
  ["ログ", ["ログ", "log", "logs", "logging"], "プログラムが動いている間に残す記録。何が起きたかを後から調べるのに使う。"],
  ["デバッグ", ["デバッグ", "debug", "debugging"], "うまく動かない原因を探して直す作業。"],
  ["スタックトレース", ["スタックトレース", "stack trace", "stacktrace", "traceback"], "エラーが起きたとき、どこを通ってそこに来たかの道のり一覧。"],
  ["クラッシュ", ["クラッシュ", "crash"], "プログラムが途中で異常終了すること。"],
  ["タイムアウト", ["タイムアウト", "timeout"], "決めた時間内に終わらなかったので打ち切られること。"],
  ["ボトルネック", ["ボトルネック", "bottleneck"], "全体の速さを一番足を引っ張っている所。"],
  // 設定・環境
  ["環境変数", ["環境変数", "env", ".env", "environment variable", "environment variables", "ENV"], "プログラムの外側に置いておく設定値。パスワードや接続先など、コードに直接書きたくない物を入れる。"],
  ["本番環境", ["本番環境", "本番", "production", "prod"], "実際のユーザーが使っている環境。ここを壊すと影響が大きい。"],
  ["開発環境", ["開発環境", "ローカル環境", "ローカル", "local", "development", "dev"], "自分の手元で試すための環境。壊しても他の人に影響しない。"],
  ["ステージング", ["ステージング", "staging", "プレビュー環境", "preview"], "本番にそっくりなお試し環境。公開前の確認に使う。"],
  ["依存関係", ["依存関係", "依存", "dependency", "dependencies", "node_modules"], "自分のプログラムが借りて使っている、他の人が作った部品。"],
  ["パッケージ", ["パッケージ", "package", "ライブラリ", "library"], "他の人が作った、借りて使えるプログラムの部品のまとまり。"],
  ["npm", ["npm", "pnpm", "yarn", "bun"], "部品（パッケージ）を取ってきたり、決まった作業を実行したりする道具。"],
  ["バージョン", ["バージョン", "version", "semver"], "そのプログラムや部品の「何回目の版か」を表す番号。"],
  ["設定ファイル", ["設定ファイル", "config", "configuration", "tsconfig.json", "package.json", "設定値"], "プログラムの動き方を書いておくファイル。"],
  ["パス", ["パス", "path", "ファイルパス"], "ファイルがどのフォルダにあるかを示す住所のような文字列。"],
  ["ディレクトリ", ["ディレクトリ", "directory", "ルート", "root"], "フォルダのこと。「ルート」は一番上のフォルダ。"],
  ["ターミナル", ["ターミナル", "terminal", "シェル", "shell", "コマンドライン", "CLI"], "文字で命令を打ち込んでコンピュータを操作する画面。"],
  ["コマンド", ["コマンド", "command"], "ターミナルに打ち込む命令の文。"],
  ["スクリプト", ["スクリプト", "script", "scripts"], "決まった作業をまとめて実行する小さなプログラム。"],
  // Git
  ["Git", ["Git", "git"], "ファイルの変更履歴を記録して、いつでも前の状態に戻せるようにする道具。"],
  ["コミット", ["コミット", "commit", "commits"], "変更をひとまとまりとして履歴に記録すること。セーブポイントのような物。"],
  ["プッシュ", ["プッシュ", "push"], "手元の変更履歴を、GitHub などの共有場所に送ること。"],
  ["プル", ["プル", "pull", "fetch", "フェッチ"], "共有場所にある最新の変更を、手元に取り込むこと。"],
  ["ブランチ", ["ブランチ", "branch", "branches", "main ブランチ"], "履歴の枝分かれ。本線を汚さずに、別の線で作業するための物。"],
  ["マージ", ["マージ", "merge"], "枝分かれした変更を、ひとつに合流させること。"],
  ["コンフリクト", ["コンフリクト", "conflict", "競合"], "同じ場所を別々に変えたため、合流できず人が選ぶ必要がある状態。"],
  ["プルリクエスト", ["プルリクエスト", "pull request", "PR", "プルリク"], "「この変更を本線に入れてください」という提案。レビューしてから取り込む。"],
  ["リポジトリ", ["リポジトリ", "repository", "repo", "リポ"], "プロジェクトのファイルと履歴をまとめて入れてある保管場所。"],
  ["クローン", ["クローン", "clone"], "共有場所にあるリポジトリを、手元に丸ごと複製すること。"],
  ["差分", ["差分", "diff"], "変更の前と後で、どこが変わったかの一覧。"],
  ["リベース", ["リベース", "rebase"], "枝分かれの起点を付け替えて、履歴を一直線に整えること。"],
  ["タグ", ["tag", "タグ付け"], "履歴の特定の時点に付ける目印。リリース番号などに使う。"],
  // Web・ネットワーク
  ["API", ["API", "エンドポイント", "endpoint"], "プログラム同士がやりとりするための窓口。「エンドポイント」はその窓口ひとつひとつの住所。"],
  ["リクエスト", ["リクエスト", "request"], "サーバーに「これをください」と送る依頼。"],
  ["レスポンス", ["レスポンス", "response"], "依頼に対してサーバーが返す答え。"],
  ["サーバー", ["サーバー", "server", "バックエンド", "backend"], "データや処理を受け持つ、裏側のコンピュータやプログラム。"],
  ["フロントエンド", ["フロントエンド", "frontend", "front-end", "クライアント", "client"], "ユーザーの画面側。ブラウザやアプリで見えている部分。"],
  ["ミドルウェア", ["ミドルウェア", "middleware", "proxy", "プロキシ"], "リクエストが届く前に間に入って、確認や振り分けをする仕組み。"],
  ["ルーティング", ["ルーティング", "routing", "route", "routes"], "どの URL のときに、どの画面や処理を出すかの振り分け。"],
  ["ドメイン", ["ドメイン", "domain", "DNS", "サブドメイン"], "サイトの住所（example.com など）。DNS はその住所から実際の場所を引く仕組み。"],
  ["HTTP", ["HTTP", "HTTPS", "https"], "ブラウザとサーバーがやりとりする際の約束事。HTTPS は暗号化付き。"],
  ["ステータスコード", ["ステータスコード", "status code", "404", "500", "401", "403"], "サーバーの返事に付く番号。404 は見つからない、500 はサーバー側の故障、401/403 は権限なし。"],
  ["JSON", ["JSON", "json"], "データを文字で書き表す形式。設定ファイルやサーバーとのやりとりでよく使う。"],
  ["CORS", ["CORS"], "別のサイトからデータを取りに来るのを許すかどうかの決まり。引っかかると「取りに行けない」エラーになる。"],
  ["Webhook", ["Webhook", "webhook", "ウェブフック"], "何かが起きたときに、外部のサービスがこちらに「起きたよ」と知らせてくる仕組み。"],
  ["CDN", ["CDN", "エッジ", "edge"], "世界中に置いた配信用サーバー。近い所から配るので速い。"],
  // データ
  ["データベース", ["データベース", "database", "DB", "Postgres", "PostgreSQL", "MySQL", "SQLite"], "データをきちんと整理して保存しておく倉庫。"],
  ["テーブル", ["テーブル", "table", "tables"], "データベースの中の表。行と列で情報を持つ。"],
  ["スキーマ", ["スキーマ", "schema"], "データの形の決まり。どんな項目を、どんな型で持つか。"],
  ["クエリ", ["クエリ", "query", "SQL"], "データベースへの問い合わせ文。SQL はその書き方。"],
  ["インデックス", ["インデックス", "index"], "データベースで検索を速くするための索引。"],
  ["ORM", ["ORM", "Prisma", "prisma", "Drizzle"], "データベースを、プログラムの言葉のまま扱えるようにする翻訳役。"],
  ["ストレージ", ["ストレージ", "storage", "バケット", "bucket", "Blob", "blob"], "画像やファイルなど大きな物を置いておく保管場所。"],
  ["シード", ["シード", "seed", "seeding"], "データベースに最初のサンプルデータを入れること。"],
  ["バックアップ", ["バックアップ", "backup"], "万一に備えて、データの控えを別の場所に取っておくこと。"],
  // 認証・安全
  ["認証", ["認証", "auth", "authentication", "ログイン", "ログアウト", "サインイン"], "「あなたは誰か」を確かめる仕組み。ログインのこと。"],
  ["認可", ["認可", "authorization", "権限", "permission", "permissions"], "「その人に何をしてよいか」を決める仕組み。"],
  ["トークン", ["トークン", "token", "JWT", "アクセストークン"], "ログイン済みであることを示す合言葉のような文字列。"],
  ["セッション", ["セッション", "session"], "ログインしてからログアウトするまでの「つながり」の記録。"],
  ["API キー", ["API キー", "APIキー", "API key", "api key", "シークレット", "secret", "secrets"], "外部サービスを使うための合鍵。人に見せてはいけない。"],
  ["OAuth", ["OAuth", "oauth", "SSO"], "Google や GitHub のアカウントでログインできるようにする仕組み。"],
  ["ハッシュ", ["ハッシュ", "hash", "hashing"], "元に戻せない形に変換すること。パスワードはこの形で保存する。"],
  ["暗号化", ["暗号化", "encrypt", "encryption", "SSL", "TLS", "証明書"], "中身を読めない形にして守ること。証明書はサイトが本物だと示す書類。"],
  ["脆弱性", ["脆弱性", "vulnerability", "XSS", "SQLインジェクション", "injection"], "攻撃に使われうる弱点。"],
  // プログラムの中身
  ["関数", ["関数", "function", "functions", "メソッド", "method"], "ひとまとまりの処理に名前を付けた物。呼ぶと動く。"],
  ["変数", ["変数", "variable", "variables", "定数", "const"], "値を入れておく名前付きの箱。"],
  ["型", ["型エラー", "型定義", "型チェック", "type error", "TypeScript", "typescript"], "その値が「文字」なのか「数」なのかといった種類。TypeScript は型をチェックしてミスを防ぐ。"],
  ["コンポーネント", ["コンポーネント", "component", "components"], "画面を作る部品。ボタンや一覧など、組み合わせて画面にする。"],
  ["モジュール", ["モジュール", "module", "インポート", "import", "export", "エクスポート"], "プログラムを分けたファイル単位。インポートは他のファイルの物を取り込むこと。"],
  ["インターフェース", ["インターフェース", "interface"], "部品同士がやりとりする際の「形の約束」。"],
  ["非同期", ["非同期", "async", "await", "Promise", "promise"], "待ち時間のある処理（通信など）を、止まらずに進める書き方。"],
  ["例外", ["例外", "exception", "throw", "try/catch"], "想定外の事が起きたときに投げられるエラー。受け止めないと止まる。"],
  ["null", ["null", "undefined", "ヌル"], "「値が無い」ことを表す特別な値。ここを扱い忘れるとよく落ちる。"],
  ["ステート", ["ステート", "state", "状態管理"], "画面が今どうなっているかを覚えている値。変わると画面が描き直される。"],
  ["フック", ["フック", "hook", "hooks"], "決まったタイミングで割り込んで動く仕組み。React では状態を扱う道具の呼び名でもある。"],
  ["プロパティ", ["プロパティ", "props", "property"], "部品に外から渡す設定値。"],
  ["レンダリング", ["レンダリング", "render", "rendering", "描画"], "データから実際の画面を描くこと。"],
  ["イベント", ["イベント", "event", "events", "ハンドラ", "handler", "リスナー"], "クリックや入力などの出来事。ハンドラはそれが起きたときに動く処理。"],
  ["正規表現", ["正規表現", "regex", "regexp", "RegExp"], "文字のパターンを表す書き方。「数字が3つ続く」などを探すのに使う。"],
  ["ハードコード", ["ハードコード", "hardcode", "hard-coded", "決め打ち"], "本来は設定にすべき値を、プログラムに直接書いてしまうこと。"],
  ["ボイラープレート", ["ボイラープレート", "boilerplate", "雛形", "テンプレート", "template"], "毎回同じように書く決まり文句の部分。"],
  ["ラッパー", ["ラッパー", "wrapper", "wrap"], "既にある物を包んで、使いやすくした物。"],
  ["エッジケース", ["エッジケース", "edge case", "境界"], "めったに起きないけれど、起きると壊れがちな特殊な状況。"],
  ["ランタイム", ["ランタイム", "runtime", "Node.js", "Node", "node"], "プログラムを実際に動かす土台。Node は JavaScript をサーバーで動かす土台。"],
  ["フレームワーク", ["フレームワーク", "framework", "Next.js", "React", "Vue", "Svelte"], "アプリを作る際の土台となる大きな部品一式。"],
  ["ミニファイ", ["ミニファイ", "minify", "バンドル", "bundle", "bundler", "Webpack", "Vite"], "配布用に、ファイルをまとめて小さくすること。"],
  ["SSR", ["SSR", "サーバーサイドレンダリング", "SSG", "静的生成", "ISR"], "画面をサーバー側で作ってから送る方式。ブラウザ側で作るより初回表示が速い。"],
  ["コンテナ", ["コンテナ", "container", "Docker", "docker"], "アプリと必要な物を箱に詰めて、どこでも同じように動かす仕組み。"],
  ["サーバーレス", ["サーバーレス", "serverless", "Lambda"], "サーバーの管理をせず、必要なときだけ処理を動かしてもらう方式。"],
  ["cron", ["cron", "cron ジョブ", "クーロン", "スケジュール実行"], "決まった時刻や間隔で自動的に実行する仕組み。"],
  // Claude Code まわり
  ["プラグイン", ["プラグイン", "plugin", "plugins"], "後から追加して機能を増やす部品。"],
  ["MCP", ["MCP", "MCP サーバー", "MCPサーバー"], "Claude が外部のサービス（Gmail やデータベースなど）を扱えるようにするつなぎ役。"],
  ["スキル", ["スキル", "skill", "skills"], "Claude に手順を教えておく台本。特定の頼み方で起動する。"],
  ["サブエージェント", ["サブエージェント", "subagent", "エージェント", "agent"], "Claude が仕事を分担させる、別の小さな Claude。"],
  ["コンテキスト", ["コンテキスト", "context", "コンテキストウィンドウ"], "Claude が今覚えていられる会話や資料の量。いっぱいになると古い物を忘れる。"],
  ["トークン数", ["トークン数", "tokens", "token count"], "文章の長さを数える単位。料金や記憶量はこれで決まる。"],
  ["プロンプト", ["プロンプト", "prompt", "システムプロンプト"], "Claude に渡す指示の文。"],
  ["ハルシネーション", ["ハルシネーション", "hallucination"], "AI がもっともらしい嘘を言ってしまうこと。"],
];

// ---------- 小さな道具 ----------

type Dollar = EngineInterface;

const isKana = (ch: string): boolean => /[゠-ヿー]/.test(ch);
const isAllKana = (s: string): boolean => /^[゠-ヿー]+$/.test(s);
const hasAscii = (s: string): boolean => /[A-Za-z]/.test(s);

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// alias が text に初めて出る位置。無ければ -1。
function firstIndex(text: string, lower: string, alias: string): number {
  if (hasAscii(alias)) {
    // 英字は単語として一致（deploy が deployed に混ざらないよう境界を見る）。大文字小文字は無視。
    const re = new RegExp(`(?<![A-Za-z0-9_.-])${escapeRe(alias)}(?![A-Za-z0-9_-]|\\.[A-Za-z])`, "i");
    const m = re.exec(text);
    return m === null ? -1 : m.index;
  }
  if (isAllKana(alias)) {
    // カタカナは、前後にカタカナが続いていたら別の語とみなす（ログ ≠ ログイン）
    let from = 0;
    for (;;) {
      const i = text.indexOf(alias, from);
      if (i < 0) return -1;
      const before = i > 0 ? text[i - 1]! : "";
      const after = text[i + alias.length] ?? "";
      if (!isKana(before) && !isKana(after)) return i;
      from = i + 1;
    }
  }
  void lower;
  return text.indexOf(alias);
}

// 本文からコードブロック（``` … ```）を外す。コマンドの中の単語まで拾うと煩いので。
function stripFences(text: string): string {
  return text.replace(/```[\s\S]*?```/g, "\n");
}

function buildEntries(user: UserFile): Entry[] {
  const userTerms = Object.keys(user.terms);
  const entries: Entry[] = userTerms.map((term) => ({ term, aliases: [term], meaning: user.terms[term]!, isUser: true }));
  const taken = new Set(userTerms.map((t) => t.toLowerCase()));
  for (const [term, aliases, meaning] of BUILTIN) {
    if (taken.has(term.toLowerCase())) continue; // 自分の辞書が優先
    // 表示名そのものは自動では拾わない（「型」のように短くて紛らわしい物があるので、拾う語は aliases に明示する）
    entries.push({ term, aliases: Array.from(new Set(aliases)), meaning, isUser: false });
  }
  return entries;
}

export function findTerms(answer: string, entries: Entry[], known: ReadonlySet<string>, from: TamacodeTerm["from"] = "answer"): TamacodeTerm[] {
  const text = stripFences(String(answer ?? "").slice(0, MAX_TEXT_CHARS));
  if (text.trim() === "") return [];
  const lower = text.toLowerCase();
  const hits: Array<{ at: number; len: number; term: TamacodeTerm }> = [];
  for (const en of entries) {
    if (known.has(en.term.toLowerCase())) continue;
    let best = -1;
    let len = 0;
    for (const alias of en.aliases) {
      const i = firstIndex(text, lower, alias);
      if (i >= 0 && (best < 0 || i < best || (i === best && alias.length > len))) {
        best = i;
        len = alias.length;
      }
    }
    if (best >= 0) hits.push({ at: best, len, term: { term: en.term, meaning: en.meaning, isUser: en.isUser, from } });
  }
  // 長い語の中に丸ごと含まれて見つかった短い語は出さない（「環境変数」の中の「変数」など）
  const kept = hits.filter((h) => !hits.some((o) => o !== h && o.len > h.len && o.at <= h.at && o.at + o.len >= h.at + h.len));
  kept.sort((a, b) => a.at - b.at);
  return kept.slice(0, MAX_FOUND).map((h) => h.term);
}

// ツールの出力のうち、用語ペインに渡す部分。エラー扱いの結果は全部、そうでなければエラーらしい行だけ
// （npm ERR! や Error: の行）。何も無ければ ""。
export function pickErrorLines(text: string, isError: boolean): string {
  const t = String(text ?? "");
  if (t.trim() === "") return "";
  if (isError) return t.slice(0, MAX_OUTPUT_CHARS);
  const re = /\bERR!|\berror\b|\bwarning\b|\bfailed\b|\bexception\b|\bfatal\b|\bcannot\b|not found|エラー|失敗|警告/i;
  const lines = t.split(/\r?\n/).filter((l) => re.test(l));
  return lines.join("\n").slice(0, MAX_OUTPUT_CHARS);
}

// ---------- 自分の辞書（ファイル） ----------

const emptyUser = (): UserFile => ({ terms: {}, known: [] });

function parseUserFile(raw: string): UserFile {
  const got = JSON.parse(raw) as Partial<UserFile> | null;
  const out = emptyUser();
  if (got && typeof got === "object") {
    if (got.terms && typeof got.terms === "object") {
      for (const [k, v] of Object.entries(got.terms)) {
        if (typeof k === "string" && k.trim() !== "" && k.trim() !== "__proto__" && typeof v === "string") out.terms[k.trim()] = v.trim();
      }
    }
    if (Array.isArray(got.known)) out.known = got.known.filter((k): k is string => typeof k === "string" && k.trim() !== "").map((k) => k.trim());
  }
  return out;
}

async function userFilePath($: Dollar): Promise<string | null> {
  let home: string | undefined;
  try {
    home = await $.env.get("HOME");
  } catch {
    home = undefined;
  }
  if (!home) return null;
  return `${home.replace(/[\\/]+$/, "")}/${USER_FILE}`;
}

async function loadUserFile($: Dollar): Promise<UserFile> {
  const path = await userFilePath($);
  if (path === null) return emptyUser();
  let raw: string;
  try {
    raw = await $.fs.read(path);
  } catch {
    return emptyUser(); // まだ無い
  }
  try {
    return parseUserFile(raw);
  } catch (err) {
    $.ui.log(`用語辞書 ${path} が読めません（JSON の形を確認してください）: ${String(err)}`, { to: "debug" });
    return emptyUser();
  }
}

// 辞書ファイルに書く形（語順をそろえる）
export function serializeUser(user: UserFile): string {
  const sorted: UserFile = {
    terms: Object.fromEntries(Object.entries(user.terms).sort(([a], [b]) => a.localeCompare(b, "ja"))),
    known: Array.from(new Set(user.known)).sort((a, b) => a.localeCompare(b, "ja")),
  };
  return JSON.stringify(sorted, null, 2) + "\n";
}

async function saveUserFile($: Dollar, user: UserFile): Promise<string | null> {
  const path = await userFilePath($);
  if (path === null) return null;
  await $.fs.write(path, serializeUser(user));
  return path;
}

// ---------- state ----------

async function readTerms($: Dollar): Promise<TamacodeTerms | null> {
  const got = await $.state.get(TERMS);
  const v = got.value as Partial<TamacodeTerms> | null | undefined;
  if (!v || typeof v !== "object" || !Array.isArray(v.found)) return null;
  return { at: v.at ?? 0, answer: v.answer ?? "", outputs: Array.isArray(v.outputs) ? v.outputs : [], found: v.found };
}

// 「add 用語 説明」「add 用語: 説明」「add 用語=説明」を {term, meaning} にする
function splitTermAndMeaning(rest: string): { term: string; meaning: string } | null {
  const s = rest.trim();
  if (s === "") return null;
  const m = /^(.+?)\s*[:：=＝]\s*(.+)$/.exec(s) ?? /^(\S+)\s+(.+)$/.exec(s);
  if (m === null) return null;
  return { term: m[1]!.trim(), meaning: m[2]!.trim() };
}

const HELP = [
  "📘 /terms の使い方",
  "  /terms                 用語ペインを開く",
  "  /terms add 用語 説明   自分の辞書に足す（「用語: 説明」でも可）",
  "  /terms rm 用語         自分の辞書から消す",
  "  /terms know 用語       もう知ってるので今後は出さない",
  "  /terms unknow 用語     また出すようにする",
  "  /terms list            自分の辞書と「知ってる」一覧",
  "  /terms file            辞書ファイルの場所",
].join("\n");

// ---------- 登録 ----------

// モジュール内に持つ辞書（起動時にファイルから読む。リロードで読み直す）
let user: UserFile = emptyUser();
let entries: Entry[] = buildEntries(user);
let known = new Set<string>();

const refresh = () => {
  entries = buildEntries(user);
  known = new Set(user.known.map((k) => k.toLowerCase()));
};

// pane.tsx（「知ってる」ボタン）が自分の辞書を差し替えるための入口。$ は渡さない（validate が拒むため、ファイル I/O は呼ぶ側が行う）
export const getUser = (): UserFile => user;
export const setUser = (next: UserFile): void => {
  user = next;
  refresh();
};

// 今の辞書で、返事とこのターンのツール出力から用語を拾う。返事の語が先、ツール出力だけに出た語が後
export function buildTerms(answer: string, outputs: string[], at: number): TamacodeTerms {
  const fromAnswer = findTerms(answer, entries, known, "answer");
  const seen = new Set(fromAnswer.map((t) => t.term));
  // ツール出力は新しい物が上に来るよう、後ろから並べる
  const fromTool = findTerms([...outputs].reverse().join("\n"), entries, known, "tool").filter((t) => !seen.has(t.term));
  return { at, answer, outputs, found: [...fromAnswer, ...fromTool].slice(0, MAX_FOUND) };
}

// 今の辞書で、直近の返事（とツール出力）を拾い直す（辞書を育てた直後に反映させる）
const rescan = async ($: Dollar, cur: TamacodeTerms | null) => {
  if (cur === null) return;
  await $.state.set(TERMS, buildTerms(cur.answer, cur.outputs, await $.clock.now()));
};

// 自分の辞書を差し替えて、ファイルに保存し、直近の返事を拾い直す。保存先のパス（HOME 無しなら null）を返す
async function applyUser($: Dollar, next: UserFile): Promise<string | null> {
  user = next;
  refresh();
  const saved = await saveUserFile($, user);
  await rescan($, await readTerms($));
  return saved;
}

export const withKnown = (term: string): UserFile => ({ ...user, known: Array.from(new Set([...user.known, term])) });

// 起動時: 辞書ファイルを読み、/terms を登録、ペインを（広ければ）出す
async function onSessionStart($: Dollar): Promise<void> {
  try {
    user = await loadUserFile($);
  } catch (err) {
    $.ui.log(`用語辞書の読み込みに失敗: ${String(err)}`, { to: "debug" });
    user = emptyUser();
  }
  refresh();
  try {
    await $.command.register({ name: "terms", description: "用語ペイン（返事の専門用語に一言説明）を開く / add・rm・know で辞書を育てる" });
  } catch (err) {
    $.ui.log(`/terms の登録に失敗: ${String(err)}`, { to: "debug" });
  }
  // 画面が広ければ勝手に右側へ出る。狭ければ /terms で開く（isPlaced: false ですぐ返るので待っても止まらない）。
  try {
    await $.ui.open({ id: PANE_ID, title: "たま", columns: 48 });
  } catch (err) {
    $.ui.log(`用語ペインを開けません: ${String(err)}`, { to: "debug" });
  }
}

export const register: Register = (on) => {
  // 人が画面を見ている会話だけ（ペインとコマンドは対話用）。
  // マッチャー無しの session.start は changes.tsx が持っているので、ここはマッチャー付きで登録する。
  on("session.start", { isInteractive: true }, async ($, e, next) => {
    await onSessionStart($);
    return next(e);
  });

  // Claude の返事が終わるたびに用語を拾う（メインの会話だけ。サブエージェントの返事は見ない）
  on("turn.complete", { reason: "answer" }, async ($, e, next) => {
    if (e.agentId === undefined && e.answer.trim() !== "") {
      try {
        const cur = await readTerms($);
        await $.state.set(TERMS, buildTerms(e.answer, cur?.outputs ?? [], await $.clock.now()));
      } catch (err) {
        $.ui.log(`用語の抽出に失敗: ${String(err)}`, { to: "debug" });
      }
    }
    return next(e);
  });

  on("command.run", { command: "terms" }, async ($, e) => {
    const args = String(e.args ?? "").trim();
    const [sub = "", ...restParts] = args.split(/\s+/);
    const rest = args.slice(sub.length).trim();
    void restParts;

    if (sub === "") {
      await $.state.set(PANE_TAB, "terms");
      const opened = await $.ui.open({ id: PANE_ID, title: "たま", focus: true, closeOnEscape: true, columns: 48, rows: 24 });
      const cur = await readTerms($);
      const n = cur?.found.length ?? 0;
      if (!opened.isPlaced) return { text: `📘 用語タブは待機中です: ${opened.reason}` };
      return { text: `📘 用語タブを開きました（直近の返事から ${n} 語）。Esc で閉じます` };
    }

    if (sub === "help" || sub === "?") return { text: HELP };

    if (sub === "file") {
      const path = await userFilePath($);
      return { text: path === null ? "辞書ファイルの場所が分かりません（HOME が未設定）" : `📘 自分の辞書: ${path}\n形: { "terms": { "用語": "説明" }, "known": ["知ってる用語"] }` };
    }

    if (sub === "list") {
      const terms = Object.entries(user.terms);
      const lines = [
        `📘 自分の辞書（${terms.length} 語）`,
        ...(terms.length === 0 ? ["  （まだありません。/terms add 用語 説明 で足せます）"] : terms.map(([t, m]) => `  ${t} … ${m}`)),
        `🙆 知ってる（${user.known.length} 語）: ${user.known.length === 0 ? "なし" : user.known.join("、")}`,
      ];
      return { text: lines.join("\n") };
    }

    let next: UserFile;
    let done: string;
    if (sub === "add") {
      const got = splitTermAndMeaning(rest);
      if (got === null) return { text: "使い方: /terms add 用語 説明   （例: /terms add デプロイ 本番に置くこと）" };
      next = { ...user, terms: { ...user.terms, [got.term]: got.meaning }, known: user.known.filter((k) => k.toLowerCase() !== got.term.toLowerCase()) };
      done = `📘 「${got.term}」を自分の辞書に足しました`;
    } else if (sub === "rm" || sub === "remove" || sub === "del") {
      if (rest === "") return { text: "使い方: /terms rm 用語" };
      if (!Object.hasOwn(user.terms, rest)) return { text: `「${rest}」は自分の辞書にありません（/terms list で確認）` };
      const terms = { ...user.terms };
      delete terms[rest];
      next = { ...user, terms };
      done = `📘 「${rest}」を自分の辞書から消しました`;
    } else if (sub === "know" || sub === "知ってる") {
      if (rest === "") return { text: "使い方: /terms know 用語" };
      next = withKnown(rest);
      done = `🙆 「${rest}」はもう出しません`;
    } else if (sub === "unknow" || sub === "unknown" || sub === "forget") {
      if (rest === "") return { text: "使い方: /terms unknow 用語" };
      next = { ...user, known: user.known.filter((k) => k.toLowerCase() !== rest.toLowerCase()) };
      done = `📘 「${rest}」をまた出すようにしました`;
    } else {
      return { text: `「${sub}」は知らない指示です。\n${HELP}` };
    }

    let saved: string | null = null;
    try {
      saved = await applyUser($, next);
    } catch (err) {
      return { text: `辞書の保存に失敗しました: ${String(err)}` };
    }
    return { text: `${done}${saved === null ? "（HOME が未設定なのでファイルには保存できませんでした）" : ""}` };
  });
};
