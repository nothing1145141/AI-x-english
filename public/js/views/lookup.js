// 单词速查：内置高考词库离线直查 + AI 深度讲解 + 一键加入词库

import { builtinLookup, builtinSearch, GAOKAO_WORDS } from '../gaokao.js';
import { addWords, getWords, logActivity } from '../store.js';
import { explainWord } from '../ai.js';
import { icon, esc, toast, modal, dateKey } from '../ui.js';
import { mdxLookup, mountMdxEntry } from '../mdx.js';
import { refresh } from '../router.js';

let query = '';
let result = null;        // { source:'builtin'|'user'|'ai'|'none', data }
let loading = false;
let aiLoading = false;
let pendingAiSerial = 0;  // 已有 AI 请求在跑时，记录期间最新一次查询，结束后补跑
let suggestions = [];
let inputFocusPos = null;
let mdxEntry = null;      // 导入的 MDX 词典命中结果
let searchSerial = 0;     // 查询序号：丢弃过期响应，防止旧查询覆盖新结果

export const title = '单词速查';
export const subtitle = `内置高考词库 ${GAOKAO_WORDS.length} 词 · 即输即查`;

export function render() {
  return `
    <section class="card">
      <div class="card-head"><div><h2>查一个单词</h2><div class="sub">内置高考词库离线秒查，深度解析交给 AI</div></div>${icon('searchWord', 18)}</div>
      <div class="lookup-hero">
        <div style="position:relative;flex:1">
          <span style="position:absolute;left:14px;top:16px;color:var(--muted)">${icon('search', 18)}</span>
          <input class="input" id="lookupInput" placeholder="输入英文单词或短语，如 abandon" value="${esc(query)}" style="padding-left:42px" autocomplete="off" />
        </div>
        <button class="btn btn-primary" data-action="search" ${loading ? 'disabled' : ''}>${icon('search', 16)} 查询</button>
      </div>
      ${suggestions.length ? `<div class="row" style="flex-wrap:wrap;gap:6px;margin-bottom:12px">
        ${suggestions.map((w) => `<button class="kw-chip" data-action="pickSuggest" data-term="${esc(w.term)}"><b>${esc(w.term)}</b><span class="kw-mean">${esc(w.meaning)}</span></button>`).join('')}
      </div>` : ''}
      <div class="feedback">${icon('info', 13)} 内置词库收录高考高频词；查不到时可点“AI 深度讲解”，或到文章阅读器里精读例句。</div>
    </section>

    ${mdxEntry ? `<section class="card mt16">
      <div class="card-head">
        <div>
          <h2>${esc(mdxEntry.key)} <button class="tts-btn" type="button" data-speak="${esc(mdxEntry.key)}" title="听发音" aria-label="听 ${esc(mdxEntry.key)} 的发音">${icon('volume', 15)}</button> <span class="mdx-tag">${esc(mdxEntry.dict.name)}</span></h2>
          <div class="sub">${mdxEntry.matched === 'variant' ? `词形还原自「${esc(query)}」 · ` : ''}来自导入的 MDX 词典</div>
        </div>
        <button class="btn btn-sm" data-action="addMdx">${icon('plusCircle', 13)} 加入我的词库</button>
      </div>
      <div data-mdx-host></div>
    </section>` : ''}

    <section class="card mt16">
      ${renderResult()}
    </section>
  `;
}

