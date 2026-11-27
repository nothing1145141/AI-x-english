// 数据层：IndexedDB 本地优先 + 服务端落盘同步

import { uid } from './ui.js';
import { isNative } from './bridge.js';

const DB_NAME = 'wordwise-ai';
const STORE_NAME = 'kv';

function openDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('浏览器不支持 IndexedDB'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE_NAME)) req.result.createObjectStore(STORE_NAME);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

export const DEFAULT_SETTINGS = {
  apiMode: 'server',          // server | custom
  customApiBase: '',
  customApiKey: '',
  textModel: 'Hy4-flash',
  visionModel: 'MiniCPM-V-4.7-35B-A3B',
  gradingModel: 'Hy4-flash',
  dailyCount: 10,
  reminderEnabled: false,
  reminderTime: '20:00',
  pushSubscribed: false,
  autoReminderReady: false
};

function normalize(input = {}) {
  return {
    version: 2,
    words: Array.isArray(input.words) ? input.words : [],
    articles: Array.isArray(input.articles) ? input.articles : [],
    sentenceHistory: Array.isArray(input.sentenceHistory) ? input.sentenceHistory : [],
    quizzes: Array.isArray(input.quizzes) ? input.quizzes : [],
    attempts: Array.isArray(input.attempts) ? input.attempts : [],
    speakings: Array.isArray(input.speakings) ? input.speakings : [],
    activity: Array.isArray(input.activity) ? input.activity : [],
    settings: Object.assign({}, DEFAULT_SETTINGS, input.settings || {}),
    meta: Object.assign({}, input.meta || {}),
    updatedAt: input.updatedAt || null
  };
}

let state = normalize();
let storageKey = 'state';
const listeners = new Set();
const syncListeners = new Set();
let saveTimer = null;
let syncStatus = { level: 'ok', text: '本地就绪' };

/* ---------- 本地 / 远端合并（按 id 取并集，绝不整份覆盖） ---------- */
function mergeTombstones(x, y) {
  const out = { words: {}, articles: {}, sentenceHistory: {}, quizzes: {}, attempts: {}, speakings: {} };
  for (const src of [x, y]) {
    if (!src) continue;
    for (const type of Object.keys(out)) Object.assign(out[type], src[type] || {});
  }
  return out;
}

function mergeState(a, b) {
  if (!a) return b || {};
  if (!b) return a || {};
  const metaA = a.meta || {}, metaB = b.meta || {};
  const tombs = mergeTombstones(metaA.tombstones, metaB.tombstones);

  const alive = (item, type) => {
    const t = tombs[type]?.[item.id];
    if (!t) return true;
    return new Date(item.updatedAt || item.createdAt || 0).getTime() > t;
  };
  const union = (key) => {
    const m = new Map();
    for (const item of [...(a[key] || []), ...(b[key] || [])]) {
      if (!item || !item.id || !alive(item, key)) continue;
      const old = m.get(item.id);
      if (!old) { m.set(item.id, item); continue; }
      const t1 = new Date(old.updatedAt || old.createdAt || 0).getTime();
      const t2 = new Date(item.updatedAt || item.createdAt || 0).getTime();
      if (t2 > t1) m.set(item.id, item);
    }
    return [...m.values()];
  };

  const activityMap = new Map();
  for (const d of [...(a.activity || []), ...(b.activity || [])]) {
    if (!d?.date) continue;
    const old = activityMap.get(d.date);
    if (!old) { activityMap.set(d.date, d); continue; }
    activityMap.set(d.date, {
      date: d.date,
      wordsAdded: Math.max(old.wordsAdded || 0, d.wordsAdded || 0),
      questions: Math.max(old.questions || 0, d.questions || 0),
      correct: Math.max(old.correct || 0, d.correct || 0),
      quizzes: Math.max(old.quizzes || 0, d.quizzes || 0),
      minutes: Math.max(old.minutes || 0, d.minutes || 0)
    });
  }

  const newer = new Date(a.updatedAt || 0).getTime() >= new Date(b.updatedAt || 0).getTime() ? a : b;
  const older = newer === a ? b : a;
  const learnA = metaA.learn || {}, learnB = metaB.learn || {};
  const learned = Object.assign({}, learnA.learned || {});
  for (const [k, v] of Object.entries(learnB.learned || {})) {
    const old = learned[k];
    if (!old || new Date(v.lastAt || 0).getTime() > new Date(old.lastAt || 0).getTime()) learned[k] = v;
  }
  const daily = Object.assign({}, learnA.daily || {});
  for (const [k, v] of Object.entries(learnB.daily || {})) {
    const old = daily[k] || { count: 0, right: 0 };
    daily[k] = { count: Math.max(old.count || 0, v.count || 0), right: Math.max(old.right || 0, v.right || 0) };
  }

  return {
    version: 2,
    words: union('words'),
    articles: union('articles').sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || ''))),
    sentenceHistory: union('sentenceHistory'),
    quizzes: union('quizzes'),
    attempts: union('attempts'),
    speakings: union('speakings').sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || ''))),
    activity: [...activityMap.values()].sort((x, y) => x.date.localeCompare(y.date)),
    settings: Object.assign({}, older.settings, newer.settings),
    meta: Object.assign({}, older.meta, newer.meta, {
      tombstones: tombs,
      learn: { learned, daily, goal: learnB.goal || learnA.goal || 20 }
    }),
    updatedAt: new Date().toISOString()
  };
}

