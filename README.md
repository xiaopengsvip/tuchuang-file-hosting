# Tuchuang File Hosting

一个面向个人/小团队的文件托管、图床与内容管理平台，当前线上入口：

- 主域名：https://tuchuang.allapple.top
- 短链/移动端入口：https://tc.allapple.top

项目采用 Node.js + Express 提供上传、下载、预览和 API 服务，React + Vite 构建前端界面，运行数据使用本地文件系统与 SQLite 保存。

## 功能亮点

- 多文件上传：支持拖拽、选择文件、粘贴剪贴板图片。
- 大文件断点续传：前端自动分片，默认 8MB chunk。
- 双额度策略：公开上传默认 1GB，管理员 token 上传默认 10GB。
- 短链与原始链接：生成 `/s/:id`、`/f/:id/:name`、`/raw/:id` 等访问入口。
- 在线预览：图片、视频、音频、PDF、Office 文档、文本文件等类型提供站内预览。
- 生命周期管理：文件默认按最近访问时间延长 7 天，长期无人访问会自动清理。
- SQLite 元数据：文件、视频推荐、笔记、访问统计等信息写入 `data/tuchuang.sqlite`。
- 内容平台能力：视频推荐区、文件笔记、管理端推荐审核与批量操作。
- 内容安全：文件名/文本内容关键词过滤，图片/视频可接入本地 NudeNet + ffmpeg 媒体审核。
- 安全响应头：默认设置 CSP、HSTS、X-Frame-Options、nosniff 等基础防护。

## 技术栈

- Node.js 24+（使用内置 `node:sqlite`）
- Express 4
- React 18
- Vite 6
- SQLite WAL
- Node.js built-in test runner
- 可选：Python + NudeNet + ffmpeg，用于图片/视频本地内容审核

## 目录结构

```text
.
├── server.js                  # Express API、上传、预览、静态资源服务
├── src/                       # React 前端与可测试业务模块
├── tests/                     # node --test 单元测试
├── dist/                      # Vite 构建产物，生产服务会直接托管这里
├── docs/                      # 设计/部署/API 文档
├── scripts/                   # 辅助脚本，例如本地媒体审核
├── uploads/                   # 运行时上传文件，已被 .gitignore 排除
├── data/                      # 运行时 SQLite 数据，已被 .gitignore 排除
├── logs/                      # 运行时日志，已被 .gitignore 排除
└── file-index.json            # 旧版 JSON 索引，运行数据，已被 .gitignore 排除
```

## 快速开始

要求 Node.js 24 或更高版本。

```bash
npm install
cp .env.example .env
npm run build
npm start
```

默认服务只监听本机：

```text
http://127.0.0.1:8765
```

开发前端：

```bash
npm run dev
```

前端开发服务器会把 `/api` 和 `/f` 代理到 `http://localhost:8765`。

## 常用命令

```bash
npm test          # 运行单元测试
npm run build    # 构建前端 dist/
npm start        # 启动 Express 生产服务
npm run server   # 同 npm start
```

## 环境变量

