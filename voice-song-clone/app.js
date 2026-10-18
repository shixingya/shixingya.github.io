'use strict';

/* =====================================================================
 * 音色克隆 · 唱出你的声音
 * 纯原生 JS，无依赖、无构建、离线可用。
 *
 * 后端契约（不得更改字段名）：
 *   POST /api/convert   multipart/form-data
 *     reference        File  音色参考音频
 *     source           File  清唱音频
 *     semi_tone_shift  int   半音移调 -12 ~ +12
 *     diffusion_steps  int   扩散步数（默认 30）
 *     成功：audio/wav 二进制流；失败：JSON {"detail": "<中文错误信息>"}（4xx/5xx）
 *   POST /api/mp3       请求体为 WAV 二进制（Content-Type: audio/wav）
 *     成功：audio/mpeg 二进制流；失败：同上
 *   POST /api/analyze_timbre  multipart/form-data
 *     reference        File  音色参考音频（限 20MB / 60s）
 *     成功：JSON {"description","traits":[{"dim","label","phrase"}×5],
 *             "prompt_words","f0_median_hz","duration_sec"}；失败：同上
 *   POST /api/cover     multipart/form-data（翻唱歌曲模式）
 *     reference        File   音色参考音频（卡片①，必填）
 *     song_file        File   歌曲文件（与 song_url 二选一，都传/都没传后端 400）
 *     song_url         string 歌曲链接（与 song_file 二选一）
 *     semi_tone_shift  int    半音移调 -12 ~ +12（默认 0）
 *     auto_f0_adjust   bool   自动对齐音域（默认 false）
 *     成功：JSON {"job_id","message"}；失败：JSON {"detail"}（400/413/415/422）
 *   GET  /api/cover/status/{job_id}
 *     成功：JSON {"state","stage","progress","detail","error","queue_pos","total_sec"}
 *   GET  /api/cover/result/{job_id}
 *     成功：audio/wav 二进制；未完成 409 / 不存在 404：JSON {"detail"}
 *   GET  /api/cover/result/{job_id}?meta=1
 *     成功：JSON {"match_score":数字|null,"duration_sec":数字}（音色匹配度元信息）
 *   音色匹配度：/api/convert 成功响应头 X-Match-Score（数字字符串；缺失时不显示徽章）
 *   POST /api/voice/train  multipart/form-data（训练专属音色模型）
 *     voice_name     str    模型名（^[\w\u4e00-\u9fff-]{1,20}$）
 *     voice_files    File×N 训练素材（wav/mp3/m4a/flac/ogg，单文件≤50MB，有效时长合计≥3 分钟，建议≥10 分钟）
 *     total_epochs   int    训练轮数（默认 200，clamp 20~500）
 *     batch_size     int    批大小（默认 4，clamp 1~8）
 *     成功：JSON {"job_id","message"}；失败：JSON {"detail"}（400/413/415）
 *   GET  /api/voice/train/status/{job_id}
 *     成功：JSON {"state":"queued|running|done|failed","stage":"预处理|特征提取|训练|索引|完成",
 *             "progress":0-100,"log_tail":[最近~30 行日志（字符串数组）],"error":中文|null}
 *   GET  /api/voice/models
 *     成功：JSON {"models":[{"voice_name","builtin","status","trained_at",...}]}
 *     （seedvc_zero 内置零样本；训练模型含 trained_at，status: ready | missing）
 *   POST /api/convert 与 /api/cover 均新增 Form 字段：
 *     voice_model    string 声音模型名（默认 "seedvc_zero"）
 *     pitch_correct  bool   音准修正（仅零样本模型有效）
 *     选中训练模型（RVC）时 auto_f0_adjust / pitch_correct / diffusion_steps 被后端忽略；
 *     训练进行中发起转换 / 翻唱 → 429 {"detail":"模型训练中，请稍后再试"}
 *   POST /api/cover/remix/{job_id}  multipart/form-data（第四期：重混音）
 *     vocal_gain      float  人声音量 0.3~2.0（服务端 clamp，UI 侧同步限幅）
 *     mix_preset      string 可选混音预设（本期 UI 不提供，不发送）
 *     成功：audio/wav 二进制（重混成品，服务端已覆盖 cover.wav）+ X-Match-Score（有则带）；
 *     404 任务不存在/未完成/分轨缺失（旧任务无分轨）；400 mix_preset 非法：JSON {"detail"}
 *   GET  /api/cover/stems/{job_id}?stem=vocals|instrumental
 *     成功：audio/wav 二进制分轨；400/404 同上
 *   POST /api/analyze_timbre 响应新增（既有字段不变）：
 *     voice_class     string male_low|male_mid|male_high|female_mid|female_high
 *     range_span_st   number 音域跨度（半音，本期 UI 不展示）
 *   跨源部署：所有后端请求经 apiFetch 统一封装——URL = API_BASE + path，
 *     API_BASE / API Token 存于 localStorage（vsc_api_base / vsc_api_token，可为空）；
 *     配置了 token 时自动注入 X-API-Token 头；X-Match-Score 服务端已配 Expose-Headers。
 * ===================================================================== */

const $ = (sel, root = document) => root.querySelector(sel);

/* ---------------- 连接配置：API_BASE + API Token（第四期） ----------------
 * localStorage 读写经 store 封装：file:// 隐私模式等场景下访问可能抛异常，
 * 静默降级为不持久化，页面功能不受影响。
 * API_BASE 用 let：设置弹窗保存后需立即热更新生效（const 无法重新赋值）。 */
const store = {
  get(k) { try { return window.localStorage.getItem(k); } catch (_) { return null; } },
  set(k, v) { try { window.localStorage.setItem(k, v); } catch (_) { /* 存储不可用 */ } },
  del(k) { try { window.localStorage.removeItem(k); } catch (_) { /* 存储不可用 */ } },
};

let API_BASE = (store.get('vsc_api_base') || '').replace(/\/+$/, '');
function apiToken() { return store.get('vsc_api_token') || ''; }

/* 统一请求封装：所有后端请求必须走 apiFetch（跨源部署 + Token 注入）。
 * FormData 请求不手动设 Content-Type，浏览器自动携带 multipart boundary。 */
function apiFetch(path, opts = {}) {
  const headers = Object.assign({}, opts.headers || {});
  const token = apiToken();
  if (token) headers['X-API-Token'] = token;
  return fetch(API_BASE + path, Object.assign({}, opts, { headers }));
}

const state = {
  reference: null,   // File：音色参考
  source: null,      // File：清唱片段
  resultWav: null,   // Blob：转换结果 WAV
  resultKind: 'solo',// 'solo' 清唱 | 'cover' 翻唱（决定结果区徽章与导出文件名）
  converting: false,
  exporting: false,
};

/* 翻唱模式独立状态机：
 * idle → submitting（POST /api/cover）→ polling（queued/running 轮询）→ done | failed
 * 与清唱转换互斥：state.converting / cover.running 任一为真时，另一方禁止发起 */
const cover = {
  running: false,   // 翻唱任务进行中（提交 + 轮询全程）
  jobId: null,      // 后端任务 ID
  pollTimer: 0,     // 轮询 setTimeout 句柄
  netFails: 0,      // 连续网络失败计数（≥3 终止轮询）
  song: null,       // 歌曲来源：{type:'file',file,duration} | {type:'url',url}
  lastJobId: null,  // 最近一次成功提交的翻唱任务 ID（coverDoneFinish 清空 jobId 后仍保留，供重混音/分轨导出）
};

/* 声音模型状态：模型下拉 + 专属音色训练任务（与转换 / 翻唱三方互斥） */
const voice = {
  models: [],        // 最近一次 GET /api/voice/models 的 models 数组
  training: false,   // 训练任务进行中（提交 + 轮询全程；期间禁止转换 / 翻唱）
  jobId: null,       // 后端训练任务 ID
  pollTimer: 0,      // 轮询 setTimeout 句柄
  netFails: 0,       // 连续网络失败计数（≥3 终止轮询）
  lastTrained: '',   // 刚训练完成的模型名（刷新下拉时优先选中）
  files: [],         // 已选训练素材 [{file, duration}]
};

/* ---------------- 通用工具 ---------------- */

function pad(n) { return String(n).padStart(2, '0'); }

