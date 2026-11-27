// AI 能力封装：拍照 OCR、出题、主观题批改、学习报告

import { getSettings, getState } from './store.js';
import { parseLooseJSON } from './ui.js';
import { isNative, apiCredentials, nativeAIRequest } from './bridge.js';
import { nlpSentence, nlpArticle, syntaxHint } from './nlp.js';
import { profilePrompt } from './profile.js';
import { anchorItems, matchItem, normalizeKey } from './anchor.js';
import { crossCheckAnalysis } from './nlpcross.js';

/** 取当前学习画像摘要；取不到时返回空串，不影响调用 */
function learnerContext() {
  try { return profilePrompt(getState()); } catch (_) { return ''; }
}

async function aiFetch(payload) {
  const s = getSettings();
  const headers = { 'Content-Type': 'application/json' };

  // APK 内：走原生 HTTP 直连网关（绕过 WebView CORS）
  if (isNative()) {
    const { apiBase, apiKey } = apiCredentials(s);
    const raw = await nativeAIRequest({
      url: `${apiBase}/chat/completions`,
      apiKey,
      method: 'POST',
      body: JSON.stringify(payload),
      timeout: 240000
    });
    const data = parseLooseJSON(raw.body || '{}') || {};
    if (raw.status < 200 || raw.status >= 300) {
      const err = data?.error;
      throw new Error(typeof err === 'string' ? err : (err?.message || `HTTP ${raw.status}`));
    }
    return data;
  }

  // 浏览器：沿用本地服务端代理
  if (s.apiMode === 'custom') {
    if (s.customApiKey) headers['x-api-key'] = s.customApiKey;
    if (s.customApiBase) headers['x-api-base'] = s.customApiBase;
  }
  let res;
  try {
    res = await fetch('/api/ai', { method: 'POST', headers, body: JSON.stringify(payload) });
  } catch (e) {
    throw new Error('无法连接本地服务，请确认应用服务已启动');
  }
  const data = await res.json().catch(() => ({ error: { message: '响应解析失败' } }));
  if (!res.ok) {
    const err = data?.error;
    throw new Error(typeof err === 'string' ? err : (err?.message || `HTTP ${res.status}`));
  }
  return data;
}

export async function chat(messages, options = {}) {
  const s = getSettings();
  const primary = options.model || s.textModel;
  const candidates = [primary, ...(options.fallbacks || []).filter((m) => m && m !== primary)];
  let lastError;
  for (let i = 0; i < candidates.length; i++) {
    const model = candidates[i];
    try {
      const data = await aiFetch({
        model,
        messages,
        temperature: options.temperature ?? 0.2,
        max_tokens: options.max_tokens || 2048,
        ...(options.json ? { response_format: { type: 'json_object' } } : {}),
        ...(options.reasoningEffort ? { reasoning_effort: options.reasoningEffort } : {})
      });
      return data.choices?.[0]?.message?.content || '';
    } catch (err) {
      lastError = err;
      // 429/容量不足/5xx/超时，以及模型不存在（404、model not found）都换下一个模型重试
      const retryable = /429|rate_limit|capacity|40[034]|50[0234]|timeout|abort|not\s*found|model[^]{0,20}not|unsupported|overloaded/i.test(err.message || '');
      if (!retryable || i === candidates.length - 1) throw err;
      await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw lastError;
}

/**
 * 请求并解析严格 JSON；解析失败时把问题反馈给模型重试一次（自愈）。
 * 原先 malformed JSON 会直接导致整个功能失败，现在只有两次都失败才抛错。
 */
export async function chatJson(messages, options = {}) {
  const first = await chat(messages, options);
  try { return parseLooseJSON(first); } catch (_) { /* 进入重试 */ }
  const retry = await chat([
    ...messages,
    { role: 'user', content: '你上一次的输出无法解析为 JSON。请重新输出：只输出一个合法的 JSON 对象，不要 Markdown 代码块、不要解释、不要任何前后缀文字。' }
  ], options);
  return parseLooseJSON(retry);
}

// 主用模型不可用时按顺序回退；前两个是当前网关上的主力模型（Hy4-flash / MiniCPM-V-4.7-35B-A3B）
const TEXT_FALLBACKS = ['MiniCPM-V-4.7-35B-A3B', 'Hy4-flash', 'Qwen3.8-27B', 'GLM-5.3-Flash', 'MiMo-V2.6-Flash', 'MiniCPM5-2B'];
const VISION_FALLBACKS = ['Hy4-flash', 'MiniCPM-V-4.7-35B-A3B', 'Gemma-4-31B-IT', 'Qwen3.8-27B', 'MiMo-V2.6-Flash'];

export async function testConnection() {
  const text = await chat([{ role: 'user', content: '只回复 OK 两个字母。' }], { fallbacks: TEXT_FALLBACKS, max_tokens: 200, temperature: 0, reasoningEffort: 'none' });
  return text.trim().slice(0, 40);
}

export async function listModels() {
  const s = getSettings();
  if (isNative()) {
    const { apiBase, apiKey } = apiCredentials(s);
    const raw = await nativeAIRequest({ url: `${apiBase}/models`, apiKey, method: 'GET', timeout: 30000 });
    const data = parseLooseJSON(raw.body || '{}') || {};
    if (raw.status < 200 || raw.status >= 300) throw new Error(data?.error?.message || `HTTP ${raw.status}`);
    return (data.data || []).map((m) => ({
      id: m.id,
      vision: !!(m.architecture?.input_modalities || []).includes('image'),
      json: !!m.json_output,
      context: m.context_length || 0
    }));
  }
  const headers = {};
  if (s.apiMode === 'custom') {
    if (s.customApiKey) headers['x-api-key'] = s.customApiKey;
    if (s.customApiBase) headers['x-api-base'] = s.customApiBase;
  }
  const res = await fetch('/api/models', { headers });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || '模型列表获取失败');
  return (data.data || []).map((m) => ({
    id: m.id,
    vision: !!(m.architecture?.input_modalities || []).includes('image'),
    json: !!m.json_output,
    context: m.context_length || 0
  }));
}

export function compressImage(src, maxSide = 1600, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      const scale = Math.min(1, maxSide / Math.max(width, height));
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      try { resolve(canvas.toDataURL('image/jpeg', quality)); } catch (_) { resolve(src); }
    };
    img.onerror = () => resolve(src);
    img.src = src;
  });
}

