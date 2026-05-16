#!/bin/bash
# Dump Sniper V3.17 部署脚本
# 用法：sudo bash deploy/install.sh [安装路径，默认 /opt/dump-sniper]
#
# 全新安装（推荐）：
#   1. git clone <repo> && cd dump-sniper
#   2. sudo bash deploy/install.sh
#   3. 按提示编辑 .env (见 .env.example 和 DEPLOY.md)
#   4. sudo systemctl start dump-sniper

set -euo pipefail

INSTALL_DIR="${1:-/opt/dump-sniper}"
SERVICE_USER="${SERVICE_USER:-ubuntu}"

echo "======================================"
echo "Dump Sniper V3.17 部署"
echo "======================================"
echo "安装路径: $INSTALL_DIR"
echo "运行用户: $SERVICE_USER"
echo ""

if [[ $EUID -ne 0 ]]; then
   echo "⚠️  此脚本需要 root 权限运行 (sudo)"
   exit 1
fi

# 1. 拷贝项目（假设当前在项目根目录）
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$( cd "$SCRIPT_DIR/.." && pwd )"

if [[ ! -d "$INSTALL_DIR" ]]; then
    echo "[1/6] 创建安装目录: $INSTALL_DIR"
    mkdir -p "$INSTALL_DIR"
fi

echo "[2/6] 拷贝项目文件"
rsync -a --exclude='node_modules' --exclude='data/*.db*' --exclude='logs/*' \
      --exclude='.env' --exclude='reports/*.md' \
      "$PROJECT_DIR/" "$INSTALL_DIR/"

mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/logs" "$INSTALL_DIR/reports"

echo "[3/6] 安装依赖（npm install）"
cd "$INSTALL_DIR"
sudo -u "$SERVICE_USER" npm install --omit=dev

echo "[4/6] 设置文件权限"
chown -R "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
chmod 600 "$INSTALL_DIR/.env" 2>/dev/null || true

# 5. 安装 systemd 服务
echo "[5/6] 配置 systemd 服务"
SERVICE_FILE="/etc/systemd/system/dump-sniper.service"
sed -e "s|/opt/dump-sniper|$INSTALL_DIR|g" \
    -e "s|^User=ubuntu|User=$SERVICE_USER|" \
    -e "s|^Group=ubuntu|Group=$SERVICE_USER|" \
    "$INSTALL_DIR/deploy/dump-sniper.service" > "$SERVICE_FILE"

systemctl daemon-reload

# 6. logrotate
echo "[6/6] 配置 logrotate"
sed "s|/opt/dump-sniper|$INSTALL_DIR|g" \
    "$INSTALL_DIR/deploy/logrotate.conf" > /etc/logrotate.d/dump-sniper

echo ""
echo "✅ 安装完成"
echo ""
echo "下一步（关键！按顺序做）："
echo ""
echo "  1. 创建 .env 配置文件："
echo "     sudo -u $SERVICE_USER cp $INSTALL_DIR/.env.example $INSTALL_DIR/.env"
echo "     sudo -u $SERVICE_USER vim $INSTALL_DIR/.env"
echo "     ⚠️  必填项: HELIUS_API_KEY, HELIUS_RPC_URL, HELIUS_LASERSTREAM_*, "
echo "                BIRDEYE_API_KEY, WALLET_PRIVATE_KEY_BS58"
echo "     ⚠️  保持 DRY_RUN=true 至少 24 小时验证策略后再切 LIVE"
echo ""
echo "  2. 启动服务：    sudo systemctl start dump-sniper"
echo "  3. 开机自启：    sudo systemctl enable dump-sniper"
echo "  4. 查看状态：    sudo systemctl status dump-sniper"
echo "  5. 查看日志：    sudo journalctl -u dump-sniper -f"
echo "  6. 健康检查：    cd $INSTALL_DIR && npm run health"
echo "  7. Dashboard：   http://<server>:3001"
echo ""
echo "  详细部署指南：    见 DEPLOY.md"
echo ""
