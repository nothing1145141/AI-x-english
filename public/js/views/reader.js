// 文章阅读器：导入文章 → 分句精读 → 选中句子 AI 讲解 → 重点词加入词库

import { getState, getArticle, saveArticle, patchArticle, deleteArticle, cacheSentence, patchSentence, addWords, logActivity, recordSentence } from '../store.js';
import { ocrArticle, ocrArticleMulti, analyzeArticle, coachSentence, translateSelection, explainWord, compressImage, generateReadingQuestions } from '../ai.js';
import { builtinLookup } from '../gaokao.js';
import { icon, esc, toast, modal, confirmDialog, pickFile, pickFiles, readAsDataURL, dateKey } from '../ui.js';
import { vizModalBody, mountVizToggles } from '../viz.js';
import { nlpSentence } from '../nlp.js';
import { detectHardSentences, articleHash } from '../hardsent.js';
import { openBacktrans } from '../backtrans.js';
import { parseEbookFile, renderPdfToImages, EBOOK_ACCEPT, FORMAT_LABELS, countWords as countEbookWords } from '../ebook.js';
import { scanWords, buildKnownSet, computeCoverage, coverageSummary, fetchDictBatch, unknownSurfaceSet, normalizeTerm } from '../coverage.js';
import { matchArticleVocab, articleVocabEntries, highlightSentence } from '../article-vocab.js';
import { buildQueue, applyAnswer } from '../drill.js';
import { go, refresh, getRoute } from '../router.js';

let mode = 'list';            // list | read
let currentId = null;
let busy = false;
let activeIndex = -1;         // 当前选中的句子序号
let selectionText = '';       // 用户划词文本
let analysisBusy = false;
let importDraft = { title: '', text: '', source: '', photos: [], fileName: '', hint: '', ebook: null };
let showImport = false;
let ebookBusy = false;
let ebookProgress = '';
let hardBusy = false;
let activeNlp = null;        // 当前选中句子的本地句法结构

/** 文章学习三部分（+ 精讲）：词汇 / 长难句 / 阅读理解 / 精讲 */
let studyTab = 'vocab';
let tabFromRoute = '';       // 记住从路由带入的 tab，避免每次重渲染把用户切回的页签重置
let siConsumed = false;      // 深链「打开第 N 句」只消费一次，防止刷新时递归
let routeIdConsumed = '';    // 路由里的文章 id 只应用一次
let showCore = true;         // 正文标注词表命中词（核心 1000 / 超纲）
let vocabShowAll = false;    // 词汇列表默认只展示前若干条

/** 阅读理解作答状态（只存内存，结果落盘到文章对象的 readingResult） */
let reading = { articleId: null, answers: {}, submitted: false, busy: false, error: '', score: null };

/** 当前文章的生词覆盖率（内存缓存，摘要另存文章对象供列表展示） */
let coverage = { articleId: null, hash: '', data: null, loading: false, error: '' };
let showUnknown = false;     // 生词高亮开关

/**
 * 当前的精读对话会话
 * { index, sentence, context, turns:[{role,text,score,verdict,focus,question,stage}],
 *   attempts, busy, analysis, cached, nlp, draft, error }
 */
let coach = null;

export const title = '文章阅读器';
export const subtitle = '导入文章 · 选中句子 · AI 精讲 · 重点词入库';

/* ---------- 分句工具 ---------- */

