# レビュー依頼ボット（MCP サーバー）

Issue ごとに Discord のスレッドを立て、その Issue の相談・PR・レビュー依頼をそこに集める。AI が人の確認を必要としたときは、そのスレッドで本人をメンションする。スレッドの返信は AI が読みに来る。
Claude でも Codex でも、MCP が使えるエージェントなら同じように使える。

ボットはネット上（Cloudflare Workers）に1つだけ置く。トークンはそこにだけあるので、メンバーは **URL を1回登録するだけ** で使える。

## 道具

| 道具 | すること |
|---|---|
| `request_review` | 呼ぶ人（GitHub のログイン名か `all`）・PR や Issue の URL・試し方と見てほしいことを渡すと、その件のスレッドでメンションする。PR なら、つながっている Issue のスレッドに書く。スレッドが無ければ立てる。PR なら差分を AI が3行に要約して添える（`summarize: false` で止める） |
| `read_replies` | スレッドの人の返信を古い順に読む。`after` に前回の `last_id` を渡すと続きだけ |
| `post_to_thread` | スレッドに書く（直したことの報告など）。`mention` で通知もできる |
| `close_review` | 一言書いてスレッドを閉じる |
| `list_reviews` | 開いているスレッドの一覧 |
| `sync_issue` | Issue のスレッドを Issue に合わせる（無ければ立てる・名前を変える・閉じる・開く）。ふだんは GitHub Actions が呼ぶ |
| `link_pr` | PR を Issue のスレッドにつなぐ。ふだんは GitHub Actions が呼ぶ |
| `post_digest` | チーム全体へのお知らせ（ダイジェスト・見回りの結果）を書く。文は呼ぶ側（Dot など）が作る。`DISCORD_DIGEST_CHANNEL_ID` があればそのチャンネル、無ければフォーラムの「ダイジェスト」スレッド |

スレッドは、スレッド ID・スレッドの URL・PR や Issue の URL のどれでも指定できる。

## Issue ごとのスレッド

`.github/workflows/nemu.yml` が、Issue と PR の動きに合わせて NEMU を呼ぶ。

- Issue が開く → `#12 タイトル` のスレッドが立つ（メンションなし）。タイトルが変わると名前も変わり、Issue を閉じると閉じ、開き直すと開く
- PR が開く → 本文の `Closes #12` から Issue のスレッドを見つけ、PR ができたことを書き、名前を `#12 タイトル（PR #13）` にする。以後 PR の URL でもこのスレッドが見つかる
- Issue の無い PR（docs だけの変更など）は、`request_review` のときに `PR #13 タイトル` のスレッドが立つ
- Actions の「NEMU（Issue のスレッド）」を手動で動かすと、開いている Issue のスレッドをまとめて立てる

## ネムの口調

NEMU はチームのマスコット「ネム」として書く（眠そうだけどドーパミン全開、決め台詞「これデプロイしたら寝るから……！」）。決まった文と、AI に渡すキャラ設定は `voice.mjs` にまとめてある。口調を変えるときはそこだけ直す。GitHub の Issue 本文など作業用の文は、ふつうの書き方のまま。

## AI（LLM）の機能

Worker に `ANTHROPIC_API_KEY` を入れると使える。無ければ AI の機能だけが止まり、ほかは今までどおり動く。モデルとお金の目安は `docs/decisions/010-llm-in-review-bot.md`。

- **レビュー依頼の要約**：`request_review` に PR の URL を渡すと、差分を読んで「変わったこと・見てほしいところ・試し方」を3行にして依頼文の先頭に添える。要約に失敗しても依頼は届く（結果の `summary_error` に理由）

