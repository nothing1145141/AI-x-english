# -*- coding: utf-8 -*-
"""
WordWise 本地口语评测服务（Python 标准库，无必装依赖）

职责（与《plus.md》的语音架构对应，但先跑通最小闭环）：
  - 音频预处理：解码浏览器上传的 16k 单声道 WAV，做能量 VAD / 停顿统计
  - ASR：faster-whisper 可选（未安装则自动降级）
  - 发音评估：OpenPronounce 可选（通过 OPENPRONOUNCE_CMD 外部命令接入）；
    未接入时用「ASR 词置信度」作为发音分代理，并明确标注来源
  - TTS：Piper 可选（未安装返回 501，前端继续用浏览器 TTS）

设计约定：
  - 只监听 127.0.0.1，由 Node 端 /api/speech/* 代理，不直接暴露公网
  - 重依赖全部惰性加载：没装模型也能给出流利度 + 词级文本比对
  - 所有降级都在响应里写 warnings，不假装拥有音素级评测能力

启动：python speech/server.py  （端口默认 8792，可用 SPEECH_PORT 覆盖）
"""

import base64
import io
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HOST = os.environ.get("SPEECH_HOST", "127.0.0.1")
PORT = int(os.environ.get("SPEECH_PORT", "8792"))
MAX_BODY = 24 * 1024 * 1024  # 24MB，约 12 分钟 16k 单声道 WAV

TARGET_SR = 16000
WORD_RE = re.compile(r"[A-Za-z]+(?:['’\-][A-Za-z]+)*|\d+")

_profile_cache = None
_profile_lock = threading.Lock()
_asr_lock = threading.Lock()
_asr_state = {"model": None, "size": None, "device": None, "error": None, "loadedAt": 0}


# ---------------------------------------------------------------- 硬件画像
def _windows_memory_gb():
    try:
        import ctypes

        class MEMORYSTATUSEX(ctypes.Structure):
            _fields_ = [
                ("dwLength", ctypes.c_ulong),
                ("dwMemoryLoad", ctypes.c_ulong),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
            ]

        stat = MEMORYSTATUSEX()
        stat.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
        if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(stat)):
            return round(stat.ullTotalPhys / (1024 ** 3), 1)
    except Exception:
        pass
    return None


def _memory_gb():
    if os.name == "nt":
        return _windows_memory_gb()
    try:
        with open("/proc/meminfo", "r", encoding="utf-8") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    return round(int(line.split()[1]) / (1024 ** 2), 1)
    except Exception:
        pass
    return None


def _gpu_info():
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if out.returncode == 0 and out.stdout.strip():
            line = out.stdout.strip().splitlines()[0]
            parts = [p.strip() for p in line.split(",")]
            mem_mb = 0
            m = re.search(r"(\d+)", parts[-1]) if parts else None
            if m:
                mem_mb = int(m.group(1))
            return {"available": True, "name": parts[0], "memoryMb": mem_mb}
    except Exception:
        pass
    return {"available": False}


def recommend_whisper(profile):
    env = (os.environ.get("SPEECH_WHISPER") or "").strip().lower()
    if env in ("tiny", "base", "small", "medium", "large-v3"):
        return env
    gpu = profile.get("gpu") or {}
    ram = profile.get("memoryGb") or 0
    if gpu.get("available"):
        gb = (gpu.get("memoryMb") or 0) / 1024
        if gb >= 10:
            return "large-v3"
        if gb >= 6:
            return "medium"
        if gb >= 4:
            return "small"
        return "base"
    if ram >= 32:
        return "medium"
    if ram >= 16:
        return "small"
    if ram >= 8:
        return "base"
    return "tiny"


