set -euo pipefail

ensure_node() {
  if command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1; then
    return 0
  fi

  echo "Node.js/npm not found; attempting install..." >&2

  if ! command -v apt-get >/dev/null 2>&1; then
    echo "Unsupported server (no apt-get). Install Node.js 24+ manually." >&2
    exit 1
  fi

  local SUDO=""
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  fi

  $SUDO apt-get update -y
  $SUDO apt-get install -y --no-install-recommends ca-certificates curl gnupg

  # Node 24 satisfies "engines.node >=24"
  curl -fsSL https://deb.nodesource.com/setup_24.x | $SUDO -E bash -
  $SUDO apt-get install -y nodejs

  command -v node >/dev/null 2>&1 && command -v npm >/dev/null 2>&1
}

ensure_pm2() {
  if command -v pm2 >/dev/null 2>&1; then
    return 0
  fi

  echo "pm2 not found; attempting install..." >&2

  if npm i -g pm2 >/dev/null 2>&1; then
    return 0
  fi

  if command -v sudo >/dev/null 2>&1; then
    sudo npm i -g pm2
    return 0
  fi

  echo "Unable to install pm2 (no permissions). Install it manually: npm i -g pm2" >&2
  exit 1
}

ensure_node

cd "${HETZNER_DEPLOY_PATH}"
npm ci || npm install

ensure_pm2

# Export environment variables for PM2
export PM2_APP_NAME="${PM2_APP_NAME}"
export TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
export TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
export OUTPUT_DIR="${OUTPUT_DIR:-}"

PM2_APP_NAME="${PM2_APP_NAME}" pm2 startOrReload ecosystem.config.cjs --env production
pm2 save
