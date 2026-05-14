# CineClip AI — 项目 Wiki

> 基于 React + Node.js 的 YouTube 视频智能剪辑工具。通过输入 YouTube 链接，自动提取字幕，使用 LLM 分析并剪辑成多段竖屏短视频。

---

## 📋 目录

1. [项目概述](#1-项目概述)
2. [技术栈](#2-技术栈)
3. [架构概览](#3-架构概览)
4. [项目结构](#4-项目结构)
5. [核心功能流程](#5-核心功能流程)
6. [前端详解](#6-前端详解)
7. [后端详解](#7-后端详解)
8. [API 接口文档](#8-api-接口文档)
9. [数据流与状态管理](#9-数据流与状态管理)
10. [开发与运行](#10-开发与运行)
11. [配置与环境变量](#11-配置与环境变量)
12. [调试与测试脚本](#12-调试与测试脚本)

---

## 1. 项目概述

**CineClip AI** 是一个本地化的 YouTube 视频智能剪辑工具。它将长视频自动分析并切割成多个竖屏（9:16）短视频片段，每个片段都带有 AI 生成的标题和字幕叠加。

### 核心能力
- **自动字幕提取**：使用 yt-dlp 提取 YouTube 视频字幕（VTT 格式）
- **AI 智能分析**：调用 OpenAI API 分析字幕内容，识别精彩片段并生成中文标题
- **自动剪辑**：使用 FFmpeg 剪辑视频、转换竖屏格式、合成标题/字幕覆盖层
- **实时进度**：WebSocket + SSE 双通道推送处理进度
- **本地处理**：所有视频处理在本地完成，保护隐私

---

## 2. 技术栈

### 前端
| 技术 | 版本 | 用途 |
|------|------|------|
| React | 19 | UI 框架 |
| TypeScript | ~5.8 | 类型系统 |
| TailwindCSS | 4.1 | 样式 |
| Framer Motion | 12.2 | 动画 |
| Vite | 6.2 | 构建工具 |
| Lucide React | 0.546 | 图标 |
| tsparticles | 3.9 | 粒子背景效果 |

### 后端
| 技术 | 版本 | 用途 |
|------|------|------|
| Node.js | >= 18 | 运行时 |
| Express | 4.21 | HTTP 服务器 |
| TypeScript | ~5.8 | 类型系统 |
| ws | 8.20 | WebSocket 服务 |
| yt-dlp | 系统安装 | YouTube 视频/字幕下载 |
| FFmpeg | 系统安装 | 视频剪辑与处理 |
| Puppeteer Core | 24.43 | 渲染覆盖层图片 |
| OpenAI API | - | LLM 内容分析 |

---

## 3. 架构概览

```
┌─────────────────────────────────────────────────────────┐
│                       前端 (React)                        │
│  ┌─────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐ │
│  │  Hero   │  │ Loading  │  │  ClipRow │  │  GlowBg  │ │
│  │  首页   │  │  加载模态 │  │  片段列表 │  │  粒子背景 │ │
│  └────┬────┘  └─────┬────┘  └─────┬────┘  └──────────┘ │
│       │              │              │                     │
│  ┌────▼──────────────▼──────────────▼──────────────────┐ │
│  │              App.tsx (状态管理中心)                    │ │
│  │  - view 状态: home → loading → results               │ │
│  │  - useRenderQueue (渲染队列)                          │ │
│  │  - usePersistedClips (本地持久化)                     │ │
│  └──────────────────────┬───────────────────────────────┘ │
│                         │ fetch / WebSocket              │
└─────────────────────────┼─────────────────────────────────┘
                          │
┌─────────────────────────┼─────────────────────────────────┐
│                       后端 (Express)                       │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  server/index.ts — 服务入口                          │ │
│  │  - CORS / JSON 中间件                                │ │
│  │  - 静态文件服务 (clips/, thumbnails/)                 │ │
│  │  - WebSocket 管理器 (wsManager)                      │ │
│  └──────────────┬──────────────────────────────────────┘ │
│                 │                                        │
│  ┌──────────────▼──────────────────────────────────────┐ │
│  │  路由层 (routes/)                                    │ │
│  │  ├── analyze.ts    POST /api/analyze                 │ │
│  │  ├── download.ts   POST /api/download                │ │
│  │  ├── render.ts     POST /api/render                  │ │
│  │  ├── delete.ts     POST /api/delete                  │ │
│  │  ├── progress.ts   GET  /api/progress/:jobId (SSE)   │ │
│  │  └── test.ts       POST /api/test (测试用)            │ │
│  └──────────────┬──────────────────────────────────────┘ │
│                 │                                        │
│  ┌──────────────▼──────────────────────────────────────┐ │
│  │  服务层 (services/)                                  │ │
│  │  ├── youtube.ts    — 视频信息获取 + 字幕下载           │ │
│  │  ├── llm.ts        — OpenAI 调用 + 片段分析            │ │
│  │  ├── render.ts     — FFmpeg 剪辑 + 竖屏合成            │ │
│  │  ├── ffmpeg.ts     — FFmpeg 底层封装                  │ │
│  │  ├── overlayRenderer.ts — Puppeteer 封面/字幕渲染      │ │
│  │  ├── progressEmitter.ts — 进度事件管理 (EventEmitter)  │ │
│  │  └── wsManager.ts  — WebSocket 连接管理               │ │
│  └─────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

---

## 4. 项目结构

```
cineclip-ai/
├── src/                          # 前端源码
│   ├── App.tsx                   # 主应用组件（状态管理中枢）
│   ├── main.tsx                  # React 入口文件
│   ├── index.css                 # 全局样式 + Tailwind 指令
│   ├── api/
│   │   └── client.ts             # API 客户端（fetch 封装 + WebSocket）
│   ├── components/
│   │   ├── Hero.tsx              # 首页搜索组件
│   │   ├── ClipRow.tsx           # 单个视频的片段列表行
│   │   ├── ClipCard.tsx          # 单个片段卡片（缩略图+操作）
│   │   ├── LoadingModal.tsx      # 加载进度模态框
│   │   └── GlowBackground.tsx    # 粒子动画背景
│   └── hooks/
│       ├── useRenderQueue.ts     # 渲染队列管理（核心状态机）
│       └── usePersistedClips.ts  # localStorage 持久化
├── server/                       # 后端源码
│   ├── index.ts                  # Express 服务器入口
│   ├── tsconfig.json             # 后端 TypeScript 配置
│   ├── routes/
│   │   ├── analyze.ts            # 分析视频路由
│   │   ├── download.ts           # 下载视频路由
│   │   ├── render.ts             # 渲染剪辑路由
│   │   ├── delete.ts             # 删除文件路由
│   │   ├── progress.ts           # SSE 进度流路由
│   │   └── test.ts               # 测试路由
│   ├── services/
│   │   ├── youtube.ts            # YouTube API + yt-dlp 封装
│   │   ├── llm.ts                # OpenAI 调用 + 结果解析
│   │   ├── render.ts             # 视频渲染业务逻辑
│   │   ├── ffmpeg.ts             # FFmpeg 命令封装
│   │   ├── overlayRenderer.ts    # Puppeteer 图片渲染
│   │   ├── progressEmitter.ts    # 进度事件发射器
│   │   └── wsManager.ts          # WebSocket 服务器管理
│   └── utils/
│       ├── youtube.ts            # URL 解析工具
│       └── ytDlp.ts              # yt-dlp 子进程封装
├── scripts/                      # 调试/测试脚本
│   ├── test-pipeline.ts          # 全链路性能诊断
│   ├── test-timestamp-precision.ts  # 时间戳精度验证
│   └── check-subtitles.ts        # 字幕数据检查
├── videos/                       # 下载的原始视频（gitignored）
├── clips/                        # 生成的剪辑片段（gitignored）
│   └── thumbnails/               # 缩略图
├── temp/                         # 临时文件（gitignored）
├── package.json                  # 项目依赖
├── pnpm-lock.yaml                # 锁文件
├── vite.config.ts                # Vite 配置
├── tsconfig.json                 # 前端 TypeScript 配置
├── .env.example                  # 环境变量模板
├── .gitignore                    # Git 忽略规则
├── README.md                     # 使用文档
├── SETUP.md                      # API 配置指南
└── metadata.json                 # 应用元数据
```

---

## 5. 核心功能流程

### 5.1 完整分析管线（Analysis Pipeline）

```
用户输入 YouTube URL
        │
        ▼
┌──────────────────┐
│ ① extractVideoId │  从 URL 中提取 videoId
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ ② getVideoInfo   │  yt-dlp --dump-json 获取视频元数据
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ ③ getSubtitles   │  yt-dlp --write-sub --write-auto-sub
│                  │  下载 VTT 字幕 → parseVTT 解析
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ ④ analyzeClips   │  调用 OpenAI GPT-4o-mini
│                  │  输入：字幕文本 + 视频标题
│                  │  输出：JSON 格式的片段列表
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ ⑤ downloadVideo  │  后台异步下载视频（fire-and-forget）
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ ⑥ 返回结果       │  { videoId, title, clips, subtitles }
│                  │  前端进入 results 视图
└──────────────────┘
```

### 5.2 渲染管线（Render Pipeline）

```
用户点击播放/渲染某个片段
        │
        ▼
┌──────────────────┐
│ ① 下载视频       │  若本地无缓存则先下载
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ ② 生成缩略图     │  FFmpeg 在片段中间时间点截图
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ ③ extractClip    │  FFmpeg 剪切原始片段（codec=copy）
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ ④ 渲染覆盖层     │  Puppeteer 生成标题/字幕 PNG
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ ⑤ combineClips   │  FFmpeg 竖屏转换 + 叠加覆盖层
│                  │  - 16:9 → 9:16（加背景模糊）
│                  │  - 标题 PNG 叠加在顶部
│                  │  - 字幕 PNG 定时叠加在底部
└───────┬──────────┘
        │
        ▼
┌──────────────────┐
│ ⑥ 清理临时文件   │  删除 temp 中间产物
└──────────────────┘
```

### 5.3 进度追踪机制

使用 **双通道** 推送进度：

1. **WebSocket** (`ws://localhost:3001/ws/progress`)：实时推送
   - 客户端连接后发送 `{ type: 'subscribe', jobId }`
   - 服务端通过 `progressEmitter` 广播事件
   - 每个事件包含：`{ jobId, stage, progress, message }`

2. **SSE** (`GET /api/progress/:jobId`)：备用/历史回放
   - 支持断线重连时回放已累积的事件
   - 进度达 100% 或出错时自动关闭流

---

## 6. 前端详解

### 6.1 状态管理（App.tsx）

```
App 组件状态：
├── view: "home" | "loading" | "results"
├── status: string        # 当前阶段描述
├── progress: number      # 0-100
├── analyzedClips: VideoGroup[]  # 分组后的片段数据
├── videoData: { videoId, title, thumbnail } | null
├── error: string | null
└── queuedClips: QueuedClip[]    # 渲染队列（来自 useRenderQueue）
```

**视图切换逻辑**：`home → loading → results`，出错时 `loading → home`（3 秒后自动重置）。

### 6.2 渲染队列（useRenderQueue.ts）

这是一个自定义 Hook，管理片段的异步串行渲染：

```typescript
interface QueuedClip extends ClipItem {
  status: "pending" | "rendering" | "done" | "error";
  progress: number;
  stage: string;
  errorMessage?: string;
  clipUrl?: string;
  renderedThumbnailUrl?: string;
}
```

- `startQueue(clips)`：将所有片段标记为 pending，异步启动 `processQueue`
- `processQueue()`：**串行** 处理每个 pending 片段，调用 `renderClip` + 订阅进度
- `updateClip(id, patch)`：通过 `syncRef` 原子更新状态
- `removeClip(id)`：从队列中移除片段

### 6.3 数据持久化（usePersistedClips.ts）

使用 `localStorage` 键 `cineclip_gallery` 存储：

```typescript
interface PersistedData {
  clips: ClipItem[];
  videoData: { videoId, title, thumbnail } | null;
  queuedClips: QueuedClip[];
}
```

- 数据变更后 **500ms 防抖** 保存
- 页面加载时自动恢复

### 6.4 UI 组件

| 组件 | 功能 |
|------|------|
| **Hero** | 首页居中搜索框 + 动画 Logo + 功能特性展示 |
| **LoadingModal** | 全屏模态框：旋转齿轮动画 + 三阶段进度条 |
| **ClipRow** | 横向滚动的片段列表，按视频分组 |
| **ClipCard** | 单个片段卡片：缩略图覆盖层 + 播放/下载/删除操作 |
| **GlowBackground** | CSS 粒子动画 + 渐变光晕背景 |

### 6.5 竖屏转换设计

在 `ffmpeg.ts` 中实现的竖屏转换策略：

```
原始 16:9 视频 (1920×1080)
        │
        ▼
缩放宽度至 1080px → 高度按比例 = 607px
        │
        ▼
放置到 1080×1920 画布中央
        │
        ▼
上下添加模糊背景（boxblur 模糊半径 20）
        │
        ▼
顶部叠加标题 PNG（垂直居中于上方空白区域）
底部叠加字幕 PNG（垂直居中于下方空白区域）
```

布局常量：
- `CANVAS_W = 1080`, `CANVAS_H = 1920`
- `VIDEO_H = 607`, `VIDEO_Y = 656`
- `TITLE_Y = 328`, `TITLE_H = 120`
- `SUBTITLE_Y = 1590`, `SUBTITLE_H = 140`

---

## 7. 后端详解

### 7.1 LLM 分析服务（llm.ts）

**核心函数 `analyzeClips()`**：

1. **语言检测**：采样前 50 条字幕，判断中文/英文占比
2. **构建 Prompt**：
   - 系统提示词定义了切片规则（30-120 秒/片段、中文标题等）
   - 用户提示词包含完整字幕（最多 300 条）
3. **调用 OpenAI API**：`gpt-4o-mini`，temperature=0.35
4. **解析响应**：`parseJsonObject()` 支持代码块包裹的 JSON
5. **标准化**：`normalizeClips()` 将 LLM 返回的索引转换为时间戳
   - 支持 `start_idx/end_idx`（1-based 字幕序号）和 `start_sec/end_sec`（秒数）两种格式
   - `snapToSubtitle()` 将秒数对齐到最近字幕边界（阈值 2 秒）
6. **去重**：`deduplicateClips()` 合并 80% 以上重叠的片段

**标题验证规则**：
- 长度 4-25 字
- 禁止包含"精彩片段"、"视频节选"等空洞词汇
- 禁止以"片段"、"节选"、"剪辑"结尾
- 禁止纯时间戳格式
- 禁止英文口语开头（And/But/So 等）

### 7.2 覆盖层渲染（overlayRenderer.ts）

使用 **Puppeteer** 无头浏览器渲染 HTML → PNG：

- **标题覆盖层**：52px 白色粗体 + 文字阴影，行高 1.2，超过 14 字自动换行
- **字幕覆盖层**：30px 半透明白色 + 背景模糊黑框，行高 1.35，超过 20 字自动换行
- **智能换行**：`smartBreak()` 函数在中点附近寻找空格断开

### 7.3 FFmpeg 服务（ffmpeg.ts）

封装了以下功能：
- `extractClip()`：按时间剪切视频（支持 copy/reencode 两种模式）
- `combineClips()`：合并多个片段为竖屏格式，支持叠加 PNG 和定时字幕
- `generateThumbnail()`：指定时间点截图
- `getVideoInfo()`：使用 ffprobe 获取视频元信息
- `cleanupTempFiles()`：清理临时目录

### 7.4 进度事件系统（progressEmitter.ts）

基于 Node.js `EventEmitter` 的进度管理：

```
analyze 阶段：  subtitles(0-30%) → analyzing(30-70%) → splitting(70-100%)
render 阶段：   downloading(0-25%) → thumbnail(30-40%) → rendering(45-90%) → complete(100%)
```

支持事件回放（新连接的客户端可获取已发生的历史事件）。

---

## 8. API 接口文档

### POST `/api/analyze`

**请求体**：
```json
{ "url": "https://youtube.com/watch?v=VIDEO_ID", "jobId": "可选" }
```

**响应**：
```json
{
  "videoId": "dQw4w9WgXcQ",
  "title": "视频标题",
  "duration": 3600,
  "thumbnail": "https://i.ytimg.com/vi/.../maxresdefault.jpg",
  "clips": [
    { "start": 123.5, "end": 178.2, "title": "片段标题", "category": "High Intensity Moments", "description": "..." }
  ],
  "subtitles": [
    { "start": 0.0, "end": 4.5, "text": "字幕文本" }
  ],
  "jobId": "job_1234567890"
}
```

### POST `/api/render`

**请求体**：
```json
{
  "videoId": "dQw4w9WgXcQ",
  "start": 123.5,
  "end": 178.2,
  "outputName": "可选_自定义文件名.mp4",
  "title": "可选_覆盖标题",
  "subtitles": [{ "start": 123.5, "end": 178.2, "text": "..." }],
  "jobId": "可选"
}
```

**响应**：
```json
{
  "outputPath": "/绝对路径/clips/filename.mp4",
  "clipUrl": "/api/clips/filename.mp4",
  "thumbnailUrl": "/api/clips/thumbnails/filename.jpg",
  "jobId": "render_xxx"
}
```

### POST `/api/download`

**请求体**：`{ "videoId": "VIDEO_ID" }`

**响应**：`{ "videoPath": "/videos/VIDEO_ID.mp4" }`

### POST `/api/delete`

**请求体**：`{ "clipUrl": "/api/clips/xxx.mp4", "thumbnailUrl": "/api/clips/thumbnails/xxx.jpg" }`

**响应**：`{ "success": true, "deleted": ["文件路径列表"] }`

### GET `/api/progress/:jobId`

SSE 流式传输进度事件，事件格式：
```json
{ "jobId": "...", "stage": "analyzing", "progress": 50, "message": "AI analyzing content..." }
```

完成时发送：`{ "type": "done", "jobId": "..." }`

### GET `/health`

`{ "status": "ok" }`

---

## 9. 数据流与状态管理

### 9.1 数据流图

```
[用户输入 URL]
      │
      ▼
┌───────────┐     analyzeVideo()      ┌─────────────┐
│   React   │ ──────────────────────▶ │  Express    │
│   App     │                         │  /analyze   │
└───────────┘                         └──────┬──────┘
      ▲                                      │
      │                                      ▼
      │                               ┌─────────────┐
      │                               │  yt-dlp     │
      │                               │  (子进程)    │
      │                               └──────┬──────┘
      │                                      │
      │                               ┌──────▼──────┐
      │                               │  OpenAI API │
      │                               └──────┬──────┘
      │                                      │
      │                               ┌──────▼──────┐
      │                               │ progress    │
      │                               │Emitter/WsMng│
      │                               └──────┬──────┘
      │                                      │
      │         subscribeProgress()          │
      └──────────────────────────────────────┘
                (WebSocket 实时推送)
```

### 9.2 渲染队列状态机

```
[pending] → [rendering] → [done]
                     ↓ (失败)
                   [error]
```

每个 `QueuedClip` 经历：`pending → rendering(0-100%) → done/error`

---

## 10. 开发与运行

### 前置要求

| 依赖 | 安装方式 |
|------|----------|
| Node.js >= 18 | [官网下载](https://nodejs.org/) |
| yt-dlp | `brew install yt-dlp` / `pip install yt-dlp` |
| FFmpeg | `brew install ffmpeg` / `sudo apt install ffmpeg` |
| OpenAI API Key | [platform.openai.com](https://platform.openai.com/api-keys) |
| **可选** Puppeteer 所需的 Chrome | 需 macOS `/Applications/Google Chrome.app/` |

### 快速启动

```bash
# 1. 克隆项目
git clone <repo-url> && cd cineclip-ai

# 2. 安装依赖（使用 pnpm）
pnpm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，填入 OPENAI_API_KEY 等配置

# 4. 启动开发服务器（同时启动前后端）
pnpm dev
# 前端: http://localhost:3000
# 后端: http://localhost:3001
```

### 生产构建

```bash
pnpm run build           # 构建前端
pnpm run server:build    # 构建后端
pnpm run server:start    # 启动后端
```

---

## 11. 配置与环境变量

### `.env` 配置

```env
# OpenAI API 配置
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-your-api-key-here
OPENAI_MODEL=gpt-4o-mini

# 服务器端口
PORT=3001

# 前端 API 地址（Vite 注入）
VITE_API_URL=http://localhost:3001

# yt-dlp 配置（可选）
HTTPS_PROXY=http://proxy.example.com:8080
YT_DLP_BIN=/usr/local/bin/yt-dlp
YT_DLP_COOKIES_BROWSER=chrome

# 代理设置
HTTPS_PROXY=http://127.0.0.1:7890
```

### 支持的模型

- **OpenAI**: `gpt-4o-mini`, `gpt-4o`, `gpt-3.5-turbo` 等
- **OpenRouter**: `openai/gpt-4o-mini`, `meta-llama/llama-3.2-3b-instruct:free` 等
- **其他兼容 OpenAI API 格式的服务**均可使用

### vite.config.ts 特殊说明

```typescript
define: {
  'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
}
```

当前项目中 `GEMINI_API_KEY` 被定义但未在核心逻辑中使用。

---

## 12. 调试与测试脚本

### 全链路性能诊断

```bash
# 直接调用 service 层（绕过 HTTP）
npx tsx scripts/test-pipeline.ts https://www.youtube.com/watch?v=VIDEO_ID

# 通过 HTTP API + SSE 测试
npx tsx scripts/test-pipeline.ts http https://www.youtube.com/watch?v=VIDEO_ID http://localhost:3001
```

输出示例：
```
╔══════════════════════════════════════════════════════════╗
║       CineClip AI - 全链路逐阶段计时诊断              ║
╚══════════════════════════════════════════════════════════╝

  Stage 1: Getting Subtitles
  ✅ 字幕获取成功
     标题: ...
     字幕段数: 1234
     耗时: 12.34s

  Stage 2: Analyzing (LLM)
  ✅ LLM 分析完成
     生成剪辑数: 5
     耗时: 3.21s

  汇总报告
  阶段                   耗时        占比      详情
  ────────────────────────────────────────────────────
  Getting Subtitles      12.34s     78.5%   1234 segments
  Analyzing              3.21s      20.5%   5 clips
  Downloading            0.00s     0.0%   CACHED
  Render                 8.90s      ...     ...
```

### 时间戳精度验证

```bash
npx tsx scripts/test-timestamp-precision.ts eV3lAY77IpU
```

验证 LLM 返回的 `start_idx/end_idx` 经过 `normalizeClips()` 转换后，与原始字幕时间戳的偏差是否在 **0.1 秒** 以内。

### API 配置测试

```bash
./test-openai.sh
```

---

## 技术决策说明

### 为什么用 Puppeteer 渲染文字？

FFmpeg 的 `drawtext` 滤镜对中文支持不佳（字体渲染、换行控制有限）。使用 Puppeteer 渲染 HTML → PNG 可以：
- 精确控制字体、大小、颜色、阴影
- 支持中文自动换行
- 透明背景 PNG 方便叠加

### 为什么视频下载采用 fire-and-forget？

`/api/analyze` 路由中，视频下载在后台异步执行。这样做的好处是：
- 分析接口快速返回，用户无需等待视频下载完成
- 下载完成后缓存在 `videos/` 目录，后续渲染直接复用
- 渲染接口 `/api/render` 会检查缓存，若不存在再触发下载

### WebSocket vs SSE 的选择

- **WebSocket**：用于 `subscribeProgress()`，全双工，适合实时进度推送
- **SSE**：用于 `/api/progress/:jobId`，支持自动重连和历史事件回放
- 两者底层共用 `progressEmitter`，确保数据一致

---

## 常见问题

### 1. yt-dlp 找不到
确保 yt-dlp 已安装并在 PATH 中，或在 `.env` 中指定：
```env
YT_DLP_BIN=/path/to/yt-dlp
```

### 2. Puppeteer 找不到 Chrome
默认路径为 `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`。如需修改，请编辑 `overlayRenderer.ts` 中的 `CHROME_PATH` 常量。

### 3. FFmpeg 字幕叠加失败
确保字幕 PNG 路径正确且文件存在。`combineClips()` 使用 FFmpeg `overlay` filter，路径错误会导致静默失败。

### 4. 生成的视频不是竖屏
检查 `combineClips()` 调用时 `portrait: true` 是否设置。该参数触发 16:9 → 9:16 的转换管线。