def get_profile():
    global _profile_cache
    with _profile_lock:
        if _profile_cache:
            return _profile_cache
        gpu = _gpu_info()
        cpu_count = os.cpu_count() or 2
        profile = {
            "platform": sys.platform,
            "python": sys.version.split()[0],
            "cpuCount": cpu_count,
            "cpuName": (os.environ.get("PROCESSOR_IDENTIFIER") or "")
            or (os.uname().machine if hasattr(os, "uname") else "")
            or "unknown",
            "memoryGb": _memory_gb(),
            "gpu": gpu,
            "diskFreeGb": round(shutil.disk_usage(os.path.abspath(".")).free / (1024 ** 3), 1),
            "recommendedWhisper": None,
            "ttsEngine": "piper" if _piper_ready() else None,
            "asrInstalled": _module_available("faster_whisper"),
            "pronounceHook": bool(os.environ.get("OPENPRONOUNCE_CMD")),
        }
        profile["recommendedWhisper"] = recommend_whisper(profile)
        _profile_cache = profile
        return profile


def _module_available(name):
    try:
        __import__(name)
        return True
    except Exception:
        return False


# ---------------------------------------------------------------- ASR
def _resolve_device():
    forced = (os.environ.get("SPEECH_DEVICE") or "auto").strip().lower()
    if forced in ("cpu", "cuda"):
        return forced
    return "cuda" if get_profile().get("gpu", {}).get("available") else "cpu"


def get_asr_model():
    """惰性加载 faster-whisper；不可用时返回 None 并记录原因。"""
    if (os.environ.get("SPEECH_ASR") or "auto").strip().lower() in ("off", "0", "false", "no"):
        _asr_state["error"] = "SPEECH_ASR=off"
        return None
    with _asr_lock:
        if _asr_state["model"] is not None:
            return _asr_state["model"]
        if not _module_available("faster_whisper"):
            _asr_state["error"] = "未安装 faster-whisper（可选依赖）"
            return None
        try:
            from faster_whisper import WhisperModel

            profile = get_profile()
            size = recommend_whisper(profile)
            device = _resolve_device()
            compute = (os.environ.get("SPEECH_COMPUTE_TYPE") or "").strip()
            if not compute:
                compute = "float16" if device == "cuda" else "int8"
            download_root = os.environ.get("SPEECH_MODEL_DIR") or os.path.join(
                os.path.dirname(os.path.abspath(__file__)), "models"
            )
            os.makedirs(download_root, exist_ok=True)
            _asr_state["error"] = None
            # 首次加载会下载模型，可能耗时较长；失败则永久降级本次运行
            model = WhisperModel(size, device=device, compute_type=compute, download_root=download_root)
            _asr_state.update(model=model, size=size, device=device, loadedAt=time.time())
            print(f"[speech] faster-whisper 已加载: {size} / {device} / {compute}", file=sys.stderr)
            return model
        except Exception as exc:
            _asr_state["error"] = f"ASR 加载失败: {exc}"
            print(f"[speech] {_asr_state['error']}", file=sys.stderr)
            return None


def run_asr(wav_path):
    model = get_asr_model()
    if model is None:
        return None, _asr_state.get("error") or "ASR 不可用"
    try:
        segments, info = model.transcribe(
            wav_path,
            language="en",
            beam_size=5,
            vad_filter=True,
            word_timestamps=True,
            condition_on_previous_text=False,
        )
        words = []
        texts = []
        for seg in segments:
            if seg.text:
                texts.append(seg.text.strip())
            for w in (seg.words or []):
                token = (w.word or "").strip()
                if not WORD_RE.search(token):
                    continue
                words.append({
                    "word": token,
                    "start": float(w.start or 0),
                    "end": float(w.end or 0),
                    "probability": float(getattr(w, "probability", 0) or 0),
                })
        return {
            "transcript": " ".join(t for t in texts if t).strip(),
            "words": words,
            "language": getattr(info, "language", "en"),
            "duration": float(getattr(info, "duration", 0) or 0),
            "model": f"faster-whisper/{_asr_state.get('size')}",
        }, None
    except Exception as exc:
        return None, f"ASR 识别失败: {exc}"


