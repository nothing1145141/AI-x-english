// 账号：登录 / 注册 / 退出 / 本机账号；会话由服务端 httpOnly Cookie 维护。
// 请求统一走 api.js（超时、错误归一化都在那里处理）。

import { request } from './api.js';

let currentUser = null;
let localAllowed = false;

export async function fetchMe() {
  const data = await request('/api/auth/me');
  currentUser = data.user || null;
  localAllowed = !!data.localAvailable;
  return currentUser;
}

export function getUser() { return currentUser; }

/** 是否显示「免登录使用本机数据」入口（仅本机账号还没有密码时）。 */
export function canUseLocal() { return localAllowed; }

export async function login(username, password) {
  const data = await request('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password })
  });
  currentUser = data.user || null;
  return currentUser;
}

export async function register(username, password, nickname) {
  const data = await request('/api/auth/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, nickname })
  });
  currentUser = data.user || null;
  return currentUser;
}

export async function loginLocal() {
  const data = await request('/api/auth/local', { method: 'POST' });
  currentUser = data.user || null;
  return currentUser;
}

export async function logout() {
  try { await request('/api/auth/logout', { method: 'POST' }); } catch (_) { /* 忽略网络错误，本地照常退出 */ }
  currentUser = null;
}
