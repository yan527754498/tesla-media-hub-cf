/**
 * 管理后台：登录 + 数据源增删改
 */

const TOKEN_KEY = 'media_hub_admin_token';
const app = document.getElementById('app');

function getToken() { return localStorage.getItem(TOKEN_KEY) || ''; }
function setToken(t) { localStorage.setItem(TOKEN_KEY, t); }
function clearToken() { localStorage.removeItem(TOKEN_KEY); }

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}
window.showToast = showToast;

function showModal(html) {
  const el = document.getElementById('modal');
  el.innerHTML = html;
  el.classList.remove('hidden');
}
function closeModal() {
  document.getElementById('modal').classList.add('hidden');
}
window.closeModal = closeModal;

// ---------- 登录 ----------
async function doLogin() {
  const username = document.getElementById('login-user').value.trim();
  const password = document.getElementById('login-pass').value;
  if (!username || !password) return showToast('请输入账号和密码');
  try {
    const res = await api('/api/admin/login', { method: 'POST', body: { username, password } });
    setToken(res.token);
    showToast('登录成功');
    enterAdmin();
  } catch (e) {
    showToast(e.message);
  }
}
window.doLogin = doLogin;

function backToLogin() {
  clearToken();
  document.getElementById('admin-view').classList.add('hidden');
  document.getElementById('login-view').classList.remove('hidden');
}

function enterAdmin() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('admin-view').classList.remove('hidden');
  loadSources();
  loadWebdavStatus();
}

// ---------- WebDAV 配置 ----------
async function loadWebdavStatus() {
  const el = document.getElementById('webdav-status');
  if (!el) return;
  try {
    const data = await api('/api/admin/webdav', { token: getToken() });
    const c = data.config || {};
    el.textContent = c.base
      ? `已配置：${c.base}（账号：${c.user || '无'}）`
      : '尚未配置 WebDAV（在首页「WebDAV 网盘」入口使用）';
  } catch (e) {
    el.textContent = '读取配置失败';
  }
}
window.loadWebdavStatus = loadWebdavStatus;

function openWebdavForm() {
  let cfg = { base: '', user: '', hasPassword: false };
  // 尽量预填（接口失败也不阻塞，用空值）
  try {
    api('/api/admin/webdav', { token: getToken() })
      .then((d) => { if (d.config) cfg = d.config; })
      .catch(() => {});
  } catch (_) { /* ignore */ }
  showModal(`
    <div class="modal-body">
      <h3>配置 WebDAV 网盘</h3>
      <input id="wd-base" placeholder="WebDAV 地址（如 https://dav.example.com:5006/dav）" value="${esc(cfg.base)}">
      <input id="wd-user" placeholder="账号（无认证可留空）" value="${esc(cfg.user)}">
      <input id="wd-pass" type="password" placeholder="${cfg.hasPassword ? '已设置，留空则不修改' : '密码（无认证可留空）'}">
      <div class="tip">保存后，首页「WebDAV 网盘」入口即可浏览并播放 .mp4 / .strm 文件。配置存于服务端 KV，无需改动部署变量。</div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">取消</button>
        <button class="btn primary" onclick="saveWebdav()">保存</button>
      </div>
    </div>`);
}
window.openWebdavForm = openWebdavForm;

async function saveWebdav() {
  const base = (document.getElementById('wd-base') || {}).value || '';
  const user = (document.getElementById('wd-user') || {}).value || '';
  const pass = (document.getElementById('wd-pass') || {}).value || '';
  try {
    await api('/api/admin/webdav', { method: 'POST', body: { base, user, pass }, token: getToken() });
    closeModal();
    showToast('WebDAV 配置已保存');
    loadWebdavStatus();
  } catch (e) {
    handleAuthError(e);
  }
}
window.saveWebdav = saveWebdav;

function handleAuthError(e) {
  if (/未登录|过期/.test(e.message)) {
    backToLogin();
    showToast('登录已过期，请重新登录');
    return true;
  }
  showToast(e.message);
  return false;
}

// ---------- 源列表 ----------
let currentSources = [];

async function loadSources() {
  const grid = document.getElementById('source-list');
  if (grid) grid.innerHTML = '<div class="loading">加载中…</div>';
  try {
    const data = await api('/api/sources');
    currentSources = data.list || [];
    renderSources(currentSources);
  } catch (e) {
    if (grid) grid.innerHTML = '';
    handleAuthError(e);
  }
}

function renderSources(list) {
  const grid = document.getElementById('source-list');
  grid.innerHTML = list.length
    ? list.map((s) => `
        <div class="card source-card">
          <div class="card-title">${esc(s.name)}</div>
          <div class="card-meta">${esc(s.type)} · ${esc(s.url)}</div>
          <div class="card-actions">
            <button onclick="editSource('${s.id}')">编辑</button>
            <button class="del" onclick="removeSource('${s.id}')">删除</button>
          </div>
        </div>`).join('')
    : '<div class="empty">暂无数据源，点击下方按钮添加</div>';
}

// ---------- 添加 / 编辑 ----------
function showAddSource() {
  openSourceForm(null);
}
window.showAddSource = showAddSource;

function editSource(id) {
  const src = currentSources.find((s) => s.id === id);
  if (!src) return;
  openSourceForm(src);
}
window.editSource = editSource;

