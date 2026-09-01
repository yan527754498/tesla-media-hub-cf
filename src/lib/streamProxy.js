// 流媒体代理：为 AppleCMS 点播提供「同源代理」，绕过源站防盗链(Referer/Origin 校验)与跨域限制。
// 前端拿到的播放地址统一改写为 /api/stream?url=...，由本模块向源站拉流并：
//   1) 注入源站自身的 Referer / Origin，使大多数防盗链放行；
//   2) 透传 Range 头，支持 mp4 拖拽；
//   3) 若为 m3u8，递归将其内部的 ts / key / map 地址改写为同样走代理的绝对地址。

import { fetchStream } from './fetcher.js';

// SSRF 基本防护：拦截明显的内网/元数据地址（CF 运行时本身也会拒绝 RFC1918 私有地址）
const BLOCKED_KEYWORDS = ['localhost', 'internal', 'metadata', '169.254.169.254'];

function isBlockedHost(host) {
  const h = String(host || '').toLowerCase();
  return BLOCKED_KEYWORDS.some((k) => h.includes(k));
}

function safeUrl(raw) {
  let u;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (isBlockedHost(u.hostname)) return null;
  return u;
}

function toAbsolute(uri, baseUrl) {
  try {
    if (/^[a-z][a-z0-9+.-]*:/i.test(uri) && !uri.startsWith('//')) {
      const u = new URL(uri);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
    }
    if (uri.startsWith('//')) {
      return new URL('https:' + uri).toString();
    }
    return new URL(uri, baseUrl).toString();
  } catch {
    return null;
  }
}

// 将 m3u8 文本中的相对/绝对 URI 改写为经过本代理的绝对地址
function rewriteM3u8(text, baseUrl, proxyBase) {
  const lines = text.split(/\r?\n/);
  const out = [];
  for (let line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      out.push(line);
      continue;
    }
    // 标签行（含 EXT-X-KEY / EXT-X-MAP / EXT-X-I-FRAME-STREAM-INF 等带 URI 的）需改写其中的 URI
    if (trimmed.startsWith('#')) {
      line = line.replace(/(URI=)("?)([^"\s,]+)\2/gi, (m, p1, q, uri) => {
        const abs = toAbsolute(uri, baseUrl);
        return abs ? p1 + q + proxyBase + encodeURIComponent(abs) + q : m;
      });
      out.push(line);
      continue;
    }
    // 已是代理地址则原样保留
    if (trimmed.includes('/api/stream')) {
      out.push(line);
      continue;
    }
    const abs = toAbsolute(trimmed, baseUrl);
    if (!abs) {
      out.push(line);
      continue;
    }
    out.push(proxyBase + encodeURIComponent(abs));
  }
  return out.join('\n');
}

export async function handleStream(request, url) {
  const target = url.searchParams.get('url');
  if (!target) return new Response('bad url', { status: 400 });

  const tu = safeUrl(target);
  if (!tu) return new Response('blocked or invalid url', { status: 403 });

  // 注入源站自身的 Referer/Origin，绕过大多数防盗链校验
  const referer = tu.origin + '/';
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    Referer: referer,
    Origin: tu.origin,
    Accept: '*/*',
  };
  const range = request.headers.get('range');
  if (range) headers['Range'] = range;

  let up;
  try {
    up = await fetchStream(tu.toString(), { headers, redirect: 'follow' });
  } catch (e) {
    const dbg = 'upstream error: ' + (e && e.message ? e.message : String(e)) + ' | url=' + tu.toString();
    return new Response(dbg, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-TMH-Error': dbg },
    });
  }
  if (!up.ok && up.status !== 206) {
    const dbg =
      'upstream status ' + up.status +
      ' | url=' + (up.url || tu.toString()) +
      ' | ct=' + (up.headers.get('content-type') || '') +
      ' | cf=' + (up.headers.get('cf-ray') || '');
    return new Response(dbg, {
      status: 502,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-TMH-Error': dbg },
    });
  }

  const finalBase = up.url || tu.toString();
  const ct = up.headers.get('content-type') || '';
  const isM3u8 =
    /mpegurl|application\/x-m3u8|vnd\.apple\.mpegurl/i.test(ct) ||
    /\.m3u8(\?|#|$)/i.test(new URL(finalBase).pathname);

  if (isM3u8) {
    const text = await up.text().catch(() => '');
    const proxyBase = url.origin + '/api/stream?url=';
    const rewritten = rewriteM3u8(text, finalBase, proxyBase);
    return new Response(rewritten, {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // 其他媒体（mp4 / ts / key 等）直接流式转发，透传关键响应头以支持拖拽
  const passHeaders = new Headers();
  for (const k of [
    'content-type',
    'content-length',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'cache-control',
  ]) {
    const v = up.headers.get(k);
    if (v) passHeaders.set(k, v);
  }
  passHeaders.set('Access-Control-Allow-Origin', '*');
  if (!passHeaders.get('cache-control')) passHeaders.set('Cache-Control', 'public, max-age=3600');

  return new Response(up.body, {
    status: up.status,
    headers: passHeaders,
  });
}
