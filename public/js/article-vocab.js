// 文章词汇标注：把正文与《高中核心词汇1000+高考超纲词》比对。
// 纯本地计算（词形还原 + 短语匹配），不调用 AI、不联网；同一篇文本结果会缓存。

import { VOCAB_CORE, VOCAB_EXTRA } from './vocab1000.js';
import { simpleLemma, normalizeTerm } from './coverage.js';

const WORD_RE = /[A-Za-z]+(?:['\u2019][A-Za-z]+)*/g;

/** 不能单独作为词条匹配的括号补充（多为语法占位或从句引导词） */
const SKIP_FORMS = new Set([
  'that', 'this', 'which', 'who', 'whom', 'whose', 'sb', 'sth', 'somebody', 'something',
  'pl', 'esp', 'etc', 'or', 'and', 'to', 'do', 'does', 'did'
]);

/** 只接受纯英文（含撇号与空格）的词条形式，避免把省略号、音标符号当成词 */
function validForm(f) {
  return !!f && f.length > 1 && !SKIP_FORMS.has(f) && /^[a-z][a-z' ]*$/.test(f);
}

/** 主词形候选：去掉括号补充、sth./sb. 占位、斜杠变体，返回 { label, forms[] } */
function parseTerm(raw) {
  const original = String(raw || '').trim();
  const extraForms = [];
  let base = original.replace(/\(([^)]*)\)/g, (_, inner) => {
    inner.split(/[,，;；]/).forEach((x) => {
      const f = normalizeTerm(x).replace(/^to\s+/, '');
      if (validForm(f) && !f.includes(' ')) extraForms.push(f);
    });
    return ' ';
  });
  base = base
    .replace(/\b(sth|sb|somebody|something)\b\.?/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.。…·;；,，]+$/g, '')
    .trim();
  const variants = base.split(/\s*\/\s*/).map((v) => normalizeTerm(v).replace(/^to\s+/, '')).filter(validForm);
  const forms = [...new Set([...variants, ...extraForms])].filter(validForm);
  const label = (variants[0] || original).replace(/^to\s+/, '');
  return { label, forms };
}

/** 词形候选：容忍 running/runs/studies/created 这类屈折变化 */
function tokenForms(token) {
  const t = normalizeTerm(token);
  if (!t) return [];
  const out = new Set([t, simpleLemma(t)]);
  const push = (v) => { if (v && v.length > 1) out.add(v); };
  if (/ing$/.test(t) && t.length > 4) {
    const stem = t.slice(0, -3);
    push(stem); push(`${stem}e`);
    if (/([bcdfgklmnprstvz])\1$/.test(stem)) push(stem.slice(0, -1));
  }
  if (/ed$/.test(t) && t.length > 4) {
    const stem = t.slice(0, -2);
    push(stem); push(`${stem}e`);
    if (/([bcdfgklmnprstvz])\1$/.test(stem)) push(stem.slice(0, -1));
  }
  if (/ies$/.test(t) && t.length > 4) push(`${t.slice(0, -3)}y`);
  if (/es$/.test(t) && t.length > 3) push(t.slice(0, -2));
  if (/s$/.test(t) && !/ss$/.test(t) && t.length > 3) push(t.slice(0, -1));
  if (/ier$/.test(t) && t.length > 4) push(`${t.slice(0, -3)}y`);
  if (/iest$/.test(t) && t.length > 5) push(`${t.slice(0, -4)}y`);
  return [...out];
}

/** 词表索引：单词 → 条目；短语单独放一组 */
function buildIndex(list, level) {
  const words = new Map();
  const phrases = [];
  for (const row of list) {
    if (!Array.isArray(row) || !row[0]) continue;
    const { label, forms } = parseTerm(row[0]);
    if (!forms.length) continue;
    const entry = { term: label, raw: String(row[0]).trim(), phonetic: row[1] || '', meaning: row[2] || '', level };
    for (const f of forms) {
      if (f.includes(' ')) phrases.push({ ...entry, phrase: f });
      else if (!words.has(f)) words.set(f, entry);
    }
  }
  return { words, phrases };
}

const INDEX = {
  core: buildIndex(VOCAB_CORE, 'core'),
  extra: buildIndex(VOCAB_EXTRA, 'extra')
};

function lookupWord(form) {
  return INDEX.core.words.get(form) || INDEX.extra.words.get(form) || null;
}

/** 在归一化后的词序列里查找短语，返回出现次数与首次位置 */
function countPhrase(phrase, joined) {
  const needle = ` ${phrase} `;
  let count = 0;
  let first = -1;
  let from = 0;
  const padded = ` ${joined} `;
  while (true) {
    const at = padded.indexOf(needle, from);
    if (at < 0) break;
    if (first < 0) first = at;
    count++;
    from = at + needle.length - 1;
  }
  return { count, first };
}

const cache = new Map();

/**
 * 统计文章命中的词表词汇。
 * @param {string} text 正文
 * @returns {{core:Array, extra:Array, surfaces:Map, coreCount:number, extraCount:number}}
 */
export function matchArticleVocab(text) {
  const src = String(text || '');
  if (cache.has(src)) return cache.get(src);

  const groups = new Map();
  const surfaces = new Map();
  const tokens = [];
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(src))) tokens.push({ raw: m[0], key: normalizeTerm(m[0]), pos: m.index });

  tokens.forEach((t, i) => {
    for (const form of tokenForms(t.key)) {
      const entry = lookupWord(form);
      if (!entry) continue;
      const key = `${entry.level}:${entry.term}`;
      let g = groups.get(key);
      if (!g) {
        g = {
          term: entry.term,
          raw: entry.raw,
          phonetic: entry.phonetic,
          meaning: entry.meaning,
          level: entry.level,
          count: 0,
          firstPos: t.pos,
          surfaces: new Set()
        };
        groups.set(key, g);
      }
      g.count++;
      g.surfaces.add(t.key);
      surfaces.set(t.key, { level: entry.level, term: entry.term, meaning: entry.meaning });
      break;
    }
  });

  const joined = tokens.map((t) => t.key).join(' ');
  for (const level of ['core', 'extra']) {
    for (const p of INDEX[level].phrases) {
      const { count, first } = countPhrase(p.phrase, joined);
      if (!count) continue;
      const key = `${level}:${p.term}`;
      const g = groups.get(key) || {
        term: p.term, raw: p.raw, phonetic: p.phonetic, meaning: p.meaning,
        level, count: 0, firstPos: first, surfaces: new Set()
      };
      g.count += count;
      g.surfaces.add(p.phrase);
      groups.set(key, g);
    }
  }

  const all = [...groups.values()].sort((a, b) => a.firstPos - b.firstPos || a.term.localeCompare(b.term));
  const result = {
    core: all.filter((g) => g.level === 'core'),
    extra: all.filter((g) => g.level === 'extra'),
    surfaces
  };
  result.coreCount = result.core.length;
  result.extraCount = result.extra.length;

  if (cache.size >= 6) cache.clear();
  cache.set(src, result);
  return result;
}

