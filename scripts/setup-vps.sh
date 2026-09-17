#!/usr/bin/env bash
# 王语晨补档站 - 国内 VPS 一键部署脚本
# 用途：把抓取脚本放到国内 Linux 服务器上，配置 cron 每 4 小时自动补档。
# 适用：阿里云 / 腾讯云轻量 / 华为云等「国内节点」服务器（出口为大陆 IP，可直连口袋48）。
#
# 用法：
#   1) 把整个 wangyuchen-archive 目录上传到国内服务器（如 /opt/wangyuchen-archive）
#   2) 在此目录执行： bash scripts/setup-vps.sh
#   3) 按提示填入 .env 里的 POCKET48_TOKEN
#   4) 站点数据会落到 site/data/，用任意静态托管（nginx / 对象存储 / CDN）对外即可
set -e

cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
SCRAPER_DIR="$ROOT/scraper"

echo "==> 工作目录: $ROOT"

# 1) 检查 Node（建议 18+，脚本用 fetch / WebAssembly）
if ! command -v node >/dev/null 2>&1; then
  echo "✗ 未检测到 node，请先安装 Node 18+（如 apt install nodejs / yum install nodejs）"
  exit 1
fi
NODE_BIN="$(command -v node)"
NODE_VER="$($NODE_BIN -v)"
echo "==> 使用 node: $NODE_BIN ($NODE_VER)"

# 2) 准备 .env
if [ ! -f "$SCRAPER_DIR/.env" ]; then
  cp "$SCRAPER_DIR/.env.example" "$SCRAPER_DIR/.env"
  echo "⚠ 已生成 $SCRAPER_DIR/.env，请编辑填入你的 POCKET48_TOKEN 后重新运行本脚本"
  echo "   编辑命令: vi $SCRAPER_DIR/.env"
  exit 0
fi
echo "==> .env 已存在，跳过生成"

# 3) 校验 token 是否已填写
if grep -q "POCKET48_TOKEN=你的token\|POCKET48_TOKEN=$" "$SCRAPER_DIR/.env" 2>/dev/null; then
  echo "⚠ .env 里的 POCKET48_TOKEN 似乎还是占位符，请先填入真实 token 再运行"
  exit 1
fi

# 4) 代理为脚本内建能力（CONNECT 隧道），无需安装任何依赖。
#    如需代理：在 .env 里加一行  SCRAPE_PROXY=https://用户名:密码@代理地址:端口

# 5) 先跑一次，验证能抓到数据（国内 VPS 应输出真实条数，非 403）
echo "==> 试运行抓取一次..."
if (cd "$SCRAPER_DIR" && "$NODE_BIN" scrape.mjs); then
  echo "✓ 试运行成功，数据已写入 site/data/"
else
  echo "✗ 试运行失败（多半是网络/ token 问题）。请检查："
  echo "   - 服务器是否大陆 IP（curl -I https://pocketapi.48.cn 应非 403）"
  echo "   - POCKET48_TOKEN 是否有效"
  exit 1
fi

# 6) 配置 cron：每 4 小时自动抓取
CRON_LINE="0 */4 * * * cd $SCRAPER_DIR && $NODE_BIN scrape.mjs >> $ROOT/scraper/cron.log 2>&1"
( crontab -l 2>/dev/null | grep -v "scraper/scrape.mjs" ; echo "$CRON_LINE" ) | crontab -
echo "==> 已写入 crontab（每 4 小时）："
echo "    $CRON_LINE"

echo ""
echo "✅ 部署完成！"
echo "   数据目录: $ROOT/site/data/"
echo "   站点部署: 把 $ROOT/site/ 整体放到 nginx / 对象存储 / CDN 即可（纯静态，全球可访问）"
echo "   日志查看: tail -f $ROOT/scraper/cron.log"
