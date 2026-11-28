import { getSettings, setSettings, getState, replaceAll } from '../store.js';
import { listModels, testConnection } from '../ai.js';
import { requestPermission, subscribePush, unsubscribePush, syncPushSettings, testPush, showNotification, getPermissionStatus, openNotificationSettings } from '../reminder.js';
import { icon, esc, toast, modal, confirmDialog, pickFile, pickFiles, readAsDataURL, download } from '../ui.js';
import { isNative } from '../bridge.js';
import { nlpStatus } from '../nlp.js';
import { refresh } from '../router.js';
import { mdxStatus, uploadMdxFile, importMdx, deleteMdxDict, formatBytes, clearMdxCache } from '../mdx.js';
import { ttsAvailable, englishVoices, getVoiceURI, setVoice, getRate, setRate, speak, RATE_OPTIONS, onVoicesReady } from '../tts.js';

export const title = '设置';
export const subtitle = 'API Key、本地 NLP、朗读、提醒与数据管理';

let models = [];
let modelLoading = false;
let perm = 'default';
let permLoaded = false;
let nlpState = null;
let mdxDicts = [];
let mdxLoaded = false;
let mdxLib = true;
let mdxBusy = null;   // { phase, pct, detail }
let lanInfo = null;   // { port, host, lan, hostname, primary, addresses }
let cloudCfg = null;  // /api/config（含 cloud 标记）
let voiceWired = false;

