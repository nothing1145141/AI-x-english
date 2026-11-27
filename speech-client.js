'use strict';

/**
 * 本地语音服务管理器：Node 自动拉起 Python 评测服务（speech/server.py），
 * 负责健康检查、崩溃重启与失败降级。服务不可用时前端会得到明确的 available=false，
 * 而不是静默返回错误分数。
 *
 * 与 nlp-client 保持一致：崩溃重启指数退避 1s/2s/4s，连续 3 次失败进入降级态。
 */

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const SPEECH_PORT = Number(process.env.SPEECH_PORT || 8792);
const SPEECH_URL = `http://127.0.0.1:${SPEECH_PORT}`;
const SCRIPT = path.join(__dirname, 'speech', 'server.py');

const MAX_CONSECUTIVE_FAILURES = 3;
const FAIL_COOLDOWN_MS = 5000;

let child = null;
let startAttempted = false;
let lastHealthCheck = 0;
let healthy = null;
let healthPayload = null;
let consecutiveFailures = 0;
let lastFailAt = 0;
let restarting = false;
let shuttingDown = false;

function resolvePython() {
  if (process.env.PYTHON_BIN) return process.env.PYTHON_BIN;
  const candidates = [
    path.join(__dirname, '.venv', 'Scripts', 'python.exe'),
    path.join(__dirname, '.venv', 'bin', 'python')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'python';
}

async function checkHealth(force = false) {
  const now = Date.now();
  if (!force && healthy !== null && now - lastHealthCheck < 5000) return healthy;
  lastHealthCheck = now;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 2000);
  try {
    const res = await fetch(`${SPEECH_URL}/health`, { signal: ctl.signal });
    healthy = res.ok;
    healthPayload = res.ok ? await res.json() : null;
    return healthy;
  } catch (_) {
    healthy = false;
    healthPayload = null;
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function spawnChild() {
  const python = resolvePython();
  child = spawn(python, [SCRIPT], {
    env: Object.assign({}, process.env, { SPEECH_PORT: String(SPEECH_PORT) }),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  child.stdout?.on('data', (d) => process.stdout.write(`[speech] ${d}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[speech] ${d}`));
  child.on('exit', (code) => {
    child = null;
    if (shuttingDown) return;
    healthy = false;
    healthPayload = null;
    if (code && code !== 0) process.stderr.write(`[speech] 服务退出(code=${code})\n`);
    scheduleRestart();
  });
  child.on('error', (e) => {
    child = null;
    healthy = false;
    process.stderr.write(`[speech] 启动失败: ${e.message}\n`);
    scheduleRestart();
  });
}

function scheduleRestart() {
  if (restarting || shuttingDown) return;
  consecutiveFailures += 1;
  if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
    lastFailAt = Date.now();
    process.stderr.write(`[speech] 连续 ${MAX_CONSECUTIVE_FAILURES} 次启动失败，进入降级态（重启 Node 后可重试）\n`);
    return;
  }
  restarting = true;
  const delay = 1000 * Math.pow(2, consecutiveFailures - 1);
  process.stderr.write(`[speech] ${delay}ms 后自动重启（第 ${consecutiveFailures}/${MAX_CONSECUTIVE_FAILURES} 次）\n`);
  setTimeout(() => {
    restarting = false;
    if (shuttingDown) return;
    startAttempted = true;
    try {
      spawnChild();
    } catch (e) {
      process.stderr.write(`[speech] 无法启动: ${e.message}\n`);
      scheduleRestart();
    }
  }, delay);
}

function ensureStarted() {
  if (startAttempted || shuttingDown) return;
  startAttempted = true;
  if (!fs.existsSync(SCRIPT)) return;
  try {
    spawnChild();
  } catch (e) {
    process.stderr.write(`[speech] 无法启动: ${e.message}\n`);
    scheduleRestart();
  }
}

async function waitReady(waitMs = 8000) {
  ensureStarted();
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (await checkHealth(true)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

async function ensureAvailable() {
  if (healthy === true) return true;
  if (shuttingDown) return false;
  if (consecutiveFailures > MAX_CONSECUTIVE_FAILURES) return false;
  if (lastFailAt && Date.now() - lastFailAt < FAIL_COOLDOWN_MS) return false;
  if (await waitReady(5000)) {
    consecutiveFailures = 0;
    return true;
  }
  lastFailAt = Date.now();
  return false;
}

/** 请求语音服务；永远返回 {ok, status, data, error}，不抛异常 */
async function request(endpoint, payload, timeoutMs) {
  if (!await ensureAvailable()) {
    return {
      ok: false,
      status: 503,
      data: null,
      error: '本地语音服务未就绪（可运行 speech\\setup-venv.bat 检查环境）'
    };
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${SPEECH_URL}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload || {}),
      signal: ctl.signal
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || data.ok === false) {
      return {
        ok: false,
        status: res.status,
        data,
        error: (data && data.error) || `语音服务返回 ${res.status}`
      };
    }
    return { ok: true, status: res.status, data, error: null };
  } catch (err) {
    healthy = false;
    lastFailAt = Date.now();
    const aborted = err && err.name === 'AbortError';
    return {
      ok: false,
      status: aborted ? 504 : 502,
      data: null,
      error: aborted ? '语音评测超时（首次加载 ASR 模型可能较慢）' : `语音服务请求失败: ${err.message}`
    };
  } finally {
    clearTimeout(timer);
  }
}

function assess(payload, timeoutMs = 180000) {
  return request('assess', payload, timeoutMs);
}

function asr(payload, timeoutMs = 180000) {
  return request('asr', payload, timeoutMs);
}

function tts(payload, timeoutMs = 60000) {
  return request('tts', payload, timeoutMs);
}

async function status() {
  const ok = await checkHealth(true);
  const data = healthPayload || {};
  return {
    ok,
    available: ok,
    port: SPEECH_PORT,
    service: data.service || null,
    asr: data.asr || null,
    tts: data.tts || null,
    pronounce: data.pronounce || null,
    profile: data.profile || null,
    error: ok ? null : '本地语音服务未启动或仍在启动中'
  };
}

function shutdown() {
  shuttingDown = true;
  if (child) {
    try { child.kill(); } catch (_) {}
    child = null;
  }
}

module.exports = {
  SPEECH_PORT,
  ensureStarted,
  waitReady,
  checkHealth,
  assess,
  asr,
  tts,
  status,
  shutdown,
  get available() { return healthy === true && !shuttingDown; }
};