function renderResult() {
  if (loading) return `<div class="empty" style="padding:40px">${icon('searchWord', 30)}<h3>查询中…</h3></div>`;
  if (aiLoading) return `<div class="empty" style="padding:40px">${icon('sparkles', 30)}<h3>AI 正在讲解…</h3><p>通常需要十几秒，可稍候。</p></div>`;
  if (!result) {
    if (mdxEntry) {
      return `<div class="empty" style="padding:30px">${icon('searchWord', 26)}<h3>已在上方显示 MDX 词典释义</h3><p>需要词根词缀、搭配与例句扩展，可点“AI 深度讲解”。</p><button class="btn btn-sm" data-action="deepAi">${icon('sparkles', 13)} AI 深度讲解</button></div>`;
    }
    return `<div class="empty" style="padding:44px">${icon('bookOpen', 34)}<h3>输入单词开始查询</h3><p>例如：abandon、look forward to、significant</p></div>`;
  }
  const d = result.data;
  if (result.source === 'none') {
    return `<div class="empty" style="padding:30px">${icon('searchWord', 26)}<h3>「${esc(d.term)}」未能生成讲解</h3><p>可能是 AI 网关繁忙或未配置 Key，稍后可再试。</p><button class="btn btn-sm btn-primary" data-action="deepAi">${icon('sparkles', 13)} 重试 AI 讲解</button></div>`;
  }
  if (result.source === 'ai') return renderAiResult(d);

  // 内置词库结构：term / phonetic / pos / meaning / example
  return `
    <div class="card-head">
      <div><h2>${esc(d.term)} <button class="tts-btn" type="button" data-speak="${esc(d.term)}" title="听发音" aria-label="听 ${esc(d.term)} 的发音">${icon('volume', 15)}</button> <span class="pill ${result.source === 'builtin' ? 'primary' : 'success'}">${result.source === 'builtin' ? '内置高考词库' : '我的词库'}</span></h2>
        <div class="sub">${esc(d.phonetic || '')} ${esc(d.pos || '')}</div></div>
      <div class="row">
        ${result.source === 'builtin' ? `<button class="btn btn-sm btn-primary" data-action="deepAi">${icon('sparkles', 13)} AI 深度讲解</button>` : ''}
        <button class="btn btn-sm" data-action="addBuiltin">${icon('plusCircle', 13)} 加入我的词库</button>
      </div>
    </div>
    <div class="lookup-result">
      <div class="def-item"><span class="small">${esc(d.meaning || '暂无释义')}</span></div>
      ${d.example ? `<div class="def-item"><span class="def-pos">例句</span><div style="font-family:Georgia,serif">${esc(d.example)}<button class="tts-btn tts-inline" type="button" data-speak="${esc(d.example)}" title="听例句" aria-label="听例句">${icon('volume', 12)}</button></div></div>` : ''}
    </div>
  `;
}

function renderAiResult(d) {
  return `
    <div class="card-head">
      <div><h2>${esc(d.term)} <button class="tts-btn" type="button" data-speak="${esc(d.term)}" title="听发音" aria-label="听 ${esc(d.term)} 的发音">${icon('volume', 15)}</button> ${d.phonetic ? `<span class="pill">${esc(d.phonetic)}</span>` : ''}</h2>
        <div class="sub">${esc(d.pos || '')} ${d.level ? `· ${esc(d.level)}` : ''} · AI 深度讲解</div></div>
      <button class="btn btn-sm btn-primary" data-action="addBuiltin">${icon('plusCircle', 13)} 加入我的词库</button>
    </div>
    <div class="lookup-result">
      ${d.root ? `<div class="feedback">${icon('info', 13)} 词根词缀：${esc(d.root)}</div>` : ''}
      ${(d.meanings || []).map((m) => `<div class="def-item">
        <span class="def-pos">${esc(m.pos || '')}</span> <strong>${esc(m.meaning || '')}</strong>
        ${m.example ? `<div class="def-ex">${esc(m.example)}<button class="tts-btn tts-inline" type="button" data-speak="${esc(m.example)}" title="听例句" aria-label="听例句">${icon('volume', 12)}</button> — ${esc(m.translation || '')}</div>` : ''}
      </div>`).join('')}
      ${d.collocations?.length ? `<div class="def-item"><span class="def-pos">常见搭配</span>
        <div class="small">${d.collocations.map(esc).join(' · ')}</div></div>` : ''}
      ${d.synonyms?.length ? `<div class="def-item"><span class="def-pos">近义词</span> <span class="small">${d.synonyms.map(esc).join(', ')}</span></div>` : ''}
      ${d.antonyms?.length ? `<div class="def-item"><span class="def-pos">反义词</span> <span class="small">${d.antonyms.map(esc).join(', ')}</span></div>` : ''}
      ${d.usage ? `<div class="feedback mt8">${esc(d.usage)}</div>` : ''}
    </div>
  `;
}

/* ---------- 查询逻辑 ---------- */

