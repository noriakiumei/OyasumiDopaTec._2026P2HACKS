# レビュー依頼ボット（MCP サーバー）

AI が人の確認を必要としたとき、Discord でその人をメンションしてレビュー依頼を送り、その件のスレッドを開く。スレッドの返信は AI が読みに来る。
Claude でも Codex でも、MCP が使えるエージェントなら同じように使える。

ボットはネット上（Cloudflare Workers）に1つだけ置く。トークンはそこにだけあるので、メンバーは **URL を1回登録するだけ** で使える。

## 道具

| 道具 | すること |
|---|---|
| `request_review` | 呼ぶ人（GitHub のログイン名か `all`）・PR や Issue の URL・試し方と見てほしいことを渡すと、メンション付きでスレッドを開く。同じ URL のスレッドがあれば、そこに書く |
| `read_replies` | スレッドの人の返信を古い順に読む。`after` に前回の `last_id` を渡すと続きだけ |
| `post_to_thread` | スレッドに書く（直したことの報告など）。`mention` で通知もできる |
| `close_review` | 一言書いてスレッドを閉じる |
| `list_reviews` | 開いているレビュー依頼スレッドの一覧 |

スレッドは、スレッド ID・スレッドの URL・PR や Issue の URL のどれでも指定できる。

## 各自のエージェントで使う

チームの非公開の場所（オンボーディング資料）にある **review-bot の URL**（`https://…/mcp/<鍵>`）を登録する。URL に鍵が入っているので、リポジトリ・Issue・PR には書かない。

- **Claude（claude.ai・デスクトップアプリ・Claude Code）**：claude.ai の「設定 → コネクタ → カスタムコネクタを追加」に URL を貼る。クラウドで動く Claude からも使える。
- **Claude Code だけで使う**：`claude mcp add --transport http review-bot <URL>`
- **Codex**：`~/.codex/config.toml` に足す。

  ```toml
  [mcp_servers.review-bot]
  url = "<URL>"
  ```

## ボットを作り直すとき（1回だけ、だれか1人）

### Discord

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリを作る。
2. 「Bot」で **Message Content Intent** をオンにする（返信を読むのに要る）。「トークンをリセット」でトークンを出す。
3. 招待 URL（`https://discord.com/oauth2/authorize?client_id=<アプリ ID>&scope=bot&permissions=326417583104`）を開いて、チームのサーバーに追加する。権限は チャンネルを見る・メッセージを送る・スレッドでメッセージを送る・公開スレッドの作成・メッセージ履歴を読む・スレッドの管理（無くても自分のスレッドは閉じられた）。
4. フォーラムチャンネル（例：`#レビュー依頼`）を作る。テキストチャンネルでも動く。
5. 「開発者モード」をオンにして、チャンネルとメンバーの ID を集める（右クリック →「ID をコピー」）。
6. 一度だけ、手元で `node tools/review-bot/server.mjs check` を動かす（Discord は、一度もゲートウェイに接続したことのないボットにはメッセージを送らせない）。設定は下の4つを環境変数か `tools/review-bot/.env` に入れる。

### ネット上に置く

`tools/review-bot` で `npx wrangler deploy` する。ダッシュボードで直すときは、`node tools/review-bot/bundle.mjs` が出す1ファイル版を Worker のエディタに貼ってデプロイする。コードを変えたら、どちらかでデプロイし直す。

設定画面の「Variables and Secrets」に4つ入れる（トークンと鍵は Secret にする）。

| 名前 | 中身 |
|---|---|
| `DISCORD_BOT_TOKEN` | ボットのトークン |
| `DISCORD_REVIEW_CHANNEL_ID` | レビュー依頼のチャンネル ID |
| `DISCORD_MEMBERS` | `{"GitHub のログイン名": "Discord のユーザー ID", …}` |
| `ACCESS_KEY` | URL に入れる鍵（長いランダムな文字列）。漏れたら変えて、URL を配り直す |

URL は `https://<Worker の名前>.<アカウント>.workers.dev/mcp/<ACCESS_KEY>`。今の Worker の名前は `oyasumi-review-bot`（`wrangler.toml` と同じ）。鍵入りの URL はオンボーディング資料に書く。

## 手元で動かす（開発・確認用）

`server.mjs` は同じ道具を stdio で出す（Node 22 以上、依存なし）。`.env.example` をコピーして `tools/review-bot/.env` を作り（コミットしない）、`node tools/review-bot/server.mjs` を MCP サーバーとして登録する。

## テスト

偽の Discord を相手に、手元版（stdio）とネット上の版（HTTP）を確かめる。

```bash
node --test tools/review-bot/server.test.mjs tools/review-bot/worker.test.mjs
```
