// LLM を使う機能を、偽の Discord・偽の Claude API・偽の GitHub を相手に確かめる。
// node --test tools/review-bot/llm.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { handle } from './core.mjs';
import { FORUM_ID, sent, channels, messages, discord } from './fake-discord.mjs';
import { anthropic, githubApi, llm, llmRequests, ghRoutes, ghRequests, listen } from './fake-apis.mjs';

let env;
let rpcId = 0;

async function call(name, args, e = env) {
  const res = await handle({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }, e);
  const text = res.result.content[0].text;
  return res.result.isError ? { error: text } : JSON.parse(text);
}

const REPO = 'https://github.com/noriakiumei/oyasumidopatec._2026p2hacks';
const API_REPO = '/repos/noriakiumei/oyasumidopatec._2026p2hacks';

before(async () => {
  const discordUrl = await listen(discord);
  env = {
    DISCORD_API_URL: `${discordUrl}/api`,
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_REVIEW_CHANNEL_ID: FORUM_ID,
    DISCORD_MEMBERS: JSON.stringify({ iuti: '111', noriakiumei: '222' }),
    ANTHROPIC_API_KEY: 'test-llm-key',
    ANTHROPIC_API_URL: await listen(anthropic),
    GITHUB_API_URL: await listen(githubApi),
  };
  for (const n of [31, 32, 33, 34]) {
    ghRoutes.set(`GET ${API_REPO}/pulls/${n}`, (req) =>
      req.headers.accept === 'application/vnd.github.diff'
        ? `diff --git a/app.js b/app.js\n+ガチャのボタン ${n}`
        : { title: `ガチャ ${n}`, body: '試し方：https://preview.example/31 を開く', user: { login: 'iuti' }, additions: 10, deletions: 2, changed_files: 1 },
    );
  }
});

after(() => {
  discord.close();
  anthropic.close();
  githubApi.close();
});

// ---------- #21 レビュー依頼に PR の要約 ----------

test('PR のレビューを頼むと、差分を上位モデルで要約して依頼文に添える', async () => {
  llm.reply = () => ({ changed: 'ガチャのボタンを足した', look_at: 'app.js のボタンの位置', try_it: 'https://preview.example/31 を開く' });
  const r = await call('request_review', { to: ['iuti'], title: 'ガチャ', url: `${REPO}/pull/31`, message: '見てね' });
  assert.equal(r.created, true);
  assert.match(r.summary, /^・変わったこと：ガチャのボタンを足した\n・見てほしいところ：app\.js のボタンの位置\n・試し方：/);
  const content = sent.at(-1).content;
  assert.match(content, /\*\*ネムの3行まとめ（差分から）\*\*\n・変わったこと：ガチャのボタンを足した/);
  assert.ok(content.indexOf('ネムの3行まとめ') < content.indexOf('見てね'));

  // GitHub から PR の中身と差分を読んだ
  assert.ok(ghRequests.some((x) => x.key === `GET ${API_REPO}/pulls/31` && x.headers.accept === 'application/vnd.github.diff'));
  // Claude API への頼み方
  const { headers, body } = llmRequests.at(-1);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.equal(headers['anthropic-version'], '2026-10-21');
  assert.equal(headers['anthropic-beta'], 'server-side-fallback-2026-07-01');
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.equal(body.output_config.effort, 'medium');
  assert.match(body.messages[0].content, /<diff>\ndiff --git a\/app\.js/);
  assert.equal(body.thinking, undefined);
});

test('LLM が失敗しても、要約なしでレビュー依頼は届く', async () => {
  llm.reply = () => ({ status: 400, json: { type: 'error', error: { type: 'invalid_request_error', message: 'だめ' } } });
  const before = sent.length;
  const r = await call('request_review', { to: ['iuti'], title: 'ガチャ', url: `${REPO}/pull/32`, message: '見てね' });
  assert.equal(r.summary, null);
  assert.match(r.summary_error, /400/);
  assert.equal(sent.length, before + 1);
  assert.ok(!sent.at(-1).content.includes('ネムの3行まとめ'));
});

test('LLM が断ったとき（refusal）も、要約なしで届く', async () => {
  const orig = llm.reply;
  llm.reply = () => ({ status: 200, json: { content: [], stop_reason: 'refusal', stop_details: { category: 'cyber' }, usage: {} } });
  const r = await call('request_review', { to: ['iuti'], title: 'ガチャ', url: `${REPO}/pull/33`, message: '見てね' });
  assert.match(r.summary_error, /答えなかった（cyber）/);
  llm.reply = orig;
});

test('API キーが無いとき・summarize: false のとき・PR でないときは LLM を呼ばない', async () => {
  const before = llmRequests.length;
  const noKey = { ...env, ANTHROPIC_API_KEY: '' };
  const a = await call('request_review', { to: ['iuti'], title: 'ガチャ', url: `${REPO}/pull/34`, message: 'a' }, noKey);
  assert.equal(a.summary, null);
  assert.equal(a.summary_error, undefined);
  await call('request_review', { to: ['iuti'], title: 'ガチャ', url: `${REPO}/pull/34`, message: 'b', summarize: false });
  await call('request_review', { to: ['iuti'], title: '相談', url: `${REPO}/issues/5`, message: 'c', kind: 'consult' });
  assert.equal(llmRequests.length, before);
});

// ---------- #23 ダイジェストの投稿（文は Dot などが作る） ----------