/** 把正文按段落与句子拆分：返回 [{para, sentences:[str]}] */
function splitArticle(text) {
  const paras = String(text || '').split(/\n\s*\n+/).map((p) => p.trim()).filter(Boolean);
  return paras.map((para) => ({
    para,
    sentences: para.split(/(?<=[.!?。！？；;])\s+(?=[A-Z"\u201c\u4e00-\u9fa5])|(?<=[。！？；;])\s*/)
      .map((s) => s.trim()).filter(Boolean)
  }));
}

function flattenSentences(struct) {
  const out = [];
  struct.forEach((p) => p.sentences.forEach((s) => out.push(s)));
  return out;
}

/** 计算某句在全文中的起始索引（用于对应缓存 key） */
function sentenceIndex(struct, paraIdx, sentIdx) {
  let n = 0;
  for (let p = 0; p < paraIdx; p++) n += struct[p].sentences.length;
  return n + sentIdx;
}

/* ---------- 长难句识别（本地 NLP） ---------- */

/** 文章文本变了、或还没有结果时，按篇幅重新挑出长难句 */
async function ensureHardSentences(articleId, { force = false } = {}) {
  const a = getArticle(articleId);
  if (!a) return;
  const hash = articleHash(a.text);
  if (!force && Array.isArray(a.hardSentences) && a.hardHash === hash) return;
  if (hardBusy) return;
  hardBusy = true;
  try {
    const sentences = flattenSentences(splitArticle(a.text)).map((text, index) => ({ index, text }));
    const r = await detectHardSentences(sentences, a.text);
    patchArticle(articleId, {
      hardSentences: r.items,
      hardLimit: r.limit,
      hardWords: r.totalWords,
      hardHash: hash,
      hardAt: r.at,
      hardEngine: r.engine
    });
    if (mode === 'read' && currentId === articleId) {
      const art = getArticle(articleId);
      // 长难句数量参与难度评分，识别完成后重算一次覆盖率
      if (art && coverage.articleId === articleId) ensureCoverage(art, { force: true });
      else refreshKeep();
    }
  } catch (err) {
    console.warn('[hard sentences]', err);
  } finally {
    hardBusy = false;
  }
}

function renderHardCard(a, list) {
  const engine = a.hardEngine === 'heuristic' ? '文本启发式（NLP 未就绪）' : (a.hardEngine || '本地 NLP');
  const words = Number(a.hardWords) || 0;
  const density = words ? `全文 ${words} 词，约每 ${Math.max(100, Math.round(words / Math.max(1, list.length || 1)))} 词 1 句` : '按篇幅自动决定句数';
  return `<section class="card mb16">
    <div class="card-head">
      <div><h2>长难句 <span class="pill">${list.length || 0}</span></h2>
        <div class="sub">${esc(engine)} · ${esc(density)} · 按长度、从句层级与嵌套深度挑选，正文中紫色下划线标出</div></div>
      <button class="btn btn-sm btn-ghost" data-action="redetectHard" ${hardBusy ? 'disabled' : ''}>
        ${hardBusy ? '<span class="loading"></span>' : '重新识别'}</button>
    </div>
    ${list.length ? `<div class="hard-list">${list.map((h) => `
      <button type="button" class="hard-item" data-action="hardItem" data-i="${h.index}">
        <span class="hard-no">${h.index + 1}</span>
        <span class="hard-body">
          <span class="hard-reason">${esc(h.reason || '')}</span>
          <span class="hard-text">${esc(String(h.text || '').slice(0, 120))}${String(h.text || '').length > 120 ? '…' : ''}</span>
        </span>
        <span class="hard-go">${icon('arrowRight', 14)}</span>
      </button>`).join('')}</div>`
      : `<div class="empty" style="padding:22px 0">${icon('sparkles', 26)}<p>${hardBusy ? '本地 NLP 正在识别…' : '还没有识别结果，点右上角重新识别'}</p></div>`}
  </section>`;
}

/* ---------- 渲染：列表 ---------- */

function renderList() {
  const articles = getState().articles;
  return `
    <section class="card">
      <div class="card-head">
        <div><h2>我的文章 <span class="pill">${articles.length}</span></h2><div class="sub">每篇文章都可精读、讲解、提取重点词</div></div>
        <div class="quick-photo-row">
          <button class="btn btn-sm quick-photo" data-action="quickPhotoArticle" ${busy ? 'disabled' : ''} title="拍照或选一张文章照片，识别后预览保存">${icon('camera', 14)} 拍照</button>
          <button class="btn btn-primary btn-sm" data-action="newImport">${icon('plus', 14)} 导入文章</button>
        </div>
      </div>
      ${articles.length ? `<div class="grid grid-2">${articles.map((a) => articleCard(a)).join('')}</div>`
        : `<div class="empty">${icon('reader', 34)}<h3>还没有文章</h3><p>粘贴一段英文、上传 TXT 或拍一张文章照片开始精读</p>
           <button class="btn btn-primary btn-sm" data-action="newImport">导入第一篇文章</button></div>`}
    </section>
    ${renderImportPanel()}
  `;
}

function articleCard(a) {
  const hasAnalysis = !!a.analysis;
  const explained = a.sentences ? Object.keys(a.sentences).length : 0;
  const words = countWordsEn(a.text);
  const cov = a.coverage && a.coverage.hash === articleHash(a.text) ? a.coverage : null;
  return `<div class="word-item" data-article="${a.id}" style="cursor:pointer">
    <div class="spread">
      <strong class="art-title">${esc(a.title || '未命名文章')}</strong>
      <span class="row" style="gap:6px">
        ${cov ? `<span class="pill ${cov.level >= 4 ? 'danger' : cov.level >= 3 ? 'warn' : 'success'}">${esc(cov.label)} · 读懂 ${Math.round(cov.knownRatio * 100)}%</span>` : `<span class="pill hide" data-cov-badge="${a.id}"></span>`}
        ${hasAnalysis ? '<span class="pill success">已分析</span>' : ''}
      </span>
    </div>
    <div class="tiny muted mt8" style="line-height:1.6;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc((a.text || '').slice(0, 120))}</div>
    <div class="row mt12 tiny muted" style="gap:10px">
      <span>${icon('file', 12)} ${words} 词</span>
      <span>${icon('chat', 12)} ${explained} 句已讲</span>
      <span>${esc((a.createdAt || '').slice(0, 10))}</span>
      <button class="btn btn-sm btn-ghost" data-speak-article="${a.id}" title="从头朗读全文" style="margin-left:auto">${icon('volume', 13)} 听全文</button>
    </div>
  </div>`;
}

/* ---------- 生词覆盖率 ---------- */

function currentCoverage(a) {
  if (!a) return null;
  const hash = articleHash(a.text);
  if (coverage.articleId === a.id && coverage.hash === hash && coverage.data) return coverage.data;
  return null;
}

async function ensureCoverage(a, { force = false } = {}) {
  if (!a) return;
  const hash = articleHash(a.text);
  if (!force && coverage.articleId === a.id && coverage.hash === hash) return;
  coverage = { articleId: a.id, hash, data: null, loading: true, error: '' };
  refreshKeep();
  try {
    const tokens = scanWords(a.text).map((t) => t.key);
    const dictInfo = await fetchDictBatch(tokens).catch(() => ({}));
    if (coverage.articleId !== a.id || coverage.hash !== hash) return;
    const data = computeCoverage(a.text, buildKnownSet(getState().words), dictInfo, a.hardSentences || []);
    coverage = { articleId: a.id, hash, data, loading: false, error: '' };
    patchArticle(a.id, { coverage: coverageSummary(data) });
  } catch (err) {
    coverage = { articleId: a.id, hash, data: null, loading: false, error: err.message };
  }
  refreshKeep();
}

function renderCoverageCard(a, cov) {
  const stored = a.coverage && a.coverage.hash === articleHash(a.text) ? a.coverage : null;
  const data = cov || stored;
  const head = `<div class="card-head"><div><h2>生词覆盖</h2><div class="sub">本地词库掌握度 + ECDICT 词频，按词种统计</div></div>${icon('highlighter', 18)}</div>`;

  if (!data && coverage.loading) {
    return `<section class="card mb16">${head}
      <div class="empty" style="padding:22px 0"><span class="loading"></span><p>正在统计生词…</p></div>
    </section>`;
  }
  if (!data) {
    return `<section class="card mb16">${head}
      <div class="empty" style="padding:22px 0">
        <p>还没有覆盖率数据${coverage.error ? `（${esc(coverage.error)}）` : ''}</p>
        <button class="btn btn-sm btn-primary" data-action="calcCoverage">${icon('refresh', 13)} 计算覆盖率</button>
      </div>
    </section>`;
  }

  const pct = Math.round((data.knownRatio || 0) * 100);
  const total = Math.max(1, data.totalTypes || 0);
  const bars = [
    ['已掌握', data.mastered, '#2f6b4f'],
    ['基础词', data.basic, '#5b5bd6'],
    ['在学', data.learning, '#c98a4b'],
    ['生词', data.unknown, '#b0463b']
  ];
  const list = (cov && cov.unknownWords ? cov.unknownWords : []).slice(0, 12);
  return `<section class="card mb16">
    ${head}
    <div class="spread" style="align-items:flex-end">
      <div><div class="stat-label">预计可读懂</div><div class="stat-value" style="font-size:30px">${pct}%</div></div>
      <div class="row" style="gap:6px">
        <span class="pill ${data.level >= 4 ? 'danger' : data.level >= 3 ? 'warn' : 'success'}">${esc(data.label || '')}</span>
        <span class="tiny muted">${'★'.repeat(data.level || 1)}${'☆'.repeat(5 - (data.level || 1))}</span>
      </div>
    </div>
    <div class="mastery-bar mt12" style="width:100%;height:10px;display:flex;overflow:hidden">
      ${bars.map(([label, n, color]) => `<i style="width:${Math.round((n / total) * 100)}%;background:${color}" title="${label} ${n}"></i>`).join('')}
    </div>
    <div class="row mt8" style="gap:12px;flex-wrap:wrap">
      ${bars.map(([label, n, color]) => `<span class="tiny muted"><b style="color:${color}">●</b> ${label} ${n}</span>`).join('')}
      <span class="tiny muted">平均 ${data.avgSentenceWords || 0} 词/句 · 长难句 ${data.hardCount || 0}</span>
    </div>

    ${!cov ? `<div class="tiny muted mt12">完整生词表正在重新统计…</div>`
      : list.length ? `<div class="mt16">${list.map((w, i) => `
        <div class="list-row" style="padding:8px 0">
          <div style="flex:1;min-width:0">
            <strong class="small">${esc(w.term)}</strong> <span class="tiny muted">${esc(w.phonetic || '')}</span>
            <div class="tiny muted" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(w.meaning || '暂无释义')}</div>
          </div>
          <span class="tiny muted">×${w.count}</span>
          <button class="btn btn-sm btn-ghost" data-action="addUnknown" data-i="${i}" title="加入词库">${icon('plus', 13)}</button>
        </div>`).join('')}</div>`
      : `<div class="feedback mt12">${icon('check', 13)} 没有发现明显生词，这篇可以放心读。</div>`}

    <div class="row mt12" style="flex-wrap:wrap">
      ${list.length ? `<button class="btn btn-sm btn-primary" data-action="addAllUnknown">${icon('plus', 13)} 生词入库 (${list.length})</button>` : ''}
      <button class="btn btn-sm" data-action="quizUnknown">${icon('sparkles', 13)} 用生词出题</button>
      <button class="btn btn-sm btn-ghost" data-action="calcCoverage">${icon('refresh', 13)} 重新计算</button>
    </div>
  </section>`;
}

/** 生词表 → 词库条目（ECDICT 释义优先，内置高考词库兜底） */
function unknownEntries(data) {
  return (data && data.unknownWords ? data.unknownWords : []).map((w) => {
    const b = builtinLookup(w.term);
    return {
      term: w.term,
      phonetic: w.phonetic || b?.phonetic || '',
      pos: b?.pos || '',
      meaning: w.meaning || b?.meaning || '',
      source: { type: 'article', articleId: currentId, at: new Date().toISOString() }
    };
  }).filter((w) => w.term);
}

function quizFromUnknown(data) {
  const entries = unknownEntries(data).slice(0, 20);
  if (!entries.length) { toast('这篇没有可用于出题的生词', 'info'); return; }
  addWords(entries);
  const terms = new Set(entries.map((e) => normalizeTerm(e.term)));
  const list = getState().words.filter((w) => terms.has(normalizeTerm(w.term))).slice(0, 20);
  if (list.length < 2) { toast('生词不足 2 个，无法生成试卷', 'error'); return; }
  const quiz = {
    id: `q_${Date.now().toString(36)}`, date: dateKey(),
    createdAt: new Date().toISOString(), status: 'draft',
    targetWordIds: list.map((w) => w.id), passage: null, questions: [], focus: '文章生词'
  };
  saveQuiz(quiz);
  go('quiz', { mode: 'take', id: quiz.id });
}

/** 列表页后台补算覆盖率：只更新徽章，不整页刷新 */
async function ensureListCoverage() {
  const articles = getState().articles.slice(0, 20);
  for (const a of articles) {
    if (mode !== 'list') return;
    const hash = articleHash(a.text);
    if (a.coverage && a.coverage.hash === hash) continue;
    try {
      const dictInfo = await fetchDictBatch(scanWords(a.text).map((t) => t.key)).catch(() => ({}));
      if (mode !== 'list') return;
      const summary = coverageSummary(computeCoverage(a.text, buildKnownSet(getState().words), dictInfo, a.hardSentences || []));
      patchArticle(a.id, { coverage: summary });
      const el = document.querySelector(`[data-cov-badge="${a.id}"]`);
      if (el) {
        el.textContent = `${summary.label} · 读懂 ${Math.round(summary.knownRatio * 100)}%`;
        el.className = `pill ${summary.level >= 4 ? 'danger' : summary.level >= 3 ? 'warn' : 'success'}`;
      }
    } catch (_) { /* 词典不可用不影响阅读 */ }
  }
}

function renderImportPanel() {
  if (!showImport) return '';
  const d = importDraft;
  const eb = d.ebook;
  return `
    <section class="card mt16">
      <div class="card-head"><div><h2>导入文章</h2><div class="sub">PDF / Word / EPUB 电子书，或粘贴文本、拍照 OCR</div></div>
        <button class="btn btn-sm btn-ghost" data-action="closeImport">${icon('x', 14)}</button></div>

      <div class="field">
        <label>电子书导入（PDF · Word · EPUB · TXT · MD · HTML · RTF）</label>
        <div class="file-drop" data-action="pickEbook">
          ${ebookBusy
            ? `<span class="loading"></span><div class="mt8">${esc(ebookProgress || '解析中…')}</div>`
            : eb
              ? `<div class="row" style="justify-content:center;gap:10px;flex-wrap:wrap">
                   <span class="pill success">${esc(FORMAT_LABELS[eb.format] || eb.format)}</span>
                   <strong>${esc(eb.fileName || '')}</strong>
                 </div>
                 <div class="tiny muted mt8">
                   ${eb.pages ? `${eb.pages} 页 · ` : ''}${eb.chapters ? `${eb.chapters} 章 · ` : ''}${countEbookWords(eb.text)} 词 · ${eb.text.length} 字符
                 </div>
                 ${eb.needsOcr ? `<div class="tiny mt8" style="color:#c0392b">⚠ 这份 PDF 几乎提取不到文字，可能是扫描件。点下方「转图片 OCR」。</div>` : ''}
                 ${eb.warnings?.length ? `<div class="tiny muted mt8">⚠ ${esc(eb.warnings.join('；'))}</div>` : ''}`
              : `${icon('upload', 28)}<div class="mt8">点击选择电子书文件</div><div class="tiny mt8">PDF 按版面还原段落 · Word 提取正文 · EPUB 按章节顺序拼接</div>`}
        </div>
        <div class="row mt12">
          <button class="btn btn-primary" data-action="pickEbook" ${ebookBusy ? 'disabled' : ''}>${icon('upload', 14)} 选择电子书</button>
          ${eb ? `<button class="btn btn-ghost btn-sm" data-action="clearEbook">移除</button>` : ''}
          ${eb?.needsOcr ? `<button class="btn btn-accent btn-sm" data-action="ebookToOcr" ${ebookBusy ? 'disabled' : ''}>${icon('camera', 13)} 转图片 OCR</button>` : ''}
        </div>
      </div>

      <div class="grid grid-2 mt16">
        <div>
          <div class="field"><label>文章标题</label>
            <input class="input" id="impTitle" placeholder="例如：The Power of Habit" value="${esc(d.title)}" /></div>
          <div class="field"><label>正文（可直接编辑）</label>
            <textarea class="textarea" id="impText" style="min-height:200px" placeholder="导入电子书后正文会出现在这里，也可以直接粘贴英文文章…">${esc(d.text)}</textarea></div>
          <button class="btn btn-accent btn-block" data-action="savePaste" ${busy || !d.text.trim() ? 'disabled' : ''}>
            ${busy ? '<span class="loading"></span> 处理中…' : `${icon('check')} 保存并开始阅读`}</button>
        </div>
        <div>
          <div class="field"><label>拍照 / 相册导入（支持多张，OCR 整篇）</label>
            <div class="file-drop" data-action="pickArticlePhoto">
              ${importDraft.photos.length
                ? `<div class="photo-grid">${importDraft.photos.map((p, i) => `
                    <div class="photo-thumb"><img src="${p.dataUrl}" alt="第${i + 1}张" />
                      <span class="photo-idx">${i + 1}</span>
                      <button class="photo-del" data-action="removePhoto" data-i="${i}" type="button">${icon('x', 12)}</button>
                    </div>`).join('')}
                    <button class="photo-add" data-action="pickArticlePhoto" type="button">${icon('plus', 20)}<span class="tiny">添加</span></button>
                   </div>`
                : `${icon('camera', 28)}<div class="mt8">点击选择文章照片（可多选）</div><div class="tiny mt8">支持课本、试卷、阅读材料 · 按页顺序识别</div>`}
            </div>
            <div class="row mt8" style="gap:8px">
              <button class="btn btn-sm" data-action="pickArticleCamera" type="button">${icon('camera', 13)} 拍照</button>
              <button class="btn btn-sm" data-action="pickArticlePhoto" type="button">${icon('image', 13)} 从相册选择</button>
            </div>
            ${importDraft.photos.length ? `<div class="tiny muted mt8">已选 ${importDraft.photos.length} 张图片，将按选择顺序拼接正文</div>` : ''}
          </div>
          <div class="field"><label>补充说明（可选）</label>
            <input class="input" id="impHint" placeholder="例如：只识别正文，忽略题目" value="${esc(d.hint)}" /></div>
          <div class="row">
            <button class="btn" data-action="pickTxt">${icon('upload', 14)} 上传 TXT</button>
            <button class="btn btn-primary" data-action="runArticleOcr" ${busy || !importDraft.photos.length ? 'disabled' : ''}>
              ${busy ? '<span class="loading"></span> 识别中…' : `${icon('sparkles', 14)} OCR 识别${importDraft.photos.length > 1 ? ` ${importDraft.photos.length} 张` : '文章'}`}</button>
          </div>
          <div class="feedback mt16">${icon('info', 14)} 电子书解析在本地完成，不上传原文件；只有点「AI 分析全文」时才会发送正文文本。</div>
        </div>
      </div>
    </section>
  `;
}

/* ---------- 渲染：阅读 ---------- */

function renderRead() {
  const a = getArticle(currentId);
  if (!a) { mode = 'list'; return renderList(); }
  const struct = splitArticle(a.text);
  const sentences = flattenSentences(struct);
  const hardList = Array.isArray(a.hardSentences) ? a.hardSentences : [];
  const hardMap = new Map(hardList.map((h) => [h.index, h]));
  const cov = currentCoverage(a);
  const stored = a.coverage && a.coverage.hash === articleHash(a.text) ? a.coverage : null;
  const shown = cov || stored;
  const vocab = matchArticleVocab(a.text);
  const unknownSet = showUnknown && cov ? unknownSurfaceSet(cov) : null;
  const coreSet = showCore ? vocab.surfaces : null;
  const rv = readingData(a);
  const vocabTotal = vocab.coreCount + vocab.extraCount;
  return `
    <div class="row reader-actions" style="margin-bottom:14px">
      <button class="btn btn-sm" data-action="backList">${icon('arrowLeft', 14)} 文章列表</button>
      <div style="flex:1"></div>
      ${cov ? `<button class="btn btn-sm ${showUnknown ? 'btn-primary' : ''}" data-action="toggleUnknown" title="标出未掌握的词">
        ${icon('highlighter', 13)} ${showUnknown ? '隐藏生词' : '生词高亮'}</button>` : ''}
      <button class="btn btn-sm" data-action="articleAnalysis" ${analysisBusy ? 'disabled' : ''}>
        ${analysisBusy ? '<span class="loading"></span>' : `${icon('sparkles', 14)} ${a.analysis ? '重新分析' : 'AI 分析全文'}`}</button>
      <button class="btn btn-sm" data-speak-article="${a.id}" title="从头朗读全文">${icon('volume', 14)} 听全文</button>
      ${mode === 'read' ? `<button class="btn btn-sm" data-action="goHistory">${icon('chat', 13)} 句库</button>` : ''}
      <button class="btn btn-sm btn-ghost" data-action="deleteArticle" title="删除文章">${icon('trash', 14)}</button>
    </div>

    <div class="reader-layout">
      <div>
        <article class="article-paper" id="articlePaper">
          <h2>${esc(a.title || '未命名文章')}</h2>
          ${struct.map((p, pi) => `
            <p><span class="para-num">¶${pi + 1}</span>${p.sentences.map((s) => {
              const idx = sentenceIndex(struct, pi, p.sentences.indexOf(s));
              const has = a.sentences && a.sentences[idx];
              const hard = hardMap.get(idx);
              const tip = hard ? `长难句 · ${hard.reason || ''}｜点这句开始精读` : '点这句，先自己翻，AI 再给提示';
              return `<span class="sentence ${idx === activeIndex ? 'active' : ''} ${has ? 'explained' : ''} ${hard ? 'hard-sentence' : ''}" data-si="${idx}" title="${esc(tip)}">${highlightSentence(s, { unknown: unknownSet, core: coreSet })}<button class="tts-btn tts-inline" type="button" data-speak="${esc(s)}" title="听这句" aria-label="听这句：${esc(s.slice(0, 40))}">${icon('volume', 13)}</button></span>`;
            }).join(' ')}</p>`).join('')}
        </article>
        <div class="selection-bar" id="selBar">
          <span class="sel-text">${selectionText ? `已选中：${esc(selectionText.slice(0, 60))}` : '点句子开始精读：先自己翻，AI 只给提示，翻得差不多了再给完整讲解'}</span>
          ${selectionText ? `<button class="btn btn-sm" data-action="translateSel">${icon('chat', 13)} 翻译选中</button>` : ''}
          ${selectionText ? `<button class="btn btn-sm btn-primary" data-action="explainSel">${icon('sparkles', 13)} 精读选中</button>` : ''}
        </div>
        <div class="tiny muted mt8">共 ${sentences.length} 句 · ${countWordsEn(a.text)} 词 · 紫色下划线是本地 NLP 挑出的长难句${vocabTotal ? ` · 词表命中 ${vocabTotal} 词` : ''}${shown ? ` · 生词 ${shown.unknown} 个 · 读懂约 ${Math.round(shown.knownRatio * 100)}%` : ''}</div>
      </div>

      <div class="study-col">
        ${renderStudyTabs(a, vocab, rv)}
        <div class="study-panel" id="studyPanel">
          ${renderStudyPanel(a, { vocab, hardList, cov, rv })}
        </div>
      </div>
    </div>
  `;
}

/* ---------- 阅读理解的本地作答状态 ---------- */

function readingData(a) {
  const hash = articleHash(a.text);
  const questions = a.reading && a.reading.hash === hash && Array.isArray(a.reading.questions) ? a.reading.questions : [];
  const result = a.readingResult && a.readingResult.hash === hash ? a.readingResult : null;
  if (reading.articleId !== a.id) {
    reading = {
      articleId: a.id,
      answers: result ? Object.assign({}, result.answers || {}) : {},
      submitted: !!result,
      busy: false,
      error: '',
      score: result ? { correct: result.correct, total: result.total } : null
    };
  }
  return { hash, questions, result };
}

const STUDY_TABS = [
  ['vocab', '词汇'],
  ['hard', '长难句'],
  ['reading', '阅读理解'],
  ['deep', '精讲']
];

function renderStudyTabs(a, vocab, rv) {
  const counts = {
    vocab: vocab.coreCount + vocab.extraCount,
    hard: (a.hardSentences || []).length,
    reading: rv.result ? `${rv.result.correct}/${rv.result.total}` : (rv.questions.length || ''),
    deep: 0
  };
  return `<div class="study-tabs" role="tablist" aria-label="文章学习分区">
    ${STUDY_TABS.map(([key, label]) => `
      <button class="study-tab ${studyTab === key ? 'active' : ''}" data-action="studyTab" data-tab="${key}" role="tab" aria-selected="${studyTab === key}" type="button">
        <span>${label}</span>${counts[key] ? `<em>${counts[key]}</em>` : ''}
      </button>`).join('')}
  </div>`;
}

function renderStudyPanel(a, { vocab, hardList, cov, rv }) {
  if (studyTab === 'hard') return renderHardCard(a, hardList);
  if (studyTab === 'reading') return renderReadingCard(a, rv);
  if (studyTab === 'deep') {
    return `${renderBacktransCard(a)}${renderExplanationPanel()}${a.analysis ? renderAnalysis(a.analysis) : ''}`;
  }
  return `${renderVocabCard(a, vocab)}${renderCoverageCard(a, cov)}`;
}

/* ---------- 第一部分：词汇（词表命中 + 背诵引导） ---------- */

function vocabRow(w, i) {
  return `<div class="vocab-row">
    <div class="vocab-main">
      <div class="vocab-term">${esc(w.term)}${w.phonetic ? `<span class="vocab-ph">${esc(w.phonetic)}</span>` : ''}</div>
      <div class="vocab-mean">${esc(w.meaning || '暂无释义')}</div>
    </div>
    <div class="vocab-side">
      <span class="tiny muted">×${w.count}</span>
      <button class="tts-btn" type="button" data-speak="${esc(w.term)}" title="听发音" aria-label="听 ${esc(w.term)}">${icon('volume', 13)}</button>
      <button class="btn btn-sm btn-ghost" data-action="addVocabWord" data-i="${i}" title="加入词库">${icon('plus', 13)}</button>
    </div>
  </div>`;
}

function renderVocabCard(a, vocab) {
  const total = vocab.coreCount + vocab.extraCount;
  const core = vocabShowAll ? vocab.core : vocab.core.slice(0, 12);
  const extra = vocabShowAll ? vocab.extra : vocab.extra.slice(0, 6);
  const inBook = new Set(getState().words.map((w) => normalizeTerm(w.term)));
  const newCount = [...vocab.core, ...vocab.extra].filter((w) => !inBook.has(normalizeTerm(w.term))).length;

  return `<section class="card mb16" id="vocabCard">
    <div class="card-head">
      <div><h2>词汇 <span class="pill">${total}</span></h2>
        <div class="sub">对照《高中核心词汇1000+高考超纲词》：核心 ${vocab.coreCount} 词 · 超纲 ${vocab.extraCount} 词 · 按文中出现顺序</div></div>
      ${icon('bookOpen', 18)}
    </div>
    <div class="row vocab-actions">
      <button class="btn btn-primary btn-sm" data-action="learnVocab" ${total ? '' : 'disabled'}>${icon('play', 13)} 背诵本文词 (${total})</button>
      <button class="btn btn-sm" data-action="addAllVocab" ${newCount ? '' : 'disabled'}>${icon('plus', 13)} 全部加入词库${newCount ? ` (${newCount})` : ''}</button>
      <button class="btn btn-sm ${showCore ? 'btn-primary' : ''}" data-action="toggleCoreVocab">${icon('highlighter', 13)} ${showCore ? '隐藏标注' : '标注原文'}</button>
    </div>

    ${total ? `
      <div class="mt16">${core.map((w, i) => vocabRow(w, i)).join('')}</div>
      ${vocab.coreCount > core.length && !vocabShowAll ? `<button class="btn btn-sm btn-ghost mt8" data-action="vocabMore">还有 ${vocab.coreCount - core.length} 个核心词，展开</button>` : ''}
      ${vocab.extra.length ? `<div class="vocab-sub">超纲词</div>
        <div>${extra.map((w, i) => vocabRow(w, vocab.core.length + i)).join('')}</div>
        ${vocab.extraCount > extra.length && !vocabShowAll ? `<button class="btn btn-sm btn-ghost mt8" data-action="vocabMore">还有 ${vocab.extraCount - extra.length} 个超纲词，展开</button>` : ''}` : ''}
    ` : `<div class="empty" style="padding:26px 0">${icon('bookOpen', 26)}<p>这篇没有命中词表词汇，可以先用「生词覆盖」把不认识的词收进词库。</p></div>`}

    <div class="feedback mt16">${icon('info', 13)} 「背诵本文词」在弹窗里完成，进度与词库、背单词页共用同一份记录；答错的词会进入背单词页的「阅读错词」。</div>
  </section>`;
}

/* ---------- 背诵本文词：弹窗卡片（与背单词页共用进度） ---------- */

function drillPromptHTML(q) {
  if (q.mode === 'w2m') {
    return `<div class="learn-word">${esc(q.word.term)}<button class="tts-btn" type="button" data-speak="${esc(q.word.term)}" title="听发音" aria-label="听 ${esc(q.word.term)} 的发音">${icon('volume', 18)}</button></div>
      <div class="learn-phonetic">${esc(q.word.phonetic || builtinLookup(q.word.term)?.phonetic || '')}</div>
      <div class="learn-hint">选出正确的中文释义</div>`;
  }
  return `<div class="learn-meaning">${esc(q.word.meaning)}</div>
    <div class="learn-hint">选出对应的英文单词</div>`;
}

function drillBody(s) {
  if (s.done) {
    const total = s.queue.length;
    const acc = total ? Math.round((s.right / total) * 100) : 0;
    return `<div class="drill-summary">
      <div class="learn-mode">本轮完成</div>
      <div class="drill-score">${acc}<span>%</span></div>
      <div class="sub">${total} 词 · 答对 ${s.right}</div>
      ${s.wrong.length
        ? `<div class="drill-wrong">${s.wrong.map((w) => `<span class="drill-chip"><b>${esc(w.term)}</b>${esc(w.meaning)}</span>`).join('')}</div>`
        : `<div class="feedback mt12">${icon('check', 13)} 全对，本文词汇已经过了一遍。</div>`}
      <div class="row mt16" style="justify-content:center">
        <button class="btn btn-primary btn-sm" data-drill="again" type="button">${icon('refresh', 13)} 再来一轮</button>
        <button class="btn btn-sm" data-close type="button">完成</button>
      </div>
    </div>`;
  }

  const q = s.queue[s.idx];
  const pct = Math.round((s.idx / s.queue.length) * 100);
  const options = q.options.map((o, i) => {
    let cls = '';
    if (s.answered) {
      if (o === q.answer) cls = 'right';
      else if (o === s.answered.choice) cls = 'wrong';
      else cls = 'dim';
    }
    return `<button class="learn-option ${cls}" data-drill="pick" data-i="${i}" type="button" ${s.answered ? 'disabled' : ''}>
      <span class="learn-opt-key">${'ABCD'[i]}</span><span>${esc(o)}</span></button>`;
  }).join('');
  const feedback = s.answered ? `<div class="learn-feedback ${s.answered.ok ? 'ok' : 'no'}">
      <b>${s.answered.ok ? '回答正确' : '再记一下'}</b>
      <div><b>${esc(q.word.term)}</b> ${esc(q.word.phonetic || '')} —— ${esc(q.word.meaning)}</div>
      <button class="btn btn-primary btn-sm mt12" data-drill="next" type="button">${s.idx + 1 >= s.queue.length ? '查看结果' : '下一个'} ${icon('arrowRight', 13)}</button>
    </div>` : '';

  return `<div class="drill-top">
      <div class="learn-progress"><div class="learn-progress-bar" style="width:${pct}%"></div></div>
      <span class="tiny muted">${s.idx + 1} / ${s.queue.length}</span>
    </div>
    <div class="learn-card">
      <div class="learn-mode">${q.mode === 'w2m' ? '看词选义' : '看义选词'}</div>
      ${drillPromptHTML(q)}
      <div class="learn-options">${options}</div>
      ${feedback}
    </div>`;
}

function openVocabDrill(article) {
  if (!article) return;
  const v = matchArticleVocab(article.text);
  const byTerm = new Map(getState().words.map((w) => [String(w.term || '').toLowerCase(), w]));
  const words = [...v.core, ...v.extra].map((w) => ({
    term: w.term,
    phonetic: w.phonetic || '',
    pos: '',
    meaning: w.meaning,
    example: '',
    ref: byTerm.get(String(w.term).toLowerCase()) || null
  }));
  if (!words.length) { toast('这篇没有命中词表的词', 'info'); return; }

  const session = { queue: buildQueue(words, words.length), idx: 0, right: 0, wrong: [], answered: null, done: false };
  modal({
    title: `背诵本文词 · ${words.length} 词`,
    wide: true,
    body: '<div class="drill-wrap" data-drill-host></div>',
    actions: [{ label: '关闭', value: null }],
    onMount: (overlay) => {
      const host = overlay.querySelector('[data-drill-host]');
      const box = overlay.querySelector('.modal');
      box.classList.add('modal-drill');
      const paint = () => { host.innerHTML = drillBody(session); box.scrollTop = 0; };
      paint();
      overlay.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-drill]');
        if (!btn) return;
        const act = btn.dataset.drill;
        if (act === 'pick') {
          if (session.answered) return;
          const q = session.queue[session.idx];
          const choice = q.options[Number(btn.dataset.i)];
          const ok = choice === q.answer;
          session.answered = { ok, choice };
          if (ok) session.right++; else session.wrong.push(q.word);
          applyAnswer(q.word, ok, 'article');
          paint();
        } else if (act === 'next') {
          session.answered = null;
          session.idx++;
          if (session.idx >= session.queue.length) session.done = true;
          paint();
        } else if (act === 'again') {
          session.queue = buildQueue(words, words.length);
          session.idx = 0; session.right = 0; session.wrong = []; session.answered = null; session.done = false;
          paint();
        }
      });
    }
  });
}

