#!/bin/sh
# 数据库备份（无 Docker、无 sqlite3 依赖）
# 备份当前 DATABASE_PATH 指向的文件：
#   - SQLite：调用 node scripts/backup.js（VACUUM INTO 热备份 + 完整性/账本一致性校验）
#   - JSON：先校验 JSON 可解析，再 gzip 复制
# 备份文件保存在 ./backups/ 下。JSON 后端不支持热备份结构语义，建议优先使用 SQLite。
# 恢复方法见脚本末尾。
set -e
cd "$(dirname "$0")"
mkdir -p backups
TS=$(date +%Y%m%d-%H%M%S)

DBFILE="${DATABASE_PATH:-}"
if [ -z "$DBFILE" ]; then
  if [ -f /workspace/data/app.db ]; then DBFILE="/workspace/data/app.db";
  elif [ -f /workspace/data/app.json ]; then DBFILE="/workspace/data/app.json";
  elif [ -f data/app.db ]; then DBFILE="data/app.db";
  elif [ -f data/app.json ]; then DBFILE="data/app.json";
  fi
fi
# 兼容 DB_BACKEND=json 且 DATABASE_PATH 以 .db 结尾时实际存成 .db.json 的情况
if [ -n "$DBFILE" ] && [ ! -f "$DBFILE" ] && [ -f "$DBFILE.json" ]; then DBFILE="$DBFILE.json"; fi

if [ -z "$DBFILE" ] || [ ! -f "$DBFILE" ]; then
  echo "没有找到数据库文件（/workspace/data/app.db、/workspace/data/app.json、data/app.db 或 data/app.json），可能应用还未启动过"
  exit 1
fi

case "$DBFILE" in
  *.db)
    BACKUP_DIR="$PWD/backups" node scripts/backup.js
    ;;
  *.json)
    OUT="backups/app-$TS.json"
    node -e "JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'))" "$DBFILE"
    cp "$DBFILE" "$OUT"
    gzip -f "$OUT"
    echo "备份完成：$OUT.gz（来源：$DBFILE，JSON 解析校验通过）"
    ;;
  *)
    echo "无法识别的数据库文件类型：$DBFILE"
    exit 1
    ;;
esac

ls -lh backups/ | tail -n 10
echo "恢复方法："
echo "  SQLite：确认应用已停止，解压备份后覆盖 $DBFILE"
echo "  JSON：gunzip 备份文件后覆盖 $DBFILE"
echo "建议：定期备份，并把备份下载/同步到本机之外。"
