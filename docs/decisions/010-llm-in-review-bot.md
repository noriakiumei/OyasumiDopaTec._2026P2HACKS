# 010: レビュー依頼ボット NEMU に、Claude の API を使う機能を足す

- 日付：2026-11-28
- 決めた人：こうのすけ（5つの機能を全部作ると決めた）。モデルの選び方などは AI の提案（PR のレビューで決める）

## 決めたこと

- NEMU（`tools/review-bot`）に、Claude の API（Anthropic）を使う機能を足す。作るのは #21〜#25 の5つ（レビュー依頼の要約、感想→Issue、朝夕のダイジェスト、Issue の分解、放置ブランチ・Issue の掃除提案）。
- API キーは Worker の Secret `ANTHROPIC_API_KEY` にだけ置く。無ければ AI の機能だけが止まり、ほかは今までどおり動く。
- モデルは2段にする。軽い処理は `claude-haiku-5-5`、読んで考える処理（PR の要約、分解、感想の整理）は `claude-opus-5-5`。Worker の `LLM_MODEL_FAST`・`LLM_MODEL_SMART` で変えられる。
- 感想の整理は、最初は Haiku だったが、前後の会話から意味をくみ取れなかった（2026-11-28 こうのすけ「文脈を理解できるようにしてほしい」）。前後の会話とスレッドの Issue を渡し、Opus にした。Discord のコマンドは裏の仕事を30秒しか待たないので、Opus が20秒で答えなければ Haiku でやり直す。
- SDK（`@anthropic-ai/sdk`）は使わず、`fetch` で Messages API を直接呼ぶ（`llm.mjs`）。
- 答えの形が決まっているものは structured outputs（`output_config.format`）で JSON にしてもらう。
- GitHub の情報集めは、できるだけ GitHub Actions に任せて NEMU に渡す（Actions には GitHub のトークンが最初からある）。Worker に GitHub のトークンを置かなくても動くようにする。

## 理由

- クレジットは約100ドル。Haiku は Opus の約40分の1の値段なので、回数の多い処理は Haiku にする。Opus で PR を1つ要約して数セント〜20セントくらい（差分は15万文字で切る）、ダイジェストは1日2回で数セント。ハッカソン期間中に使い切ることはまず無い。
- NEMU は依存なしの1ファイル（`bundle.mjs`）をダッシュボードに貼ってデプロイすることがある。SDK を入れるとビルドの手順が要るので、`fetch` で呼ぶ。呼ぶのは1か所（`ask()`）だけなので、やり直し・断られたとき・使ったトークンのログはそこにまとめた。
- Worker の IP は共有なので、トークン無しで GitHub API を何度も呼ぶと回数の上限に当たりやすい。Actions から渡せば上限を気にしなくてよく、Worker に置く秘密も増えない。

## 検討したほかの案

- 全部 Haiku にする：一番安いが、PR の要約や分解の質が落ちる。お金に余裕があるので上位モデルを使う。
- LLM を GitHub Actions の中で呼ぶ：Worker を通さずに済むが、API キーをリポジトリのシークレットに置くことになり、登録できるのは管理者（梅さん）だけ。Discord に書くのは NEMU なので、NEMU に置いた。

## 影響（変わること・注意すること）

- Worker に `ANTHROPIC_API_KEY` を入れる必要がある（こうのすけの Cloudflare アカウント）。キーが漏れたら Claude Console で消して作り直す。
- 使い過ぎが心配なら、Claude Console のワークスペースで月の上限（Spend limit）を決めておく。呼ぶたびに使ったトークン数を Cloudflare のログに出している。
- コードを変えたら Worker をデプロイし直す（README の「ネット上に置く」）。1ファイル版を作るときは、ファイルどうしで同じ名前の関数を作らない。
