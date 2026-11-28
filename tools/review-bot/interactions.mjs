// Discord のコマンド（Interactions）を受ける（#22）。
//   POST /discord/interactions        Discord から届く。署名（DISCORD_PUBLIC_KEY）で本物か確かめる
//   GET  /discord/setup/<ACCESS_KEY>  コマンドを Discord に登録する（最初とコマンドを変えたときに1回開く）
//
// コマンド
//   メッセージを右クリック →「アプリ」→「Issue にする」  そのメッセージを Issue にする
//   /issue 内容:<文>                                    書いた文を Issue にする

import { loadConfig, discord } from './core.mjs';
import { draftIssue, fileIssue } from './feedback.mjs';
import { NEMU } from './voice.mjs';

const PING = 1;
const COMMAND = 2;
const PONG = 1;
const REPLY = 4;
const DEFERRED = 5;
const EPHEMERAL = 64;

export const COMMANDS = [
  { type: 3, name: 'Issue にする', contexts: [0] },
  {
    type: 1,
    name: 'issue',
    description: '感想や不具合を書くと、AI が整えて GitHub の Issue にする',
    contexts: [0],
    options: [{ type: 3, name: 'text', name_localizations: { ja: '内容' }, description: '感想・不具合・やりたいこと（雑でいい）', required: true }],
  },
];

const fromHex = (hex) => new Uint8Array((hex.match(/../g) || []).map((b) => parseInt(b, 16)));

export async function verifyDiscord(publicKey, signature, timestamp, body) {
  if (!publicKey || !signature || !timestamp) return false;
  try {
    const key = await crypto.subtle.importKey('raw', fromHex(publicKey.trim()), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, fromHex(signature), new TextEncoder().encode(timestamp + body));
  } catch {
    return false;
  }
}

const respond = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const reply = (content, ephemeral = true) => respond({ type: REPLY, data: { content, flags: ephemeral ? EPHEMERAL : 0, allowed_mentions: { parse: [] } } });

const userName = (u) => u?.global_name || u?.username || '誰か';

// コマンドから、Issue にする文・書いた人・元のメッセージを取り出す
function feedbackFrom(i) {
  const guild = i.guild_id || '@me';
  if (i.data.type === 3) {
    const m = i.data.resolved?.messages?.[i.data.target_id];
    if (!m) return null;
    return {
      id: m.id,
      channel: m.channel_id || i.channel_id,
      text: m.content || '',
      author: userName(m.author),
      link: `https://discord.com/channels/${guild}/${m.channel_id || i.channel_id}/${m.id}`,
      attachments: (m.attachments || []).map((a) => a.url),
    };
  }
  const text = i.data.options?.find((o) => o.name === 'text')?.value || '';
  return { id: null, channel: i.channel_id, text, author: userName(i.member?.user || i.user), link: `https://discord.com/channels/${guild}/${i.channel_id}`, attachments: [] };
}

const CONTEXT_MESSAGES = 30; // 前後の会話を何件読むか（Discord は1回100件まで）

// メッセージの本文。<@123> のようなメンションは名前に直す
function plain(m) {
  const names = new Map((m.mentions || []).map((u) => [u.id, userName(u)]));
  const text = String(m.content || '').replace(/<@!?(\d+)>/g, (_, id) => `@${names.get(id) || '誰か'}`);
  const files = (m.attachments || []).length;
  return text + (files ? `（添付 ${files} 件）` : '');
}

const tokyoTime = (iso) => (iso ? new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');

// 前後の会話と、スレッドの名前（`#12 タイトル` なら Issue につながる）。読めなくても Issue は作る
async function contextOf(cfg, fb) {
  const [channel, list] = await Promise.all([
    discord(cfg, 'GET', `/channels/${fb.channel}`).catch(() => null),
    discord(cfg, 'GET', `/channels/${fb.channel}/messages?limit=${CONTEXT_MESSAGES}${fb.id ? `&around=${fb.id}` : ''}`).catch(() => []),
  ]);
  const messages = (Array.isArray(list) ? list : [])
    .filter((m) => m.type === 0 || m.type === 19) // ふつうの投稿と返信だけ
    .sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    .map((m) => ({ author: `${userName(m.author)}${m.author?.bot ? '（ボット）' : ''}`, text: plain(m), time: tokyoTime(m.timestamp), target: m.id === fb.id }));
  return { threadName: channel?.name || '', messages };
}

function resultMessage(draft, filed, by) {
  const lines = [];
  if (filed.created) lines.push(NEMU.issueCreated(by, filed.number, draft.title));
  else lines.push(NEMU.issueDrafted(by, draft.title), NEMU.issuePasteBody);
  if (draft.duplicate) lines.push(NEMU.maybeDuplicate(draft.duplicate.number, draft.duplicate.title));
  if (!filed.created) lines.push('```md', draft.body.replace(/```/g, "'''").slice(0, 1200), '```');
  return lines.join('\n').slice(0, 2000);
}

// 時間のかかる仕事（LLM と GitHub）。終わったら、最初に出した「考え中…」を書き換える
async function makeIssue(cfg, env, i, fb) {
  const edit = (body) => discord(cfg, 'PATCH', `/webhooks/${i.application_id}/${i.token}/messages/@original`, { allowed_mentions: { parse: [] }, ...body });
  const by = userName(i.member?.user || i.user);
  try {
    const context = await contextOf(cfg, fb);
    const draft = await draftIssue(cfg, env, { ...fb, context });
    const filed = await fileIssue(cfg, draft);
    const button = filed.url.length <= 512 ? [{ type: 1, components: [{ type: 2, style: 5, label: filed.created ? 'Issue を開く' : 'GitHub で作る', url: filed.url }] }] : [];
    const content = resultMessage(draft, filed, by) + (button.length ? '' : `\n${filed.url}`);
    await edit({ content: content.slice(0, 2000), components: button });
  } catch (e) {
    await edit({ content: NEMU.issueFailed(String(e.message).slice(0, 300)) }).catch(() => {});
  }
}

export async function interactions(request, env, ctx) {
  const body = await request.text();
  const ok = await verifyDiscord(env.DISCORD_PUBLIC_KEY, request.headers.get('X-Signature-Ed25519'), request.headers.get('X-Signature-Timestamp'), body);
  if (!ok) return new Response('署名が違う', { status: 401 });
  const i = JSON.parse(body);
  if (i.type === PING) return respond({ type: PONG });
  if (i.type !== COMMAND) return reply(NEMU.unknownCommand);

  let cfg;
  try {
    cfg = loadConfig(env);
  } catch (e) {
    return reply(e.message);
  }
  if (!cfg.llm) return reply(NEMU.noLlm);
  const fb = feedbackFrom(i);
  if (!fb || !fb.text.trim()) return reply(NEMU.noText);

  // Discord は3秒以内の返事を待つので、先に「考え中…」を返し、続きは裏でやる
  ctx.waitUntil(makeIssue(cfg, env, i, fb));
  return respond({ type: DEFERRED });
}

// コマンドを Discord に登録する（何度やっても同じ結果になる）
export async function registerCommands(env) {
  const cfg = loadConfig(env);
  const app = await discord(cfg, 'GET', '/applications/@me');
  const list = await discord(cfg, 'PUT', `/applications/${app.id}/commands`, COMMANDS);
  return { application_id: app.id, commands: list.map((c) => c.name) };
}
