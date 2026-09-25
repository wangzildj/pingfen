#!/usr/bin/env bash
# 阿里云轻量应用服务器一键部署脚本（Ubuntu/Debian/Alibaba Cloud Linux/CentOS 通用）
# 用法： sudo bash deploy.sh
# 作用：检查 Node(>=14 即可) -> 安装依赖（纯 JS，无需编译原生模块）-> 自动取公网 IP 填 BASE_URL -> pm2 守护启动
# 注意：本项目用 sql.js（纯 WASM）替代 better-sqlite3，不再需要 gcc/python 源码编译，彻底规避 glibc 2.28 兼容问题。
set -e

APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR"

echo "==> [1/5] 检查 Node.js（sql.js 为纯 JS，>=14 即可，低于 14 才自动装）"
NODE_OK=0
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  echo "    当前 Node: $(node -v)"
  [ "$NODE_MAJOR" -ge 14 ] && NODE_OK=1
fi
if [ "$NODE_OK" -ne 1 ]; then
  if command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get update
    apt-get install -y nodejs
  elif command -v dnf >/dev/null 2>&1; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    dnf install -y nodejs
  else
    echo "!! 未识别的包管理器，请手动安装 Node.js 后重跑本脚本" >&2
    exit 1
  fi
fi
node -v

echo "==> [2/5] 检查 git（未安装则安装）"
if ! command -v git >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then apt-get install -y git
  elif command -v dnf >/dev/null 2>&1; then dnf install -y git
  elif command -v yum >/dev/null 2>&1; then yum install -y git
  fi
fi

echo "==> [3/5] 安装运行依赖（纯 JS 包，--omit=dev 跳过 playwright，无需编译原生模块）"
npm install --omit=dev

echo "==> [4/5] 计算公网地址（轻量应用服务器无 ECS 元数据，直接用外部服务获取真实公网 IP）"
# 先试阿里云 ECS 元数据，再用外部服务兜底；两者都要求返回值必须是合法 IPv4，否则丢弃
PUBLIC_IP="$(curl -s --max-time 4 http://100.100.100.200/latest/meta-data/public-ipv4 2>/dev/null || true)"
if ! echo "$PUBLIC_IP" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
  PUBLIC_IP="$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || true)"
fi
if ! echo "$PUBLIC_IP" | grep -Eq '^[0-9]{1,3}(\.[0-9]{1,3}){3}$'; then
  PUBLIC_IP="${BASE_URL:-localhost}"
fi
PORT="${PORT:-3000}"
export BASE_URL="http://${PUBLIC_IP}:${PORT}"
echo "    BASE_URL=${BASE_URL}"

echo "==> [5/5] 安装 pm2 进程守护（如未安装）并启动"
if ! command -v pm2 >/dev/null 2>&1; then
  npm install -g pm2
fi
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
