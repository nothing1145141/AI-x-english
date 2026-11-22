'use strict';

/**
 * 账号与会话：本地账号体系（零外部依赖）
 * - 密码 scrypt + 随机盐，恒定时间比较
 * - 会话令牌存 data/sessions.json，浏览器只拿 httpOnly Cookie
 * - 每个账号一份独立学习数据 data/users/<id>.json
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 天
const COOKIE_NAME = 'ww_session';

[USERS_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function loadUsers() {
  const list = readJson(USERS_FILE, []);
  return Array.isArray(list) ? list : [];
}
function saveUsers(list) { writeJsonAtomic(USERS_FILE, list); }

/**
 * 免登录模式使用的本机账号：取账号表里的第一个账号，保证沿用已有学习数据；
 * 一个都没有时创建一个无密码的本地账号（id 固定），让数据有地方落盘。
 */
function localUser() {
  const users = loadUsers();
  if (users.length) return users[0];
  const user = {
    id: 'u_local',
    username: 'local',
    nickname: '本机用户',
    salt: '',
    hash: '',
    createdAt: new Date().toISOString(),
    lastLoginAt: null
  };
  users.push(user);
  saveUsers(users);
  return user;
}

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), Buffer.from(salt, 'hex'), 64).toString('hex');
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'hex');
  const bb = Buffer.from(String(b), 'hex');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, username: u.username, nickname: u.nickname || u.username, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null };
}

function validate({ username, password, nickname }) {
  const name = String(username || '').trim();
  if (!/^[A-Za-z0-9_\u4e00-\u9fa5-]{2,20}$/.test(name)) {
    return '用户名需 2-20 位，只允许中英文、数字、下划线和短横线';
  }
  const pw = String(password || '');
  if (pw.length < 6) return '密码至少 6 位';
  if (pw.length > 72) return '密码过长';
  if (nickname && String(nickname).length > 20) return '昵称最多 20 个字';
  return null;
}

function register({ username, password, nickname }) {
  const err = validate({ username, password, nickname });
  if (err) throw new Error(err);

  const name = String(username).trim();
  const users = loadUsers();
  if (users.some((u) => u.username.toLowerCase() === name.toLowerCase())) {
    throw new Error('这个用户名已经被注册了');
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const user = {
    id: `u_${crypto.randomBytes(8).toString('hex')}`,
    username: name,
    nickname: String(nickname || '').trim() || name,
    salt,
    hash: hashPassword(password, salt),
    createdAt: new Date().toISOString(),
    lastLoginAt: null
  };
  users.push(user);
  saveUsers(users);
  return user;
}

function login({ username, password }) {
  const name = String(username || '').trim();
  if (!name || !password) throw new Error('请输入用户名和密码');
  const users = loadUsers();
  const user = users.find((u) => u.username.toLowerCase() === name.toLowerCase());
  // 用户不存在时也跑一次哈希，避免用响应时间探测账号是否存在
  const salt = user ? user.salt : crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  if (!user || !safeEqual(hash, user.hash)) throw new Error('用户名或密码不正确');
  user.lastLoginAt = new Date().toISOString();
  saveUsers(users);
  return user;
}

/* ---------------- 会话 ---------------- */

function loadSessions() {
  const now = Date.now();
  const list = readJson(SESSIONS_FILE, []);
  if (!Array.isArray(list)) return [];
  return list.filter((s) => s && s.token && s.expiresAt > now);
}

function createSession(userId) {
  const sessions = loadSessions();
  const token = crypto.randomBytes(32).toString('hex');
  sessions.push({ token, userId, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL });
  // 同一账号最多保留 8 个有效会话
  const mine = sessions.filter((s) => s.userId === userId);
  if (mine.length > 8) {
    const drop = new Set(mine.sort((a, b) => a.createdAt - b.createdAt).slice(0, mine.length - 8).map((s) => s.token));
    writeJsonAtomic(SESSIONS_FILE, sessions.filter((s) => !drop.has(s.token)));
  } else {
    writeJsonAtomic(SESSIONS_FILE, sessions);
  }
  return token;
}

function findSession(token) {
  if (!token) return null;
  const hit = loadSessions().find((s) => s.token === token);
  if (!hit) return null;
  const user = loadUsers().find((u) => u.id === hit.userId);
  if (!user) return null;
  return { session: hit, user };
}

function destroySession(token) {
  if (!token) return;
  const sessions = loadSessions().filter((s) => s.token !== token);
  writeJsonAtomic(SESSIONS_FILE, sessions);
}

/* ---------------- Cookie ---------------- */

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  raw.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i < 0) return;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  });
  return out;
}

function sessionCookie(token, req) {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL / 1000)}${secure}`;
}

function clearCookie() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function tokenFrom(req) {
  return parseCookies(req)[COOKIE_NAME] || '';
}

/* ---------------- 每用户数据文件 ---------------- */

function storeFile(userId) {
  const safe = String(userId || '').replace(/[^a-zA-Z0-9_]/g, '');
  return path.join(USERS_DIR, `${safe}.json`);
}

module.exports = {
  COOKIE_NAME,
  localUser,
  register,
  login,
  publicUser,
  createSession,
  findSession,
  destroySession,
  tokenFrom,
  sessionCookie,
  clearCookie,
  storeFile
};