/* ---------- 第三部分：阅读理解（4 题，1 主旨 + 3 细节/推理/态度/词义） ---------- */

const RQ_TYPE_LABEL = { main: '主旨理解', detail: '细节理解', inference: '推理判断', attitude: '态度观点', vocab: '词义猜测' };

function renderReadingCard(a, rv) {
  if (reading.busy) {
    return `<section class="card mb16"><div class="card-head"><div><h2>阅读理解</h2><div class="sub">AI 正在按北京卷 C/D 篇难度命题…</div></div></div>
      <div class="empty" style="padding:30px 0"><span class="loading"></span><p>通常需要 10-40 秒</p></div></section>`;
  }

  if (!rv.questions.length) {
    return `<section class="card mb16">
      <div class="card-head"><div><h2>阅读理解</h2><div class="sub">4 道单选题：1 道主旨 + 3 道细节 / 推理 / 态度 / 词义，难度对标北京卷 C/D 篇</div></div>${icon('clipboard', 18)}</div>
      <div class="empty" style="padding:20px 0">
        ${icon('sparkles', 26)}
        <p>${reading.error ? esc(reading.error) : '这篇还没有阅读理解题。生成后会自动缓存，正文不变不重复出题。'}</p>
        <button class="btn btn-primary btn-sm" data-action="genReading">${icon('sparkles', 13)} ${reading.error ? '重试生成' : '生成 4 道阅读题'}</button>
      </div>
    </section>`;
  }

  const submitted = reading.submitted;
  const score = reading.score;
  return `<section class="card mb16">
    <div class="card-head">
      <div><h2>阅读理解 <span class="pill">${rv.questions.length} 题</span></h2>
        <div class="sub">北京卷 C/D 篇难度${submitted && score ? ` · 本次 ${score.correct} / ${score.total} 正确` : ' · 选完后提交，逐题看解析'}</div></div>
      <button class="btn btn-sm btn-ghost" data-action="genReading" ${submitted ? '' : 'disabled'} title="重新命题">${icon('refresh', 13)} 换一套</button>
    </div>

    ${rv.questions.map((q, qi) => {
      const chosen = reading.answers[q.id];
      return `<div class="rq">
        <div class="rq-head">
          <span class="q-index">${qi + 1}</span>
          <span class="pill ${q.type === 'main' ? 'primary' : ''}">${RQ_TYPE_LABEL[q.type] || '理解'}</span>
          ${submitted ? `<span class="rq-state ${Number(chosen) === q.answer ? 'ok' : 'no'}">${Number(chosen) === q.answer ? '正确' : '需复习'}</span>` : ''}
        </div>
        <p class="rq-stem">${esc(q.stem)}</p>
        <div class="rq-options">
          ${q.options.map((opt, i) => {
            let cls = '';
            if (submitted) cls = i === q.answer ? 'right' : (i === Number(chosen) ? 'wrong' : 'dim');
            else if (i === Number(chosen)) cls = 'selected';
            return `<button type="button" class="rq-option ${cls}" data-action="rqPick" data-q="${esc(q.id)}" data-i="${i}" ${submitted ? 'disabled' : ''}>
              <span class="rq-key">${'ABCD'[i]}</span><span class="rq-text">${esc(opt)}</span></button>`;
          }).join('')}
        </div>
        ${submitted ? `<div class="rq-explain">
          <div>${icon('info', 13)} ${esc(q.explain || '暂无解析')}</div>
          ${q.anchor?.anchored ? `<button class="btn btn-sm btn-ghost mt8" data-action="jumpSentence" data-si="${q.anchor.sentenceIndex}">${icon('reader', 12)} 回到原文依据</button>` : ''}
        </div>` : ''}
      </div>`;
    }).join('')}

    <div class="rq-foot">
      ${submitted
        ? `<div class="rq-score ${score && score.correct === score.total ? 'ok' : ''}">${score ? score.correct : 0} / ${score ? score.total : rv.questions.length}</div>
           <div class="row">
             <button class="btn btn-sm" data-action="retryReading">${icon('refresh', 13)} 再做一遍</button>
             <button class="btn btn-sm btn-ghost" data-action="learnVocab">${icon('target', 13)} 去背本文词</button>
           </div>`
        : `<button class="btn btn-primary" data-action="submitReading">${icon('check', 14)} 提交批改</button>
           <span class="tiny muted">已选 ${Object.keys(reading.answers).length} / ${rv.questions.length}</span>`}
    </div>
  </section>`;
}


