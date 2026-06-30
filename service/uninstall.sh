#!/bin/sh
set -eu

SERVER_SERVICE_NAME="pnx-management-server.service"
CRON_SERVICE_NAME="pnx-management-cron.service"
FEISHU_WS_SERVICE_NAME="pnx-management-feishu-ws.service"

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
ENV_SOURCE=${ENV_SOURCE:-"$PROJECT_DIR/.env"}
SYSTEMD_DIR=${SYSTEMD_DIR:-/etc/systemd/system}
ENV_DIR=${ENV_DIR:-/etc/pnx-management}
ENV_FILE=${ENV_FILE:-"$ENV_DIR/pnx-management.env"}

if [ -f "$ENV_SOURCE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_SOURCE"
  set +a
fi

run_root() {
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return
  fi

  if sudo -n true >/dev/null 2>&1; then
    sudo "$@"
    return
  fi

  if [ -n "${SUDO_PASSWORD:-}" ]; then
    printf '%s\n' "$SUDO_PASSWORD" | sudo -S -p "" "$@"
    return
  fi

  sudo "$@"
}

for service_name in "$FEISHU_WS_SERVICE_NAME" "$CRON_SERVICE_NAME" "$SERVER_SERVICE_NAME"; do
  run_root systemctl disable --now "$service_name" >/dev/null 2>&1 || true
done

run_root rm -f \
  "$SYSTEMD_DIR/$SERVER_SERVICE_NAME" \
  "$SYSTEMD_DIR/$CRON_SERVICE_NAME" \
  "$SYSTEMD_DIR/$FEISHU_WS_SERVICE_NAME"
run_root systemctl daemon-reload
run_root systemctl reset-failed \
  "$SERVER_SERVICE_NAME" \
  "$CRON_SERVICE_NAME" \
  "$FEISHU_WS_SERVICE_NAME" >/dev/null 2>&1 || true

if [ "${REMOVE_ENV_FILE:-false}" = "true" ]; then
  run_root rm -f "$ENV_FILE"
  run_root rmdir "$ENV_DIR" >/dev/null 2>&1 || true
fi

echo "Uninstalled systemd services:"
echo "  $SERVER_SERVICE_NAME"
echo "  $CRON_SERVICE_NAME"
echo "  $FEISHU_WS_SERVICE_NAME"
echo
echo "Runtime env kept at $ENV_FILE"
echo "Set REMOVE_ENV_FILE=true to remove it during uninstall."