function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function fmtClock(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '--:--';
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${pad(m)}:${pad(s)}`;
}

function fmtSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '';
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function extFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.includes('webm')) return '.webm';
  if (m.includes('mp4') || m.includes('m4a')) return '.m4a';
  if (m.includes('ogg')) return '.ogg';
  if (m.includes('mpeg') || m.includes('mp3')) return '.mp3';
  if (m.includes('wav')) return '.wav';
  return '.webm';
}

/* 读取音频 Blob 时长（秒）；webm 可能返回 Infinity，跳转到末尾迫使浏览器计算。
 * 全局工具：录音卡片与翻唱歌曲文件共用 */
function probeDuration(blob) {
  return new Promise((resolve) => {
    let settled = false;
    let url = '';
    const finish = (d) => {
      if (settled) return;
      settled = true;
      if (url) URL.revokeObjectURL(url);
      resolve(d);
    };
    try { url = URL.createObjectURL(blob); } catch (_) { resolve(NaN); return; }
    const a = new Audio();
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      if (Number.isFinite(a.duration) && a.duration > 0) { finish(a.duration); return; }
      a.ontimeupdate = () => {
        a.ontimeupdate = null;
        finish(Number.isFinite(a.duration) && a.duration > 0 ? a.duration : NaN);
      };
      try { a.currentTime = 1e7; } catch (_) { finish(NaN); }
    };
    a.onerror = () => finish(NaN);
    window.setTimeout(() => finish(NaN), 6000);
    a.src = url;
  });
}

/* 统一错误解析：非 2xx 时按契约解析 {"detail": "..."} */
async function errorFromResponse(res, actionLabel) {
  let detail = '';
  try {
    const data = await res.json();
    if (data && typeof data.detail === 'string' && data.detail) detail = data.detail;
  } catch (_) { /* 响应体不是 JSON */ }
  const msg = detail ? `${actionLabel}失败：${detail}` : `${actionLabel}失败（HTTP ${res.status}）`;
  const err = new Error(msg);
  err.status = res.status;
  return err;
}

/* ---------------- Toast ---------------- */

function toast(msg, type = 'info', ms = 4500) {
  const box = $('#toasts');
  if (!box) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  window.setTimeout(() => {
    el.classList.add('out');
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }, ms);
}

/* ---------------- 图标与常量 ---------------- */

const ICONS = {
  play: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>',
  upload: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 15V4"/><path d="M7.5 8.5 12 4l4.5 4.5"/><path d="M4.5 15.5v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 12a8.5 8.5 0 1 1-2.49-6.01"/><path d="M20.5 3.5V8H16"/></svg>',
};

const FILE_ACCEPT = '.webm,.wav,.mp3,.m4a,.ogg,audio/webm,audio/wav,audio/x-wav,audio/wave,audio/mpeg,audio/mp4,audio/x-m4a,audio/ogg';

function flashMissing(card) {
  if (!card) return;
  card.classList.remove('missing');
  void card.offsetWidth; /* 重启动画 */
  card.classList.add('missing');
  window.setTimeout(() => card.classList.remove('missing'), 1600);
}

/* =====================================================================
 * 录音卡片（音色参考 / 清唱片段 共用一套逻辑）
 * 状态机：idle（待录音/上传）→ rec（录制中）→ done（已就绪）
 * 上传与录音二选一，后操作的覆盖先前的。
 * ===================================================================== */

function createRecorderCard({ stage, card, key, fileBase, onReady, onReset }) {
  let file = null;        // 就绪的 File 对象（同步写入 state[key]）
  let blobUrl = null;     // 试听 Blob URL
  let duration = NaN;     // 时长（秒）
  let fromUpload = false;

  let recorder = null;
  let chunks = [];
  let tickId = 0;
  let startAt = 0;
  let elapsed = 0;
  const audio = new Audio();

  stage.innerHTML = `
    <div class="view view-idle">
      <div class="idle-row">
        <button type="button" class="btn btn-rec js-start"><i class="rec-dot" aria-hidden="true"></i><span>开始录音</span></button>
        <label class="btn">${ICONS.upload}<span>从文件上传</span>
          <input type="file" class="js-file" accept="${FILE_ACCEPT}" hidden>
        </label>
      </div>
      <p class="up-note">支持 webm / wav / mp3 / m4a / ogg · 上传会覆盖已录内容</p>
    </div>

    <div class="view view-rec">
      <div class="live-row">
        <button type="button" class="btn btn-rec is-rec js-stop"><i class="rec-square" aria-hidden="true"></i><span>停止录音</span></button>
        <span class="rec-clock js-clock">00:00</span>
        <span class="eq" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
      </div>
      <p class="up-note">建议时长 10~30 秒 · 保持环境安静效果更佳</p>
    </div>

    <div class="view view-done">
      <div class="ready-line"><i class="ready-dot" aria-hidden="true"></i><span class="js-ready">已就绪</span></div>
      <div class="ready-sub js-sub"></div>
      <div class="rec-actions">
        <button type="button" class="btn js-play"><span class="js-play-ic">${ICONS.play}</span><span class="js-play-label">试听</span></button>
        <button type="button" class="btn js-rerec">${ICONS.refresh}<span>重录</span></button>
        <label class="btn">${ICONS.upload}<span>换文件</span>
          <input type="file" class="js-file" accept="${FILE_ACCEPT}" hidden>
        </label>
      </div>
    </div>`;

  const views = {
    idle: $('.view-idle', stage),
    rec: $('.view-rec', stage),
    done: $('.view-done', stage),
  };
  const clockEl = $('.js-clock', stage);
  const readyEl = $('.js-ready', stage);
  const subEl = $('.js-sub', stage);
  const playIc = $('.js-play-ic', stage);
  const playLabel = $('.js-play-label', stage);

  function show(name) {
    for (const k of Object.keys(views)) views[k].classList.toggle('show', k === name);
  }

  function setPlayUI(playing) {
    playIc.innerHTML = playing ? ICONS.pause : ICONS.play;
    playLabel.textContent = playing ? '暂停' : '试听';
  }

  audio.addEventListener('play', () => setPlayUI(true));
  audio.addEventListener('pause', () => setPlayUI(false));
  audio.addEventListener('ended', () => setPlayUI(false));

  function stopPreview() {
    audio.pause();
    try { audio.currentTime = 0; } catch (_) { /* 忽略 */ }
  }

  /* 就绪：生成 File 备用（录音与上传统一入口） */
  function setBlob(data, meta) {
    stopPreview();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    duration = meta.duration;
    fromUpload = meta.fromUpload;
    blobUrl = URL.createObjectURL(data);
    audio.src = blobUrl;
    file = new File([data], meta.name, { type: data.type || 'audio/webm' });
    state[key] = file;
    readyEl.textContent = fromUpload ? '文件已就绪' : '录音已就绪';
    const durText = (Number.isFinite(duration) && duration > 0) ? fmtClock(duration) : fmtSize(data.size);
    subEl.textContent = `${meta.name} · ${durText}`;
    if (card) card.classList.remove('missing');
    show('done');
    if (onReady) onReady(file); /* 参考音频就绪回调：触发音色画像分析 */
  }

  function clearFile() {
    stopPreview();
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    file = null;
    duration = NaN;
    state[key] = null;
    if (onReset) onReset(); /* 清空回调：撤销旧音色画像 */
  }

  /* ---- 录音（getUserMedia + MediaRecorder，优先 audio/webm） ---- */

  function pickMime() {
    if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
    const list = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
    return list.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  async function startRec() {
    /* 重入保护：正在录音时忽略重复触发，避免双击导致 MediaStream 与计时器泄漏 */
    if (recorder && recorder.state !== 'inactive') return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
      toast('当前环境不支持录音：请使用最新版 Chrome / Edge，并通过 localhost 或 https 打开本页面', 'error');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMime();
      recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunks = [];
      recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const type = recorder.mimeType || mime || 'audio/webm';
        const data = new Blob(chunks, { type });
        if (!data.size) {
          show('idle');
          toast('录音数据为空，请重试', 'error');
          return;
        }
        setBlob(data, { name: `${fileBase}_${stamp()}${extFromMime(type)}`, duration: elapsed, fromUpload: false });
      };
      recorder.start(250);
      startAt = performance.now();
      elapsed = 0;
      clockEl.textContent = '00:00';
      tickId = window.setInterval(() => {
        elapsed = (performance.now() - startAt) / 1000;
        clockEl.textContent = fmtClock(elapsed);
      }, 200);
      show('rec');
    } catch (err) {
      const name = err && err.name;
      if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
        toast('麦克风权限被拒绝：请在浏览器地址栏的权限设置中允许「麦克风」，然后重试', 'error');
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        toast('未检测到可用麦克风设备，请检查设备连接后重试', 'error');
      } else if (name === 'NotReadableError') {
        toast('麦克风被其他应用占用，请关闭占用麦克风的程序后重试', 'error');
      } else {
        toast(`无法开始录音：${(err && err.message) || '未知错误'}`, 'error');
      }
      show('idle');
    }
  }

  function stopRec() {
    window.clearInterval(tickId);
    elapsed = (performance.now() - startAt) / 1000;
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }

  /* ---- 从文件上传 ---- */

  async function onFileChosen(e) {
    const input = e.currentTarget;
    const f = input.files && input.files[0];
    input.value = ''; /* 允许重复选择同一文件 */
    if (!f) return;
    const ok = /\.(webm|wav|mp3|m4a|ogg)$/i.test(f.name) ||
      /^audio\/(webm|x-wav|wave|wav|mpeg|mp3|mp4|x-m4a|m4a|ogg)/i.test(f.type || '');
    if (!ok) {
      toast('暂不支持该格式：请选择 webm / wav / mp3 / m4a / ogg 音频文件', 'error');
      return;
    }
    const dur = await probeDuration(f);
    setBlob(f, { name: f.name, duration: dur, fromUpload: true });
  }

  /* ---- 事件绑定 ---- */

  $('.js-start', stage).addEventListener('click', startRec);
  $('.js-stop', stage).addEventListener('click', stopRec);
  $('.js-rerec', stage).addEventListener('click', () => { clearFile(); show('idle'); startRec(); });
  $('.js-play', stage).addEventListener('click', () => {
    if (!blobUrl) return;
    if (audio.paused) audio.play().catch(() => toast('播放失败，请重试', 'error'));
  });
  stage.querySelectorAll('.js-file').forEach((input) => input.addEventListener('change', onFileChosen));

  /* 初始态：idle（待录音/上传）。不调用则三个视图均因 .view{display:none} 全部隐藏 */
  show('idle');
}

/* =====================================================================
 * 第二步：转换设置与转换
 * ===================================================================== */

const semiEl = $('#semi');
const semiVal = $('#semiVal');
const stepsEl = $('#steps');
const stepsVal = $('#stepsVal');
const convertBtn = $('#convertBtn');
const statusLine = $('#statusLine');
const resultEmpty = $('#resultEmpty');
const resultBody = $('#resultBody');
const resultAudio = $('#resultAudio');
const resultMeta = $('#resultMeta');
const resultKindBadge = $('#resultKindBadge');
const resultMatch = $('#resultMatch');
const matchBadge = $('#matchBadge');
const exportBtn = $('#exportBtn');
const hqSoloEl = $('#hqSolo');
const pcSoloEl = $('#pcSolo');
const gateNoteSolo = $('#gateNoteSolo');

function paintRange(el) {
  const min = Number(el.min);
  const max = Number(el.max);
  const v = Number(el.value);
  const p = max > min ? ((v - min) / (max - min)) * 100 : 0;
  el.style.setProperty('--p', `${p}%`);
}

function updateSemi() {
  const v = Number(semiEl.value);
  semiVal.textContent = v > 0 ? `+${v}` : String(v);
  paintRange(semiEl);
  const range = v < 0 ? 'down' : (v > 0 ? 'up' : 'same');
  document.querySelectorAll('#shiftNotes li').forEach((li) => {
    li.classList.toggle('active', li.dataset.range === range);
  });
}

function updateSteps() {
  stepsVal.textContent = stepsEl.value;
  paintRange(stepsEl);
}

semiEl.addEventListener('input', updateSemi);
stepsEl.addEventListener('input', updateSteps);
updateSemi();
updateSteps();

/* 高质量模式：锁定扩散步数 50（关闭时恢复原值）；滑杆禁用态由 syncStepsLock 统管 */
hqSoloEl.addEventListener('change', () => {
  if (hqSoloEl.checked) {
    stepsEl.dataset.prev = stepsEl.value;
    stepsEl.value = '50';
  } else {
    stepsEl.value = stepsEl.dataset.prev || '30';
  }
  updateSteps();
  syncStepsLock();
});

/* 扩散步数滑杆锁定：使用训练模型（后端忽略该参数）或高质量模式已固定 50 */
function syncStepsLock() {
  stepsEl.disabled = currentVoiceModel() !== 'seedvc_zero' || hqSoloEl.checked;
}

function setStatus(kind, text) {
  statusLine.className = `status-line show ${kind}`;
  statusLine.textContent = text;
}

function updateConvertBtn() {
  /* 清唱 / 翻唱 / 训练三方互斥：任一进行中，其余按钮均禁用 */
  convertBtn.disabled = state.converting || cover.running || voice.training;
  convertBtn.classList.toggle('is-loading', state.converting);
}

async function startConvert() {
  if (state.converting) return;
  if (voice.training) {
    toast('音色模型训练中：训练期间无法转换 / 翻唱，请等待训练完成', 'error');
    return;
  }
  if (cover.running) {
    toast('翻唱任务正在进行中，请等待其完成后再发起清唱转换', 'error');
    return;
  }

  /* 转换前校验：两段音频均已就绪 */
  if (!state.reference && !state.source) {
    toast('请先完成第一步：录制或上传「音色参考」与「清唱片段」两段音频', 'error');
    flashMissing($('#cardReference'));
    flashMissing($('#cardSource'));
    return;
  }
  if (!state.reference) {
    toast('缺少「音色参考」：请先录制或上传 10~30 秒语音', 'error');
    flashMissing($('#cardReference'));
    return;
  }
  if (!state.source) {
    toast('缺少「清唱片段」：请先录制或上传一段清唱', 'error');
    flashMissing($('#cardSource'));
    return;
  }

  state.converting = true;
  updateConvertBtn();
  setStatus('busy', '首次转换需加载模型约 1 分钟，之后每次约 15~45 秒');

  try {
    const fd = new FormData();
    fd.append('reference', state.reference, state.reference.name);
    fd.append('source', state.source, state.source.name);
    /* 契约字段：semi_tone_shift（int，-12~+12）、voice_model（两种模式共用模型下拉）；
     * 训练模型（RVC）自带音准处理，diffusion_steps / pitch_correct 被后端忽略，不提交 */
    fd.append('semi_tone_shift', String(Number(semiEl.value)));
    fd.append('voice_model', currentVoiceModel());
    if (currentVoiceModel() === 'seedvc_zero') {
      fd.append('diffusion_steps', String(Number(stepsEl.value)));
      fd.append('pitch_correct', pcSoloEl.checked ? 'true' : 'false');
    }

    /* 转换可能耗时数分钟，不设超时；仅捕获网络错误 */
    const res = await apiFetch('/api/convert', { method: 'POST', body: fd });
    if (!res.ok) throw await errorFromResponse(res, '转换');

    /* 音色匹配度：X-Match-Score 响应头（缺失 / 非法时为 null，结果区不显示徽章） */
    const matchPct = parseMatchScore(res.headers.get('X-Match-Score'));
    const wav = await res.blob();
    if (!wav || wav.size === 0) throw new Error('转换失败：服务端返回了空音频');

    state.resultWav = wav;
    state.resultKind = 'solo';
    showResult(wav, 'solo', matchPct);
    setStatus('ok', '转换完成，克隆歌声已生成，可在第三步试听');
    toast('转换完成', 'success');
    $('#step3').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (err) {
    if (err instanceof TypeError) {
      setStatus('error', '网络错误：无法连接本地服务，请确认后端已启动后重试');
    } else {
      setStatus('error', err.message || '转换失败：未知错误');
    }
  } finally {
    state.converting = false;
    updateConvertBtn();
  }
}

convertBtn.addEventListener('click', startConvert);

/* matchPct：音色匹配度（0~100 整数或 null）；null 时不显示徽章 */
function showResult(wav, kind = 'solo', matchPct = null) {
  if (resultAudio.dataset.url) URL.revokeObjectURL(resultAudio.dataset.url);
  const url = URL.createObjectURL(wav);
  resultAudio.dataset.url = url;
  resultAudio.src = url;
  const isCover = kind === 'cover';
  resultKindBadge.hidden = !isCover;
  const hasMatch = Number.isFinite(matchPct);
  resultMatch.hidden = !hasMatch;
  if (hasMatch) matchBadge.textContent = `音色匹配度 ${matchPct}%`;
  resultMeta.textContent = isCover ? `翻唱成品 · WAV · ${fmtSize(wav.size)}` : `WAV · ${fmtSize(wav.size)}`;
  resultEmpty.hidden = true;
  resultBody.hidden = false;
  /* 混音调节区块：仅翻唱成品且已知最近任务 ID 时显示（清唱卡不显示；无分轨任务走 404 兜底提示） */
  const showRemix = kind === 'cover' && !!cover.lastJobId;
  remixBlock.hidden = !showRemix;
  if (showRemix) {
    vocalGainEl.value = '1';
    vocalGainVal.textContent = '100%';
    paintRange(vocalGainEl);
    remixCtl.vocalsWav = null; /* 新任务的分轨缓存作废 */
    updateRemixUI();
  }
  updateExportBtn();
}

/* 匹配度口径：服务端恒返回 0~100 整数（已钳制）；负数 / 非数字非法返回 null，>100 兜底钳到 100 */
function parseMatchScore(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  const v = Number(raw);
  if (!Number.isFinite(v) || v <= 0) return null;
  return Math.round(Math.min(100, v));
}

/* =====================================================================
 * 第三步：导出 MP3（POST /api/mp3，请求体为 WAV 二进制）
 * ===================================================================== */

function updateExportBtn() {
  exportBtn.disabled = state.exporting || !state.resultWav;
  exportBtn.classList.toggle('is-loading', state.exporting);
}

async function exportMp3() {
  if (state.exporting || !state.resultWav) return;
  state.exporting = true;
  updateExportBtn();
  try {
    const res = await apiFetch('/api/mp3', {
      method: 'POST',
      headers: { 'Content-Type': 'audio/wav' },
      body: state.resultWav,
    });
    if (!res.ok) throw await errorFromResponse(res, '导出 MP3');

    const mp3 = await res.blob();
    if (!mp3 || mp3.size === 0) throw new Error('导出 MP3 失败：服务端返回了空文件');

    const url = URL.createObjectURL(mp3);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${state.resultKind === 'cover' ? '翻唱克隆' : '录音克隆'}_${stamp()}.mp3`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    /* 60 秒后再释放链接：部分浏览器（尤其大文件/慢速磁盘）开始写盘需要时间，8 秒可能不够 */
    window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('MP3 导出成功，已开始下载', 'success');
  } catch (err) {
    if (err instanceof TypeError) {
      toast('网络错误：无法连接本地服务，请确认后端已启动后重试', 'error');
    } else {
      toast(err.message || '导出 MP3 失败：未知错误', 'error');
    }
  } finally {
    state.exporting = false;
    updateExportBtn();
  }
}

