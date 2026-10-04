# CODEX TRACE

Codex のタスク・サブタスクとプラグイン、スキル、MCP の呼び出し経路を表示する監視GUI。WebGLの回路と光点を主画面にし、サマリーは小さく、履歴と根拠は注釈で表示します。

## 起動

Node.js 22.13以上（`node:sqlite`対応）とPowerShell 7を使用します。ローカル監視の実行に追加パッケージは不要です。外部配信のスキーマ生成では site の開発依存を使用します。

```powershell
pwsh -File .\start.ps1
```

Codexの内部ブラウザで [ローカル監視画面](http://127.0.0.1:4318/) を開きます。停止は `pwsh -File .\stop.ps1`。記録したPID・開始時刻・コマンドが一致する、このプロジェクトが起動したプロセスだけを終了します。

## データと表示

- `%CODEX_HOME%` または `~/.codex` の実行記録を2秒ごとに追跡。作成日が古くても、直近2日以内に更新されたログを取得します。
- `.runtime/telemetry.sqlite3` に正規化したメタデータを保存。WAL・索引・IDによる重複防止・読み取り位置の保存を使用します。
- ログは先頭から4MiBずつ取り込みます。大きなログも途中を飛ばしません。起動直後に過去ログの取り込みが続くことがあります。
- 読み取りに失敗したファイルは次の巡回で再試行します。`source.readErrors` は起動後の累計で、過去の一時的な失敗も残ります。
- 実行記録から確認できる呼び出しは実線、コード内の記述は破線。中心が明るく周囲がにじむ光の玉が、新しい呼び出しで外向き、応答で戻る向きに移動します。動きを減らすOS設定では玉の数と速度を抑えます。
- スキルは参照先の `SKILL.md` を検出します。参照を含むコマンドの完了と、コード内の参照指示を区別します。モデルがその内容に従ったかは判定しません。
- WebGLでBOX・枠・線・発光・光点を描き、SVGで文字と操作判定、HTMLで注釈を表示します。背景のドラッグで移動、ホイールで拡大、BOXのドラッグで並べ替えができます。全体表示ボタンで戻します。WebGLが使えない場合は静的SVGに切り替えます。動きを減らすOS設定にも対応します。
- DBの蓄積に表示キャッシュの上限は影響しません。表示は直近100タスク・2,500イベント。グラフはスキル・MCP・ツールの機能名ごとにBOXを表示し、同じ機能の繰り返し呼び出しだけを件数で示します。機能ノード数の上限は設けず、画面移動・拡大で追えます。長い名前は省略せずBOX内で折り返します。履歴は索引付きで最大200件ずつ取得します。
- 完了したサブタスクはタスク一覧と処理経路から非表示にします。選択中に完了した場合は表示可能な親タスクへ戻ります。履歴とSQLiteの記録は保持します。
- 1回に最大64ログを読み、未読ファイルを順番に巡回します。保留ファイル数は `/api/snapshot` の `source.deferredFiles` で確認できます。64MiBを超える単一行は読み取り対象外となり、`source.oversizeRecords` に計数されます。

保存・配信するのはID、時刻、名前、親子関係、状態、所要時間と根拠の種類です。プロンプト、内部推論、コマンド本文、引数、出力、資格情報は保存・配信しません。完全な履歴はこのPCのSQLiteに残り、外部表示用の最新メタデータだけを本人限定のSitesへ同期します。

## 外部からの参照

[本人限定のSites](https://codex-trace-nagi.a-iioka137834.chatgpt.site) を別PC・スマートフォンで開き、同じChatGPTアカウントでログインします。閲覧端末のlocalhostは使いません。

- このPCからHTTPSで10秒ごとに差分を送信し、SitesのD1に最新状態を保存します。
- PCが起動し、コレクターが動いている間に更新されます。PCの停止・通信停止・収集停止は更新時刻と状態表示で判別できます。
- 外部表示は同期された直近100タスク・2,500イベントの範囲です。SQLiteの全履歴ファイルは送信しません。
- 接続用資格情報は `.runtime/remote-sync.secret` にWindowsのDPAPIで保護します。同じWindowsユーザーだけが復号できます。公開コードやブラウザへ資格情報を渡しません。
- `/api/health` の `remoteSync` または `.runtime/remote-status.json` で同期状態を確認できます。
- 再起動は `start.ps1`。同期を止める場合は `.runtime/remote-sync.json` の `enabled` を `false` にしてコレクターを再起動します。

初回接続は `node scripts/configure-remote.mjs` の非表示の標準入力で、既存Siteのサービス資格情報・同期用キー・Siteのoriginを設定します。資格情報をコマンド引数やGitへ含めません。Siteを替える場合は、そのSiteの秘密環境変数 `TRACE_SYNC_KEY` とローカル設定のキーを一致させます。

## Sites配信

`site/build-worker.mjs` は既存GUIを含むWorkerを生成します。`site/.openai/hosting.json` の既存Site IDを再利用し、D1 bindingは `DB`。`db/schema.ts` と生成済み `drizzle/` が本番スキーマの根拠です。

同期用チェックアウトは `.runtime/publish/` に分離し、SiteのソースとGUIだけをコピーします。SQLite・ログ・資格情報をデプロイやGitHubへ含めません。

[Cloudflare D1の公式API](https://developers.cloudflare.com/d1/worker-api/)に従い、準備済みクエリと条件付き更新でデータを書き込みます。アプリ側でも読み取り・書き込みの認証を確認し、Sitesの本人限定のアクセス制御を維持します。

## 検証

```powershell
node --test tests/telemetry.test.mjs tests/graph-model.test.mjs tests/remote-sync.test.mjs
node --check site/dist/app.js
node --check site/dist/graph-webgl.js
```

ローカルの実行記録はバージョンによって形式が変わるため、[Codex App Serverの公式仕様](https://learn.chatgpt.com/docs/app-server)と実際のログを照合して更新します。別のapp-serverを起動して、このデスクトップの実行状態を推定する方法は使っていません。