const OCR_SYSTEM = `你是英语学习资料的结构化识别助手。用户会提供一张单词书、学案、课本或练习册的照片。
请从图片中提取所有英语单词、短语、搭配和例句，输出严格 JSON：
{
  "items": [
    {
      "term": "英语单词或短语，保留原文拼写",
      "phonetic": "音标；没有则空字符串",
      "pos": "词性缩写，如 n. / v. / adj.；没有则空字符串",
      "meaning": "简洁中文释义；不确定则空字符串",
      "example": "图片中出现的原句；没有则空字符串",
      "exampleTranslation": "例句的中文翻译；没有则空字符串"
    }
  ]
}
规则：
1. 只输出 JSON 对象，不要 Markdown 代码块、解释或前后缀。
2. 逐条对应图片内容，不要编造图片中不存在的词条；模糊处做合理纠正。
3. 若图片主体是句子，请把句子放进 example，并提取句中重点词/短语作为 term。
4. 最多 60 条。每条 term 必须非空。`;

export async function ocrImage(dataUrl, hint = '') {
  const s = getSettings();
  const parsed = await chatJson([
    { role: 'system', content: OCR_SYSTEM },
    {
      role: 'user',
      content: [
        { type: 'text', text: `请识别这张${hint || '英语学习资料'}照片并提取词条。${hint ? `补充信息：${hint}` : ''}` },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }
  ], { model: s.visionModel, fallbacks: VISION_FALLBACKS, json: true, max_tokens: 4000, temperature: 0.05, reasoningEffort: 'none' });
  const items = Array.isArray(parsed) ? parsed : (parsed.items || parsed.words || []);
  return items.filter((x) => x && String(x.term || '').trim()).slice(0, 60);
}

export async function ocrText(rawText) {
  const parsed = await chatJson([
    { role: 'system', content: OCR_SYSTEM },
    { role: 'user', content: `请从以下文本中提取词条：\n\n${rawText.slice(0, 12000)}` }
  ], { fallbacks: TEXT_FALLBACKS, json: true, max_tokens: 4000, temperature: 0.05, reasoningEffort: 'none' });
  const items = Array.isArray(parsed) ? parsed : (parsed.items || parsed.words || []);
  return items.filter((x) => x && String(x.term || '').trim()).slice(0, 60);
}

const QUIZ_SYSTEM = `你是一位英语词汇测评出题专家。根据给定的「今日复习词表」生成一份小试卷，输出严格 JSON：
{
  "passage": {
    "title": "英文短文标题",
    "text": "120-180 个英文单词的小短文，自然嵌入尽可能多的给定单词",
    "translation": "短文的中文翻译"
  },
  "questions": [
    {
      "id": "q1",
      "type": "meaning | usage | fill | spell | translation | reading",
      "prompt": "题面文本",
      "options": ["选项A", "选项B", "选项C", "选项D"],
      "answer": "正确答案文本",
      "wordIds": ["词表中的词 id"],
      "explain": "简短中文解析"
    }
  ]
}
题型说明：
- meaning：给英文单词选中文释义（4 选 1，options 必填）
- usage：给一个英文句子挖空，选合适的词（4 选 1，options 必填）
- fill：给中文提示与英文句子空格，用户输入单词（answer 为单个词；可写 "word1|word2" 表示多个可接受答案）
- spell：给中文释义和首字母，拼写完整单词（answer 为完整单词）
- translation：给中文句子要求译成英文（主观题，答案写参考译文）
- reading：基于 passage 的阅读理解（4 选 1，options 必填）

规则：
1. 只输出 JSON 对象，无 Markdown 代码块和解释。
2. 题目数量必须等于要求数量；题型尽量混合，至少包含 1 道 translation 和 1 道 reading。
3. 优先覆盖词表中 level 低、错误率高的词；每个 question 的 wordIds 只能使用给定 id。
4. 选择题的 answer 必须是 options 中的完整文本（不要只写 A/B/C/D）。
5. 同一词不要重复出同一题型；题面清晰、适合中学生水平。
6. 不要输出 id 以外的任何自定义字段。`;

export async function generateQuiz({ words, count = 10, focus = '' }) {
  const s = getSettings();
  const brief = words.slice(0, 40).map((w) => ({
    id: w.id,
    term: w.term,
    meaning: w.meaning,
    phonetic: w.phonetic || '',
    example: (w.example || '').slice(0, 160)
  }));
  if (!brief.length) throw new Error('词库为空，请先导入单词');
  const parsed = await chatJson([
    { role: 'system', content: QUIZ_SYSTEM },
    {
      role: 'user',
      content: `请生成 ${count} 道题的今日试卷。\n${focus ? `侧重点：${focus}\n` : ''}词表（JSON）：\n${JSON.stringify(brief)}`
    }
  ], { model: s.textModel, fallbacks: TEXT_FALLBACKS, json: true, max_tokens: 6000, temperature: 0.45, reasoningEffort: 'none' });
  if (!parsed || !Array.isArray(parsed.questions)) throw new Error('AI 未返回有效试卷，请重试');
  return {
    passage: parsed.passage || { title: '', text: '', translation: '' },
    questions: parsed.questions.slice(0, count).map((q, i) => ({
      id: String(q.id || `q${i + 1}`),
      type: ['meaning', 'usage', 'fill', 'spell', 'translation', 'reading'].includes(q.type) ? q.type : 'meaning',
      prompt: String(q.prompt || ''),
      options: Array.isArray(q.options) ? q.options.map(String) : [],
      answer: String(q.answer ?? ''),
      wordIds: Array.isArray(q.wordIds) ? q.wordIds.filter((id) => brief.some((b) => b.id === id)) : [],
      explain: String(q.explain || '')
    }))
  };
}

const GRADE_SYSTEM = `你是严谨而宽松的英语老师。批改学生对单词与句子的作答，输出严格 JSON：
{
  "results": [
    { "id": "q1", "score": 85, "correct": true, "feedback": "简短中文点评", "modelAnswer": "参考答案" }
  ]
}
规则：
1. score 为 0-100 整数；correct 为 score >= 60。
2. 意思表达正确、语法基本通顺即给高分；拼写/大小写小错扣 10-20 分；完全无关给 0。
3. feedback 一句话中文点评，指出关键问题或肯定优点。
4. 只输出 JSON 对象，不要 Markdown。`;

export async function gradeSubjective(items) {
  if (!items.length) return {};
  const s = getSettings();
  const parsed = await chatJson([
    { role: 'system', content: GRADE_SYSTEM },
    { role: 'user', content: `待批改作答（JSON）：\n${JSON.stringify(items)}` }
  ], { model: s.gradingModel, fallbacks: TEXT_FALLBACKS, json: true, max_tokens: 3000, temperature: 0.1, reasoningEffort: 'none' });
  const list = Array.isArray(parsed) ? parsed : (parsed.results || []);
  const map = {};
  list.forEach((r) => { if (r && r.id) map[String(r.id)] = r; });
  return map;
}

export async function generateAdvice(stats) {
  const text = await chat([
    { role: 'system', content: '你是耐心的英语学习教练。根据统计数据给出中文学习建议，使用简短 Markdown（小标题 + 要点），不超过 500 字，语气鼓励、具体可执行。' },
    { role: 'user', content: `学习统计：\n${JSON.stringify(stats)}` }
  ], { fallbacks: TEXT_FALLBACKS, max_tokens: 1200, temperature: 0.5, reasoningEffort: 'none' });
  return text.trim();
}

export async function generateReport(stats) {
  const text = await chat([
    {
      role: 'system',
      content: '你是学习数据分析师。根据用户的英语单词学习数据写出中文分析报告，Markdown 格式，包含：一、整体概览；二、掌握情况；三、薄弱点诊断；四、下阶段计划。数据要具体引用，不少于 400 字，不超过 1200 字。'
    },
    { role: 'user', content: JSON.stringify(stats) }
  ], { fallbacks: TEXT_FALLBACKS, max_tokens: 2400, temperature: 0.4, reasoningEffort: 'none' });
  return text.trim();
}

/**
 * 口语评测的 AI 点评：基于本机语音服务给出的评分、词级结果与韵律指标。
 * 只允许复述已有信息，不编造未提供的音素错误。
 */
export async function coachSpeaking({ reference, transcript, scores, metrics, words = [], warnings = [] }) {
  const missed = words.filter((w) => w.status === 'miss').map((w) => w.text).slice(0, 8);
  const weak = words.filter((w) => w.status === 'weak').map((w) => w.text).slice(0, 8);
  const data = {
    目标句: reference,
    识别转写: transcript,
    评分: scores,
    韵律: metrics,
    漏读词: missed,
    置信度偏低词: weak,
    系统提示: warnings
  };
  const text = await chat([
    {
      role: 'system',
      content: '你是英语口语教练。根据系统提供的评分、转写和韵律数据，用中文给出 2-3 条具体可执行的改进建议，总字数不超过 160 字。直接输出正文，不要 Markdown 标题或列表符号。只能引用数据中出现的词和指标，不要编造音素发音错误；若发音分为代理值，要提醒用户这是趋势参考。'
    },
    { role: 'user', content: JSON.stringify(data, null, 2) }
  ], { fallbacks: TEXT_FALLBACKS, max_tokens: 800, temperature: 0.4, reasoningEffort: 'none' });
  return text.trim();
}

/* ============================================================
   阅读器能力：文章导入 / 全文分析 / 句子讲解 / 单词深度解析
   ============================================================ */

/** 从文章照片 OCR 出完整英文文本（保留段落），而非词条 */
export async function ocrArticle(dataUrl, hint = '') {
  const s = getSettings();
  const parsed = await chatJson([
    {
      role: 'system',
      content: `你是英文文章 OCR 助手。从照片中完整转录英文文章正文，输出严格 JSON：
{
  "title": "文章标题（没有则根据内容拟一个简短标题）",
  "text": "完整正文，保留段落（用 \\n\\n 分隔），保留原有标点和拼写",
  "source": "图片中可见的出处信息，没有则空字符串"
}
规则：
1. 只输出 JSON，不要 Markdown。
2. 逐字转录，不要翻译、不要摘要、不要改写；模糊的单词按上下文合理纠正。
3. 排除页眉页脚、题号、水印等非正文内容。`
    },
    {
      role: 'user',
      content: [
        { type: 'text', text: `请完整转录这张文章照片的正文。${hint ? `补充：${hint}` : ''}` },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }
  ], { model: s.visionModel, fallbacks: VISION_FALLBACKS, json: true, max_tokens: 5000, temperature: 0.05, reasoningEffort: 'none' });
  return {
    title: String(parsed.title || '').trim(),
    text: String(parsed.text || '').trim(),
    source: String(parsed.source || '').trim()
  };
}

/**
 * 多图 OCR：把多张文章照片一次性送入视觉模型，按页识别后拼接成完整正文。
 * @param {string[]} dataUrls 多张图片的 dataURL
 * @param {string} hint 补充说明
 */
export async function ocrArticleMulti(dataUrls, hint = '') {
  const s = getSettings();
  const images = (dataUrls || []).filter(Boolean);
  if (!images.length) throw new Error('没有可识别的图片');
  const content = [
    { type: 'text', text: `请按图片顺序（第1张、第2张…）完整转录这些文章照片的正文，输出严格 JSON：
{
  "title": "文章标题（没有则根据内容拟定）",
  "pages": [ { "page": 1, "text": "该页完整正文，保留段落，用 \\n\\n 分隔" } ],
  "text": "按页顺序拼接后的完整正文",
  "source": "图片中可见的出处信息，没有则空字符串"
}
规则：
1. 只输出 JSON，不要 Markdown。
2. 逐字转录，不翻译不摘要不改写；跨页处自然衔接，不要重复或遗漏段落。
3. 排除页眉页脚、题号、水印等非正文内容。
${hint ? `补充：${hint}` : ''}` },
    ...images.map((url, i) => ({ type: 'text', text: `【第 ${i + 1} 张图片】` })),
    ...images.map((url) => ({ type: 'image_url', image_url: { url } }))
  ];
  const parsed = await chatJson([
    { role: 'system', content: '你是英文文章 OCR 助手，按图片顺序转录正文，输出严格 JSON。' },
    { role: 'user', content }
  ], { model: s.visionModel, fallbacks: VISION_FALLBACKS, json: true, max_tokens: 8000, temperature: 0.05, reasoningEffort: 'none' });
  const pages = Array.isArray(parsed.pages)
    ? parsed.pages.map((p) => String(p.text || '').trim()).filter(Boolean) : [];
  const merged = String(parsed.text || '').trim() || pages.join('\n\n');
  return {
    title: String(parsed.title || '').trim(),
    text: merged,
    pages,
    source: String(parsed.source || '').trim()
  };
}

/**
 * 全文阅读分析：概览 / 结构 / 重点词汇 / 难句 / 写作亮点。
 * @param {string} title 文章标题
 * @param {string} text 正文
 * @param {{index:number,text:string}[]|null} sentences 阅读器分句结果（带全文序号）；
 *        提供后对 AI 返回的 keyWords/hardSentences 逐条做「定位回原文」锚定，
 *        未在原文中命中的条目标 anchor.anchored=false，由 UI 诚实呈现。
 */
export async function analyzeArticle(title, text, sentences = null) {
  const s = getSettings();
  // 先做全文句法概览，作为 LLM 分析的参考骨架
  const nlpResult = await nlpArticle(text, 80);
  const hint = nlpResult ? syntaxHint(nlpResult) : '';
  const p = await chatJson([
    {
      role: 'system',
      content: `你是资深英语阅读教师。针对给定英文文章做深度阅读分析，输出严格 JSON：
{
  "summary": "80-150 字中文内容概要",
  "theme": "文章主旨与作者态度，一句话点明",
  "level": "难度评级：高中 / 大学 / Above",
  "wordCount": 数字,
  "structure": [ { "part": "第1段 / 第2-3段 ...", "gist": "该部分中文大意", "role": "在全文中的作用（引出/论证/转折/总结等）" } ],
  "keyWords": [ { "term": "文中重点单词或短语（原文形式）", "meaning": "结合本文语境的中文释义", "reason": "为什么重要（高频/主题词/熟词生义等，一句话）" } ],
  "hardSentences": [ { "text": "原文中的长难句", "reason": "难在哪里（从句嵌套/非谓语/倒装等，一句话）" } ],
  "highlights": [ "写作亮点或值得学习的表达，中文说明" ],
  "quiz": [ { "q": "中文理解的思考题", "a": "参考答案要点" } ]
}
规则：
1. 只输出 JSON，不要 Markdown。
2. keyWords 取 8-15 个，hardSentences 取 2-5 句，highlights 取 3-5 条，quiz 取 2-4 题。
3. 所有引号内容必须是中文说明或原文摘录，不要杜撰原文没有的句子。
${learnerContext() ? `4. 学生画像如下，分析难度与词汇取舍要贴合他的水平：\n${learnerContext()}` : ''}
${hint}`
    },
    { role: 'user', content: `标题：${title || '(无标题)'}\n\n正文：\n${String(text).slice(0, 15000)}` }
  ], { model: s.textModel, fallbacks: TEXT_FALLBACKS, json: true, max_tokens: 6000, temperature: 0.35, reasoningEffort: 'none' });
  const sents = Array.isArray(sentences) && sentences.length ? sentences : null;
  return {
    summary: String(p.summary || ''), theme: String(p.theme || ''),
    level: String(p.level || '高中'), wordCount: Number(p.wordCount) || countWords(text),
    structure: Array.isArray(p.structure) ? p.structure : [],
    keyWords: anchorItems(Array.isArray(p.keyWords) ? p.keyWords.filter((x) => x && x.term) : [], sents || []),
    hardSentences: anchorItems(Array.isArray(p.hardSentences) ? p.hardSentences.filter((x) => x && x.text) : [], sents || []),
    highlights: Array.isArray(p.highlights) ? p.highlights.map(String) : [],
    quiz: Array.isArray(p.quiz) ? p.quiz : [],
    anchored: !!sents,
    nlp: nlpResult ? { engine: nlpResult.engine, totalSentences: nlpResult.totalSentences, analyzed: nlpResult.analyzed } : null,
    analyzedAt: new Date().toISOString()
  };
}

/* ============================================================
   阅读理解：4 道单选题（1 道主旨 + 3 道细节/推理/词义/态度）
   ============================================================ */

const READING_SYSTEM = `你是北京高考英语阅读命题人。根据给定英文文章出一套 4 道单选题，难度对标北京卷 C/D 篇，输出严格 JSON：
{
  "questions": [
    {
      "id": "r1",
      "type": "main | detail | inference | attitude | vocab",
      "stem": "英文题干",
      "options": ["英文选项 A", "英文选项 B", "英文选项 C", "英文选项 D"],
      "answer": 0,
      "explain": "中文解析：为什么正确项对，其余三项错在哪",
      "evidence": "原文中支撑答案的那一句，逐字摘录"
    }
  ]
}
规则：
1. 必须正好 4 题。第 1 题固定为 main（主旨大意 / 最佳标题 / 作者写作目的三选一），后 3 题从 detail、inference、attitude、vocab 中选，且至少包含 1 道推理判断、1 道词义猜测或作者态度。
2. 难度对标北京卷 C/D 篇：题干需要理解句间逻辑与作者言外之意，不能靠关键词直接定位答案。
3. 干扰项必须基于原文信息设置（张冠李戴、过度推断、以偏概全、偷换程度），不要出现明显荒谬的选项，不要使用 All of the above / None of the above。
4. 题干与选项全部用英文；正确选项要改写原文，不能整句照抄。四个选项长度尽量接近。
5. evidence 必须是原文中真实出现的一句（或完整分句），不得改写、不得杜撰；explain 用中文，每条不超过 80 字。
6. answer 用 0-3 的整数表示正确选项下标。
7. 只输出 JSON 对象，不要 Markdown 代码块，不要解释。`;

/**
 * 生成本文的阅读理解题（4 题，含 1 道主旨题）。
 * @param {object} opts
 * @param {string} opts.title 标题
 * @param {string} opts.text 正文
 * @param {{index:number,text:string}[]} [opts.sentences] 阅读器分句，用于把 evidence 定位回原文
 */
export async function generateReadingQuestions({ title, text, sentences = [] }) {
  const s = getSettings();
  const p = await chatJson([
    { role: 'system', content: READING_SYSTEM },
    { role: 'user', content: `标题：${title || '(无标题)'}\n\n正文：\n${String(text).slice(0, 12000)}` }
  ], { model: s.textModel, fallbacks: TEXT_FALLBACKS, json: true, max_tokens: 4000, temperature: 0.4, reasoningEffort: 'none' });

  const raw = Array.isArray(p) ? p : (Array.isArray(p.questions) ? p.questions : []);
  const TYPES = ['main', 'detail', 'inference', 'attitude', 'vocab'];
  const sents = Array.isArray(sentences) ? sentences : [];
  const questions = raw.map((q, i) => {
    if (!q || !String(q.stem || '').trim()) return null;
    const options = (Array.isArray(q.options) ? q.options : []).map(String).filter((x) => x.trim()).slice(0, 4);
    if (options.length < 4) return null;
    let idx = Number(q.answer);
    if (!Number.isInteger(idx) || idx < 0 || idx > 3) {
      const a = String(q.answer == null ? '' : q.answer).trim();
      if (/^[A-Da-d]$/.test(a)) idx = 'ABCD'.indexOf(a.toUpperCase());
      else idx = options.findIndex((o) => normalizeKey(o) === normalizeKey(a));
    }
    if (!Number.isInteger(idx) || idx < 0 || idx > 3) return null;
    const evidence = String(q.evidence || '').trim();
    return {
      id: String(q.id || `r${i + 1}`),
      type: TYPES.includes(q.type) ? q.type : 'detail',
      stem: String(q.stem).trim(),
      options,
      answer: idx,
      explain: String(q.explain || '').trim(),
      evidence,
      anchor: evidence && sents.length ? matchItem(evidence, sents) : { anchored: false, matchType: null, sentenceIndex: null }
    };
  }).filter(Boolean).slice(0, 4);

  if (questions.length < 4) throw new Error('AI 返回的题目不完整，请重试一次');
  if (!questions.some((q) => q.type === 'main')) questions[0].type = 'main';
  return questions;
}

/* ============================================================
   对话式精读：先让学生自己翻，再逐步给提示，最后才给完整讲解
   ============================================================ */

const COACH_SYSTEM = `你是一位很有耐心的英语精读老师，正在和一个中国学生一起读一个英文长难句。你的任务不是"给答案"，而是"带他自己读出来"。

教学原则（严格遵守）：
1. 学生还没交出译文时，只做引导：可以说这句话大概有几层结构、有几处从句、哪个词容易理解错、先找什么成分。**绝对不要给出整句中文译文，也不要逐段讲解。**
2. 学生交出译文后，先具体肯定他理解对的部分（引用他的说法，例如"你把 … 处理成 … 是对的"），再只点出**最关键的一处**偏差或遗漏，然后给一个能推他一把的小提示或追问，让他自己改。不要一次把所有问题都倒出来。
3. 只有当学生理解已经基本正确（整句意思没跑偏，只是措辞不地道），或学生明确要求直接看讲解时，才输出完整分析。
4. 语气像面对面辅导：简短、具体、不说空话，不用"很棒""非常好"这类空泛表扬，不用 Markdown，不用 emoji。
5. 全程中文（英文原句和单词除外）。

每一轮只输出一个 JSON 对象，不要 Markdown 代码块：
{
  "stage": "guide | ask | analysis",
  "reply": "你要对学生说的话，1-3 句，口语化中文。stage 为 analysis 时这里写一句总评。",
  "verdict": "none | off | partial | close",
  "score": 0,
  "focus": ["本轮请他注意的点，1-3 个短语"],
  "question": "让他再试一次的具体追问，一句话；不需要追问时为空字符串",
  "analysis": null
}

字段规则：
- stage：学生还没作答 → guide；译文偏差较大或只对一半 → ask；可以给完整讲解 → analysis（此时 verdict 为 close）。
- **进入 analysis 的门槛不要设得太高**：只要学生把整句意思说对了（score ≥ 70，个别措辞不地道不算错），就进入 analysis，别为了多教一轮而扣着不给。
- 最多追问两轮：学生已经改过两次稿（【已尝试】≥ 2），即使还有小毛病，也进入 analysis，把剩下的问题放进 grammar 或 tip 里讲清楚，不要再要求第三次。
- score：0-100，学生对整句意思的理解程度；没作答给 0。
- stage 为 analysis 时，analysis 必须是对象（其余情况为 null）：
  {
    "translation": "准确通顺的中文译文",
    "structure": "主干结构一句话，如：主语 + 谓语 + that 宾语从句",
    "breakdown": [{ "part": "原文片段", "role": "该成分的语法作用（中文）" }],
    "grammar": [{ "point": "语法点名称", "explain": "结合本句的中文讲解" }],
    "words": [{ "term": "重点词或短语", "phonetic": "音标或空", "pos": "词性或空", "meaning": "本句中的中文释义", "example": "原句中的用法片段", "level": "核心/进阶/拓展" }],
    "tip": "一句学习提示"
  }
  breakdown 3-6 项，grammar 1-3 项，words 2-6 个。
- 学生说"给点提示"时，给一个更具体但仍不揭晓译文的提示（例如：先找出谓语动词 / 先分清主句和从句 / 注意 that 指代什么）。
- 严禁出现"这句话的意思是……""整句翻译为……"这类完整译文，除非 stage 为 analysis。`;

function normalizeAnalysis(p, sentence, nlpResult) {
  if (!p || typeof p !== 'object' || !String(p.translation || '').trim()) return null;
  const out = {
    translation: String(p.translation || ''),
    structure: String(p.structure || ''),
    breakdown: Array.isArray(p.breakdown) ? p.breakdown : [],
    grammar: Array.isArray(p.grammar) ? p.grammar : [],
    words: Array.isArray(p.words) ? p.words.filter((x) => x && x.term).map((x) => ({
      term: String(x.term).trim(), phonetic: String(x.phonetic || ''), pos: String(x.pos || ''),
      meaning: String(x.meaning || ''), example: String(x.example || ''),
      level: ['核心', '进阶', '拓展'].includes(x.level) ? x.level : '核心'
    })) : [],
    tip: String(p.tip || ''),
    sentence: String(sentence || ''),
    nlp: nlpResult ? {
      engine: nlpResult.engine,
      stats: nlpResult.stats,
      preview: nlpResult.preview,
      tokens: nlpResult.tokens,
      tree: nlpResult.tree
    } : null,
    explainedAt: new Date().toISOString()
  };
  // AI↔NLP 交叉校验：README「不一致时以句法结果为准」的代码级落点——
  // 冲突不改写 AI 文本，由 UI 并排展示并标明采信 NLP
  out.consistency = crossCheckAnalysis(out, nlpResult);
  return out;
}

/**
 * 对话式精读的一轮。
 * @param {object} opts
 * @param {string} opts.sentence 原句
 * @param {string} [opts.context] 上下文
 * @param {Array<{role:'me'|'coach',text:string}>} [opts.transcript] 已有对话
 * @param {string} [opts.translation] 本轮学生译文
 * @param {'open'|'hint'|'answer'|'reveal'} [opts.mode] 本轮类型
 * @param {number} [opts.attempt] 学生已尝试次数
 * @param {any} [opts.nlp] 本地句法结果（用于最终讲解校准）
 */
export async function coachSentence({ sentence, context = '', transcript = [], translation = '', mode = 'answer', attempt = 0, nlp = null }) {
  const s = getSettings();

  // 只在真正要给讲解时，把完整句法骨架注入；引导阶段只给统计，避免模型顺手把答案抖出来
  let nlpPart = '';
  const st = nlp?.stats;
  if (st) {
    nlpPart = `\n\n【本地句法统计】句型：${st.sentenceType || '—'}；从句 ${st.clauses || 0} 处；复杂度：${st.complexity || '—'}。`;
  }
  const fullHint = (mode === 'reveal' || attempt >= 2) && nlp ? '\n\n' + syntaxHint(nlp) : '';

  const lines = [];
  const rows = (transcript || []).filter((t) => t && t.text);
  if (rows.length) {
    lines.push('【已有对话】');
    rows.forEach((t) => lines.push(`${t.role === 'me' ? '学生' : '老师'}：${String(t.text).slice(0, 600)}`));
  }

  let thisTurn = '';
  if (mode === 'open') thisTurn = '学生还没有作答，这是第一次看到这个句子。请做开场引导，让他先自己翻。';
  else if (mode === 'hint') thisTurn = '学生请求"给点提示"，仍然不要说出译文，只给一个更具体的抓手。';
  else if (mode === 'reveal') thisTurn = '学生要求直接看完整讲解，请给出 stage=analysis 的完整分析，并在 reply 里用一句话点出这句最值得学的地方。';
  else thisTurn = `学生提交的译文：${String(translation).slice(0, 800)}`;

  const user = [
    `【原句】${sentence}`,
    context ? `【上下文】${String(context).slice(0, 1200)}` : '',
    learnerContext(),
    lines.join('\n'),
    nlpPart,
    `【本轮】${thisTurn}`,
    `【已尝试】${attempt} 次`
  ].filter(Boolean).join('\n\n');

  const out = await chat([
    { role: 'system', content: COACH_SYSTEM + fullHint },
    { role: 'user', content: user }
  ], { model: s.textModel, fallbacks: TEXT_FALLBACKS, json: true, max_tokens: 3200, temperature: 0.35, reasoningEffort: 'none' });

  const p = parseLooseJSON(out) || {};
  const stage = ['guide', 'ask', 'analysis'].includes(p.stage) ? p.stage : (mode === 'reveal' ? 'analysis' : 'ask');
  const score = Math.max(0, Math.min(100, Number(p.score) || 0));
  const analysis = stage === 'analysis' ? normalizeAnalysis(p.analysis, sentence, nlp) : null;

  // 模型说该给讲解了，却没吐出结构化分析：补一次「直接讲解」的请求，避免学生卡在空面板
  if (stage === 'analysis' && !analysis && mode !== 'reveal') {
    return coachSentence({ sentence, context, transcript, translation, mode: 'reveal', attempt, nlp });
  }

  return {
    stage,
    reply: String(p.reply || '').trim() || '先自己翻一遍，说说你卡在哪一处，我来帮你看。',
    verdict: ['none', 'off', 'partial', 'close'].includes(p.verdict) ? p.verdict : 'none',
    score,
    focus: Array.isArray(p.focus) ? p.focus.map(String).filter(Boolean).slice(0, 3) : [],
    question: String(p.question || '').trim(),
    analysis
  };
}

/** 单词深度解析：释义 / 词根词缀 / 搭配 / 例句 / 辨析（用于速查页 AI 补充） */
export async function explainWord(term, context = '') {
  const s = getSettings();
  // 若提供了英文语境，先分析句子结构，供 LLM 参考词义（中文释义不送 NLP）
  let hint = '';
  let nlpResult = null;
  const enWords = String(context || '').match(/[A-Za-z]+/g) || [];
  if (enWords.length >= 4) {
    nlpResult = await nlpSentence(context.slice(0, 500));
    hint = syntaxHint(nlpResult);
  }
  const p = await chatJson([
    {
      role: 'system',
      content: `你是英语词汇学老师。深度讲解一个单词或短语，输出严格 JSON：
{
  "term": "词条本身",
  "phonetic": "音标",
  "pos": "词性（可多个，用 / 分隔）",
  "meanings": [ { "pos": "词性", "meaning": "中文释义", "example": "英文例句", "translation": "例句中文翻译" } ],
  "root": "词根词缀解析，中文说明；没有则空字符串",
  "collocations": [ "常见搭配（英文）" ],
  "synonyms": [ "近义词" ],
  "antonyms": [ "反义词" ],
  "usage": "用法要点与易错点，中文说明，不超过 120 字",
  "level": "高考 / 四级 / 六级 / 拓展"
}
规则：
1. 只输出 JSON，不要 Markdown。
2. meanings 取 2-4 项，collocations 取 3-6 条；全部例句要地道、适合中学生理解。
${hint}`
    },
    { role: 'user', content: `单词/短语：${term}\n\n语境（可能为空）：\n${String(context).slice(0, 800)}` }
  ], { model: s.textModel, fallbacks: TEXT_FALLBACKS, json: true, max_tokens: 4000, temperature: 0.3, reasoningEffort: 'none' });
  return {
    term: String(p.term || term).trim(), phonetic: String(p.phonetic || ''), pos: String(p.pos || ''),
    meanings: Array.isArray(p.meanings) ? p.meanings : [],
    root: String(p.root || ''),
    collocations: Array.isArray(p.collocations) ? p.collocations.map(String) : [],
    synonyms: Array.isArray(p.synonyms) ? p.synonyms.map(String) : [],
    antonyms: Array.isArray(p.antonyms) ? p.antonyms.map(String) : [],
    usage: String(p.usage || ''), level: String(p.level || ''),
    queriedAt: new Date().toISOString()
  };
}

/** 划词翻译 / 简短解释（非 JSON，快速返回；同内容会话级缓存，重复划词不重复请求） */
const selCache = new Map();
export async function translateSelection(text, context = '') {
  const key = `${normalizeKey(text)}|${normalizeKey(String(context).slice(0, 300))}`;
  if (selCache.has(key)) return selCache.get(key);
  const r = await nlpSentence(text);
  const hint = syntaxHint(r);
  const out = await chat([
    { role: 'system', content: `你是英汉翻译助手。给出所选英文内容的准确中文翻译；若是单词或短语，再附一行用法说明。直接输出中文，不要 Markdown，不要解释你的工作方式。${hint ? '\n\n' + hint + '\n\n翻译时请参考句法分析，确保主干和修饰关系判断正确。' : ''}` },
    { role: 'user', content: `选中内容：${text}\n\n上下文：${String(context).slice(0, 800)}` }
  ], { fallbacks: TEXT_FALLBACKS, max_tokens: 800, temperature: 0.2, reasoningEffort: 'none' });
  const v = out.trim();
  if (v) {
    if (selCache.size > 60) selCache.clear();
    selCache.set(key, v);
  }
  return v;
}

function countWords(text) {
  const en = String(text || '').match(/[A-Za-z]+(?:['’-][A-Za-z]+)*/g);
  return en ? en.length : 0;
}
