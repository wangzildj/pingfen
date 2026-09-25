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

echo "==> [2.5/5] 同步最新代码（强制对齐远端 master，丢弃本地意外改动如 npm 生成的 package-lock.json）"
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git fetch origin 2>/dev/null || true
  git reset --hard origin/master 2>/dev/null || git reset --hard HEAD
fi

echo "==> [3/5] 安装运行依赖（纯 JS 包，--omit=dev 跳过 playwright，无需编译原生模块）"
rm -rf node_modules
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

echo "==> [4.5/5] 配置 nginx 反代（80 -> 127.0.0.1:${PORT}，支持大文件上传与 WebSocket）"
NGINX_OK=0
if command -v nginx >/dev/null 2>&1 || apt-get install -y nginx 2>/dev/null || dnf install -y nginx 2>/dev/null || yum install -y nginx 2>/dev/null; then
  cat > /etc/nginx/conf.d/pingfen.conf <<EOF
server {
    listen 80 default_server;
    server_name _;
    client_max_body_size 50m;
    location / {
        proxy_pass http://127.0.0.1:${PORT};
        proxy_http_version 1.1;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_read_timeout 3600s;
    }
}
EOF
  # 摘掉系统自带 nginx.conf 里的 default_server，避免 80 端口冲突
  sed -i 's/default_server//' /etc/nginx/nginx.conf 2>/dev/null || true
  rm -f /etc/nginx/conf.d/default.conf /etc/nginx/sites-enabled/default
  if nginx -t 2>/dev/null; then
    systemctl enable nginx 2>/dev/null || true
    systemctl restart nginx 2>/dev/null || nginx 2>/dev/null || true
    # SELinux 可能拦截 nginx 访问后端端口（CentOS/Alibaba Cloud Linux）
    setsebool -P httpd_can_network_connect 1 2>/dev/null || true
    NGINX_OK=1
    # nginx 通了之后，对外地址走 80，不用带端口
    export BASE_URL="http://${PUBLIC_IP}"
    echo "    nginx 反代已就绪，BASE_URL=${BASE_URL}"
  else
    echo "    !! nginx 配置校验失败（nginx -t），跳过反代，仍用 ${BASE_URL} 直连"
  fi
else
  echo "    !! nginx 安装失败，跳过反代，仍用 ${BASE_URL} 直连"
fi

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
echo "   ⚠️ 记得在服务器控制台「防火墙」放行 TCP 80 和 TCP ${PORT}"