exportBtn.addEventListener('click', exportMp3);
updateExportBtn();

/* =====================================================================
 * 翻唱歌曲模式：模式 Tab / 歌曲来源 / 任务提交与轮询
 * 契约：POST /api/cover → GET /api/cover/status/{id} → GET /api/cover/result/{id}
 * 状态机：idle → submitting → polling → done | failed；与清唱转换互斥。
 * 动态数据全部经 textContent 插入，防 XSS。
 * ===================================================================== */

const tabSolo = $('#tabSolo');
const tabCover = $('#tabCover');
const paneSolo = $('#paneSolo');
const paneCover = $('#paneCover');

const songUrlEl = $('#songUrl');
const songFileEl = $('#songFile');
const srcKind = $('#srcKind');
const songPicked = $('#songPicked');
const songPickedText = $('#songPickedText');

const autoF0El = $('#autoF0');
const hqCoverEl = $('#hqCover');
const pcCoverEl = $('#pcCover');
const gateNoteCover = $('#gateNoteCover');
const coverBtn = $('#coverBtn');
const coverProgress = $('#coverProgress');
const stageList = $('#stageList');
const coverBar = $('#coverBar');
const coverBarFill = $('#coverBarFill');
const coverPct = $('#coverPct');
const coverDetail = $('#coverDetail');
const coverQueue = $('#coverQueue');
const coverFail = $('#coverFail');
const coverFailMsg = $('#coverFailMsg');
const ktvList = $('#ktvList');
const ktvDetail = $('#ktvDetail');

const COVER_STAGES = ['解析', '下载', '预处理', '分离', '转换', '混音'];

/* 经典测试歌曲（男声精选 10 首 + 女声精选 10 首，group 字段决定分组）：
 * 男声组数据已逐条经 yt-dlp 实测验证（B 站伴奏区投稿）；
 * 点击 chip 仅填入 song_url 输入框（与手动输入等价），不自动发起翻唱。
 * 女声组无 range 字段，难度徽章与翻唱提示合并展示；
 * lead_f0_hz：原唱人声基频经验值（Hz），供「为你推荐」计算建议移调（第四期） */
const KTV_SONGS = [
  { title: "海阔天空 - Beyond", url: "https://www.bilibili.com/video/BV1424y1C7XT", range: "副歌顶点约 B4", difficulty: "中", tip: "长音多注意气息；吃力可降 1~2 key", group: "male", lead_f0_hz: 140 },
  { title: "光辉岁月 - Beyond", url: "https://www.bilibili.com/video/BV1wd4y1W7bL", range: "副歌顶点约 A4~B4", difficulty: "中", tip: "最高点在'风雨中抱紧自由'，提前换气", group: "male", lead_f0_hz: 150 },
  { title: "十年 - 陈奕迅", url: "https://www.bilibili.com/video/BV19bd1BxEDC", range: "中低音区，音域窄", difficulty: "易", tip: "基本无需移调，重点在叙事感与气声", group: "male", lead_f0_hz: 130 },
  { title: "吻别 - 张学友", url: "https://www.bilibili.com/video/BV198411D7cN", range: "副歌顶点约 A4", difficulty: "中", tip: "低音偏低可升 1 key；长音做渐弱", group: "male", lead_f0_hz: 135 },
  { title: "朋友 - 周华健", url: "https://www.bilibili.com/video/BV1wnx7eCE8s", range: "中音区舒适，音域窄", difficulty: "易", tip: "无需移调，适合大合唱", group: "male", lead_f0_hz: 125 },
  { title: "童话 - 光良", url: "https://www.bilibili.com/video/BV1g5D1BME4n", range: "副歌顶点约 C5", difficulty: "中", tip: "副歌高音密集，吃力可降 2 key", group: "male", lead_f0_hz: 140 },
  { title: "晴天 - 周杰伦", url: "https://www.bilibili.com/video/BV1K5G1z9EQV", range: "主歌低音，副歌顶点约 B4", difficulty: "中", tip: "主歌字密先跟节奏；副歌可降 1~2 key", group: "male", lead_f0_hz: 145 },
  { title: "平凡之路 - 朴树", url: "https://www.bilibili.com/video/BV1bw411G7T9", range: "音域极窄，最高约 G4~A4", difficulty: "易", tip: "无需移调，难点在情绪递进", group: "male", lead_f0_hz: 130 },
  { title: "成都 - 赵雷", url: "https://www.bilibili.com/video/BV1ux41197wA", range: "中低音民谣区", difficulty: "易", tip: "无需移调，低音不压喉", group: "male", lead_f0_hz: 120 },
  { title: "突然的自我 - 伍佰", url: "https://www.bilibili.com/video/BV19P4y1v7xU", range: "中音区，副歌顶点约 A4", difficulty: "易", tip: "无需移调，节奏保持松弛", group: "male", lead_f0_hz: 135 },
  { title: "有没有人告诉你 - 陈楚生", url: "https://www.bilibili.com/video/BV1uupj6DEcH", difficulty: "易", tip: "无需移调；重点在叙事语气", group: "female", lead_f0_hz: 130 },
  { title: "姑娘 - 陈楚生", url: "https://www.bilibili.com/video/BV1n34y1N7gR", difficulty: "易", tip: "无需移调；Live 版伴奏，副歌长音松弛", group: "female", lead_f0_hz: 135 },
  { title: "这就是爱 - 张杰", url: "https://www.bilibili.com/video/BV16cw9zuE8S", difficulty: "难", tip: "建议降 2~3 key；四字连续高音注意气息", group: "female", lead_f0_hz: 220 },
  { title: "天下 - 张杰", url: "https://www.bilibili.com/video/BV1LPcuzvEKV", difficulty: "难", tip: "建议降 3~5 key 或副歌假声", group: "female", lead_f0_hz: 230 },
  { title: "想念式 - 苏醒", url: "https://www.bilibili.com/video/BV1y8ekzaE4c", difficulty: "中", tip: "无需移调；难点在切分节奏与转音", group: "female", lead_f0_hz: 140 },
  { title: "怕爱 - 苏醒", url: "https://www.bilibili.com/video/BV1ud4y1M7Z4", difficulty: "中", tip: "无需移调；副歌控制力度情绪递进", group: "female", lead_f0_hz: 135 },
  { title: "爱你 - 王心凌", url: "https://www.bilibili.com/video/BV1ad4y1Q7pF", difficulty: "中", tip: "男声建议降 8~12 半音；连音求颗粒感", group: "female", lead_f0_hz: 205 },
  { title: "睫毛弯弯 - 王心凌", url: "https://www.bilibili.com/video/BV1aT4y1M7Hu", difficulty: "中", tip: "男声建议降 8~12 半音；先念词跟节拍", group: "female", lead_f0_hz: 210 },
  { title: "柠檬树 - 苏慧伦", url: "https://www.bilibili.com/video/BV1JZ4y1v7A6?p=2", difficulty: "易", tip: "男声建议降 8~10 半音；注意重复段强弱", group: "female", lead_f0_hz: 185 },
  { title: "鸭子 - 苏慧伦", url: "https://www.bilibili.com/video/BV1WY4y1N7i5", difficulty: "易", tip: "男声建议降 8~10 半音；保持轻快不拖拍", group: "female", lead_f0_hz: 190 }
];

