---
name: codex-telemetry
description: このプロジェクトのCodex実行経路GUIを起動・復旧し、実データ接続とSQLiteへの蓄積を検証するときに使う。
---

# Codex telemetry

適用条件はこのリポジトリの監視GUIの起動・復旧・収集処理の変更。グローバル設定や他プロジェクトには適用しない。

1. リポジトリルートで `pwsh -File ./start.ps1` を実行する。既存のコレクターを再利用する。ポート使用者が異なる場合は、そのプロセスを終了しない。
2. `http://127.0.0.1:4318/api/health` の `service`、`pid` と `source` を確認し、`/api/snapshot` の `source.storage` が `sqlite`、更新時刻が進むことを確認する。`readErrors` はプロセス起動後の累計なので、複数回の観測で増え続ける場合に未解消の読み取り失敗を調べる。過去の数値を消すためだけに再起動しない。生のログを出力しない。
3. 内部ブラウザでGUIを開き、LIVE、WebGLまたはフォールバック表示、実際のタスクの親子関係を確認する。デモの成功を実データ接続の成功として報告しない。
   タスク名の検証はCodexの状態DBの `threads.name`（読み取り専用）または `session_index.jsonl` の `thread_name` と表示を照合する。`threads.title`・初回メッセージ・会話の説明文を正式名の根拠にしない。既存SQLiteの未更新タスクにも名前が反映されることを確認する。
4. 外部同期が有効なら `/api/health` の `remoteSync.enabled`、`connected`、`lastSyncedAt` を確認する。外部表示の読み取りはSitesの同じoriginの `/api/snapshot` を使う。閲覧端末のlocalhostへ代替接続しない。受信停止と収集日時の停止をともに判定する。
5. 収集やSQLite処理を変えたときは `node --test tests/telemetry.test.mjs` を実行する。表示だけの変更は対応するJavaScriptの構文と文字・操作の収まりを確認する。
6. 再起動が必要なら `pwsh -File ./stop.ps1`、続いて `pwsh -File ./start.ps1`。PID・開始時刻・コマンドが一致しないプロセスは停止しない。SQLiteを消去しない。

正規化したメタデータだけを保存・配信する。参照元のプロンプト・推論・引数・出力をDBやサイトへ持ち込まない。実行記録、参照コマンドの完了、コードからの検出、プラグインの所属を区別する。

Siteを配信するときは GUI・Worker・同期プロトコル・build-worker.mjs・db/schema.ts・生成済みdrizzle/とmanifestを `.runtime/publish/` にコピーし、`node build-worker.mjs` をSitesの同期手順のビルドとして実行する。既適用のマイグレーションは書き換えない。`.runtime/` のSQLite・ログはコピーしない。登録済みのSite IDを再利用する。

WindowsのSitesパッケージ処理は、PowerShellのそのプロセス内で `$env:PATH = 'C:\Program Files\Git\bin;' + $env:PATH` と `$env:TAR_OPTIONS = '--force-local'` を設定してから、Sitesの `site-workflow.mjs` を実行する。これで同梱処理がGit付属のbashを使い、tarがドライブ文字をリモートホストと誤認しなくなる。グローバル環境を変更したり、WSLをインストールしたりしない。期限切れのSitesソース資格情報は同じSite IDで再取得し、メモリと標準入力だけで扱う。

外部接続を設定する場合は、既存SiteにだけSitesのサービス資格情報を使用し、同期用キーをSitesの秘密環境変数 `TRACE_SYNC_KEY` に置く。`scripts/configure-remote.mjs` の非表示の標準入力で設定し、ローカルの資格情報はDPAPIで暗号化する。資格情報をCLI引数・ソース・ブラウザへ出さない。外部APIからの実データ読み取りを検証し、未確認のブラウザログインを接続成功扱いしない。
