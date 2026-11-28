// LLM を使う機能を、偽の Discord・偽の Claude API・偽の GitHub を相手に確かめる。
// node --test tools/review-bot/llm.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { handle } from './core.mjs';
import { FORUM_ID, sent, discord } from './fake-discord.mjs';
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
  assert.match(content, /\*\*AI の要約（差分から）\*\*\n・変わったこと：ガチャのボタンを足した/);
  assert.ok(content.indexOf('AI の要約') < content.indexOf('見てね'));

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
  assert.ok(!sent.at(-1).content.includes('AI の要約'));
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
