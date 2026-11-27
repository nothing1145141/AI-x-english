// 复习梳理：把「以前不牢固」的内容汇总成首页可执行的清单。
// 四类证据全部来自本地学习记录（SRS、试卷作答、阅读题结果、精读对话评分），不做 AI 推断。

import { isDue, mastery } from './srs.js';

const MAX_ITEMS = 5;

function lastTurnScore(entry) {
  const turns = Array.isArray(entry?.coachTurns) ? entry.coachTurns : [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t && t.role === 'me' && !t.pseudo && Number.isFinite(Number(t.score))) return Number(t.score);
  }
  return null;
}

/**
 * @param {object} state 全局 state
 * @returns {{total:number, words:object, mistakes:object, reading:object, sentences:object}}
 */
export function collectReview(state) {
  const s = state || {};

  // 1) 到期的词 / 答错过的词：掌握度低的优先
  const wordPool = (s.words || [])
    .filter((w) => isDue(w) || (w.srs?.wrong || 0) > 0)
    .sort((a, b) => mastery(a) - mastery(b) || (b.srs?.wrong || 0) - (a.srs?.wrong || 0));
  const words = {
    count: wordPool.filter(isDue).length,
    items: wordPool.slice(0, MAX_ITEMS).map((w) => ({
      id: w.id, term: w.term, meaning: w.meaning || '暂无释义',
      mastery: mastery(w), wrong: w.srs?.wrong || 0
    }))
  };

  // 2) 试卷里做错的选择/填空题：按最近作答去重
  const attempts = [...(s.attempts || [])]
    .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')));
  const seen = new Set();
  const wrongItems = [];
  for (const att of attempts) {
    for (const ans of att.answers || []) {
      if (ans.correct) continue;
      const key = String(ans.prompt || '').toLowerCase().replace(/\s+/g, ' ').slice(0, 60);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      wrongItems.push({
        attemptId: att.id,
        date: att.finishedAt || att.date || '',
        prompt: ans.prompt || '',
        answer: ans.modelAnswer || ans.answer || '',
        explain: ans.explain || '',
        response: ans.response || ''
      });
    }
  }
  const mistakes = { count: wrongItems.length, items: wrongItems.slice(0, MAX_ITEMS) };

  // 3) 阅读理解没过关的文章（正确 < 总题数）
  const readingItems = (s.articles || [])
    .filter((a) => a.readingResult && Number(a.readingResult.correct) < Number(a.readingResult.total))
    .sort((a, b) => String(b.readingResult.at || '').localeCompare(String(a.readingResult.at || '')))
    .map((a) => ({
      articleId: a.id,
      title: a.title || '未命名文章',
      correct: a.readingResult.correct,
      total: a.readingResult.total,
      at: a.readingResult.at || ''
    }));
  const reading = { count: readingItems.length, items: readingItems.slice(0, MAX_ITEMS) };

  // 4) 精读里自己翻得不理想的句子（最后一轮理解度 < 70）
  const sentenceItems = [];
  for (const a of s.articles || []) {
    const map = a.sentences || {};
    Object.keys(map).forEach((k) => {
      const i = Number(k);
      if (!Number.isFinite(i)) return;
      const entry = map[k];
      if (!entry || !entry.translation) return;
      const score = lastTurnScore(entry);
      if (score === null || score >= 70) return;
      sentenceItems.push({
        articleId: a.id,
        title: a.title || '未命名文章',
        index: i,
        sentence: entry.sentence || '',
        translation: entry.translation,
        score
      });
    });
  }
  sentenceItems.sort((a, b) => a.score - b.score);
  const sentences = { count: sentenceItems.length, items: sentenceItems.slice(0, MAX_ITEMS) };

  return {
    total: words.count + mistakes.count + reading.count + sentences.count,
    words, mistakes, reading, sentences
  };
}
