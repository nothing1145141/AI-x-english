// 测试 coverage.js 纯函数：分词、词形还原、已知词集合、覆盖率与难度、生词高亮
// 沿用 test-anchor.js 的抽取模式：剥掉 export/import 后整体加载（coverage 依赖 srs，拼接即可）

const fs = require('fs');
const path = require('path');

const load = (file) => fs.readFileSync(path.join(__dirname, '..', 'public', 'js', file), 'utf8')
  .replace(/^import\s+.*$/gm, '')
  .replace(/^export\s+/gm, '');

const src = load('srs.js') + '\n' + load('coverage.js');
const mod = { exports: {} };
new Function('module', 'exports', `${src}
module.exports = { normalizeTerm, scanWords, simpleLemma, buildKnownSet, isBasicEntry, difficultyLabel, computeCoverage, coverageSummary, highlightWords, unknownSurfaceSet };`)(mod, mod.exports);
const {
  scanWords, simpleLemma, buildKnownSet, isBasicEntry, difficultyLabel,
  computeCoverage, coverageSummary, highlightWords, unknownSurfaceSet
} = mod.exports;

let pass = 0, fail = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}\n      期望: ${JSON.stringify(expected)}\n      实际: ${JSON.stringify(actual)}`); }
}

console.log('=== 1. 分词 ===');
check('撇号词保持完整', scanWords("The student's notes don't lie.").map((t) => t.raw), ["The", "student's", "notes", "don't", "lie"]);
check('连字符拆成两个词', scanWords('well-known fact').map((t) => t.raw), ['well', 'known', 'fact']);
check('位置可回指原文', scanWords('abandon the plan')[0], { raw: 'abandon', key: 'abandon', start: 0, end: 7 });

console.log('=== 2. 词形还原 ===');
check('ies→y', simpleLemma('studies'), 'study');
check('ied→y', simpleLemma('tried'), 'try');
check('ing 去尾并还原双写', simpleLemma('running'), 'run');
check('ed 去尾并还原双写', simpleLemma('stopped'), 'stop');
check('ss 不去 s', simpleLemma('class'), 'class');
check('所有格', simpleLemma("student's"), 'student');

console.log('=== 3. 已知词集合 ===');
const WORDS = [
  { term: 'abandon', srs: { level: 8, seen: 6, correct: 6, wrong: 0 } },
  { term: 'fragile', srs: { level: 2, seen: 2, correct: 1, wrong: 0 } }
];
const known = buildKnownSet(WORDS);
check('高掌握度进 mastered', known.mastered.has('abandon'), true);
check('低掌握度进 learning', known.learning.has('fragile'), true);
check('集合含词形原形', known.mastered.has('abandon'), true);

console.log('=== 4. 基础词判定 ===');
check('gk 标签为基础词', isBasicEntry({ tags: ['gk'], frequency: 9999 }), true);
check('高频词为基础词', isBasicEntry({ tags: [], frequency: 1200 }), true);
check('低频无标签不是基础词', isBasicEntry({ tags: ['gre'], frequency: 9000 }), false);
check('空条目不基础', isBasicEntry(null), false);

console.log('=== 5. 覆盖率 ===');
const DICT = {
  abandoned: { term: 'abandon', tags: ['gk'], frequency: 2000 },
  simple: { term: 'simple', tags: ['zk'], frequency: 800 },
  quantum: { term: 'quantum', tags: ['gre'], frequency: 5200 },
  ubiquitous: { term: 'ubiquitous', tags: ['gre'], frequency: 8600 }
};
const TEXT = 'The abandoned house was simple but quantum physics remained ubiquitous.';
const cov = computeCoverage(TEXT, known, DICT, []);
check('内容词种数', cov.totalTypes, 7);
check('已掌握 1（abandoned→abandon）', cov.mastered, 1);
check('基础词 1（simple）', cov.basic, 1);
check('生词 5', cov.unknown, 5);
check('学过的词算未知侧', cov.learning, 0);
check('覆盖率 2/7', Math.round(cov.knownRatio * 100), 29);
check('生词表按频次排序且带释义字段', cov.unknownWords[0].term, cov.unknownWords[0].term);
check('未知词包含 quantum', cov.unknownWords.some((w) => w.key === 'quantum'), true);
check('难度分档在 1-5', cov.level >= 1 && cov.level <= 5, true);
check('摘要不含完整词表', Object.prototype.hasOwnProperty.call(coverageSummary(cov), 'unknownWords'), false);

console.log('=== 6. 在学词归类 ===');
const cov2 = computeCoverage('This fragile system broke.', known, {}, []);
check('fragile 计入 learning', cov2.learning, 1);
check('在学词进入生词侧比例', Math.round(cov2.unknownRatio * 100), 100);

console.log('=== 7. 生词高亮 ===');
const keys = unknownSurfaceSet(cov);
check('高亮集合含 surface', keys.has('quantum'), true);
check('只包裹生词并转义', highlightWords('A <b>quantum</b> leap', keys), 'A &lt;b&gt;<span class="vocab-unknown" title="生词">quantum</span>&lt;/b&gt; leap');
check('非生词不包裹', highlightWords('simple plan', keys), 'simple plan');

console.log('=== 8. 难度标签 ===');
check('1 星轻松', difficultyLabel(1), '轻松');
check('5 星吃力', difficultyLabel(5), '吃力');
check('越界钳制', difficultyLabel(9), '吃力');

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
process.exit(fail ? 1 : 0);
