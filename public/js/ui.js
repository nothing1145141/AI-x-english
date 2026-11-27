// 通用 UI 工具：图标、Toast、弹窗、格式化

const PATHS = {
  user: '<circle cx="12" cy="8" r="3.6"/><path d="M4.5 21a7.5 7.5 0 0 1 15 0"/>',
  wifi: '<path d="M4.5 11.5a11 11 0 0 1 15 0"/><path d="M8 15a6 6 0 0 1 8 0"/><circle cx="12" cy="18.5" r="1.1"/>',
  home: '<path d="m3 10 9-7 9 7v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M9 22V12h6v10"/>',
  book: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><path d="M9 12h6M9 16h4"/>',
  chart: '<path d="M3 3v18h18"/><path d="m7 15 4-4 3 3 5-6"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  camera: '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3z"/><circle cx="12" cy="13" r="3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
  upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
  check: '<path d="m20 6-11 11-5-5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  sparkles: '<path d="m12 3 1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/><path d="m19 16 .7 1.8L21.5 18l-1.8.7L19 20.5l-.7-1.8L16.5 18l1.8-.2z"/>',
  trash: '<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 15H6L5 6"/><path d="M10 11v6M14 11v6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  arrowLeft: '<path d="M19 12H5M11 18l-6-6 6-6"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/>',
  file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
  flame: '<path d="M12 22c4 0 7-2.7 7-6.5 0-4-3-5.5-3-9.5-2 1-3 3-3 5-1.5-1-2-3-2-5-3 3-6 6.5-6 10C5 19.3 8 22 12 22z"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  layers: '<path d="m12 2 9 5-9 5-9-5z"/><path d="m3 12 9 5 9-5M3 17l9 5 9-5"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>',
  play: '<path d="m6 4 14 8-14 8z"/>',
  volume: '<path d="M11 5 6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/>',
  mic: '<rect x="9" y="2" width="6" height="11" rx="3"/><path d="M19 11a7 7 0 0 1-14 0M12 18v3M8 21h8"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  reader: '<path d="M2 4h7a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-7a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h7z"/>',
  searchWord: '<circle cx="10.5" cy="10.5" r="7"/><path d="m21 21-4.5-4.5M10.5 7.5v6M7.5 10.5h6"/>',
  highlighter: '<path d="m15 3 6 6-9.5 9.5H5.5L3 16z"/><path d="M2 22h20"/>',
  plusCircle: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  chat: '<path d="M21 12a8 8 0 0 1-8 8H7l-4 3V12a8 8 0 0 1 8-8h2a8 8 0 0 1 8 8z"/>',
  bookOpen: '<path d="M12 7v14"/><path d="M3 5h6a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H3z"/><path d="M21 5h-6a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h6z"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>'
};

export function icon(name, size = 18) {
  const d = PATHS[name] || PATHS.info;
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
}

export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function toast(message, type = 'info', ms = 2600) {
  const root = document.getElementById('toastRoot');
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  root.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(-6px)';
    setTimeout(() => node.remove(), 260);
  }, ms);
}

export function modal({ title, body, actions = [], wide = false, closable = true, onMount }) {
  return new Promise((resolve) => {
    const root = document.getElementById('modalRoot');
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head"><h3>${esc(title)}</h3>${closable ? `<button class="icon-btn" data-close type="button">${icon('x', 17)}</button>` : ''}</div>
        <div class="modal-body">${body || ''}</div>
        ${actions.length ? `<div class="modal-foot">${actions.map((a, i) => `<button class="btn ${a.cls || ''}" data-act="${i}" type="button">${esc(a.label)}</button>`).join('')}</div>` : ''}
      </div>`;
    root.appendChild(overlay);
    const done = (value) => { overlay.remove(); resolve(value); };
    if (typeof onMount === 'function') {
      try { onMount(overlay); } catch (e) { console.error('[modal onMount]', e); }
    }
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay && closable) return done(null);
      if (e.target.closest('[data-close]')) return done(null);
      const btn = e.target.closest('[data-act]');
      if (btn) {
        const action = actions[Number(btn.dataset.act)];
        if (action.keepOpen) { action.onClick?.(overlay, done); return; }
        const value = typeof action.value === 'function' ? action.value(overlay) : (action.value !== undefined ? action.value : btn.dataset.act);
        done(value);
      }
    });
    overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape' && closable) done(null); });
    const first = overlay.querySelector('input, textarea, select, [data-act]');
    if (first) setTimeout(() => first.focus(), 50);
  });
}

export function confirmDialog(title, message, okLabel = '确认') {
  return modal({
    title,
    body: `<p class="small muted" style="margin:0;line-height:1.7">${esc(message)}</p>`,
    actions: [{ label: '取消', value: false }, { label: okLabel, cls: 'btn-primary', value: true }]
  });
}

export function dateKey(d = new Date()) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

export function fmtDate(iso, withTime = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const base = `${d.getMonth() + 1}月${d.getDate()}日`;
  return withTime ? `${base} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : base;
}

export function durationText(ms) {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return '不到 1 分钟';
  if (m < 60) return `${m} 分钟`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

import { isNative, nativeSaveFile } from './bridge.js';

export function download(filename, content, mime = 'text/plain;charset=utf-8') {
  // APK 内：保存到手机 Downloads/WordWise 目录
  if (isNative()) {
    nativeSaveFile(filename, content, mime)
      .then(() => toast(`已保存：${filename}`, 'success'))
      .catch((e) => toast(`保存失败：${e.message}`, 'error'));
    return;
  }
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function pickFile(accept = 'image/*', capture = false) {
  return new Promise((resolve) => {
    const input = document.getElementById('globalFileInput');
    input.value = '';
    input.accept = accept;
    input.multiple = false;
    if (capture) input.setAttribute('capture', 'environment');
    else input.removeAttribute('capture');
    const done = (value) => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      resolve(value);
    };
    const onChange = () => done(input.files?.[0] || null);
    // 用户取消选择时部分浏览器不触发 change，必须监听 cancel，否则 Promise 永不 resolve 且监听器残留
    const onCancel = () => done(null);
    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    input.click();
  });
}

export function pickFiles(accept = 'image/*', multiple = true) {
  return new Promise((resolve) => {
    const input = document.getElementById('globalFileInput');
    input.value = '';
    input.accept = accept;
    input.multiple = multiple;
    input.removeAttribute('capture');
    const done = (value) => {
      input.removeEventListener('change', onChange);
      input.removeEventListener('cancel', onCancel);
      resolve(value);
    };
    const onChange = () => done([...(input.files || [])]);
    const onCancel = () => done([]);
    input.addEventListener('change', onChange);
    input.addEventListener('cancel', onCancel);
    input.click();
  });
}

export function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

export function parseLooseJSON(text) {
  if (typeof text !== 'string') return text;
  let s = text.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  try { return JSON.parse(s); } catch (_) { /* continue */ }
  const starts = ['{', '['];
  for (const start of starts) {
    const i = s.indexOf(start);
    if (i < 0) continue;
    let depth = 0, inStr = false, esc = false;
    for (let j = i; j < s.length; j++) {
      const c = s[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === '\\') esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') depth++;
      if (c === '}' || c === ']') {
        depth--;
        if (depth === 0) {
          try { return JSON.parse(s.slice(i, j + 1)); } catch (_) { break; }
        }
      }
    }
  }
  throw new Error('无法解析 AI 返回的 JSON');
}

export function uid(prefix = '') {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}
