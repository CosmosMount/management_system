#!/bin/sh
set -e

mkdir -p /app/storage/uploads /app/public/uploads

if [ -z "$DATABASE_URL" ]; then
  echo "[entrypoint] ERROR: DATABASE_URL is required (PostgreSQL connection string)"
  exit 1
fi

case "$DATABASE_URL" in
  postgresql://*|postgres://*)
    ;;
  *)
    echo "[entrypoint] ERROR: DATABASE_URL must be a PostgreSQL connection string"
    exit 1
    ;;
esac

node -e 'const url = new URL(process.env.DATABASE_URL); if (url.password) url.password = "***"; console.log(`[entrypoint] DATABASE_URL=${url.toString()}`);'

if [ "$SKIP_DB_DEPLOY" = "true" ]; then
  echo "[entrypoint] 跳过数据库迁移（SKIP_DB_DEPLOY=true）"
else
  echo "[entrypoint] 应用数据库迁移..."
  npm run db:deploy
fi

if [ "$RUN_DB_SEED" = "true" ]; then
  echo "[entrypoint] 执行 seed（RUN_DB_SEED=true）..."
  npx tsx prisma/seed.ts
fi

exec "$@"