复制 `.env.example` 到 `.env` 后按需修改：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8765` | Express 监听端口 |
| `BASE_URL` | `https://tuchuang.allapple.top` | 主文件链接域名 |
| `SHORT_BASE_URL` | `https://tc.allapple.top` | 短链域名 |
| `ADMIN_TOKEN` / `TUCHUANG_ADMIN_TOKEN` | 空 | 管理员 token，启用删除、日志、视频推荐审核、笔记管理等操作 |
| `PUBLIC_MAX_FILE_MB` | `1024` | 公开上传单文件上限，单位 MB |
| `ADMIN_MAX_FILE_MB` | `10240` | 管理员上传单文件上限，单位 MB |
| `MAX_FILES` | `50` | 单次最多上传文件数 |
| `UPLOAD_DIR` | `./uploads` | 上传文件保存目录 |
| `QUARANTINE_DIR` | `UPLOAD_DIR/.quarantine` | 审核通过前的临时隔离目录 |
| `CHUNK_DIR` | `UPLOAD_DIR/.chunks` | 断点续传 chunk 目录 |
| `INDEX_FILE` | `./file-index.json` | 旧 JSON 索引兼容文件 |
| `DB_FILE` | `./data/tuchuang.sqlite` | SQLite 元数据库 |
| `LOG_DIR` | `./logs` | 上传和服务日志目录 |
| `RESUMABLE_CHUNK_SIZE` | `8388608` | 断点续传分片大小，默认 8MB |
| `CLEANUP_INTERVAL_MS` | `3600000` | 过期文件清理间隔 |
| `CHUNK_SESSION_TTL_MS` | `86400000` | 未完成分片上传会话保留时间 |
| `MEDIA_MODERATION_ENABLED` | `true` | 是否启用本地媒体审核 |
| `MEDIA_MODERATION_BLOCK_ON_UNAVAILABLE` | `false` | 审核器不可用时是否阻断上传 |
| `MEDIA_MODERATION_PYTHON` | `python3` | 媒体审核 Python 解释器 |
| `MEDIA_MODERATION_SCRIPT` | `scripts/local-media-moderation.py` | 本地媒体审核脚本 |
| `FFMPEG_PATH` | `ffmpeg` | 视频抽帧使用的 ffmpeg 路径 |

注意：`.env`、`uploads/`、`data/`、`logs/` 都是运行时敏感/体积数据，不应提交到 GitHub。

## API 概览

详细说明见 `docs/API.md`。

常用接口：

- `GET /health`：健康检查和服务能力摘要。
- `POST /api/upload`：普通多文件上传，form 字段名为 `files`。
- `POST /api/uploads/init`：初始化断点续传。
- `PUT /api/uploads/:uploadId/chunks/:index`：上传指定 chunk。
- `POST /api/uploads/:uploadId/complete`：合并 chunk 并生成文件记录。
- `GET /api/files`：分页查询文件列表。
- `GET /api/stats`：统计信息。
- `GET /api/feed/videos`：公开视频推荐流。
- `GET /api/notes`：公开笔记列表，带管理员 token 时可查看私有笔记。
- `GET /s/:id`：短链跳转。
- `GET /preview/:id`：站内预览页。

管理员接口需要在请求头带：

```text
X-Admin-Token: <ADMIN_TOKEN>
```

## 部署说明

生产部署建议使用 systemd 管理 Node 进程，Caddy 或 Nginx 反向代理到本机 `127.0.0.1:8765`。

部署细节见 `docs/DEPLOYMENT.md`。

## 数据与备份

需要备份的运行数据：

- `uploads/`：实际上传文件。
- `data/tuchuang.sqlite*`：SQLite 数据库及 WAL/SHM 文件。
- `file-index.json`：旧版兼容索引，如果线上仍在使用请一起备份。
- `logs/`：上传和服务审计日志，可按需求备份或轮转。

推荐备份命令示例：

```bash
mkdir -p backups
sqlite3 data/tuchuang.sqlite ".backup 'backups/tuchuang-$(date +%Y%m%d%H%M%S).sqlite'"
tar -czf "backups/uploads-$(date +%Y%m%d%H%M%S).tar.gz" uploads
```

## 安全注意事项

- 必须设置强 `ADMIN_TOKEN`，不要把 `.env` 提交到仓库。
- 仓库只保存源码、测试、文档和构建产物，不保存线上上传文件和数据库。
- 公开上传场景建议在反向代理层增加请求体大小限制、速率限制和访问日志。
- 媒体审核不可替代人工审核；如果业务必须严格拦截，设置 `MEDIA_MODERATION_BLOCK_ON_UNAVAILABLE=true`。
- 删除文件接口是软删除元数据 + 删除本地文件，执行前请确认备份策略。

## License

当前仓库未声明开源许可证。公开发布前如需允许他人复用，请补充 LICENSE 文件。