# ---------------------------------------------------------------- WAV / 音频分析
def read_wav_bytes(raw):
    """解析 WAV → (mono float list, sampleRate)。支持 8/16/32 bit PCM。"""
    with wave.open(io.BytesIO(raw), "rb") as wf:
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        rate = wf.getframerate()
        frames = wf.readframes(wf.getnframes())
    if width == 1:
        samples = [(b - 128) / 128.0 for b in frames]
    elif width == 2:
        import array

        arr = array.array("h")
        arr.frombytes(frames)
        samples = [v / 32768.0 for v in arr]
    elif width == 4:
        import array

        arr = array.array("i")
        arr.frombytes(frames)
        samples = [v / 2147483648.0 for v in arr]
    else:
        raise ValueError(f"不支持的采样位宽: {width * 8} bit")

    if channels > 1:
        samples = [
            sum(samples[i:i + channels]) / channels
            for i in range(0, len(samples) - channels + 1, channels)
        ]
    if rate != TARGET_SR and samples:
        samples = _resample(samples, rate, TARGET_SR)
        rate = TARGET_SR
    return samples, rate


def _resample(samples, src_rate, dst_rate):
    if src_rate == dst_rate or not samples:
        return samples
    ratio = dst_rate / src_rate
    new_len = max(1, int(len(samples) * ratio))
    out = []
    for i in range(new_len):
        pos = i / ratio
        i0 = int(pos)
        i1 = min(i0 + 1, len(samples) - 1)
        frac = pos - i0
        out.append(samples[i0] * (1 - frac) + samples[i1] * frac)
    return out


def analyze_audio(samples, rate):
    """能量 VAD + 停顿/语速/能量稳定性统计（纯原始音频，不依赖转写）。"""
    n = len(samples)
    duration_ms = int(n / rate * 1000) if rate else 0
    if n < rate * 0.2:
        return {
            "durationMs": duration_ms,
            "speechMs": 0,
            "voicedRatio": 0,
            "pauseCount": 0,
            "pauseRatio": 0,
            "wpm": 0,
            "rms": 0,
            "peak": 0,
            "energyCv": 0,
            "noSpeech": True,
        }

    frame = max(1, int(rate * 0.02))  # 20ms
    rms_list = []
    for i in range(0, n - frame + 1, frame):
        seg = samples[i:i + frame]
        rms_list.append(math.sqrt(sum(v * v for v in seg) / len(seg)))
    if not rms_list:
        rms_list = [0.0]

    ordered = sorted(rms_list)
    p10 = ordered[max(0, int(len(ordered) * 0.10) - 1)]
    p95 = ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]
    peak = max(rms_list)
    threshold = max(p10 * 2.2, p95 * 0.12, 0.0035)

    voiced = [r >= threshold for r in rms_list]
    voiced_idx = [i for i, v in enumerate(voiced) if v]
    if not voiced_idx:
        return {
            "durationMs": duration_ms,
            "speechMs": 0,
            "voicedRatio": 0,
            "pauseCount": 0,
            "pauseRatio": 0,
            "wpm": 0,
            "rms": round(peak, 4),
            "peak": round(peak, 4),
            "energyCv": 0,
            "noSpeech": True,
        }

    first, last = voiced_idx[0], voiced_idx[-1]
    span_frames = last - first + 1
    span_ms = span_frames * 20
    voiced_ms = len(voiced_idx) * 20

    pause_count = 0
    pause_ms = 0
    run = 0
    for i in range(first, last + 1):
        if not voiced[i]:
            run += 1
        else:
            if run >= 13:  # ≥260ms
                pause_count += 1
                pause_ms += run * 20
            run = 0

    mean_rms = sum(rms_list) / len(rms_list)
    if mean_rms > 1e-6:
        var = sum((r - mean_rms) ** 2 for r in rms_list) / len(rms_list)
        energy_cv = math.sqrt(var) / mean_rms
    else:
        energy_cv = 0

    return {
        "durationMs": duration_ms,
        "speechMs": max(0, span_ms),
        "voicedRatio": round(voiced_ms / span_ms, 3) if span_ms else 0,
        "pauseCount": pause_count,
        "pauseRatio": round(pause_ms / span_ms, 3) if span_ms else 0,
        "wpm": 0,
        "rms": round(mean_rms, 4),
        "peak": round(peak, 4),
        "energyCv": round(energy_cv, 3),
        "noSpeech": False,
    }


