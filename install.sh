#!/usr/bin/env bash
# OpenClaw (CodeBuddy fork) 一键安装脚本
# 用法: curl -fsSL <raw-url>/install.sh | bash
set -euo pipefail

REGISTRY="https://npm.cnb.cool/mugglezack/openclaw-cb/-/packages/"
PKG="openclaw"
MIN_NODE=22

# ---------- 颜色输出 ----------
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

info()  { printf "${GREEN}[INFO]${NC}  %s\n" "$*"; }
warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
fail()  { printf "${RED}[ERROR]${NC} %s\n" "$*"; exit 1; }

# ---------- 环境检测 ----------
info "检测运行环境..."

OS="$(uname -s)"
ARCH="$(uname -m)"
info "系统: ${OS} ${ARCH}"

# Node.js
if ! command -v node &>/dev/null; then
  fail "未检测到 Node.js，请先安装 Node.js >= ${MIN_NODE}（推荐使用 nvm 或 fnm）"
fi

NODE_VER="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "${NODE_VER}" -lt "${MIN_NODE}" ]; then
  fail "Node.js 版本过低（当前 v$(node -v | sed 's/^v//')），需要 >= ${MIN_NODE}"
fi
info "Node.js $(node -v) ✓"

# npm
if ! command -v npm &>/dev/null; then
  fail "未检测到 npm，请确保 npm 已安装"
fi
info "npm $(npm -v) ✓"

# ---------- 安装 ----------
info "从 CNB registry 安装 ${PKG}..."
info "registry: ${REGISTRY}"

# 通过 --registry 参数指定源，不修改全局 npmrc，不影响其他包
npm install -g "${PKG}" --registry="${REGISTRY}"

# ---------- 验证 ----------
if command -v openclaw &>/dev/null; then
  VER="$(openclaw --version 2>/dev/null || echo '未知')"
  info "安装成功！"
  info "版本: ${VER}"
  echo ""
  echo "使用方法:"
  echo "  openclaw --help        查看帮助"
  echo "  openclaw gateway run   启动网关"
  echo ""
  echo "更新方法:"
  echo "  npm update -g openclaw --registry=${REGISTRY}"
else
  fail "安装似乎未成功，openclaw 命令不可用。请检查 npm 全局 bin 目录是否在 PATH 中。"
fi
