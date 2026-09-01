/**
 * 播放器层：适配车载大屏触摸
 * 统一播放引擎（tesla-media-hub 内置播放库，基于 wody11/Tesla-VideoPlayer）：
 *   - 完全无 <video> 标签，纯 WebCodecs 解码 → Canvas 渲染
 *   - AppleCMS 点播：浏览器直连源站 HLS/MP4（不走服务端，零服务器负载）
 *   - IPTV 直播：浏览器拉取服务端 ffmpeg 转码推流的 MPEG-TS 流
 *   - 源站不支持 WebCodecs 或跨域受限时给出提示
 */

const playerLayer = document.getElementById('player-layer');
let iptvPlayer = null;     // 统一播放实例（tesla-media-hub 内置播放库），承载 IPTV 直播与 AppleCMS 点播
let playCtx = null;        // AppleCMS 点播上下文：{ siteKey, vodName, plays, flagIdx, curEp, qualityIdx, urls, lastUrl, isLastEp }
let startupTimer = null;   // 点播首帧超时诊断：黑屏无提示时给出可能原因
let lastFramePaused = false; // 末集/单集：已在最后一秒暂停画面，避免重复暂停与误触发续播
const LAST_FRAME_PAUSE_SEC = 1; // 距离片尾不足该秒数时暂停在末帧

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * 将第三方播放地址改写为同源流媒体代理地址，绕过源站防盗链 / 跨域限制。
 * - blob:/data: 等浏览器本地地址原样返回
 * - 已是 /api/stream 的地址（幂等）原样返回
 * - 仅对 http(s) 绝对地址进行代理包装
 */
function proxyUrl(raw) {
  if (!raw) return raw;
  if (/^(blob:|data:)/i.test(raw)) return raw;
  if (raw.indexOf('/api/stream') !== -1) return raw;
  if (/^https?:\/\//i.test(raw)) return '/api/stream?url=' + encodeURIComponent(raw);
  return raw;
}

async function openPlayer(ctx) {
  // 销毁可能存在的播放实例（包括 AppleCMS/IPTv 任一模式）
  if (iptvPlayer) {
    try { iptvPlayer.destroy(); } catch (e) { /* ignore */ }
    iptvPlayer = null;
  }
  playCtx = {
    ...ctx,
    curEp: ctx.startEp || 0,
    qualityIdx: -1,
    urls: [],
    lastUrl: '',        // 当前集解析后的真实播放地址
  };
  playerLayer.classList.remove('hidden');
  renderEpStrip();
  await playCurrent();
}

/**
 * 打开 IPTV 频道播放（服务端 ffmpeg 转码推流 → tesla-media-hub 内置播放库拉流）
 * ctx: { sourceId, name, type, streamUrl }
 */
async function openIptvPlayer(ctx) {
  if (iptvPlayer) {
    try { iptvPlayer.destroy(); } catch (e) { /* ignore */ }
    iptvPlayer = null;
  }
  playCtx = null; // 清理可能残留的 applecms 上下文，避免互相干扰

  const driveView = document.getElementById('drive-view');
  const iptvView = document.getElementById('iptv-view');
  const host = document.getElementById('iptv-host');
  const titleEl = document.getElementById('player-title');
  const qBtn = document.getElementById('btn-quality');

  titleEl.textContent = ctx.name || 'IPTV';
  if (qBtn) qBtn.style.display = 'none';

  playerLayer.classList.remove('hidden');
  driveView.classList.add('hidden');
  iptvView.classList.remove('hidden');

  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }

  if (!window.IptvAdapter || !window.IptvAdapter.isSupported()) {
    showToast('当前浏览器不支持 WebCodecs（IPTV 播放所需）');
    return;
  }

  showToast('正在加载 ' + (ctx.name || '频道'));
  try {
    iptvPlayer = await window.IptvAdapter.createPlayer(host, ctx.streamUrl, {
      live: true,
      onFirstFrame: () => {
        const t = document.getElementById('toast');
        if (t) t.classList.remove('show');
      },
      onStatus: (msg) => showToast(msg),
      onError: (e) => showToast('播放出错：' + (e && e.message ? e.message : '未知错误')),
      onEnded: () => showToast('直播已结束'),
    });
  } catch (e) {
    showToast('IPTV 播放失败：' + (e && e.message ? e.message : ''));
  }
}
window.openIptvPlayer = openIptvPlayer;

