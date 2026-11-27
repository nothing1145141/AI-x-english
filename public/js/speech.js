// 浏览器录音 → 16k 单声道 WAV（供本地语音服务评测）。
// 同时可选用 Web Speech API 做「辅助转写」：仅用于词级比对，不冒充发音评估。
// 录音与转写都在本地完成，音频只发往本机 Node 服务。

const SR = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

let session = null;

export function micSupported() {
  return !!(
    typeof navigator !== 'undefined' &&
    navigator.mediaDevices &&
    navigator.mediaDevices.getUserMedia &&
    (window.AudioContext || window.webkitAudioContext)
  );
}

export function recorderSupported() {
  return typeof window.MediaRecorder !== 'undefined';
}

export function recognitionSupported() {
  return !!SR;
}

/** 把浏览器抛出的录音错误翻译成可操作提示 */
export function formatMicError(err) {
  const name = (err && err.name) || '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return '麦克风权限被拒绝：请点地址栏的锁图标允许麦克风后重试。';
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
    return '没有检测到麦克风设备，请检查耳机/麦克风连接。';
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return '麦克风被其它程序占用，请关闭会议/录音软件后重试。';
  }
  if (!window.isSecureContext) {
    return '当前页面不是安全上下文：请用 http://localhost 打开，或给局域网地址配置 HTTPS。';
  }
  return `无法启动录音：${(err && err.message) || name || '未知错误'}`;
}

function pickMime() {
  if (typeof MediaRecorder === 'undefined') return '';
  const list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  return list.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
}

/** 开始录音：返回 Promise，权限失败会 reject（用 formatMicError 展示） */
export async function startRecording({ onLevel, onTick } = {}) {
  if (session) throw new Error('录音已在进行中');
  if (!micSupported()) throw new Error('当前浏览器不支持录音（需要 getUserMedia / AudioContext）');
  if (!window.isSecureContext) {
    const e = new Error('需要安全上下文');
    e.name = 'SecurityError';
    throw e;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });

  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const ctx = new AudioCtx();
  await ctx.resume().catch(() => {});
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.6;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.fftSize);
  const startedAt = performance.now();
  let raf = 0;
  const loop = () => {
    if (!session || session.closed) return;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    try { onLevel && onLevel(rms); } catch (_) {}
    try { onTick && onTick(performance.now() - startedAt); } catch (_) {}
    raf = requestAnimationFrame(loop);
  };

  const chunks = [];
  let recorder = null;
  const mime = pickMime();
  if (recorderSupported()) {
    recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    recorder.start(250);
  }

  let recognition = null;
  let finalText = '';
  let interimText = '';
  let recognitionError = null;
  let recognitionEnded = null;
  if (SR) {
    try {
      recognition = new SR();
      recognition.lang = 'en-US';
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.onresult = (event) => {
        let interim = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const r = event.results[i];
          if (r.isFinal) finalText += ` ${r[0].transcript}`;
          else interim += r[0].transcript;
        }
        interimText = interim;
      };
      recognition.onerror = (event) => {
        recognitionError = event && event.error ? event.error : 'unknown';
      };
      recognition.onend = () => { recognitionEnded && recognitionEnded(); };
      recognition.start();
    } catch (err) {
      recognition = null;
      recognitionError = (err && err.message) || 'start-failed';
    }
  }

  session = {
    stream, ctx, source, analyser, recorder, chunks, mime,
    recognition, startedAt, raf, closed: false,
    get transcript() { return `${finalText} ${interimText}`.replace(/\s+/g, ' ').trim(); },
    get recognitionError() { return recognitionError; },
    waitRecognitionEnd(ms) {
      if (!recognition) return Promise.resolve();
      return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        recognitionEnded = () => { clearTimeout(timer); resolve(); };
      });
    }
  };
  loop();
  return { startedAt };
}

/** 停止录音 → 返回 { blobUrl, wavBase64, durationMs, transcript, recognitionError } */
export async function stopRecording() {
  if (!session) return null;
  const s = session;
  session = null;
  s.closed = true;
  cancelAnimationFrame(s.raf);
  const durationMs = Math.max(0, performance.now() - s.startedAt);

  if (s.recognition) {
    try { s.recognition.stop(); } catch (_) {}
    await s.waitRecognitionEnd(900);
    try { s.recognition.abort(); } catch (_) {}
  }

  const transcript = s.transcript;
  const recognitionError = s.recognitionError;

  let blob = null;
  if (s.recorder) {
    blob = await new Promise((resolve) => {
      const finish = () => resolve(new Blob(s.chunks, { type: s.mime || 'audio/webm' }));
      if (s.recorder.state === 'inactive') { finish(); return; }
      s.recorder.onstop = finish;
      try { s.recorder.stop(); } catch (_) { finish(); }
    });
  }

  s.stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
  try { await s.ctx.close(); } catch (_) {}

  let wavBase64 = '';
  let wavError = null;
  try {
    if (!blob || !blob.size) throw new Error('没有录到音频数据');
    wavBase64 = await blobToWavBase64(blob);
  } catch (err) {
    wavError = err.message || String(err);
  }

  return {
    blobUrl: blob && blob.size ? URL.createObjectURL(blob) : '',
    wavBase64,
    wavError,
    durationMs,
    transcript,
    recognitionError
  };
}

/** 取消录音（不发评测） */
export function cancelRecording() {
  if (!session) return;
  const s = session;
  session = null;
  s.closed = true;
  cancelAnimationFrame(s.raf);
  if (s.recognition) { try { s.recognition.abort(); } catch (_) {} }
  if (s.recorder && s.recorder.state !== 'inactive') { try { s.recorder.stop(); } catch (_) {} }
  s.stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
  try { s.ctx.close(); } catch (_) {}
}

export function isRecording() {
  return !!session;
}

/* ---------------- 解码 / 重采样 / WAV 编码 ---------------- */
async function blobToWavBase64(blob) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const decodeCtx = new AudioCtx();
  let decoded;
  try {
    const arrayBuffer = await blob.arrayBuffer();
    decoded = await new Promise((resolve, reject) => {
      const p = decodeCtx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
  } finally {
    try { decodeCtx.close(); } catch (_) {}
  }

  const targetRate = 16000;
  const frames = Math.max(1, Math.ceil(decoded.duration * targetRate));
  let rendered;
  if (decoded.sampleRate === targetRate && decoded.numberOfChannels === 1) {
    rendered = decoded;
  } else {
    const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OfflineCtx(1, frames, targetRate);
    const node = off.createBufferSource();
    node.buffer = decoded;
    node.connect(off.destination);
    node.start(0);
    rendered = await off.startRendering();
  }

  const pcm = rendered.getChannelData(0);
  const buffer = new ArrayBuffer(44 + pcm.length * 2);
  const view = new DataView(buffer);
  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + pcm.length * 2, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, targetRate, true);
  view.setUint32(28, targetRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, pcm.length * 2, true);
  let offset = 44;
  for (let i = 0; i < pcm.length; i++) {
    const v = Math.max(-1, Math.min(1, pcm[i]));
    view.setInt16(offset, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    offset += 2;
  }
  return base64FromBytes(new Uint8Array(buffer));
}

function base64FromBytes(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
