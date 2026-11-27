// 生词覆盖率与难度：把「这篇文章我大概能读懂多少」变成可解释的本地计算。
// 依赖用户词库掌握度 + ECDICT 词频/标签；不做 AI 推断，结果可复现。
// 统计口径：按词种（type）而不是词次，避免 a/the 这类高频词把覆盖率冲高。

import { mastery } from './srs.js';

/** 功能词：不参与生词统计（学生几乎不可能不认识，算进去只会虚高覆盖率） */
export const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'nor', 'so', 'yet', 'for',
  'i', 'me', 'my', 'mine', 'myself', 'we', 'us', 'our', 'ours', 'ourselves',
  'you', 'your', 'yours', 'yourself', 'yourselves', 'he', 'him', 'his', 'himself',
  'she', 'her', 'hers', 'herself', 'it', 'its', 'itself', 'they', 'them', 'their',
  'theirs', 'themselves', 'this', 'that', 'these', 'those', 'who', 'whom', 'whose',
  'which', 'what', 'when', 'where', 'why', 'how', 'there', 'here',
  'in', 'on', 'at', 'to', 'of', 'by', 'with', 'from', 'about', 'as', 'into', 'onto',
  'over', 'under', 'between', 'among', 'through', 'during', 'before', 'after',
  'above', 'below', 'up', 'down', 'out', 'off', 'across', 'along', 'around',
  'near', 'behind', 'beside', 'beyond', 'within', 'without', 'against', 'upon',
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'done', 'doing', 'have', 'has', 'had', 'having',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  'not', 'no', 'yes', 'if', 'unless', 'because', 'since', 'though', 'although',
  'while', 'whereas', 'than', 'then', 'too', 'very', 'just', 'also', 'only',
  'more', 'most', 'less', 'least', 'such', 'some', 'any', 'all', 'both', 'each',
  'every', 'either', 'neither', 'other', 'another', 'same', 'own', 'few', 'many',
  'much', 'several', 'one', 'two', 'three', 'first', 'second', 'third',
  'mr', 'mrs', 'ms', 'dr', 'etc', 'eg', 'ie'
]);

/** ECDICT 中代表「基础词」的标签 */
const BASIC_TAGS = new Set(['zk', 'gk', 'cet4', 'cet6']);
/** 词频排名不超过该值，默认视为基础词 */
const BASIC_FREQ = 3000;

