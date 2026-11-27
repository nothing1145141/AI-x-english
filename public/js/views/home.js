import { getState } from '../store.js';
import { computeStats } from '../stats.js';
import { icon, esc, fmtDate } from '../ui.js';
import { go } from '../router.js';
import { collectReview } from '../review.js';

export const title = '今天';
export const subtitle = '学习记录与接下来要做的事';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];

export function render() {
  const state = getState();
  const st = computeStats(state);
  const now = new Date();

  const quiz = state.quizzes.find((q) => q.date === st.todayKey);
  const attempt = quiz ? state.attempts.find((a) => a.quizId === quiz.id) : null;

  const articles = [...state.articles]
    .sort((a, b) => String(b.updatedAt || b.createdAt || '').localeCompare(String(a.updatedAt || a.createdAt || '')))
    .slice(0, 5);

  // 一句话说清今天的状态：只陈述事实，不做鼓励。
  const bits = [];
  if (st.dueCount) bits.push(`${st.dueCount} 个词到期`);
  if (!quiz) bits.push('今天的卷子还没出');
  else if (!attempt) bits.push('今天的卷子还没做完');
  if (st.today.questions) bits.push(`已做 ${st.today.questions} 题`);
  const lead = bits.length ? `${bits.join('，')}。` : '今天没有到期的词，也没有待完成的卷子。';

  const attempts = [...state.attempts]
    .sort((a, b) => String(b.finishedAt || '').localeCompare(String(a.finishedAt || '')))
    .slice(0, 5);

  const review = collectReview(state);

  return `
    <div class="page-lead">
      <div>
        <p class="lead-date">${now.getMonth() + 1}月${now.getDate()}日 · 星期${WEEK[now.getDay()]}</p>
        <h2 class="lead-line">${lead}</h2>
      </div>
      <div class="lead-actions">
        <button class="btn" data-action="import" type="button">${icon('plus', 15)} 导入文章</button>
        <button class="btn btn-primary" data-action="lookup" type="button">查一个词</button>
      </div>
    </div>

    <div class="ledger">
      <div><span>词库</span><b>${st.totalWords}<em>${st.dueCount} 个到期</em></b></div>
      <div><span>已掌握</span><b>${st.mastered}<em>平均 ${st.masteryAvg}%</em></b></div>
      <div><span>今日正确率</span><b>${st.today.accuracy === null ? '—' : st.today.accuracy + '%'}<em>${st.today.questions} 题</em></b></div>
      <div><span>连续</span><b>${st.streak}<em>天</em></b></div>
    </div>

    ${renderReview(review)}

    <div class="grid home-main">
      <div class="home-col">
        <section class="card">
          <div class="card-head">
            <div><h2>文章</h2></div>
            <button class="btn btn-sm" data-action="reader" type="button">全部 ${icon('arrowRight', 13)}</button>
          </div>
          ${articles.length ? articles.map((a) => `
            <div class="art-row">
              <button class="list-row as-btn" data-action="open" data-id="${esc(a.id)}" type="button">
                <div class="row-main">
                  <div class="art-title">${esc(a.title || '未命名')}</div>
                  <div class="row-meta">${wordCount(a.text)} 词 · ${fmtDate(a.updatedAt || a.createdAt)}</div>
                </div>
                ${icon('arrowRight', 14)}
              </button>
              <button class="tts-btn" type="button" data-speak-article="${esc(a.id)}" title="听全文" aria-label="听全文：${esc(a.title || '未命名')}">${icon('volume', 14)}</button>
            </div>`).join('') : `
            <p class="row-empty">还没有导入文章。粘贴一段英文，或上传 txt / 拍照。</p>`}
        </section>

        <section class="card">
          <div class="card-head">
            <div><h2>试卷记录</h2></div>
            <button class="btn btn-sm" data-action="quizzes" type="button">全部 ${icon('arrowRight', 13)}</button>
          </div>
          ${attempts.length ? `
            <table class="table">
              <thead><tr><th>日期</th><th>试卷</th><th class="num">题数</th><th class="num">正确率</th><th class="num">用时</th></tr></thead>
              <tbody>
                ${attempts.map((a) => {
                  const q = state.quizzes.find((x) => x.id === a.quizId);
                  return `<tr data-action="result" data-id="${esc(a.id)}" class="clickable">
                    <td>${fmtDate(a.finishedAt)}</td>
                    <td>${esc(q?.title || '练习卷')}</td>
                    <td class="num">${a.answers?.length || 0}</td>
                    <td class="num">${a.accuracy ?? 0}%</td>
                    <td class="num">${Math.max(1, Math.round((a.durationMs || 0) / 60000))} 分</td>
                  </tr>`;
                }).join('')}
              </tbody>
            </table>` : `
            <p class="row-empty">还没有做过试卷。${quiz ? '今天的卷子已经出好了。' : ''}</p>`}
        </section>
      </div>

      <section class="card">
        <div class="card-head">
          <div><h2>薄弱的词</h2></div>
          ${st.dueCount ? `<button class="btn btn-sm" data-action="learn" type="button">开始复习</button>` : ''}
        </div>
        ${st.weak.length ? st.weak.slice(0, 7).map((w) => `
          <div class="list-row">
            <div class="row-main">
              <div class="word-term">${esc(w.term)}<button class="tts-btn" type="button" data-speak="${esc(w.term)}" title="听发音" aria-label="听 ${esc(w.term)} 的发音">${icon('volume', 12)}</button></div>
              <div class="row-meta">${esc(w.meaning || '暂无释义')}</div>
            </div>
            <div class="row-side">
              <span class="mastery-bar"><i style="width:${Math.max(2, w.mastery)}%;background:${w.mastery >= 50 ? 'var(--primary)' : 'var(--danger)'}"></i></span>
              <span class="tiny muted">${w.mastery}%</span>
            </div>
          </div>`).join('') : `
          <p class="row-empty">词库里还没有词。查一个词，或从文章里收几个。</p>`}
      </section>
    </div>
  `;
}

