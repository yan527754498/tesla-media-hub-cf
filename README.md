# tesla-media-hub (Cloudflare 版)

把原 `tesla-media-hub`（AppleCMS 影视聚合、适配特斯拉车机的 WebCodecs 播放器）改造为**可直接部署到 Cloudflare** 的版本：

- 前端静态资源（`public/` HTML/CSS/JS/wasm）由 **Cloudflare 静态资产（Assets）** 托管；
- 后端 **AppleCMS 点播 API** 跑在单个 **Cloudflare Worker** 里；
- 源配置 / 管理员账号用 **KV** 持久化（替代原 Docker 的 `data/` 磁盘卷）；
- **已移除 IPTV / ffmpeg**（Cloudflare 无法运行原生二进制、无法 spawn 子进程），车机点播 AppleCMS 直链的能力完整保留。

> 本仓库同时提供 `docker-compose.yml`：若需要 **完整原版（含 IPTV 直播 ffmpeg 转码/代理）**，可直接 `docker compose up -d` 拉起官方镜像，见下文「方式三：Docker Compose 一键部署」。两种部署相互独立、按需选择。

## 与原版的区别

| 项         | 原版（Docker）                            | 本版（Cloudflare）                        |
| --------- | ------------------------------------- | ------------------------------------- |
| 运行环境      | `node server/index.js` + Express 常驻进程 | 单个 Worker（`export default { fetch }`） |
| 持久化       | `fs` 写 `data/*.json`                  | KV（`TMH_KV`）                          |
| IPTV 直播   | ffmpeg 转码 / 代理                        | ❌ 已移除                                 |
| 登录态       | 内存 Map 存 token                        | 无状态 HMAC 签名 token（内嵌过期+账号版本，改密即失效）    |
| 图片代理 SSRF | `dns`/`net` 解析拦截内网                    | 协议/关键字校验 + 不跟随重定向（内网地址由 CF 网络层直接拦截）   |

> 前端 `app.js` 已去掉 IPTV 入口，点击 IPTV 源会提示「功能已禁用」。

## 部署步骤

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 KV 命名空间

```bash
npx wrangler kv namespace create tesla-media-hub
# 输出类似：
#   { binding = "TMH_KV", id = "a1b2c3d4...", ... }
```

把 `id` 填到 `wrangler.toml` 里的 `[[kv_namespaces]]` 的 `id = "..."` 处。

### 3.（强烈建议）设置登录态签名密钥

不设置也能跑，但未设 `TMH_SECRET` 时每个 Worker 冷启动会随机生成密钥，重启后旧登录态失效。建议设为 Secrets（不进仓库）：

```bash
npx wrangler secret put TMH_SECRET
# 输入一段随机长字符串，例如：openssl rand -hex 32
```

### 4. 部署

```bash
npx wrangler deploy
```

部署完成后访问 `https://<你的子域>.workers.dev`，管理后台在 `/admin`。

### 5. 首次登录

默认管理员账号 `admin` / `admin123`（来自 `wrangler.toml` 的 `ADMIN_USER`/`ADMIN_PASS`，也可在管理后台网页修改，修改后写入 KV 覆盖）。**请务必在管理后台修改默认密码。**

## 方式二：通过 GitHub 一键 Git 部署（推荐，持续交付）

把仓库推到 GitHub 后，在 Cloudflare 后台「连接 Git」，之后每次 `git push` 到 `main` 自动部署，PR 自动出预览环境。

> ⚠️ 前置条件：**KV 命名空间必须先存在**，且 `wrangler.toml` 里的 `id` 已填真实值。Cloudflare 的 Git 集成**不会**自动创建 KV，绑定 id 不存在会导致部署失败。

### A. 推送到 GitHub

```bash
cd tesla-media-hub-cf
git remote add origin git@github.com:<你的用户名>/tesla-media-hub-cf.git
git branch -M main
git push -u origin main
```

### B. 在 Cloudflare 后台连接仓库

1. 登录 Cloudflare 控制台 → **Workers & Pages** → **Create** → **Connect to Git**。
2. 授权 GitHub，选择仓库 `tesla-media-hub-cf`、生产分支 `main`。
3. Cloudflare 会读取 `wrangler.toml` 自动识别：
   - `main = src/index.js` → Worker 入口；
   - `[assets]` → 静态资源托管 `public/`；
   - `[[kv_namespaces]] binding = "TMH_KV"` → KV 绑定（id 已在 toml 中）。
4. 点击 **Deploy** 完成首次构建。

### C. 配置变量与 Secret（关键）

