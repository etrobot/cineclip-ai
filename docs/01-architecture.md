# Architecture

## Tech Stack

### Frontend
| Technology | Version | Purpose |
|-----------|---------|---------|
| React | 19 | UI framework |
| TypeScript | ~5.8 | Type safety |
| TailwindCSS | 4 | Utility-first CSS |
| Motion (Framer Motion) | 12 | Animation library |
| Vite | 6 | Build tool & dev server |
| Lucide React | 0.546 | Icon library |
| tsparticles | 3.9 | Particle background effects |

### Backend
| Technology | Version | Purpose |
|-----------|---------|---------|
| Node.js | >=18 | Runtime |
| Express | 4 | HTTP server |
| TypeScript | ~5.8 | Type safety |
| ws | 8 | WebSocket (real-time progress) |
| tsx | 4 | Dev runner with hot reload |
| concurrently | 9 | Run server + client together |

### External Dependencies
| Tool | Purpose |
|------|---------|
| yt-dlp | YouTube subtitle extraction & video download |
| FFmpeg | Video cutting, format conversion, subtitle overlay, scene detection, keyframe extraction |
| Sharp | Thumbnail generation, grid image composition, timestamp overlay |
| OpenAI API | LLM content analysis (clip suggestion) |

### Python / yt-dlp
| Technology | Purpose |
|-----------|---------|
| uv | Python venv manager (for yt-dlp installation) |
| yt-dlp | Installed in `.venv/bin/yt-dlp` via uv |

## Coding Standards

- **Language**: TypeScript (strict mode) throughout frontend and backend
- **Module system**: ESM (`"type": "module"` in package.json)
- **Package manager**: pnpm (with workspace support)
- **Path alias**: `@` → project root (defined in vite.config.ts)
- **Naming**: camelCase for variables/functions, PascalCase for components/interfaces
- **Server entry**: `server/index.ts` — Express + WebSocket on same HTTP server
- **Dev command**: `pnpm dev` runs server + client concurrently

## Infrastructure

### Development
```
pnpm dev  →  concurrently "tsx watch server/index.ts" + "vite --port=3000"
```
- Server: http://localhost:3001 (Express + WebSocket)
- Client: http://localhost:3000 (Vite HMR)

### Production
```
vite build → dist/
tsc -p server/tsconfig.json → dist/server/
node dist/server/index.js
```

### Environment Variables
| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `OPENAI_BASE_URL` | Yes | `https://api.openai.com/v1` | OpenAI-compatible API endpoint |
| `OPENAI_API_KEY` | Yes | — | API key for LLM |
| `OPENAI_MODEL` | No | `gpt-4o-mini` | Model name for analysis |
| `VL_MODEL` | No | `gemini-2.0-flash-vision` | Vision-language model used for shot labeling |
| `PORT` | No | `3001` | Server port |
| `VITE_API_URL` | No | `http://localhost:3001` | Frontend API address |
| `YT_DLP_BIN` | No | `.venv/bin/yt-dlp` | yt-dlp binary path |
| `HTTPS_PROXY` | No | — | Proxy for yt-dlp / API calls |

## Architecture Decisions

### ADR-001: Local Processing Only
- **Decision**: All video processing runs locally (FFmpeg, yt-dlp)
- **Rationale**: Privacy protection, no cloud dependency for video ops, cost control
- **Trade-off**: Requires user to install FFmpeg & yt-dlp locally

### ADR-002: WebSocket for Progress
- **Decision**: Use WebSocket (`ws` library) for real-time progress updates instead of SSE or polling
- **Rationale**: Bidirectional, lower latency, simpler reconnection for long-running jobs
- **Trade-off**: Slightly more complex server setup (shared HTTP server)

### ADR-003: LLM-Driven Analysis
- **Decision**: Use OpenAI API to analyze subtitles and suggest clips
- **Rationale**: No need for custom ML models; flexible prompt-based approach
- **Trade-off**: Depends on external API; response format requires robust parsing

### ADR-007: Hybrid Shot Segmentation
- **Decision**: Use FFmpeg scene detection to determine shot boundaries, then use a VL model to label each scene from a numbered grid
- **Rationale**: Scene boundaries become more precise and deterministic, while the VL model focuses on semantic labeling instead of boundary detection
- **Trade-off**: Slightly more FFmpeg work and one extra image-building step; shot labeling still depends on the VL API

### ADR-006: Centralized Prompt Building (llmPrompt.ts)
- **Decision**: Extract all LLM/VL prompt construction into a dedicated `llmPrompt.ts` module
- **Rationale**: Ensures `analyzeClips` and `shotSegmentation` share the same video context format; prevents prompt drift; makes it easy to add new analysis modules
- **Trade-off**: Slightly more indirection; requires both modules to pass `VideoContext`

### ADR-004: SQLite + Drizzle ORM for Metadata Storage
- **Decision**: Store clip metadata in local SQLite database with Drizzle ORM
- **Rationale**: Structured data with relationships (author → post → clips → shots); supports multi-platform expansion (YouTube, X.com)
- **Trade-off**: Requires ORM setup; schema migrations needed on schema changes
- **Schema**: 4 tables — `author`, `original_post`, `clips`, `shots`

### ADR-005: Copy Codec for Initial Cut
- **Decision**: Use `codec: 'copy'` (no re-encode) for initial clip extraction
- **Rationale**: Much faster cutting; preserves original quality
- **Trade-off**: Subtitle overlay and portrait conversion need separate re-encode pass
