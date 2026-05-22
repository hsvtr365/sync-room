#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="${APP_NAME:-sync-room}"
HOST="${HOST:-0.0.0.0}"
PORT="${PORT:-3000}"
PID_FILE="$ROOT_DIR/$APP_NAME.pid"
LOG_FILE="$ROOT_DIR/$APP_NAME.log"

log() {
	printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

have() {
	command -v "$1" >/dev/null 2>&1
}

load_env_file() {
	local env_file="$1"
	local line key value

	while IFS= read -r line || [[ -n "$line" ]]; do
		line="${line%$'\r'}"
		[[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
		[[ "$line" != *=* ]] && continue

		line="${line#export }"
		key="${line%%=*}"
		value="${line#*=}"
		key="${key//[[:space:]]/}"

		[[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue

		case "$value" in
			\"*\") value="${value:1:${#value}-2}" ;;
			\'*\') value="${value:1:${#value}-2}" ;;
		esac

		export "$key=$value"
	done < "$env_file"
}

cd "$ROOT_DIR"

if [[ -f "$ROOT_DIR/.env" ]]; then
	load_env_file "$ROOT_DIR/.env"
fi

log "[1/5] stop existing process"
"$ROOT_DIR/stop.sh"

log "[2/5] install dependencies"
if [[ -f "$ROOT_DIR/package-lock.json" ]]; then
	npm ci --include=dev
else
	npm install --include=dev
fi

log "[3/5] build"
npm run build

log "[4/5] start server on $HOST:$PORT"
if have pm2; then
	HOST="$HOST" PORT="$PORT" NODE_ENV="${NODE_ENV:-production}" \
		pm2 start "$ROOT_DIR/build/index.js" --name "$APP_NAME" --time --update-env
	pm2 save
	pm2 list
else
	: > "$LOG_FILE"
	HOST="$HOST" PORT="$PORT" NODE_ENV="${NODE_ENV:-production}" \
		nohup node "$ROOT_DIR/build/index.js" > "$LOG_FILE" 2>&1 &
	echo $! > "$PID_FILE"
	echo "PID: $(cat "$PID_FILE")"
	echo "Log file: $LOG_FILE"
	sleep 2
	tail -n 40 "$LOG_FILE" || true
fi

log "[5/5] done"