async function doSearch(term) {
  const q = String(term || '').trim();
  if (!q) { toast('请输入单词', 'error'); return; }
  const serial = ++searchSerial;
  query = q; result = null; suggestions = []; mdxEntry = null;
  loading = true; refresh();

  // 1) 导入的 MDX 词典（先查，内容最完整）
  mdxEntry = await mdxLookup(q);
  if (serial !== searchSerial) return;   // 期间用户又查了新词，丢弃本次后续步骤

  const renderDone = () => { refresh(); };

  // 2) 内置词库精确查询
  const builtin = builtinLookup(q);
  if (builtin) {
    result = { source: 'builtin', data: builtin };
    loading = false; renderDone(); return;
  }
  // 3) 我的词库查询
  const mine = getWords().find((w) => String(w.term).toLowerCase() === q.toLowerCase());
  if (mine) {
    result = { source: 'user', data: mine };
    loading = false; renderDone(); return;
  }
  // 4) 未命中：MDX 命中则不再自动调 AI，否则给候选并自动讲解
  suggestions = builtinSearch(q, 8);
  loading = false;
  if (mdxEntry) { renderDone(); return; }
  deepAi(serial);
}

async function deepAi(serial = searchSerial) {
  if (!query) return;
  if (aiLoading) {
    // 单飞：不并发烧钱，但记住最新查询，等当前请求结束后补跑
    if (serial === searchSerial) pendingAiSerial = serial;
    return;
  }
  aiLoading = true; refresh();
  try {
    const term = query;
    const r = await explainWord(term);
    if (serial !== searchSerial) return;   // 过期响应丢弃，不覆盖新查询的结果
    result = { source: 'ai', data: r };
    toast('AI 讲解已生成', 'success');
  } catch (err) {
    if (serial !== searchSerial) return;
    toast(`AI 讲解失败：${err.message}`, 'error', 5000);
    if (!result) result = { source: 'none', data: { term: query } };
  } finally {
    // 无论成功、失败还是过期退出，都必须复位加载态，否则界面会永久停在「AI 正在讲解…」
    aiLoading = false;
    refresh();
    if (pendingAiSerial) {
      const queued = pendingAiSerial;
      pendingAiSerial = 0;
      if (queued === searchSerial) deepAi(searchSerial);
    }
  }
}

function addToBook() {
  if (!result?.data) return;
  const d = result.data;
  let entry;
  if (result.source === 'ai') {
    entry = {
      term: d.term, phonetic: d.phonetic || '', pos: d.pos || (d.meanings[0]?.pos || ''),
      meaning: (d.meanings || []).map((m) => m.meaning).filter(Boolean).join('；'),
      example: d.meanings?.[0]?.example || '',
      source: { type: 'lookup', at: new Date().toISOString() }
    };
  } else {
    entry = { ...d, source: { type: 'lookup', at: new Date().toISOString() } };
  }
  const r = addWords([entry]);
  logActivity(dateKey(), { wordsAdded: r.added });
  toast(r.added ? `「${entry.term}」已加入词库` : `「${entry.term}」词库中已存在，已更新`, 'success');
}

export function mount() {
  const view = document.getElementById('view');

  // MDX 释义用 iframe 渲染，每次视图重建后重新挂载
  const mdxHost = view.querySelector('[data-mdx-host]');
  if (mdxHost && mdxEntry) mountMdxEntry(mdxHost, mdxEntry);

  const input = view.querySelector('#lookupInput');
  if (input) {
    if (query) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    input.addEventListener('input', () => {
      query = input.value;
      const pos = input.selectionStart;
      clearTimeout(input._t);
      input._t = setTimeout(() => {
        suggestions = query.trim() ? builtinSearch(query, 8) : [];
        refresh();
        const el = document.getElementById('lookupInput');
        if (el) { el.focus(); el.setSelectionRange(pos, pos); }
      }, 400);
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(input.value); });
  }

  view.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const a = btn.dataset.action;
    if (a === 'search') { doSearch(document.getElementById('lookupInput')?.value || query); return; }
    if (a === 'pickSuggest') { doSearch(btn.dataset.term); return; }
    if (a === 'addBuiltin') { addToBook(); return; }
    if (a === 'deepAi') { deepAi(); return; }
    if (a === 'addMdx') {
      if (!mdxEntry) return;
      const meaning = result && result.source !== 'ai'
        ? (result.data?.meaning || '')
        : '';
      const r = addWords([{
        term: mdxEntry.key,
        phonetic: result?.data?.phonetic || '',
        pos: result?.data?.pos || '',
        meaning: meaning || `${mdxEntry.dict.name} 词条`,
        source: { type: 'mdx', dict: mdxEntry.dict.name, at: new Date().toISOString() }
      }]);
      logActivity(dateKey(), { wordsAdded: r.added });
      toast(r.added ? `「${mdxEntry.key}」已加入词库` : `「${mdxEntry.key}」词库中已存在，已更新`, 'success');
      return;
    }
  });
}