/** 词表整体（核心 + 超纲），用于背单词页出词：去重、清洗成可展示的词条 */
let listCache = null;
export function vocabList() {
  if (listCache) return listCache;
  const out = [];
  const seen = new Set();
  for (const [rows, level] of [[VOCAB_CORE, 'core'], [VOCAB_EXTRA, 'extra']]) {
    for (const row of rows) {
      if (!Array.isArray(row) || !row[0]) continue;
      const { label } = parseTerm(row[0]);
      const term = (label || String(row[0]).trim()).replace(/\s+/g, ' ').trim();
      const key = term.toLowerCase();
      if (!term || !row[2] || seen.has(key)) continue;
      seen.add(key);
      out.push({ term, phonetic: row[1] || '', meaning: row[2], level });
    }
  }
  listCache = out;
  return out;
}

/** 转成词库条目（与 addWords 的字段对齐） */
export function articleVocabEntries(list, articleId) {
  return (Array.isArray(list) ? list : [])
    .filter((w) => w && w.term && w.meaning)
    .map((w) => ({
      term: w.term,
      phonetic: w.phonetic || '',
      pos: '',
      meaning: w.meaning || '',
      source: { type: 'article-vocab', articleId: articleId || null, at: new Date().toISOString() }
    }));
}

function escapeHTML(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * 正文高亮：一次遍历同时处理「生词」与「词表命中词」，避免两次替换互相破坏标签。
 * @param {string} text 句子
 * @param {{unknown?:Set<string>, core?:Map<string,{level:string,meaning:string}>}} marks
 */
export function highlightSentence(text, { unknown = null, core = null } = {}) {
  const s = String(text == null ? '' : text);
  let out = '';
  let last = 0;
  WORD_RE.lastIndex = 0;
  let m;
  while ((m = WORD_RE.exec(s))) {
    out += escapeHTML(s.slice(last, m.index));
    const key = normalizeTerm(m[0]);
    const hit = core && core.get(key);
    const isUnknown = unknown && unknown.has(key);
    const cls = [hit ? `vocab-${hit.level}` : '', isUnknown ? 'vocab-unknown' : ''].filter(Boolean).join(' ');
    out += cls
      ? `<span class="${cls}"${hit ? ` title="${escapeHTML(hit.term)}：${escapeHTML(hit.meaning)}"` : ''}>${escapeHTML(m[0])}</span>`
      : escapeHTML(m[0]);
    last = m.index + m[0].length;
  }
  out += escapeHTML(s.slice(last));
  return out;
}
