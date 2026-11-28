// GitHub の REST API を読む（fetch だけ）。リポジトリは public なので、トークンが無くても読める。
// GITHUB_TOKEN（任意）があれば使う。無いと、Cloudflare の IP は共有なので回数の上限に当たりやすい。

export function githubConfig(env) {
  return { token: env.GITHUB_TOKEN?.trim() || null, api: env.GITHUB_API_URL || 'https://api.github.com' };
}

export async function github(gh, method, path, { accept = 'application/vnd.github+json', body } = {}) {
  const res = await fetch(gh.api + path, {
    method,
    headers: {
      Accept: accept,
      'User-Agent': 'oyasumi-review-bot',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(gh.token ? { Authorization: `Bearer ${gh.token}` } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GitHub ${method} ${path} → ${res.status} ${text.slice(0, 200)}`);
  return accept.includes('json') && text ? JSON.parse(text) : text;
}

// https://github.com/<owner>/<repo>/pull/12 → { owner, repo, kind: 'pr', number: 12 }
export function parseGithubUrl(url) {
  const m = String(url).match(/github\.com\/([^/\s]+)\/([^/\s]+)\/(issues|pull)\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], kind: m[3] === 'pull' ? 'pr' : 'issue', number: Number(m[4]) } : null;
}

// PR の中身（タイトル・本文・差分）
export async function pullRequest(gh, { owner, repo, number }) {
  const path = `/repos/${owner}/${repo}/pulls/${number}`;
  const [pr, diff] = await Promise.all([github(gh, 'GET', path), github(gh, 'GET', path, { accept: 'application/vnd.github.diff' })]);
  return { title: pr.title, body: pr.body || '', author: pr.user?.login, additions: pr.additions, deletions: pr.deletions, files: pr.changed_files, diff };
}
