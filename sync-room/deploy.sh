#!/usr/bin/env bash
set -euo pipefail

SCRIPT_PATH="${BASH_SOURCE[0]:-$0}"
APP_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
REPO_DIR="$(cd "$APP_DIR/.." && pwd)"
BRANCH="${BRANCH:-main}"
APP_NAME="${APP_NAME:-sync-room}"

log() {
	printf '\n[%s] %s\n' "$(date '+%H:%M:%S')" "$*"
}

have() {
	command -v "$1" >/dev/null 2>&1
}

if [[ ! -d "$REPO_DIR/.git" ]]; then
	echo "Git repository not found at $REPO_DIR" >&2
	exit 1
fi

if [[ ! -x "$APP_DIR/start.sh" ]]; then
	chmod +x "$APP_DIR/start.sh"
fi

if [[ -f "$APP_DIR/stop.sh" && ! -x "$APP_DIR/stop.sh" ]]; then
	chmod +x "$APP_DIR/stop.sh"
fi

log "[1/3] git pull"
cd "$REPO_DIR"
current_branch="$(git branch --show-current)"
if [[ "$current_branch" != "$BRANCH" ]]; then
	git checkout "$BRANCH"
fi
git pull --ff-only origin "$BRANCH"

chmod +x "$APP_DIR/start.sh" "$APP_DIR/stop.sh" "$APP_DIR/deploy.sh"

log "[2/3] restart app"
cd "$APP_DIR"
"$APP_DIR/start.sh"

log "[3/3] status"
if have pm2; then
	pm2 status "$APP_NAME"
else
	echo "PM2 not found; start.sh used local PID mode."
fi
