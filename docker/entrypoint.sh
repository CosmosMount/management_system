#!/bin/sh
set -e

mkdir -p /app/data /app/storage/uploads /app/public/uploads

if [ -z "$DATABASE_URL" ]; then
  export DATABASE_URL="file:/app/data/app.db"
fi

echo "[entrypoint] DATABASE_URL=$DATABASE_URL"
if [ "$SKIP_DB_PUSH" = "true" ]; then
  echo "[entrypoint] 跳过数据库 schema 同步（SKIP_DB_PUSH=true）"
else
  echo "[entrypoint] 应用数据库迁移..."
  npm run db:deploy
fi

if [ "$RUN_DB_SEED" = "true" ]; then
  echo "[entrypoint] 执行 seed（RUN_DB_SEED=true）..."
  npx tsx prisma/seed.ts
fi

exec "$@"