const WORD_RE = /[A-Za-z]+(?:['\u2019][A-Za-z]+)*/g;

/** 归一化：小写、弯撇号折直、空白折叠 */
export function normalizeTerm(term) {
  return String(term == null ? '' : term)
    .toLowerCase()
    .replace(/[\u2019\u2018]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** 扫描正文中的英文词，保留原始形式与位置 */
export function scanWords(text) {
  const out = [];
  const s = String(text == null ? '' : text);
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(s))) {
    out.push({ raw: m[0], key: normalizeTerm(m[0]), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/** 双写辅音还原：running→runn→run，stopped→stopp→stop */
function undouble(w) {
  return /([bcdfgklmnprstvz])\1$/.test(w) ? w.slice(0, -1) : w;
}

/** 轻量词形还原：只为匹配词库已收录的原形，不追求语言学正确 */
export function simpleLemma(word) {
  const w = normalizeTerm(word);
  if (!w || w.length <= 3) return w;
  if (w.endsWith("'s")) return w.slice(0, -2);
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ied') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('es') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  if (w.endsWith('ed') && w.length > 4) return undouble(w.slice(0, -2));
  if (w.endsWith('ing') && w.length > 5) return undouble(w.slice(0, -3));
  if (w.endsWith('ly') && w.length > 4) return w.slice(0, -2);
  return w;
}

/**
 * 从词库构建已知词集合。
 * 已掌握：mastery >= masteredMin；在学：其余已入库词。
 * 集合同时写入原形，命中 running→run 这类词形变化。
 */
export function buildKnownSet(words, { masteredMin = 50 } = {}) {
  const mastered = new Set();
  const learning = new Set();
  for (const w of Array.isArray(words) ? words : []) {
    const key = normalizeTerm(w && w.term);
    if (!key) continue;
    const target = mastery(w) >= masteredMin ? mastered : learning;
    target.add(key);
    target.add(simpleLemma(key));
  }
  return { mastered, learning };
}

/** 判断 ECDICT 条目是否属于「基础词」 */
export function isBasicEntry(entry) {
  if (!entry) return false;
  const tags = Array.isArray(entry.tags)
    ? entry.tags
    : String(entry.tags || '').split(/\s+/).filter(Boolean);
  if (tags.some((t) => BASIC_TAGS.has(String(t).toLowerCase()))) return true;
  const freq = Number(entry.frequency) || 0;
  return freq > 0 && freq <= BASIC_FREQ;
}

/** 难度分档 */
export function difficultyLabel(level) {
  return ['轻松', '适中', '有挑战', '困难', '吃力'][Math.max(0, Math.min(4, (level || 1) - 1))];
}

/**
 * 计算文章覆盖率与难度。
 * @param {string} text 正文
 * @param {{mastered:Set<string>, learning:Set<string>}} knownSet
 * @param {Object} dictInfo 查询词 -> ECDICT 条目
 * @param {Array} hardSentences 本地 NLP 已识别的长难句
 */
export function computeCoverage(text, knownSet, dictInfo = {}, hardSentences = []) {
  const known = knownSet || { mastered: new Set(), learning: new Set() };
  const tokens = scanWords(text);
  const sentences = String(text == null ? '' : text)
    .split(/[.!?]+(?=\s|$)/)
    .map((s) => s.trim())
    .filter(Boolean);

  const groups = new Map();
  let contentTokens = 0;

  for (const t of tokens) {
    if (STOP_WORDS.has(t.key)) continue;
    contentTokens++;
    const info = (dictInfo && (dictInfo[t.key] || dictInfo[simpleLemma(t.key)])) || null;
    const base = normalizeTerm((info && info.term) || simpleLemma(t.key));
    let g = groups.get(base);
    if (!g) {
      g = { key: base, count: 0, surfaces: new Set(), info };
      groups.set(base, g);
    }
    g.count++;
    g.surfaces.add(t.key);
    if (!g.info && info) g.info = info;
  }

  let masteredCount = 0;
  let learningCount = 0;
  let basicCount = 0;
  let unknownCount = 0;
  const unknownWords = [];
  const learningWords = [];

  for (const g of groups.values()) {
    const surfaces = [...g.surfaces];
    const inMastered = known.mastered.has(g.key) || surfaces.some((s) => known.mastered.has(s));
    const inLearning = known.learning.has(g.key) || surfaces.some((s) => known.learning.has(s));
    const pack = {
      term: (g.info && g.info.term) || g.key,
      key: g.key,
      count: g.count,
      phonetic: (g.info && g.info.phonetic) || '',
      meaning: (g.info && g.info.meaning) || '',
      tags: (g.info && g.info.tags) || [],
      surfaces
    };

    if (inMastered) masteredCount++;
    else if (inLearning) {
      learningCount++;
      learningWords.push(pack);
    } else if (isBasicEntry(g.info)) {
      basicCount++;
    } else {
      unknownCount++;
      unknownWords.push(pack);
    }
  }

  const totalTypes = masteredCount + learningCount + basicCount + unknownCount;
  const knownRatio = totalTypes ? (masteredCount + basicCount) / totalTypes : 0;
  const unknownRatio = totalTypes ? (unknownCount + learningCount) / totalTypes : 0;

  const avgSentenceWords = sentences.length ? Math.round(tokens.length / sentences.length) : tokens.length;
  const hardCount = Array.isArray(hardSentences) ? hardSentences.length : 0;
  const hardRatio = sentences.length ? hardCount / sentences.length : 0;

  // 生词占 60%，长句占 25%，长难句密度占 15%
  const rawScore = unknownRatio * 60
    + Math.min(1, Math.max(0, (avgSentenceWords - 12) / 22)) * 25
    + Math.min(1, hardRatio * 3) * 15;
  const score = Math.round(rawScore);
  const level = score < 20 ? 1 : score < 40 ? 2 : score < 60 ? 3 : score < 80 ? 4 : 5;

  const byCount = (a, b) => b.count - a.count || a.term.localeCompare(b.term);

  return {
    totalTokens: tokens.length,
    contentTokens,
    totalTypes,
    mastered: masteredCount,
    learning: learningCount,
    basic: basicCount,
    unknown: unknownCount,
    knownRatio,
    unknownRatio,
    avgSentenceWords,
    hardCount,
    score,
    level,
    label: difficultyLabel(level),
    unknownWords: unknownWords.sort(byCount),
    learningWords: learningWords.sort(byCount)
  };
}

/** 存进文章对象的摘要（不存完整词表，避免文章对象膨胀） */
export function coverageSummary(data) {
  if (!data) return null;
  return {
    totalTypes: data.totalTypes,
    mastered: data.mastered,
    learning: data.learning,
    basic: data.basic,
    unknown: data.unknown,
    knownRatio: data.knownRatio,
    unknownRatio: data.unknownRatio,
    avgSentenceWords: data.avgSentenceWords,
    hardCount: data.hardCount,
    score: data.score,
    level: data.level,
    label: data.label
  };
}

/** 生词高亮：只替换英文词，其余文本照常转义 */
export function highlightWords(text, keys) {
  const mark = keys instanceof Set ? keys : new Set(keys || []);
  const s = String(text == null ? '' : text);
  let out = '';
  let last = 0;
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(s))) {
    out += escapeHTML(s.slice(last, m.index));
    const key = normalizeTerm(m[0]);
    out += mark.has(key) ? `<span class="vocab-unknown" title="生词">${escapeHTML(m[0])}</span>` : escapeHTML(m[0]);
    last = m.index + m[0].length;
  }
  out += escapeHTML(s.slice(last));
  return out;
}

/** 把正文生词表面形式摊平成高亮集合 */
export function unknownSurfaceSet(data) {
  const set = new Set();
  if (!data) return set;
  for (const w of data.unknownWords || []) {
    for (const s of w.surfaces || []) set.add(s);
  }
  return set;
}

function escapeHTML(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 批量取 ECDICT 信息（服务端按首字母分组扫描） */
export async function fetchDictBatch(terms) {
  const words = [];
  const seen = new Set();
  for (const raw of Array.isArray(terms) ? terms : []) {
    const w = normalizeTerm(raw);
    if (!w || seen.has(w)) continue;
    seen.add(w);
    words.push(w);
    if (words.length >= 1500) break;
  }
  if (!words.length) return {};
  const r = await fetch('/api/dict/batch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ words })
  });
  if (!r.ok) throw new Error(`词典批量查询失败（${r.status}）`);
  const data = await r.json();
  return (data && data.dict) || {};
}
