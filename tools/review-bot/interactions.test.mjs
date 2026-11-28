// Discord のコマンド（感想 → Issue、#22）を、偽の Discord・偽の Claude API・偽の GitHub を相手に確かめる。
// node --test tools/review-bot/interactions.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import worker from './worker.mjs';
import { FORUM_ID, APP_ID, webhookEdits, webhookPosts, discord, channels, messages } from './fake-discord.mjs';
import { anthropic, githubApi, llm, llmRequests, ghRoutes, ghRequests, listen } from './fake-apis.mjs';

const KEY = 'test-access-key-1234567890';
const API_REPO = '/repos/noriakiumei/OyasumiDopaTec._2026P2HACKS';
let env;
let keys;
let publicKey;

before(async () => {
  keys = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  publicKey = Buffer.from(await crypto.subtle.exportKey('raw', keys.publicKey)).toString('hex');
  env = {
    DISCORD_API_URL: `${await listen(discord)}/api`,
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_REVIEW_CHANNEL_ID: FORUM_ID,
    DISCORD_MEMBERS: JSON.stringify({ iuti: '111' }),
    DISCORD_PUBLIC_KEY: publicKey,
    ACCESS_KEY: KEY,
    ANTHROPIC_API_KEY: 'test-llm-key',
    ANTHROPIC_API_URL: await listen(anthropic),
    GITHUB_API_URL: await listen(githubApi),
  };
  ghRoutes.set(`GET ${API_REPO}/issues`, () => [
    { number: 7, title: 'ガチャのボタンが押せない' },
    { number: 8, title: 'PR です', pull_request: {} },
  ]);
  ghRoutes.set(`GET ${API_REPO}/issues/7`, () => ({ number: 7, title: 'ガチャのボタンが押せない', state: 'open', body: 'ガチャ画面のボタンが反応しない' }));
  // 「Issue にする」を押すメッセージ（777）がある、Issue #7 のスレッドと、その前後の会話
  const kousuke = { id: '111', username: 'iuti', global_name: 'こうのすけ' };
  channels.set('300', { id: '300', type: 11, guild_id: '1', parent_id: FORUM_ID, name: '#7 ガチャのボタンが押せない', thread_metadata: { archived: false } });
  messages.set('300', [
    { id: '770', type: 0, author: kousuke, content: 'ボタン直したから、ガチャ画面もう一回見てほしい', timestamp: '2026-11-28T02:00:00Z', mentions: [], attachments: [] },
    { id: '777', type: 0, author: { id: '222', username: 'uma', global_name: '梅' }, content: 'ガチャ引いたら結果が真っ白', timestamp: '2026-11-28T02:05:00Z', mentions: [], attachments: [{ url: 'https://cdn.example/a.png' }] },
    { id: '780', type: 0, author: { id: '999', username: 'NEMU.', bot: true }, content: '<@111> 見てあげて', timestamp: '2026-11-28T02:06:00Z', mentions: [kousuke], attachments: [] },
  ]);
  ghRoutes.set(`POST ${API_REPO}/issues`, (req, body) => ({ number: 40, html_url: 'https://github.com/noriakiumei/OyasumiDopaTec._2026P2HACKS/issues/40', ...body }));
});

after(() => {
  discord.close();
  anthropic.close();
  githubApi.close();
});

// Discord と同じように署名して送る。waitUntil に渡された仕事が終わるまで待てるようにする
async function send(body, { sign = true, e = env } = {}) {
  const text = JSON.stringify(body);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sig = sign ? Buffer.from(await crypto.subtle.sign('Ed25519', keys.privateKey, new TextEncoder().encode(timestamp + text))).toString('hex') : '00'.repeat(64);
  const jobs = [];
  const res = await worker.fetch(
    new Request('https://review-bot.example/discord/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': timestamp },
      body: text,
    }),
    e,
    { waitUntil: (p) => jobs.push(p) },
  );
  await Promise.all(jobs);
  return res;
}

const messageCommand = (content, token = 'tok-msg') => ({
  type: 2,
  application_id: APP_ID,
  token,
  guild_id: '1',
  channel_id: '300',
  member: { user: { id: '111', username: 'iuti', global_name: 'こうのすけ' } },
  data: {
    type: 3,
    name: 'Issue にする',
    target_id: '777',
    resolved: { messages: { 777: { id: '777', channel_id: '300', content, author: { id: '222', username: 'uma', global_name: '梅' }, attachments: [{ url: 'https://cdn.example/a.png' }] } } },
  },
});

const draft = { title: 'ガチャの結果画面が真っ白になるのを直す', kind: '不具合', body: '### 何が起きたか\n結果画面が白い\n\n### 再現手順\n1. ガチャを引く', duplicate_of: 7 };

test('署名が違うと 401、PING には PONG', async () => {
  assert.equal((await send({ type: 1 }, { sign: false })).status, 401);
  const res = await send({ type: 1 });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { type: 1 });
});

