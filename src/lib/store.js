// KV 持久化 + 管理员鉴权（替代原 Docker 的 data/ 磁盘卷与 fs 读写）
// - 源配置 / 管理员账号 存于 TMH_KV
// - 登录态采用无状态 HMAC 签名 token（内嵌过期时间与账号版本），避免 KV 一致性问题

const SOURCES_KEY = 'tmh:sources';
const ADMIN_KEY = 'tmh:admin';
const TOKEN_TTL = 12 * 3600 * 1000; // 12 小时

let KV = null;
let SECRET = null;
let ENV_USER = 'admin';
let ENV_PASS = 'admin123';
let ENV_WEBDAV_BASE = '';
let ENV_WEBDAV_USER = '';
let ENV_WEBDAV_PASS = '';

// 未配置 TMH_SECRET 时使用的内置默认值（已随机生成，写死在代码里）。
// 这样即使不在 CF 后台设 Secret，部署也能稳定签发/校验登录 token（不会每次冷启动换密钥导致登录态失效）。
// 若需自行更换，可在 CF 后台添加 Secret 类型的 TMH_SECRET 覆盖它。
const BUILTIN_SECRET = '70acc766ad71cc78b8a6530a91b934174872fb9e4c7b27d4055f1f2b6a72ceb1';

const DEFAULT_SOURCES = {
  sources: [
    { id: 'default-ffzy', name: '非凡影视', type: 'applecms', url: 'https://cj.ffzyapi.com/api.php/provide/vod/', remark: 'AppleCMS 采集接口' },
    { id: 'default-dyttzy', name: '电影天堂', type: 'applecms', url: 'http://caiji.dyttzyapi.com/api.php/provide/vod/', remark: 'dyttzy 采集接口' },
    { id: 'default-wujin', name: '五尽影视', type: 'applecms', url: 'https://api.wujinapi.me/api.php/provide/vod/', remark: '五尽采集接口' },
    { id: 'default-lziapi', name: '懒猪影视', type: 'applecms', url: 'https://cj.lziapi.com/api.php/provide/vod/', remark: '懒猪采集接口' },
  ],
};

function init(env) {
  KV = env.TMH_KV;
  ENV_USER = env.ADMIN_USER || 'admin';
  ENV_PASS = env.ADMIN_PASS || 'admin123';
  ENV_WEBDAV_BASE = env.WEBDAV_BASE || '';
  ENV_WEBDAV_USER = env.WEBDAV_USER || '';
  ENV_WEBDAV_PASS = env.WEBDAV_PASS || '';
  // 仅首次初始化时确定签名密钥：优先用后台 Secret TMH_SECRET，未配置则回退到代码内置默认值
  // （后续请求不要重复生成，否则每次都换密钥会让已签发 token 立刻失效）
  if (SECRET === null) SECRET = env.TMH_SECRET || BUILTIN_SECRET;
}

// ---------- 源配置 ----------
async function getConfig() {
  let cfg = await KV.get(SOURCES_KEY, { type: 'json' });
  if (!cfg || !Array.isArray(cfg.sources)) {
    cfg = JSON.parse(JSON.stringify(DEFAULT_SOURCES));
    await KV.put(SOURCES_KEY, JSON.stringify(cfg));
  }
  return cfg;
}

async function listSources() {
  return (await getConfig()).sources;
}

async function getSource(id) {
  return (await listSources()).find((s) => s.id === id) || null;
}

async function addSource(data) {
  const cfg = await getConfig();
  const source = {
    id: crypto.randomUUID(),
    name: String(data.name || '').trim(),
    type: String(data.type || 'applecms').trim(),
    url: String(data.url || '').trim(),
    remark: String(data.remark || '').trim(),
    createdAt: new Date().toISOString(),
  };
  if (!source.name) throw new Error('名称不能为空');
  if (!source.url) throw new Error('地址不能为空');
  cfg.sources.push(source);
  await KV.put(SOURCES_KEY, JSON.stringify(cfg));
  return source;
}

