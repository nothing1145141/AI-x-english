// 错题聚合：把试卷作答里的错误与回译错误统一成错题条目。
// 纯函数，不依赖 UI / AI；订正状态由「同一题最新一次是否答对」推导，不新增存储字段。
// 试卷题以 questionId 去重；回译以句子归一化文本去重。

const TYPE_LABEL = {
  meaning: '释义选择',
  usage: '选词填空',
  fill: '单词填空',
  spell: '单词拼写',
  translation: '句子翻译',
  reading: '阅读理解',
  backtranslate: '回译'
};

export function mistakeTypeLabel(type) {
  return TYPE_LABEL[type] || type || '其他';
}

export function normalizeText(text) {
  return String(text == null ? '' : text)
    .toLowerCase()
    .replace(/[\u2019\u2018]/g, "'")
    .replace(/[^a-z0-9']+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function simpleLemma(word) {
  const w = normalizeText(word);
  if (!w || w.length <= 3) return w;
  if (w.endsWith('ies') && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2);
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

function tokensOf(text) {
  return normalizeText(text).split(' ').filter(Boolean);
}

function timeOf(attempt) {
  return String(attempt.finishedAt || attempt.at || attempt.createdAt || '');
}

/** 把句子中出现的词库词映射成 wordId，供错题重练卷使用 */
export function linkWords(text, words) {
  const tokenSet = new Set();
  for (const t of tokensOf(text)) {
    tokenSet.add(t);
    tokenSet.add(simpleLemma(t));
  }
  const out = [];
  for (const w of Array.isArray(words) ? words : []) {
    const key = normalizeText(w && w.term);
    if (!key) continue;
    if (tokenSet.has(key) || tokenSet.has(simpleLemma(key))) out.push(w.id);
  }
  return out;
}

/**
 * 汇总错题。
 * @param {Array} attempts state.attempts（试卷作答 + 回译记录混存）
 * @param {Array} words state.words
 * @returns {{items:Array, summary:Object}}
 */
export function collectMistakes(attempts, words = []) {
  const list = [...(Array.isArray(attempts) ? attempts : [])].sort((a, b) => timeOf(a).localeCompare(timeOf(b)));
  const wordMap = new Map((Array.isArray(words) ? words : []).map((w) => [w.id, w]));
  const quizGroups = new Map();
  const btGroups = new Map();

  for (const att of list) {
    if (Array.isArray(att.answers)) {
      for (const ans of att.answers) {
        if (!ans) continue;
        const key = ans.questionId || `${att.id || timeOf(att)}:${quizGroups.size}`;
        let g = quizGroups.get(key);
        if (!g) {
          g = { key, wrongCount: 0, last: null, lastAtt: null };
          quizGroups.set(key, g);
        }
        g.last = ans;
        g.lastAtt = att;
        if (!ans.correct) g.wrongCount++;
      }
      continue;
    }
    if (att.type === 'backtranslate' && att.sentence) {
      const key = normalizeText(att.sentence);
      if (!key) continue;
      let g = btGroups.get(key);
      if (!g) {
        g = { key, wrongCount: 0, last: null, errors: new Map() };
        btGroups.set(key, g);
      }
      g.last = att;
      if (Number(att.score) >= 80) continue;
      g.wrongCount++;
      for (const e of Array.isArray(att.errorTypes) ? att.errorTypes : []) {
        g.errors.set(e.type, (g.errors.get(e.type) || 0) + (Number(e.count) || 1));
      }
    }
  }

  const items = [];

  for (const g of quizGroups.values()) {
    if (!g.wrongCount) continue;
    const ans = g.last || {};
    items.push({
      id: `quiz:${g.key}`,
      source: 'quiz',
      type: ans.type || 'other',
      resolved: !!ans.correct,
      wrongCount: g.wrongCount,
      lastAt: timeOf(g.lastAtt || {}),
      prompt: ans.prompt || '',
      response: ans.response || '',
      answer: ans.modelAnswer || ans.answer || '',
      feedback: ans.feedback || '',
      explain: ans.explain || '',
      score: Number(ans.score) || 0,
      wordIds: Array.isArray(ans.wordIds) ? ans.wordIds : [],
      wordTerms: (Array.isArray(ans.wordIds) ? ans.wordIds : []).map((id) => wordMap.get(id)?.term).filter(Boolean),
      quizId: (g.lastAtt && g.lastAtt.quizId) || null,
      attemptId: (g.lastAtt && g.lastAtt.id) || null
    });
  }

  for (const g of btGroups.values()) {
    if (!g.wrongCount) continue;
    const att = g.last || {};
    const ids = linkWords(att.sentence || '', words);
    items.push({
      id: `bt:${g.key}`,
      source: 'backtranslate',
      type: 'backtranslate',
      resolved: Number(att.score) >= 80,
      wrongCount: g.wrongCount,
      lastAt: timeOf(att),
      sentence: att.sentence || '',
      translation: att.translation || '',
      response: att.response || '',
      score: Number(att.score) || 0,
      errorTypes: [...g.errors.entries()].map(([type, count]) => ({ type, count })),
      wordIds: ids,
      wordTerms: ids.map((id) => wordMap.get(id)?.term).filter(Boolean)
    });
  }

  items.sort((a, b) => String(b.lastAt).localeCompare(String(a.lastAt)));
  return { items, summary: summarizeMistakes(items, words) };
}

/** 错题统计：待订正/已订正、题型、回译错误类型、关联词条 */
export function summarizeMistakes(items, words = []) {
  const list = Array.isArray(items) ? items : [];
  const wordMap = new Map((Array.isArray(words) ? words : []).map((w) => [w.id, w]));
  const byType = {};
  const byError = {};
  const wordCount = new Map();

  for (const item of list) {
    if (!item.resolved) {
      byType[item.type] = (byType[item.type] || 0) + 1;
      for (const id of item.wordIds || []) {
        wordCount.set(id, (wordCount.get(id) || 0) + 1);
      }
    }
    // 错误类型统计保留已订正的历史证据，反映真实的易错点
    for (const e of item.errorTypes || []) {
      byError[e.type] = (byError[e.type] || 0) + (Number(e.count) || 1);
    }
  }

  const byWord = [...wordCount.entries()]
    .map(([id, count]) => {
      const w = wordMap.get(id);
      return { id, term: w?.term || id, meaning: w?.meaning || '', count };
    })
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));

  const errors = Object.entries(byError).sort((a, b) => b[1] - a[1]);
  const pending = list.filter((x) => !x.resolved).length;

  return {
    total: list.length,
    pending,
    resolved: list.length - pending,
    byType,
    byError,
    topError: errors.length ? { type: errors[0][0], count: errors[0][1] } : null,
    byWord
  };
}

/** 选择重练卷的目标词：优先未订正条目关联的词，按出现次数排序 */
export function retryWordIds(items, { limit = 20 } = {}) {
  const count = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (item.resolved) continue;
    for (const id of item.wordIds || []) count.set(id, (count.get(id) || 0) + 1);
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([id]) => id);
}
