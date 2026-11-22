import { init, subscribe, onSync, getState, setSettings, getSettings } from './store.js';
import { fetchMe, getUser } from './auth.js';
import { speak as speakText, speakSequence, splitForSpeech, stop as stopSpeaking, ttsAvailable } from './tts.js';
import { isNative } from './bridge.js';
import { computeStats } from './stats.js';
import { icon } from './ui.js';
import { initRouter, onChange, go } from './router.js';
import { startLocalScheduler } from './reminder.js';

import * as home from './views/home.js';
import * as reader from './views/reader.js';
import * as history from './views/history.js';
import * as lookup from './views/lookup.js';
import * as importView from './views/import.js';
import * as words from './views/words.js';
import * as learn from './views/learn.js';
import * as quiz from './views/quiz.js';
import * as dashboard from './views/dashboard.js';
import * as settings from './views/settings.js';

const VIEWS = { home, reader, history, lookup, import: importView, words, learn, quiz, dashboard, settings };
// tab: true 的项出现在移动端底栏（其余仍需在侧栏抽屉中访问）
const NAV = [
  { name: 'home', label: '今天', icon: 'home', tab: true, group: '学习' },
  { name: 'reader', label: '阅读', icon: 'reader', tab: true, group: '学习' },
  { name: 'words', label: '词库', icon: 'book', tab: true, group: '学习' },
  { name: 'learn', label: '复习', icon: 'target', group: '学习' },
  { name: 'quiz', label: '试卷', icon: 'clipboard', tab: true, group: '学习' },
  { name: 'lookup', label: '查词', icon: 'searchWord', tab: true, group: '工具' },
  { name: 'history', label: '句库', icon: 'chat', group: '工具' },
  { name: 'dashboard', label: '统计', icon: 'chart', tab: true, group: '工具' },
  { name: 'settings', label: '设置', icon: 'gear', group: '' }
];

function buildNav() {
  const side = document.getElementById('sideNav');
  const tabs = document.getElementById('tabbar');
  side.innerHTML = NAV.map((n, i) => {
    const head = n.group && (i === 0 || NAV[i - 1].group !== n.group)
      ? `<div class="nav-group">${n.group}</div>` : '';
    return `${head}<button class="nav-item" data-nav="${n.name}" type="button">${icon(n.icon)}<span>${n.label}</span><span class="badge hide" data-badge="${n.name}"></span></button>`;
  }).join('');
  tabs.innerHTML = NAV.filter((n) => n.tab).map((n) => `
    <button class="tab-item" data-nav="${n.name}" type="button">${icon(n.icon, 20)}<span>${n.label}</span></button>`).join('');

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-nav]');
    if (!btn) return;
    go(btn.dataset.nav);
    closeSidebar();
  });
}

function openSidebar() {
  document.getElementById('sidebar')?.classList.add('open');
  if (!document.querySelector('.scrim')) {
    const scrim = document.createElement('div');
    scrim.className = 'scrim';
    scrim.addEventListener('click', closeSidebar);
    document.getElementById('app').appendChild(scrim);
  }
}

function closeSidebar() {
  document.getElementById('sidebar')?.classList.remove('open');
  document.querySelector('.scrim')?.remove();
}

function updateChrome(route) {
  const safeName = VIEWS[route.name] ? route.name : 'home';
  const view = VIEWS[safeName];
  const title = typeof view.title === 'function' ? view.title(route.params) : view.title;
  const subtitle = typeof view.subtitle === 'function' ? view.subtitle(route.params) : view.subtitle;
  document.getElementById('pageTitle').textContent = title;
  document.getElementById('pageSubtitle').textContent = subtitle;
  document.querySelectorAll('[data-nav]').forEach((el) => el.classList.toggle('active', el.dataset.nav === safeName));
}

function updateStreak() {
  const st = computeStats(getState());
  document.getElementById('streakChip').innerHTML = `${icon('flame', 13)} <span class="streak-text">连续 ${st.streak} 天</span>`;
}

function updateBadges() {
  const due = getState().words.filter((w) => !w.srs?.dueAt || w.srs.dueAt <= Date.now() || !w.srs?.level).length;
  const badge = document.querySelector('[data-badge="learn"]');
  if (badge) { badge.textContent = due > 99 ? '99+' : due; badge.classList.toggle('hide', due === 0); }
}

