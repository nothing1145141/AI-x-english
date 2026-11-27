'use strict';

/**
 * WordWise - Cloudflare Workers 版本
 *
 * 兼容本地 Node 版 server.js 的前端协议：
 *   - /api/auth/me、/api/health、/api/net
 *   - /api/config（只读，模型与网关来自环境变量）
 *   - /api/models、/api/ai（服务端 Key 或访客自带 Key）
 *   - /api/data（学习数据存 KV）
 *   - /api/upload、/api/image/*
 *   - 词典 / MDX / NLP / 语音 / Web Push：云端不可用，返回明确的降级响应
 * 静态资源由 Workers 静态资源绑定（ASSETS）直接提供，/api/* 先进入 Worker。
 */

const LOCAL_USER = {
  id: 'u_local',
  username: 'local',
  nickname: '本机用户',
  createdAt: '2026-01-01T00:00:00.000Z',
  lastLoginAt: null,
  local: true
};

const STATE_KEY = `state:${LOCAL_USER.id}`;
const IMAGE_PREFIX = 'img:';
const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;

// 测试用免费额度 Key，直接内置，省去配置；环境变量可覆盖
const DEFAULTS = {
  apiBase: 'https://developer.amd.com.cn/radeon/api/v1',
  apiKey: 'rc-01828a8f5be1c53e73b92bf39bbd516929b0ce25c90b314c',
  textModel: 'Hy4-flash',
  visionModel: 'MiniCPM-V-4.7-35B-A3B',
  gradingModel: 'Hy4-flash',
  dailyQuestions: 10
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

let modelsCache = { at: 0, data: null };

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname;

    if (!p.startsWith('/api/')) return env.ASSETS.fetch(request);

    try {
      return await route(request, env, url, p);
    } catch (e) {
      return json({ error: e.message || '服务器错误' }, 500);
    }
  }
};

async function route(request, env, url, p) {
  const method = request.method;

  if (method === 'GET' && p === '/api/auth/me') return json({ ok: true, user: LOCAL_USER });
  if (method === 'GET' && p === '/api/health') {
    return json({ ok: true, time: new Date().toISOString(), dataFile: false, nlp: false, cloud: true });
  }
  if (method === 'GET' && p === '/api/net') {
    return json({ ok: true, port: null, host: 'cloudflare', lan: false, hostname: 'cloudflare', localUrl: url.origin, primary: null, addresses: [] });
  }

  if (method === 'GET' && p === '/api/config') {
    const gw = gateway(env, request);
    return json({
      apiBase: gw.base,
      hasServerKey: !!gw.key,
      textModel: env.WORDWISE_TEXT_MODEL || DEFAULTS.textModel,
      visionModel: env.WORDWISE_VISION_MODEL || DEFAULTS.visionModel,
      gradingModel: env.WORDWISE_GRADING_MODEL || DEFAULTS.gradingModel,
      dailyQuestionCount: Number(env.WORDWISE_DAILY_QUESTIONS) || DEFAULTS.dailyQuestions
    });
  }
  if (method === 'POST' && p === '/api/config') {
    return json({ ok: false, error: '云端部署的网关与模型由 Cloudflare 环境变量控制，设置页不可修改' }, 403);
  }

  if (method === 'GET' && p === '/api/models') return handleModels(env, request);
  if (method === 'POST' && p === '/api/ai') return handleAI(request, env);

  if (method === 'GET' && p === '/api/data') {
    const store = await readState(env);
    return json(store);
  }
  if (method === 'POST' && p === '/api/data') {
    const body = await readJson(request, 32 * 1024 * 1024);
    if (!body || !Array.isArray(body.words)) return json({ error: '数据格式不正确' }, 400);
    body.updatedAt = new Date().toISOString();
    await env.WORDWISE_KV.put(STATE_KEY, JSON.stringify(body));
    return json({ ok: true, updatedAt: body.updatedAt });
  }

  if (method === 'POST' && p === '/api/upload') {
    const body = await readJson(request, 20 * 1024 * 1024);
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s.exec(body.dataUrl || '');
    if (!m) return json({ error: '图片格式不正确' }, 400);
    const bin = base64ToBytes(m[2]);
    if (!bin.length || bin.length > MAX_UPLOAD_BYTES) return json({ error: '图片过大或为空' }, 400);
    const extMap = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' };
    const ext = extMap[m[1].toLowerCase()] || '.jpg';
    const id = `${Date.now()}-${randomHex(6)}${ext}`;
    await env.WORDWISE_KV.put(IMAGE_PREFIX + id, bin, { metadata: { type: MIME[ext] || 'image/jpeg' } });
    return json({ ok: true, id, url: `/api/image/${id}`, size: bin.length });
  }
  if (method === 'GET' && p.startsWith('/api/image/')) {
    const name = p.slice('/api/image/'.length);
    if (!/^[A-Za-z0-9._-]+$/.test(name)) return new Response('Not found', { status: 404 });
    const hit = await env.WORDWISE_KV.getWithMetadata(IMAGE_PREFIX + name, { type: 'arrayBuffer' });
    if (!hit || !hit.value) return new Response('Not found', { status: 404 });
    return new Response(hit.value, {
      headers: {
        'Content-Type': (hit.metadata && hit.metadata.type) || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400'
      }
    });
  }

  // 词典：云端不内置 ECDICT / MDX，前端会自动降级
  if (method === 'GET' && p === '/api/dict/status') return json({ ok: false, meta: null });
  if (method === 'GET' && p === '/api/dict') {
    const term = String(url.searchParams.get('q') || '').slice(0, 80);
    return json({ ok: false, term, suggestions: [] });
  }
  if (method === 'POST' && p === '/api/dict/batch') return json({ ok: true, dict: {} });
  if (method === 'GET' && p === '/api/mdx/status') return json({ ok: true, dicts: [], available: false });
  if (method === 'GET' && p === '/api/mdx/lookup') {
    return json({ ok: false, term: String(url.searchParams.get('q') || '').slice(0, 80), suggestions: [] });
  }
  if (method === 'GET' && p === '/api/mdx/suggest') return json({ ok: true, list: [] });
  if (p.startsWith('/api/mdx/')) return json({ ok: false, error: '云端部署不支持导入 MDX 词典' }, 501);

  // NLP / 语音依赖本地 Python 服务，云端明确降级
  if (method === 'GET' && p === '/api/nlp/status') return json({ ok: false, available: false });
  if (p.startsWith('/api/nlp/')) return json({ ok: false, error: '云端部署不提供本地 NLP 句法服务' }, 503);
  if (method === 'GET' && p === '/api/speech/status') {
    return json({ ok: false, available: false, port: null, service: null, asr: null, tts: null, pronounce: null, profile: null, error: '云端部署不提供本地语音评测' });
  }
  if (p.startsWith('/api/speech/')) return json({ ok: false, error: '云端部署不提供本地语音评测' }, 503);

  // Web Push：云端暂不支持
  if (method === 'GET' && p === '/api/vapid-public') {
    return json({ ok: false, key: '', error: '云端部署暂不支持定时提醒' }, 501);
  }
  if (p === '/api/subscribe' || p === '/api/push-test') {
    return json({ ok: false, error: '云端部署暂不支持定时提醒' }, 501);
  }

  return json({ error: 'Not found' }, 404);
}

