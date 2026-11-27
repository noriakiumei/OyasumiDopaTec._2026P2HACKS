// ネット上の版（worker.mjs）を、偽の Discord を相手に確かめる。
// node --test tools/review-bot/worker.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import worker from './worker.mjs';
import { FORUM_ID, sent, discord } from './fake-discord.mjs';

let env;
const KEY = 'test-access-key-1234567890';

before(async () => {
  await new Promise((r) => discord.listen(0, r));
  env = {
    DISCORD_API_URL: `http://127.0.0.1:${discord.address().port}/api`,
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_REVIEW_CHANNEL_ID: FORUM_ID,
    DISCORD_MEMBERS: JSON.stringify({ iuti: '111' }),
    ACCESS_KEY: KEY,
  };
});

after(() => discord.close());

const post = (path, body, headers = {}) =>
  worker.fetch(
    new Request(`https://review-bot.example${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
      body: JSON.stringify(body),
    }),
    env,
  );

test('鍵が無い・違うと 401 で、Discord には何も送らない', async () => {
  const before = sent.length;
  assert.equal((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  assert.equal((await post('/mcp/wrong-key', { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status, 401);
  assert.equal((await post('/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }, { Authorization: 'Bearer nope' })).status, 401);
  assert.equal(sent.length, before);
});

test('URL の鍵で initialize と道具の一覧が返る', async () => {
  const init = await (await post(`/mcp/${KEY}`, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json();
  assert.equal(init.result.serverInfo.name, 'review-bot');
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const list = await (await post(`/mcp/${KEY}`, { jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
  assert.equal(list.result.tools.length, 5);
  assert.match(list.result.tools[0].description, /iuti/);
});

test('鍵の前後の空白や改行は無視する。ほかのパスは 404（OAuth を探されても勘違いさせない）', async () => {
  const res = await worker.fetch(
    new Request(`https://review-bot.example/mcp/${KEY}`, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) }),
    { ...env, ACCESS_KEY: ` ${KEY}\n` },
  );
  assert.equal(res.status, 200);
  const wk = await worker.fetch(new Request('https://review-bot.example/.well-known/oauth-protected-resource'), env);
  assert.equal(wk.status, 404);
  assert.equal((await worker.fetch(new Request('https://review-bot.example/'), env)).status, 200);
});

test('通知だけなら 202 で本文なし、GET は 405', async () => {
  const res = await post(`/mcp/${KEY}`, { jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(res.status, 202);
  const get = await worker.fetch(new Request(`https://review-bot.example/mcp/${KEY}`), env);
  assert.equal(get.status, 405);
});

test('Bearer の鍵でレビューを頼むと、偽の Discord にスレッドができる', async () => {
  const res = await post(
    '/mcp',
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'request_review', arguments: { to: ['iuti'], title: 'PR #1', url: 'https://example.com/pr/1', message: 'テスト' } } },
    { Authorization: `Bearer ${KEY}` },
  );
  const r = JSON.parse((await res.json()).result.content[0].text);
  assert.equal(r.created, true);
  assert.match(sent.at(-1).content, /^<@111> レビューをお願い！/);
});

test('まとめて送ると、まとめて返る', async () => {
  const res = await post(`/mcp/${KEY}`, [
    { jsonrpc: '2.0', id: 10, method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 11, method: 'ping' },
  ]);
  const body = await res.json();
  assert.deepEqual(body.map((x) => x.id), [10, 11]);
});
