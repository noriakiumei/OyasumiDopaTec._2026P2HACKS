// テスト用の偽の Claude API と偽の GitHub API（HTTP サーバー）。fake-discord.mjs と同じように使う。

import { createServer } from 'node:http';

const readBody = async (req) => {
  let body = '';
  for await (const c of req) body += c;
  return body ? JSON.parse(body) : undefined;
};

// ---------- Claude API ----------

export const llmRequests = []; // 受け取ったリクエスト（{ headers, body }）
// 答え方。テストで差し替える。(body) => 文字列（text の答え）か { status, json }
export const llm = { reply: () => 'はい' };

export const anthropic = createServer(async (req, res) => {
  const body = await readBody(req);
  llmRequests.push({ headers: req.headers, body });
  const send = (code, data) => {
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };
  if (req.headers['x-api-key'] !== 'test-llm-key') return send(401, { type: 'error', error: { type: 'authentication_error' } });
  const r = await llm.reply(body);
  if (typeof r === 'object' && r.status) return send(r.status, r.json ?? { type: 'error' });
  const text = typeof r === 'string' ? r : JSON.stringify(r);
  send(200, {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: body.model,
    // 本物と同じく、考えた跡のブロックが先に来ることがある
    content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'text', text }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10, output_tokens: 5 },
  });
});

// ---------- GitHub API ----------

export const ghRequests = [];
// 'GET /repos/o/r/pulls/1' → (req, body) => 返すもの。diff を求められたら diff の文字列を返す
export const ghRoutes = new Map();

export const githubApi = createServer(async (req, res) => {
  const body = await readBody(req);
  const url = new URL(req.url, 'http://x');
  const key = `${req.method} ${url.pathname}`;
  ghRequests.push({ key, headers: req.headers, body, query: url.searchParams });
  const route = ghRoutes.get(key);
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: `偽の GitHub に無い: ${key}` }));
  }
  const out = await route(req, body, url);
  if (typeof out === 'string') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end(out);
  }
  res.writeHead(out?.status || 200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(out?.json ?? out));
});

export const listen = (server) => new Promise((r) => server.listen(0, () => r(`http://127.0.0.1:${server.address().port}`)));