- **感想 → Issue**：Discord のメッセージを右クリック →「アプリ」→「**Issue にする**」か、`/issue 内容:…` で、AI がタイトル・本文（何が起きたか・再現手順など）・ラベルに整えて Issue にする。前後の会話（30 件）と、スレッドがつながっている Issue・PR も読むので、「これ」「さっきの」のような書き方でも意味を補う。元のメッセージへのリンクと書いた人を本文に残し、似た Issue が開いていれば知らせる。`GITHUB_TOKEN` があれば直接起票し、無ければ作成ページのボタンと本文を返す（下の「Discord のコマンド」の設定が要る）

朝夕のダイジェストと見回りは、ChatGPT の Dot・Codex が NEMU の道具で書く。つなぎ方と頼み方は [dot.md](dot.md)。

使ったトークン数は、呼ぶたびに Cloudflare のログ（Workers → oyasumi-review-bot → Logs）に出る。

使うには、リポジトリのシークレット `NEMU_URL` に NEMU の URL（鍵入り）を入れる（Settings → Secrets and variables → Actions。リポジトリの管理者だけができる）。無いあいだは何もしない。フォークから出した PR もつながる（`pull_request_target` で受けるので、シークレットが渡る）。このワークフローは `main` にある版で動くので、マージした後に効く。

Discord ではスレッドを別のチャンネルに移せないので、1つのフォーラムで扱う。

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

AI の機能を使うときは、さらに次を入れる。

| 名前 | 中身 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude の API キー（Secret）。[Claude Console](https://platform.claude.com/) の API Keys で作る |
| `LLM_MODEL_FAST`・`LLM_MODEL_SMART` | （任意）モデルを変えるとき。既定は `claude-haiku-5-5`・`claude-opus-5-5` |
| `GITHUB_TOKEN` | （任意）感想を直接 Issue にするときと、GitHub を読むときに使う。読むだけなら無くても public なリポジトリは読める |
| `DISCORD_PUBLIC_KEY` | Discord のコマンドを受けるとき（下の「Discord のコマンド」） |
| `DISCORD_DIGEST_CHANNEL_ID` | （任意）ダイジェストを書くチャンネル。無ければフォーラムに「ダイジェスト」スレッドを作る |
| `GITHUB_REPO` | （任意）Issue を作るリポジトリ。既定は `noriakiumei/OyasumiDopaTec._2026P2HACKS` |

URL は `https://<Worker の名前>.<アカウント>.workers.dev/mcp/<ACCESS_KEY>`。今の Worker の名前は `oyasumi-review-bot`（`wrangler.toml` と同じ）。鍵入りの URL はオンボーディング資料に書く。

### Discord のコマンド（感想 → Issue）

1. Developer Portal の「General Information」にある **Public Key** を、Worker の変数 `DISCORD_PUBLIC_KEY` に入れる（秘密ではないので Secret でなくてよい）。
2. 同じ画面の **Interactions Endpoint URL** に `https://<Worker の URL>/discord/interactions` を入れて保存する（Discord が試しに送って、通れば保存できる）。
3. ブラウザで `https://<Worker の URL>/discord/setup/<ACCESS_KEY>` を1回開く。`"ok": true` が出ればコマンドが登録された。コマンドを変えたときも開き直す。
4. 直接起票させるなら、GitHub の fine-grained トークン（このリポジトリだけ、Issues の Read and write）を Worker の Secret `GITHUB_TOKEN` に入れる。起票した人はトークンの持ち主になる（書いた人は本文に残る）。

コマンドが出てこないときは、招待 URL の scope を `bot%20applications.commands` にしてサーバーに入れ直す。

## 手元で動かす（開発・確認用）

`server.mjs` は同じ道具を stdio で出す（Node 22 以上、依存なし）。`.env.example` をコピーして `tools/review-bot/.env` を作り（コミットしない）、`node tools/review-bot/server.mjs` を MCP サーバーとして登録する。

## テスト

偽の Discord・偽の Claude API・偽の GitHub を相手に、手元版（stdio）とネット上の版（HTTP）、1ファイル版を確かめる。本物の API は呼ばないので、お金はかからない。

```bash
node --test tools/review-bot/*.test.mjs
```