test('メッセージを「Issue にする」と、AI が整えて起票し、返事を書き換える（GITHUB_TOKEN あり）', async () => {
  llm.reply = () => draft;
  const res = await send(messageCommand('ガチャ引いたら結果が真っ白 @everyone'), { e: { ...env, GITHUB_TOKEN: 'gh-test' } });
  assert.deepEqual(await res.json(), { type: 5, data: { flags: 64 } }); // まず「考え中…」。押した人だけに見える

  // 上位モデルに、開いている Issue（PR は除く）・スレッドの Issue・前後の会話・感想を渡した
  const { body } = llmRequests.at(-1);
  assert.equal(body.model, 'claude-opus-5-5');
  const prompt = body.messages[0].content;
  assert.match(prompt, /#7 ガチャのボタンが押せない/);
  assert.ok(!prompt.includes('PR です'));
  assert.match(prompt, /<thread_issue number="7" kind="Issue" state="open" title="ガチャのボタンが押せない">\nガチャ画面のボタンが反応しない/);
  assert.match(prompt, /<conversation place="#7 ガチャのボタンが押せない">/);
  assert.match(prompt, /\] こうのすけ: ボタン直したから、ガチャ画面もう一回見てほしい/);
  assert.match(prompt, /★ \[[^\]]+\] 梅: ガチャ引いたら結果が真っ白（添付 1 件）/);
  assert.match(prompt, /NEMU\.（ボット）: @こうのすけ 見てあげて/);
  assert.ok(prompt.indexOf('ボタン直した') < prompt.indexOf('★'), '会話は古い順');
  assert.match(prompt, /<feedback author="梅">\nガチャ引いたら結果が真っ白/);

  // 起票した中身
  const created = ghRequests.findLast((x) => x.key === `POST ${API_REPO}/issues`);
  assert.equal(created.headers.authorization, 'Bearer gh-test');
  assert.equal(created.body.title, draft.title);
  assert.deepEqual(created.body.labels, ['不具合']);
  assert.match(created.body.body, /### 再現手順/);
  assert.match(created.body.body, /Discord で 梅 が書いた感想から/);
  assert.match(created.body.body, /https:\/\/discord\.com\/channels\/1\/300\/777/);
  assert.match(created.body.body, /- https:\/\/cdn\.example\/a\.png/);
  assert.match(created.body.body, /> ガチャ引いたら結果が真っ白/);

  // 返事
  const edit = webhookEdits.at(-1);
  assert.equal(edit.token, 'tok-msg');
  assert.match(edit.body.content, /Issue にしたよ！⚡（こうのすけ から）：\*\*#40 /);
  assert.match(edit.body.content, /似た Issue がもうあるかも👀：#7/);
  assert.deepEqual(edit.body.allowed_mentions, { parse: [] });
  assert.equal(edit.body.components[0].components[0].url, 'https://github.com/noriakiumei/OyasumiDopaTec._2026P2HACKS/issues/40');

  // みんなには一言だけ（プレビューなしのリンク、メンションなし）
  const post = webhookPosts.at(-1);
  assert.equal(post.token, 'tok-msg');
  assert.equal(post.body.content, `📝 梅 の感想から Issue 立てたよ！⚡ [#40 ${draft.title}](<https://github.com/noriakiumei/OyasumiDopaTec._2026P2HACKS/issues/40>)`);
  assert.equal(post.body.flags, undefined);
  assert.deepEqual(post.body.allowed_mentions, { parse: [] });
});

test('/issue で書いた文も Issue にできる。GITHUB_TOKEN が無ければ、作成ページのボタンと本文を返す', async () => {
  llm.reply = () => ({ ...draft, kind: '機能', title: '音を消せるようにする', duplicate_of: null });
  const before = ghRequests.filter((x) => x.key.startsWith('POST')).length;
  await send({
    type: 2,
    application_id: APP_ID,
    token: 'tok-slash',
    guild_id: '1',
    channel_id: '300',
    member: { user: { id: '111', username: 'iuti' } },
    data: { type: 1, name: 'issue', options: [{ name: 'text', type: 3, value: '音うるさいから消したい' }] },
  });
  assert.equal(ghRequests.filter((x) => x.key.startsWith('POST')).length, before); // 起票はしない
  assert.ok(!webhookPosts.some((x) => x.token === 'tok-slash'), '下書きだけのときは、みんなには何も出さない');
  const edit = webhookEdits.at(-1);
  assert.equal(edit.token, 'tok-slash');
  assert.match(edit.body.content, /下書きできたよ（iuti から）：\*\*音を消せるようにする\*\*/);
  assert.match(edit.body.content, /```md\n### 何が起きたか/);
  assert.ok(!edit.body.content.includes('似た Issue'));
  const url = new URL(edit.body.components[0].components[0].url);
  assert.equal(url.pathname, '/noriakiumei/OyasumiDopaTec._2026P2HACKS/issues/new');
  assert.equal(url.searchParams.get('title'), '音を消せるようにする');
  assert.equal(url.searchParams.get('labels'), '機能');
});

test('AI が失敗したら、その旨に書き換える。API キーが無ければすぐ断る', async () => {
  llm.reply = () => ({ status: 400, json: { type: 'error' } });
  await send(messageCommand('なにか', 'tok-fail'));
  assert.match(webhookEdits.at(-1).body.content, /Issue にできなかった（LLM .* 400/);
  const res = await send(messageCommand('なにか'), { e: { ...env, ANTHROPIC_API_KEY: '' } });
  const body = await res.json();
  assert.equal(body.type, 4);
  assert.equal(body.data.flags, 64);
  assert.match(body.data.content, /ANTHROPIC_API_KEY/);
});

test('/discord/setup/<鍵> でコマンドを登録する。鍵が違うと 401', async () => {
  assert.equal((await worker.fetch(new Request('https://review-bot.example/discord/setup/nope'), env)).status, 401);
  const res = await worker.fetch(new Request(`https://review-bot.example/discord/setup/${KEY}`), env);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.application_id, APP_ID);
  assert.deepEqual(body.commands, ['Issue にする', 'issue']);
});