/** 回译练习：只列已经精读过的句子（有中文译文才能遮住原文） */
function renderBacktransCard(a) {
  const map = a.sentences || {};
  const items = Object.keys(map)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((x, y) => x - y)
    .map((i) => ({ i, s: map[i] }))
    .filter((x) => x.s && x.s.translation)
    .slice(0, 6);
  if (!items.length) {
    return `<section class="card mb16">
      <div class="card-head"><div><h2>回译练习</h2><div class="sub">看中文写英文，交卷后逐词对照</div></div>${icon('refresh', 18)}</div>
      <div class="tiny muted">精读完一句（拿到中文译文）后，这里会出现回译练习。</div>
    </section>`;
  }
  return `<section class="card mb16">
    <div class="card-head"><div><h2>回译练习 <span class="pill">${items.length}</span></h2>
      <div class="sub">遮住原文，看中文写英文；交卷后按词比对，自动分出时态 / 词序 / 搭配问题</div></div>${icon('refresh', 18)}</div>
    <div class="bt-list">${items.map(({ i, s }) => `
      <button class="bt-item" type="button" data-action="backtrans" data-i="${i}">
        <span class="bt-item-zh">${esc(String(s.translation || '').slice(0, 60))}${String(s.translation || '').length > 60 ? '…' : ''}</span>
        <span class="bt-item-go">${icon('arrowRight', 14)}</span>
      </button>`).join('')}</div>
  </section>`;
}

function verdictLabel(v) {
  return v === 'close' ? '基本到位' : v === 'partial' ? '对了一半' : v === 'off' ? '差得比较远' : '';
}

function coachSub(c) {
  const where = c.index >= 0 ? `第 ${c.index + 1} 句` : '划选内容';
  if (c.analysis) return c.fromCache ? `${where} · 上次讲解` : `${where} · 对话 ${c.attempts} 轮`;
  if (c.cached && !c.turns.length) return `${where} · 这句你之前讲过`;
  return `${where} · 先自己翻，再对照`;
}

/** 句子精讲面板：对话 → 引导 → 最后才给分析 */
function renderExplanationPanel() {
  if (!coach) {
    return `<section class="card">
      <div class="card-head"><div><h2>句子精讲</h2><div class="sub">先自己翻，再对照</div></div>${icon('highlighter', 18)}</div>
      <div class="empty" style="padding:34px">${icon('highlighter', 30)}<h3>选中一个句子</h3>
        <p>你先用中文翻一遍，AI 会看着你的译文给提示；翻得差不多了，才给完整讲解</p></div></section>`;
  }
  const c = coach;
  return `
    <section class="card coach-card" id="coachCard">
      <div class="card-head">
        <div><h2>句子精讲</h2><div class="sub">${esc(coachSub(c))}</div></div>
        ${c.analysis ? `<button class="btn btn-sm btn-primary" data-action="vizModal">${icon('chart', 13)} 可视化讲解</button>` : icon('highlighter', 18)}
      </div>
      <blockquote class="coach-sentence"><span class="coach-src">${c.index >= 0 ? '原句' : '划选'}</span>${esc(c.sentence)}<button class="tts-btn tts-inline" type="button" data-speak="${esc(c.sentence)}" title="听这句" aria-label="听这句">${icon('volume', 13)}</button></blockquote>
      ${c.cached && !c.turns.length && !c.analysis && !c.busy ? `<div class="coach-resume">
          <div class="tiny muted">上次的讲解还在缓存里，你可以先自己再翻一次，也可以直接看。</div>
          <div class="row mt8">
            <button class="btn btn-sm btn-primary" data-action="coachStart">${icon('chat', 13)} 先自己翻一次</button>
            <button class="btn btn-sm btn-ghost" data-action="coachShowCached">看上次的讲解</button>
          </div>
        </div>` : ''}
      ${!c.analysis && (c.turns.length || c.busy) ? `<div class="coach-thread">${coachTurnsHtml(c)}${c.busy ? coachTypingHtml(c) : ''}</div>` : ''}
      ${c.analysis ? renderCoachAnalysis(c) : `
        ${c.cached && !c.turns.length && !c.busy ? '' : `<div class="coach-input">
          ${!c.turns.length ? `<div class="coach-freewrite">${icon('highlighter', 13)} 先自己翻，AI 不会提前提示；写完交给老师，卡住再点「给点提示」。</div>` : ''}
          <textarea class="textarea" id="coachInput" placeholder="用中文把这句话的意思写出来，卡住的地方可以先跳过…">${esc(c.draft)}</textarea>
          <div class="row" style="margin-top:10px">
            <button class="btn btn-primary" data-action="coachSend" ${c.busy ? 'disabled' : ''}>${icon('chat', 13)} 交给老师看</button>
            <button class="btn btn-sm btn-ghost" data-action="coachHint" ${c.busy ? 'disabled' : ''}>给点提示</button>
            <div style="flex:1"></div>
            <button class="btn btn-sm btn-ghost" data-action="coachReveal" ${c.busy ? 'disabled' : ''}>直接看讲解</button>
          </div>
          <div class="tiny muted mt8">已尝试 ${c.attempts} 次 · 翻得不顺也没关系，先把能确定的部分写出来</div>
        </div>`}`}
      ${c.error ? `<div class="feedback mt12" style="border-left:3px solid var(--warn)">${icon('info', 13)} ${esc(c.error)}</div>` : ''}
    </section>`;
}

