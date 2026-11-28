// レビュー依頼ボットの MCP サーバー（ネット上の版、Cloudflare Workers）。道具の中身は core.mjs。
// トークンはこのサーバーにだけ置くので、メンバーにトークンを配らなくていい。
// 各自のエージェントには、この URL を MCP サーバー（コネクタ）として1回登録するだけ。
//
//   POST /mcp/<ACCESS_KEY>   MCP（Streamable HTTP、JSON で返す。SSE は使わない）
//   POST /mcp                Authorization: Bearer <ACCESS_KEY> でも可
//   POST /discord/interactions        Discord のコマンド（interactions.mjs）
//   GET  /discord/setup/<ACCESS_KEY>  Discord にコマンドを登録する
//
// 設定（Cloudflare のシークレット）：DISCORD_BOT_TOKEN、DISCORD_REVIEW_CHANNEL_ID、DISCORD_MEMBERS、ACCESS_KEY

import { handle } from './core.mjs';
import { interactions, registerCommands } from './interactions.mjs';

function sameKey(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// 貼るときに混ざりやすい空白・改行・<> を除く
const cleanKey = (k) => (k || '').trim().replace(/^<|>$/g, '').trim();

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/discord/interactions' && request.method === 'POST') return interactions(request, env, ctx);
    const setup = url.pathname.match(/^\/discord\/setup\/([^/]+)$/);
    if (setup) {
      if (!sameKey(cleanKey(safeDecode(setup[1])), cleanKey(env.ACCESS_KEY))) return json({ error: '鍵が違う' }, 401);
      try {
        return json({ ok: true, ...(await registerCommands(env)) });
      } catch (e) {
        return json({ ok: false, error: e.message }, 500);
      }
    }
    if (url.pathname === '/') {
      return new Response('review-bot（レビュー依頼ボット）は動いているよ。MCP は /mcp/<鍵> で使ってね。\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    // /.well-known/oauth-* など。200 を返すと、クライアントが OAuth のサインインが要ると勘違いする
    const m = url.pathname.match(/^\/mcp(?:\/([^/]+))?\/?$/);
    if (!m) return json({ error: 'not found' }, 404);

    const bearer = request.headers.get('Authorization')?.match(/^Bearer\s+(.+)$/i)?.[1];
    if (!env.ACCESS_KEY) return json({ error: 'ACCESS_KEY が設定されていない' }, 500);
    const given = cleanKey(m[1] ? safeDecode(m[1]) : bearer);
    const expected = cleanKey(env.ACCESS_KEY);
    if (!sameKey(given, expected)) {
      // 鍵そのものは出さない。長さだけ Cloudflare のログに残して、貼り間違いを見つけやすくする
      console.log(`鍵が違う：受け取った長さ ${given.length}、設定の長さ ${expected.length}`);
      return json({ error: '鍵が違う' }, 401);
    }

    if (request.method === 'GET') return new Response(null, { status: 405, headers: { Allow: 'POST' } }); // SSE は使わない
    if (request.method === 'DELETE') return new Response(null, { status: 204 });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON として読めない' } }, 400);
    }
    const batch = Array.isArray(body);
    const results = (await Promise.all((batch ? body : [body]).map((msg) => handle(msg, env)))).filter(Boolean);
    if (!results.length) return new Response(null, { status: 202 }); // 通知だけなら返事なし
    return json(batch ? results : results[0]);
  },
};