const SONG_MAX_BYTES = 100 * 1048576; /* 100MB */
const SONG_MAX_SEC = 600;             /* 10 分钟 */
const POLL_MS = 2000;                 /* 轮询间隔 */
const POLL_MS_HIDDEN = 5000;          /* 页面隐藏时降频轮询 */

/* ---- 模式 Tab：切换面板，互不清空对方状态 ---- */

function switchMode(mode) {
  const solo = mode === 'solo';
  tabSolo.classList.toggle('active', solo);
  tabCover.classList.toggle('active', !solo);
  tabSolo.setAttribute('aria-selected', String(solo));
  tabCover.setAttribute('aria-selected', String(!solo));
  paneSolo.hidden = !solo;
  paneCover.hidden = solo;
}

tabSolo.addEventListener('click', () => switchMode('solo'));
tabCover.addEventListener('click', () => switchMode('cover'));

/* ---- 歌曲来源：URL 与本地文件二选一，后操作覆盖先前的 ---- */

function setSongSource(src) {
  cover.song = src;
  renderSongPicked();
}

function renderSongPicked() {
  const s = cover.song;
  if (s && s.type === 'file') {
    const durText = (Number.isFinite(s.duration) && s.duration > 0) ? fmtClock(s.duration) : '时长未知';
    songPickedText.textContent = `${s.file.name} · ${durText} · ${fmtSize(s.file.size)}`;
    srcKind.textContent = '本地上传';
    songPicked.hidden = false;
  } else if (s && s.type === 'url') {
    songPickedText.textContent = s.url;
    srcKind.textContent = '歌曲链接';
    songPicked.hidden = false;
  } else {
    songPickedText.textContent = '';
    srcKind.textContent = '';
    songPicked.hidden = true;
  }
}

songUrlEl.addEventListener('input', () => {
  const v = songUrlEl.value.trim();
  if (v) {
    /* 输入链接即视为选择 URL 通道，取消本地文件选择 */
    songFileEl.value = '';
    setSongSource({ type: 'url', url: v });
  } else if (cover.song && cover.song.type === 'url') {
    setSongSource(null);
  }
});

songFileEl.addEventListener('change', async (e) => {
  const f = e.currentTarget.files && e.currentTarget.files[0];
  e.currentTarget.value = ''; /* 允许重复选择同一文件 */
  if (!f) return;
  const ok = /\.(mp3|flac|wav|m4a|ogg|webm)$/i.test(f.name) ||
    /^(audio\/(mpeg|mp3|x-wav|wave|wav|mp4|x-m4a|m4a|ogg|flac|webm)|video\/webm)/i.test(f.type || '');
  if (!ok) {
    toast('暂不支持该格式：请选择 mp3 / flac / wav / m4a / ogg / webm 音频文件', 'error');
    return;
  }
  if (f.size > SONG_MAX_BYTES) {
    toast(`歌曲文件超过 100MB 上限（当前 ${fmtSize(f.size)}），请裁剪或压缩后重试`, 'error');
    return;
  }
  const dur = await probeDuration(f);
  if (Number.isFinite(dur) && dur > SONG_MAX_SEC) {
    toast(`歌曲时长超过 10 分钟上限（当前约 ${fmtClock(dur)}），请裁剪后重试`, 'error');
    return;
  }
  /* 选择文件即视为选择本地通道，清空 URL 输入 */
  songUrlEl.value = '';
  setSongSource({ type: 'file', file: f, duration: dur });
});

$('#songClear').addEventListener('click', () => {
  songUrlEl.value = '';
  songFileEl.value = '';
  setSongSource(null);
});

/* ---- 经典测试歌曲快捷入口：渲染 chips + 点击填入 URL 通道 ---- */

/* 难度徽章配色：易=绿 / 中=琥珀 / 难=红（未知值兜底琥珀） */
function ktvDiffClass(d) {
  if (d === '易') return 'is-easy';
  if (d === '难') return 'is-hard';
  return 'is-mid';
}

/* 分组：男声精选（旧 10 首）/ 女声精选（新 10 首），组头带性别小徽章 */
const KTV_GROUPS = [
  { key: 'male', label: '男声精选', badge: '男声', note: '' },
  { key: 'female', label: '女声精选', badge: '女声', note: '点击选择后可配合移调滑杆' },
];

function renderKtvChips() {
  if (!ktvList) return;
  ktvList.textContent = '';
  for (const g of KTV_GROUPS) {
    const group = el('div', 'ktv-group');
    const head = el('div', 'ktv-group-head');
    head.append(
      el('span', `ktv-group-badge ${g.key === 'male' ? 'is-male' : 'is-female'}`, g.badge),
      el('span', 'ktv-group-title', g.label),
    );
    if (g.note) head.appendChild(el('span', 'ktv-group-note', g.note));
    const list = el('div', 'ktv-group-list');
    for (const song of KTV_SONGS.filter((s) => s.group === g.key)) {
      const chip = el('button', 'ktv-chip');
      chip.type = 'button';
      chip.title = [song.range, song.tip].filter(Boolean).join(' · ');
      chip.append(
        el('span', 'ktv-name', song.title),
        el('span', `ktv-badge ${ktvDiffClass(song.difficulty)}`, song.difficulty),
      );
      chip.addEventListener('click', () => applyKtvSong(song));
      list.appendChild(chip);
    }
    group.append(head, list);
    ktvList.appendChild(group);
  }
}

function applyKtvSong(song) {
  /* 与手动输入链接完全等价：填入输入框并切到链接通道（取消本地文件选择） */
  songUrlEl.value = song.url;
  songFileEl.value = '';
  setSongSource({ type: 'url', url: song.url });
  renderKtvDetail(song);
  toast(`已选择：${song.title}`, 'success', 2600);
}

/* 选中曲目后在其下方展示音域 / 难度 / 翻唱提示（全部 textContent 插入）；
 * 女声精选无 range 字段：难度徽章与翻唱提示合并为单行 */
function renderKtvDetail(song) {
  if (!ktvDetail) return;
  ktvDetail.hidden = false;
  ktvDetail.textContent = '';
  const badge = el('span', `ktv-badge ${ktvDiffClass(song.difficulty)}`, song.difficulty);
  if (song.range) {
    const line1 = el('p', 'ktv-detail-line');
    line1.append(el('span', 'ktv-range', `音域：${song.range}`), badge);
    ktvDetail.append(
      line1,
      el('p', 'ktv-detail-line ktv-tip', `翻唱提示：${song.tip}`),
    );
  } else {
    const line = el('p', 'ktv-detail-line');
    line.append(badge, el('span', 'ktv-range', song.tip));
    ktvDetail.appendChild(line);
  }
}

/* ---- 进度区渲染 ---- */

function setCoverBar(p) {
  coverBarFill.style.width = `${p}%`;
  coverBar.setAttribute('aria-valuenow', String(p));
}

/* idx：-1 未开始；0..len-1 当前阶段；≥len 全部完成（listEl 与阶段数组由调用方传入，翻唱/训练共用） */
function setStageHighlight(listEl, stages, idx) {
  listEl.querySelectorAll('li').forEach((li, i) => {
    li.classList.toggle('done', idx >= stages.length || i < idx);
    li.classList.toggle('active', i === idx);
  });
}

function resetCoverProgress() {
  coverProgress.hidden = false;
  coverFail.hidden = true;
  coverFailMsg.textContent = '';
  coverQueue.hidden = true;
  coverQueue.textContent = '';
  coverDetail.textContent = '';
  coverPct.textContent = '0%';
  setCoverBar(0);
  setStageHighlight(stageList, COVER_STAGES, -1);
}

function applyCoverStatus(st) {
  const stageName = st && typeof st.stage === 'string' ? st.stage : '';
  const idx = COVER_STAGES.indexOf(stageName);
  setStageHighlight(stageList, COVER_STAGES, stageName === '完成' ? COVER_STAGES.length : idx);
  const p = Math.max(0, Math.min(100, Math.round(Number(st && st.progress) || 0)));
  setCoverBar(p);
  coverPct.textContent = `${p}%`;
  coverDetail.textContent = st && typeof st.detail === 'string' ? st.detail : '';
  const qp = Number(st && st.queue_pos) || 0;
  if (qp > 0) {
    coverQueue.hidden = false;
    coverQueue.textContent = `排队中，前面还有 ${qp} 个任务`;
  } else {
    coverQueue.hidden = true;
    coverQueue.textContent = '';
  }
}

/* ---- 按钮可用性：翻唱进行中或清唱转换中均禁用 ---- */

function updateCoverBtn() {
  coverBtn.disabled = cover.running || state.converting || voice.training;
  coverBtn.classList.toggle('is-loading', cover.running);
}

/* ---- 发起翻唱 ---- */

function fatalCoverError(message) {
  const e = new Error(message);
  e.fatal = true;
  return e;
}

