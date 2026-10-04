---
name: codex-telemetry
description: このプロジェクトのCodex実行経路GUIを起動・復旧し、実データ接続とSQLiteへの蓄積を検証するときに使う。
---

# Codex telemetry

適用条件はこのリポジトリの監視GUIの起動・復旧・収集処理の変更。グローバル設定や他プロジェクトには適用しない。

1. リポジトリルートで `pwsh -File ./start.ps1` を実行する。既存のコレクターを再利用する。ポート使用者が異なる場合は、そのプロセスを終了しない。
2. `http://127.0.0.1:4318/api/health` の `service`、`pid` と `source` を確認し、`/api/snapshot` の `source.storage` が `sqlite`、`readErrors` が0であること、更新時刻が進むことを確認する。生のログを出力しない。
3. 内部ブラウザでGUIを開き、LIVE、WebGLまたはフォールバック表示、実際のタスクの親子関係を確認する。デモの成功を実データ接続の成功として報告しない。
4. 収集やSQLite処理を変えたときは `node --test tests/telemetry.test.mjs` を実行する。表示だけの変更は対応するJavaScriptの構文と文字・操作の収まりを確認する。
5. 再起動が必要なら `pwsh -File ./stop.ps1`、続いて `pwsh -File ./start.ps1`。PID・開始時刻・コマンドが一致しないプロセスは停止しない。SQLiteを消去しない。

正規化したメタデータだけを保存・配信する。参照元のプロンプト・推論・引数・出力をDBやサイトへ持ち込まない。実行記録、参照コマンドの完了、コードからの検出、プラグインの所属を区別する。

Siteを配信するときは `site/dist/` と `site/.openai/hosting.json` を `.runtime/publish/` にコピーし、Sitesの同期手順をその分離したチェックアウトで実行する。`.runtime/` のSQLite・ログはコピーしない。登録済みのSite IDを再利用する。

WindowsのSitesパッケージ処理は、PowerShellのそのプロセス内で `$env:PATH = 'C:\Program Files\Git\bin;' + $env:PATH` と `$env:TAR_OPTIONS = '--force-local'` を設定してから、Sitesの `site-workflow.mjs` を実行する。これで同梱処理がGit付属のbashを使い、tarがドライブ文字をリモートホストと誤認しなくなる。グローバル環境を変更したり、WSLをインストールしたりしない。期限切れのSitesソース資格情報は同じSite IDで再取得し、メモリと標準入力だけで扱う。
