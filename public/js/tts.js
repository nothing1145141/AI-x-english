// 朗读：浏览器自带 speechSynthesis，零依赖、零模型下载、不联网。//
// 朗读：浏览器自带 speechSynthesis，零依赖、零模型下载、不联网。
//
// 用法：
//   1) 任意元素加 data-speak="要读的英文"，全站点统一接管点击（见 app.js 的 bindTts）。
//   2) 整篇朗读：speakSequence(splitForSpeech(text), { btn })。
//   3) 语音 / 语速在「设置 → 朗读」里换，存 localStorage，不写学习数据。
//
// 说明：
// - 句子按句号切开逐句排队，避免 Chrome 对长文本的截断；
// - 再次点击同一个按钮 = 停止；
// - 浏览器不支持时静默降级：app.js 给 <html> 加 .no-tts，CSS 隐藏所有听按钮。

import { toast } from './ui.js';
import { splitSentences } from './textsplit.js';

const KEY_VOICE = 'ww.tts.voice';
const KEY_RATE = 'ww.tts.rate';

const DEFAULT_RATE = 0.95;
const RATE_MIN = 0.6;
const RATE_MAX = 1.25;
const RATE_STEPS = [
  [0.75, '慢'],
  [0.95, '标准'],
  [1.1, '稍快'],
  [1.25, '快']
];

export const RATE_OPTIONS = RATE_STEPS;

let cachedVoices = [];
let pref = {
  voiceURI: readPref(KEY_VOICE, ''),
  rate: clampRate(readPref(KEY_RATE, DEFAULT_RATE))
};

let serial = 0;          // 每次播放递增，旧回调据此作废
let currentBtn = null;   // 正在朗读的按钮（用于状态样式）
let warnedNoVoice = false;
const voiceListeners = new Set();

/* ---------------- 环境与偏好 ---------------- */

export function ttsAvailable() {
  return typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof window.SpeechSynthesisUtterance === 'function';
}

function readPref(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch (_) {
    return fallback;
  }
}

function writePref(key, value) {
  try { localStorage.setItem(key, String(value)); } catch (_) { /* 隐私模式写不进就算了 */ }
}

function clampRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_RATE;
  return Math.min(RATE_MAX, Math.max(RATE_MIN, Math.round(n * 100) / 100));
}

export function getRate() { return pref.rate; }

export function setRate(value) {
  pref.rate = clampRate(value);
  writePref(KEY_RATE, pref.rate);
  return pref.rate;
}

export function getVoiceURI() { return pref.voiceURI; }

export function setVoice(uri) {
  pref.voiceURI = String(uri || '');
  writePref(KEY_VOICE, pref.voiceURI);
}

/* ---------------- 语音列表 ---------------- */

function isEnglish(voice) {
  return /^en([-_]|$)/i.test(String(voice?.lang || ''));
}

function refreshVoices() {
  if (!ttsAvailable()) return cachedVoices;
  try {
    cachedVoices = (window.speechSynthesis.getVoices() || []).filter(isEnglish);
  } catch (_) {
    cachedVoices = [];
  }
  return cachedVoices;
}

/** 当前可用的英文语音（可能为空：系统没装英文语音包） */
export function englishVoices() {
  if (!cachedVoices.length) refreshVoices();
  return cachedVoices.slice();
}

/** 语音列表异步就绪时通知（Chrome 首次要等 voiceschanged） */
export function onVoicesReady(fn) {
  voiceListeners.add(fn);
  return () => voiceListeners.delete(fn);
}

/** 默认语音排序：自然音 > Google 在线音 > 本地音，en-US 优先 */
function voiceScore(v) {
  let s = 0;
  if (/natural|neural|premium|enhanced/i.test(v.name || '')) s += 30;
  if (/google/i.test(v.name || '')) s += 24;
  if (!v.localService) s += 6;
  if (/^en[-_]us/i.test(v.lang || '')) s += 8;
  else if (/^en[-_]gb/i.test(v.lang || '')) s += 5;
  else if (/^en[-_]au/i.test(v.lang || '')) s += 3;
  return s;
}

export function currentVoice() {
  const list = englishVoices();
  if (!list.length) return null;
  if (pref.voiceURI) {
    const hit = list.find((v) => v.voiceURI === pref.voiceURI);
    if (hit) return hit;
  }
  return list.slice().sort((a, b) => voiceScore(b) - voiceScore(a))[0];
}

/* ---------------- 朗读 ---------------- */