async function startCover() {
  if (cover.running) return; /* 防重入 */
  if (voice.training) {
    toast('音色模型训练中：训练期间无法转换 / 翻唱，请等待训练完成', 'error');
    return;
  }
  if (state.converting) {
    toast('清唱转换正在进行中，请等待其完成后再发起翻唱', 'error');
    return;
  }
  /* 参考音色就绪检查：不通过则闪烁卡片①，不发请求 */
  if (!state.reference) {
    toast('请先在第一步完成音色参考', 'error');
    flashMissing($('#cardReference'));
    return;
  }
  if (!cover.song) {
    toast('请先提供歌曲来源：粘贴歌曲链接或上传本地歌曲文件', 'error');
    return;
  }
  if (cover.song.type === 'url' && !/^https?:\/\/\S+/i.test(cover.song.url)) {
    toast('链接格式无效：请粘贴以 http(s):// 开头的 B 站视频/音频链接', 'error');
    return;
  }

  cover.running = true;
  updateCoverBtn();
  updateConvertBtn();
  resetCoverProgress();
  coverDetail.textContent = '正在提交翻唱任务…';

  try {
    const fd = new FormData();
    /* 卡片①就绪的 File 本身已带正确扩展名（录音自动命名 / 上传保留原名），直接随表单上传 */
    fd.append('reference', state.reference, state.reference.name);
    if (cover.song.type === 'file') {
      fd.append('song_file', cover.song.file, cover.song.file.name);
    } else {
      fd.append('song_url', cover.song.url);
    }
    /* 契约字段：semi_tone_shift（int，-12~+12）、voice_model（两种模式共用模型下拉）；
     * 训练模型（RVC）自带音准处理，auto_f0_adjust / pitch_correct / diffusion_steps 被后端忽略，不提交 */
    fd.append('semi_tone_shift', String(Number(semiEl.value)));
    fd.append('voice_model', currentVoiceModel());
    if (currentVoiceModel() === 'seedvc_zero') {
      fd.append('auto_f0_adjust', autoF0El.checked ? 'true' : 'false');
      fd.append('pitch_correct', pcCoverEl.checked ? 'true' : 'false');
      if (hqCoverEl.checked) fd.append('diffusion_steps', '50');
    }

    const res = await apiFetch('/api/cover', { method: 'POST', body: fd });
    if (!res.ok) throw await errorFromResponse(res, '发起翻唱');
    const data = await res.json();
    if (!data || !data.job_id) throw new Error('发起翻唱失败：服务端未返回任务 ID');

    cover.jobId = data.job_id;
    cover.lastJobId = data.job_id;
    cover.netFails = 0;
    coverDetail.textContent = data.message ? `任务已创建：${data.message}` : '任务已创建，等待调度…';
    scheduleNextPoll();
  } catch (err) {
    const msg = err instanceof TypeError
      ? '网络错误：无法连接本地服务，请确认后端已启动后重试'
      : (err.message || '发起翻唱失败：未知错误');
    coverFailFinish(msg);
  }
}

/* ---- 轮询：间隔 2s，页面隐藏时降为 5s；网络错误累计 3 次终止 ---- */

function scheduleNextPoll() {
  clearTimeout(cover.pollTimer);
  cover.pollTimer = window.setTimeout(pollTick, document.hidden ? POLL_MS_HIDDEN : POLL_MS);
}

async function pollTick() {
  if (!cover.running || !cover.jobId) return;
  try {
    const res = await apiFetch(`/api/cover/status/${encodeURIComponent(cover.jobId)}`);
    if (res.status === 404) {
      throw fatalCoverError('查询任务状态失败：任务不存在（可能因服务重启丢失）');
    }
    if (!res.ok) {
      let detail = '';
      try {
        const d = await res.json();
        if (d && typeof d.detail === 'string' && d.detail) detail = d.detail;
      } catch (_) { /* 响应体不是 JSON */ }
      throw fatalCoverError(detail ? `查询任务状态失败：${detail}` : `查询任务状态失败（HTTP ${res.status}）`);
    }
    const st = await res.json();
    if (!cover.running) return; /* 轮询期间已被重置 */
    cover.netFails = 0;
    applyCoverStatus(st);

    if (st.state === 'done') { await fetchCoverResult(); return; }
    if (st.state === 'failed') {
      const msg = (typeof st.error === 'string' && st.error) ? st.error : '翻唱失败：未知错误';
      coverFailFinish(msg);
      return;
    }
    scheduleNextPoll();
  } catch (err) {
    if (!cover.running) return;
    if (err && err.fatal) { coverFailFinish(err.message); return; }
    cover.netFails += 1;
    if (cover.netFails >= 3) {
      coverFailFinish('网络错误：连续 3 次查询任务状态失败，请检查本地服务是否仍在运行');
      return;
    }
    coverDetail.textContent = `网络波动，正在重试查询（${cover.netFails}/3）…`;
    scheduleNextPoll();
  }
}

/* ---- 拉取成品：done 后获取，网络错误内部重试 3 次 ---- */

async function fetchCoverResult() {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!cover.running) return;
    try {
      /* 音色匹配度元信息与音频流并行请求；meta 失败仅降级为不显示徽章 */
      const metaPromise = apiFetch(`/api/cover/result/${encodeURIComponent(cover.jobId)}?meta=1`)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
      const res = await apiFetch(`/api/cover/result/${encodeURIComponent(cover.jobId)}`);
      if (res.ok) {
        const wav = await res.blob();
        if (!wav || wav.size === 0) {
          throw fatalCoverError('获取翻唱成品失败：服务端返回了空音频');
        }
        const meta = await metaPromise;
        const ms = (meta && meta.match_score !== null && meta.match_score !== undefined)
          ? parseMatchScore(meta.match_score) : null;
        state.resultWav = wav;
        state.resultKind = 'cover';
        coverDoneFinish();
        showResult(wav, 'cover', ms);
        toast('翻唱完成，克隆歌声已生成', 'success');
        $('#step3').scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      /* 409 未完成 / 404 不存在 / 其他 HTTP 错误：确定性失败，重试无意义 */
      let detail = '';
      try {
        const d = await res.json();
        if (d && typeof d.detail === 'string' && d.detail) detail = d.detail;
      } catch (_) { /* 响应体不是 JSON */ }
      if (res.status === 404) {
        throw fatalCoverError(`获取翻唱成品失败：${detail || '任务不存在（可能因服务重启丢失）'}`);
      }
      if (res.status === 409) {
        throw fatalCoverError(`获取翻唱成品失败：${detail || '任务尚未完成'}`);
      }
      throw fatalCoverError(detail ? `获取翻唱成品失败：${detail}` : `获取翻唱成品失败（HTTP ${res.status}）`);
    } catch (err) {
      if (err && err.fatal) { coverFailFinish(err.message); return; }
      if (attempt < 3) await new Promise((r) => window.setTimeout(r, 1500));
    }
  }
  coverFailFinish('网络错误：连续 3 次获取翻唱成品失败，请检查本地服务是否仍在运行');
}

function coverFailFinish(msg) {
  clearTimeout(cover.pollTimer);
  cover.running = false;
  cover.jobId = null;
  coverFailMsg.textContent = msg;
  coverFail.hidden = false;
  coverQueue.hidden = true;
  updateCoverBtn();
  updateConvertBtn();
  toast(msg, 'error', 6000);
}

function coverDoneFinish() {
  clearTimeout(cover.pollTimer);
  cover.running = false;
  cover.jobId = null;
  coverQueue.hidden = true;
  setStageHighlight(stageList, COVER_STAGES, COVER_STAGES.length);
  setCoverBar(100);
  coverPct.textContent = '100%';
  coverDetail.textContent = '翻唱完成';
  updateCoverBtn();
  updateConvertBtn();
}

$('#coverRetry').addEventListener('click', () => startCover());
coverBtn.addEventListener('click', startCover);
updateCoverBtn();
updateConvertBtn();
renderSongPicked();
renderKtvChips();

/* =====================================================================
 * 重混音 + 清唱分轨导出（第四期，仅翻唱成品结果卡显示）
 * 契约：POST /api/cover/remix/{job_id}（multipart vocal_gain 0.3~2.0，服务端 clamp）
 *       → 200 audio/wav（重混成品，服务端已覆盖 cover.wav）+ X-Match-Score（有则带）
 *       GET /api/cover/stems/{job_id}?stem=vocals → 200 audio/wav
 *       404 任务不存在/未完成/分轨缺失；400 mix_preset 非法（本期 UI 不发送该字段）
 * 任务 ID 取 cover.lastJobId：coverDoneFinish 会清空 jobId，lastJobId 保留会话内
 * 最近一次成功提交的任务，供重混音与分轨导出使用。
 * ===================================================================== */

const remixBlock = $('#remixBlock');
const vocalGainEl = $('#vocalGain');
const vocalGainVal = $('#vocalGainVal');
const remixBtn = $('#remixBtn');
const stemsBtn = $('#stemsBtn');
const stemsMp3Btn = $('#stemsMp3Btn');

const remixCtl = { busy: false, stemsBusy: false, vocalsWav: null };

/* 人声音量滑杆：实时显示百分比（0.3~2.0 → 30%~200%） */
vocalGainEl.addEventListener('input', () => {
  vocalGainVal.textContent = `${Math.round(Number(vocalGainEl.value) * 100)}%`;
  paintRange(vocalGainEl);
});

function updateRemixUI() {
  remixBtn.disabled = remixCtl.busy || !cover.lastJobId;
  remixBtn.classList.toggle('is-loading', remixCtl.busy);
  stemsBtn.disabled = remixCtl.stemsBusy || !cover.lastJobId;
  /* 「清唱转MP3」小链接：仅在已缓存人声分轨后展示 */
  stemsMp3Btn.hidden = !remixCtl.vocalsWav || remixCtl.stemsBusy;
}

/* 重新混音：POST remix → 成功后以返回 WAV 替换结果区（无缝替换，保留播放进度） */
async function startRemix() {
  if (remixCtl.busy || !cover.lastJobId) return;
  remixCtl.busy = true;
  updateRemixUI();
  try {
    const fd = new FormData();
    /* 服务端 clamp 0.3~2.0，UI 滑杆已同步限幅 */
    fd.append('vocal_gain', String(Number(vocalGainEl.value)));
    const res = await apiFetch(`/api/cover/remix/${encodeURIComponent(cover.lastJobId)}`, {
      method: 'POST',
      body: fd,
    });
    if (res.status === 404) {
      /* 旧任务无分轨等场景：优先展示服务端 detail，无则用约定兜底文案 */
      let detail = '';
      try { const d = await res.json(); if (d && typeof d.detail === 'string') detail = d.detail; } catch (_) { /* 非 JSON */ }
      toast(detail || '该任务未保留分轨，无法重混音', 'error');
      return;
    }
    if (!res.ok) throw await errorFromResponse(res, '重新混音');
    const wav = await res.blob();
    if (!wav || wav.size === 0) throw new Error('重新混音失败：服务端返回了空音频');
    applyRemixResult(wav, parseMatchScore(res.headers.get('X-Match-Score')));
    toast('重混音完成，已替换上方成品', 'success');
  } catch (err) {
    toast(err instanceof TypeError
      ? '网络错误：无法连接服务，请确认后端已启动'
      : (err.message || '重新混音失败：未知错误'), 'error');
  } finally {
    remixCtl.busy = false;
    updateRemixUI();
  }
}

/* 用重混结果无缝替换结果区：保留播放进度（loadedmetadata 后恢复），失败静默从头播 */
function applyRemixResult(wav, matchPct) {
  const resumeAt = resultAudio.currentTime || 0;
  if (resultAudio.dataset.url) URL.revokeObjectURL(resultAudio.dataset.url);
  const url = URL.createObjectURL(wav);
  resultAudio.dataset.url = url;
  resultAudio.src = url;
  if (resumeAt > 0) {
    resultAudio.addEventListener('loadedmetadata', () => {
      try { resultAudio.currentTime = Math.min(resumeAt, resultAudio.duration || resumeAt); } catch (_) { /* 恢复失败则从头播放 */ }
    }, { once: true });
  }
  state.resultWav = wav;
  resultMeta.textContent = `翻唱成品（重混） · WAV · ${fmtSize(wav.size)}`;
  if (Number.isFinite(matchPct)) {
    resultMatch.hidden = false;
    matchBadge.textContent = `音色匹配度 ${matchPct}%`;
  }
}

