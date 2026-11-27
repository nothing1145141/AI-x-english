// 百词斩式卡片背单词（纯文字，无语音/图片）
// 看词选义 / 看义选词交替，即时反馈，错词优先，进度落盘。

import { builtinLookup } from '../gaokao.js';
import { getWords } from '../store.js';
import { icon, esc, toast } from '../ui.js';
import { refresh, getRoute } from '../router.js';
import { vocabList } from '../article-vocab.js';
import { learnState, dayStat, shuffle, buildQueue, applyAnswer } from '../drill.js';

let phase = 'home';        // home | study | done
let queue = [];
let idx = 0;
let right = 0;
let wrongList = [];
let answered = null;       // { ok, choice }
// 两个范围：阅读错词（阅读 / 练习里答错与到期的词）| 词表的词（1000 核心 + 超纲）
let scope = 'list';
let scopeFromRoute = '';
let startTime = 0;

export const title = '背单词';
export const subtitle = '卡片速记 · 看词选义 / 看义选词';

/* ---------- 选词与出题 ---------- */

/** 词表的词：范围 = 《高中核心词汇1000+高考超纲词》 */
function listWords() {
  const byTerm = new Map(getWords().map((w) => [String(w.term || '').toLowerCase(), w]));
  return vocabList().map((v) => {
    const ref = byTerm.get(v.term.toLowerCase()) || null;
    return {
      term: v.term, phonetic: v.phonetic || '', pos: '',
      meaning: v.meaning, example: '', ref, level: v.level
    };
  });
}

/** 阅读错词：阅读里答错的词 + 词库中答错/已到期的词 */
function wrongWords() {
  const byTerm = new Map(vocabList().map((v) => [v.term.toLowerCase(), v]));
  const rows = new Map();
  const learned = learnState().learned || {};

  Object.keys(learned).forEach((term) => {
    const r = learned[term];
    if (!r || !r.wrong) return;
    if (!(r.src === 'article' || r.readingWrong)) return;
    const entry = byTerm.get(term);
    if (!entry) return;
    rows.set(term, {
      term: entry.term, phonetic: entry.phonetic, pos: '', meaning: entry.meaning,
      example: '', ref: null, wrong: r.wrong
    });
  });

  getWords().forEach((w) => {
    const key = String(w.term || '').toLowerCase();
    if (!w.meaning || rows.has(key)) return;
    const wrong = w.srs?.wrong || 0;
    const due = (w.srs?.seen || 0) > 0 && String(w.srs?.dueAt || '') <= new Date().toISOString();
    if (!wrong && !due) return;
    rows.set(key, {
      term: w.term, phonetic: w.phonetic || '', pos: w.pos || '',
      meaning: w.meaning, example: w.example || '', ref: w, wrong
    });
  });

  return [...rows.values()].sort((a, b) => (b.wrong || 0) - (a.wrong || 0) || a.term.localeCompare(b.term));
}

function pool() {
  return scope === 'wrong' ? wrongWords() : listWords();
}

function makeQueue() {
  const all = pool();
  if (!all.length) return [];
  // 错词可能只有两三个：选项不足时用词表补齐，避免出现 2 选 1
  const optionPool = all.length >= 5 ? all
    : [...all, ...listWords().filter((w) => !all.some((x) => x.term.toLowerCase() === w.term.toLowerCase()))];
  const goal = Math.min(learnState().goal || 20, all.length);
  return buildQueue(all, goal).map((q) => {
    if (q.options.length >= 4) return q;
    const others = shuffle(optionPool.filter((o) => o.term.toLowerCase() !== q.word.term.toLowerCase() && o.meaning && o.meaning !== q.word.meaning)).slice(0, 3);
    const options = q.mode === 'w2m'
      ? shuffle([q.word.meaning, ...others.map((o) => o.meaning)])
      : shuffle([q.word.term, ...others.map((o) => o.term)]);
    return { ...q, options, answer: q.mode === 'w2m' ? q.word.meaning : q.word.term };
  });
}

function start() {
  queue = makeQueue();
  if (!queue.length) {
    toast(scope === 'wrong' ? '还没有阅读错词，先读一篇、做几道题吧' : '词表没有可学习的词条', 'info');
    return;
  }
  idx = 0; right = 0; wrongList = []; answered = null;
  startTime = Date.now();
  phase = 'study';
  refresh();
}

