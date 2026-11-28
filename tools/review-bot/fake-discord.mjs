// テスト用の偽の Discord（HTTP サーバー）。server.test.mjs と worker.test.mjs で使う。

import { createServer } from 'node:http';

export const GUILD = '1';
export const FORUM_ID = '100';
export const BOT = { id: '999', username: 'review-bot', bot: true };
let nextId = 1000;
export const channels = new Map([[FORUM_ID, { id: FORUM_ID, type: 15, guild_id: GUILD, name: 'レビュー依頼' }]]);
export const messages = new Map(); // チャンネル ID → メッセージの配列
export const sent = []; // 送られたメッセージ（allowed_mentions を確かめる）
export const APP_ID = '555';
export const webhookEdits = []; // コマンドの返事の書き換え（{ token, body }）
export const webhookPosts = []; // コマンドの追いの投稿（{ token, body }）
export let commands = [];

export function addMessage(channelId, author, body) {
  const m = { id: String(nextId++), type: 0, author, content: body.content, timestamp: new Date().toISOString(), attachments: [], allowed_mentions: body.allowed_mentions };
  if (!messages.has(channelId)) messages.set(channelId, []);
  messages.get(channelId).push(m);
  const t = channels.get(channelId);
  if (t?.thread_metadata) {
    t.last_message_id = m.id;
    t.thread_metadata.archived = false; // 書き込むと開く
  }
  return m;
}

export const discord = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname.replace(/^\/api/, '');
  let body = '';
  for await (const c of req) body += c;
  body = body ? JSON.parse(body) : undefined;
  const send = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(data === undefined ? '' : JSON.stringify(data));
  };
  let m;
  // コマンドの返事の書き換えは、ボットのトークンが無くても通る
  if ((m = p.match(/^\/webhooks\/(\d+)\/([^/]+)\/messages\/@original$/)) && req.method === 'PATCH') {
    if (m[1] !== APP_ID) return send(404, { message: 'Unknown Webhook' });
    webhookEdits.push({ token: m[2], body });
    return send(200, { id: '1', ...body });
  }
  if ((m = p.match(/^\/webhooks\/(\d+)\/([^/]+)$/)) && req.method === 'POST') {
    if (m[1] !== APP_ID) return send(404, { message: 'Unknown Webhook' });
    webhookPosts.push({ token: m[2], body });
    return send(200, { id: '2', ...body });
  }
  if (req.headers.authorization !== 'Bot test-token') return send(401, { message: 'Unauthorized' });
  if (req.method === 'GET' && p === '/applications/@me') return send(200, { id: APP_ID, name: 'NEMU.' });
  if (req.method === 'PUT' && p === `/applications/${APP_ID}/commands`) {
    commands = body.map((c, n) => ({ id: String(9000 + n), ...c }));
    return send(200, commands);
  }
  if (req.method === 'POST' && p === `/channels/${FORUM_ID}/threads`) {
    const id = String(nextId++);
    const t = { id, type: 11, guild_id: GUILD, parent_id: FORUM_ID, name: body.name, thread_metadata: { archived: false } };
    channels.set(id, t);
    nextId--; // 最初のメッセージの ID はスレッド ID と同じ
    sent.push(addMessage(id, BOT, body.message));
    return send(201, t);
  }
  if (req.method === 'GET' && p === `/guilds/${GUILD}/threads/active`) {
    return send(200, { threads: [...channels.values()].filter((c) => c.thread_metadata && !c.thread_metadata.archived) });
  }
  if (req.method === 'GET' && p === `/channels/${FORUM_ID}/threads/archived/public`) {
    return send(200, { threads: [...channels.values()].filter((c) => c.thread_metadata?.archived) });
  }
  if ((m = p.match(/^\/channels\/(\d+)\/messages\/(\d+)$/)) && req.method === 'GET') {
    const msg = (messages.get(m[1]) || []).find((x) => x.id === m[2]);
    return msg ? send(200, msg) : send(404, { message: 'Unknown Message' });
  }
  if ((m = p.match(/^\/channels\/(\d+)\/messages$/))) {
    if (!channels.has(m[1])) return send(404, { message: 'Unknown Channel' });
    if (req.method === 'POST') {
      const msg = addMessage(m[1], BOT, body);
      sent.push(msg);
      return send(200, msg);
    }
    const limit = Number(url.searchParams.get('limit') || 50);
    const all = messages.get(m[1]) || [];
    const around = url.searchParams.get('around');
    if (around) {
      const at = Math.max(0, all.findIndex((x) => x.id === around));
      const from = Math.max(0, at - Math.floor(limit / 2));
      return send(200, all.slice(from, from + limit).reverse());
    }
    const afterId = BigInt(url.searchParams.get('after') || '0');
    const list = all.filter((x) => BigInt(x.id) > afterId).reverse(); // 新しい順で返す
    return send(200, list.slice(0, limit));
  }
  if ((m = p.match(/^\/channels\/(\d+)$/))) {
    const c = channels.get(m[1]);
    if (!c) return send(404, { message: 'Unknown Channel' });
    if (req.method === 'PATCH') {
      if (body.name !== undefined) {
        if (c.thread_metadata.archived) return send(400, { message: 'Thread is archived' });
        c.name = body.name;
      }
      if (body.archived !== undefined) c.thread_metadata.archived = body.archived;
    }
    return send(200, c);
  }
  send(404, { message: `偽の Discord に無い: ${req.method} ${p}` });
});
