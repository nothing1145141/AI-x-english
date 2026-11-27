// 卡片速记的共享内核：背单词页与阅读器「背诵本文词」弹窗共用同一份进度与 SRS 记录。
// 只要从这两个入口答题，都会写入 state.meta.learn（今日计划 / 累计正确）并同步词库 SRS。

import { getState, save, updateWord, logActivity } from './store.js';
import { applyReview } from './srs.js';
import { dateKey } from './ui.js';

/** 学习进度（存于 state.meta.learn，不新增顶层字段） */
export function learnState() {
  const s = getState();
  if (!s.meta) s.meta = {};
  if (!s.meta.learn || typeof s.meta.learn !== 'object') {
    s.meta.learn = { learned: {}, daily: {}, goal: 20 };
  }
  if (!s.meta.learn.learned) s.meta.learn.learned = {};
  if (!s.meta.learn.daily) s.meta.learn.daily = {};
  return s.meta.learn;
}

export function dayStat() {
  const st = learnState();
  const k = dateKey();
  if (!st.daily[k]) st.daily[k] = { count: 0, right: 0 };
  return st.daily[k];
}

/**
 * 记录一次答题。
 * @param {string} term 词条
 * @param {boolean} ok 是否正确
 * @param {'list'|'article'} src 来源：词表 / 阅读。已有记录不会被覆盖，便于「阅读错词」追溯。
 */
export function recordAnswer(term, ok, src = 'list') {
  const st = learnState();
  const key = String(term || '').toLowerCase();
  if (!key) return;
  const r = st.learned[key] || { seen: 0, right: 0, wrong: 0, lastAt: null, src };
  r.seen++;
  r[ok ? 'right' : 'wrong']++;
  r.lastAt = new Date().toISOString();
  if (!r.src) r.src = src;
  // 阅读里答错单独计数：即使这个词先前在词表里练过，也应进入「阅读错词」
  if (!ok && src === 'article') r.readingWrong = (r.readingWrong || 0) + 1;
  st.learned[key] = r;
  const d = dayStat();
  d.count++;
  if (ok) d.right++;
  save();
}

/** 排序分：答对加分、答错扣分，越小越该先练 */
export function learnedScore(term) {
  const r = learnState().learned[String(term || '').toLowerCase()];
  if (!r) return 0;
  return r.right - r.wrong * 2 + (r.seen ? 1 : 0);
}

export function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 组题：错词优先，其次没练过的，再看已掌握的；选项不足 4 个时用同一批词补齐（外部保证 pool 足够大）。
 * @param {Array} words [{term, phonetic, pos, meaning, example, ref}]
 * @param {number} limit 本轮题目数
 */
export function buildQueue(words, limit = 20) {
  const all = (words || []).filter((w) => w.term && w.meaning);
  if (!all.length) return [];
  const goal = Math.max(1, Math.min(limit || all.length, all.length));
  const groups = new Map();
  all.forEach((w) => {
    const s = learnedScore(w.term);
    const g = s < 0 ? 0 : s === 0 ? 1 : 2;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(w);
  });
  const picked = [...(groups.get(0) || []), ...shuffle(groups.get(1) || []), ...shuffle(groups.get(2) || [])].slice(0, goal);
  return shuffle(picked).map((w, i) => {
    const others = shuffle(all.filter((o) => o.term.toLowerCase() !== w.term.toLowerCase() && o.meaning && o.meaning !== w.meaning)).slice(0, 3);
    const mode = i % 2 === 0 ? 'w2m' : 'm2w';
    const options = mode === 'w2m'
      ? shuffle([w.meaning, ...others.map((o) => o.meaning)])
      : shuffle([w.term, ...others.map((o) => o.term)]);
    return { word: w, mode, options, answer: mode === 'w2m' ? w.meaning : w.term };
  });
}

/** 一次作答：学习进度 + 词库 SRS + 今日统计 */
export function applyAnswer(word, ok, src = 'list') {
  recordAnswer(word.term, ok, src);
  if (word.ref) updateWord(word.ref.id, { srs: applyReview(word.ref, ok) });
  logActivity(dateKey(), { questions: 1, correct: ok ? 1 : 0 });
}
