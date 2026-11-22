// 当前本机用户（浏览器端）：免登录，只读取服务端固定的本机账号。
// 请求统一走 api.js（超时、错误归一化都在那里处理）。

import { request } from './api.js';

let currentUser = null;

export async function fetchMe() {
  // 服务端恒返回本机账号；网络不通时向上抛错，由启动流程显示连接失败。
  const data = await request('/api/auth/me');
  currentUser = data.user || null;
  return currentUser;
}

export function getUser() { return currentUser; }