let routeSerial = 0;
async function renderRoute(route) {
  const serial = ++routeSerial;
  stopSpeaking();          // 换页面时停掉正在进行的朗读
  const old = document.getElementById('view');
  const fresh = document.createElement('main');
  fresh.className = 'view'; fresh.id = 'view';
  old.replaceWith(fresh);

  updateChrome(route);
  const view = VIEWS[route.name] || VIEWS.home;
  fresh.innerHTML = view.render(route.params || {});
  updateStreak();
  updateBadges();
  // 并发导航防护：mount 内部往往有 await，恢复执行时 DOM 可能已被更新的路由替换；
  // 序号不一致说明本次已过期，直接放弃，避免把旧视图的监听器挂到新 DOM 上
  if (serial !== routeSerial) return;
  try { await view.mount?.(route.params || {}); }
  catch (err) { console.error('[view mount]', err); }
}

function renderSideUser() {
  const box = document.getElementById('sideUser');
  if (!box) return;
  const u = getUser();
  if (!u) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="side-user">
      <div class="side-avatar">${icon('user', 15)}</div>
      <div class="side-user-text">
        <strong>${escapeHTML(u.nickname || u.username)}</strong>
        <span>@${escapeHTML(u.username)}</span>
      </div>
    </div>`;
}

function escapeHTML(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/**
 * 朗读：全站统一接管 [data-speak]（词/句）与 [data-speak-article]（整篇文章）。
 * 用捕获阶段 —— 点到「听」时不会再触发它所在卡片 / 句子的点击（例如打开句子精讲）。
 * 浏览器不支持 speechSynthesis 时给 <html> 加 .no-tts，CSS 会把所有听按钮隐藏。
 */
function bindTts() {
  if (!ttsAvailable()) {
    document.documentElement.classList.add('no-tts');
    return;
  }
  document.addEventListener('click', (e) => {
    const artBtn = e.target.closest('[data-speak-article]');
    if (artBtn) {
      e.preventDefault();
      e.stopPropagation();
      const article = getState().articles.find((a) => a.id === artBtn.dataset.speakArticle);
      if (article) speakSequence(splitForSpeech(article.text), { btn: artBtn });
      return;
    }
    const el = e.target.closest('[data-speak]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    speakText(el.dataset.speak, { btn: el });
  }, true);
}

bindTts();

async function boot() {
  // APK 内置版没有服务端，数据只存本机：不走账号
  if (isNative()) {
    await startApp({ id: 'local', username: '本机', nickname: '本机用户', local: true });
    return;
  }

  // 免登录：直接读取服务端固定的本机账号；服务不可达时由外层 catch 显示重试
  const me = await fetchMe();
  if (!me) throw new Error('服务端未返回本机账号');
  await startApp(me);
}

async function startApp(me) {
  buildNav();
  renderSideUser();
  document.getElementById('menuBtn').innerHTML = icon('menu', 20);
  document.getElementById('menuBtn').addEventListener('click', () => {
    if (document.getElementById('sidebar')?.classList.contains('open')) closeSidebar();
    else openSidebar();
  });
  document.getElementById('bellBtn').innerHTML = icon('bell', 19);
  document.getElementById('bellBtn').addEventListener('click', () => go('settings'));

  initRouter();
  await init(me.id);

  // APK 内：默认首次授予通知权限时机由用户在设置页决定，并刷新一次系统闹钟
  if (isNative()) {
    const s = getSettings();
    if (s.reminderEnabled) {
      const { syncPushSettings } = await import('./reminder.js');
      syncPushSettings();
    }
  }

  subscribe(() => { updateStreak(); updateBadges(); });
  onSync(({ level, text }) => {
    const pill = document.getElementById('syncPill');
    pill.className = `sync-pill ${level === 'busy' ? 'busy' : level === 'error' ? 'error' : ''}`;
    pill.querySelector('span').textContent = text;
  });

  onChange((route) => { renderRoute(route).catch(console.error); });
  await renderRoute({ name: (await import('./router.js')).getRoute().name, params: (await import('./router.js')).getRoute().params });

  startLocalScheduler();

  if (!isNative() && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW 注册失败', err));
  }
}

boot().catch((err) => {
  console.error(err);
  document.getElementById('view').innerHTML = `<div class="card"><h2>无法连接服务</h2><p class="small muted">${escapeHTML(err.message)}</p><button class="btn btn-primary" onclick="location.reload()">重试</button></div>`;
});
