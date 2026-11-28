// レビュー依頼ボットの中身（Discord と MCP の道具）。手元の stdio 版（server.mjs）とネット上の版（worker.mjs）で共通。
// Node 専用の機能は使わない（fetch だけ）。

import { llmConfig } from './llm.mjs';
import { githubConfig, parseGithubUrl } from './github.mjs';
import { summarizePr } from './pr-summary.mjs';
import { postDigest } from './digest.mjs';
import { splitIssue } from './split.mjs';
import { NEMU } from './voice.mjs';

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
  return {
    token: env.DISCORD_BOT_TOKEN,
    channelId: env.DISCORD_REVIEW_CHANNEL_ID,
    members,
    api: env.DISCORD_API_URL || 'https://discord.com/api/v10',
    llm: llmConfig(env), // ANTHROPIC_API_KEY が無ければ null（LLM の機能は使わない）
    github: githubConfig(env),
    digestChannelId: env.DISCORD_DIGEST_CHANNEL_ID || null, // 無ければフォーラムの「ダイジェスト」スレッドに書く
  };
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

// GitHub の URL から Issue・PR の番号を読む
const githubRef = parseGithubUrl;

// スレッド名の決まり：Issue は「#12 タイトル」、PR がつながると「#12 タイトル（PR #13, #14）」、Issue の無い PR は「PR #13 タイトル」
const PR_SUFFIX = /（PR (#\d+(?:, #\d+)*)）$/;
const prsInName = (name) => (name.match(PR_SUFFIX)?.[1].match(/\d+/g) || []).map(Number);
const baseName = (name) => name.replace(PR_SUFFIX, '');
function nameFor(base, prs) {
  const suffix = prs.length ? `（PR ${prs.map((n) => `#${n}`).join(', ')}）` : '';
  return clip(base, 100 - suffix.length) + suffix;
}
function nameMatches(name, ref) {
  if (ref.kind === 'issue') return new RegExp(`^#${ref.number}(\\s|（|$)`).test(name);
  return new RegExp(`^PR #${ref.number}(\\s|$)`).test(name) || prsInName(name).includes(ref.number);
}

const STARTER_SCAN_LIMIT = 30; // Workers の1回あたりの外部リクエスト数（無料枠は50）に収める

// PR・Issue の URL から、その件のスレッドを探す。まずスレッド名で、無ければ最初のメッセージに書いた URL で照らす
async function findThreadByUrl(cfg, url) {
  const list = await threads(cfg);
  const ref = githubRef(url);
  if (ref) {
    const t = list.find((x) => nameMatches(x.name, ref));
    if (t) return t;
  }
  for (const t of list.slice(0, STARTER_SCAN_LIMIT)) {
    const first = await starter(cfg, t);
    if (first?.content.split('\n').some((line) => line.split(/\s+/).includes(url))) return t;
  }
  return null;
}

// Issue 番号からスレッドを探す（スレッド名だけで探す）
async function findIssueThread(cfg, number) {
  return (await threads(cfg)).find((t) => nameMatches(t.name, { kind: 'issue', number })) || null;
}

async function createThread(cfg, name, message) {
  const ch = await channel(cfg);
  if (ch.type === FORUM) {
    return discord(cfg, 'POST', `/channels/${cfg.channelId}/threads`, { name: clip(name, 100), auto_archive_duration: 10080, message });
  }
  const msg = await discord(cfg, 'POST', `/channels/${cfg.channelId}/messages`, message);
  return discord(cfg, 'POST', `/channels/${cfg.channelId}/messages/${msg.id}/threads`, { name: clip(name, 100), auto_archive_duration: 10080 });
}

const say = (cfg, thread, content, allowed_mentions = { parse: [] }) =>
  discord(cfg, 'POST', `/channels/${thread.id}/messages`, { content: clip(content, 2000), allowed_mentions });

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

export function requestText({ ids, kind, title, url, message, from, summary }) {
  const head = kind === 'consult' ? NEMU.consult : NEMU.review;
  const by = from ? `（${from} より）` : '';
  const ai = summary ? ['', NEMU.summaryHead, summary] : [];
  return clip(
    [`${ids.map((id) => `<@${id}>`).join(' ')} ${head}${by}`, url, '', `**${title}**`, ...ai, '', message.trim(), '', NEMU.replyHere].join('\n'),
    2000,
  );
}

function issueText(number, { url, title, author, body }) {
  const excerpt = clip(
    (body || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    600,
  );
  return clip(
    [`Issue #${number}${author ? `（${author} より）` : ''}`, url, '', `**${title}**`, ...(excerpt ? ['', excerpt] : []), '', NEMU.issueThread].join('\n'),
    2000,
  );
}

// PR を Issue のスレッドにつなぐ。つないだスレッドを返す
async function linkPr(cfg, { number, url, title, author, issues }) {
  const linked = [];
  const numbers = [...new Set(issues.map((x) => Number(String(x).match(/(\d+)\D*$/)?.[1])).filter(Boolean))];
  for (const n of numbers) {
    const thread = await findIssueThread(cfg, n);
    if (!thread) continue;
    const prs = prsInName(thread.name);
    if (!prs.includes(number)) {
      await unarchive(cfg, thread);
      await say(cfg, thread, [NEMU.prLinked(number, author, title), url].join('\n'));
      await discord(cfg, 'PATCH', `/channels/${thread.id}`, { name: nameFor(baseName(thread.name), [...prs, number]) });
      thread.name = nameFor(baseName(thread.name), [...prs, number]);
    }
    linked.push(thread);
  }
  return linked;
}

// LLM の機能のファイル（digest.mjs など）に渡す、Discord を触る関数
const kit = { discord, channel, threads, findIssueThread, createThread, say, unarchive, githubLogin, threadUrl };

const tools = {
  request_review: {
    description: (cfg) =>
      [
        '人の確認が要るとき（マージ前のレビュー、要相談の判断）に、Discord で本人をメンションしてレビュー依頼を送り、その件のスレッドを開く。',
        'その件のスレッドが既にあれば（Issue のスレッド、PR がつながった Issue のスレッドを含む）、新しく作らずそこに書く（「直したので見てほしい」など）。',
        '通知が多いと無視されるので、確認が本当に要るときだけ使う。小さな質問は PR・Issue のコメントで聞く。',
        '送ったら、返ってきた thread_url を PR か Issue のコメントに書いておく。',
        `呼べる人（GitHub のログイン名）: ${cfg ? Object.keys(cfg.members).join(', ') || '（未設定）' : '（未設定）'}。全員なら "all"。`,
      ].join(''),
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'array', items: { type: 'string' }, description: '呼ぶ人の GitHub ログイン名。全員なら ["all"]' },
        title: { type: 'string', description: '何の確認か。新しくスレッドを作るときの名前になる（例：ログイン画面）' },
        url: { type: 'string', description: 'PR か Issue の URL。スレッドを探す鍵にもなる。PR なら、つながっている Issue のスレッドに書く' },
        issue: { type: 'string', description: 'PR が対応する Issue の番号か URL（任意）。PR がまだ Issue のスレッドにつながっていなければ、ここでつなぐ' },
        message: { type: 'string', description: '試し方（3手以内）と、見てほしいこと（1〜3点）。返事がほしい期限があれば書く' },
        kind: { type: 'string', enum: ['review', 'consult'], description: 'review = レビュー依頼（既定）、consult = 相談' },
        from: { type: 'string', description: '頼んでいる人（AI を動かしている人の名前など）' },
        summarize: { type: 'boolean', description: 'PR の差分を AI で3行に要約して添えるか（既定 true。PR の URL のときだけ）' },
      },
      required: ['to', 'title', 'url', 'message'],
    },
    async run(cfg, a) {
      const { ids, found, notFound } = mentionsFor(cfg, a.to || []);
      if (!ids.length) throw new Error(`呼べる人がいない（${notFound.join(', ') || '空'}）。呼べる人: ${Object.keys(cfg.members).join(', ')}`);
      const ref = githubRef(a.url);
      // 要約に失敗しても、依頼そのものは送る
      let summary = null;
      let summaryError;
      if (ref?.kind === 'pr' && cfg.llm && a.summarize !== false) {
        summary = await summarizePr(cfg, ref).catch((e) => ((summaryError = e.message), null));
      }
      const content = requestText({ ids, kind: a.kind, title: a.title, url: a.url, message: a.message, from: a.from, summary });
      const allowed_mentions = { users: ids };
      const ch = await channel(cfg);
      let thread = await findThreadByUrl(cfg, a.url);
      if (!thread && ref?.kind === 'pr' && a.issue) {
        thread = await linkPr(cfg, { number: ref.number, url: a.url, issues: [a.issue] }).then((r) => r[0] || null);
      }
      let created = false;
      if (thread) {
        await unarchive(cfg, thread);
        await say(cfg, thread, content, allowed_mentions);
      } else {
        const name = ref && !new RegExp(`#${ref.number}\\b`).test(a.title) ? `${ref.kind === 'pr' ? 'PR ' : ''}#${ref.number} ${a.title}` : a.title;
        thread = await createThread(cfg, name, { content, allowed_mentions });
        created = true;
      }
      return {
        thread_id: thread.id,
        thread_url: threadUrl(ch.guild_id, thread.id),
        created,
        mentioned: found,
        not_found: notFound,
        summary,
        ...(summaryError ? { summary_error: summaryError } : {}),
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

  sync_issue: {
    description: () =>
      'Issue のスレッドを Issue に合わせる。無ければ立て（メンションなし）、タイトルが変われば名前を変え、Issue が閉じたら閉じ、開き直したら開く。ふだんは GitHub Actions が呼ぶ。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Issue の URL' },
        title: { type: 'string', description: 'Issue のタイトル' },
        state: { type: 'string', enum: ['open', 'closed'], description: 'Issue の状態' },
        author: { type: 'string', description: 'Issue を作った人の GitHub ログイン名' },
        body: { type: 'string', description: 'Issue の本文（最初のほうだけ載せる）' },
        action: { type: 'string', description: 'GitHub のイベントの action（opened・edited・closed・reopened）' },
      },
      required: ['url', 'title', 'state'],
    },
    async run(cfg, a) {
      const ref = githubRef(a.url);
      if (ref?.kind !== 'issue') throw new Error(`Issue の URL ではない: ${a.url}`);
      const ch = await channel(cfg);
      let thread = await findIssueThread(cfg, ref.number);
      const base = `#${ref.number} ${a.title}`;
      if (!thread) {
        if (a.state === 'closed') return { thread_id: null, action: 'none' };
        thread = await createThread(cfg, base, { content: issueText(ref.number, a), allowed_mentions: { parse: [] } });
        return { thread_id: thread.id, thread_url: threadUrl(ch.guild_id, thread.id), action: 'created' };
      }
      const actions = [];
      const wasArchived = Boolean(thread.thread_metadata?.archived);
      const name = nameFor(base, prsInName(thread.name));
      if (thread.name !== name) {
        await unarchive(cfg, thread); // 閉じたスレッドは名前を変えられない
        await discord(cfg, 'PATCH', `/channels/${thread.id}`, { name });
        actions.push('renamed');
      }
      if (a.state === 'closed') {
        if (!wasArchived) {
          await say(cfg, thread, NEMU.issueClosed);
          actions.push('closed');
        }
        if (!wasArchived || actions.includes('renamed')) await discord(cfg, 'PATCH', `/channels/${thread.id}`, { archived: true });
      } else if (wasArchived) {
        // 書き込みが7日ないと Discord が自動で閉じるので、開き直しの知らせは Issue が開き直されたときだけ書く
        if (!actions.includes('renamed')) await unarchive(cfg, thread);
        if (a.action === 'reopened') await say(cfg, thread, NEMU.issueReopened);
        actions.push('reopened');
      }
      return { thread_id: thread.id, thread_url: threadUrl(ch.guild_id, thread.id), action: actions.join(',') || 'none' };
    },
  },

  link_pr: {
    description: () =>
      'PR を、対応する Issue のスレッドにつなぐ。スレッド名に PR 番号を足し、PR ができたことを書く。以後 PR の URL でもそのスレッドが見つかる。ふだんは GitHub Actions が呼ぶ。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'PR の URL' },
        title: { type: 'string', description: 'PR のタイトル' },
        author: { type: 'string', description: 'PR を作った人の GitHub ログイン名' },
        issues: { type: 'array', items: { type: 'string' }, description: 'つなぐ Issue の番号か URL（本文の Closes #番号 など）' },
      },
      required: ['url', 'issues'],
    },
    async run(cfg, a) {
      const ref = githubRef(a.url);
      if (ref?.kind !== 'pr') throw new Error(`PR の URL ではない: ${a.url}`);
      const ch = await channel(cfg);
      const linked = await linkPr(cfg, { number: ref.number, url: a.url, title: a.title, author: a.author, issues: a.issues || [] });
      return { linked: linked.map((t) => ({ thread_id: t.id, thread_url: threadUrl(ch.guild_id, t.id) })) };
    },
  },

  post_digest: {
    description: () =>
      'チーム全体へのお知らせ（朝夕のダイジェスト、放置ブランチ・Issue の見回り結果など）を Discord のダイジェストの場所に書く。' +
      '文は呼ぶ側が作る（NEMU は AI を使わず、そのまま書く）。事実だけを短く、Issue・PR は「#12 タイトル」とリンクで書く。' +
      '文の中の @GitHubログイン名 は Discord の名前になる（通知はしない）。2000文字まで。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '見出し（例：11/28 朝のダイジェスト）' },
        content: { type: 'string', description: '書く文（Markdown、2000文字まで）' },
      },
      required: ['content'],
    },
    run: (cfg, a) => postDigest(cfg, kit, a),
  },

  split_issue: {
    description: () =>
      '大きい Issue を、1 PR で終わる大きさのサブタスクに分ける案を AI が作る（見積もり・順番・担当候補つき）。提案だけで、サブ Issue は作らない。' +
      'Issue の Discord スレッドにネムが一言書く。GITHUB_TOKEN が無ければ comment_url が null なので、返ってきた comment を呼んだ側が Issue にコメントする。' +
      'ふだんは「分解」ラベルで GitHub Actions が呼ぶ。',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Issue の URL' },
        title: { type: 'string', description: 'Issue のタイトル（無ければ GitHub から読む）' },
        body: { type: 'string', description: 'Issue の本文（無ければ GitHub から読む）' },
        team: { type: 'object', description: 'チームの状況（開いている Issue と担当、最近の PR と作った人など）。担当候補を選ぶのに使う' },
      },
      required: ['url'],
    },
    run: (cfg, a) => splitIssue(cfg, kit, a),
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

const READ_ONLY = new Set(['read_replies', 'list_reviews']);

const INSTRUCTIONS =
  '人の確認が要るときに、Discord でその人に直接知らせて、返事を受け取るための道具。' +
  'Issue ごとに Discord のスレッドがあり（GitHub Actions が立てる）、PR とレビュー依頼もそのスレッドに集まる。' +
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
    // annotations：読むだけの道具を知らせる（ChatGPT などが確認を挟むかどうかの手がかりにする）
    return ok({
      tools: Object.entries(tools).map(([name, t]) => ({
        name,
        description: t.description(cfg),
        inputSchema: t.inputSchema,
        annotations: { readOnlyHint: READ_ONLY.has(name), destructiveHint: false, openWorldHint: true },
      })),
    });
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
