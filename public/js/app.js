/**
 * 主应用：hash 路由 + 页面渲染（源 → 站点 → 内容 → 详情 → 播放）
 */

const app = document.getElementById('app');

// ---------- 工具 ----------
let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

function setTitle(title, sub) {
  document.getElementById('page-title').textContent = title;
  document.getElementById('page-sub').textContent = sub || '';
}

function showModal(html) {
  const el = document.getElementById('modal');
  el.innerHTML = html;
  el.classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}
window.closeModal = closeModal;

// ---------- 路由 ----------
const navStack = [];
function parseHash() {
  const h = location.hash.slice(1) || '/';
  const [path, queryStr] = h.split('?');
  const query = {};
  if (queryStr) new URLSearchParams(queryStr).forEach((v, k) => { query[k] = v; });
  return { path, query };
}
function go(hash) {
  navStack.push(location.hash.slice(1) || '/');
  location.hash = hash;
}
function historyBack() {
  const prev = navStack.pop();
  if (prev) location.hash = prev;
  else location.hash = '/';
}
window.historyBack = historyBack;
window.go = go;

async function render() {
  const { path } = parseHash();
  const segs = path.split('/').filter(Boolean);
  try {
    if (!segs.length) await renderHome();
    else if (segs[0] === 'browse') await renderBrowse(decodeURIComponent(segs[1]));
    else if (segs[0] === 'detail') await renderDetail(decodeURIComponent(segs[1]), decodeURIComponent(segs[2]));
    else if (segs[0] === 'webdav') await renderWebdav(decodeURIComponent(segs[1] || ''));
    else if (segs[0] === 'iptv') {
      app.innerHTML = '<div class="empty">IPTV 功能已禁用（本部署已移除）</div>';
    }
    else await renderHome();
  } catch (e) {
    app.innerHTML = `<div class="empty">加载失败：${esc(e.message)}<br><br><button class="btn primary" onclick="go('/')">返回首页</button></div>`;
  }
}
window.addEventListener('hashchange', render);

// ---------- 首页：数据源列表（仅切换用，管理在 /admin） ----------
async function renderHome() {
  setTitle('车载影视', '选择数据源');
  const data = await api('/api/sources');
  const list = data.list || [];
  const sourceCards = list.length
    ? list.map((s) => `
        <div class="card source-card" onclick="enterSource('${s.id}','${esc(s.type)}')">
          <div class="card-title">${esc(s.name)}</div>
          <div class="card-meta">${esc(s.type)} · ${esc(s.url)}</div>
          <div class="card-actions">
            <button class="enter" onclick="event.stopPropagation();enterSource('${s.id}','${esc(s.type)}')">进入</button>
          </div>
        </div>`).join('')
    : '<div class="empty">暂无数据源<br>请管理员在「管理后台」中添加</div>';
  const webdavCard = `
    <div class="card source-card" onclick="go('/webdav')">
      <div class="card-title">📁 WebDAV 网盘</div>
      <div class="card-meta">播放网盘内 .mp4 / .strm</div>
      <div class="card-actions">
        <button class="enter" onclick="event.stopPropagation();go('/webdav')">进入</button>
      </div>
    </div>`;
  app.innerHTML = `
    <div class="page-title">选择数据源</div>
    <div class="card-grid">
      ${sourceCards}
      ${webdavCard}
    </div>`;
}

/** 根据源类型进入对应浏览页：applecms → 站点浏览；iptv 已禁用 */
function enterSource(sourceId, type) {
  if (String(type || '').toLowerCase() === 'iptv') {
    showToast('IPTV 功能已禁用（本部署已移除）');
    return;
  }
  enterSourceBrowse(sourceId);
}
window.enterSource = enterSource;

// ---------- IPTV 频道列表 ----------
const iptvState = { sourceId: '', sourceName: '', channels: [] };

function enterIptv(sourceId) {
  go(`/iptv/${encodeURIComponent(sourceId)}`);
}
window.enterIptv = enterIptv;

async function renderIptv(sourceId) {
  iptvState.sourceId = sourceId;
  setTitle('加载中…', '');
  app.innerHTML = '<div class="loading">加载中…</div>';
  try {
    const data = await api(`/api/iptv/channels?sourceId=${encodeURIComponent(sourceId)}`);
    iptvState.sourceName = (data.source && data.source.name) || '';
    iptvState.channels = data.channels || [];
    setTitle(iptvState.sourceName || 'IPTV', `共 ${iptvState.channels.length} 个频道`);
    renderIptvContent();
  } catch (e) {
    app.innerHTML = `<div class="empty">加载失败：${esc(e.message)}<br><br><button class="btn primary" onclick="go('/')">返回首页</button></div>`;
  }
}