export function render() {
  if (!permLoaded) {
    permLoaded = true;
    getPermissionStatus().then((p) => { perm = p; refresh(); });
    nlpStatus().then((r) => { nlpState = r; refresh(); });
  }
  if (cloudCfg === null) {
    cloudCfg = { loading: true };
    fetch('/api/config', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : {}))
      .then((d) => { cloudCfg = d || {}; refresh(); })
      .catch(() => { cloudCfg = {}; });
  }
  if (!mdxLoaded) {
    mdxLoaded = true;
    mdxStatus().then((r) => { mdxDicts = r.dicts || []; mdxLib = r.available !== false; refresh(); });
  }
  if (lanInfo === null) {
    lanInfo = { loading: true };
    fetch('/api/net', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { lanInfo = d && d.ok ? d : { lan: false, error: true }; })
      .catch(() => { lanInfo = { lan: false, error: true }; })
      .finally(() => refresh());
  }
  const s = getSettings();
  const state = getState();
  const isCloud = !!(cloudCfg && cloudCfg.cloud);
  const voices = ttsAvailable() ? englishVoices() : [];
  const ttsVoiceURI = getVoiceURI();
  const ttsRate = getRate();
  return `
    <div class="grid grid-2">
      <div>
      <section class="card">
        <div class="card-head"><div><h2>AI 接口配置</h2><div class="sub">支持自定义 API Key 与兼容 OpenAI 的网关</div></div>${icon('sparkles', 18)}</div>
        ${isCloud ? `<div class="feedback" style="margin-bottom:12px">${icon('info', 13)} 云端部署已内置网关与 Key，默认 Key 模式开箱可用；切到「使用我的 Key」可覆盖为自己的网关。</div>` : ''}
        <div class="field"><label>接口模式</label>
          <div class="row">
            <label class="row small" style="gap:7px"><input type="radio" name="apiMode" value="server" ${s.apiMode === 'server' ? 'checked' : ''} data-setting="apiMode" /> ${isNative() ? '内置默认 Key' : '服务端默认 Key'}</label>
            <label class="row small" style="gap:7px"><input type="radio" name="apiMode" value="custom" ${s.apiMode === 'custom' ? 'checked' : ''} data-setting="apiMode" /> 使用我的 Key</label>
          </div>
          <div class="tiny muted mt8">${icon('shield', 12)} ${isNative() ? '内置 Key 已随 App 预置，可直接用；切换到“我的 Key”可填自己的网关。' : '自定义 Key 会随请求发送到本地服务端代理，不会写入浏览器之外的位置。'}</div>
        </div>
        <div class="field"><label>API Base URL</label><input class="input" data-setting="customApiBase" value="${esc(s.customApiBase)}" placeholder="https://your-gateway/v1" ${s.apiMode !== 'custom' ? 'disabled' : ''} /></div>
        <div class="field"><label>API Key</label><input class="input" type="password" data-setting="customApiKey" value="${esc(s.customApiKey)}" placeholder="sk-..." ${s.apiMode !== 'custom' ? 'disabled' : ''} /></div>
        <div class="field"><label>出题模型</label><input class="input" data-setting="textModel" list="modelList" value="${esc(s.textModel)}" /><span class="tiny muted">负责试卷生成与学习建议</span></div>
        <div class="field"><label>视觉 / OCR 模型</label><input class="input" data-setting="visionModel" list="modelList" value="${esc(s.visionModel)}" /><span class="tiny muted">需支持图片输入</span></div>
        <div class="field"><label>批改模型</label><input class="input" data-setting="gradingModel" list="modelList" value="${esc(s.gradingModel)}" /></div>
        <datalist id="modelList">${models.map((m) => `<option value="${esc(m.id)}">${m.vision ? '支持视觉' : '仅文本'}${m.json ? ' · JSON' : ''}</option>`).join('')}</datalist>
        <div class="row">
          <button class="btn" data-action="loadModels" ${modelLoading ? 'disabled' : ''}>${modelLoading ? '<span class="loading"></span> 加载中…' : `${icon('refresh', 14)} 刷新模型列表`}</button>
          <button class="btn btn-primary" data-action="testApi">${icon('sparkles', 14)} 测试连接</button>
        </div>
        ${models.length ? `<div class="tiny muted mt12">可用模型 ${models.length} 个${models.filter((m) => m.vision).length ? `，其中 ${models.filter((m) => m.vision).length} 个支持视觉识别` : ''}。</div>` : ''}
      </section>

      <section class="card mt16">
        <div class="card-head"><div><h2>本地 NLP 句法引擎</h2><div class="sub">先分析句法骨架，再交给 AI 校准讲解</div></div>${icon('layers', 18)}</div>
        <div class="spread">
          <div><strong class="small">状态</strong>
            <div class="tiny muted">${isCloud ? '云端不提供本地句法服务，讲解直接由 AI 完成' : nlpState === null ? '检测中…' : nlpState.available ? '已就绪 · spaCy 本地运行，无需联网' : '未启用 · 将降级为纯 LLM 模式'}</div></div>
          <span class="pill ${isCloud ? 'success' : nlpState?.available ? 'success' : 'warn'}">${isCloud ? 'AI 模式' : nlpState === null ? '…' : nlpState.available ? '运行中' : '未启用'}</span>
        </div>
        <div class="feedback mt12">${icon('info', 13)} ${isCloud ? '云端版本不运行 Python，句法参考由大模型直接完成，阅读与讲解功能不受影响。' : '引擎在句子讲解/全文分析/划词翻译前先做分词、词形还原、词性与依存句法分析，将确定性结果作为参考注入 AI，减少主干误判与从句漏判。若 Python spaCy 未安装，应用会自动降级，不影响其他功能。'}</div>
        ${isCloud ? '' : `<div class="row mt12"><button class="btn btn-sm" data-action="testNlp">${icon('sparkles', 13)} 测试句法分析</button></div>`}
      </section>
      </div>

      <div>
        <section class="card">
          <div class="card-head"><div><h2>每日学习设置</h2><div class="sub">组卷题量与默认节奏</div></div>${icon('calendar', 18)}</div>
          <div class="field"><label>每日试卷题量</label>
            <select class="select" data-setting="dailyCount">
              ${[6, 8, 10, 12, 15, 20].map((n) => `<option value="${n}" ${Number(s.dailyCount) === n ? 'selected' : ''}>${n} 题</option>`).join('')}
            </select>
          </div>
          <div class="feedback">${icon('info', 14)} 系统优先安排待复习词与掌握度低的词，答对后自动拉长复习间隔，答错则 10 分钟后重排。</div>
        </section>

        <section class="card mt16">
          <div class="card-head"><div><h2>朗读</h2><div class="sub">用系统自带语音读单词、句子和整篇文章，零依赖、不下载模型、不联网</div></div>${icon('volume', 18)}</div>
          ${ttsAvailable() ? `
            <div class="spread">
              <div><strong class="small">朗读引擎</strong>
                <div class="tiny muted">${voices.length ? `系统里有 ${voices.length} 个英文语音可选` : '正在读取系统语音列表…（首次可能要等一下）'}</div></div>
              <span class="pill success">可用</span>
            </div>
            <div class="field mt16"><label>英文语音</label>
              <select class="select" data-tts-setting="voice">
                <option value="">自动选择（推荐）</option>
                ${voices.map((v) => `<option value="${esc(v.voiceURI)}" ${v.voiceURI === ttsVoiceURI ? 'selected' : ''}>${esc(v.name)} · ${esc(v.lang)}${v.localService ? '' : ' · 在线'}</option>`).join('')}
              </select>
              <span class="tiny muted">列表来自系统已安装的语音包；手机可在系统「设置 → 辅助功能 / 语言」里下载英文语音</span>
            </div>
            <div class="field"><label>语速</label>
              <select class="select" data-tts-setting="rate">
                ${RATE_OPTIONS.map(([v, label]) => `<option value="${v}" ${Math.abs(ttsRate - v) < 0.01 ? 'selected' : ''}>${label}（${v}×）</option>`).join('')}
              </select>
            </div>
            <div class="row mt12">
              <button class="btn" data-action="ttsTest">${icon('volume', 14)} 试听</button>
              <span class="tiny muted">正文每句、词库每个词后面都有「听」，再点一次停止</span>
            </div>
          ` : `<div class="feedback mt12">${icon('info', 14)} 当前浏览器不支持 speechSynthesis，换 Chrome / Edge / Safari 即可使用朗读。</div>`}
        </section>

        <section class="card mt16">
          <div class="card-head"><div><h2>每日提醒</h2><div class="sub">${isNative() ? '系统通知 + 定时闹钟（关闭 App 也生效）' : '应用内通知 + Web Push'}</div></div>${icon('bell', 18)}</div>
          <div class="spread"><div><strong class="small">开启每日提醒</strong><div class="tiny muted">到点推送一条学习提示</div></div>
            <label class="switch"><input type="checkbox" data-setting="reminderEnabled" ${s.reminderEnabled ? 'checked' : ''} /><i></i></label></div>
          <div class="field mt16"><label>提醒时间</label><input class="input" type="time" data-setting="reminderTime" value="${esc(s.reminderTime)}" /></div>
          <div class="row">
            <button class="btn" data-action="permission">${icon('bell', 14)} 通知权限：${{ granted: '已授予', denied: '已拒绝', default: '未申请', unsupported: '不支持' }[perm] || perm}</button>
            ${isNative()
              ? `<button class="btn" data-action="openNotifySettings">${icon('gear', 14)} 系统通知设置</button>`
              : isCloud
                ? ''
                : `<button class="btn" data-action="togglePush">${icon('shield', 14)} ${s.pushSubscribed ? '关闭后台推送' : '开启后台推送'}</button>`}
            <button class="btn" data-action="testNotify">测试通知</button>
          </div>
          <div class="feedback mt16">${icon('info', 14)} ${isCloud ? '云端部署暂不支持后台推送；打开页面时仍会按设定时间弹出应用内提醒。' : isNative() ? '提醒由系统闹钟触发，即使关闭 App 也会准时通知。首次使用请先授予通知权限。' : '后台推送需要 HTTPS（或 localhost）与 PWA 安装；纯局域网 HTTP 下仍可在应用打开时收到本地提醒。'}</div>
        </section>

        <section class="card mt16" style="${isCloud ? 'display:none' : ''}">
          <div class="card-head"><div><h2>局域网访问</h2><div class="sub">手机、平板或另一台电脑连同一个 Wi-Fi，就能打开同一份数据</div></div>${icon('wifi', 18)}</div>
          ${lanInfo && lanInfo.loading
            ? `<div class="tiny muted">正在检测网络…</div>`
            : lanInfo && lanInfo.lan
              ? `<div class="spread">
                  <div><strong class="small">内网地址</strong><div class="tiny muted">端口 ${lanInfo.port}${lanInfo.hostname ? ` · ${esc(lanInfo.hostname)}` : ''}</div></div>
                  <span class="pill success">已开放</span>
                </div>
                ${lanInfo.primary
                  ? `<div class="lan-url"><code>${esc(lanInfo.primary)}</code><button class="btn btn-sm" data-action="copyLan" data-url="${esc(lanInfo.primary)}">${icon('copy', 13)} 复制</button></div>`
                  : `<div class="feedback mt12">${icon('info', 14)} 未检测到内网 IP，请确认已连接 Wi-Fi 或网线。</div>`}
                ${(lanInfo.addresses || []).filter((a) => a.url !== lanInfo.primary).length
                  ? `<div class="tiny muted mt8">其它网卡：${(lanInfo.addresses || []).filter((a) => a.url !== lanInfo.primary).map((a) => `${esc(a.name)} ${esc(a.url)}`).join(' · ')}</div>`
                  : ''}
                <div class="feedback mt12">${icon('shield', 13)} 手机一直转圈多半是 Windows 防火墙拦了端口：双击项目里的 <code>lan-firewall.bat</code> 放行（会弹一次管理员确认）。要从外网访问，还得在路由器上把 ${lanInfo.port} 端口映射到本机。</div>`
              : `<div class="spread">
                  <div><strong class="small">仅本机可访问</strong><div class="tiny muted">${lanInfo && lanInfo.error ? '未连接到本地服务' : `当前监听 ${esc((lanInfo && lanInfo.host) || '127.0.0.1')}`}</div></div>
                  <span class="pill warn">未开放</span>
                </div>
                <div class="feedback mt12">${icon('info', 14)} 把 config.json 里的 <code>"host"</code> 改成 <code>0.0.0.0</code>（或启动时设 <code>HOST=0.0.0.0</code>）后重启服务，局域网设备即可访问。</div>`}
        </section>
      </div>
    </div>

    <section class="card mt16" style="${isCloud ? 'display:none' : ''}">
      <div class="card-head">
        <div><h2>MDX 词典</h2><div class="sub">导入 MDict 离线词典（.mdx 必需，.mdd 可选用于图片与样式），上传后立即可用，点词即查完整释义</div></div>
        ${icon('book', 18)}
      </div>
      ${mdxLib ? '' : `<div style="margin:0 0 14px;padding:10px 12px;border-left:2px solid var(--danger);background:transparent;color:var(--danger);font-size:12px;line-height:1.7">缺少解析依赖 js-mdict，请在项目目录执行 <code>npm install</code> 后重启服务</div>`}
      ${mdxDicts.length ? `<div>${mdxDicts.map((d) => `
        <div class="mdx-dict-row">
          <div class="mdx-dict-mark">${esc((d.title || d.name || '词').slice(0, 1))}</div>
          <div class="mdx-dict-main">
            <div class="mdx-dict-name">${esc(d.title || d.name)}</div>
            <div class="mdx-dict-meta">${esc(d.name)} · ${d.entries} 词条 · ${formatBytes(d.bytes)}${d.hasMdd ? ` · 含资源包 ${formatBytes(d.mddBytes)}` : ''} · ${esc(String(d.createdAt || '').slice(0, 10))}</div>
          </div>
          <button class="btn btn-sm" data-action="mdxDelete" data-id="${esc(d.id)}" data-name="${esc(d.title || d.name)}">删除</button>
        </div>`).join('')}</div>`
        : `<div class="empty" style="padding:26px 20px">
             ${icon('bookOpen', 26)}
             <h3>还没有导入词典</h3>
             <p>选一个 .mdx 文件导入即可离线查询，例如柯林斯、牛津高阶等 MDict 词典</p>
           </div>`}
      ${mdxBusy ? `<div class="mdx-progress" id="mdxProgress">
        <div class="row spread">
          <span class="mdx-progress-phase">${esc(mdxBusy.phase || '处理中…')}</span>
          <span class="tiny muted mdx-progress-detail">${esc(mdxBusy.detail || '')}</span>
        </div>
        <div class="mdx-progress-bar"><i style="width:${mdxBusy.pct || 0}%"></i></div>
      </div>` : ''}
      <div class="row mt12">
        <button class="btn btn-primary" data-action="mdxImport" ${mdxBusy ? 'disabled' : ''}>${icon('upload', 14)} 导入 MDX 词典</button>
        <span class="tiny muted">支持中文词典名称；上传后即时生效，可在句子里点任意单词查看</span>
      </div>
    </section>

    <section class="card mt16">
      <div class="card-head"><div><h2>数据管理</h2><div class="sub">${isNative() ? '数据保存在本机 App 存储（IndexedDB），支持备份导出与恢复' : '本地 IndexedDB + 服务端 data/store.json（含自动快照备份）'}</div></div>${icon('file', 18)}</div>
      <div class="grid grid-4 keep">
        <div class="stat-card"><div class="stat-label">单词</div><div class="stat-value">${state.words.length}</div></div>
        <div class="stat-card"><div class="stat-label">试卷</div><div class="stat-value">${state.quizzes.length}</div></div>
        <div class="stat-card"><div class="stat-label">作答记录</div><div class="stat-value">${state.attempts.length}</div></div>
        <div class="stat-card"><div class="stat-label">活跃天数</div><div class="stat-value">${state.activity.length}</div></div>
      </div>
      <div class="row mt16">
        <button class="btn" data-action="exportAll">${icon('download', 14)} 导出完整备份</button>
        <button class="btn" data-action="importBackup">${icon('upload', 14)} 从备份恢复</button>
        <button class="btn btn-danger" data-action="clearAll">${icon('trash', 14)} 清空所有数据</button>
      </div>
    </section>
  `;
}

