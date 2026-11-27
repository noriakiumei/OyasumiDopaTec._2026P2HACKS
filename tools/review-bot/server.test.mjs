// 偽の Discord を立てて、MCP サーバーを stdio で動かして確かめる。
// node --test tools/review-bot/server.test.mjs

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

import { GUILD, FORUM_ID, channels, sent, addMessage, discord } from './fake-discord.mjs';

// ---------- MCP サーバーを動かす ----------

let proc;
let lines;
let rpcId = 0;
const waiting = new Map();

function start(extraEnv) {
  const p = spawn(process.execPath, [fileURLToPath(new URL('./server.mjs', import.meta.url))], {
    env: { PATH: process.env.PATH, ...extraEnv },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const rl = createInterface({ input: p.stdout });
  rl.on('line', (l) => {
    const msg = JSON.parse(l);
    waiting.get(msg.id)?.(msg);
    waiting.delete(msg.id);
  });
  return p;
}

function rpc(p, method, params) {
  const id = ++rpcId;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

async function call(name, args, p = proc) {
  const res = await rpc(p, 'tools/call', { name, arguments: args });
  const text = res.result.content[0].text;
  return res.result.isError ? { error: text } : JSON.parse(text);
}

before(async () => {
  await new Promise((r) => discord.listen(0, r));
  proc = start({
    DISCORD_API_URL: `http://127.0.0.1:${discord.address().port}/api`,
    DISCORD_BOT_TOKEN: 'test-token',
    DISCORD_REVIEW_CHANNEL_ID: FORUM_ID,
    DISCORD_MEMBERS: JSON.stringify({ iuti: '111', NoriakiUmei: '222' }),
  });
});

after(() => {
  proc.kill();
  discord.close();
});

// ---------- テスト ----------

const PR = 'https://github.com/noriakiumei/oyasumidopatec._2026p2hacks/pull/99';

test('initialize と道具の一覧', async () => {
  const init = await rpc(proc, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.serverInfo.name, 'review-bot');
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  const list = await rpc(proc, 'tools/list', {});
  const names = list.result.tools.map((t) => t.name);
  assert.deepEqual(names, ['request_review', 'read_replies', 'post_to_thread', 'close_review', 'list_reviews']);
  assert.match(list.result.tools[0].description, /iuti, noriakiumei/);
});

let threadId;

test('レビューを頼むと、メンション付きでスレッドができる', async () => {
  const r = await call('request_review', { to: ['iuti'], title: 'PR #99 ログイン画面', url: PR, message: '試し方：…\n見てほしいこと：…', from: 'chico' });
  assert.equal(r.created, true);
  assert.deepEqual(r.mentioned, ['iuti']);
  assert.equal(r.thread_url, `https://discord.com/channels/${GUILD}/${r.thread_id}`);
  threadId = r.thread_id;
  const first = sent.at(-1);
  assert.match(first.content, /^<@111> レビューをお願い！（chico より）\n/);
  assert.ok(first.content.includes(PR));
  assert.deepEqual(first.allowed_mentions, { users: ['111'] });
  assert.equal(channels.get(threadId).name, 'PR #99 ログイン画面');
});

test('同じ URL でもう一度頼むと、同じスレッドに書く（大文字のログイン名でも呼べる）', async () => {
  const r = await call('request_review', { to: ['@NoriakiUmei'], title: 'PR #99 ログイン画面', url: PR, message: '直したので見てほしい' });
  assert.equal(r.created, false);
  assert.equal(r.thread_id, threadId);
  assert.match(sent.at(-1).content, /^<@222> /);
});

test('人の返信だけを読めて、after で続きだけ読める', async () => {
  addMessage(threadId, { id: '111', username: 'chico', global_name: 'ちこ' }, { content: 'ボタンが小さいかも' });
  const r = await call('read_replies', { thread: PR });
  assert.equal(r.replies.length, 1);
  assert.equal(r.replies[0].content, 'ボタンが小さいかも');
  assert.equal(r.replies[0].author, 'ちこ');
  assert.equal(r.replies[0].github, 'iuti');
  const again = await call('read_replies', { thread: threadId, after: r.last_id });
  assert.equal(again.replies.length, 0);
  assert.equal(again.last_id, r.last_id);
});

test('スレッドに書ける（スレッドの URL でも指定できる）', async () => {
  const r = await call('post_to_thread', { thread: `https://discord.com/channels/${GUILD}/${threadId}`, message: '大きくしたよ', mention: ['iuti'] });
  assert.equal(r.thread_id, threadId);
  assert.equal(sent.at(-1).content, '<@111> 大きくしたよ');
});

test('一覧に出て、閉じると消え、また頼むと同じスレッドが開く', async () => {
  let l = await call('list_reviews', {});
  assert.equal(l.reviews.length, 1);
  assert.equal(l.reviews[0].url, PR);
  const c = await call('close_review', { thread: PR, message: 'マージされたので閉じるね' });
  assert.equal(c.closed, true);
  assert.equal(channels.get(threadId).thread_metadata.archived, true);
  l = await call('list_reviews', {});
  assert.equal(l.reviews.length, 0);
  const r = await call('request_review', { to: ['all'], title: 'PR #99', url: PR, message: 'もう一度' });
  assert.equal(r.thread_id, threadId);
  assert.equal(r.created, false);
  assert.deepEqual(r.mentioned.sort(), ['iuti', 'noriakiumei']);
  assert.equal(channels.get(threadId).thread_metadata.archived, false);
});

test('知らない人だけを呼ぶとエラーになり、何も送らない', async () => {
  const before = sent.length;
  const r = await call('request_review', { to: ['someone'], title: 't', url: 'https://example.com/x', message: 'm' });
  assert.match(r.error, /呼べる人がいない/);
  assert.equal(sent.length, before);
});

test('設定が無いときは、道具がエラーで設定の仕方を返す', async () => {
  const p = start({});
  const r = await call('list_reviews', {}, p);
  assert.match(r.error, /DISCORD_BOT_TOKEN と DISCORD_REVIEW_CHANNEL_ID が無い/);
  const list = await rpc(p, 'tools/list', {});
  assert.equal(list.result.tools.length, 5);
  p.kill();
});
