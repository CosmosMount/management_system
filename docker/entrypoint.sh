#!/bin/sh
set -e

mkdir -p /app/data /app/public/uploads

if [ -z "$DATABASE_URL" ]; then
  export DATABASE_URL="file:/app/data/app.db"
fi

echo "[entrypoint] DATABASE_URL=$DATABASE_URL"
echo "[entrypoint] 同步数据库 schema..."
npx prisma db push --skip-generate

if [ "$RUN_DB_SEED" = "true" ]; then
  echo "[entrypoint] 执行 seed（RUN_DB_SEED=true）..."
  npx tsx prisma/seed.ts
fi

exec "$@"