function coachTurnsHtml(c) {
  return c.turns.map((t) => {
    if (t.role === 'me') {
      const meta = (t.pseudo || t.score == null) ? ''
        : `<span class="coach-score">理解度 ${t.score} · ${esc(verdictLabel(t.verdict))}</span>`;
      return `<div class="coach-turn coach-turn--me"><div class="coach-bubble${t.pseudo ? ' pseudo' : ''}">${esc(t.text)}${meta}</div></div>`;
    }
    const paras = String(t.text || '').split(/\n+/).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('');
    return `<div class="coach-turn coach-turn--coach">
      <span class="coach-avatar" aria-hidden="true">师</span>
      <div class="coach-bubble">
        ${paras || '<p>…</p>'}
        ${t.focus?.length ? `<div class="coach-focus"><span>留意</span>${t.focus.map((f) => `<em>${esc(f)}</em>`).join('')}</div>` : ''}
        ${t.question ? `<div class="coach-q">${esc(t.question)}</div>` : ''}
      </div>
    </div>`;
  }).join('');
}

function coachTypingHtml(c) {
  return `<div class="coach-turn coach-turn--coach">
    <span class="coach-avatar" aria-hidden="true">师</span>
    <div class="coach-bubble"><div class="coach-typing"><span class="loading"></span>${c.turns.length ? '在看你的译文…' : '正在读这句话…'}</div></div>
  </div>`;
}

function renderCoachAnalysis(c) {
  const e = c.analysis;
  const mine = [...c.turns].reverse().find((t) => t.role === 'me' && !t.pseudo);
  const lastCoach = [...c.turns].reverse().find((t) => t.role === 'coach' && t.text);
  const tries = c.turns.filter((t) => t.role === 'me' && !t.pseudo).length;
  return `
    ${lastCoach ? `<div class="coach-verdict">${esc(lastCoach.text)}</div>` : ''}
    ${tries ? `<details class="coach-recap"><summary>回顾我们的对话（${tries} 次尝试）</summary>
      <div class="coach-thread">${coachTurnsHtml(c)}</div></details>` : ''}
    <div class="coach-compare">
      ${mine ? `<div><h4>你的译文</h4><p class="mine">${esc(mine.text)}</p></div>` : ''}
      <div><h4>参考译文</h4><p class="ref">${esc(e.translation || '')}</p></div>
      ${e.structure ? `<div class="coach-structure">${icon('layers', 12)} ${esc(e.structure)}</div>` : ''}
    </div>
    ${e.breakdown?.length ? `<div class="analysis-block"><h4>结构拆解</h4>
      ${e.breakdown.map((b) => `<div class="small" style="line-height:1.8"><b>${esc(b.part)}</b> — ${esc(b.role)}</div>`).join('')}</div>` : ''}
    ${e.grammar?.length ? `<div class="analysis-block"><h4>语法点</h4>
      ${e.grammar.map((g) => `<div class="grammar-item"><b>${esc(g.point)}</b>：${esc(g.explain)}</div>`).join('')}</div>` : ''}
    ${e.words?.length ? `<div class="mt12">
      <div class="row spread"><strong class="small">重点词汇 · ${e.words.length} 个</strong>
        <button class="btn btn-sm btn-primary" data-action="addWordsToBook">${icon('plusCircle', 13)} 全部加入词库</button></div>
      ${e.words.map((w, i) => `<div class="list-row" style="padding:8px 0">
        <div style="flex:1;min-width:0">
          <div class="row" style="gap:6px"><span class="word-term">${esc(w.term)}</span>
            <span class="word-level ${w.level === '核心' ? 'core' : w.level === '进阶' ? 'adv' : 'ext'}">${esc(w.level || '核心')}</span></div>
          ${w.phonetic ? `<div class="tiny muted">${esc(w.phonetic)} ${esc(w.pos || '')}</div>` : ''}
          <div class="small">${esc(w.meaning)}</div>
        </div>
        <div style="text-align:right">
          <button class="tts-btn" type="button" data-speak="${esc(w.term)}" title="听发音" aria-label="听 ${esc(w.term)}">${icon('volume', 14)}</button>
          <button class="btn btn-sm btn-ghost" data-action="addOneWord" data-i="${i}" title="加入词库">${icon('plus', 13)}</button>
        </div>
      </div>`).join('')}
    </div>` : ''}
    ${e.nlp ? (() => {
      // AI↔NLP 交叉校验结论：一致 → 绿色徽章；冲突 → 红色并可展开详情（冲突处采信 NLP）
      const c = e.consistency || { verdict: 'unknown', conflicts: [] };
      const FIELD_LABEL = { root: '主干动词', passive: '被动语态', question: '疑问句' };
      const conflict = c.verdict === 'conflict';
      const detail = conflict ? `
        <details class="nlp-conflict" style="margin-top:6px">
          <summary style="color:var(--danger);cursor:pointer">不一致 ${c.conflicts.length} 处，点击查看（按约定此处采信本地句法）</summary>
          ${c.conflicts.map((cf) => `<div class="small" style="margin:6px 0 0 12px">
            <b>${esc(FIELD_LABEL[cf.field] || cf.field)}</b>：
            采信 NLP <b style="color:var(--success)">${esc(cf.nlp)}</b>
            <span class="tiny muted">（AI 讲解为「${esc(cf.ai)}」）</span></div>`).join('')}
        </details>` : '';
      return `<div class="feedback mt12" style="border-left:3px solid ${conflict ? 'var(--danger)' : 'var(--success)'}">
        ${icon(conflict ? 'info' : 'check', 13)} <strong>${conflict ? '句法交叉校验发现分歧' : '句法已校准'}</strong> · ${esc(e.nlp.engine)} 本地分析
        <span class="tiny muted">（${esc(e.nlp.stats?.sentenceType || '')} · ${esc(e.nlp.stats?.complexity || '')} · ${e.nlp.stats?.clauses || 0} 处从句结构）</span>
        <button class="btn btn-sm btn-ghost" data-action="showSyntax" style="margin-left:6px">查看句法骨架</button>
        ${detail}
      </div>`;
    })() : ''}
    ${e.tip ? `<div class="feedback mt12">${icon('info', 13)} ${esc(e.tip)}</div>` : ''}
    <div class="row mt16">
      <button class="btn btn-sm btn-ghost" data-action="coachRestart">${icon('refresh', 13)} 再练一次这句</button>
      ${e.translation ? `<button class="btn btn-sm btn-primary" data-action="coachBacktrans">${icon('refresh', 13)} 回译对照</button>` : ''}
    </div>`;
}

function renderAnalysis(an) {
  const kw = an.keyWords || [];
  const hs = an.hardSentences || [];
  const kwHit = kw.filter((k) => k.anchor?.anchored).length;
  const hsHit = hs.filter((s) => s.anchor?.anchored).length;
  /** 锚点控件：已定位 → 跳原句按钮；未定位 → 灰色诚实徽章；旧缓存无 anchor 字段 → 不渲染 */
  const anchorCtl = (it) => it.anchor?.anchored
    ? `<button class="anchor-go" type="button" data-action="jumpSentence" data-si="${it.anchor.sentenceIndex}" title="在原文中定位">${icon('reader', 12)}</button>`
    : (it.anchor ? `<span class="anchor-miss" title="这条 AI 返回在原文中匹配不到，可能是改写或杜撰">未定位</span>` : '');
  return `
    <section class="card mt16">
      <div class="card-head"><div><h2>全文分析</h2><div class="sub">${esc(an.level || '高中')} · ${an.wordCount || 0} 词${an.anchored ? ' · 定位回原文已启用' : ''}</div></div>${icon('chart', 18)}</div>
      ${an.theme ? `<div class="analysis-block"><h4>主旨</h4><p>${esc(an.theme)}</p></div>` : ''}
      ${an.summary ? `<div class="analysis-block"><h4>内容概要</h4><p>${esc(an.summary)}</p></div>` : ''}
      ${an.structure?.length ? `<div class="analysis-block"><h4>篇章结构</h4>
        ${an.structure.map((s) => `<div class="small" style="margin:6px 0"><b>${esc(s.part)}</b> ${esc(s.gist)}<span class="tiny muted"> · ${esc(s.role)}</span></div>`).join('')}</div>` : ''}
      ${kw.length ? `<div class="analysis-block"><h4>重点词汇（点击讲解并入库 · 已定位 ${kwHit}/${kw.length}）</h4>
        ${kw.map((k, i) => `<span class="kw-chip" data-action="analysisWord" data-i="${i}">
          <b>${esc(k.term)}</b><span class="kw-mean">${esc(k.meaning)}</span>${anchorCtl(k)}<button class="tts-btn" type="button" data-speak="${esc(k.term)}" title="听发音" aria-label="听 ${esc(k.term)}">${icon('volume', 12)}</button></span>`).join('')}</div>` : ''}
      ${hs.length ? `<div class="analysis-block"><h4>长难句（AI 判定 · 正文紫线为本地 NLP 判定）</h4>
        <div class="tiny muted" style="margin-bottom:8px">已定位 ${hsHit}/${hs.length}；「未定位」条目可能是 AI 改写或杜撰，谨慎参考</div>
        ${hs.map((s) => `<div class="hard-sentence">
          <div class="hs-text">${esc(s.text)} ${anchorCtl(s)}</div>
          <div class="tiny muted">${esc(s.reason)}</div>
          <div class="row" style="gap:6px">
            <button class="btn btn-sm btn-ghost" data-action="coachHard" data-text="${esc(s.text)}">${icon('highlighter', 12)} 我自己翻这句</button>
            <button class="btn btn-sm btn-ghost" type="button" data-speak="${esc(s.text)}">${icon('volume', 12)} 听这句</button>
          </div>
        </div>`).join('')}</div>` : ''}
      ${an.highlights?.length ? `<div class="analysis-block"><h4>写作亮点</h4><ul>${an.highlights.map((h) => `<li>${esc(h)}</li>`).join('')}</ul></div>` : ''}
      ${an.quiz?.length ? `<div class="analysis-block"><h4>理解思考题</h4>
        ${an.quiz.map((q) => `<div class="small" style="margin:6px 0"><b>Q：</b>${esc(q.q)}<div class="tiny muted">A：${esc(q.a)}</div></div>`).join('')}</div>` : ''}
    </section>`;
}

