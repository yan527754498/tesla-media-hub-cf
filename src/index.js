import * as store from './lib/store.js';
import { getSites, resolveSite, splitKey, createAdapter } from './lib/sites.js';
import { resolvePlayUrl } from './lib/resolvePlay.js';
import { fetchStream } from './lib/fetcher.js';
import { handleStream } from './lib/streamProxy.js';

export default {
  async fetch(request, env) {
    store.init(env);

    const url = new URL(request.url);
    const p = url.pathname;

    // 静态资源：非 /api 请求交给 Cloudflare 静态资产处理
    if (!p.startsWith('/api/')) {
      // /admin 便捷别名 -> admin.html
      if (p === '/admin' || p === '/admin/') {
        return env.ASSETS.fetch(new Request(new URL('/admin.html', url), request));
      }
      return env.ASSETS.fetch(request);
    }

    try {
      return await routeApi(request, url);
    } catch (e) {
      return json({ code: 0, msg: e && e.message ? e.message : '未知错误' }, 500);
    }
  },
};

// ---------------- 路由 ----------------
async function routeApi(request, url) {
  const method = request.method;
  const p = url.pathname;
  const segs = p.split('/').filter(Boolean); // ["api","sources",":id",...]

  // /api/health
  if (method === 'GET' && p === '/api/health') {
    return json({ code: 1, msg: 'ok' });
  }

  // /api/admin/login
  if (method === 'POST' && p === '/api/admin/login') {
    const { username, password } = await request.json().catch(() => ({}));
    const admin = await store.getAdmin();
    if (username === admin.username && password === admin.password) {
      return json({ code: 1, token: await store.createToken(admin.username) });
    }
    return json({ code: 0, msg: '账号或密码错误' }, 401);
  }

  // /api/admin/logout（无状态 token 无法单独吊销，直接返回成功）
  if (method === 'POST' && p === '/api/admin/logout') {
    if (!(await authed(request))) return unauthorized();
    return json({ code: 1 });
  }

  // /api/admin/change-password
  if (method === 'POST' && p === '/api/admin/change-password') {
    if (!(await authed(request))) return unauthorized();
    const { username, password } = await request.json().catch(() => ({}));
    if (!username || !String(username).trim()) return json({ code: 0, msg: '账号不能为空' }, 400);
    if (!password || String(password).length < 4) return json({ code: 0, msg: '密码至少 4 位' }, 400);
    await store.setAdmin(String(username).trim(), String(password));
    return json({ code: 1, msg: '已更新，请重新登录' });
  }

  // /api/sources
  if (p === '/api/sources') {
    if (method === 'GET') {
      return json({ code: 1, list: await store.listSources() });
    }
    if (method === 'POST') {
      if (!(await authed(request))) return unauthorized();
      const body = await request.json().catch(() => ({}));
      body.type = String(body.type || 'applecms');
      return json({ code: 1, item: await store.addSource(body) });
    }
  }

  // /api/sources/:id
  if (segs[1] === 'sources' && segs[2]) {
    const id = segs[2];
    if (method === 'PUT' || method === 'PATCH') {
      if (!(await authed(request))) return unauthorized();
      const body = await request.json().catch(() => ({}));
      if (body.type) body.type = String(body.type);
      const item = await store.updateSource(id, body);
      if (!item) return json({ code: 0, msg: '源不存在' }, 404);
      return json({ code: 1, item });
    }
    if (method === 'DELETE') {
      if (!(await authed(request))) return unauthorized();
      await store.removeSource(id);
      return json({ code: 1 });
    }
    // /api/sources/:id/sites
    if (method === 'GET' && segs[3] === 'sites') {
      const source = await store.getSource(id);
      if (!source) return json({ code: 0, msg: '源不存在' }, 404);
      const sites = await getSites(source, { force: url.searchParams.get('force') === '1' });
      return json({
        code: 1,
        source,
        list: sites.map((s) => ({ key: s.key, name: s.name, sourceType: s.sourceType, api: s.api })),
      });
    }
  }

  // /api/sites/:siteKey/<home|category|search|detail|play>
  if (segs[1] === 'sites' && segs[2] && segs[3]) {
    const siteKey = decodeURIComponent(segs[2]);
    const action = segs[3];
    const [sourceId, siteKeyInSource] = splitKey(siteKey);
    const site = await resolveSite(sourceId, siteKeyInSource);
    const adapter = createAdapter(site);
    if (action === 'home') {
      return json({ code: 1, ...(await adapter.getHome()) });
    }
    if (action === 'category') {
      return json({
        code: 1,
        ...(await adapter.getCategory({
          cat: url.searchParams.get('cat'),
          page: url.searchParams.get('page'),
          filter: undefined,
        })),
      });
    }
    if (action === 'search') {
      return json({
        code: 1,
        ...(await adapter.search({ wd: url.searchParams.get('wd') || '', page: url.searchParams.get('page') })),
      });
    }
    if (action === 'detail') {
      return json({ code: 1, ...(await adapter.getDetail({ id: url.searchParams.get('id') })) });
    }
    if (action === 'play') {
      const url2 = await resolvePlayUrl(url.searchParams.get('id'));
      return json({ code: 1, url: url2 });
    }
  }

  // /api/proxy/image
  if (p === '/api/proxy/image' && method === 'GET') {
    return await proxyImage(url);
  }

  // /api/stream?url=...  流媒体代理（绕过源站防盗链/跨域，详见 lib/streamProxy.js）
  if (p === '/api/stream' && method === 'GET') {
    return await handleStream(request, url);
  }

  return json({ code: 0, msg: 'Not Found' }, 404);
}

// ---------------- 鉴权辅助 ----------------
async function authed(request) {
  const header = request.headers.get('authorization') || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  return store.verifyToken(token);
}
function unauthorized() {
  return json({ code: 0, msg: '未登录或登录已过期' }, 401);
}

// ---------------- 图片代理（精简 SSRF） ----------------
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const ALLOWED_CT = /^(image\/[a-z0-9.+\-]+)$/i;
const BLOCKED_KEYWORDS = ['localhost', 'internal', 'metadata', '169.254.169.254'];

async function proxyImage(url) {
  const target = url.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) return json({ code: 0, msg: 'bad url' }, 400);

  let u;
  try { u = new URL(target); } catch { return json({ code: 0, msg: 'bad url' }, 400); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return json({ code: 0, msg: 'bad protocol' }, 400);
  if (BLOCKED_KEYWORDS.some((k) => u.hostname.toLowerCase().includes(k))) {
    return json({ code: 0, msg: '图片代理禁止访问该地址（SSRF 防护）' }, 403);
  }
  // 注：Cloudflare 运行时会直接拦截对私有/回环/链路本地地址的 fetch，无需自行做 DNS 解析

  // 不跟随重定向（避免 30x 跳转到内网绕过）
  const up = await fetchStream(target, { redirect: 'manual' });
  if (up.status !== 200) {
    return json({ code: 0, msg: 'image proxy error' }, up.status === 301 || up.status === 302 || up.status === 307 || up.status === 308 ? 400 : 502);
  }
  const ct = up.headers.get('content-type') || '';
  if (!ALLOWED_CT.test(ct)) return json({ code: 0, msg: '不支持的内容类型' }, 415);

  const buf = await up.arrayBuffer().catch(() => null);
  if (!buf) return json({ code: 0, msg: 'image proxy error' }, 502);
  if (buf.byteLength > MAX_IMAGE_BYTES) return json({ code: 0, msg: '图片过大' }, 413);

  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': ct || 'image/jpeg',
      'Cache-Control': 'public, max-age=86400',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

// ---------------- 工具 ----------------
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}