/* 下载清唱分轨（vocals）：WAV 直接下载；已缓存后提供「清唱转MP3」小链接 */
async function downloadStems(asMp3 = false) {
  if (!cover.lastJobId || remixCtl.stemsBusy) return;
  remixCtl.stemsBusy = true;
  updateRemixUI();
  try {
    if (!remixCtl.vocalsWav) {
      const res = await apiFetch(`/api/cover/stems/${encodeURIComponent(cover.lastJobId)}?stem=vocals`);
      if (res.status === 404) {
        let detail = '';
        try { const d = await res.json(); if (d && typeof d.detail === 'string') detail = d.detail; } catch (_) { /* 非 JSON */ }
        toast(detail || '该任务未保留分轨，无法导出清唱', 'error');
        return;
      }
      if (!res.ok) throw await errorFromResponse(res, '下载清唱分轨');
      const wav = await res.blob();
      if (!wav || wav.size === 0) throw new Error('下载清唱分轨失败：服务端返回了空音频');
      remixCtl.vocalsWav = wav;
    }
    if (asMp3) {
      const res = await apiFetch('/api/mp3', {
        method: 'POST',
        headers: { 'Content-Type': 'audio/wav' },
        body: remixCtl.vocalsWav,
      });
      if (!res.ok) throw await errorFromResponse(res, '清唱转 MP3');
      const mp3 = await res.blob();
      if (!mp3 || mp3.size === 0) throw new Error('清唱转 MP3 失败：服务端返回了空文件');
      saveBlob(mp3, `清唱分轨_${stamp()}.mp3`);
    } else {
      saveBlob(remixCtl.vocalsWav, `清唱分轨_${stamp()}.wav`);
    }
  } catch (err) {
    toast(err instanceof TypeError
      ? '网络错误：无法连接服务，请确认后端已启动'
      : (err.message || '导出清唱失败：未知错误'), 'error');
  } finally {
    remixCtl.stemsBusy = false;
    updateRemixUI();
  }
}

/* 通用下载小工具（与导出 MP3 同款：60 秒后回收 URL） */
function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}

remixBtn.addEventListener('click', startRemix);
stemsBtn.addEventListener('click', () => downloadStems(false));
stemsMp3Btn.addEventListener('click', () => downloadStems(true));

/* =====================================================================
 * 音色画像：参考音频就绪后自动分析（POST /api/analyze_timbre）
 * 动态数据全部经 textContent / createTextNode / 属性赋值插入，防 XSS；
 * 分析失败不阻塞转换流程；重录 / 换文件后旧结果作废并自动重新分析。
 * ===================================================================== */

const timbrePanel = $('#timbrePanel');
const timbre = { reqId: 0, lastFile: null };

const TIMBRE_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M3 12h2.5"/><path d="M8.5 8v8"/><path d="M12.5 5v14"/><path d="M16.5 9v6"/><path d="M20.5 12H22"/></svg>';

/* 建 DOM 小工具：仅设置 textContent，杜绝 HTML 注入 */
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
}

function resetTimbre() {
  timbre.reqId += 1; /* 在途请求作废 */
  timbre.lastFile = null;
  timbrePanel.hidden = true;
  timbrePanel.textContent = '';
}

function renderTimbreLoading() {
  timbrePanel.hidden = false;
  timbrePanel.textContent = '';
  const box = el('div', 'timbre-card timbre-loading');
  box.append(el('span', 'spinner'), el('span', null, '音色分析中…'));
  timbrePanel.appendChild(box);
}

function renderTimbreError(msg) {
  timbrePanel.hidden = false;
  timbrePanel.textContent = '';
  const box = el('div', 'timbre-card timbre-error');
  const retry = el('button', 'btn btn-sm');
  retry.type = 'button';
  retry.textContent = '重试分析';
  retry.addEventListener('click', () => { if (timbre.lastFile) analyzeTimbre(timbre.lastFile); });
  box.append(el('p', 'timbre-error-msg', msg || '音色分析失败：未知错误'), retry);
  timbrePanel.appendChild(box);
}

function renderTimbreResult(data) {
  timbrePanel.hidden = false;
  timbrePanel.textContent = '';

  const card = el('div', 'timbre-card');

  /* 头部：图标（静态常量）+ 标题 + 数值摘要 */
  const head = el('div', 'timbre-head');
  const icon = el('span', 'timbre-icon');
  icon.innerHTML = TIMBRE_ICON; /* 静态常量，无用户数据 */
  const meta = el('p', 'timbre-meta',
    `F0 中位 ${Number(data.f0_median_hz).toFixed(0)} Hz · 时长 ${Number(data.duration_sec).toFixed(1)} 秒`);
  const titles = el('div', 'timbre-titles');
  titles.append(el('h4', null, '音色画像'), meta);
  head.append(icon, titles);

  /* 五维徽章（悬停显示完整短语） */
  const badges = el('div', 'timbre-badges');
  const traits = Array.isArray(data.traits) ? data.traits : [];
  for (const t of traits) {
    const b = el('span', 'timbre-badge');
    b.title = t && t.phrase ? String(t.phrase) : '';
    b.append(
      el('b', null, t && t.dim ? t.dim : ''),
      document.createTextNode(t && t.label ? String(t.label) : ''),
    );
    badges.appendChild(b);
  }

  /* 画像描述 */
  const desc = el('p', 'timbre-desc', data && data.description ? String(data.description) : '');

  /* 提示词区块 + 复制按钮 */
  const promptBox = el('div', 'timbre-prompt');
  const promptHead = el('div', 'prompt-head');
  const copyBtn = el('button', 'btn btn-sm btn-copy');
  copyBtn.type = 'button';
  copyBtn.textContent = '复制提示词';
  promptHead.append(el('span', 'prompt-label', 'AI PROMPT'), copyBtn);
  const promptText = el('code', 'prompt-text', data && data.prompt_words ? String(data.prompt_words) : '');
  promptBox.append(promptHead, promptText);

  copyBtn.addEventListener('click', async () => {
    const text = promptText.textContent || '';
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        /* 兜底：临时 textarea + execCommand（localhost 为安全上下文，通常走不到这里） */
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      toast('已复制', 'success');
    } catch (_) {
      toast('复制失败：请手动选中文本复制', 'error');
    }
  });

  card.append(head, badges, desc, promptBox);
  timbrePanel.appendChild(card);

  /* 「为你推荐」推荐卡：后端返回 voice_class 且 F0 中位有效时渲染（旧后端无该字段则跳过） */
  const f0Median = Number(data && data.f0_median_hz);
  if (data && typeof data.voice_class === 'string' && VOICE_CLASS_NOTES[data.voice_class]
      && Number.isFinite(f0Median) && f0Median > 0) {
    renderRecommendations(data.voice_class, f0Median);
  }
}

/* =====================================================================
 * 「为你推荐」：按 voice_class 从 KTV 歌单生成个性化推荐（第四期）
 * 排序：male_* → 男声组在前（女声组「易」难度曲附后最多 2 首）；
 *       female_* → 女声组在前；组内难度升序（易→中→难），稳定排序。
 * 建议移调：shift = clamp(round(12·log2(lead_f0_hz / f0_median_hz)), -12, 12)。
 *   方向已核对：与移调滑杆语义一致（负 = 降 key），点击 chip 直接写入，无需取反。
 * ===================================================================== */

const VOICE_CLASS_NOTES = {
  male_low: '低男声：优先男声中低音曲目',
  male_mid: '男中音：男声组全适配',
  male_high: '偏高男声：男声组 + 女声组易曲（需移调）',
  female_mid: '中女声：女声组全适配',
  female_high: '偏高女声：女声组全适配',
};

/* 建议移调（半音）；入参非法时返回 0（按原调处理） */
function computeShift(leadF0, f0Median) {
  if (!Number.isFinite(leadF0) || !Number.isFinite(f0Median) || leadF0 <= 0 || f0Median <= 0) return 0;
  return Math.max(-12, Math.min(12, Math.round(12 * Math.log2(leadF0 / f0Median))));
}

/* 推荐排序（纯逻辑，node 单测直接提取本函数与 KTV_SONGS 断言） */
function recommendSongs(voiceClass) {
  const DIFF_RANK = { '易': 0, '中': 1, '难': 2 };
  const byDiff = (a, b) => (DIFF_RANK[a.difficulty] ?? 9) - (DIFF_RANK[b.difficulty] ?? 9);
  const pick = (g) => KTV_SONGS.filter((s) => s.group === g).slice().sort(byDiff);
  if (typeof voiceClass === 'string' && voiceClass.startsWith('male')) {
    return [...pick('male'), ...pick('female').filter((s) => s.difficulty === '易').slice(0, 2)];
  }
  return pick('female');
}

function renderRecommendations(voiceClass, f0Median) {
  /* 旧数据兼容：缺 lead_f0_hz 的曲目不参与推荐 */
  const songs = recommendSongs(voiceClass).filter((s) => Number.isFinite(s.lead_f0_hz) && s.lead_f0_hz > 0);
  if (!songs.length) return;

  const card = el('div', 'timbre-card timbre-recommend');
  const head = el('div', 'timbre-rec-head');
  head.append(
    el('h4', 'timbre-rec-title', '为你推荐'),
    el('p', 'timbre-rec-sub', VOICE_CLASS_NOTES[voiceClass] || ''),
  );

  const list = el('div', 'rec-list');
  for (const s of songs) {
    const shift = computeShift(s.lead_f0_hz, f0Median);
    const chip = el('button', 'rec-chip');
    chip.type = 'button';
    const line = el('span', 'rec-line');
    line.append(
      el('span', 'rec-name', s.title),
      el('span', `ktv-badge ${ktvDiffClass(s.difficulty)}`, s.difficulty),
      el('span', `rec-shift${Math.abs(shift) > 8 ? ' is-far' : ''}`,
        Math.abs(shift) <= 1 ? '原调' : `建议移调 ${shift > 0 ? '+' : ''}${shift} key`),
    );
    chip.appendChild(line);
    if (Math.abs(shift) > 8) {
      chip.title = `音域跨度较大（约 ${shift > 0 ? '+' : ''}${shift} key）`;
      chip.appendChild(el('span', 'rec-hint', '跨度较大：建议改用「自动对齐音域」'));
    } else {
      chip.title = s.tip || '点击填入翻唱面板';
    }
    chip.addEventListener('click', () => applyRecommendation(s, shift));
    list.appendChild(chip);
  }

  card.append(head, list);
  timbrePanel.appendChild(card);
}