function renderIptvContent() {
  const list = iptvState.channels;
  const grid = list.length
    ? `<div class="card-grid">${list.map((c) => channelCardHtml(c)).join('')}</div>`
    : '<div class="empty">该 IPTV 源未解析到可用频道<br>（请检查 M3U 地址与格式）</div>';
  app.innerHTML = `
    <div class="page-title">${esc(iptvState.sourceName || 'IPTV')} · 频道列表</div>
    ${grid}`;
}

function channelCardHtml(c) {
  const meta = [String(c.type || '').toUpperCase()];
  if (c.transcode) meta.push('转码');
  if (!c.transcode && c.direct) meta.push('直连');
  return `
    <div class="card vod-card" onclick="playIptvChannel('${esc(iptvState.sourceId)}','${esc(c.id)}')">
      <div class="poster"><div class="remarks">${esc(meta.join(' '))}</div></div>
      <div class="v-name">${esc(c.name)}</div>
    </div>`;
}

function playIptvChannel(sourceId, channelId) {
  const ch = iptvState.channels.find((c) => String(c.id) === String(channelId));
  if (!ch) return showToast('频道不存在');
  // IPTV 流默认需管理员 token（服务端 IPTV_AUTH=true）；从本地存储取，与管理后台同源共享
  let token = '';
  try { token = localStorage.getItem('media_hub_admin_token') || ''; } catch (_) { /* ignore */ }
  const streamUrl =
    ch.playUrl + (ch.playUrl.includes('?') ? '&' : '?') +
    'sid=' + Date.now().toString(36) + Math.random().toString(36).slice(2) +
    (token ? '&token=' + encodeURIComponent(token) : '');
  openIptvPlayer({ sourceId, name: ch.name, type: ch.type, streamUrl });
}
window.playIptvChannel = playIptvChannel;

/** 点击源：解析站点后直接进入首个站点浏览（多站支持浏览页顶栏切换） */
async function enterSourceBrowse(sourceId) {
  try {
    const data = await api(`/api/sources/${sourceId}/sites`);
    const sites = data.list || [];
    if (!sites.length) return showToast('该源无可用站点');
    browseState.sites = sites;
    enterSite(encodeURIComponent(sites[0].key));
  } catch (e) {
    showToast(e.message);
  }
}
window.enterSourceBrowse = enterSourceBrowse;

function enterSite(encodedKey) {
  // 调用方已 encodeURIComponent，这里不再二次编码（避免 :: 被双重编码导致服务端解析失败）
  go(`/browse/${encodedKey}`);
}
window.enterSite = enterSite;

// ---------- 内容浏览 ----------
const browseState = { siteKey: '', classes: [], cat: '', page: 1, pagecount: 1, mode: 'home', wd: '' };

async function renderBrowse(siteKey) {
  browseState.siteKey = siteKey;
  browseState.cat = '';
  browseState.page = 1;
  browseState.mode = 'home';
  browseState.wd = '';
  setTitle('加载中…', '');
  app.innerHTML = '<div class="loading">加载中…</div>';

  // 并行加载：首页内容 + 当前源下全部站点（用于"切换站点"）
  const idx = siteKey.indexOf('::');
  const sourceId = idx < 0 ? siteKey : siteKey.slice(0, idx);
  const [home, sitesRes] = await Promise.all([
    api(`/api/sites/${encodeURIComponent(siteKey)}/home`).catch(() => ({ classes: [], list: [] })),
    api(`/api/sources/${sourceId}/sites`).catch(() => ({ list: [] })),
  ]);
  browseState.classes = home.classes || [];
  browseState.pagecount = 1;
  browseState.sites = (sitesRes && sitesRes.list) || [];
  setTitle('浏览', browseState.sites.length > 1 ? `共 ${browseState.sites.length} 个站点可切换` : '');
  renderBrowseContent(home.list || []);
}

function searchRowHtml() {
  return `
    <div class="search-row">
      <input id="search-input" placeholder="搜索影视名称" value="${esc(browseState.wd)}">
      <button onclick="doSearch()">搜索</button>
    </div>`;
}

function renderBrowseContent(list) {
  const switchSiteBtn = (browseState.sites && browseState.sites.length > 1)
    ? `<div style="display:flex;justify-content:flex-end;margin-bottom:8px"><button class="btn" style="min-height:40px;padding:0 14px;font-size:14px" onclick="showSwitchSite()">⇆ 切换站点</button></div>`
    : '';
  const catBar = `
    <div class="cat-bar">
      <button class="cat ${browseState.cat === '' ? 'active' : ''}" onclick="selectCat('')">全部</button>
      ${browseState.classes.map((c) => `
        <button class="cat ${browseState.cat === String(c.type_id) ? 'active' : ''}" onclick="selectCat('${esc(String(c.type_id))}')">${esc(c.type_name)}</button>`).join('')}
    </div>`;

  const grid = list.length
    ? `<div class="card-grid">${list.map((v) => vodCardHtml(v)).join('')}</div>`
    : '<div class="empty">暂无内容</div>';

  const pager = browseState.pagecount > 1
    ? `<div class="pager">
        <button class="btn" onclick="changePage(-1)" ${browseState.page <= 1 ? 'disabled style="opacity:.4"' : ''}>上一页</button>
        <span class="info">${browseState.page} / ${browseState.pagecount}</span>
        <button class="btn" onclick="changePage(1)" ${browseState.page >= browseState.pagecount ? 'disabled style="opacity:.4"' : ''}>下一页</button>
      </div>`
    : '';

  app.innerHTML = switchSiteBtn + searchRowHtml() + catBar + grid + pager;
}