def rate_score(wpm):
    if not wpm:
        return None
    if 95 <= wpm <= 170:
        return 100
    if wpm < 95:
        return max(35, 100 - (95 - wpm) * 1.4)
    return max(45, 100 - (wpm - 170) * 0.9)


def fluency_score(metrics):
    rate = rate_score(metrics.get("wpm"))
    pause = 100 - metrics.get("pauseRatio", 0) * 160 - max(0, metrics.get("pauseCount", 0) - 3) * 5
    pause = max(30, min(100, pause))
    if rate is None:
        return round(pause)
    return round(rate * 0.58 + pause * 0.42)


# ---------------------------------------------------------------- 文本比对
def tokens(text):
    return WORD_RE.findall((text or "").lower())


def display_tokens(text):
    return WORD_RE.findall(text or "")


def align(reference, heard):
    """LCS 对齐，返回命中的 reference/heard 下标集合。"""
    n, m = len(reference), len(heard)
    dp = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n - 1, -1, -1):
        row, nxt = dp[i], dp[i + 1]
        for j in range(m - 1, -1, -1):
            if reference[i] == heard[j]:
                row[j] = nxt[j + 1] + 1
            else:
                row[j] = nxt[j] if nxt[j] >= row[j + 1] else row[j + 1]
    hit_ref, hit_heard = set(), set()
    i = j = 0
    while i < n and j < m:
        if reference[i] == heard[j]:
            hit_ref.add(i)
            hit_heard.add(j)
            i += 1
            j += 1
        elif dp[i + 1][j] >= dp[i][j + 1]:
            i += 1
        else:
            j += 1
    return hit_ref, hit_heard


