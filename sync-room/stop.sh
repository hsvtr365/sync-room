#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_NAME="${APP_NAME:-sync-room}"
PID_FILE="$ROOT_DIR/$APP_NAME.pid"

have() {
	command -v "$1" >/dev/null 2>&1
}

if have pm2; then
	pm2 stop "$APP_NAME" >/dev/null 2>&1 || true
	pm2 delete "$APP_NAME" >/dev/null 2>&1 || true
	pm2 save >/dev/null 2>&1 || true
fi

if [[ -f "$PID_FILE" ]]; then
	PID="$(cat "$PID_FILE" || true)"
	if [[ -n "$PID" ]] && kill -0 "$PID" >/dev/null 2>&1; then
		kill "$PID"
		echo "Stopped PID $PID"
	else
		echo "PID $PID not running"
	fi
	rm -f "$PID_FILE"
else
	echo "No pid file found"
fi