/**
 * 启动 AppleCMS 点播播放（tesla-media-hub 内置播放库，VOD 模式）
 */
async function applyMode() {
  const ctx = playCtx;
  if (!ctx) return;

  const driveView = document.getElementById('drive-view');
  const driveHost = document.getElementById('tesla-host');
  const iptvView = document.getElementById('iptv-view');

  // 切到 AppleCMS 视图（drive-view 容器），隐藏 iptv-view
  iptvView.classList.add('hidden');
  driveView.classList.remove('hidden');
  driveHost.classList.remove('hidden');

  // 销毁可能残留的播放实例
  if (iptvPlayer) {
    try { iptvPlayer.destroy(); } catch (e) { /* ignore */ }
    iptvPlayer = null;
  }

  if (!window.IptvAdapter || !window.IptvAdapter.isSupported()) {
    showToast('当前浏览器不支持 WebCodecs');
    return;
  }

  // 统一通过同源流媒体代理播放，绕过源站防盗链 / 跨域
  ctx.lastUrl = proxyUrl(ctx.lastUrl);

  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  // 首帧超时提示：解码/渲染若静默失败（黑屏无报错），主动给出可能原因
  startupTimer = setTimeout(() => {
    startupTimer = null;
    showToast('首帧等待超时：该片源可能为车机不支持的编码（如 HEVC/H265）或解码缓慢，可尝试切换线路');
  }, 15000);

  try {
    iptvPlayer = await window.IptvAdapter.createPlayer(driveHost, ctx.lastUrl, {
      live: false,
      onFirstFrame: () => {
        if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
      },
      onError: (e) => {
        if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
        showToast('播放出错：' + (e && e.message ? e.message : '未知错误'));
      },
      // 时间更新：末集/单集在最后一秒暂停画面，保留末帧（不黑屏、不销毁）
      onTime: (currentTime, duration) => {
        const c = playCtx;
        if (!c || !c.isLastEp) return;          // 非末集不处理（由 onEnded 自动续播）
        if (lastFramePaused) return;            // 已暂停，跳过
        if (!duration || duration <= 0) return;  // 直播/时长未知不处理
        if (duration - currentTime <= LAST_FRAME_PAUSE_SEC) {
          lastFramePaused = true;
          try { iptvPlayer && iptvPlayer.pause(); } catch (_) { /* ignore */ }
          showToast('已播至本片结尾（末集）');
        }
      },
      // 播放结束：非末集自动续播下一集；末集由 onTime 已暂停在末帧，此处兜底
      onEnded: () => {
        const c = playCtx;
        if (!c) return;
        if (!c.isLastEp) {
          const next = c.curEp + 1;
          const epsLen = ((c.plays[c.flagIdx] || {}).episodes || []).length;
          if (next < epsLen) {
            showToast('自动播放下一集…');
            switchEp(next);
          }
        } else if (iptvPlayer && !lastFramePaused) {
          // 兜底：极端情况下 onTime 未命中，则在此暂停保持末帧
          lastFramePaused = true;
          try { iptvPlayer.pause(); } catch (_) { /* ignore */ }
        }
      },
    });
  } catch (e) {
    if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
    showToast('播放失败（浏览器需支持 WebCodecs 且源站允许跨域）：' + (e && e.message ? e.message : ''));
  }
}

