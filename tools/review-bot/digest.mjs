// チーム全体へのお知らせ（朝夕のダイジェスト、見回りの結果など）を Discord に書く（#23）。
// 文は呼ぶ側（ChatGPT の Dot・Codex など）が作る。NEMU は書く場所を決めて投稿するだけ（AI は使わない）。
// Discord を触る関数（kit）は core.mjs から渡してもらう（core.mjs がこのファイルを読むので、ここからは読まない）。

import { NEMU } from './voice.mjs';

export const DIGEST_THREAD = 'ダイジェスト';

// 投稿先：DISCORD_DIGEST_CHANNEL_ID があればそこ、無ければレビュー依頼のフォーラムの「ダイジェスト」スレッド
async function digestTarget(cfg, kit) {
  if (cfg.digestChannelId) return { id: cfg.digestChannelId };
  let thread = (await kit.threads(cfg)).find((t) => t.name === DIGEST_THREAD);
  if (!thread) {
    thread = await kit.createThread(cfg, DIGEST_THREAD, {
      content: NEMU.digestIntro,
      allowed_mentions: { parse: [] },
    });
  }
  await kit.unarchive(cfg, thread);
  return thread;
}

// 文の中の @GitHubログイン名 を Discord の名前（<@ID>）にする。通知はしない
export function linkMembers(cfg, text) {
  return String(text).replace(/(^|[^\w`])@([A-Za-z0-9-]+)/g, (all, pre, login) => (cfg.members[login.toLowerCase()] ? `${pre}<@${cfg.members[login.toLowerCase()]}>` : all));
}

export async function postDigest(cfg, kit, { content, title }) {
  if (!String(content || '').trim()) throw new Error('content（書く文）が空だよ');
  const text = linkMembers(cfg, [title ? `📰 **${title}**` : '', String(content).trim()].filter(Boolean).join('\n'));
  if (text.length > 2000) throw new Error(`長すぎる（${text.length} 文字）。Discord は2000文字までなので、短くするか分けて送ってね`);
  const target = await digestTarget(cfg, kit);
  const msg = await kit.say(cfg, target, text);
  const ch = await kit.channel(cfg);
  return { posted: true, message_id: msg?.id ?? null, url: `https://discord.com/channels/${ch.guild_id}/${target.id}/${msg?.id ?? ''}` };
}
