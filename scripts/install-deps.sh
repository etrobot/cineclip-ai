#!/usr/bin/env bash
# ============================================
# install-deps.sh — 一键安装 Node.js + uv 依赖
# ============================================
# 用法:
#   chmod +x scripts/install-deps.sh
#   ./scripts/install-deps.sh          # 安装所有依赖
#   ./scripts/install-deps.sh --skip-node   # 跳过 Node.js 依赖安装
#   ./scripts/install-deps.sh --skip-uv     # 跳过 uv/Python 依赖安装
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

SKIP_NODE=false
SKIP_UV=false

for arg in "$@"; do
  case "$arg" in
    --skip-node) SKIP_NODE=true ;;
    --skip-uv)   SKIP_UV=true ;;
    --help|-h)
      echo "用法: $0 [选项]"
      echo ""
      echo "选项:"
      echo "  --skip-node    跳过 Node.js/pnpm 依赖安装"
      echo "  --skip-uv      跳过 uv/Python 依赖安装"
      echo "  --help, -h     显示此帮助信息"
      exit 0
      ;;
    *)
      echo "未知选项: $arg (使用 --help 查看帮助)"
      exit 1
      ;;
  esac
done

# 颜色输出
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ─── 检查前置工具 ────────────────────────────────────────────

check_command() {
  if ! command -v "$1" &>/dev/null; then
    return 1
  fi
}

# ─── Section 1: Node.js + pnpm 依赖 ──────────────────────────

if [ "$SKIP_NODE" = false ]; then
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  1/2  Node.js 依赖安装 (pnpm)"
  echo "═══════════════════════════════════════════════════════"

  # 检查 Node.js
  if check_command node; then
    NODE_VERSION=$(node -v | cut -d'v' -f2)
    log_info "Node.js 已安装: v$NODE_VERSION"
  else
    log_error "未找到 Node.js！请先安装 Node.js >= 18"
    log_info "推荐安装方式:"
    echo "  macOS:   brew install node"
    echo "  Linux:   使用 nvm 或系统包管理器"
    echo "  Windows: 从 https://nodejs.org/ 下载"
    exit 1
  fi

  # 检查 pnpm
  if ! check_command pnpm; then
    log_warn "未找到 pnpm，尝试通过 npm 安装..."
    npm install -g pnpm || { log_error "pnpm 安装失败"; exit 1; }
  fi
  PNP_VERSION=$(pnpm -v)
  log_info "pnpm 版本: $PNP_VERSION"

  # 安装 Node.js 依赖
  log_info "正在安装 Node.js 依赖 (pnpm install)..."
  cd "$PROJECT_ROOT"
  pnpm install --frozen-lockfile 2>&1 || { log_error "pnpm install 失败"; exit 1; }
  log_info "Node.js 依赖安装完成 ✓"
else
  log_info "跳过 Node.js 依赖安装 (--skip-node)"
fi

# ─── Section 2: uv + Python 依赖 ─────────────────────────────

if [ "$SKIP_UV" = false ]; then
  echo ""
  echo "═══════════════════════════════════════════════════════"
  echo "  2/2  Python 依赖安装 (uv)"
  echo "═══════════════════════════════════════════════════════"

  # 检查 uv
  if ! check_command uv; then
    log_warn "未找到 uv，尝试安装..."
    case "$(uname -s)" in
      Darwin*)
        log_info "macOS: 使用 brew 安装 uv..."
        brew install uv 2>/dev/null || pipx install uv 2>/dev/null || {
          log_error "uv 安装失败，请手动安装: https://docs.astral.sh/uv/getting-started/installation/"
          exit 1
        }
        ;;
      Linux*)
        log_info "Linux: 使用官方脚本安装 uv..."
        curl -LsSf https://astral.sh/uv/install.sh | sh || {
          log_error "uv 安装失败，请手动安装: https://docs.astral.sh/uv/getting-started/installation/"
          exit 1
        }
        # 确保 uv 在 PATH 中
        export PATH="$HOME/.local/bin:$PATH"
        ;;
      *)
        log_error "不支持的操作系统，请手动安装 uv: https://docs.astral.sh/uv/getting-started/installation/"
        exit 1
        ;;
    esac
  fi
  UV_VERSION=$(uv --version)
  log_info "uv 版本: $UV_VERSION"

  # 同步 Python 虚拟环境并安装 yt-dlp
  log_info "正在同步 Python 虚拟环境并安装 yt-dlp..."
  cd "$PROJECT_ROOT"

  # 使用 uv venv 创建/更新虚拟环境（不包含项目依赖，仅用于 yt-dlp）
  VENV_DIR=".venv"

  if [ -d "$VENV_DIR" ]; then
    log_info "更新现有虚拟环境: $VENV_DIR"
    uv pip install --python "$VENV_DIR" yt-dlp 2>&1 || { log_error "yt-dlp 安装失败"; exit 1; }
  else
    log_info "创建新的虚拟环境: $VENV_DIR"
    uv venv "$VENV_DIR" --no-project 2>&1 || { log_error "虚拟环境创建失败"; exit 1; }
    uv pip install --python "$VENV_DIR" yt-dlp 2>&1 || { log_error "yt-dlp 安装失败"; exit 1; }
  fi
  log_info "yt-dlp 安装完成 ✓"

  # 验证 yt-dlp 可执行
  log_info "验证 yt-dlp 安装..."
  if "$VENV_DIR/bin/yt-dlp" --version &>/dev/null; then
    YTDLP_VER=$("$VENV_DIR/bin/yt-dlp" --version)
    log_info "yt-dlp 版本: $YTDLP_VER"
    log_info "yt-dlp 路径: $VENV_DIR/bin/yt-dlp"
  else
    log_error "yt-dlp 验证失败！路径: $VENV_DIR/bin/yt-dlp"
    exit 1
  fi
else
  log_info "跳过 Python/uv 依赖安装 (--skip-uv)"
fi

# ─── 完成 ────────────────────────────────────────────────────

echo ""
echo "═══════════════════════════════════════════════════════"
log_info "所有依赖安装完成！"
echo ""
log_info "环境变量建议（添加到 .env 文件）:"
echo "  YT_DLP_BIN=$PROJECT_ROOT/.venv/bin/yt-dlp"
echo ""
log_info "接下来:"
echo "  1. 确保 .env 文件已配置 (参考 .env.example)"
echo "  2. 启动开发服务器: pnpm dev"
echo ""
echo "═══════════════════════════════════════════════════════"