function renderEpStrip() {
  const ctx = playCtx;
  const flag = (ctx.plays[ctx.flagIdx] || {});
  const eps = flag.episodes || [];
  const strip = document.getElementById('ep-strip');
  strip.innerHTML = eps
    .map((e, i) => `<button class="ep-mini ${i === ctx.curEp ? 'active' : ''}" onclick="switchEp(${i})">${esc(e.name || '第' + (i + 1) + '集')}</button>`)
    .join('');
  const active = strip.querySelector('.ep-mini.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
}

async function switchEp(i) {
  const ctx = playCtx;
  const eps = (ctx.plays[ctx.flagIdx] || {}).episodes || [];
  if (i < 0 || i >= eps.length) return;
  ctx.curEp = i;
  renderEpStrip();
  await playCurrent();
}

async function playCurrent(resume) {
  const ctx = playCtx;
  const flag = ctx.plays[ctx.flagIdx] || {};
  const ep = (flag.episodes || [])[ctx.curEp];
  if (!ep) {
    showToast('该线路暂无选集');
    return;
  }
  const title = `${ctx.vodName} · ${ep.name || '第' + (ctx.curEp + 1) + '集'}`;
  document.getElementById('player-title').textContent = title;

  // 是否为当前线路最后一集（或单集）：用于「末集停在末帧」判定
  const eps = (flag.episodes || []);
  ctx.isLastEp = ctx.curEp >= eps.length - 1;
  lastFramePaused = false; // 新的一集重新开始计时

  let res;
  try {
    res = await api(
      `/api/sites/${encodeURIComponent(ctx.siteKey)}/play` +
      `?id=${encodeURIComponent(ep.id || ep.url || '')}`
    );
  } catch (e) {
    showToast('获取播放地址失败：' + e.message);
    return;
  }

  ctx.lastUrl = res.url || ep.url || ep.id || '';
  ctx.urls = (res.urls && res.urls.length) ? res.urls : (res.url ? [{ label: res.label || '自动', url: res.url }] : []);
  if (!ctx.urls.length) {
    showToast('未获取到播放地址');
    return;
  }
  ctx.qualityIdx = ctx.urls.length - 1;

  const qBtn = document.getElementById('btn-quality');
  if (ctx.urls.length > 1) {
    qBtn.style.display = '';
    qBtn.textContent = ctx.urls[ctx.qualityIdx].label;
  } else {
    qBtn.style.display = 'none';
  }

  // 用解析出的地址启动 tesla-media-hub 内置播放库解码
  await applyMode();
}

async function cycleQuality() {
  const ctx = playCtx;
  if (!ctx.urls || ctx.urls.length < 2) return;
  ctx.qualityIdx = (ctx.qualityIdx + 1) % ctx.urls.length;
  const q = ctx.urls[ctx.qualityIdx];
  document.getElementById('btn-quality').textContent = q.label;
  ctx.lastUrl = q.url;
  await applyMode(); // 重建播放实例以装载新清晰度
  showToast('已切换：' + q.label);
}

function closePlayer() {
  // 所有清理均 try/catch，确保最终必能关闭播放层返回页面
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  if (iptvPlayer) {
    try { iptvPlayer.destroy(); } catch (e) { /* ignore */ }
    iptvPlayer = null;
  }

  // 清理播放器容器内的 canvas/控件，保留 view 容器（drive-view/iptv-view），避免下次打开叠加
  try {
    const driveHost = document.getElementById('tesla-host');
    const iptvHost = document.getElementById('iptv-host');
    if (driveHost) driveHost.innerHTML = '';
    if (iptvHost) iptvHost.innerHTML = '';
    document.getElementById('drive-view').classList.add('hidden');
    document.getElementById('iptv-view').classList.add('hidden');
  } catch (e) { /* ignore */ }

  // 清空选集条，释放 DOM 与播放缓存
  try { document.getElementById('ep-strip').innerHTML = ''; } catch (e) { /* ignore */ }

  playCtx = null;
  lastFramePaused = false;
  playerLayer.classList.add('hidden');
}

// 暴露给 app.js 使用
window.openPlayer = openPlayer;
window.switchEp = switchEp;
window.cycleQuality = cycleQuality;
window.closePlayer = closePlayer;
