SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)

${SCRIPT_DIR}/uninstall.sh
${SCRIPT_DIR}/install.sh