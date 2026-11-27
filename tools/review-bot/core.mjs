// レビュー依頼ボットの中身（Discord と MCP の道具）。手元の stdio 版（server.mjs）とネット上の版（worker.mjs）で共通。
// Node 専用の機能は使わない（fetch だけ）。

const FORUM = 15;

// ---------- 設定 ----------

export function loadConfig(env) {
  const missing = ['DISCORD_BOT_TOKEN', 'DISCORD_REVIEW_CHANNEL_ID'].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`${missing.join(' と ')} が無い。tools/review-bot/README.md の「セットアップ」を見て設定してね`);
  }
  let members;
  try {
    members = JSON.parse(env.DISCORD_MEMBERS || '{}');
  } catch {
    throw new Error('DISCORD_MEMBERS が JSON として読めない。{"GitHub のログイン名": "Discord のユーザー ID"} の形にする');
  }
  // GitHub のログイン名は大文字小文字を区別しないので、小文字でそろえる
  members = Object.fromEntries(Object.entries(members).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return { token: env.DISCORD_BOT_TOKEN, channelId: env.DISCORD_REVIEW_CHANNEL_ID, members, api: env.DISCORD_API_URL || 'https://discord.com/api/v10' };
}

// ---------- Discord API ----------

export async function discord(cfg, method, path, body) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(cfg.api + path, {
      method,
      headers: {
        Authorization: `Bot ${cfg.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'DiscordBot (review-bot, 0.1)',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      await sleep(Number(data.retry_after ?? 1) * 1000 + 100);
      continue;
    }
    if (res.status === 204) return null;
    const text = await res.text();
    if (!res.ok) throw new Error(`Discord ${method} ${path} → ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  }
  throw new Error(`Discord ${method} ${path} → 429（混んでいる）が続いた`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const byId = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1);

const channelCache = new Map();
export async function channel(cfg) {
  if (!channelCache.has(cfg.channelId)) channelCache.set(cfg.channelId, await discord(cfg, 'GET', `/channels/${cfg.channelId}`));
  return channelCache.get(cfg.channelId);
}

const threadUrl = (guildId, threadId) => `https://discord.com/channels/${guildId}/${threadId}`;

// スレッドの最初のメッセージ（フォーラムならスレッド内、テキストチャンネルなら親チャンネルにある）
async function starter(cfg, thread) {
  const ch = await channel(cfg);
  const where = ch.type === FORUM ? thread.id : cfg.channelId;
  return discord(cfg, 'GET', `/channels/${where}/messages/${thread.id}`).catch(() => null);
}

// レビュー依頼のチャンネルにあるスレッド（開いているものと、最近閉じたもの）
async function threads(cfg) {
  const ch = await channel(cfg);
  const active = await discord(cfg, 'GET', `/guilds/${ch.guild_id}/threads/active`);
  const archived = await discord(cfg, 'GET', `/channels/${cfg.channelId}/threads/archived/public?limit=50`).catch(() => ({ threads: [] }));
  return [...active.threads.filter((t) => t.parent_id === cfg.channelId), ...archived.threads];
}

// PR・Issue の URL から、その件のスレッドを探す。依頼文の2行目に URL を書いてあるので、それで照らす
async function findThreadByUrl(cfg, url) {
  for (const t of await threads(cfg)) {
    const first = await starter(cfg, t);
    if (first?.content.split('\n').some((line) => line.trim() === url)) return t;
  }
  return null;
}

// thread 引数は、スレッド ID・Discord のスレッド URL・PR や Issue の URL のどれでもよい
async function resolveThread(cfg, ref) {
  if (!ref) throw new Error('thread を指定してね（スレッド ID、スレッドの URL、または PR・Issue の URL）');
  const s = String(ref).trim();
  const id = /^\d+$/.test(s) ? s : s.match(/discord(?:app)?\.com\/channels\/\d+\/(\d+)/)?.[1];
  if (id) return discord(cfg, 'GET', `/channels/${id}`);
  const t = await findThreadByUrl(cfg, s);
  if (!t) throw new Error(`${s} のスレッドが見つからない。先に request_review で依頼してね`);
  return t;
}

function mentionsFor(cfg, logins) {
  const all = logins.some((l) => l.toLowerCase() === 'all');
  const list = all ? Object.keys(cfg.members) : logins.map((l) => l.replace(/^@/, '').toLowerCase());
  const found = list.filter((l) => cfg.members[l]);
  const notFound = list.filter((l) => !cfg.members[l]);
  return { ids: [...new Set(found.map((l) => cfg.members[l]))], found, notFound };
}

const githubLogin = (cfg, discordId) => Object.entries(cfg.members).find(([, id]) => id === discordId)?.[0];

function toReply(cfg, m) {
  return {
    id: m.id,
    author: m.member?.nick || m.author.global_name || m.author.username,
    github: githubLogin(cfg, m.author.id) ?? null,
    time: m.timestamp,
    content: m.content,
    attachments: (m.attachments || []).map((a) => a.url),
  };
}

async function unarchive(cfg, thread) {
  if (thread.thread_metadata?.archived) await discord(cfg, 'PATCH', `/channels/${thread.id}`, { archived: false });
}

// ---------- 道具 ----------

export function requestText({ ids, kind, title, url, message, from }) {
  const head = kind === 'consult' ? '相談したいことがあるよ。意見をちょうだい！' : 'レビューをお願い！';
  const by = from ? `（${from} より）` : '';
  return clip(
    [`${ids.map((id) => `<@${id}>`).join(' ')} ${head}${by}`, url, '', `**${title}**`, '', message.trim(), '', '返事はこのスレッドに書いてね。AI が読みに来るよ。'].join('\n'),
    2000,
  );
}

const tools = {
  request_review: {
    description: (cfg) =>
      [
        '人の確認が要るとき（マージ前のレビュー、要相談の判断）に、Discord で本人をメンションしてレビュー依頼を送り、その件のスレッドを開く。',
        '同じ url の依頼スレッドが既にあれば、新しく作らずそこに書く（「直したので見てほしい」など）。',
        '通知が多いと無視されるので、確認が本当に要るときだけ使う。小さな質問は PR・Issue のコメントで聞く。',
        '送ったら、返ってきた thread_url を PR か Issue のコメントに書いておく。',
        `呼べる人（GitHub のログイン名）: ${cfg ? Object.keys(cfg.members).join(', ') || '（未設定）' : '（未設定）'}。全員なら "all"。`,
      ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: '呼ぶ人の GitHub ログイン名。全員なら ["all"]' },
        title: { type: 'string', description: '何の確認か。スレッドの名前になる（例：PR #12 ログイン画面）' },
        url: { type: 'string', description: 'PR か Issue の URL。スレッドを探す鍵にもなる' },
        message: { type: 'string', description: '試し方（3手以内）と、見てほしいこと（1〜3点）。返事がほしい期限があれば書く' },
        kind: { type: 'string', enum: ['review', 'consult'], description: 'review = レビュー依頼（既定）、consult = 相談' },
        from: { type: 'string', description: '頼んでいる人（AI を動かしている人の名前など）' },
      },
      required: ['to', 'title', 'url', 'message'],
    },
    async run(cfg, a) {
      const { ids, found, notFound } = mentionsFor(cfg, a.to || []);
      if (!ids.length) throw new Error(`呼べる人がいない（${notFound.join(', ') || '空'}）。呼べる人: ${Object.keys(cfg.members).join(', ')}`);
      const content = requestText({ ids, kind: a.kind, title: a.title, url: a.url, message: a.message, from: a.from });
      const allowed_mentions = { users: ids };
      const ch = await channel(cfg);
      let thread = await findThreadByUrl(cfg, a.url);
      let created = false;
      if (thread) {
        await unarchive(cfg, thread);
        await discord(cfg, 'POST', `/channels/${thread.id}/messages`, { content, allowed_mentions });
      } else if (ch.type === FORUM) {
        thread = await discord(cfg, 'POST', `/channels/${cfg.channelId}/threads`, {
          name: clip(a.title, 100),
          auto_archive_duration: 10080,
          message: { content, allowed_mentions },
        });
        created = true;
      } else {
        const msg = await discord(cfg, 'POST', `/channels/${cfg.channelId}/messages`, { content, allowed_mentions });
        thread = await discord(cfg, 'POST', `/channels/${cfg.channelId}/messages/${msg.id}/threads`, { name: clip(a.title, 100), auto_archive_duration: 10080 });
        created = true;
      }
      return {
        thread_id: thread.id,
        thread_url: threadUrl(ch.guild_id, thread.id),
        created,
        mentioned: found,
        not_found: notFound,
        next: 'thread_url を PR・Issue のコメントに書いておく。返事は read_replies で読む。',
      };
    },
  },

  read_replies: {
    description: () =>
      'レビュー依頼スレッドの、人の返信を古い順に読む（ボット自身の投稿は除く）。after に前回の last_id を渡すと、その後の返信だけ返す。作業を始めるときに確かめる。',
    inputSchema: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'スレッド ID、スレッドの URL、または PR・Issue の URL' },
        after: { type: 'string', description: 'この ID より後の返信だけ読む（前回の last_id）' },
      },
      required: ['thread'],
    },
    async run(cfg, a) {
      const thread = await resolveThread(cfg, a.thread);
      const all = [];
      let after = a.after || '0';
      for (;;) {
        const batch = await discord(cfg, 'GET', `/channels/${thread.id}/messages?after=${after}&limit=100`);
        all.push(...batch);
        if (batch.length < 100) break;
        after = batch.slice().sort(byId).at(-1).id;
      }
      all.sort(byId);
      const replies = all.filter((m) => !m.author.bot && (m.type === 0 || m.type === 19)).map((m) => toReply(cfg, m));
      return {
        thread_id: thread.id,
        name: thread.name,
        closed: Boolean(thread.thread_metadata?.archived),
        replies,
        last_id: all.at(-1)?.id ?? a.after ?? null,
      };
    },
  },

  post_to_thread: {
    description: () => 'レビュー依頼スレッドに書く（質問への答え、直したことの報告など）。mention を付けるとその人に通知が行く。',
    inputSchema: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'スレッド ID、スレッドの URL、または PR・Issue の URL' },
        message: { type: 'string', description: '書く内容' },
        mention: { type: 'array', items: { type: 'string' }, description: '通知したい人の GitHub ログイン名（任意）' },
      },
      required: ['thread', 'message'],
    },
    async run(cfg, a) {
      const thread = await resolveThread(cfg, a.thread);
      const { ids, notFound } = mentionsFor(cfg, a.mention || []);
      await unarchive(cfg, thread);
      const content = clip([ids.map((id) => `<@${id}>`).join(' '), a.message.trim()].filter(Boolean).join(' '), 2000);
      const msg = await discord(cfg, 'POST', `/channels/${thread.id}/messages`, { content, allowed_mentions: { users: ids } });
      return { thread_id: thread.id, message_id: msg.id, not_found: notFound };
    },
  },

  close_review: {
    description: () => 'レビュー依頼スレッドを閉じる（PR がマージされた、相談が決まったなど）。閉じる前に一言書ける。',
    inputSchema: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: 'スレッド ID、スレッドの URL、または PR・Issue の URL' },
        message: { type: 'string', description: '閉じる前に書く一言（例：マージされたので閉じるね）' },
      },
      required: ['thread'],
    },
    async run(cfg, a) {
      const thread = await resolveThread(cfg, a.thread);
      await unarchive(cfg, thread);
      if (a.message) await discord(cfg, 'POST', `/channels/${thread.id}/messages`, { content: clip(a.message, 2000), allowed_mentions: { parse: [] } });
      await discord(cfg, 'PATCH', `/channels/${thread.id}`, { archived: true });
      return { thread_id: thread.id, closed: true };
    },
  },

  list_reviews: {
    description: () => '開いているレビュー依頼スレッドの一覧。どの PR・Issue の件か（url）と、最後の投稿の ID を返す。',
    inputSchema: { type: 'object', properties: {} },
    async run(cfg) {
      const ch = await channel(cfg);
      const open = (await threads(cfg)).filter((t) => !t.thread_metadata?.archived);
      const list = [];
      for (const t of open) {
        const first = await starter(cfg, t);
        list.push({
          thread_id: t.id,
          name: t.name,
          thread_url: threadUrl(ch.guild_id, t.id),
          url: first?.content.split('\n')[1]?.trim() || null,
          last_message_id: t.last_message_id ?? null,
        });
      }
      return { reviews: list };
    },
  },
};

