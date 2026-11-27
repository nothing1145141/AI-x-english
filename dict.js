'use strict';
/**
 * 内置词典查询：按首字母分片懒加载，含词形变化匹配。
 * 数据源：ECDICT（MIT），经 tools/build_dict.py 转换为 data/dict/parts/*.json
 */

const fs = require('fs');
const path = require('path');

const DICT_DIR = path.join(__dirname, 'data', 'dict');
const PARTS_DIR = path.join(DICT_DIR, 'parts');
const META_FILE = path.join(DICT_DIR, 'meta.json');
const cache = new Map();
const MAX_CACHE = 12;

function available() {
  try { return fs.existsSync(META_FILE) && fs.existsSync(PARTS_DIR); }
  catch (_) { return false; }
}

function meta() {
  try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); }
  catch (_) { return null; }
}

function shardPath(term) {
  const k = String(term || '')[0]?.toLowerCase() || '_';
  return path.join(PARTS_DIR, /^[a-z]$/.test(k) ? `${k}.json` : '_.json');
}

function loadShard(term) {
  const file = shardPath(term);
  if (cache.has(file)) return cache.get(file);
  let data = null;
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (_) { data = null; }
  if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value);
  cache.set(file, data);
  return data;
}

/** exchange: d:abandoned|p:abandoned|3:abandons|i:abandoning|r:abandonment */
function matchExchange(entry, word) {
  if (!entry.x) return false;
  return entry.x.split('|').some((seg) => {
    const v = seg.split(':')[1];
    return v && v.toLowerCase() === word;
  });
}

function format(entry) {
  const norm = (s) => String(s || '').replace(/\\n/g, '\n').replace(/\r/g, '');
  const lines = norm(entry.t).split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const poss = [...new Set(lines.map((l) => (l.match(/^\s*(?:n|v|adj|adv|prep|conj|pron|num|art|int|aux|vi|vt|abbr)\./i) || [''])[0].replace('.', '').trim()).filter(Boolean))];
  return {
    term: entry.w,
    phonetic: entry.p ? (entry.p.startsWith('/') ? entry.p : `/${entry.p}/`) : '',
    definition: norm(entry.d),
    meanings: lines,
    pos: poss.join('/'),
    exchange: entry.x || '',
    tags: entry.g ? entry.g.split(/\s+/).filter(Boolean) : [],
    frequency: entry.f || null
  };
}

/** 精确查询；未命中时尝试词形变化 */
function lookup(raw) {
  const word = String(raw || '').trim().toLowerCase();
  if (!word || !available()) return null;
  const shard = loadShard(word);
  if (!Array.isArray(shard)) return null;

  let exact = null, derived = null;
  for (const e of shard) {
    const w = String(e.w || '').toLowerCase();
    if (w === word) { exact = e; break; }
    if (!derived && matchExchange(e, word)) derived = e;
  }
  const hit = exact || derived;
  return hit ? format(hit) : null;
}

/**
 * 批量查询：一次查一篇文章的去重词表。
 * 按首字母分组，每个分片只扫描一次，避免逐词反复遍历大数组。
 * 返回 { [查询词]: { term, phonetic, meaning, pos, tags, frequency, exchange } }
 */
function lookupMany(rawTerms, limit = 3000) {
  const words = [];
  const seen = new Set();
  for (const raw of Array.isArray(rawTerms) ? rawTerms : []) {
    const w = String(raw || '').trim().toLowerCase();
    if (!w || w.length > 64 || seen.has(w)) continue;
    seen.add(w);
    words.push(w);
    if (words.length >= limit) break;
  }
  const out = {};
  if (!words.length || !available()) return out;

  const groups = new Map();
  for (const w of words) {
    const file = shardPath(w);
    if (!groups.has(file)) groups.set(file, []);
    groups.get(file).push(w);
  }

  for (const [file, list] of groups) {
    const shard = loadShard(list[0]);
    if (!Array.isArray(shard)) continue;
    const exact = new Map();
    const derived = new Map();
    for (const e of shard) {
      const key = String(e.w || '').toLowerCase();
      if (!key) continue;
      if (!exact.has(key)) exact.set(key, e);
      if (!e.x) continue;
      for (const seg of String(e.x).split('|')) {
        const v = seg.split(':')[1];
        if (!v) continue;
        const k = v.toLowerCase();
        if (!derived.has(k)) derived.set(k, e);
      }
    }
    for (const w of list) {
      const hit = exact.get(w) || derived.get(w);
      if (!hit) continue;
      const f = format(hit);
      out[w] = {
        term: f.term,
        phonetic: f.phonetic,
        meaning: f.meanings[0] || '',
        pos: f.pos,
        tags: f.tags,
        frequency: f.frequency,
        exchange: f.exchange
      };
    }
  }
  return out;
}

/** 前缀联想，最多 limit 条 */
function suggest(raw, limit = 8) {
  const word = String(raw || '').trim().toLowerCase();
  if (!word || !available()) return [];
  const out = [];
  const shard = loadShard(word);
  if (!Array.isArray(shard)) return [];
  for (const e of shard) {
    const w = String(e.w || '').toLowerCase();
    if (w.startsWith(word) && w !== word) {
      out.push({ term: e.w, meaning: String(e.t || '').split(/\n+/)[0] || '', phonetic: e.p || '' });
      if (out.length >= limit) break;
    }
  }
  return out;
}

module.exports = { available, meta, lookup, lookupMany, suggest };