/* 点击推荐 chip：填 URL + 写移调滑杆 + 滚动到翻唱面板（与 KTV chip 行为等价） */
function applyRecommendation(song, shift) {
  songUrlEl.value = song.url;
  songFileEl.value = '';
  setSongSource({ type: 'url', url: song.url });
  renderKtvDetail(song); /* 同步 KTV 详情区，保持两处入口状态一致 */
  semiEl.value = String(shift); /* 公式方向与滑杆一致（负 = 降 key），无需取反 */
  updateSemi();
  switchMode('cover');
  toast(`已填入「${song.title}」${Math.abs(shift) > 1 ? `，移调 ${shift > 0 ? '+' : ''}${shift} key` : '（原调）'}`, 'success');
  $('#step2').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function analyzeTimbre(file) {
  if (!file) return;
  timbre.lastFile = file;
  const id = ++timbre.reqId;
  renderTimbreLoading();
  try {
    const fd = new FormData();
    fd.append('reference', file, file.name);
    const res = await apiFetch('/api/analyze_timbre', { method: 'POST', body: fd });
    if (id !== timbre.reqId) return; /* 已被新分析 / 重置取代 */
    if (!res.ok) throw await errorFromResponse(res, '音色分析');
    const data = await res.json();
    if (id !== timbre.reqId) return;
    renderTimbreResult(data);
  } catch (err) {
    if (id !== timbre.reqId) return;
    const msg = err instanceof TypeError
      ? '网络错误：无法连接本地服务，请确认后端已启动'
      : (err.message || '音色分析失败：未知错误');
    renderTimbreError(msg);
  }
}

/* =====================================================================
 * 声音模型：模型下拉 + 专属音色训练
 * 契约：GET /api/voice/models → POST /api/voice/train → GET /api/voice/train/status/{id}
 * 状态机：idle → submitting → polling → done | failed；与转换 / 翻唱三方互斥。
 * 动态数据全部经 textContent / createTextNode 插入，防 XSS。
 * ===================================================================== */

const voiceSelect = $('#voiceSelect');
const modelsRefresh = $('#modelsRefresh');
const modelNote = $('#modelNote');
const trainAdv = $('#trainAdv');
const voiceNameEl = $('#voiceName');
const trainFileInput = $('#trainFileInput');
const trainFilesList = $('#trainFilesList');
const trainFilesSummary = $('#trainFilesSummary');
const trainWarn = $('#trainWarn');
const totalEpochsEl = $('#totalEpochs');
const totalEpochsVal = $('#totalEpochsVal');
const batchSizeEl = $('#batchSize');
const batchSizeVal = $('#batchSizeVal');
const trainBtn = $('#trainBtn');
const trainProgress = $('#trainProgress');
const trainStageList = $('#trainStageList');
const trainBar = $('#trainBar');
const trainBarFill = $('#trainBarFill');
const trainPct = $('#trainPct');
const trainDetail = $('#trainDetail');
const trainLog = $('#trainLog');
const trainFail = $('#trainFail');
const trainFailMsg = $('#trainFailMsg');
const trainRetry = $('#trainRetry');

const TRAIN_STAGES = ['预处理', '特征提取', '训练', '索引'];
const VOICE_NAME_RE = /^[\w\u4e00-\u9fff][\w\u4e00-\u9fff-]{0,19}$/; /* 首字符不能是连字符，与服务端一致 */
const VOICE_FILE_MAX_BYTES = 50 * 1048576; /* 单文件 50MB */
const VOICE_MIN_TOTAL_SEC = 180;           /* 有效时长合计 ≥3 分钟 */
const TRAIN_POLL_MS = 2000;                /* 训练轮询间隔（同翻唱节奏） */
const TRAIN_POLL_MS_HIDDEN = 5000;         /* 页面隐藏时降频 */

/* trained_at 兼容三种口径：ISO 字符串 / 秒级时间戳 / 毫秒级时间戳 */
function fmtTrainedAt(v) {
  let d = null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    d = new Date(v > 1e12 ? v : v * 1000);
  } else if (typeof v === 'string' && v) {
    d = new Date(v);
  }
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* 当前选中的声音模型名；下拉未就绪时兜底内置零样本 */
function currentVoiceModel() {
  const v = voiceSelect && voiceSelect.value;
  return (typeof v === 'string' && v) ? v : 'seedvc_zero';
}

/* ---- 模型下拉：拉取 + 渲染（missing 禁用；seedvc_zero 标零样本） ---- */

async function refreshVoiceModels(preferName) {
  modelsRefresh.disabled = true;
  try {
    const res = await apiFetch('/api/voice/models');
    if (!res.ok) throw await errorFromResponse(res, '获取模型列表');
    const data = await res.json();
    voice.models = Array.isArray(data && data.models) ? data.models : [];
    renderVoiceModels(preferName);
    modelNote.hidden = true;
    modelNote.textContent = '';
  } catch (err) {
    const msg = err instanceof TypeError
      ? '网络错误：无法连接本地服务，请确认后端已启动后重试'
      : (err.message || '获取模型列表失败：未知错误');
    modelNote.textContent = msg;
    modelNote.hidden = false;
  } finally {
    modelsRefresh.disabled = false;
  }
}

function renderVoiceModels(preferName) {
  const prev = voiceSelect.value;
  voiceSelect.textContent = '';
  let preferred = '';
  for (const m of voice.models) {
    const name = (m && (m.voice_name || m.name)) || '';   /* 后端字段 voice_name；容错旧字段 name */
    if (!name) continue;
    const missing = m.status === 'missing';
    const opt = document.createElement('option');
    opt.value = name;
    opt.disabled = missing;
    if (name === 'seedvc_zero') {
      opt.textContent = '零样本（免训练）';
    } else {
      const when = m.trained_at ? ` · ${fmtTrainedAt(m.trained_at)}` : '';
      opt.textContent = `${name}${when}${missing ? '（文件缺失）' : ''}`;
    }
    voiceSelect.appendChild(opt);
    if (preferName && name === preferName && !missing) preferred = name;
  }
  /* 优先选 preferName（刚训练完成），其次保持原选择，最后选第一个可用项 */
  const opts = [...voiceSelect.options];
  if (preferred) {
    voiceSelect.value = preferred;
  } else if (opts.some((o) => o.value === prev && !o.disabled)) {
    voiceSelect.value = prev;
  } else {
    const firstOk = opts.find((o) => !o.disabled);
    if (firstOk) voiceSelect.value = firstOk.value;
  }
  applyModelGating();
}

/* ---- 模型联动：选中训练模型（RVC）时禁用调教控件并注明原因 ---- */

function applyModelGating() {
  const isZero = currentVoiceModel() === 'seedvc_zero';
  for (const box of [hqSoloEl, pcSoloEl, hqCoverEl, pcCoverEl, autoF0El]) {
    box.disabled = !isZero;
    const row = box.closest('.check-row');
    if (row) row.classList.toggle('is-locked', !isZero);
  }
  gateNoteSolo.hidden = isZero;
  gateNoteCover.hidden = isZero;
  if (!isZero) {
    const hint = '当前使用训练模型（RVC）：自带音准处理，以上选项将被忽略';
    gateNoteSolo.textContent = hint;
    gateNoteCover.textContent = hint;
  }
  syncStepsLock();
}

voiceSelect.addEventListener('change', applyModelGating);
modelsRefresh.addEventListener('click', () => refreshVoiceModels());

/* ---- 训练素材：多文件选择 / 逐个探测时长 / 列表渲染 / 素材量提示 ---- */

trainFileInput.addEventListener('change', (e) => {
  const picked = [...(e.currentTarget.files || [])];
  e.currentTarget.value = ''; /* 允许重复选择同一批文件 */
  const okExts = /\.(wav|mp3|m4a|flac|ogg)$/i;
  const okMimes = /^audio\/(wav|x-wav|wave|mpeg|mp3|mp4|x-m4a|m4a|ogg|flac)/i;
  const accepted = picked.filter((f) => {
    if (f.size > VOICE_FILE_MAX_BYTES) {
      toast(`「${f.name}」超过单文件 50MB 上限（当前 ${fmtSize(f.size)}），已跳过`, 'error');
      return false;
    }
    if (!okExts.test(f.name) && !okMimes.test(f.type || '')) {
      toast(`「${f.name}」格式暂不支持：仅接受 wav / mp3 / m4a / flac / ogg`, 'error');
      return false;
    }
    return true;
  });
  if (accepted.length) {
    voice.files = voice.files.concat(accepted.map((f) => ({ file: f, duration: NaN })));
    renderTrainFiles();
  }
});

function renderTrainFiles() {
  trainFilesList.textContent = '';
  if (!voice.files.length) {
    trainFilesList.hidden = true;
    trainFilesSummary.hidden = true;
    updateTrainWarn();
    return;
  }
  trainFilesList.hidden = false;
  trainFilesSummary.hidden = false;
  voice.files.forEach((item, i) => {
    const row = el('div', 'train-file-row');
    const meta = el('span', 'tfr-meta',
      Number.isFinite(item.duration) && item.duration > 0 ? fmtClock(item.duration) : '时长探测中…');
    const del = el('button', 'tfr-del');
    del.type = 'button';
    del.textContent = '×';
    del.setAttribute('aria-label', `移除 ${item.file.name}`);
    del.addEventListener('click', () => {
      voice.files.splice(i, 1);
      renderTrainFiles();
    });
    row.append(
      el('span', 'tfr-name', item.file.name),
      el('span', 'tfr-size', fmtSize(item.file.size)),
      meta,
      del,
    );
    trainFilesList.appendChild(row);
    if (!(Number.isFinite(item.duration) && item.duration > 0)) {
      probeDuration(item.file).then((d) => {
        item.duration = d;
        meta.textContent = Number.isFinite(d) && d > 0 ? fmtClock(d) : '时长未知';
        updateTrainWarn();
      });
    }
  });
  updateTrainWarn();
}

/* 素材量提示：全部已知且合计 <3 分钟 → 红色警告（提交时同样拦截） */
function updateTrainWarn() {
  const known = voice.files.filter((it) => Number.isFinite(it.duration) && it.duration > 0);
  const total = known.reduce((s, it) => s + it.duration, 0);
  trainFilesSummary.textContent = voice.files.length
    ? `共 ${voice.files.length} 个文件 · 已知累计时长约 ${fmtClock(total)}${known.length < voice.files.length ? '（部分时长未知）' : ''}`
    : '';
  if (voice.files.length && known.length === voice.files.length && total < VOICE_MIN_TOTAL_SEC) {
    trainWarn.hidden = false;
    trainWarn.textContent = `素材不足 3 分钟（当前约 ${fmtClock(total)}），建议 10 分钟以上`;
  } else {
    trainWarn.hidden = true;
    trainWarn.textContent = '';
  }
}

/* ---- 训练参数滑杆 ---- */

totalEpochsEl.addEventListener('input', () => {
  totalEpochsVal.textContent = totalEpochsEl.value;
  paintRange(totalEpochsEl);
});
batchSizeEl.addEventListener('input', () => {
  batchSizeVal.textContent = batchSizeEl.value;
  paintRange(batchSizeEl);
});
paintRange(totalEpochsEl);
paintRange(batchSizeEl);

/* ---- 训练进度渲染（复用翻唱进度样式，阶段列表独立） ---- */

function setTrainBar(p) {
  trainBarFill.style.width = `${p}%`;
  trainBar.setAttribute('aria-valuenow', String(p));
}

function resetTrainProgress() {
  trainProgress.hidden = false;
  trainFail.hidden = true;
  trainFailMsg.textContent = '';
  trainDetail.textContent = '';
  trainPct.textContent = '0%';
  trainLog.hidden = true;
  trainLog.textContent = '';
  setTrainBar(0);
  setStageHighlight(trainStageList, TRAIN_STAGES, -1);
}

function applyTrainStatus(st) {
  const stageName = st && typeof st.stage === 'string' ? st.stage : '';
  const idx = TRAIN_STAGES.indexOf(stageName);
  setStageHighlight(trainStageList, TRAIN_STAGES, stageName === '完成' ? TRAIN_STAGES.length : idx);
  const p = Math.max(0, Math.min(100, Math.round(Number(st && st.progress) || 0)));
  setTrainBar(p);
  trainPct.textContent = `${p}%`;
  trainDetail.textContent = stageName ? `当前阶段：${stageName}` : '训练进行中…';
  const tail = st && Array.isArray(st.log_tail) ? st.log_tail : [];
  if (tail.length) {
    trainLog.hidden = false;
    trainLog.textContent = tail.slice(-6).join('\n'); /* 最近几行，等宽小字 */
    trainLog.scrollTop = trainLog.scrollHeight;
  }
}

/* ---- 按钮可用性：转换 / 翻唱 / 训练三方互斥 ---- */

function updateTrainBtn() {
  trainBtn.disabled = voice.training || state.converting || cover.running;
  trainBtn.classList.toggle('is-loading', voice.training);
}

/* ---- 发起训练 ---- */

function fatalTrainError(message) {
  const e = new Error(message);
  e.fatal = true;
  return e;
}

async function startTrain() {
  if (voice.training) return; /* 防重入：训练中禁止再次提交 */
  if (state.converting || cover.running) {
    toast('转换 / 翻唱正在进行中：请等待其完成后再开始训练', 'error');
    return;
  }
  const name = voiceNameEl.value.trim();
  if (!name) {
    toast('请先填写模型名称（中文 / 字母 / 数字 / 连字符，不超过 20 字）', 'error');
    voiceNameEl.focus();
    return;
  }
  if (!VOICE_NAME_RE.test(name)) {
    toast('模型名称格式不正确：仅支持中文、字母、数字、下划线与连字符，长度 1~20，且不能以连字符开头', 'error');
    voiceNameEl.focus();
    return;
  }
  if (!voice.files.length) {
    toast('请先选择训练素材音频（可多选）', 'error');
    return;
  }
  const known = voice.files.filter((it) => Number.isFinite(it.duration) && it.duration > 0);
  const total = known.reduce((s, it) => s + it.duration, 0);
  if (known.length === voice.files.length && total < VOICE_MIN_TOTAL_SEC) {
    toast(`素材累计不足 3 分钟（当前约 ${fmtClock(total)}）：建议补充到 10 分钟以上`, 'error');
    return;
  }

  voice.training = true;
  voice.jobId = null;
  voice.netFails = 0;
  voice.lastTrained = name;
  updateTrainBtn();
  updateConvertBtn();
  updateCoverBtn();
  trainAdv.open = true; /* 保持折叠区展开，进度可见 */
  resetTrainProgress();
  trainDetail.textContent = '正在提交训练任务…';

  try {
    const fd = new FormData();
    fd.append('voice_name', name);
    for (const it of voice.files) fd.append('voice_files', it.file, it.file.name);
    fd.append('total_epochs', String(Number(totalEpochsEl.value)));
    fd.append('batch_size', String(Number(batchSizeEl.value)));
    const res = await apiFetch('/api/voice/train', { method: 'POST', body: fd });
    if (!res.ok) throw await errorFromResponse(res, '发起训练');
    const data = await res.json();
    if (!data || !data.job_id) throw new Error('发起训练失败：服务端未返回任务 ID');
    voice.jobId = data.job_id;
    voice.netFails = 0;
    trainDetail.textContent = data.message ? `任务已创建：${data.message}` : '任务已创建，训练已开始…';
    scheduleTrainPoll();
  } catch (err) {
    const msg = err instanceof TypeError
      ? '网络错误：无法连接本地服务，请确认后端已启动后重试'
      : (err.message || '发起训练失败：未知错误');
    trainFailFinish(msg);
  }
}

/* ---- 训练轮询：间隔 2s，页面隐藏时降为 5s；网络错误累计 3 次终止 ---- */

function scheduleTrainPoll() {
  clearTimeout(voice.pollTimer);
  voice.pollTimer = window.setTimeout(trainTick, document.hidden ? TRAIN_POLL_MS_HIDDEN : TRAIN_POLL_MS);
}

async function trainTick() {
  if (!voice.training || !voice.jobId) return;
  try {
    const res = await apiFetch(`/api/voice/train/status/${encodeURIComponent(voice.jobId)}`);
    if (res.status === 404) {
      throw fatalTrainError('查询训练状态失败：任务不存在（可能因服务重启丢失）');
    }
    if (!res.ok) {
      let detail = '';
      try {
        const d = await res.json();
        if (d && typeof d.detail === 'string' && d.detail) detail = d.detail;
      } catch (_) { /* 响应体不是 JSON */ }
      throw fatalTrainError(detail ? `查询训练状态失败：${detail}` : `查询训练状态失败（HTTP ${res.status}）`);
    }
    const st = await res.json();
    if (!voice.training) return; /* 轮询期间已被重置 */
    voice.netFails = 0;
    applyTrainStatus(st);

    if (st.state === 'done') { trainDoneFinish(); return; }
    if (st.state === 'failed') {
      const msg = (typeof st.error === 'string' && st.error) ? st.error : '训练失败：未知错误';
      trainFailFinish(msg);
      return;
    }
    scheduleTrainPoll();
  } catch (err) {
    if (!voice.training) return;
    if (err && err.fatal) { trainFailFinish(err.message); return; }
    voice.netFails += 1;
    if (voice.netFails >= 3) {
      trainFailFinish('网络错误：连续 3 次查询训练状态失败，请检查本地服务是否仍在运行');
      return;
    }
    trainDetail.textContent = `网络波动，正在重试查询（${voice.netFails}/3）…`;
    scheduleTrainPoll();
  }
}

function trainFailFinish(msg) {
  clearTimeout(voice.pollTimer);
  voice.training = false;
  voice.jobId = null;
  trainFailMsg.textContent = msg;
  trainFail.hidden = false;
  trainLog.hidden = true;
  updateTrainBtn();
  updateConvertBtn();
  updateCoverBtn();
  toast(msg, 'error', 6000);
}

function trainDoneFinish() {
  clearTimeout(voice.pollTimer);
  voice.training = false;
  voice.jobId = null;
  setStageHighlight(trainStageList, TRAIN_STAGES, TRAIN_STAGES.length);
  setTrainBar(100);
  trainPct.textContent = '100%';
  trainDetail.textContent = '训练完成';
  trainLog.hidden = true;
  updateTrainBtn();
  updateConvertBtn();
  updateCoverBtn();
  /* 刷新模型下拉并自动选中新训练的模型 */
  refreshVoiceModels(voice.lastTrained);
  toast('训练完成，专属音色模型已就绪', 'success');
}

trainRetry.addEventListener('click', () => startTrain());
trainBtn.addEventListener('click', startTrain);

/* ---- 初始化：拉取模型列表 + 空素材列表 + 滑杆锁定初始态 ---- */

updateTrainBtn();
renderTrainFiles();
syncStepsLock();
refreshVoiceModels();

/* =====================================================================
 * 初始化：两块录音卡片（各自独立状态）
 * ===================================================================== */

createRecorderCard({
  stage: $('#stageReference'), card: $('#cardReference'), key: 'reference', fileBase: '音色参考',
  onReady: (file) => analyzeTimbre(file),
  onReset: resetTimbre,
});
createRecorderCard({ stage: $('#stageSource'), card: $('#cardSource'), key: 'source', fileBase: '清唱片段' });

/* =====================================================================
 * 连接设置（第四期）：后端地址 + API Token，localStorage 持久化
 * 部署态（GitHub Pages / 局域网手机访问）时配置跨源地址与可选 Token；
 * 本机使用留空 = 本页同源。保存后立即热更新 API_BASE 并做连通性探测。
 * ===================================================================== */

const settingsBtn = $('#settingsBtn');
const settingsModal = $('#settingsModal');
const settingsClose = $('#settingsClose');
const apiBaseInput = $('#apiBaseInput');
const apiTokenInput = $('#apiTokenInput');
const settingsProbe = $('#settingsProbe');
const settingsClear = $('#settingsClear');
const settingsSave = $('#settingsSave');

function openSettings() {
  apiBaseInput.value = API_BASE;
  apiTokenInput.value = apiToken();
  settingsProbe.hidden = true;
  settingsProbe.textContent = '';
  settingsProbe.className = 'settings-probe';
  settingsModal.hidden = false;
  apiBaseInput.focus();
}

function closeSettings() {
  settingsModal.hidden = true;
}

settingsBtn.addEventListener('click', openSettings);
settingsClose.addEventListener('click', closeSettings);
/* 点击遮罩空白处关闭；Escape 键关闭 */
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) closeSettings();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !settingsModal.hidden) closeSettings();
});

