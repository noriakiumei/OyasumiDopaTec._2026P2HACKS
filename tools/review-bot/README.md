# レビュー依頼ボット（MCP サーバー）

AI が人の確認を必要としたとき、Discord でその人をメンションしてレビュー依頼を送り、その件のスレッドを開く。スレッドの返信は AI が読みに来る。
Claude Code でも Codex でも、MCP が使えるエージェントなら同じように使える。サーバーは立てず、各自のエージェントが `server.mjs` を手元で起動する（依存パッケージなし、Node 22 以上）。

## 道具

| 道具 | すること |
|---|---|
| `request_review` | 呼ぶ人（GitHub のログイン名か `all`）・PR や Issue の URL・試し方と見てほしいことを渡すと、メンション付きでスレッドを開く。同じ URL のスレッドがあれば、そこに書く |
| `read_replies` | スレッドの人の返信を古い順に読む。`after` に前回の `last_id` を渡すと続きだけ |
| `post_to_thread` | スレッドに書く（直したことの報告など）。`mention` で通知もできる |
| `close_review` | 一言書いてスレッドを閉じる |
| `list_reviews` | 開いているレビュー依頼スレッドの一覧 |

スレッドは、スレッド ID・スレッドの URL・PR や Issue の URL のどれでも指定できる。

## セットアップ（ボットを作る人が1回だけ）

1. [Discord Developer Portal](https://discord.com/developers/applications) で「New Application」を押して、アプリを作る（名前の例：レビュー依頼）。
2. 「Bot」で「Reset Token」を押してトークンをコピーする。同じ画面の「Privileged Gateway Intents」で **Message Content Intent** をオンにする（返信を読むのに要る）。
3. 「OAuth2」→「URL Generator」で、Scopes に `bot`、Bot Permissions に `View Channels`・`Send Messages`・`Send Messages in Threads`・`Create Public Threads`・`Read Message History`・`Manage Threads` を選ぶ。下に出た URL を開いて、チームのサーバーに追加する。
4. Discord にフォーラムチャンネル（例：`#レビュー依頼`）を作る。テキストチャンネルでも動く。
5. Discord の「ユーザー設定 → 詳細設定 → 開発者モード」をオンにして、チャンネルとメンバーを右クリック →「ID をコピー」で ID を集める。
6. `.env.example` をコピーして `tools/review-bot/.env` を作り、トークン・チャンネル ID・メンバーの対応表を書く。
7. `node tools/review-bot/server.mjs check` を1回動かす。ボットが Discord に一度接続し、チャンネルとメンバーが見えるかを確かめる（Discord は、一度も接続したことのないボットにはメッセージを送らせない）。

`.env` はコミットしない（`.gitignore` 済み）。中身は Discord の DM など、チームの外に出ない場所で渡す。リポジトリ・Issue・PR には書かない。

## 各自のエージェントで使う

まず、もらった `.env` を `tools/review-bot/.env` に置く。

- **Claude Code**：リポジトリ直下の `.mcp.json` に登録済み。最初に開いたときに「review-bot を使うか」聞かれたら許可する。
- **Codex**：`~/.codex/config.toml` に足す（パスは自分の clone の場所に変える）。

  ```toml
  [mcp_servers.review-bot]
  command = "node"
  args = ["/path/to/oyasumidopatec._2026p2hacks/tools/review-bot/server.mjs"]
  ```

- **クラウドで動くエージェント**（Claude Code on the web など）：`.env` を置けないので、環境の設定で `DISCORD_BOT_TOKEN`・`DISCORD_REVIEW_CHANNEL_ID`・`DISCORD_MEMBERS` を環境変数に入れる。ネットワークの許可に `discord.com` と `gateway.discord.gg` が要る（許可していないと 403 で失敗する）。

設定が無いときは、道具を呼ぶと「.env を作ってね」というエラーが返るだけで、ほかの作業の邪魔はしない。

## テスト

偽の Discord を相手に、MCP サーバーを stdio で動かして確かめる。

```bash
node --test tools/review-bot/server.test.mjs
```