Git 集成部署时，以下配置从 `wrangler.toml` 与后台「变量和机密」读取，**无法从 Git 读取 Secret**，需手动设置：

| 类型 | 名称 | 说明 | 设置位置 |
| ---- | ---- | ---- | ---- |
| **KV 绑定** | `TMH_KV` | 源配置/管理员账号存储（id 已在 `wrangler.toml` 填好；若后台未自动识别，需在 Worker → Settings → Variables and Secrets → Add → KV 选命名空间） | 后台 |
| **明文变量** | `ADMIN_USER` / `ADMIN_PASS` | 默认管理员账号（已写在 `wrangler.toml` 的 `[vars]`，会随 Git 部署自动应用） | 无需额外操作（在 toml 内） |
| **Secret（机密）** | `TMH_SECRET` | 登录态 HMAC 签名密钥。**必须手动设**，否则每次冷启动随机密钥、登录态易失效 | Worker → Settings → Variables and Secrets → **Add** → 选 **Secret** |

设置 `TMH_SECRET`（两个环境都要加：Production 和 Preview，否则 PR 预览环境会登录异常）：

1. Worker 详情 → **Settings** → **Variables and Secrets** → **Add**。
2. 类型选 **Secret**，名称 `TMH_SECRET`，值填一段随机串（如本地执行 `openssl rand -hex 32` 的结果）。
3. 对 **Production** 和 **Preview** 环境分别添加一次。

> 账号 ID（`account_id`）：Git 集成部署时由后台所选账号决定，可不填；仅本地 `wrangler dev/deploy` 时需要，到 Cloudflare 后台右上角「账户 ID」获取后填入 `wrangler.toml`。

### D. 之后如何更新

```bash
git commit -am "..." && git push   # 自动触发 Cloudflare 生产部署
# 开 PR → 自动出 Preview 预览环境
```

## 方式三：Docker Compose 一键部署（完整原版，含 IPTV 直播）

如果你想要 **完整原版功能**（含 IPTV 直播 ffmpeg 转码/代理、HTTPS_PROXY 代理拉源等），而不仅是 Cloudflare 版的纯点播，可直接用仓库里的 `docker-compose.yml` 一键拉起官方镜像——**无需本地构建源码**：

```bash
# 在项目根目录执行（需已安装 Docker 与 Docker Compose v2）
docker compose up -d
```

- 镜像：`docker.io/yan527754498/tesla-media-hub:latest`（由作者预构建并推送到 Docker Hub）
- 访问地址：`http://<服务器IP>:6969`
- 数据持久化：`./data` 目录挂载到容器内 `/app/data`，源配置与管理员账号不会随容器重建丢失
- 默认管理员：`admin / admin123`（首次部署建议改强密码；亦可在管理后台修改）

### 常用环境变量（改 `docker-compose.yml` 的 `environment` 段）

| 变量 | 默认值 | 说明 |
| ---- | ---- | ---- |
| `PORT` | `6969` | 容器内监听端口（宿主机映射见 `ports`） |
| `ADMIN_USER` / `ADMIN_PASS` | `admin` / `admin123` | 管理员账号 |
| `IPTV_AUTH` | `true` | IPTV 播放是否要求管理员 token 鉴权（`false` 仅限可信内网，不建议公网） |
| `IPTV_MAX_CONCURRENT` | `4` | 同时转码/代理的 IPTV 流上限，超出返回 429（防止 ffmpeg 被无限拉起） |
| `HTTPS_PROXY` / `HTTP_PROXY` | 未设置 | NAS/家庭宽带无法直连影视源时，填代理地址（仅用于服务端拉取源站元数据/图片） |

### 常用命令

```bash
docker compose ps                          # 查看运行状态
docker compose logs -f                     # 跟踪日志
docker compose down                        # 停止并移除容器（数据仍在 ./data）
docker compose pull && docker compose up -d # 升级到最新镜像
```

> 注意：Docker 版与 Cloudflare 版是 **两套独立部署**：
> - **Docker 版** = 完整原版（Express + ffmpeg + IPTV，镜像来自 Docker Hub `yan527754498/tesla-media-hub`）；
> - **Cloudflare 版** = 纯点播 Worker（无 IPTV，源码在本仓库 `src/`）。
> 两者账号体系、持久化（Docker 用 `./data` 磁盘 / CF 用 KV）互不通用，按需选择其一即可。

## 本地开发

```bash
npx wrangler dev
```

`wrangler dev` 会用本地预览 KV，无需真实 KV id 即可联调（部分功能会读取/写入本地模拟 KV）。

## 使用说明

