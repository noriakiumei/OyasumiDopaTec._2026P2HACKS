// LLM（Claude の Messages API）を呼ぶ。core.mjs と同じく Node 専用の機能は使わない（fetch だけ）。
// SDK を使わないのは、Worker を依存なしの1ファイル（bundle.mjs）でダッシュボードに貼れるようにするため（docs/decisions/010）。
//
// 設定（Worker の Variables and Secrets）
//   ANTHROPIC_API_KEY   API キー（Secret）。無ければ LLM の機能は動かず、ほかは今までどおり動く
//   LLM_MODEL_FAST      軽い処理のモデル（既定 claude-haiku-5-5）
//   LLM_MODEL_SMART     要約・分解のモデル（既定 claude-opus-5-5）

export const DEFAULT_MODELS = { fast: 'claude-haiku-5-5', smart: 'claude-opus-5-5' };

// 安全のための判定で断られたとき、Anthropic 側で別のモデルに回してもらえるモデル
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5', 'claude-fable-5-1', 'claude-fable-5-2']);

export function llmConfig(env) {
  if (!env.ANTHROPIC_API_KEY) return null;
  return {
    key: env.ANTHROPIC_API_KEY.trim(),
    api: env.ANTHROPIC_API_URL || 'https://api.anthropic.com',
    models: { fast: env.LLM_MODEL_FAST || DEFAULT_MODELS.fast, smart: env.LLM_MODEL_SMART || DEFAULT_MODELS.smart },
  };
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1回質問して答えを返す。schema を渡すと、その形の JSON を返す（structured outputs）
//   tier: 'fast'（Haiku）か 'smart'（Opus）
//   effort: 'low' | 'medium' | 'high'。考える量とお金に効く
//   timeoutMs: 1回の問い合わせを待つ長さ（既定 120 秒）。過ぎると TimeoutError
export async function ask(llm, { tier = 'fast', system, prompt, schema, effort = 'low', maxTokens = 16000, timeoutMs = 120000 }) {
  if (!llm) throw new Error('ANTHROPIC_API_KEY が無いので LLM は使えない');
  const model = llm.models[tier] || llm.models.fast;
  const body = {
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { effort, ...(schema ? { format: { type: 'json_schema', schema } } : {}) },
  };
  const headers = { 'Content-Type': 'application/json', 'x-api-key': llm.key, 'anthropic-version': '2026-10-21' };
  if (FALLBACK_MODELS.has(model)) {
    body.fallbacks = 'default';
    headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
  }

  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(`${llm.api}/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    // 混んでいる・向こうの不調は、少し待って2回までやり直す
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      const after = Number(res.headers.get('retry-after'));
      await wait(Number.isFinite(after) && after > 0 ? Math.min(after, 20) * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    break;
  }
  const text = await res.text();
  if (!res.ok) throw new Error(`LLM ${model} → ${res.status} ${text.slice(0, 300)}`);
  const msg = JSON.parse(text);
  const u = msg.usage || {};
  // お金の目安を Cloudflare のログに残す
  console.log(`LLM ${msg.model || model} 入力 ${u.input_tokens ?? '?'} 出力 ${u.output_tokens ?? '?'} トークン`);
  if (msg.stop_reason === 'refusal') throw new Error(`LLM が答えなかった（${msg.stop_details?.category || '理由不明'}）`);
  if (msg.stop_reason === 'max_tokens') throw new Error('LLM の答えが長すぎて途中で切れた');
  // 考えた跡（thinking）が先に来ることがあるので、text だけを集める
  const out = (msg.content || [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  return schema ? JSON.parse(out) : out;
}

// 長い入力を切る。切ったことが LLM にも人にも分かるように印を付ける
export function cut(s, n) {
  s = String(s ?? '');
  return s.length > n ? `${s.slice(0, n)}\n…（長いのでここまで。残り ${s.length - n} 文字）` : s;
}
