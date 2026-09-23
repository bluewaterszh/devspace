#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION="${1:-}"
INSTANCE="${2:-}"

usage() {
  cat <<'EOF'
Usage:
  ./devspace-tunnelctl.sh probe   <instance>
  ./devspace-tunnelctl.sh start   <instance>
  ./devspace-tunnelctl.sh stop    <instance>
  ./devspace-tunnelctl.sh restart <instance>
  ./devspace-tunnelctl.sh status  <instance>
  ./devspace-tunnelctl.sh log     <instance>

Example:
  ./devspace-tunnelctl.sh probe devspace-22
  ./devspace-tunnelctl.sh start devspace-22

The instance uses:
  <instance>.env
  .<instance>.browser-tunnel.pid
  .<instance>.browser-tunnel.log
EOF
}

if [[ -z "$ACTION" || -z "$INSTANCE" ]]; then
  usage
  exit 2
fi

case "$INSTANCE" in
  *[!A-Za-z0-9._-]*)
    echo "Invalid instance name: $INSTANCE" >&2
    exit 2
    ;;
esac

ENV_FILE="$SCRIPT_DIR/$INSTANCE.env"
PID_FILE="$SCRIPT_DIR/.$INSTANCE.browser-tunnel.pid"
LOG_FILE="$SCRIPT_DIR/.$INSTANCE.browser-tunnel.log"
ENTRYPOINT="$SCRIPT_DIR/bin/devspace-browser-tunnel.mjs"

load_env() {
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "Missing env file: $ENV_FILE" >&2
    echo "Create it from: $SCRIPT_DIR/devspace.env.example" >&2
    exit 2
  fi

  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a

  : "${DEVSPACE_CONTROL_PLANE:=https://www.astmars.com}"
  : "${MCP_URL:=http://127.0.0.1:3010/}"
  : "${DEVSPACE_BROWSER:=chrome}"
  : "${DEVSPACE_SSO_WAIT_SECONDS:=180}"

  if [[ -z "${DEVSPACE_TUNNEL_TOKEN:-}" ]]; then
    echo "DEVSPACE_TUNNEL_TOKEN is missing in $ENV_FILE" >&2
    exit 2
  fi
  if [[ -z "${TUNNEL_ID:-}" ]]; then
    echo "TUNNEL_ID is missing in $ENV_FILE" >&2
    exit 2
  fi
}

require_runtime() {
  if ! command -v node >/dev/null 2>&1; then
    echo "node was not found in PATH" >&2
    exit 2
  fi
  if [[ ! -d "$SCRIPT_DIR/node_modules/playwright-core" ]]; then
    echo "Dependencies are not installed." >&2
    echo "Run: cd '$SCRIPT_DIR' && npm install" >&2
    exit 2
  fi
}

read_pid() {
  if [[ -f "$PID_FILE" ]]; then
    tr -d '\r\n ' < "$PID_FILE"
  fi
}

is_running() {
  local pid
  pid="$(read_pid)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

cleanup_stale_pid() {
  if [[ -f "$PID_FILE" ]] && ! is_running; then
    rm -f "$PID_FILE"
  fi
}

probe() {
  load_env
  require_runtime

  echo "Probe instance: $INSTANCE"
  echo "Control plane: $DEVSPACE_CONTROL_PLANE"
  echo "Tunnel ID: $TUNNEL_ID"
  echo "MCP: $MCP_URL"
  echo "Browser: $DEVSPACE_BROWSER"
  echo "Proxy: ${HTTPS_PROXY:-${HTTP_PROXY:-system/default}}"
  echo

  exec node "$ENTRYPOINT" --probe-only
}

start() {
  load_env
  require_runtime
  cleanup_stale_pid

  if is_running; then
    echo "$INSTANCE is already running (pid=$(read_pid))"
    return 0
  fi

  : > "$LOG_FILE"

  echo "Starting $INSTANCE ..."
  nohup node "$ENTRYPOINT" >>"$LOG_FILE" 2>&1 < /dev/null &
  local pid=$!
  echo "$pid" > "$PID_FILE"

  sleep 1
  if ! kill -0 "$pid" 2>/dev/null; then
    echo "$INSTANCE failed to start. Last log lines:" >&2
    tail -n 80 "$LOG_FILE" >&2 || true
    rm -f "$PID_FILE"
    return 1
  fi

  echo "$INSTANCE started (pid=$pid)"
  echo "log: $LOG_FILE"
  echo "A browser window may appear for enterprise SSO/approval."
}

stop() {
  cleanup_stale_pid
  if ! is_running; then
    echo "$INSTANCE is not running"
    rm -f "$PID_FILE"
    return 0
  fi

  local pid
  pid="$(read_pid)"
  echo "Stopping $INSTANCE (pid=$pid) ..."
  kill "$pid" 2>/dev/null || true

  for _ in {1..50}; do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$PID_FILE"
      echo "$INSTANCE stopped"
      return 0
    fi
    sleep 0.1
  done

  echo "$INSTANCE did not exit in 5s; forcing stop ..."
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$PID_FILE"
  echo "$INSTANCE stopped"
}

status() {
  cleanup_stale_pid
  if is_running; then
    echo "$INSTANCE: RUNNING pid=$(read_pid)"
    echo "log: $LOG_FILE"
  else
    echo "$INSTANCE: STOPPED"
    [[ -f "$LOG_FILE" ]] && echo "log: $LOG_FILE"
    return 1
  fi
}

show_log() {
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "No log file yet: $LOG_FILE" >&2
    exit 1
  fi
  tail -n 100 -f "$LOG_FILE"
}

case "$ACTION" in
  probe)
    probe
    ;;
  start)
    start
    ;;
  stop)
    stop
    ;;
  restart)
    stop
    start
    ;;
  status)
    status
    ;;
  log|logs)
    show_log
    ;;
  *)
    usage
    exit 2
    ;;
esac