function wordCount(text) {
  return String(text || '').split(/\s+/).filter(Boolean).length;
}

/* ---------- 复习：以前不牢固的内容 ---------- */

function renderReview(r) {
  if (!r.total) {
    return `<section class="card review-board">
      <div class="card-head"><div><h2>复习</h2><div class="sub">到期词 / 做错的题 / 没读透的句子</div></div><span class="pill success">暂无欠账</span></div>
      <div class="feedback">${icon('check', 13)} 目前没有需要回炉的内容。继续读一篇新文章，或做一份试卷。</div>
    </section>`;
  }

  const blocks = [];

  if (r.words.items.length) {
    blocks.push(`<div class="review-block">
      <div class="review-head">
        <span class="review-title">${icon('book', 14)} 待复习词 <em>${r.words.count}</em></span>
        <button class="btn btn-sm" data-action="reviewLearn" type="button">去背单词</button>
      </div>
      ${r.words.items.slice(0, 3).map((w) => `
        <div class="review-row">
          <div class="review-row-main"><b>${esc(w.term)}</b><span>${esc(w.meaning)}</span></div>
          <span class="review-tag">${w.mastery}%</span>
        </div>`).join('')}
    </div>`);
  }

  if (r.mistakes.items.length) {
    blocks.push(`<div class="review-block">
      <div class="review-head">
        <span class="review-title">${icon('clipboard', 14)} 做错的题 <em>${r.mistakes.count}</em></span>
        <span class="tiny muted">点一行看批改</span>
      </div>
      ${r.mistakes.items.slice(0, 3).map((m) => `
        <button class="review-row as-btn" data-action="reviewMistake" data-id="${esc(m.attemptId)}" type="button">
          <span class="review-row-main"><b>${esc(cut(m.prompt, 52))}</b><span>答案：${esc(cut(m.answer, 30))}</span></span>
          ${icon('arrowRight', 13)}
        </button>`).join('')}
    </div>`);
  }

  if (r.reading.items.length) {
    blocks.push(`<div class="review-block">
      <div class="review-head">
        <span class="review-title">${icon('reader', 14)} 阅读题没过关 <em>${r.reading.count}</em></span>
        <span class="tiny muted">正确率未满</span>
      </div>
      ${r.reading.items.slice(0, 3).map((x) => `
        <button class="review-row as-btn" data-action="reviewReading" data-id="${esc(x.articleId)}" type="button">
          <span class="review-row-main"><b>${esc(cut(x.title, 28))}</b><span>${fmtDate(x.at)} · 阅读理解</span></span>
          <span class="review-tag ${x.correct === x.total ? 'ok' : ''}">${x.correct}/${x.total}</span>
        </button>`).join('')}
    </div>`);
  }

  if (r.sentences.items.length) {
    blocks.push(`<div class="review-block">
      <div class="review-head">
        <span class="review-title">${icon('highlighter', 14)} 没读透的句子 <em>${r.sentences.count}</em></span>
        <span class="tiny muted">理解度偏低</span>
      </div>
      ${r.sentences.items.slice(0, 3).map((s) => `
        <button class="review-row as-btn" data-action="reviewSentence" data-id="${esc(s.articleId)}" data-si="${s.index}" type="button">
          <span class="review-row-main"><b>${esc(cut(s.sentence, 46))}</b><span>${esc(cut(s.title, 18))} · 理解度 ${s.score}</span></span>
          ${icon('arrowRight', 13)}
        </button>`).join('')}
    </div>`);
  }

  return `<section class="card review-board">
    <div class="card-head">
      <div><h2>复习</h2><div class="sub">以前不牢固的内容：到期词、做错的题、没读透的句子</div></div>
      <span class="pill warn">${r.total} 项待巩固</span>
    </div>
    <div class="review-grid">${blocks.join('')}</div>
  </section>`;
}

function cut(text, n) {
  const s = String(text || '').replace(/\s+/g, ' ');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

export function mount() {
  document.getElementById('view').addEventListener('click', (e) => {
    const target = e.target.closest('[data-action]');
    if (!target) return;
    const a = target.dataset.action;
    if (a === 'import') go('import');
    else if (a === 'reader') go('reader');
    else if (a === 'open') go('reader', { id: target.dataset.id });
    else if (a === 'lookup') go('lookup');
    else if (a === 'words') go('words');
    else if (a === 'quizzes') go('quiz');
    else if (a === 'learn') go('learn');
    else if (a === 'take') go('quiz', { mode: 'take' });
    else if (a === 'result') go('quiz', { mode: 'result', id: target.dataset.id });
    else if (a === 'reviewLearn') go('learn', { scope: 'wrong', t: String(Date.now()) });
    else if (a === 'reviewMistake') go('quiz', { mode: 'result', id: target.dataset.id });
    else if (a === 'reviewReading') go('reader', { id: target.dataset.id, tab: 'reading' });
    else if (a === 'reviewSentence') go('reader', { id: target.dataset.id, tab: 'deep', si: target.dataset.si });
  });
}
