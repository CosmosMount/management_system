#!/bin/sh
set -eu

if [ "${1:-}" = "config" ] || [ "${1:-}" = "version" ]; then
  exec docker compose "$@"
fi

if [ -z "${SUDO_PASSWORD:-}" ] && [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

if docker info >/dev/null 2>&1; then
  exec docker compose "$@"
fi

if [ -z "${SUDO_PASSWORD:-}" ]; then
  echo "SUDO_PASSWORD is empty. Set it in the environment or .env before running Docker with sudo." >&2
  exit 2
fi

printf '%s\n' "$SUDO_PASSWORD" | sudo -S -p "" docker compose "$@"
