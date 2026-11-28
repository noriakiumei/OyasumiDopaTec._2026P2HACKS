// Cloudflare のダッシュボードに貼る1ファイル版（worker.mjs と、それが読むファイル全部）を標準出力に出す。
// node tools/review-bot/bundle.mjs > worker.bundle.js   （wrangler deploy なら要らない）
// 各ファイルを関数で包むので、ファイルどうしで同じ名前があってもぶつからない。import は1行で書く。

import { readFileSync } from 'node:fs';

// 読まれる側を先に並べる。最後が Worker の入り口
const FILES = ['llm.mjs', 'github.mjs', 'pr-summary.mjs', 'feedback.mjs', 'digest.mjs', 'core.mjs', 'interactions.mjs', 'worker.mjs'];

const varName = (f) => `__${f.replace(/\W/g, '_')}`;

export function bundle() {
  return FILES.map((f, n) => {
    let code = readFileSync(new URL(f, import.meta.url), 'utf8').replace(
      /^import \{([^}]*)\} from '\.\/(.*\.mjs)';$/gm,
      (_, names, from) => `const {${names}} = ${varName(from)};`,
    );
    if (n === FILES.length - 1) return code;
    const names = [...code.matchAll(/^export (?:async )?(?:function|const|let) (\w+)/gm)].map((m) => m[1]);
    code = code.replace(/^export (?=(async )?function |const |let )/gm, '');
    return `const ${varName(f)} = (() => {\n${code}\nreturn { ${names.join(', ')} };\n})();\n`;
  }).join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) process.stdout.write(bundle());