function vodCardHtml(v) {
  const pic = v.vod_pic ? `/api/proxy/image?url=${encodeURIComponent(v.vod_pic)}` : '';
  const vodId = encodeURIComponent(String(v.vod_id));
  return `
    <div class="card vod-card" onclick="enterDetail('${encodeURIComponent(browseState.siteKey)}','${vodId}')">
      <div class="poster">
        ${pic ? `<img src="${pic}" loading="lazy" onerror="this.style.display='none'">` : ''}
        ${v.vod_remarks ? `<div class="remarks">${esc(v.vod_remarks)}</div>` : ''}
      </div>
      <div class="v-name">${esc(v.vod_name)}</div>
    </div>`;
}

function enterDetail(siteKey, vodId) {
  go(`/detail/${siteKey}/${vodId}`);
}
window.enterDetail = enterDetail;

async function selectCat(cat) {
  browseState.cat = cat;
  browseState.mode = 'category';
  browseState.page = 1;
  await loadList();
}
window.selectCat = selectCat;

async function doSearch() {
  const input = document.getElementById('search-input');
  const wd = input ? input.value.trim() : '';
  if (!wd) return showToast('请输入搜索关键词');
  browseState.wd = wd;
  browseState.mode = 'search';
  browseState.page = 1;
  await loadList();
}
window.doSearch = doSearch;

async function changePage(delta) {
  browseState.page = Math.max(1, browseState.page + delta);
  await loadList();
}
window.changePage = changePage;

// ---------- 切换站点 ----------
function showSwitchSite() {
  const sites = browseState.sites || [];
  if (sites.length <= 1) return showToast('该源只有 1 个站点');
  const current = browseState.siteKey;
  const cards = sites.map((s) => `
    <div class="card source-card" style="cursor:pointer;border-color:${s.key===current?'var(--accent)':''}" onclick="switchSite('${encodeURIComponent(s.key)}')">
      <span class="badge ${s.sourceType}">${s.sourceType === 'applecms' ? 'AppleCMS' : esc(s.sourceType)}</span>
      <div class="card-title">${esc(s.name)}</div>
      <div class="card-meta">${esc(s.api)}</div>
    </div>`).join('');
  showModal(`
    <div class="modal-body">
      <h3>切换站点</h3>
      ${cards}
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">关闭</button>
      </div>
    </div>`);
}
window.showSwitchSite = showSwitchSite;

function switchSite(encodedKey) {
  closeModal();
  enterSite(encodedKey);
}
window.switchSite = switchSite;

async function loadList() {
  const key = encodeURIComponent(browseState.siteKey);
  let url;
  if (browseState.mode === 'search') {
    url = `/api/sites/${key}/search?wd=${encodeURIComponent(browseState.wd)}&page=${browseState.page}`;
  } else {
    url = `/api/sites/${key}/category?cat=${encodeURIComponent(browseState.cat)}&page=${browseState.page}`;
  }
  try {
    const data = await api(url);
    browseState.pagecount = Math.max(1, Number(data.pagecount || 1));
    renderBrowseContent(data.list || []);
  } catch (e) {
    showToast(e.message);
  }
}

// ---------- 详情页 ----------
const detailState = { siteKey: '', vodId: '', data: null, plays: [], flagIdx: 0 };

async function renderDetail(siteKey, vodId) {
  detailState.siteKey = siteKey;
  detailState.vodId = vodId;
  setTitle('详情', '');
  app.innerHTML = '<div class="loading">加载中…</div>';
  const data = await api(`/api/sites/${encodeURIComponent(siteKey)}/detail?id=${encodeURIComponent(vodId)}`);
  detailState.data = data;
  detailState.plays = data.plays || [];
  const firstWithEp = detailState.plays.findIndex((p) => p.episodes && p.episodes.length);
  detailState.flagIdx = firstWithEp >= 0 ? firstWithEp : 0;
  setTitle(data.vod_name || '', data.type_name || '');
  renderDetailContent();
}

