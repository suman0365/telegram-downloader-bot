#!/bin/sh
# start.sh — starts the Local Bot API server (if configured) + the Node app.
# - If TELEGRAM_API_ID + TELEGRAM_API_HASH are set AND the binary exists,
#   telegram-bot-api runs in --local mode in the background on port 8081.
#   Download is then unlimited (needed for >20 MB files, up to 4 GB).
# - If either is missing, the app runs in hosted mode
#   (api.telegram.org, getFile limit 20 MB) and logs a clear warning.
# - Never put a real token in this file. All secrets come from env vars.
set -e

if [ -n "$TELEGRAM_API_ID" ] && [ -n "$TELEGRAM_API_HASH" ] && [ -x /usr/local/bin/telegram-bot-api ]; then
  echo "[start] Local Bot API server starting on 127.0.0.1:8081 (--local mode)"
  mkdir -p /var/lib/telegram-bot-api /tmp/telegram-bot-api-tmp
  /usr/local/bin/telegram-bot-api \
    --local \
    --api-id="$TELEGRAM_API_ID" \
    --api-hash="$TELEGRAM_API_HASH" \
    --http-port=8081 \
    --dir=/var/lib/telegram-bot-api \
    --temp-dir=/tmp/telegram-bot-api-tmp &
  export LOCAL_BOT_API_URL="http://127.0.0.1:8081"
  # Give the local server a moment to bind before the Node app serves /dl
  sleep 2
else
  echo "[start] WARNING: Local Bot API server NOT started."
  echo "[start] Need TELEGRAM_API_ID + TELEGRAM_API_HASH and the telegram-bot-api binary."
  echo "[start] Running in hosted mode only — getFile limit 20 MB. See README."
fi

exec node src/index.js
