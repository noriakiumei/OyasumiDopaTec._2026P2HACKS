// Cloudflare のダッシュボードに貼る1ファイル版（core.mjs + worker.mjs）を標準出力に出す。
// node tools/review-bot/bundle.mjs > worker.bundle.js   （wrangler deploy なら要らない）

import { readFileSync } from 'node:fs';

const read = (f) => readFileSync(new URL(f, import.meta.url), 'utf8');
const core = read('./core.mjs').replace(/^export (?=(async )?function )/gm, '');
const worker = read('./worker.mjs').replace(/^import .* from '\.\/core\.mjs';\n/m, '');
process.stdout.write(`${core}\n${worker}`);
