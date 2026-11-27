// 测试 mistakes.js 纯函数：错题去重、订正判定、回译错误聚合、重练词选择
// 沿用 test-anchor.js 的抽取模式：剥掉 export/import 后整体加载

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'mistakes.js'), 'utf8')
  .replace(/^import\s+.*$/gm, '')
  .replace(/^export\s+/gm, '');

const mod = { exports: {} };
new Function('module', 'exports', `${src}
module.exports = { collectMistakes, summarizeMistakes, retryWordIds, linkWords, mistakeTypeLabel, normalizeText, simpleLemma };`)(mod, mod.exports);
const { collectMistakes, retryWordIds, linkWords, mistakeTypeLabel, normalizeText } = mod.exports;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`); }
}

const WORDS = [
  { id: 'w1', term: 'abandon', meaning: '放弃' },
  { id: 'w2', term: 'fragile', meaning: '脆弱的' },
  { id: 'w3', term: 'quantum', meaning: '量子' }
];

const ATTEMPTS = [
  {
    id: 'a1', quizId: 'q1', finishedAt: '2026-11-20T10:00:00.000Z', date: '2026-11-20',
    answers: [
      { questionId: 'q1-1', type: 'meaning', prompt: 'abandon 的意思是', response: '坚持', answer: '放弃', correct: false, score: 0, feedback: '正确答案：放弃', wordIds: ['w1'] },
      { questionId: 'q1-2', type: 'spell', prompt: '拼写 fragile', response: 'fragile', answer: 'fragile', correct: true, score: 100, wordIds: ['w2'] },
      { questionId: 'q1-3', type: 'translation', prompt: '翻译句子', response: 'wrong', answer: '参考译文', correct: false, score: 40, feedback: '注意时态', wordIds: [] }
    ]
  },
  {
    id: 'a2', quizId: 'q2', finishedAt: '2026-11-21T10:00:00.000Z', date: '2026-11-21',
    answers: [
      { questionId: 'q1-1', type: 'meaning', prompt: 'abandon 的意思是', response: '放弃', answer: '放弃', correct: true, score: 100, wordIds: ['w1'] },
      { questionId: 'q2-1', type: 'spell', prompt: '拼写 quantum', response: 'quantun', answer: 'quantum', correct: false, score: 0, wordIds: ['w3'] }
    ]
  },
  {
    id: 'bt1', type: 'backtranslate', at: '2026-11-20T12:00:00.000Z',
    sentence: 'They abandon the fragile plan.', translation: '他们放弃了这个脆弱的计划。',
    response: 'They abandoned the plan.', score: 50,
    errorTypes: [{ type: '时态/词形', count: 2 }, { type: '遗漏', count: 1 }]
  },
  {
    id: 'bt2', type: 'backtranslate', at: '2026-11-21T12:00:00.000Z',
    sentence: 'They abandon the fragile plan.', translation: '他们放弃了这个脆弱的计划。',
    response: 'They abandon the fragile plan.', score: 90, errorTypes: []
  },
  {
    id: 'bt3', type: 'backtranslate', at: '2026-11-22T12:00:00.000Z',
    sentence: 'Quantum physics is hard.', translation: '量子物理很难。',
    response: 'Quantum physics hard.', score: 60,
    errorTypes: [{ type: '搭配', count: 1 }]
  }
];

const { items, summary } = collectMistakes(ATTEMPTS, WORDS);

console.log('=== 1. 去重与订正判定 ===');
check('错题条目数（含未重练的翻译题与已订正题）', items.length, 5);
const q1 = items.find((x) => x.id === 'quiz:q1-1');
check('同题两次错误合并', [q1.wrongCount, q1.resolved], [1, true]);
const q2 = items.find((x) => x.id === 'quiz:q2-1');
check('新题未订正', [q2.wrongCount, q2.resolved], [1, false]);
const bt = items.find((x) => x.id === `bt:${normalizeText('They abandon the fragile plan.')}`);
check('回译同句最新一次及格 → 已订正', [bt.wrongCount, bt.resolved], [1, true]);
const bt3 = items.find((x) => x.id === `bt:${normalizeText('Quantum physics is hard.')}`);
check('回译未及格', [bt3.wrongCount, bt3.resolved], [1, false]);

console.log('=== 2. 汇总 ===');
check('总条目 / 待订正 / 已订正', [summary.total, summary.pending, summary.resolved], [5, 3, 2]);
check('待订正题型计数', Object.entries(summary.byType).sort(), [['backtranslate', 1], ['spell', 1], ['translation', 1]]);
check('回译错误类型聚合（保留已订正的历史证据）', Object.entries(summary.byError).sort(), [['时态/词形', 2], ['搭配', 1], ['遗漏', 1]].sort());
check('最高频错误类型', summary.topError, { type: '时态/词形', count: 2 });
check('关联词只统计待订正条目', summary.byWord.map((w) => [w.term, w.count]), [['quantum', 2]]);

console.log('=== 3. 重练词 ===');
check('只取未订正条目的词', retryWordIds(items), ['w3']);

console.log('=== 4. 句子 → 词库词 ===');
check('回译句命中两个词条', linkWords('They abandon the fragile plan.', WORDS), ['w1', 'w2']);
check('词形变化命中', linkWords('She abandoned it.', WORDS), ['w1']);
check('无关句', linkWords('Nothing here.', WORDS), []);

console.log('=== 5. 标签 ===');
check('题目类型标签', mistakeTypeLabel('meaning'), '释义选择');
check('回译标签', mistakeTypeLabel('backtranslate'), '回译');
check('未知类型回退', mistakeTypeLabel('custom'), 'custom');

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