/* ---------- 工具函数 ---------- */

function countWordsEn(text) {
  const m = String(text || '').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g);
  return m ? m.length : 0;
}

function refreshMe() { refresh(); }
/** 精读对话刷新：保留滚动位置，不把读者甩回页首 */
function refreshKeep() { refresh({ keepScroll: true }); }

function collectImport() {
  const t = document.getElementById('impTitle'); if (t) importDraft.title = t.value;
  const x = document.getElementById('impText'); if (x) importDraft.text = x.value;
  const h = document.getElementById('impHint'); if (h) importDraft.hint = h.value;
}

function saveNewArticle({ title, text, source }) {
  if (!text || !text.trim()) { toast('正文为空', 'error'); return; }
  const a = saveArticle({ title: title || text.slice(0, 40), text: text.trim(), source: source || 'manual' });
  logActivity(dateKey(), { wordsAdded: 0 });
  toast('文章已保存，开始精读吧', 'success');
  currentId = a.id; mode = 'read'; activeIndex = -1; coach = null; selectionText = '';
  showImport = false; importDraft = { title: '', text: '', source: '', photos: [], fileName: '', hint: '', ebook: null, ebookFile: null };
  refreshMe();
  ensureHardSentences(a.id);
  ensureCoverage(a);
}

function toWordEntries(words, sourceType) {
  return words.filter((w) => w && String(w.term || '').trim()).map((w) => ({
    term: String(w.term).trim(), phonetic: String(w.phonetic || ''), pos: String(w.pos || ''),
    meaning: String(w.meaning || ''), example: String(w.example || ''),
    source: { type: sourceType, articleId: currentId, at: new Date().toISOString() }
  }));
}

/** 把讲解结果转成历史记录条目 */
function buildHistoryEntry(result, article, index) {
  return {
    sentence: result.sentence || '',
    translation: result.translation || '',
    structure: result.structure || '',
    breakdown: result.breakdown || [],
    grammar: result.grammar || [],
    words: result.words || [],
    tip: result.tip || '',
    nlp: result.nlp || null,
    articleId: article?.id || null,
    articleTitle: article?.title || '',
    sentenceIndex: typeof index === 'number' ? index : -1
  };
}

/** 打开可视化讲解弹窗（含加入词库/历史提示） */
async function openVizModal(result, article) {
  if (!result) return;
  const body = vizModalBody(result);
  await modal({
    title: '句子结构可视化讲解',
    wide: true,
    body,
    onMount: mountVizToggles,
    actions: [
      { label: '关闭', value: null },
      { label: '重点词入库', cls: 'btn-primary', keepOpen: true, onClick: (overlay, done) => {
        if (!result.words?.length) { toast('本句暂无重点词', 'info'); return; }
        const r = addWords(toWordEntries(result.words, 'sentence'));
        logActivity(dateKey(), { wordsAdded: r.added });
        toast(`已加入词库：新增 ${r.added}，更新 ${r.updated}`, 'success');
        // 更新按钮反馈
        const b = overlay.querySelector('[data-act="1"]');
        if (b) { b.textContent = `✓ 已入库 ${r.added} 词`; b.disabled = true; }
      } }
    ]
  });
}

/* ---------- 对话式精读 ---------- */

function lastMyTurn(c) {
  return [...c.turns].reverse().find((t) => t.role === 'me' && !t.pseudo);
}