test('ダイジェストは AI を使わず、フォーラムの「ダイジェスト」スレッドに書く。@ログイン名は名前になり、通知はしない', async () => {
  const before = llmRequests.length;
  const r = await call('post_digest', { title: '11/28 朝のダイジェスト', content: '**進んだこと**\n・#31 ガチャ（@iuti）がマージされた\n・`@iuti` はそのまま、@someone も' });
  assert.equal(r.posted, true);
  assert.equal(llmRequests.length, before);
  const thread = [...channels.values()].find((c) => c.name === 'ダイジェスト');
  assert.ok(thread);
  const post = messages.get(thread.id).at(-1);
  assert.equal(post.content, '📰 **11/28 朝のダイジェスト**\n**進んだこと**\n・#31 ガチャ（<@111>）がマージされた\n・`@iuti` はそのまま、@someone も');
  assert.deepEqual(post.allowed_mentions, { parse: [] });
  assert.match(r.url, new RegExp(`/${thread.id}/${post.id}$`));

  // 2回目も同じスレッド（閉じていても開いて書く）
  thread.thread_metadata.archived = true;
  await call('post_digest', { content: '夕方の分' });
  assert.equal([...channels.values()].filter((c) => c.name === 'ダイジェスト').length, 1);
  assert.equal(messages.get(thread.id).at(-1).content, '夕方の分');
});

test('DISCORD_DIGEST_CHANNEL_ID があればそのチャンネルに書く。空・長すぎる文はエラー', async () => {
  channels.set('500', { id: '500', type: 0, guild_id: '1', name: 'ダイジェスト' });
  const e = { ...env, DISCORD_DIGEST_CHANNEL_ID: '500' };
  await call('post_digest', { content: 'チャンネルへ' }, e);
  assert.equal(messages.get('500').at(-1).content, 'チャンネルへ');
  assert.match((await call('post_digest', { content: ' ' }, e)).error, /空/);
  assert.match((await call('post_digest', { content: 'あ'.repeat(2001) }, e)).error, /長すぎる（2001 文字）/);
});

// ---------- #24 Issue の分解と担当提案 ----------

const plan = {
  summary: 'ガチャ画面、4つに割ってみたよ⚡',
  subtasks: [
    { title: 'ガチャのボタンを置く', what: 'ボタンだけ置く', done: '押すとログが出る', size: 'S', depends_on: [], assignee: '@iuti', why: '担当が少ない' },
    { title: '結果画面', what: '結果を出す', done: 'スマホで見える', size: 'M', depends_on: [1], assignee: '', why: '' },
  ],
  questions: ['演出の長さは何秒？'],
};

test('分解：AI の案を GitHub のコメント用の文にし、Issue のスレッドにネムが一言書く', async () => {
  const s = await call('sync_issue', { url: `${REPO}/issues/40`, title: 'ガチャ画面', state: 'open' });
  llm.reply = () => plan;
  const team = { open_issues_and_prs: [{ number: 12, title: 'ログイン', assignees: ['noriakiumei'] }], recent_merged_prs: [{ number: 9, title: 'ガチャの素材', by: 'iuti' }] };
  const r = await call('split_issue', { url: `${REPO}/issues/40`, title: 'ガチャ画面', body: 'ガチャを引けるようにする', team });

  const { body } = llmRequests.at(-1);
  assert.equal(body.model, 'claude-opus-5-5');
  assert.match(body.system, /ネム/);
  assert.match(body.messages[0].content, /チームの GitHub ログイン名：iuti, noriakiumei/);
  assert.match(body.messages[0].content, /"title":"ログイン","assignees":\["noriakiumei"\]/);
  assert.match(body.messages[0].content, /<issue number="40" title="ガチャ画面">\nガチャを引けるようにする/);

  assert.equal(r.comment_url, null); // GITHUB_TOKEN が無いので、コメントは呼んだ側が書く
  assert.equal(r.subtasks, 2);
  assert.match(r.comment, /^### 🧩 #40 の分け方の提案（NEMU）\n\n1\. \*\*ガチャのボタンを置く\*\*（目安 S：半日まで、担当候補 iuti）\n {3}- やること：ボタンだけ置く/);
  assert.ok(!r.comment.includes('@iuti')); // GitHub で通知を飛ばさない
  assert.match(r.comment, /2\. \*\*結果画面\*\*（目安 M：1日くらい）\n.*\n.*\n {3}- 先に終わっている必要があるもの：1/);
  assert.match(r.comment, /\*\*人に決めてほしいこと\*\*\n- 演出の長さは何秒？/);

  assert.equal(r.thread_url.endsWith(`/${s.thread_id}`), true);
  const said = messages.get(s.thread_id).at(-1);
  assert.match(said.content, /^ガチャ画面、4つに割ってみたよ⚡\nサブタスク 2 個の案は Issue のコメントにあるよ：/);
  assert.deepEqual(said.allowed_mentions, { parse: [] });
});

test('分解：title が無ければ GitHub から読み、GITHUB_TOKEN があれば NEMU がコメントする', async () => {
  ghRoutes.set(`GET ${API_REPO}/issues/41`, () => ({ title: '音まわり', body: 'BGM と効果音' }));
  ghRoutes.set(`POST ${API_REPO}/issues/41/comments`, (req, b) => ({ html_url: `${REPO}/issues/41#issuecomment-1`, body: b.body }));
  llm.reply = () => plan;
  const r = await call('split_issue', { url: `${REPO}/issues/41` }, { ...env, GITHUB_TOKEN: 'gh-test' });
  assert.match(llmRequests.at(-1).body.messages[0].content, /<issue number="41" title="音まわり">\nBGM と効果音/);
  assert.equal(r.comment_url, `${REPO}/issues/41#issuecomment-1`);
  const posted = ghRequests.findLast((x) => x.key === `POST ${API_REPO}/issues/41/comments`);
  assert.equal(posted.body.body, r.comment);
  assert.equal(r.thread_url, null); // スレッドが無ければ書かない
  assert.match((await call('split_issue', { url: `${REPO}/pull/41` })).error, /Issue の URL ではない/);
});