function clean(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function makeUtterance(text) {
  const u = new SpeechSynthesisUtterance(text);
  const voice = currentVoice();
  u.lang = voice?.lang || 'en-US';
  if (voice) u.voice = voice;
  u.rate = pref.rate;
  u.pitch = 1;
  u.volume = 1;
  return u;
}

function markBtn(btn, on) {
  if (btn && btn.isConnected) btn.classList.toggle('is-speaking', on);
}

function clearBtn() {
  markBtn(currentBtn, false);
  currentBtn = null;
  document.querySelectorAll('.tts-btn.is-speaking, .btn.is-speaking').forEach((el) => el.classList.remove('is-speaking'));
}

export function isSpeaking() {
  if (!ttsAvailable()) return false;
  try { return window.speechSynthesis.speaking || window.speechSynthesis.pending; } catch (_) { return false; }
}

/** 停止当前朗读（切页面、切文章时调用） */
export function stop() {
  serial += 1;
  clearBtn();
  if (!ttsAvailable()) return;
  try { window.speechSynthesis.cancel(); } catch (_) { /* 忽略 */ }
}

function speakUtterance(u, onDone) {
  u.onend = onDone;
  u.onerror = onDone;   // 被 cancel() 打断时也会走这里，由 serial 判断是否过时
  try { window.speechSynthesis.resume(); } catch (_) { /* 忽略 */ }
  window.speechSynthesis.speak(u);
}

/**
 * 读一段文字（词、句、例句）。
 * 同一个按钮再点一次 = 停止。
 * @returns {boolean} 是否开始朗读
 */
export function speak(text, { btn = null } = {}) {
  const body = clean(text);
  if (!body) return false;

  if (btn && btn.classList.contains('is-speaking')) { stop(); return false; }

  if (!ttsAvailable()) {
    toast('当前浏览器不支持朗读，换 Chrome / Edge / Safari 试试', 'error');
    return false;
  }

  stop();
  const mine = serial;
  currentBtn = btn;
  markBtn(btn, true);

  const u = makeUtterance(body);
  speakUtterance(u, () => {
    if (mine === serial) clearBtn();
  });

  if (!currentVoice() && !warnedNoVoice) {
    warnedNoVoice = true;
    toast('系统里没找到英文语音，暂用默认发音；可在「设置 → 朗读」查看', 'info');
  }
  return true;
}

/**
 * 顺序朗读多句（整篇文章）。逐句排队，上一句读完再读下一句。
 * @param {string[]} texts 句子数组
 * @param {{btn?: HTMLElement}} opts
 */
export function speakSequence(texts, { btn = null } = {}) {
  const list = (Array.isArray(texts) ? texts : [texts]).map(clean).filter(Boolean);
  if (!list.length) return false;

  if (btn && btn.classList.contains('is-speaking')) { stop(); return false; }

  if (!ttsAvailable()) {
    toast('当前浏览器不支持朗读，换 Chrome / Edge / Safari 试试', 'error');
    return false;
  }

  stop();
  const mine = serial;
  currentBtn = btn;
  markBtn(btn, true);

  let i = 0;
  const next = () => {
    if (mine !== serial) return;
    if (i >= list.length) { clearBtn(); return; }
    const u = makeUtterance(list[i]);
    i += 1;
    speakUtterance(u, () => {
      if (mine !== serial) return;
      next();
    });
  };
  next();
  return true;
}

/** 句末常见缩写：切开后要再粘回去，避免 "Mr. Smith" 被读成两句 */
const ABBR = /(?:^|\s)(?:mr|mrs|ms|dr|prof|sr|jr|st|etc|vs|inc|ltd|co|fig|no|al|e\.g|i\.e)\.$|(?:^|\s)(?:[A-Za-z]\.){2,}$/i;

/** 把文章正文切成适合逐句朗读的句子（段落切分，再按句末标点断句） */
export function splitForSpeech(text) {
  const raw = String(text || '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return [];
  const out = [];
  raw.split(/\n\s*\n+/).forEach((para) => {
    const parts = splitSentences(para)
      .map((s) => clean(s))
      .filter(Boolean);
    // 缩写点号不是句子边界：并到上一句
    const merged = [];
    parts.forEach((p) => {
      if (merged.length && ABBR.test(merged[merged.length - 1])) merged[merged.length - 1] += ` ${p}`;
      else merged.push(p);
    });
    merged.forEach((s) => out.push(s));
  });
  return out;
}

/* ---------------- 初始化 ---------------- */

if (ttsAvailable()) {
  const notify = () => { refreshVoices(); voiceListeners.forEach((fn) => { try { fn(); } catch (_) {} }); };
  try {
    window.speechSynthesis.addEventListener('voiceschanged', notify);
  } catch (_) {
    window.speechSynthesis.onvoiceschanged = notify;
  }
  refreshVoices();
}
