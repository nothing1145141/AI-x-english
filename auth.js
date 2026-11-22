'use strict';

/**
 * 本机账号（免登录）：
 * - 固定使用 data/users.json 里的第一个账号，沿用已有学习数据；
 * - 账号表为空时自动创建一个无密码的本机账号，保证数据有地方落盘；
 * - 不再提供注册 / 登录 / 会话 / 密码校验。
 * 每个账号一份独立学习数据：data/users/<id>.json
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_DIR = path.join(DATA_DIR, 'users');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

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

/** 取本机账号：账号表第一个；没有则创建一个无密码的本地账号（id 固定）。 */
function localUser() {
  const users = loadUsers();
  if (users.length) return users[0];
  const user = {
    id: 'u_local',
    username: 'local',
    nickname: '本机用户',
    createdAt: new Date().toISOString(),
    lastLoginAt: null
  };
  users.push(user);
  saveUsers(users);
  return user;
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    nickname: u.nickname || u.username,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null
  };
}

/* ---------------- 每用户数据文件 ---------------- */

function storeFile(userId) {
  const safe = String(userId || '').replace(/[^a-zA-Z0-9_]/g, '');
  return path.join(USERS_DIR, `${safe}.json`);
}

module.exports = {
  localUser,
  publicUser,
  storeFile
};
