#!/usr/bin/env bash
# 阿里云轻量应用服务器一键部署脚本（Ubuntu/Debian/Alibaba Cloud Linux/CentOS 通用）
# 用法： sudo bash deploy.sh
# 作用：检测并安装 Node 20（含旧版自动升级） -> 安装依赖 -> 自动取公网 IP 填 BASE_URL -> pm2 守护启动
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo "==> [1/5] 检查 Node.js（需要 >= 18，过低/未装则自动装 Node 20）"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  echo "    当前 Node: $(node -v)"
  [ "$NODE_MAJOR" -ge 18 ] && NODE_OK=1
fi
if [ "$NODE_OK" -ne 1 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    # Ubuntu / Debian（含阿里云 Ubuntu 镜像）
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get update
    apt-get install -y nodejs build-essential
  elif command -v dnf >/dev/null 2>&1; then
    # Alibaba Cloud Linux / Fedora
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs gcc-c++ make
  elif command -v yum >/dev/null 2>&1; then
    # CentOS 系
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs gcc-c++ make
  else
    echo "!! 未识别的包管理器，请手动安装 Node 20 后重跑本脚本" >&2
    exit 1
  fi
fi
node -v

echo "==> [2/5] 安装运行依赖（跳过 playwright 等开发依赖，不下载 Chromium）"
npm install --omit=dev

echo "==> [3/5] 计算公网地址（优先用阿里云元数据，失败回退到 BASE_URL 环境变量）"
PUBLIC_IP="$(curl -s --max-time 3 http://100.100.100.200/latest/meta-data/public-ipv4 || true)"
if [ -z "$PUBLIC_IP" ]; then PUBLIC_IP="${BASE_URL:-localhost}"; fi
PORT="${PORT:-3000}"
export BASE_URL="http://${PUBLIC_IP}:${PORT}"
echo "    BASE_URL=${BASE_URL}"

echo "==> [4/5] 安装 pm2 进程守护（如未安装）"
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi

echo "==> [5/5] 启动 / 重启服务"
pm2 delete pingfen 2>/dev/null || true
pm2 start server.js --name pingfen --update-env
pm2 save

echo ""
echo "✅ 部署完成！访问地址：${BASE_URL}"
echo "   大屏  : ${BASE_URL}/screen"
echo "   后台  : ${BASE_URL}/admin"
echo "   评委  : ${BASE_URL}/judge"
echo "   控制台: ${BASE_URL}/control"
echo ""
echo "   ⚠️ 记得在服务器控制台「防火墙」放行 TCP ${PORT}"