async function updateSource(id, data) {
  const cfg = await getConfig();
  const src = cfg.sources.find((s) => s.id === id);
  if (!src) return null;
  if (data.name != null) src.name = String(data.name).trim();
  if (data.type != null) src.type = String(data.type).trim();
  if (data.url != null) src.url = String(data.url).trim();
  if (data.remark != null) src.remark = String(data.remark).trim();
  await KV.put(SOURCES_KEY, JSON.stringify(cfg));
  return src;
}

async function removeSource(id) {
  const cfg = await getConfig();
  cfg.sources = cfg.sources.filter((s) => s.id !== id);
  await KV.put(SOURCES_KEY, JSON.stringify(cfg));
}

// ---------- WebDAV 配置（优先 KV，fallback wrangler 变量） ----------
const WEBDAV_KEY = 'tmh:webdav';

// 返回可直接 spread 进 env 的对象（含 WEBDAV_BASE/USER/PASS）
async function getWebdavConfig() {
  let wd = null;
  try { wd = await KV.get(WEBDAV_KEY, { type: 'json' }); } catch (_) { /* ignore */ }
  if (!wd || typeof wd !== 'object') wd = {};
  return {
    WEBDAV_BASE: String(wd.base != null ? wd.base : ENV_WEBDAV_BASE).trim().replace(/\/+$/, ''),
    WEBDAV_USER: String(wd.user != null ? wd.user : ENV_WEBDAV_USER).trim(),
    WEBDAV_PASS: String(wd.pass != null ? wd.pass : ENV_WEBDAV_PASS),
  };
}

// 给前端展示用：不返回明文密码，仅告知是否已设置
async function getWebdavConfigPublic() {
  const c = await getWebdavConfig();
  return { base: c.WEBDAV_BASE, user: c.WEBDAV_USER, hasPassword: !!c.WEBDAV_PASS };
}

// 保存 WebDAV 配置到 KV。密码传空字符串表示不修改（保留原值）。
async function setWebdavConfig(input) {
  const cur = await getWebdavConfig();
  let base = String((input && input.base) || '').trim().replace(/\/+$/, '');
  if (base && !/^https?:\/\//i.test(base)) throw new Error('WebDAV 地址必须以 http(s):// 开头');
  const user = String((input && input.user) || '').trim();
  let pass = cur.WEBDAV_PASS;
  if (input && input.pass !== undefined && input.pass !== null && String(input.pass) !== '') {
    pass = String(input.pass);
  }
  await KV.put(WEBDAV_KEY, JSON.stringify({ base, user, pass }));
  return getWebdavConfigPublic();
}

// ---------- 管理员账号 ----------
async function getAdmin() {
  let a = await KV.get(ADMIN_KEY, { type: 'json' });
  if (!a || !a.username || !a.password) {
    a = { username: ENV_USER, password: ENV_PASS, version: 1 };
    await KV.put(ADMIN_KEY, JSON.stringify(a));
  }
  return a;
}

async function getAdminVersion() {
  return (await getAdmin()).version || 1;
}

async function setAdmin(username, password) {
  const a = await getAdmin();
  a.username = username;
  a.password = password;
  a.version = (a.version || 1) + 1; // 版本号自增：令所有旧登录态失效
  await KV.put(ADMIN_KEY, JSON.stringify(a));
}

// ---------- 无状态签名 token ----------
const enc = new TextEncoder();

function b64url(s) {
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return atob(s);
}

async function hmac(msg) {
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function createToken(username) {
  const payload = JSON.stringify({
    u: username,
    exp: Date.now() + TOKEN_TTL,
    v: await getAdminVersion(),
  });
  const b = b64url(payload);
  const sig = await hmac(b);
  return `${b}.${sig}`;
}

async function verifyToken(token) {
  if (!token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const [b, sig] = parts;
  const expected = await hmac(b);
  if (sig !== expected) return false;
  try {
    const payload = JSON.parse(b64urlDecode(b));
    if (!payload.exp || Date.now() > payload.exp) return false;
    if (payload.v !== (await getAdminVersion())) return false;
    return true;
  } catch (e) {
    return false;
  }
}

export {
  init,
  listSources,
  getSource,
  addSource,
  updateSource,
  removeSource,
  getWebdavConfig,
  getWebdavConfigPublic,
  setWebdavConfig,
  getAdmin,
  getAdminVersion,
  setAdmin,
  createToken,
  verifyToken,
};