function addTombstone(type, id) {
  if (!state.meta) state.meta = {};
  if (!state.meta.tombstones) state.meta.tombstones = {};
  if (!state.meta.tombstones[type]) state.meta.tombstones[type] = {};
  state.meta.tombstones[type][id] = Date.now();
}

function emit() { listeners.forEach((fn) => { try { fn(state); } catch (_) {} }); }
function emitSync() { syncListeners.forEach((fn) => { try { fn(syncStatus); } catch (_) {} }); }
function setSync(level, text) { syncStatus = { level, text }; emitSync(); }

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function onSync(fn) { syncListeners.add(fn); fn(syncStatus); return () => syncListeners.delete(fn); }
export function getState() { return state; }
export function getSettings() { return state.settings; }

export async function init(userId) {
  if (userId) storageKey = `state:${userId}`;
  let local = null, remote = null;
  try { local = await idbGet(storageKey); } catch (e) { console.warn('IDB 读取失败', e); }

  // APK 内：数据只存本机 IndexedDB，不请求服务端
  if (isNative()) {
    state = normalize(local || {});
    emit();
    setSync('ok', '已存本机');
    return state;
  }

  try {
    const res = await fetch('/api/data', { cache: 'no-store' });
    if (res.ok) remote = await res.json();
  } catch (_) { /* 离线 */ }

  // 本地与远端按 id 合并，避免任一端旧状态覆盖另一端
  state = normalize(mergeState(local, remote));

  // 首次启动同步服务端默认模型配置
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (res.ok) {
      const cfg = await res.json();
      if (!local && !remote) {
        state.settings.textModel = cfg.textModel || state.settings.textModel;
        state.settings.visionModel = cfg.visionModel || state.settings.visionModel;
        state.settings.gradingModel = cfg.gradingModel || state.settings.gradingModel;
        state.settings.dailyCount = cfg.dailyQuestionCount || state.settings.dailyCount;
      }
    }
  } catch (_) {}

  emit();
  // 两端都有数据时把合并结果写回，确保不再出现单端覆盖
  if (local && remote) save();
  return state;
}