// ---------- MCP（JSON-RPC 2.0） ----------

const INSTRUCTIONS =
  '人の確認が要るときに、Discord でその人に直接知らせて、返事を受け取るための道具。' +
  'マージ前のレビューや「要相談」の判断のように、人が見ないと先に進めないときだけ request_review を使う。' +
  '作業を始めるときは list_reviews と read_replies で新しい返信を確かめ、感想は Issue にするか PR で直す。';

export async function handle(msg, env) {
  const { id, method, params } = msg;
  const ok = (result) => ({ jsonrpc: '2.0', id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined) return null; // 通知には返事をしない
  if (method === 'initialize') {
    return ok({
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'review-bot', version: '0.1.0' },
      instructions: INSTRUCTIONS,
    });
  }
  if (method === 'ping') return ok({});
  if (method === 'tools/list') {
    let cfg = null;
    try {
      cfg = loadConfig(env);
    } catch {}
    return ok({ tools: Object.entries(tools).map(([name, t]) => ({ name, description: t.description(cfg), inputSchema: t.inputSchema })) });
  }
  if (method === 'tools/call') {
    const tool = tools[params?.name];
    if (!tool) return fail(-32602, `知らない道具: ${params?.name}`);
    try {
      const result = await tool.run(loadConfig(env), params.arguments || {});
      return ok({ content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] });
    } catch (e) {
      return ok({ content: [{ type: 'text', text: e.message }], isError: true });
    }
  }
  return fail(-32601, `知らないメソッド: ${method}`);
}
