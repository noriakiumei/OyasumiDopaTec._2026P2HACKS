// Cloudflare のダッシュボードに貼る1ファイル版（worker.mjs と、それが読むファイル全部）を標準出力に出す。
// node tools/review-bot/bundle.mjs > worker.bundle.js   （wrangler deploy なら要らない）
// ファイルをつなげるだけなので、ファイルどうしで同じ名前の関数・定数を作らない。import は1行で書く。

import { readFileSync } from 'node:fs';

// 読まれる側を先に並べる
const FILES = ['llm.mjs', 'github.mjs', 'pr-summary.mjs', 'core.mjs', 'worker.mjs'];

export function bundle() {
  return FILES.map((f) =>
    readFileSync(new URL(f, import.meta.url), 'utf8')
      .replace(/^import .* from '\.\/.*\.mjs';\n/gm, '')
      .replace(/^export (?=(async )?function |const |let )/gm, ''),
  ).join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(bundle());
