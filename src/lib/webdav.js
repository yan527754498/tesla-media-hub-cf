// WebDAV 列目录与 .strm 解析
// 列目录用 PROPFIND；播放 .strm 时读取其文本并解析第一行 http(s) 真实地址。
// 关键安全点：WebDAV 凭据（WEBDAV_USER/PASS）仅存在于 Worker 端变量，绝不返回给前端。

function getCfg(env) {
  const base = (env && env.WEBDAV_BASE ? String(env.WEBDAV_BASE) : '').trim().replace(/\/+$/, '');
  return {
    base: base || null,
    user: (env && env.WEBDAV_USER ? String(env.WEBDAV_USER) : '').trim(),
    pass: (env && env.WEBDAV_PASS ? String(env.WEBDAV_PASS) : '').trim(),
  };
}

// Basic Auth 头；btoa 不支持非 Latin1 字符时退回 UTF-8 编码
function authHeaders(cfg) {
  if (!cfg.user) return {};
  let token;
  try {
    token = 'Basic ' + btoa(cfg.user + ':' + cfg.pass);
  } catch (_) {
    token = 'Basic ' + btoa(unescape(encodeURIComponent(cfg.user + ':' + cfg.pass)));
  }
  return { Authorization: token };
}

const PLAYABLE_EXT = ['.mp4', '.strm', '.mkv', '.m3u8', '.ts', '.webm', '.mov', '.m4v'];

export function isPlayable(name) {
  const lower = String(name || '').toLowerCase();
  return PLAYABLE_EXT.some((ext) => lower.endsWith(ext));
}

// 相对 path 拼成完整 WebDAV URL
function joinUrl(cfg, path) {
  const p = path && path !== '/' ? '/' + String(path).replace(/^\/+/, '') : '';
  return cfg.base + p;
}

// 从完整 URL 反推相对 path（去掉 base 的 pathname 前缀）
function toRelPath(fullUrl, basePathname) {
  let u;
  try { u = new URL(fullUrl); } catch { return null; }
  let p = decodeURIComponent(u.pathname);
  if (basePathname && p.startsWith(basePathname)) p = p.slice(basePathname.length);
  if (!p) p = '/';
  return p;
}

function parsePropfind(xml, cfg) {
  let basePathname = '';
  let origin = cfg.base;
  try {
    const b = new URL(cfg.base);
    basePathname = b.pathname.replace(/\/+$/, '');
    origin = b.origin;
  } catch { /* ignore */ }
  const blocks = xml.split(/<(\w*:)?response>/i).slice(1);
  const items = [];
  for (const raw of blocks) {
    const block = raw.split(/<\/(\w*:)?response>/i)[0];
    if (!block) continue;
    const hrefMatch = block.match(/<(\w*:)?href>([\s\S]*?)<\/(\w*:)?href>/i);
    if (!hrefMatch) continue;
    const href = decodeURIComponent(hrefMatch[2].trim());
    const isDir = /<(\w*:)?collection\s*\/?>/i.test(block);
    // WebDAV 返回的 href 多为「服务器绝对路径」（如 /dav/movies/），需基于 origin 拼接，避免与 base 路径重复
    const fullUrl = href.startsWith('http') ? href : origin + (href.startsWith('/') ? href : '/' + href);
    const rel = toRelPath(fullUrl, basePathname);
    if (rel === null || rel === '/') continue; // 跳过根目录自身
    const name = rel.split('/').filter(Boolean).pop() || rel;
    const lenMatch = block.match(/<(\w*:)?getcontentlength>([\s\S]*?)<\/(\w*:)?getcontentlength>/i);
    const size = lenMatch ? parseInt(lenMatch[2].trim(), 10) || 0 : 0;
    items.push({ name, path: rel, isDir, size, playable: !isDir && isPlayable(name) });
  }
  items.sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, 'zh')));
  return items;
}

export async function listDir(env, path) {
  const cfg = getCfg(env);
  if (!cfg.base) throw new Error('WebDAV 未配置：请在 Worker 变量设置 WEBDAV_BASE');
  const target = joinUrl(cfg, path || '/');
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<D:propfind xmlns:D="DAV:"><D:prop>' +
    '<D:resourcetype/><D:getcontentlength/><D:getcontenttype/><D:displayname/>' +
    '</D:prop></D:propfind>';
  const res = await fetch(target, {
    method: 'PROPFIND',
    headers: { ...authHeaders(cfg), Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
    body,
  });
  if (res.status === 401) throw new Error('WebDAV 认证失败（WEBDAV_USER / WEBDAV_PASS 不正确）');
  if (!res.ok) throw new Error('WebDAV 列目录失败：HTTP ' + res.status);
  return parsePropfind(await res.text(), cfg);
}

// 解析出来的 URL 也必须过 SSRF 校验，避免 .strm 指向内网/元数据地址
function safeHttpUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const h = u.hostname.toLowerCase();
  if (['localhost', 'internal', 'metadata', '169.254.169.254'].some((k) => h.includes(k))) return null;
  return u.toString();
}

function parseStrm(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue; // 跳过空行与注释
    if (/^https?:\/\//i.test(t)) {
      const safe = safeHttpUrl(t);
      if (safe) return safe;
    }
  }
  return null;
}

// 返回真实可播放地址（不代理）。前端统一包成 /api/stream?url= 走同源代理 + 回退直连。
export async function getPlayUrl(env, path) {
  const cfg = getCfg(env);
  if (!cfg.base) throw new Error('WebDAV 未配置：请在 Worker 变量设置 WEBDAV_BASE');
  const lower = String(path || '').toLowerCase();
  if (lower.endsWith('.strm')) {
    const target = joinUrl(cfg, path);
    const res = await fetch(target, { method: 'GET', headers: authHeaders(cfg) });
    if (res.status === 401) throw new Error('WebDAV 认证失败（WEBDAV_USER / WEBDAV_PASS 不正确）');
    if (!res.ok) throw new Error('读取 .strm 失败：HTTP ' + res.status);
    const real = parseStrm(await res.text());
    if (!real) throw new Error('.strm 中未找到有效的 http(s) 链接');
    return real;
  }
  // .mp4 / 其他媒体：返回 WebDAV 真实地址（代理时 Worker 自动注入 Basic Auth）
  return joinUrl(cfg, path);
}
