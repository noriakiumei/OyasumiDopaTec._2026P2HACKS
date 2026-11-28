// NEMU（ネム）の口調。ボットが Discord に書く決まった文と、AI に渡すキャラ設定をここにまとめる（#29）。
// ネム：おやすみドパTec. のマスコットで代表。眠そうだけどドーパミン全開のハイテンション。
// 好き：睡眠・開発・ガジェット・エナドリ・タスク消化。苦手：早起き・バグの再現・マージコンフリクト。
// 決め台詞「これデプロイしたら寝るから……！」
// 口調を変えるときはここだけ直す。番号・人・リンクなどの中身は崩さない。

// AI（Claude）が Discord に書く文に足すキャラ設定
export const NEMU_PERSONA = [
  'あなたはチームのマスコット「ネム」として書く。眠そうだけどドーパミン全開でハイテンション、エナドリとタスク消化が好き、早起きとバグの再現とマージコンフリクトが苦手。',
  '語尾はくだけて（〜だよ、〜してね、〜かも）、ときどき「⚡」「💤」を1つ添える。決め台詞「これデプロイしたら寝るから……！」は使っても1回まで。',
  'ただし中身は正確に：番号・人・ファイル名・URL・手順は書き換えず、キャラのために情報を減らしたり盛ったりしない。',
].join('\n');

export const NEMU = {
  alive: 'NEMU（ネム）は起きてるよ⚡ MCP は /mcp/<鍵> でどうぞ。\n',

  // レビュー依頼
  review: 'レビューおねがい〜！⚡',
  consult: 'ちょっと相談させて〜！みんなの意見ほしい⚡',
  summaryHead: '**ネムの3行まとめ（差分から）**',
  replyHere: '返事はこのスレッドにどうぞ〜。ネム（と AI たち）が読みに来るよ💤',

  // Issue のスレッド
  issueThread: 'この Issue の相談・感想・PR・レビュー依頼は、ぜんぶこのスレッドに集めるね。ネムも読みに来るよ⚡',
  prLinked: (n, author, title) => `PR #${n} きたー！⚡${author ? `（${author}）` : ''}${title ? `：${title}` : ''}`,
  issueClosed: 'Issue が閉じたから、このスレッドもおやすみ〜💤',
  issueReopened: 'Issue が開き直された！ネムも起きた⚡',

  // ダイジェストの場所
  digestIntro: 'ふぁ……ここは朝と夕方のダイジェストと、お片付けの提案を置く場所だよ。ネムが寝てる間も Dot たちが見回ってくれるはず💤',

  // Discord のコマンド（感想 → Issue）
  issueCreated: (by, n, title) => `📝 Issue にしたよ！⚡（${by} から）：**#${n} ${title}**`,
  issueAnnounce: (author, n, title, url) => `📝 ${author} の感想から Issue 立てたよ！⚡ [#${n} ${title}](<${url}>)`,
  issueDrafted: (by, title) => `📝 Issue の下書きできたよ（${by} から）：**${title}**`,
  issuePasteBody: 'ボタンから作成ページを開いて、下の本文を貼ってね。（GITHUB_TOKEN があれば、ネムが直接作れるんだけどな〜）',
  maybeDuplicate: (n, title) => `似た Issue がもうあるかも👀：#${n} ${title}`,
  issueFailed: (why) => `うぅ……Issue にできなかった（${why}）。バグの再現は苦手なんだよね……`,
  noLlm: 'AI の設定（ANTHROPIC_API_KEY）がまだだから、ネムは考えられない……💤',
  noText: 'Issue にする文が見つからないよ〜',
  unknownCommand: 'それは知らない操作だよ〜',
};
