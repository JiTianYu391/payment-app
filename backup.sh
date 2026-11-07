#!/bin/sh
# 数据库备份 — PandaStack Apps 适配版（无 Docker、无 sqlite3 依赖）
# 备份的是当前 DATABASE_PATH 指向的文件：
#   - /workspace/data/app.json（推荐：已挂载 1 GiB 卷时，默认后端）
#   - /workspace/data/app.db（SQLite 后端时）
#   - ./data/app.json 或 ./data/app.db（未挂载卷、本地开发时）
# 用法：在项目目录执行 sh backup.sh
# 备份文件保存在 ./backups/app-YYYYMMDD-HHMMSS.json.gz（或 .db.gz）
# 注意：PandaStack 每次部署都是全新机器，备份文件不要只留在沙箱里，
# 请下载到本地电脑；最稳妥的是数据本身就放在已挂载的 Volume 上。
set -e
cd "$(dirname "$0")"
mkdir -p backups
TS=$(date +%Y%m%d-%H%M%S)

# 按 DATABASE_PATH 环境变量（未设置时按默认规则）定位数据库文件
DBFILE="${DATABASE_PATH:-}"
if [ -z "$DBFILE" ]; then
  if [ -f /workspace/data/app.json ]; then DBFILE="/workspace/data/app.json";
  elif [ -f /workspace/data/app.db ]; then DBFILE="/workspace/data/app.db";
  elif [ -f data/app.json ]; then DBFILE="data/app.json";
  elif [ -f data/app.db ]; then DBFILE="data/app.db";
  fi
fi

if [ -z "$DBFILE" ] || [ ! -f "$DBFILE" ]; then
  # 兼容强制 JSON 后端时 .db 路径实际存为 .db.json 的情况
  #（DB_BACKEND=json + DATABASE_PATH=./data/app.db → ./data/app.db.json）
  if [ -n "$DBFILE" ] && [ -f "$DBFILE.json" ]; then
    DBFILE="$DBFILE.json"
  fi
fi

if [ -z "$DBFILE" ] || [ ! -f "$DBFILE" ]; then
  echo "没有找到数据库文件（/workspace/data/app.json、/workspace/data/app.db、data/app.json 或 data/app.db），可能应用还未启动过"
  exit 1
fi

case "$DBFILE" in
  *.json) OUT="backups/app-$TS.json" ;;
  *.db)   OUT="backups/app-$TS.db" ;;
  *) echo "无法识别的数据库文件类型：$DBFILE"; exit 1 ;;
esac
cp "$DBFILE" "$OUT"
gzip -f "$OUT"
echo "备份完成：$OUT.gz（来源：$DBFILE）"
ls -lh backups/ | tail -n 10
echo "恢复方法：解压后覆盖 $DBFILE，然后在 PandaStack 控制台重新部署或重启 App："
echo "  gunzip $OUT.gz"
echo "  cp $OUT $DBFILE"
echo "建议：每周备份一次，并把备份下载到本地电脑，不要只留在沙箱/卷上。"