/* ---------- 渲染 ---------- */
export function render() {
  const params = (getRoute() || {}).params || {};
  // 路由里带 scope 时切到对应范围；key 里带上 t，保证从首页反复深链都能重新生效
  const key = `${params.scope || ''}|${params.t || ''}`;
  if (params.scope && key !== scopeFromRoute) {
    if (params.scope === 'wrong' || params.scope === 'list') scope = params.scope;
    scopeFromRoute = key;
    phase = 'home';
  } else if (!params.scope) {
    scopeFromRoute = '';
  }
  if (phase === 'study') return renderStudy();
  if (phase === 'done') return renderDone();
  return renderHome();
}

function renderScopePicker(wrongCount, listCount) {
  return `<div class="learn-scope" role="group" aria-label="背诵范围">
    <button class="learn-scope-btn ${scope === 'wrong' ? 'active' : ''}" data-act="setScope" data-scope="wrong" type="button">
      <b>阅读错词</b><span>阅读 / 练习里答错、到期的词</span><em>${wrongCount}</em>
    </button>
    <button class="learn-scope-btn ${scope === 'list' ? 'active' : ''}" data-act="setScope" data-scope="list" type="button">
      <b>词表的词</b><span>核心 1000 + 超纲词</span><em>${listCount}</em>
    </button>
  </div>`;
}

function renderHome() {
  const st = learnState();
  const d = dayStat();
  const words = pool();
  const learnedCount = Object.keys(st.learned).length;
  const mastered = Object.values(st.learned).filter((r) => r.right >= 2 && r.right > r.wrong).length;
  const total = words.length;
  return `
    <div class="learn-hero">
      <div>
        <div class="learn-eyebrow">今日计划</div>
        <h2>每天 ${st.goal || 20} 词，积少成多</h2>
        <p>卡片速记，看词选义与看义选词交替。点完即出结果，答错的词会优先再出现；阅读器里的「背诵本文词」用的是同一份记录。</p>
        ${renderScopePicker(wrongWords().length, vocabList().length)}
        <div class="learn-hero-actions">
          <button class="btn btn-primary" data-act="start" ${total ? '' : 'disabled'}>${icon('play', 15)} 开始今日学习</button>
        </div>
      </div>
      <div class="learn-ring">
        <div class="learn-ring-num">${d.count}<span>/${st.goal || 20}</span></div>
        <div class="learn-ring-label">今日已学</div>
      </div>
    </div>

    <div class="grid grid-4 keep mt16">
      ${stat('今日已学', d.count, `正确 ${d.count ? Math.round(d.right / d.count * 100) : 0}%`, 'book')}
      ${stat('已接触词', learnedCount, `累计练习记录`, 'sparkles')}
      ${stat('已掌握', mastered, '答对 2 次以上', 'target')}
      ${stat('可用词条', total, scopeLabel(), 'layers')}
    </div>

    <section class="card mt16">
      <div class="card-head"><div><h2>怎么玩</h2><div class="sub">纯文字卡片，两步一个循环</div></div></div>
      <div class="learn-steps">
        <div class="learn-step"><span>01</span><div><b>看词选义</b><small>看到单词，从四个中文释义里挑出正确的</small></div></div>
        <div class="learn-step"><span>02</span><div><b>看义选词</b><small>看到释义，反向选出对应单词</small></div></div>
        <div class="learn-step"><span>03</span><div><b>即时反馈</b><small>答错立刻显示正确释义与例句，并安排重练</small></div></div>
      </div>
    </section>`;
}

function stat(label, value, foot, ico) {
  return `<div class="card learn-stat"><div class="row spread"><span class="stat-label">${label}</span>${icon(ico, 15)}</div>
    <div class="stat-value">${value}</div><div class="tiny muted">${esc(foot)}</div></div>`;
}
function scopeLabel() {
  return scope === 'wrong' ? '阅读错词' : '词表的词';
}