export function mount() {
  const view = document.getElementById('view');

  // 系统语音列表是异步加载的（Chrome 首次要等 voiceschanged），就绪后再刷新一次下拉框
  if (!voiceWired) {
    voiceWired = true;
    onVoicesReady(() => refresh());
  }

  view.addEventListener('change', (e) => {
    const kind = e.target?.dataset?.ttsSetting;
    if (!kind) return;
    if (kind === 'voice') setVoice(e.target.value);
    if (kind === 'rate') setRate(Number(e.target.value));
  });

  if (!models.length && !modelLoading) {
    modelLoading = true;
    listModels().then((list) => { models = list; modelLoading = false; refresh(); })
      .catch(() => { modelLoading = false; });
  }

  view.addEventListener('change', async (e) => {
    const el = e.target;
    const key = el.dataset?.setting;
    if (!key) return;
    if (key === 'apiMode') { setSettings({ apiMode: el.value }); refresh(); return; }
    if (key === 'dailyCount') setSettings({ dailyCount: Number(el.value) });
    if (key === 'reminderEnabled') {
      setSettings({ reminderEnabled: el.checked });
      if (el.checked) {
        try { await requestPermission(); } catch (err) { toast(err.message, 'error'); }
      }
      await syncPushSettings();
      return;
    }
    if (key === 'customApiBase' || key === 'customApiKey' || key === 'textModel' || key === 'visionModel' || key === 'gradingModel' || key === 'reminderTime') {
      setSettings({ [key]: el.value });
      if (key === 'reminderTime') await syncPushSettings();
    }
  });

  view.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const a = btn.dataset.action;

    if (a === 'ttsTest') {
      speak('Reading slowly is a habit worth keeping.', { btn });
      return;
    }
    if (a === 'testNlp') {
      toast('正在分析测试句…', 'info');
      try {
        const r = await fetch('/api/nlp/analyze-sentence', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: 'The book that I bought yesterday, which was written by a famous author, is really fascinating.' })
        });
        const d = await r.json();
        if (!d.ok) throw new Error(d.error || 'NLP 不可用');
        await modal({
          title: '句法分析结果',
          wide: true,
          body: `<div class="feedback" style="white-space:pre-wrap;font-family:ui-monospace,Consolas,monospace;font-size:12px;line-height:1.7;max-height:55vh;overflow:auto">${esc(d.preview)}</div>`,
          actions: [{ label: '关闭', value: null }]
        });
      } catch (err) { toast(`测试失败：${err.message}`, 'error'); }
      return;
    }
    if (a === 'loadModels') {
      modelLoading = true; refresh();
      try { models = await listModels(); toast(`已加载 ${models.length} 个模型`, 'success'); }
      catch (err) { toast(`加载失败：${err.message}`, 'error'); }
      modelLoading = false; refresh(); return;
    }
    if (a === 'copyLan') {
      const ok = await copyText(btn.dataset.url || '');
      toast(ok ? '地址已复制，在手机上粘贴打开' : '复制失败，请手动长按选择地址', ok ? 'success' : 'warn');
      return;
    }
    if (a === 'testApi') {
      toast('正在测试…', 'info');
      try { const r = await testConnection(); toast(`连接正常：${r}`, 'success'); }
      catch (err) { toast(`连接失败：${err.message}`, 'error', 6000); }
      return;
    }
    if (a === 'permission') {
      try { await requestPermission(); toast('通知权限已就绪', 'success'); }
      catch (err) { toast(err.message, 'error'); }
      perm = await getPermissionStatus(); refresh(); return;
    }
    if (a === 'openNotifySettings') {
      await openNotificationSettings(); return;
    }
    if (a === 'togglePush') {
      try {
        if (getSettings().pushSubscribed) { await unsubscribePush(); toast('后台推送已关闭', 'success'); }
        else { await subscribePush(); toast('后台推送已开启', 'success'); }
      } catch (err) { toast(`操作失败：${err.message}`, 'error', 6000); }
      refresh(); return;
    }
    if (a === 'testNotify') {
      try { const msg = await testPush(); toast(msg, 'success'); }
      catch (err) { toast(`测试失败：${err.message}`, 'error'); }
      return;
    }
    if (a === 'showTest') { showNotification(); return; }
    if (a === 'mdxImport') {
      await importMdxFlow();
      return;
    }
    if (a === 'mdxDelete') {
      const name = btn.dataset.name || '该词典';
      const ok = await confirmDialog('删除词典', `将删除「${name}」的全部词条与资源文件，此操作不可撤销。`, '删除');
      if (!ok) return;
      try {
        await deleteMdxDict(btn.dataset.id);
        mdxDicts = (await mdxStatus(true)).dicts || [];
        toast('词典已删除', 'success');
      } catch (err) { toast(`删除失败：${err.message}`, 'error'); }
      refresh();
      return;
    }
    if (a === 'exportAll') {
      download(`wordwise-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(getState(), null, 2), 'application/json');
      toast('备份已下载', 'success'); return;
    }
    if (a === 'importBackup') {
      const file = await pickFile('application/json,.json');
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!Array.isArray(data.words)) throw new Error('不是有效的备份文件');
        const ok = await confirmDialog('恢复备份', `将用备份中的数据覆盖当前词库（${data.words.length} 个单词），确定继续吗？`, '覆盖恢复');
        if (!ok) return;
        await replaceAll(data);
        toast('备份已恢复', 'success');
      } catch (err) { toast(`恢复失败：${err.message}`, 'error'); }
      return;
    }
    if (a === 'clearAll') {
      const ok = await confirmDialog('清空所有数据', '将删除全部单词、试卷、作答记录与统计数据。建议先导出备份。此操作不可撤销。', '确认清空');
      if (!ok) return;
      await replaceAll({});
      toast('数据已清空', 'success');
    }
  });
}

/* ---------- 剪贴板（局域网地址复制，兼容 http 非安全上下文） ---------- */

async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (_) { /* 落到 execCommand */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch (_) {
    return false;
  }
}

/* ---------- MDX 导入 ---------- */

function paintBusy() {
  const box = document.getElementById('mdxProgress');
  if (!box || !mdxBusy) return;
  const phase = box.querySelector('.mdx-progress-phase');
  const detail = box.querySelector('.mdx-progress-detail');
  const bar = box.querySelector('.mdx-progress-bar i');
  if (phase) phase.textContent = mdxBusy.phase || '处理中…';
  if (detail) detail.textContent = mdxBusy.detail || '';
  if (bar) bar.style.width = `${Math.max(2, Math.min(100, mdxBusy.pct || 0))}%`;
}

async function importMdxFlow() {
  const files = await pickFiles('.mdx,.mdd', true);
  if (!files || !files.length) return;
  const mdxFile = files.find((f) => /\.mdx$/i.test(f.name));
  const mddFile = files.find((f) => /\.mdd$/i.test(f.name));
  if (!mdxFile) { toast('请选择 .mdx 文件（.mdd 为可选的资源包）', 'error', 5000); return; }

  mdxBusy = { phase: '上传 MDX…', pct: 5, detail: formatBytes(mdxFile.size) };
  refresh();
  try {
    const up = await uploadMdxFile(mdxFile, null);
    if (mddFile) {
      mdxBusy = { phase: '上传 MDD 资源…', pct: 12, detail: formatBytes(mddFile.size) };
      paintBusy();
      await uploadMdxFile(mddFile, up.token);
    }
    mdxBusy = { phase: '登记词典…', pct: 70, detail: '读取词条索引' };
    paintBusy();

    const meta = await importMdx(up.token);
    mdxBusy = { phase: '完成', pct: 100, detail: `${meta.entries} 条词条` };
    paintBusy();
    toast(`「${meta.title || meta.name}」已就绪，共 ${meta.entries} 条`, 'success', 5000);
    await new Promise((r) => setTimeout(r, 300));
  } catch (e) {
    toast(`导入失败：${e.message}`, 'error', 7000);
  } finally {
    mdxBusy = null;
    clearMdxCache();
    mdxDicts = (await mdxStatus(true)).dicts || [];
    refresh();
  }
}