- 首页选择数据源 → 浏览分类 / 搜索 → 打开详情 → 点选集即播放（车机本地 WebCodecs 解码到 Canvas，无 `<video>` 标签）。
- 管理后台 `/admin`：添加 AppleCMS 源（采集接口形如 `https://域名/api.php/provide/vod/`）、编辑/删除、修改管理员密码。
- 默认已内置几个 AppleCMS 源；首次运行写入 KV 后可随时增删。

## WebDAV 网盘（播放 .mp4 / .strm）

首页新增「WebDAV 网盘」入口，可直接浏览并播放你自己的网盘（家庭 NAS / 支持 WebDAV 的云盘）里的视频：

- **列目录**：Worker 用 `PROPFIND` 读取目录（凭据只存于 Worker 端变量，**不暴露给前端**）。
- **播放 .mp4 等**：点文件 → 走现有同源代理 `/api/stream`，Worker 自动注入 `Basic Auth`，绕过 CORS / 防盗链。
- **播放 .strm 指针文件**：点 `.strm` → Worker 读取其文本、解析第一行 `http(s)` 真实地址 → 同样走 `/api/stream`；若第三方源封 Cloudflare 出口 IP 导致代理失败，会自动**回退浏览器直连**（你的家宽 IP 通常放行）—— 完美兼容 ffzy 这类源。

### 配置（推荐在 `/admin` 后台可视化配置）

WebDAV 配置存于 KV（键 `tmh:webdav`），**无需改动部署变量、无需重新部署**：

1. 打开 `/admin` 并用管理员账号登录；
2. 在页面下方「WebDAV 网盘」卡片点击「配置 WebDAV」；
3. 填写：
   - **WebDAV 地址**：根地址，如 `https://dav.example.com:5006/dav`
   - **账号 / 密码**：Basic Auth 凭据（无认证可留空）；密码留空表示不修改已保存项
4. 保存后，首页「WebDAV 网盘」入口即可浏览并播放。

> 凭据仅保存在服务端 KV 与 Worker 端，**绝不返回给前端**。  
> 若你更习惯用 `wrangler.toml` 的 `[vars]` 写死（`WEBDAV_BASE` / `WEBDAV_USER` / `WEBDAV_PASS`），它仍作为 **fallback** 生效：KV 中的配置优先于 wrangler 变量。

> 未配置时，「WebDAV 网盘」入口仍可点击，但会提示「WebDAV 未配置」。

## 已知限制 / 注意事项

- **仅支持 AppleCMS 直链 JSON 接口**（`ac=list`/`ac=detail`/`ac=videolist`），依赖 Spider/XPath 解析的站点无法播放。
- **播放已默认走同源流媒体代理 `/api/stream`**：前端拿到的播放地址会自动改写为 `/api/stream?url=...`，由 Worker 向源站拉流并注入源站自身的 `Referer`/`Origin`、透传 `Range`、对 m3u8 递归改写内部 ts/key 地址。这样能解决大部分源站「防盗链（Referer 校验）/跨域」导致的连接失败——这也是 Cloudflare 版相比 Docker 版最容易踩的坑（Docker 版前端跑在你自己的域名/IP 下，源站通常放行；CF 版跑在 `*.workers.dev` 或自定义域名下，源站可能拒绝）。
- **仍有极少数源站只放行特定地区/ISP 出口 IP**：这种情况下代理也救不了（Worker 出口是 Cloudflare 数据中心 IP），只能换源或改用 Docker 版。
- **部分影视源是 `http://`**，Cloudflare Workers 的子请求对纯 HTTP 支持有限，建议优先添加 `https://` 的源。
- 影视聚合类应用涉及版权与地区合规，请确保在合法授权范围内使用；公网部署务必修改默认密码。

## 目录结构

```
tesla-media-hub-cf/
├── wrangler.toml          # Worker + Assets + KV 配置（Cloudflare 版）
├── docker-compose.yml     # 完整原版一键部署（Docker 版，拉取 Docker Hub 镜像）
├── package.json
├── src/
│   ├── index.js           # Worker 入口（fetch handler + 路由）
│   └── lib/
│       ├── store.js       # KV 持久化 + 无状态 token 鉴权
│       ├── sites.js       # AppleCMS 站点适配（首页/分类/搜索/详情）
│       ├── fetcher.js     # fetch 封装（超时/UA）
│       ├── parsePlay.js   # 播放地址解析（$$$/#/$ 拆分）
│       ├── resolvePlay.js # HTML 跳转页真实地址解析
│       ├── streamProxy.js  # 流媒体同源代理（绕过源站防盗链/跨域）
│       └── sourceParser.js# 源解析（仅 applecms）
└── public/                # 前端静态资源（原样托管）
```