export function save(immediate = false) {
  clearTimeout(saveTimer);
  const run = async () => {
    state.updatedAt = new Date().toISOString();
    try { await idbSet(storageKey, state); } catch (e) { setSync('error', '本地保存失败'); console.error(e); return; }
    if (isNative()) { setSync('ok', '已存本机'); return; }
    setSync('busy', '同步中');
    try {
      const res = await fetch('/api/data', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSync('ok', '已同步');
    } catch (err) {
      setSync('error', String(err.message || '').includes('401') ? '登录已失效' : '离线·仅本地');
    }
  };
  if (immediate) return run();
  saveTimer = setTimeout(run, 500);
}

export function setSettings(patch) {
  state.settings = Object.assign({}, state.settings, patch);
  emit(); save();
}

export function replaceAll(data) {
  state = normalize(data);
  emit(); return save(true);
}

/* ---------- 单词 ---------- */
export function getWords() { return state.words; }
export function getWord(id) { return state.words.find((w) => w.id === id); }

export function addWords(items) {
  let added = 0, updated = 0;
  for (const raw of items) {
    const term = String(raw.term || '').trim();
    if (!term) continue;
    const key = term.toLowerCase().replace(/\s+/g, ' ');
    const existing = state.words.find((w) => String(w.term).toLowerCase().replace(/\s+/g, ' ') === key);
    if (existing) {
      Object.assign(existing, raw, { updatedAt: new Date().toISOString() });
      updated++;
    } else {
      state.words.push({
        id: uid('w_'), term, phonetic: raw.phonetic || '', pos: raw.pos || '',
        meaning: raw.meaning || '', example: raw.example || '', exampleTranslation: raw.exampleTranslation || '',
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        source: raw.source || { type: 'manual' },
        srs: raw.srs || { level: 0, dueAt: Date.now(), ease: 2.5, seen: 0, correct: 0, wrong: 0, lastReview: null },
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
      });
      added++;
    }
  }
  if (added || updated) { emit(); save(); }
  return { added, updated };
}

export function updateWord(id, patch) {
  const w = getWord(id);
  if (!w) return false;
  Object.assign(w, patch, { updatedAt: new Date().toISOString() });
  emit(); save();
  return true;
}

export function deleteWord(id) {
  const before = state.words.length;
  state.words = state.words.filter((w) => w.id !== id);
  if (state.words.length !== before) { addTombstone('words', id); emit(); save(); return true; }
  return false;
}

/* ---------- 文章 / 阅读分析 ---------- */
export function getArticles() { return state.articles; }
export function getArticle(id) { return state.articles.find((a) => a.id === id); }

export function saveArticle(article) {
  const idx = state.articles.findIndex((a) => a.id === article.id);
  if (idx >= 0) state.articles[idx] = Object.assign({}, state.articles[idx], article, { updatedAt: new Date().toISOString() });
  else state.articles.unshift(Object.assign({
    id: uid('a_'), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }, article));
  emit(); save();
  return idx >= 0 ? state.articles[idx] : state.articles[0];
}

export function patchArticle(id, patch) {
  const a = getArticle(id);
  if (!a) return null;
  Object.assign(a, patch, { updatedAt: new Date().toISOString() });
  emit(); save();
  return a;
}

export function deleteArticle(id) {
  const before = state.articles.length;
  state.articles = state.articles.filter((a) => a.id !== id);
  if (state.articles.length !== before) { addTombstone('articles', id); emit(); save(); return true; }
  return false;
}

/** 缓存某句子的 AI 讲解结果 */
export function cacheSentence(articleId, index, explanation) {
  const a = getArticle(articleId);
  if (!a) return;
  if (!a.sentences) a.sentences = {};
  a.sentences[index] = Object.assign({ cachedAt: new Date().toISOString() }, explanation);
  emit(); save();
}

/** 合并更新某句缓存里的轻量数据（如精读对话轮次），不整体覆盖讲解对象 */
export function patchSentence(articleId, index, patch) {
  const a = getArticle(articleId);
  if (!a) return;
  if (!a.sentences) a.sentences = {};
  a.sentences[index] = Object.assign({}, a.sentences[index] || {}, patch);
  emit(); save();
}

/* ---------- 长难句讲解历史 ---------- */
export function getSentenceHistory() { return state.sentenceHistory; }

/** 记录一次句子讲解（含翻译/结构/可视化），同一句重复讲解会更新而不是堆积 */
export function recordSentence(entry) {
  const sentence = String(entry.sentence || '').trim();
  if (!sentence) return null;
  const key = sentence.toLowerCase().replace(/\s+/g, ' ');
  const now = new Date().toISOString();
  const idx = state.sentenceHistory.findIndex((h) =>
    String(h.sentence || '').toLowerCase().replace(/\s+/g, ' ') === key);
  const record = Object.assign({}, entry, {
    sentence,
    id: idx >= 0 ? state.sentenceHistory[idx].id : uid('sh_'),
    createdAt: idx >= 0 ? state.sentenceHistory[idx].createdAt : now,
    updatedAt: now,
    times: idx >= 0 ? (state.sentenceHistory[idx].times || 1) + 1 : 1
  });
  if (idx >= 0) state.sentenceHistory[idx] = record;
  else state.sentenceHistory.unshift(record);
  emit(); save();
  return record;
}

export function deleteSentenceHistory(id) {
  const before = state.sentenceHistory.length;
  state.sentenceHistory = state.sentenceHistory.filter((h) => h.id !== id);
  if (state.sentenceHistory.length !== before) { addTombstone('sentenceHistory', id); emit(); save(); return true; }
  return false;
}

export function clearSentenceHistory() {
  state.sentenceHistory.forEach((h) => addTombstone('sentenceHistory', h.id));
  state.sentenceHistory = [];
  emit(); save();
}

/* ---------- 口语评测记录 ---------- */
export function getSpeakings() { return state.speakings; }

export function saveSpeaking(entry) {
  if (!entry || !entry.id) return null;
  const now = new Date().toISOString();
  const idx = state.speakings.findIndex((s) => s.id === entry.id);
  const record = Object.assign({}, entry, {
    createdAt: idx >= 0 ? state.speakings[idx].createdAt : (entry.createdAt || now),
    updatedAt: now
  });
  if (idx >= 0) state.speakings[idx] = record;
  else state.speakings.unshift(record);
  state.speakings.sort((x, y) => String(y.createdAt || '').localeCompare(String(x.createdAt || '')));
  emit(); save();
  return record;
}

export function deleteSpeaking(id) {
  const before = state.speakings.length;
  state.speakings = state.speakings.filter((s) => s.id !== id);
  if (state.speakings.length !== before) {
    addTombstone('speakings', id);
    emit(); save();
    return true;
  }
  return false;
}

/* ---------- 试卷 / 作答 ---------- */
export function getQuizzes() { return state.quizzes; }
export function getQuiz(id) { return state.quizzes.find((q) => q.id === id); }
export function getQuizByDate(date) { return state.quizzes.find((q) => q.date === date); }

export function saveQuiz(quiz) {
  const idx = state.quizzes.findIndex((q) => q.id === quiz.id);
  if (idx >= 0) state.quizzes[idx] = quiz; else state.quizzes.push(quiz);
  emit(); save();
  return quiz;
}

export function getAttempts() { return state.attempts; }
export function getAttempt(id) { return state.attempts.find((a) => a.id === id); }

export function saveAttempt(attempt) {
  const idx = state.attempts.findIndex((a) => a.id === attempt.id);
  if (idx >= 0) state.attempts[idx] = attempt; else state.attempts.push(attempt);
  emit(); save();
  return attempt;
}

/* ---------- 活动统计 ---------- */
export function logActivity(date, patch) {
  let day = state.activity.find((a) => a.date === date);
  if (!day) {
    day = { date, wordsAdded: 0, questions: 0, correct: 0, quizzes: 0, minutes: 0 };
    state.activity.push(day);
  }
  Object.keys(patch).forEach((k) => { day[k] = (Number(day[k]) || 0) + (Number(patch[k]) || 0); });
  state.activity.sort((a, b) => a.date.localeCompare(b.date));
  emit(); save();
  return day;
}

export function getActivity(date) {
  return state.activity.find((a) => a.date === date) || { date, wordsAdded: 0, questions: 0, correct: 0, quizzes: 0, minutes: 0 };
}

export async function flush() { return save(true); }
