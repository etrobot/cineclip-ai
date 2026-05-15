# CineClip - YouTube 视频智能剪辑工具

基于 React + Node.js 的本地应用，可以通过输入 YouTube 链接，自动提取字幕，使用 LLM 分析并剪辑成多段精彩的竖屏短视频。

## 功能特性

- 🎬 **自动字幕提取**：使用 yt-dlp 提取 YouTube 视频字幕
- 🤖 **AI 智能分析**：使用 OpenAI API 分析字幕，识别精彩片段
- ✂️ **自动剪辑**：使用 FFmpeg 自动剪辑并转换为竖屏格式（9:16）
- 🎨 **现代化界面**：基于 React + TailwindCSS 的精美 UI
- 📦 **本地处理**：所有视频处理都在本地完成，保护隐私

## 技术栈

### 前端
- React 19
- TypeScript
- TailwindCSS 4
- Motion (Framer Motion)
- Vite

### 后端
- Node.js
- Express
- TypeScript
- yt-dlp (字幕提取)
- FFmpeg (视频处理)
- OpenAI API (LLM 分析)

## 前置要求

1. **Node.js** >= 18
2. **uv** - Python 虚拟环境管理工具 (用于安装 yt-dlp)
   ```bash
   # macOS
   brew install uv

   # Linux
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```
3. **FFmpeg** - 视频处理工具
   ```bash
   # macOS
   brew install ffmpeg

   # Linux
   sudo apt install ffmpeg

   # Windows
   # 从 https://ffmpeg.org/download.html 下载
   ```

4. **OpenAI API Key** - 用于 LLM 分析
   - 从 https://platform.openai.com/api-keys 获取
   - 或使用兼容的第三方服务

## 安装步骤

1. **克隆项目**
   ```bash
   git clone <your-repo-url>
   cd <project-folder>
   ```

2. **一键安装所有依赖（推荐）**
   ```bash
   chmod +x scripts/install-deps.sh
   ./scripts/install-deps.sh
   ```
   该脚本会自动：
   - 安装 pnpm 依赖（Node.js）
   - 安装 uv 并创建虚拟环境
   - 通过 uv 安装 yt-dlp
   - 自动配置 `YT_DLP_BIN` 环境变量

3. **或手动安装**
   ```bash
   # Node.js 依赖
   pnpm install

   # Python 依赖（yt-dlp）
   uv venv .venv --no-project
   uv pip install --python .venv yt-dlp
   ```

4. **配置环境变量**
   ```bash
   cp .env.example .env
   ```

   编辑 `.env` 文件，填入你的配置：
   ```env
   # OpenAI API 配置
   OPENAI_BASE_URL="https://api.openai.com/v1"
   OPENAI_API_KEY="sk-your-api-key-here"
   OPENAI_MODEL="gpt-4o-mini"

   # 服务器端口
   PORT=3001

   # 前端 API 地址
   VITE_API_URL=http://localhost:3001

   # yt-dlp 二进制路径（如果使用 uv 安装则自动配置）
   YT_DLP_BIN=./.venv/bin/yt-dlp
   ```

## 运行项目

### 开发模式

1. **启动后端服务**
   ```bash
   npm run server:dev
   ```
   服务将运行在 http://localhost:3001

2. **启动前端开发服务器**（新终端）
   ```bash
   npm run dev
   ```
   前端将运行在 http://localhost:3000

### 生产模式

1. **构建前端**
   ```bash
   npm run build
   ```

2. **构建后端**
   ```bash
   npm run server:build
   ```

3. **启动服务**
   ```bash
   npm run server:start
   ```

## 使用方法

1. 打开浏览器访问 http://localhost:3000
2. 在首页输入 YouTube 视频链接
3. 点击"Analyze"按钮
4. 等待系统：
   - 提取字幕
   - AI 分析精彩片段
   - 下载视频
   - 处理剪辑
5. 查看生成的剪辑片段，按类别分组展示

## API 接口

### POST /api/analyze
分析 YouTube 视频并返回剪辑建议

**请求体：**
```json
{
  "url": "https://youtube.com/watch?v=VIDEO_ID"
}
```

**响应：**
```json
{
  "videoId": "VIDEO_ID",
  "title": "视频标题",
  "duration": 1234,
  "thumbnail": "缩略图URL",
  "clips": [
    {
      "start": 123.5,
      "end": 178.2,
      "title": "片段标题",
      "category": "High Intensity Moments",
      "description": "片段描述"
    }
  ]
}
```

### POST /api/download
下载 YouTube 视频

**请求体：**
```json
{
  "videoId": "VIDEO_ID"
}
```

### POST /api/render
渲染视频片段为竖屏格式

**请求体：**
```json
{
  "videoId": "VIDEO_ID",
  "start": 123.5,
  "end": 178.2,
  "outputName": "clip_name.mp4"
}
```

## 项目结构

```
.
├── src/                    # 前端源码
│   ├── components/         # React 组件
│   ├── api/               # API 客户端
│   ├── App.tsx            # 主应用组件
│   └── main.tsx           # 入口文件
├── server/                # 后端源码
│   ├── routes/            # API 路由
│   ├── services/          # 业务逻辑
│   │   ├── youtube.ts     # YouTube 相关服务
│   │   ├── llm.ts         # LLM 分析服务
│   │   └── render.ts      # 视频渲染服务
│   ├── utils/             # 工具函数
│   └── index.ts           # 服务器入口
├── reference/             # 参考实现
├── videos/                # 下载的视频（自动创建）
├── clips/                 # 生成的剪辑（自动创建）
└── temp/                  # 临时文件（自动创建）
```

## 常见问题

### 1. yt-dlp 找不到
如果使用一键安装脚本，yt-dlp 会自动安装到 `.venv/bin/yt-dlp`。

手动安装时确保 yt-dlp 在系统 PATH 中，或在 `.env` 中指定路径：
```env
YT_DLP_BIN=./.venv/bin/yt-dlp
```

### 2. 无法下载某些视频
某些视频可能需要登录或有地区限制，可以配置浏览器 cookies：
```env
YT_DLP_COOKIES_BROWSER=chrome
```

### 3. 需要使用代理
在 `.env` 中配置代理：
```env
HTTPS_PROXY=http://proxy.example.com:8080
```

### 4. OpenAI API 调用失败
- 检查 API Key 是否正确
- 检查网络连接
- 如果使用第三方服务，确保 `OPENAI_BASE_URL` 配置正确

## 许可证

MIT

## 贡献

欢迎提交 Issue 和 Pull Request！
