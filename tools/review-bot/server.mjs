#!/usr/bin/env node
// レビュー依頼ボットの MCP サーバー（stdio、手元で動かす版）。道具の中身は core.mjs。
// ふだんはネット上の版（worker.mjs）を使う。これはデプロイ前の確認や、ボットの最初の接続（check）に使う。
// 依存パッケージなし（Node 22 以上の fetch と WebSocket を使う）。
//
//   node tools/review-bot/server.mjs         MCP サーバーとして動く（エージェントから起動される）
//   node tools/review-bot/server.mjs check   設定を確かめる（最初に1回。ボットを Discord に接続する）
//
// 設定は環境変数か、このファイルと同じフォルダの .env（コミットしない）。書き方は README.md。

import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadConfig, handle, channel, discord } from './core.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const envFile = join(here, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const GATEWAY = process.env.DISCORD_GATEWAY_URL || 'wss://gateway.discord.gg/?v=10&encoding=json';
const FORUM = 15;

// ---------- MCP（1行に1メッセージ） ----------

function serve() {
  const rl = createInterface({ input: process.stdin });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON として読めない' } }) + '\n');
    }
    const res = await handle(msg, process.env);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
}

// ---------- check ----------

// Discord は、一度もゲートウェイに接続したことのないボットにはメッセージを送らせない。1回つないで切る。
function connectGateway(token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(GATEWAY);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('ゲートウェイの応答がない'));
    }, 20000);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.op === 10) ws.send(JSON.stringify({ op: 2, d: { token, intents: 0, properties: { os: 'linux', browser: 'review-bot', device: 'review-bot' } } }));
      if (msg.t === 'READY') {
        clearTimeout(timer);
        ws.close();
        resolve(msg.d.user);
      }
    };
    ws.onclose = (ev) => {
      clearTimeout(timer);
      if (ev.code >= 4000) reject(new Error(`ゲートウェイに切られた（${ev.code} ${ev.reason}）。トークンを確かめてね`));
    };
  });
}

async function check() {
  const cfg = loadConfig(process.env);
  const user = await connectGateway(cfg.token);
  console.log(`✓ ボット: ${user.username}`);
  const ch = await channel(cfg);
  console.log(`✓ チャンネル: #${ch.name}（${ch.type === FORUM ? 'フォーラム' : 'テキスト'}）`);
  const logins = Object.keys(cfg.members);
  if (!logins.length) console.log('！ DISCORD_MEMBERS が空なので、だれも呼べない');
  for (const [login, id] of Object.entries(cfg.members)) {
    const m = await discord(cfg, 'GET', `/guilds/${ch.guild_id}/members/${id}`).catch(() => null);
    console.log(m ? `✓ ${login} → ${m.nick || m.user.global_name || m.user.username}` : `！ ${login} → ${id} が見つからない（サーバーにいないか、ID が違う）`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === 'check') {
    check().catch((e) => {
      console.error(`✗ ${e.message}`);
      process.exit(1);
    });
  } else {
    serve();
  }
}