function scrollCoachIntoView(force = false) {
  const el = document.getElementById('coachCard');
  if (!el) return;
  const top = el.getBoundingClientRect().top;
  // 桌面端：面板就在正文旁边，除非它已经滚出可视区，否则不打断阅读
  if (!force && window.innerWidth > 1040 && top >= 0 && top < window.innerHeight - 160) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/** 定位回原文：滚动到指定句子并短暂高亮（全文分析卡的重点词/难句跳转用） */
function jumpToSentence(si) {
  const el = document.querySelector(`#articlePaper .sentence[data-si="${si}"]`);
  if (!el) { toast('没有找到对应的句子', 'error'); return; }
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('anchor-flash');
  setTimeout(() => el.classList.remove('anchor-flash'), 2200);
}

/** 把精读对话轮次持久化到句子缓存（上限 10 轮），切页/刷新后可回顾 */
function persistCoachTurns(c) {
  if (!c || c.index < 0) return;
  const a = getArticle(currentId);
  if (!a) return;
  patchSentence(a.id, c.index, { coachTurns: c.turns.slice(-10) });
}

/** 打开某一句的精读对话：先让学生自己翻，AI 只引导 */
function openCoach(index, sentenceOverride = '') {
  const a = getArticle(currentId);
  if (!a) return;
  const all = flattenSentences(splitArticle(a.text));
  const sentence = String(index >= 0 ? (all[index] || '') : (sentenceOverride || '')).trim();
  if (!sentence) { toast('先选中要讲的句子', 'info'); return; }
  const context = index >= 0
    ? all.slice(Math.max(0, index - 1), index + 2).join(' ')
    : all.slice(0, 3).join(' ');

  // 恢复上次的对话轮次（上限 10 轮）：切页/刷新后仍可回顾，不再丢失中间过程
  const cachedEntry = index >= 0 ? (a.sentences?.[index] || null) : null;
  coach = {
    index,
    sentence,
    context,
    turns: index >= 0 ? [...(cachedEntry?.coachTurns || [])] : [],
    attempts: 0,
    busy: false,
    analysis: null,
    cached: cachedEntry,
    fromCache: false,
    nlp: null,
    draft: '',
    error: ''
  };
  // 上次已经拿到完整讲解 → 直接恢复到分析视图（对话历史一并回顾）；
  // 想重练用「再练一次这句」。只有轮次没有讲解（上次中途退出）→ 保持对话态继续练。
  if (cachedEntry && String(cachedEntry.translation || '').trim()) {
    coach.analysis = cachedEntry;
    coach.fromCache = true;
  }
  activeIndex = index;
  studyTab = 'deep';          // 点句子 → 自动切到「精讲」分区
  activeNlp = (index >= 0 && a.sentences?.[index]?.nlp) || null;
  refreshKeep();
  scrollCoachIntoView();

  // 后台取本地句法骨架：结构树先用缓存，没有再请求
  if (!activeNlp) {
    nlpSentence(sentence)
      .then((r) => {
        if (coach && coach.sentence === sentence) {
          coach.nlp = r;
          if (activeIndex === index) { activeNlp = r; refreshKeep(); }
        }
      })
      .catch(() => {});
  } else {
    coach.nlp = activeNlp;
  }
  // 不再自动让 AI 开场：先让学生自己翻，需要提示时再点「给点提示」
}

async function runCoachTurn({ translation = '', mode = 'answer' } = {}) {
  const c = coach;
  if (!c || c.busy) return;
  if (mode === 'answer') {
    if (!translation.trim()) { toast('先写下你的译文', 'info'); return; }
    c.turns.push({ role: 'me', text: translation.trim() });
    c.attempts += 1;
    c.draft = '';
  } else {
    c.turns.push({ role: 'me', pseudo: true, text: mode === 'hint' ? '（先给点提示，别告诉我答案）' : '（直接给我讲解吧）' });
  }
  const history = c.turns.slice(0, -1);
  c.busy = true; c.error = ''; refreshKeep();
  try {
    const r = await coachSentence({
      sentence: c.sentence,
      context: c.context,
      transcript: history.map((t) => ({ role: t.role, text: t.text })),
      translation,
      mode,
      attempt: c.attempts,
      nlp: c.nlp
    });
    if (coach !== c) return;
    if (mode === 'answer') {
      const last = lastMyTurn(c);
      if (last) { last.score = r.score; last.verdict = r.verdict; }
    }
    c.turns.push({ role: 'coach', text: r.reply, focus: r.focus, question: r.question, stage: r.stage });
    c.busy = false;
    if (r.analysis) finishCoach(r.analysis);
  } catch (err) {
    if (coach !== c) return;
    c.busy = false;
    c.error = `对话失败：${err.message}`;
  }
  persistCoachTurns(c);
  refreshKeep();
  scrollCoachIntoView();
}

/** 讲解到位：落缓存、记历史，并显示完整分析 */
function finishCoach(analysis) {
  const c = coach;
  if (!c || !analysis) return;
  const a = getArticle(currentId);
  analysis.sentence = analysis.sentence || c.sentence;
  c.analysis = analysis;
  c.fromCache = false;
  const mine = lastMyTurn(c);
  if (a) {
    if (c.index >= 0) {
      cacheSentence(a.id, c.index, analysis);
      // cacheSentence 会整体覆盖句子缓存对象，轮次要在其之后补写回去
      persistCoachTurns(c);
    }
    recordSentence(Object.assign(buildHistoryEntry(analysis, a, c.index), {
      myTranslation: mine?.text || '',
      attempts: c.attempts || 1
    }));
  }
  activeIndex = c.index;
  toast(c.attempts ? '讲解已生成，对照一下你的译文' : '讲解已生成', 'success');
}

/* ---------- 渲染入口 ---------- */

export function render(params = {}) {
  const prevId = currentId;
  // 支持从首页直接打开某一篇：#/reader?id=xxx
  // 路由里的 id 只消费一次：否则用户在列表里换文章后，刷新会把 currentId 拽回旧文章
  if (params.id && params.id !== routeIdConsumed) {
    const a = getArticle(params.id);
    if (a) { currentId = a.id; mode = 'read'; }
    routeIdConsumed = params.id;
  }
  if (!params.id) routeIdConsumed = '';

  if (currentId !== prevId) {
    reading = { articleId: null, answers: {}, submitted: false, busy: false, error: '', score: null };
    vocabShowAll = false;
    if (!params.tab) studyTab = 'vocab';
  }
  // 首页「复习」深链：直接落到指定分区
  if (params.tab && STUDY_TABS.some(([k]) => k === params.tab)) {
    if (params.tab !== tabFromRoute) { studyTab = params.tab; tabFromRoute = params.tab; }
  } else {
    tabFromRoute = '';
  }

  return mode === 'read' && currentId ? renderRead() : renderList();
}

export function mount() {
  const view = document.getElementById('view');

  // 进入阅读页自动统计生词；列表页在后台补算各文章难度徽章
  if (mode === 'read' && currentId) {
    const art = getArticle(currentId);
    if (art) ensureCoverage(art);
  } else if (mode === 'list') {
    ensureListCoverage();
  }

  // 导入面板：输入时实时更新 draft 与按钮状态（避免整页刷新丢焦点）
  const impText = view.querySelector('#impText');
  if (impText) {
    impText.addEventListener('input', () => {
      importDraft.text = impText.value;
      const btn = view.querySelector('[data-action="savePaste"]');
      if (btn) btn.disabled = !importDraft.text.trim() || busy;
    });
  }
  const impTitle = view.querySelector('#impTitle');
  if (impTitle) impTitle.addEventListener('input', () => { importDraft.title = impTitle.value; });
  const impHint = view.querySelector('#impHint');
  if (impHint) impHint.addEventListener('input', () => { importDraft.hint = impHint.value; });

  // 划词检测
  const paper = view.querySelector('#articlePaper');
  if (paper) {
    paper.addEventListener('mouseup', () => {
      const sel = (window.getSelection()?.toString() || '').trim();
      if (sel && sel.length > 1) { selectionText = sel.slice(0, 300); refreshKeep(); }
    });
    paper.addEventListener('touchend', () => {
      setTimeout(() => {
        const sel = (window.getSelection()?.toString() || '').trim();
        if (sel && sel.length > 1) { selectionText = sel.slice(0, 300); refreshKeep(); }
      }, 100);
    });
  }

  // 精读输入框：草稿实时保存、Ctrl/Cmd+Enter 提交、桌面端自动聚焦
  const thread = view.querySelector('.coach-thread');
  if (thread) thread.scrollTop = thread.scrollHeight;

  const coachInput = view.querySelector('#coachInput');
  if (coachInput && coach) {
    coachInput.addEventListener('input', () => { if (coach) coach.draft = coachInput.value; });
    coachInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) {
        ev.preventDefault();
        view.querySelector('[data-action="coachSend"]')?.click();
      }
    });
    if (!coach.busy && window.innerWidth > 1040) {
      try {
        coachInput.focus({ preventScroll: true });
        coachInput.setSelectionRange(coachInput.value.length, coachInput.value.length);
      } catch (_) {}
    }
  }

  // 首页「复习」深链：#/reader?id=xxx&si=3 → 渲染后直接打开该句精讲（只消费一次）
  const params = (getRoute() || {}).params || {};
  if (params.si !== undefined && params.si !== '' && !siConsumed) {
    siConsumed = true;
    const idx = Number(params.si);
    if (Number.isFinite(idx) && idx >= 0) { openCoach(idx); return; }
  } else if (params.si === undefined) {
    siConsumed = false;
  }

  view.addEventListener('click', async (e) => {
    const sentenceEl = e.target.closest('.sentence');
    if (sentenceEl && !e.target.closest('[data-action]')) {
      const idx = Number(sentenceEl.dataset.si);
      selectionText = '';
      if (coach && coach.index === idx) { refreshKeep(); scrollCoachIntoView(); return; }
      openCoach(idx);
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) {
      const card = e.target.closest('[data-article]');
      if (card) {
        currentId = card.dataset.article; mode = 'read'; activeIndex = -1; coach = null; selectionText = '';
        coverage = { articleId: null, hash: '', data: null, loading: false, error: '' };
        showUnknown = false;
        studyTab = 'vocab'; vocabShowAll = false;
        reading = { articleId: null, answers: {}, submitted: false, busy: false, error: '', score: null };
        refreshMe();
        ensureHardSentences(currentId);
        ensureCoverage(getArticle(currentId));
      }
      return;
    }
    const a = btn.dataset.action;

    if (a === 'newImport') { collectImport(); showImport = true; refreshMe(); return; }
    if (a === 'quickPhotoArticle') {
      // 拍照快捷流：直接调起相机/选图 → OCR → 打开导入面板预览（已自动填好）→ 检查后保存
      // 比原流程少 2-3 步；多张照片/电子书仍走「导入文章」完整面板
      if (busy) return;
      collectImport();
      busy = true; refreshMe();
      try {
        const file = await pickFile('image/*', true);
        if (!file) { busy = false; refreshMe(); return; }
        const dataUrl = await readAsDataURL(file);
        toast('正在识别照片正文…', 'info');
        const r = await ocrArticle(dataUrl, '');
        if (!r.text) throw new Error('没有识别到正文，请换一张更清晰的照片，或用「导入文章」多拍几张');
        importDraft.title = importDraft.title || r.title || '';
        importDraft.text = r.text;
        importDraft.source = r.source || { type: 'camera' };
        showImport = true;
        toast(`识别完成：${countWordsEn(r.text)} 词，检查无误后点保存`, 'success');
      } catch (err) { toast(`拍照识别失败：${err.message}`, 'error', 5000); }
      busy = false; refreshMe();
      return;
    }
    if (a === 'pickArticleCamera') {
      // 移动端直达相机的单张入口（capture 属性调起系统相机）
      collectImport();
      const file = await pickFile('image/*', true);
      if (!file) return;
      toast('正在压缩图片…', 'info');
      try {
        const dataUrl = await readAsDataURL(file);
        try { importDraft.photos.push({ dataUrl: await compressImage(dataUrl), name: `camera-${Date.now()}.jpg` }); }
        catch (_) { importDraft.photos.push({ dataUrl, name: `camera-${Date.now()}.jpg` }); }
      } catch (err) {
        toast(`读取照片失败：${err.message}`, 'error');
      }
      refreshMe();
      return;
    }
    if (a === 'goHistory') { go('history'); return; }
    if (a === 'hardItem') { openCoach(Number(btn.dataset.i)); return; }
    if (a === 'jumpSentence') { jumpToSentence(Number(btn.dataset.si)); return; }

    /* ----- 学习分区：词汇 / 长难句 / 阅读理解 / 精讲 ----- */
    if (a === 'studyTab') {
      studyTab = btn.dataset.tab || 'vocab';
      refreshKeep();
      if (window.innerWidth <= 900) {
        setTimeout(() => document.getElementById('studyPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 40);
      }
      return;
    }
    if (a === 'toggleCoreVocab') { showCore = !showCore; refreshKeep(); return; }
    if (a === 'vocabMore') { vocabShowAll = true; refreshKeep(); return; }
    if (a === 'learnVocab') { openVocabDrill(getArticle(currentId)); return; }
    if (a === 'addVocabWord') {
      const art = getArticle(currentId);
      if (!art) return;
      const v = matchArticleVocab(art.text);
      const w = [...v.core, ...v.extra][Number(btn.dataset.i)];
      if (!w) return;
      const r = addWords(articleVocabEntries([w], art.id));
      logActivity(dateKey(), { wordsAdded: r.added });
      toast(r.added ? `已加入「${w.term}」` : `「${w.term}」已在词库中`, 'success');
      return;
    }
    if (a === 'addAllVocab') {
      const art = getArticle(currentId);
      if (!art) return;
      const v = matchArticleVocab(art.text);
      const r = addWords(articleVocabEntries([...v.core, ...v.extra], art.id));
      logActivity(dateKey(), { wordsAdded: r.added });
      toast(`已加入词库：新增 ${r.added}，更新 ${r.updated}`, 'success');
      return;
    }
    if (a === 'genReading') {
      const art = getArticle(currentId);
      if (!art || reading.busy) return;
      reading.busy = true;
      reading.error = '';
      refreshKeep();
      try {
        const sents = flattenSentences(splitArticle(art.text)).map((text, index) => ({ index, text }));
        const questions = await generateReadingQuestions({ title: art.title, text: art.text, sentences: sents });
        patchArticle(art.id, {
          reading: { hash: articleHash(art.text), questions, at: new Date().toISOString() },
          readingResult: null
        });
        reading = { articleId: art.id, answers: {}, submitted: false, busy: false, error: '', score: null };
        toast('阅读理解已生成：4 题', 'success');
      } catch (err) {
        reading.busy = false;
        reading.error = `出题失败：${err.message}`;
        toast(reading.error, 'error', 5000);
      }
      reading.busy = false;
      refreshKeep();
      return;
    }
    if (a === 'rqPick') {
      if (reading.submitted) return;
      reading.answers[btn.dataset.q] = Number(btn.dataset.i);
      refreshKeep();
      return;
    }
    if (a === 'submitReading') {
      const art = getArticle(currentId);
      if (!art) return;
      const qs = (art.reading && art.reading.hash === articleHash(art.text) && art.reading.questions) || [];
      if (!qs.length) return;
      if (Object.keys(reading.answers).length < qs.length) { toast(`还有 ${qs.length - Object.keys(reading.answers).length} 题没选`, 'info'); return; }
      const correct = qs.filter((q) => Number(reading.answers[q.id]) === q.answer).length;
      const result = {
        hash: articleHash(art.text),
        answers: Object.assign({}, reading.answers),
        correct,
        total: qs.length,
        at: new Date().toISOString()
      };
      patchArticle(art.id, { readingResult: result });
      reading.submitted = true;
      reading.score = { correct, total: qs.length };
      logActivity(dateKey(), { questions: qs.length, correct });
      toast(`阅读理解：${correct} / ${qs.length} 正确`, correct === qs.length ? 'success' : 'info');
      refreshKeep();
      return;
    }
    if (a === 'retryReading') {
      reading.answers = {};
      reading.submitted = false;
      reading.score = null;
      refreshKeep();
      return;
    }
    if (a === 'backtrans') {
      const art = getArticle(currentId);
      const i = Number(btn.dataset.i);
      const s = art?.sentences?.[i];
      if (!s?.translation) { toast('这句还没有译文', 'info'); return; }
      const all = flattenSentences(splitArticle(art.text));
      openBacktrans({ sentence: all[i] || s.sentence || '', translation: s.translation, articleId: currentId, index: i });
      return;
    }
    if (a === 'coachBacktrans') {
      const c = coach;
      if (!c?.analysis?.translation) { toast('先看到完整讲解，才有中文译文', 'info'); return; }
      openBacktrans({ sentence: c.sentence, translation: c.analysis.translation, articleId: currentId, index: c.index });
      return;
    }
    if (a === 'redetectHard') { await ensureHardSentences(currentId, { force: true }); toast('已重新识别长难句', 'success'); return; }
    if (a === 'closeImport') { collectImport(); showImport = false; refreshMe(); return; }
    if (a === 'backList') {
      mode = 'list'; currentId = null; selectionText = ''; coach = null; activeIndex = -1; showUnknown = false;
      coverage = { articleId: null, hash: '', data: null, loading: false, error: '' };
      reading = { articleId: null, answers: {}, submitted: false, busy: false, error: '', score: null };
      refreshMe();
      return;
    }

    /* ----- 生词覆盖 ----- */
    if (a === 'toggleUnknown') { showUnknown = !showUnknown; refreshKeep(); return; }
    if (a === 'calcCoverage') { await ensureCoverage(getArticle(currentId), { force: true }); return; }
    if (a === 'addUnknown') {
      const data = currentCoverage(getArticle(currentId));
      const w = data?.unknownWords?.[Number(btn.dataset.i)];
      if (!w) return;
      const entry = unknownEntries({ unknownWords: [w] })[0];
      if (!entry) return;
      const r = addWords([entry]);
      logActivity(dateKey(), { wordsAdded: r.added });
      toast(r.added ? `已加入「${w.term}」` : `「${w.term}」已在词库中`, 'success');
      await ensureCoverage(getArticle(currentId), { force: true });
      return;
    }
    if (a === 'addAllUnknown') {
      const data = currentCoverage(getArticle(currentId));
      const entries = unknownEntries(data);
      if (!entries.length) { toast('没有可加入的生词', 'info'); return; }
      const r = addWords(entries);
      logActivity(dateKey(), { wordsAdded: r.added });
      toast(`已加入词库：新增 ${r.added}，更新 ${r.updated}`, 'success');
      await ensureCoverage(getArticle(currentId), { force: true });
      return;
    }
    if (a === 'quizUnknown') { quizFromUnknown(currentCoverage(getArticle(currentId))); return; }

    /* ----- 对话式精读 ----- */
    if (a === 'coachStart') {
      // 只清掉「上次讲解」的引导，直接进入自己翻的状态（不触发 AI）
      if (coach) { coach.cached = null; refreshKeep(); }
      return;
    }
    if (a === 'coachShowCached') {
      if (!coach?.cached) return;
      coach.analysis = coach.cached; coach.fromCache = true; refreshKeep(); return;
    }
    if (a === 'coachSend') {
      if (!coach) return;
      const el = view.querySelector('#coachInput');
      const text = (el?.value || coach.draft || '').trim();
      await runCoachTurn({ translation: text });
      return;
    }
    if (a === 'coachHint') { await runCoachTurn({ mode: 'hint' }); return; }
    if (a === 'coachReveal') { await runCoachTurn({ mode: 'reveal' }); return; }
    if (a === 'coachRestart') {
      if (!coach) return;
      coach = Object.assign({}, coach, {
        turns: [], attempts: 0, busy: false, analysis: null, fromCache: false, draft: '', error: ''
      });
      refreshKeep();
      return;
    }
    if (a === 'coachHard') {
      const text = btn.dataset.text || '';
      const art = getArticle(currentId);
      if (!art) return;
      const all = flattenSentences(splitArticle(art.text));
      const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      let idx = all.findIndex((s) => norm(s) === norm(text));
      if (idx < 0) idx = all.findIndex((s) => norm(s) && (norm(s).includes(norm(text)) || norm(text).includes(norm(s))));
      openCoach(idx >= 0 ? idx : -1, text);
      setTimeout(() => scrollCoachIntoView(true), 60);
      return;
    }

    if (a === 'pickTxt') {
      collectImport();
      const file = await pickFile('.txt,text/plain');
      if (!file) return;
      try {
        importDraft.text = await file.text();
        importDraft.title = importDraft.title || file.name.replace(/\.txt$/i, '');
        importDraft.fileName = file.name;
        refreshMe();
        toast('TXT 已载入，点击保存开始阅读', 'success');
      } catch (err) { toast(`读取失败：${err.message}`, 'error'); }
      return;
    }

    /* ----- 电子书导入 ----- */
    if (a === 'pickEbook') {
      if (ebookBusy) return;
      collectImport();
      const file = await pickFile(EBOOK_ACCEPT);
      if (!file) return;

      ebookBusy = true;
      ebookProgress = '正在读取文件…';
      refreshMe();
      try {
        const r = await parseEbookFile(file, {
          onProgress: (i, total) => {
            ebookProgress = `正在解析 PDF：第 ${i} / ${total} 页`;
            const el = document.querySelector('.file-drop .mt8');
            if (el) el.textContent = ebookProgress;
          }
        });

        if (r.empty) {
          importDraft.ebook = r;
          importDraft.ebookFile = file;
          importDraft.fileName = file.name;
          toast(r.needsOcr ? '这份 PDF 提取不到文字，可能是扫描件，请点「转图片 OCR」' : '文件里没有可提取的文字', 'error', 6000);
        } else {
          importDraft.ebook = r;
          importDraft.ebookFile = file;
          importDraft.text = r.text;
          importDraft.title = importDraft.title || r.title;
          importDraft.fileName = file.name;
          importDraft.source = {
            type: 'ebook',
            format: r.format,
            fileName: file.name,
            pages: r.pages || null,
            chapters: r.chapters || null
          };
          const label = FORMAT_LABELS[r.format] || r.format;
          toast(`${label} 解析完成：${countEbookWords(r.text)} 词${r.pages ? ` · ${r.pages} 页` : ''}${r.chapters ? ` · ${r.chapters} 章` : ''}`, 'success', 4000);
        }
      } catch (err) {
        toast(`解析失败：${err.message}`, 'error', 6000);
      } finally {
        ebookBusy = false;
        ebookProgress = '';
        refreshMe();
      }
      return;
    }

    if (a === 'clearEbook') {
      collectImport();
      importDraft.ebook = null;
      importDraft.ebookFile = null;
      importDraft.fileName = '';
      refreshMe();
      return;
    }

    if (a === 'ebookToOcr') {
      collectImport();
      const eb = importDraft.ebook;
      const file = importDraft.ebookFile;
      if (!eb || !file) { toast('请先选择 PDF 文件', 'error'); return; }
      ebookBusy = true;
      ebookProgress = '正在渲染页面…';
      refreshMe();
      try {
        const { images, totalPages, rendered } = await renderPdfToImages(file, { maxPages: 12 });
        if (!images.length) throw new Error('没有渲染出页面');
        importDraft.photos.push(...images);
        toast(`已渲染 ${rendered} / ${totalPages} 页，点「OCR 识别」继续`, 'success', 5000);
      } catch (err) {
        toast(`渲染失败：${err.message}`, 'error', 6000);
      } finally {
        ebookBusy = false;
        ebookProgress = '';
        refreshMe();
      }
      return;
    }

    if (a === 'pickArticlePhoto') {
      collectImport();
      const files = await pickFiles('image/*', true);
      if (!files.length) return;
      toast(`已选择 ${files.length} 张图片，正在压缩…`, 'info');
      const added = [];
      for (const file of files) {
        try { added.push({ dataUrl: await compressImage(await readAsDataURL(file)), name: file.name }); }
        catch (_) {}
      }
      importDraft.photos.push(...added);
      refreshMe();
      toast(`已添加 ${added.length} 张图片`, 'success');
      return;
    }

    if (a === 'removePhoto') {
      collectImport();
      importDraft.photos.splice(Number(btn.dataset.i), 1);
      refreshMe();
      return;
    }

    if (a === 'runArticleOcr') {
      collectImport();
      if (!importDraft.photos.length) return;
      busy = true; refreshMe();
      try {
        const urls = importDraft.photos.map((p) => p.dataUrl);
        const r = importDraft.photos.length > 1
          ? await ocrArticleMulti(urls, importDraft.hint)
          : await ocrArticle(urls[0], importDraft.hint);
        if (!r.text) throw new Error('没有识别到正文，请换一张更清晰的照片');
        importDraft.title = importDraft.title || r.title;
        importDraft.text = r.text;
        importDraft.source = r.source || { type: 'camera', fileName: importDraft.fileName, pages: importDraft.photos.length };
        toast(`识别完成：${countWordsEn(r.text)} 词${r.pages?.length ? ` · ${r.pages.length} 页` : ''}，可检查后保存`, 'success');
      } catch (err) { toast(`OCR 失败：${err.message}`, 'error', 5000); }
      busy = false; refreshMe();
      return;
    }

    if (a === 'savePaste') {
      collectImport();
      saveNewArticle({ title: importDraft.title, text: importDraft.text, source: importDraft.source || { type: 'paste' } });
      return;
    }

    if (a === 'deleteArticle') {
      const ok = await confirmDialog('删除文章', '将删除这篇文章及其所有句子讲解缓存，确定继续吗？', '删除');
      if (ok) { deleteArticle(currentId); mode = 'list'; currentId = null; toast('文章已删除', 'success'); refreshMe(); }
      return;
    }

    if (a === 'articleAnalysis') {
      const art = getArticle(currentId);
      // 全文分析缓存守卫：正文没变就直接用已有结果（与长难句的 hardHash 同思路）
      const hash = articleHash(art.text);
      if (art.analysis && art.analysisHash === hash) {
        toast('正文未变化，已直接使用缓存的分析结果；修改正文后可重新分析', 'info');
        return;
      }
      analysisBusy = true; refreshMe();
      try {
        // 把阅读器分句传给 AI 分析：AI 返回的重点词/长难句会逐条定位回原文（anchor）
        const sentences = flattenSentences(splitArticle(art.text)).map((text, index) => ({ index, text }));
        const an = await analyzeArticle(art.title, art.text, sentences);
        patchArticle(art.id, { analysis: an, analysisHash: hash });
        const stats = an.hardSentences.filter((x) => x.anchor?.anchored).length;
        toast(`全文分析已生成 · 难句定位 ${stats}/${an.hardSentences.length}`, 'success');
      } catch (err) { toast(`分析失败：${err.message}`, 'error', 5000); }
      analysisBusy = false; refreshMe();
      return;
    }

    if (a === 'explainSel' || a === 'translateSel') {
      if (!selectionText) return;
      const art = getArticle(currentId);
      const struct = splitArticle(art.text);
      const ctx = flattenSentences(struct).slice(0, 3).join(' ');
      if (a === 'translateSel') {
        toast('翻译中…', 'info');
        try {
          const v = await translateSelection(selectionText, ctx);
          await modal({ title: '划词翻译', body: `<div style="font-size:15px;line-height:1.8;white-space:pre-wrap">${esc(v)}</div>`,
            actions: [{ label: '关闭', value: null }] });
        } catch (err) { toast(`翻译失败：${err.message}`, 'error'); }
      } else {
        const text = selectionText;
        selectionText = '';
        openCoach(-1, text);
      }
      return;
    }

    if (a === 'vizModal') {
      if (!coach?.analysis) return;
      await openVizModal(coach.analysis, getArticle(currentId));
      return;
    }

    if (a === 'showSyntax') {
      const e = coach?.analysis;
      if (!e?.nlp?.preview) return;
      await modal({
        title: '本地 NLP 句法骨架',
        wide: true,
        body: `<div class="feedback" style="white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.7;max-height:60vh;overflow:auto">${esc(e.nlp.preview)}</div>
          <div class="tiny muted mt8">这段确定性句法分析由本地 spaCy 引擎生成，在 AI 讲解前先行计算并作为参考注入，用于校准主干、从句与语法判断。</div>`,
        actions: [{ label: '关闭', value: null }]
      });
      return;
    }

    if (a === 'addWordsToBook') {
      if (!coach?.analysis?.words?.length) return;
      const r = addWords(toWordEntries(coach.analysis.words, 'sentence'));
      logActivity(dateKey(), { wordsAdded: r.added });
      toast(`已加入词库：新增 ${r.added}，更新 ${r.updated}`, 'success');
      return;
    }

    if (a === 'addOneWord') {
      const w = coach?.analysis?.words?.[Number(btn.dataset.i)];
      if (!w) return;
      const r = addWords(toWordEntries([w], 'sentence'));
      toast(r.added ? `已加入「${w.term}」` : `「${w.term}」已更新`, 'success');
      return;
    }

    if (a === 'analysisWord') {
      const an = getArticle(currentId)?.analysis;
      const k = an?.keyWords?.[Number(btn.dataset.i)];
      if (!k) return;
      toast(`正在讲解「${k.term}」…`, 'info');
      try {
        const r = await explainWord(k.term, k.meaning);
        const v = await modal({
          title: `${r.term} ${r.phonetic || ''}`,
          wide: true,
          body: `<div class="lookup-result">
            <div class="row spread"><strong>${esc(r.term)}</strong><span class="pill">${esc(r.level || '高考')}</span></div>
            ${r.root ? `<div class="feedback mt8">${icon('info', 13)} ${esc(r.root)}</div>` : ''}
            ${r.meanings.map((m) => `<div class="def-item"><span class="def-pos">${esc(m.pos)}</span> ${esc(m.meaning)}
              ${m.example ? `<div class="def-ex">${esc(m.example)} — ${esc(m.translation || '')}</div>` : ''}</div>`).join('')}
            ${r.collocations?.length ? `<div class="tiny muted mt8">搭配：${r.collocations.map(esc).join(' · ')}</div>` : ''}
            ${r.usage ? `<div class="feedback mt8">${esc(r.usage)}</div>` : ''}
          </div>`,
          actions: [{ label: '关闭', value: null }, { label: '加入词库', cls: 'btn-primary', value: '__add__' }]
        });
        if (v === '__add__' || v === true) {
          const add = addWords(toWordEntries([{
            term: r.term, phonetic: r.phonetic, pos: r.pos || (r.meanings[0]?.pos || ''),
            meaning: r.meanings.map((m) => m.meaning).join('；'), example: r.meanings[0]?.example || ''
          }], 'analysis'));
          toast(add.added ? `已加入「${r.term}」` : '词库中已存在，已更新', 'success');
        }
      } catch (err) { toast(`讲解失败：${err.message}`, 'error'); }
      return;
    }
  });
}