/* 连通性探测：GET {API_BASE}/api/voice/models，展示后端版本 / 模型数 */
async function probeConnection() {
  settingsProbe.hidden = false;
  settingsProbe.className = 'settings-probe is-busy';
  settingsProbe.textContent = '正在测试连接…';
  try {
    const res = await apiFetch('/api/voice/models');
    if (!res.ok) {
      let detail = '';
      try { const d = await res.json(); if (d && typeof d.detail === 'string') detail = d.detail; } catch (_) { /* 非 JSON */ }
      settingsProbe.className = 'settings-probe is-error';
      settingsProbe.textContent = `连接失败（HTTP ${res.status}）${detail ? `：${detail}` : ''}`;
      return;
    }
    const data = await res.json();
    const n = Array.isArray(data && data.models) ? data.models.length : 0;
    const ver = (data && typeof data.version === 'string' && data.version) ? ` · 后端 ${data.version}` : '';
    settingsProbe.className = 'settings-probe is-ok';
    settingsProbe.textContent = `连接成功：发现 ${n} 个声音模型${ver}`;
  } catch (err) {
    settingsProbe.className = 'settings-probe is-error';
    settingsProbe.textContent = err instanceof TypeError
      ? '连接失败：无法访问该地址（请检查地址是否正确、后端是否启动、浏览器「本地网络访问」权限）'
      : (err.message || '连接失败：未知错误');
  }
}

settingsSave.addEventListener('click', () => {
  const base = apiBaseInput.value.trim().replace(/\/+$/, '');
  if (base && !/^https?:\/\//i.test(base)) {
    settingsProbe.hidden = false;
    settingsProbe.className = 'settings-probe is-error';
    settingsProbe.textContent = '后端地址需以 http:// 或 https:// 开头（本机使用可留空）';
    return;
  }
  const token = apiTokenInput.value.trim();
  store.set('vsc_api_base', base);
  store.set('vsc_api_token', token);
  API_BASE = base; /* 热更新立即生效（这也是 API_BASE 用 let 的原因） */
  toast('连接设置已保存', 'success');
  probeConnection();
});

settingsClear.addEventListener('click', () => {
  store.del('vsc_api_base');
  store.del('vsc_api_token');
  API_BASE = '';
  apiBaseInput.value = '';
  apiTokenInput.value = '';
  settingsProbe.hidden = true;
  settingsProbe.textContent = '';
  toast('已清除连接配置，恢复本页同源访问', 'success');
});