function renderStudy() {
  const q = queue[idx];
  if (!q) return renderDone();
  const pct = Math.round(idx / queue.length * 100);
  const prompt = q.mode === 'w2m'
    ? `<div class="learn-word">${esc(q.word.term)}<button class="tts-btn" type="button" data-speak="${esc(q.word.term)}" title="听发音" aria-label="听 ${esc(q.word.term)} 的发音">${icon('volume', 18)}</button></div>
       <div class="learn-phonetic">${esc(q.word.phonetic || builtinLookup(q.word.term)?.phonetic || '')} ${esc(q.word.pos || '')}</div>
       <div class="learn-hint">选出正确的中文释义</div>`
    : `<div class="learn-meaning">${esc(q.word.meaning)}</div>
       <div class="learn-hint">选出对应的英文单词</div>`;

  const options = q.options.map((o, i) => {
    let cls = '';
    if (answered) {
      if (o === q.answer) cls = 'right';
      else if (o === answered.choice) cls = 'wrong';
      else cls = 'dim';
    }
    return `<button class="learn-option ${cls}" data-act="choice" data-i="${i}" ${answered ? 'disabled' : ''}>
      <span class="learn-opt-key">${'ABCD'[i]}</span><span>${esc(o)}</span></button>`;
  }).join('');

  const feedback = answered ? `
    <div class="learn-feedback ${answered.ok ? 'ok' : 'no'}">
      <b>${answered.ok ? '回答正确' : '再记一下'}</b>
      <div><b>${esc(q.word.term)}</b><button class="tts-btn" type="button" data-speak="${esc(q.word.term)}" title="听发音" aria-label="听 ${esc(q.word.term)} 的发音">${icon('volume', 13)}</button> ${esc(q.word.phonetic || '')} ${esc(q.word.pos || '')} —— ${esc(q.word.meaning)}</div>
      ${q.word.example ? `<div class="learn-example">${esc(q.word.example)}</div>` : ''}
      <button class="btn btn-primary btn-sm mt12" data-act="next">${idx + 1 >= queue.length ? '查看结果' : '下一个'} ${icon('arrowRight', 13)}</button>
    </div>` : '';

  return `
    <div class="learn-study">
      <div class="learn-top">
        <button class="btn btn-sm" data-act="quit">${icon('x', 13)} 退出</button>
        <div class="learn-progress"><div class="learn-progress-bar" style="width:${pct}%"></div></div>
        <span class="tiny muted">${idx + 1} / ${queue.length}</span>
      </div>
      <div class="learn-card">
        <div class="learn-mode">${q.mode === 'w2m' ? '看词选义' : '看义选词'}</div>
        ${prompt}
        <div class="learn-options">${options}</div>
        ${feedback}
      </div>
    </div>`;
}

function renderDone() {
  const total = queue.length;
  const acc = total ? Math.round(right / total * 100) : 0;
  const ms = Date.now() - startTime;
  return `
    <div class="card learn-done">
      <div class="learn-done-badge">${acc >= 80 ? '很棒' : acc >= 60 ? '继续保持' : '再来一轮'}</div>
      <div class="learn-done-score">${acc}<span>%</span></div>
      <div class="sub">本轮 ${total} 词 · 答对 ${right} · 用时 ${Math.max(1, Math.round(ms / 60000))} 分钟</div>
      <div class="row mt16" style="justify-content:center">
        <button class="btn btn-primary" data-act="start">${icon('refresh', 14)} 再来一轮</button>
        <button class="btn" data-act="home">返回计划</button>
      </div>
    </div>
    ${wrongList.length ? `<section class="card mt16">
      <div class="card-head"><div><h2>需要复习</h2><div class="sub">这些词答错过，已安排优先重练</div></div></div>
      <div class="grid grid-2">${wrongList.map((w) => `<div class="learn-wrong">
        <b>${esc(w.term)}</b><button class="tts-btn" type="button" data-speak="${esc(w.term)}" title="听发音" aria-label="听 ${esc(w.term)} 的发音">${icon('volume', 12)}</button><span class="tiny muted">${esc(w.phonetic || '')}</span>
        <div class="small">${esc(w.meaning)}</div></div>`).join('')}</div>
    </section>` : ''}`;
}

/* ---------- 交互 ---------- */
function answer(i, q) {
  if (answered) return;
  const choice = q.options[i];
  const ok = choice === q.answer;
  answered = { ok, choice };
  if (ok) right++; else wrongList.push(q.word);
  applyAnswer(q.word, ok, scope === 'wrong' ? 'article' : 'list');
  refresh();
}

export function mount() {
  const view = document.getElementById('view');
  view.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const a = btn.dataset.act;
    if (a === 'start') return start();
    if (a === 'home') { phase = 'home'; refresh(); return; }
    if (a === 'quit') { phase = 'home'; refresh(); return; }
    if (a === 'setScope') {
      const next = btn.dataset.scope;
      if (next === 'wrong' || next === 'list') scope = next;
      phase = 'home';
      refresh(); return;
    }
    if (a === 'choice' && phase === 'study') return answer(Number(btn.dataset.i), queue[idx]);
    if (a === 'next' && phase === 'study') {
      idx++;
      answered = null;
      if (idx >= queue.length) phase = 'done';
      refresh();
    }
  });
}