function openSourceForm(src) {
  const isEdit = !!src;
  // 支持 AppleCMS 与 IPTV 两种源；编辑旧源时保留其原 type（向后兼容）
  const currentType = src ? (src.type || 'applecms') : 'applecms';
  showModal(`
    <div class="modal-body">
      <h3>${isEdit ? '编辑数据源' : '添加数据源'}</h3>
      <input id="src-name" placeholder="源名称（如：我的影视源 / 我的IPTV）" value="${src ? esc(src.name) : ''}">
      <select id="src-type" onchange="onSrcTypeChange()" style="width:100%;min-height:42px;padding:0 12px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:#16181d;color:#f2f2f2;font-size:15px;">
        <option value="applecms" ${currentType === 'applecms' ? 'selected' : ''}>AppleCMS 影视源（点播）</option>
        <option value="iptv" ${currentType === 'iptv' ? 'selected' : ''}>IPTV 直播源（M3U）</option>
      </select>
      <input id="src-url" placeholder="AppleCMS 接口地址（形如 https://域名/api.php/provide/vod/）" value="${src ? esc(src.url) : ''}">
      <textarea id="src-remark" placeholder="备注（可选）">${src ? esc(src.remark || '') : ''}</textarea>
      <div class="tip" id="src-tip">AppleCMS 源：填写采集接口地址，形如 <code>https://域名/api.php/provide/vod/</code>。</div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">取消</button>
        <button class="btn primary" onclick="saveSource('${isEdit ? src.id : ''}')">保存</button>
      </div>
    </div>`);
  // 依据当前类型初始化提示
  setTimeout(onSrcTypeChange, 0);
}

function onSrcTypeChange() {
  const type = (document.getElementById('src-type') || {}).value;
  const urlInput = document.getElementById('src-url');
  const tip = document.getElementById('src-tip');
  if (type === 'iptv') {
    if (urlInput) urlInput.placeholder = 'M3U 播放列表地址（http(s) URL，或容器内可访问的本地路径）';
    if (tip) tip.innerHTML = 'IPTV 源：填写 M3U 播放列表地址。服务端会解析频道，并用 ffmpeg 转码 / 代理成车机可直接播放的流。<br>频道选项写在 M3U 的 <code>#EXTVLCOPT</code> 行：<code>tesla-direct=1</code> 直连、<code>tesla-low=720&aac</code> 转码。';
  } else {
    if (urlInput) urlInput.placeholder = 'AppleCMS 接口地址（形如 https://域名/api.php/provide/vod/）';
    if (tip) tip.innerHTML = 'AppleCMS 源：填写采集接口地址，形如 <code>https://域名/api.php/provide/vod/</code>。';
  }
}
window.onSrcTypeChange = onSrcTypeChange;

async function saveSource(id) {
  const name = document.getElementById('src-name').value.trim();
  const type = document.getElementById('src-type').value;
  const url = document.getElementById('src-url').value.trim();
  const remark = document.getElementById('src-remark').value.trim();
  if (!name || !url) return showToast('名称和地址不能为空');
  const body = { name, type, url, remark };
  try {
    if (id) await api(`/api/sources/${id}`, { method: 'PUT', body, token: getToken() });
    else await api('/api/sources', { method: 'POST', body, token: getToken() });
    closeModal();
    showToast('已保存');
    loadSources();
  } catch (e) {
    handleAuthError(e);
  }
}
window.saveSource = saveSource;

async function removeSource(id) {
  if (!window.confirm('确定删除该数据源？')) return;
  try {
    await api(`/api/sources/${id}`, { method: 'DELETE', token: getToken() });
    showToast('已删除');
    loadSources();
  } catch (e) {
    handleAuthError(e);
  }
}
window.removeSource = removeSource;

// ---------- 账号设置 ----------
function showAccountForm() {
  showModal(`
    <div class="modal-body">
      <h3>修改账号 / 密码</h3>
      <input id="acc-user" placeholder="管理员账号" autocomplete="off">
      <input id="acc-pass" type="password" placeholder="新密码（至少 4 位）">
      <input id="acc-pass2" type="password" placeholder="确认新密码">
      <div class="tip">保存后需重新登录。账号密码保存在服务器的 data 目录中，优先于环境变量。</div>
      <div class="modal-actions">
        <button class="btn" onclick="closeModal()">取消</button>
        <button class="btn primary" onclick="saveAccount()">保存</button>
      </div>
    </div>`);
}
window.showAccountForm = showAccountForm;

async function saveAccount() {
  const username = document.getElementById('acc-user').value.trim();
  const password = document.getElementById('acc-pass').value;
  const password2 = document.getElementById('acc-pass2').value;
  if (!username) return showToast('账号不能为空');
  if (password.length < 4) return showToast('密码至少 4 位');
  if (password !== password2) return showToast('两次输入的密码不一致');
  try {
    await api('/api/admin/change-password', { method: 'POST', body: { username, password }, token: getToken() });
    closeModal();
    showToast('账号已更新，请重新登录');
    backToLogin();
  } catch (e) {
    handleAuthError(e);
  }
}
window.saveAccount = saveAccount;

// ---------- 退出 ----------
async function logout() {
  try {
    await api('/api/admin/logout', { method: 'POST', token: getToken() });
  } catch (e) { /* ignore */ }
  clearToken();
  backToLogin();
}
window.logout = logout;

// 启动
if (getToken()) enterAdmin();
else backToLogin();