/* ---------------- AI 代理 ---------------- */

function gateway(env, request) {
  const headers = request.headers;
  const clientKey = String(headers.get('x-api-key') || '').trim();
  const key = clientKey || String(env.AI_API_KEY || env.WORDWISE_API_KEY || DEFAULTS.apiKey).trim();
  const base = (clientKey
    ? String(headers.get('x-api-base') || '').trim()
    : String(env.AI_API_BASE || env.WORDWISE_API_BASE || DEFAULTS.apiBase).trim()) || '';
  return { key, base: base.replace(/\/$/, ''), clientKey: !!clientKey };
}

function pickModel(env, requested, envName) {
  return String(requested || env[envName] || env.WORDWISE_TEXT_MODEL || DEFAULTS.textModel).trim();
}

async function handleAI(request, env) {
  const body = await readJson(request);
  const gw = gateway(env, request);
  if (!gw.key) return json({ error: '未配置 API Key，请在设置中填写' }, 400);
  if (!gw.base) return json({ error: '未配置 AI 网关地址' }, 400);
  if (!body.messages || !Array.isArray(body.messages)) return json({ error: 'messages 格式不正确' }, 400);

  const payload = {
    model: pickModel(env, body.model, 'WORDWISE_TEXT_MODEL'),
    messages: body.messages,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0.2,
    max_tokens: body.max_tokens || 2048
  };
  if (body.reasoning_effort) payload.reasoning_effort = String(body.reasoning_effort);
  if (body.response_format && body.response_format.type) payload.response_format = body.response_format;

  try {
    const r = await fetch(`${gw.base}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gw.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(120000)
    });
    const text = await r.text();
    return new Response(text, {
      status: r.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  } catch (e) {
    return json({ error: { message: e.message } }, 502);
  }
}

async function handleModels(env, request) {
  const gw = gateway(env, request);
  if (!gw.key) return json({ error: '未配置 API Key，请在设置中填写' }, 400);
  if (!gw.base) return json({ error: '未配置 AI 网关地址' }, 400);
  if (!gw.clientKey && modelsCache.data && Date.now() - modelsCache.at < 10 * 60 * 1000) {
    return json(modelsCache.data);
  }
  try {
    const r = await fetch(`${gw.base}/models`, {
      headers: { Authorization: `Bearer ${gw.key}` },
      signal: AbortSignal.timeout(20000)
    });
    const data = await r.json();
    if (r.ok && !gw.clientKey) modelsCache = { at: Date.now(), data };
    return json(data, r.ok ? 200 : 502);
  } catch (e) {
    return json({ error: { message: e.message } }, 502);
  }
}

/* ---------------- 工具 ---------------- */

function emptyStore() {
  return { version: 1, words: [], quizzes: [], attempts: [], activity: [], speakings: [], settings: {}, updatedAt: null };
}

async function readState(env) {
  const raw = await env.WORDWISE_KV.get(STATE_KEY);
  if (!raw) return emptyStore();
  try {
    const s = JSON.parse(raw);
    return s && typeof s === 'object' ? Object.assign(emptyStore(), s) : emptyStore();
  } catch (_) {
    return emptyStore();
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function readJson(request, limit = 16 * 1024 * 1024) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len && len > limit) throw new Error('请求体过大');
  const text = await request.text();
  if (!text) return {};
  if (text.length > limit) throw new Error('请求体过大');
  try {
    return JSON.parse(text);
  } catch (_) {
    throw new Error('JSON 解析失败');
  }
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomHex(n) {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}