function renderDetailContent() {
  const data = detailState.data || {};
  const plays = detailState.plays;
  const flagIdx = detailState.flagIdx;
  const flag = plays[flagIdx] || {};
  const eps = flag.episodes || [];
  const pic = data.vod_pic ? `/api/proxy/image?url=${encodeURIComponent(data.vod_pic)}` : '';

  const infoLines = [];
  if (data.vod_score) infoLines.push(`评分 ${esc(data.vod_score)}`);
  if (data.vod_year) infoLines.push(esc(data.vod_year));
  if (data.vod_area) infoLines.push(esc(data.vod_area));
  if (data.type_name) infoLines.push(esc(data.type_name));

  app.innerHTML = `
    <div class="detail-head">
      <div class="poster">${pic ? `<img src="${pic}" onerror="this.style.display='none'">` : ''}</div>
      <div class="detail-info">
        <div class="d-title">${esc(data.vod_name)}</div>
        <div class="d-line">${infoLines.join(' · ') || '&nbsp;'}</div>
        <div class="d-line">导演：${esc(data.vod_director || '-')}</div>
        <div class="d-line">主演：${esc(data.vod_actor || '-')}</div>
      </div>
    </div>
    <div class="detail-desc">${esc(data.vod_content || '暂无简介')}</div>
    ${plays.length > 1 ? `
      <div class="section-title">播放线路</div>
      <div class="tab-bar">
        ${plays.map((p, i) => `<button class="tab ${i === flagIdx ? 'active' : ''}" onclick="switchDetailFlag(${i})">${esc(p.flag || '线路' + (i + 1))}</button>`).join('')}
      </div>` : ''}
    <div class="section-title">选集（共 ${eps.length} 集）</div>
    <div class="ep-grid">
      ${eps.length ? eps.map((e, i) => `<button class="ep" onclick="playNow(${i})">${esc(e.name || '第' + (i + 1) + '集')}</button>`).join('') : '<div class="empty">暂无选集（该站点可能需要特殊解析，无法直接播放）</div>'}
    </div>
    <div style="height:20px"></div>`;
}

function switchDetailFlag(i) {
  detailState.flagIdx = i;
  renderDetailContent();
}
window.switchDetailFlag = switchDetailFlag;

function playNow(epIdx) {
  openPlayer({
    siteKey: detailState.siteKey,
    vodName: (detailState.data || {}).vod_name || '',
    poster: (detailState.data || {}).vod_pic || '',
    plays: detailState.plays,
    flagIdx: detailState.flagIdx,
    startEp: epIdx,
  });
}
window.playNow = playNow;

// ---------- WebDAV 网盘浏览 ----------
let webdavItems = [];
async function renderWebdav(subPath) {
  const path = subPath || '/';
  setTitle('WebDAV 网盘', path);
  app.innerHTML = '<div class="loading">加载中…</div>';
  let data;
  try {
    data = await api('/api/dav?path=' + encodeURIComponent(path));
  } catch (e) {
    app.innerHTML = `<div class="empty">加载失败：${esc(e.message)}<br><br><button class="btn primary" onclick="go('/')">返回首页</button></div>`;
    return;
  }
  const items = data.items || [];
  webdavItems = items;
  const up = path !== '/' ? `<div style="margin-bottom:8px"><button class="btn" onclick="go('/webdav')">↑ 根目录</button></div>` : '';
  const grid = items.length
    ? `<div class="card-grid">${items.map((it, idx) => webdavItemHtml(it, idx)).join('')}</div>`
    : '<div class="empty">该目录为空</div>';
  app.innerHTML = `
    <div class="page-title">WebDAV 网盘 · ${esc(path)}</div>
    ${up}${grid}`;
}
function webdavItemHtml(it, idx) {
  if (it.isDir) {
    return `<div class="card vod-card" onclick="go('/webdav/${encodeURIComponent(it.path.replace(/^\/+/, ''))}')">
      <div class="poster"><div class="remarks">文件夹</div></div>
      <div class="v-name">${esc(it.name)}</div></div>`;
  }
  const tag = it.playable ? '▶ 可播放' : '文件';
  return `<div class="card vod-card" onclick="playWebdavByIndex(${idx})">
    <div class="poster"><div class="remarks">${esc(tag)}</div></div>
    <div class="v-name">${esc(it.name)}</div></div>`;
}
function playWebdavByIndex(idx) {
  const it = webdavItems[idx];
  if (!it) return;
  if (!it.playable) return showToast('该文件类型暂不支持播放（仅 .mp4 / .strm 等）');
  showToast('获取播放地址…');
  (async () => {
    try {
      const data = await api('/api/dav/play?path=' + encodeURIComponent(it.path));
      if (!data.url) return showToast('未获取到播放地址');
      playWebdav(data.url, it.name);
    } catch (e) { showToast(e.message); }
  })();
}
window.playWebdavByIndex = playWebdavByIndex;

// ---------- 启动 ----------
render();