# ---------------------------------------------------------------- OpenPronounce 插件
def run_openpronounce(wav_path, reference):
    """外部音素级评测命令：stdin 传 JSON，stdout 返回 JSON。
    约定返回 {"score": 0-100, "words": [{"text": "...", "score": 0-100,
             "phonemes": [{"phoneme": "θ", "score": 0-100, "tip": "..."}]}], "notes": []}
    """
    cmd = os.environ.get("OPENPRONOUNCE_CMD")
    if not cmd:
        return None
    try:
        payload = json.dumps({"audioPath": wav_path, "reference": reference}, ensure_ascii=False)
        out = subprocess.run(
            cmd, shell=True, input=payload.encode("utf-8"),
            capture_output=True, timeout=45,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if out.returncode != 0:
            return None
        data = json.loads(out.stdout.decode("utf-8", "ignore") or "{}")
        if not isinstance(data, dict):
            return None
        return data
    except Exception:
        return None


# ---------------------------------------------------------------- TTS
def _piper_ready():
    bin_path = os.environ.get("PIPER_BIN") or "piper"
    if shutil.which(bin_path) or os.path.exists(bin_path):
        return True
    return False


def piper_tts(text):
    model = os.environ.get("PIPER_MODEL")
    bin_path = os.environ.get("PIPER_BIN") or "piper"
    if not _piper_ready():
        return None, "Piper 未安装（设置 PIPER_BIN / PIPER_MODEL 后可用）"
    if not model or not os.path.exists(model):
        return None, "未配置 Piper 模型（环境变量 PIPER_MODEL）"
    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    try:
        proc = subprocess.run(
            [bin_path, "--model", model, "--output_file", tmp.name],
            input=(text or "").encode("utf-8"),
            capture_output=True, timeout=60,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if proc.returncode != 0 or not os.path.getsize(tmp.name):
            return None, "Piper 合成失败"
        with open(tmp.name, "rb") as f:
            return base64.b64encode(f.read()).decode("ascii"), None
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


# ---------------------------------------------------------------- 评测主流程
def assess(payload):
    reference = (payload.get("reference") or "").strip()
    mode = payload.get("mode") or ("shadow" if reference else "free")
    browser_transcript = (payload.get("browserTranscript") or "").strip()
    audio_b64 = payload.get("audio") or ""

    warnings = []
    if not audio_b64:
        return {"ok": False, "error": "缺少音频数据"}

    try:
        raw = base64.b64decode(audio_b64)
        if not raw:
            raise ValueError("音频为空")
        samples, rate = read_wav_bytes(raw)
    except Exception as exc:
        return {"ok": False, "error": f"音频解析失败: {exc}"}

    metrics = analyze_audio(samples, rate)
    duration_ms = metrics["durationMs"]

    wav_path = None
    try:
        wav_path = _write_temp_wav(samples, rate)
        asr_result, asr_error = run_asr(wav_path)

        transcript = ""
        asr_words = []
        asr_used = False
        if asr_result and (asr_result.get("transcript") or asr_result.get("words")):
            transcript = asr_result["transcript"]
            asr_words = asr_result.get("words") or []
            asr_used = True
        elif browser_transcript:
            transcript = browser_transcript
            warnings.append("本地 ASR 未启用，词级比对使用浏览器语音识别结果（辅助参考）。")
        else:
            warnings.append("本地 ASR 未启用且浏览器无转写结果：本次只给出流利度与韵律评分。")
            if asr_error:
                warnings.append(asr_error)

        if metrics.get("noSpeech"):
            warnings.append("录音中几乎没有检测到人声，请检查麦克风或环境噪音。")

        ref_display = display_tokens(reference)
        ref_tokens = tokens(reference)
        heard_tokens = tokens(transcript)

        heard_count_for_rate = len(heard_tokens) or len(ref_tokens)
        if metrics.get("speechMs", 0) > 400 and heard_count_for_rate:
            metrics["wpm"] = round(heard_count_for_rate / (metrics["speechMs"] / 60000.0))

        accuracy = completeness = None
        words_out = []
        extra = []
        pron_source = None
        pronunciation = None

        if mode == "free":
            status_tokens = heard_tokens
            words_out = [
                {"text": t, "status": "ok", "confidence": None, "phonemes": []}
                for t in status_tokens
            ]
            acc_map = {}
            prob_map = {}
            if asr_words:
                # 自由说：按出现顺序对齐 ASR 词，取置信度
                idx = 0
                for item in words_out:
                    while idx < len(asr_words) and tokens(asr_words[idx]["word"])[:1] != [item["text"]]:
                        idx += 1
                    if idx < len(asr_words):
                        item["confidence"] = round(asr_words[idx]["probability"], 3)
                        idx += 1
            if asr_words:
                probs = [w["probability"] for w in asr_words if w.get("probability") is not None]
                if probs:
                    pronunciation = round(sum(probs) / len(probs) * 100)
                    pron_source = "asr-confidence"
                    warnings.append("发音分为 ASR 词置信度代理值，仅作趋势参考；接入 OpenPronounce 后可得到音素级评分。")
        elif reference:
            if heard_tokens:
                hit_ref, hit_heard = align(ref_tokens, heard_tokens)
                confidence_by_index = _confidence_by_index(ref_tokens, asr_words, hit_ref, asr_used)
                for i, token in enumerate(ref_tokens):
                    matched = i in hit_ref
                    conf = confidence_by_index.get(i)
                    if matched:
                        status = "weak" if (conf is not None and conf < 0.55) else "ok"
                    else:
                        status = "miss"
                    words_out.append({
                        "text": ref_display[i] if i < len(ref_display) else token,
                        "status": status,
                        "confidence": conf,
                        "phonemes": [],
                    })
                extra = [heard_tokens[j] for j in range(len(heard_tokens)) if j not in hit_heard][:20]
                completeness = round(len(hit_ref) / len(ref_tokens) * 100) if ref_tokens else None
                accuracy = round(len(hit_ref) / len(heard_tokens) * 100) if heard_tokens else None
                accuracy = min(100, accuracy)
                if asr_used:
                    probs = [w["probability"] for w in asr_words if w.get("probability") is not None]
                    if probs:
                        pronunciation = round(sum(probs) / len(probs) * 100)
                        pron_source = "asr-confidence"
                        warnings.append("发音分为 ASR 词置信度代理值；音素级发音分需接入 OpenPronounce。")
            else:
                words_out = [
                    {"text": ref_display[i] if i < len(ref_display) else t,
                     "status": "unknown", "confidence": None, "phonemes": []}
                    for i, t in enumerate(ref_tokens)
                ]
                completeness = 0
                accuracy = 0
                warnings.append("未获得转写结果，无法判断逐词完整度/准确度。")
        else:
            warnings.append("跟读模式缺少目标文本，已按自由说处理。")

        # OpenPronounce 插件：接入后覆盖音素级结果
        if wav_path:
            pron = run_openpronounce(wav_path, reference)
            if pron:
                pronunciation = _clamp_score(pron.get("score"))
                pron_source = "openpronounce"
                _merge_phonemes(words_out, pron.get("words"))
                for note in (pron.get("notes") or [])[:5]:
                    warnings.append(str(note))
            elif pron_source == "asr-confidence":
                pass

        fluency = fluency_score(metrics)

        parts = []
        if accuracy is not None:
            parts.append((accuracy, 0.34))
        if completeness is not None:
            parts.append((completeness, 0.3))
        parts.append((fluency, 0.22))
        if pronunciation is not None:
            parts.append((pronunciation, 0.14))
        weight_sum = sum(w for _, w in parts)
        overall = round(sum(v * w for v, w in parts) / weight_sum) if weight_sum else 0

        suggestions = _suggestions(scores={"accuracy": accuracy, "completeness": completeness,
                                           "fluency": fluency, "pronunciation": pronunciation},
                                   metrics=metrics, words=words_out, extra=extra,
                                   transcript=transcript, warnings=warnings)

        engine_bits = ["prosody"]
        if asr_used:
            engine_bits.append("faster-whisper")
        elif browser_transcript and transcript:
            engine_bits.append("browser-asr")
        if pron_source == "openpronounce":
            engine_bits.append("openpronounce")

        return {
            "ok": True,
            "mode": mode,
            "engine": "+".join(engine_bits),
            "durationMs": duration_ms,
            "transcript": transcript,
            "asr": {
                "used": asr_used,
                "engine": (asr_result or {}).get("model") if asr_used else None,
                "error": None if asr_used else asr_error,
                "browserFallback": bool(transcript) and not asr_used,
            },
            "pronunciationSource": pron_source,
            "scores": {
                "overall": overall,
                "accuracy": accuracy,
                "completeness": completeness,
                "fluency": fluency,
                "pronunciation": pronunciation,
            },
            "words": words_out,
            "extra": extra,
            "metrics": {
                "wpm": metrics.get("wpm"),
                "pauseCount": metrics.get("pauseCount"),
                "pauseRatio": metrics.get("pauseRatio"),
                "voicedRatio": metrics.get("voicedRatio"),
                "speechMs": metrics.get("speechMs"),
                "durationMs": duration_ms,
                "energyCv": metrics.get("energyCv"),
            },
            "suggestions": suggestions,
            "warnings": _dedupe(warnings),
        }
    finally:
        if wav_path:
            try:
                os.unlink(wav_path)
            except OSError:
                pass


def _confidence_by_index(ref_tokens, asr_words, hit_ref, asr_used):
    if not asr_used or not asr_words:
        return {}
    out = {}
    j = 0
    for i in sorted(hit_ref):
        token = ref_tokens[i]
        while j < len(asr_words) and tokens(asr_words[j]["word"])[:1] != [token]:
            j += 1
        if j < len(asr_words):
            out[i] = round(asr_words[j].get("probability") or 0, 3)
            j += 1
    return out


def _merge_phonemes(words_out, pron_words):
    if not isinstance(pron_words, list):
        return
    for i, item in enumerate(words_out):
        if i >= len(pron_words):
            break
        src = pron_words[i] or {}
        score = _clamp_score(src.get("score"))
        if score is not None:
            item["score"] = score
            if item["status"] == "ok" and score < 60:
                item["status"] = "weak"
        phonemes = src.get("phonemes")
        if isinstance(phonemes, list):
            item["phonemes"] = [
                {
                    "phoneme": str(p.get("phoneme") or ""),
                    "score": _clamp_score(p.get("score")),
                    "tip": str(p.get("tip") or ""),
                }
                for p in phonemes[:6] if isinstance(p, dict)
            ]


def _clamp_score(v):
    if v is None:
        return None
    try:
        return max(0, min(100, round(float(v))))
    except (TypeError, ValueError):
        return None


def _suggestions(scores, metrics, words, extra, transcript, warnings):
    out = []
    missed = [w["text"] for w in words if w["status"] == "miss"]
    weak = [w["text"] for w in words if w["status"] == "weak"]
    if missed:
        out.append("漏读或识别偏差：" + "、".join(missed[:5]) + ("…" if len(missed) > 5 else ""))
    if weak:
        out.append("这些词识别置信度偏低，注意吐字：" + "、".join(weak[:5]))
    if extra and transcript:
        out.append("多读/插入：" + "、".join(extra[:4]))
    wpm = metrics.get("wpm") or 0
    if wpm and wpm < 80:
        out.append(f"语速偏慢（约 {wpm} 词/分），先按意群分组再连起来读。")
    elif wpm > 190:
        out.append(f"语速偏快（约 {wpm} 词/分），句末注意降调并留出停顿。")
    if (metrics.get("pauseCount") or 0) >= 4:
        out.append("停顿偏多，建议先大声朗读 2 遍熟悉节奏。")
    if scores.get("overall") is None:
        pass
    if not missed and not weak and wpm and 95 <= wpm <= 170:
        out.append("节奏稳定，继续保持句末降调和重音。")
    if not out:
        out.append("先完整听一遍示范，再整句跟读，避免逐词停顿。")
    return out[:5]


def _write_temp_wav(samples, rate):
    import array

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    arr = array.array("h")
    for v in samples:
        clamped = max(-1.0, min(1.0, v))
        arr.append(int(clamped * 32767))
    with wave.open(tmp.name, "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(rate)
        wf.writeframes(arr.tobytes())
    return tmp.name


def _dedupe(items):
    seen, out = set(), []
    for item in items:
        if item and item not in seen:
            seen.add(item)
            out.append(item)
    return out


# ---------------------------------------------------------------- HTTP
class Handler(BaseHTTPRequestHandler):
    server_version = "WordWiseSpeech/0.1"

    def log_message(self, fmt, *args):
        if os.environ.get("SPEECH_VERBOSE") == "1":
            print("[speech] " + (fmt % args), file=sys.stderr)

    def _send(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        if length > MAX_BODY:
            raise ValueError("请求体过大")
        return json.loads(self.rfile.read(length).decode("utf-8", "ignore") or "{}")

    def do_GET(self):
        if self.path == "/health":
            profile = get_profile()
            self._send(200, {
                "ok": True,
                "service": "wordwise-speech",
                "version": "0.1",
                "asr": {
                    "installed": profile["asrInstalled"],
                    "enabled": (os.environ.get("SPEECH_ASR") or "auto").lower() not in ("off", "0", "false", "no"),
                    "loaded": _asr_state["model"] is not None,
                    "model": _asr_state["size"] or profile["recommendedWhisper"],
                    "device": _asr_state["device"],
                    "error": _asr_state["error"],
                },
                "pronounce": {"hook": bool(os.environ.get("OPENPRONOUNCE_CMD"))},
                "tts": {"piper": _piper_ready()},
                "profile": profile,
            })
        elif self.path == "/profile":
            self._send(200, {"ok": True, "profile": get_profile()})
        else:
            self._send(404, {"ok": False, "error": "not found"})

    def do_POST(self):
        try:
            payload = self._read_json()
        except Exception as exc:
            self._send(400, {"ok": False, "error": f"请求体解析失败: {exc}"})
            return

        try:
            if self.path == "/assess":
                t0 = time.time()
                result = assess(payload)
                result["elapsedMs"] = int((time.time() - t0) * 1000)
                self._send(200 if result.get("ok") else 400, result)
            elif self.path == "/asr":
                audio_b64 = payload.get("audio") or ""
                if not audio_b64:
                    self._send(400, {"ok": False, "error": "缺少音频数据"})
                    return
                raw = base64.b64decode(audio_b64)
                samples, rate = read_wav_bytes(raw)
                wav_path = _write_temp_wav(samples, rate)
                try:
                    result, error = run_asr(wav_path)
                finally:
                    try:
                        os.unlink(wav_path)
                    except OSError:
                        pass
                if result is None:
                    self._send(503, {"ok": False, "error": error or "ASR 不可用"})
                else:
                    self._send(200, {"ok": True, **result})
            elif self.path == "/tts":
                audio, error = piper_tts(payload.get("text") or "")
                if not audio:
                    self._send(501, {"ok": False, "error": error})
                else:
                    self._send(200, {"ok": True, "audio": audio, "format": "wav"})
            elif self.path == "/unload":
                with _asr_lock:
                    _asr_state.update(model=None, size=None, device=None, loadedAt=0)
                self._send(200, {"ok": True})
            else:
                self._send(404, {"ok": False, "error": "not found"})
        except Exception as exc:
            traceback.print_exc()
            self._send(500, {"ok": False, "error": str(exc)})


def selftest():
    """生成一段合成语音跑通评测链路（不依赖 ASR / TTS）。"""
    import array

    rate = TARGET_SR
    samples = []
    for i in range(int(rate * 1.8)):
        t = i / rate
        # 0.15s 静音 + 0.5s 音 + 0.4s 停顿 + 0.5s 音 + 尾部静音
        env = 0.0
        if 0.15 <= t < 0.65 or 1.05 <= t < 1.55:
            env = 0.25 * math.sin(2 * math.pi * 180 * t)
        samples.append(env)
    wav = _write_temp_wav(samples, rate)
    try:
        with open(wav, "rb") as f:
            audio_b64 = base64.b64encode(f.read()).decode("ascii")
        result = assess({
            "audio": audio_b64,
            "reference": "The early bird catches the worm.",
            "mode": "shadow",
            "browserTranscript": "the early bird catches the worm",
        })
        assert result.get("ok"), result.get("error")
        assert result["scores"]["fluency"] > 0, result
        assert result["metrics"]["pauseCount"] >= 1, result
        print(f"  [自检] 流利度 {result['scores']['fluency']} | "
              f"词对 {len(result['words'])} | 停顿 {result['metrics']['pauseCount']} | "
              f"引擎 {result['engine']}")
        print("  [自检] 通过")
        return 0
    finally:
        try:
            os.unlink(wav)
        except OSError:
            pass


def main():
    if "--selftest" in sys.argv:
        sys.exit(selftest())
    profile = get_profile()
    print(
        f"[speech] WordWise 语音服务启动于 http://{HOST}:{PORT} | "
        f"whisper={profile['recommendedWhisper']} install={profile['asrInstalled']} "
        f"piper={profile['ttsEngine']} pron={profile['pronounceHook']}",
        file=sys.stderr,
    )
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    server.daemon_threads = True
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
