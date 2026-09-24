#!/usr/bin/env bash

set -u

BASE_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION="${1:-}"
PROFILE_ARG="${2:-}"

usage() {
    echo "Usage:"
    echo "  ./devspace-tunnelctl.sh probe   devspace-22"
    echo "  ./devspace-tunnelctl.sh start   devspace-22"
    echo "  ./devspace-tunnelctl.sh stop    devspace-22"
    echo "  ./devspace-tunnelctl.sh restart devspace-22"
    echo "  ./devspace-tunnelctl.sh status  devspace-22"
    echo "  ./devspace-tunnelctl.sh log     devspace-22"
    echo "  ./devspace-tunnelctl.sh ssh-log devspace-22"
    echo
    echo "Also supports:"
    echo "  ./devspace-tunnelctl.sh start devspace-22.env"
    exit 1
}

[[ -z "$ACTION" || -z "$PROFILE_ARG" ]] && usage

if [[ -f "$BASE_DIR/$PROFILE_ARG" ]]; then
    PROFILE_FILE="$BASE_DIR/$PROFILE_ARG"
elif [[ -f "$BASE_DIR/${PROFILE_ARG}.env" ]]; then
    PROFILE_FILE="$BASE_DIR/${PROFILE_ARG}.env"
else
    echo "ERROR: profile not found: $PROFILE_ARG"
    exit 1
fi

PROFILE="$(basename "$PROFILE_FILE")"
PROFILE="${PROFILE%.env}"

set -a
# shellcheck disable=SC1090
source "$PROFILE_FILE"
set +a

SSH_PORT="${SSH_PORT:-22}"
SSH_GROUP="${SSH_GROUP:-dev}"
SSH_AUTH_MODE="${SSH_AUTH_MODE:-password}"
MCP_PORT="${MCP_PORT:-3000}"
MCP_TOKEN="${MCP_TOKEN:-}"
SSH_PASSWORD="${SSH_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-}"
DEVSPACE_CONTROL_PLANE="${DEVSPACE_CONTROL_PLANE:-https://www.astmars.com}"
DEVSPACE_TUNNEL_TOKEN="${DEVSPACE_TUNNEL_TOKEN:-}"
TUNNEL_ID="${TUNNEL_ID:-}"
DEVSPACE_BROWSER="${DEVSPACE_BROWSER:-chrome}"
DEVSPACE_BROWSER_WATCHDOG_SECONDS="${DEVSPACE_BROWSER_WATCHDOG_SECONDS:-15}"
DEVSPACE_SSO_AUTO_APPROVE="${DEVSPACE_SSO_AUTO_APPROVE:-1}"
DEVSPACE_SSO_WAIT_SECONDS="${DEVSPACE_SSO_WAIT_SECONDS:-180}"
MCP_URL="${MCP_URL:-http://127.0.0.1:$MCP_PORT/}"

SSH_PID_FILE="$BASE_DIR/.$PROFILE.ssh-mcp.pid"
TUNNEL_PID_FILE="$BASE_DIR/.$PROFILE.browser-tunnel.pid"
SSH_LOG="$BASE_DIR/.$PROFILE.ssh-mcp.log"
TUNNEL_LOG="$BASE_DIR/.$PROFILE.browser-tunnel.log"
ENTRYPOINT="$BASE_DIR/bin/devspace-browser-tunnel.mjs"

if command -v cygpath >/dev/null 2>&1; then
    NODE_ENTRYPOINT="$(cygpath -w "$ENTRYPOINT")"
else
    NODE_ENTRYPOINT="$ENTRYPOINT"
fi

export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*'
export DEVSPACE_CONTROL_PLANE
export DEVSPACE_TUNNEL_TOKEN
export TUNNEL_ID
export DEVSPACE_BROWSER
export DEVSPACE_BROWSER_WATCHDOG_SECONDS
export DEVSPACE_SSO_AUTO_APPROVE
export DEVSPACE_SSO_WAIT_SECONDS
export MCP_URL
export MCP_TOKEN

is_running() {
    local pid_file="$1"
    [[ -f "$pid_file" ]] || return 1
    local pid
    pid="$(cat "$pid_file")"
    kill -0 "$pid" 2>/dev/null
}

cleanup_stale_pid() {
    local pid_file="$1"
    if [[ -f "$pid_file" ]] && ! is_running "$pid_file"; then
        rm -f "$pid_file"
    fi
}

check_config() {
    local missing=0

    for name in SSH_HOST SSH_USER WORKDIR TUNNEL_ID DEVSPACE_CONTROL_PLANE DEVSPACE_TUNNEL_TOKEN
    do
        if [[ -z "${!name:-}" ]]; then
            echo "ERROR: $name is empty"
            missing=1
        fi
    done

    [[ "$missing" == "1" ]] && exit 1

    case "$SSH_GROUP" in
        dev|staging|prod) ;;
        *)
            echo "ERROR: SSH_GROUP must be: dev / staging / prod"
            exit 1
            ;;
    esac

    case "$SSH_AUTH_MODE" in
        password|key|auto|agent) ;;
        *)
            echo "ERROR: SSH_AUTH_MODE must be: password / key / auto / agent"
            exit 1
            ;;
    esac
}

require_runtime() {
    if ! command -v ssh-mcp >/dev/null 2>&1; then
        echo "ERROR: ssh-mcp was not found in PATH"
        exit 1
    fi
    if ! command -v node >/dev/null 2>&1; then
        echo "ERROR: node was not found in PATH"
        exit 1
    fi
    if [[ ! -d "$BASE_DIR/node_modules/playwright-core" ]]; then
        echo "ERROR: browser-tunnel dependencies are not installed"
        echo "Run: cd '$BASE_DIR' && npm ci"
        exit 1
    fi
}

build_ssh_args() {
    SSH_ARGS=(
        "--host=$SSH_HOST"
        "--port=$SSH_PORT"
        "--user=$SSH_USER"
        "--workdir=$WORKDIR"
        "--group=$SSH_GROUP"
        "--transport=http"
        "--maxChars=none"
        "--httpPort=$MCP_PORT"
    )

    if [[ -n "$MCP_TOKEN" ]]; then
        SSH_ARGS+=("--bearerToken=$MCP_TOKEN")
    fi

    case "$SSH_AUTH_MODE" in
        password)
            if [[ -z "$SSH_PASSWORD" ]]; then
                echo "ERROR: SSH_PASSWORD is empty"
                exit 1
            fi
            export SSH_MCP_PASSWORD="$SSH_PASSWORD"
            ;;
        key)
            if [[ -z "$SSH_KEY" ]]; then
                echo "ERROR: SSH_KEY is empty"
                exit 1
            fi
            unset SSH_MCP_PASSWORD 2>/dev/null || true
            SSH_ARGS+=("--key=$SSH_KEY")
            ;;
        auto|agent)
            unset SSH_MCP_PASSWORD 2>/dev/null || true
            ;;
    esac
}

start_ssh_mcp() {
    cleanup_stale_pid "$SSH_PID_FILE"

    if is_running "$SSH_PID_FILE"; then
        echo "ssh-mcp already running"
        echo "PID=$(cat "$SSH_PID_FILE")"
        return 1
    fi

    build_ssh_args

    echo "Starting ssh-mcp [$PROFILE] ..."
    nohup ssh-mcp "${SSH_ARGS[@]}" > "$SSH_LOG" 2>&1 &
    SSH_PID=$!
    echo "$SSH_PID" > "$SSH_PID_FILE"

    sleep 2
    if ! is_running "$SSH_PID_FILE"; then
        echo "ERROR: ssh-mcp failed to start"
        echo
        tail -30 "$SSH_LOG"
        rm -f "$SSH_PID_FILE"
        return 1
    fi

    echo "ssh-mcp started PID=$SSH_PID"
}

start_browser_tunnel() {
    cleanup_stale_pid "$TUNNEL_PID_FILE"

    if is_running "$TUNNEL_PID_FILE"; then
        echo "browser-tunnel already running"
        echo "PID=$(cat "$TUNNEL_PID_FILE")"
        return 1
    fi

    : > "$TUNNEL_LOG"

    echo "Starting browser-tunnel [$PROFILE] ..."
    echo "Control plane: $DEVSPACE_CONTROL_PLANE"
    echo "Tunnel ID: $TUNNEL_ID"
    echo "Local MCP: $MCP_URL"
    echo "Browser: $DEVSPACE_BROWSER"
    echo "Browser watchdog: ${DEVSPACE_BROWSER_WATCHDOG_SECONDS}s"

    nohup node "$NODE_ENTRYPOINT" > "$TUNNEL_LOG" 2>&1 < /dev/null &
    TUNNEL_PID=$!
    echo "$TUNNEL_PID" > "$TUNNEL_PID_FILE"

    sleep 2
    if ! is_running "$TUNNEL_PID_FILE"; then
        echo "ERROR: browser-tunnel failed to start"
        echo
        tail -50 "$TUNNEL_LOG"
        rm -f "$TUNNEL_PID_FILE"
        return 1
    fi

    echo "browser-tunnel started PID=$TUNNEL_PID"
    echo "A Chrome/Edge window may require enterprise SSO approval."
}

start_service() {
    check_config
    require_runtime

    cleanup_stale_pid "$SSH_PID_FILE"
    cleanup_stale_pid "$TUNNEL_PID_FILE"

    if is_running "$SSH_PID_FILE"; then
        echo "ssh-mcp already running"
        echo "PID=$(cat "$SSH_PID_FILE")"
        exit 1
    fi

    if is_running "$TUNNEL_PID_FILE"; then
        echo "browser-tunnel already running"
        echo "PID=$(cat "$TUNNEL_PID_FILE")"
        exit 1
    fi

    rm -f "$SSH_PID_FILE" "$TUNNEL_PID_FILE"

    if ! start_ssh_mcp; then
        exit 1
    fi

    if ! start_browser_tunnel; then
        stop_process "$SSH_PID_FILE" "ssh-mcp"
        exit 1
    fi

    echo
    echo "================================="
    echo "Started: $PROFILE"
    echo "================================="
    echo "SSH: $SSH_USER@$SSH_HOST:$SSH_PORT"
    echo "Workdir: $WORKDIR"
    echo "DevSpace control plane: $DEVSPACE_CONTROL_PLANE"
    echo "Tunnel ID: $TUNNEL_ID"
    echo "ssh-mcp PID: $(cat "$SSH_PID_FILE")"
    echo "Browser tunnel PID: $(cat "$TUNNEL_PID_FILE")"
    echo "MCP health: http://127.0.0.1:$MCP_PORT/health"
    echo "Browser tunnel log: $TUNNEL_LOG"
}

probe_service() {
    check_config
    require_runtime

    echo "Probe profile: $PROFILE"
    echo "DevSpace control plane: $DEVSPACE_CONTROL_PLANE"
    echo "Tunnel ID: $TUNNEL_ID"
    echo "Browser: $DEVSPACE_BROWSER"
    echo
    exec node "$NODE_ENTRYPOINT" --probe-only
}

stop_process() {
    local pid_file="$1"
    local name="$2"

    if [[ ! -f "$pid_file" ]]; then
        echo "$name: stopped"
        return
    fi

    local pid
    pid="$(cat "$pid_file")"

    if kill -0 "$pid" 2>/dev/null; then
        echo "Stopping $name PID=$pid ..."
        kill "$pid" 2>/dev/null || true

        for _ in {1..25}; do
            if ! kill -0 "$pid" 2>/dev/null; then
                break
            fi
            sleep 0.2
        done

        if kill -0 "$pid" 2>/dev/null; then
            echo "Force stopping $name ..."
            kill -9 "$pid" 2>/dev/null || true
        fi
    else
        echo "$name: stale PID $pid"
    fi

    rm -f "$pid_file"
}

stop_service() {
    stop_process "$TUNNEL_PID_FILE" "browser-tunnel"
    stop_process "$SSH_PID_FILE" "ssh-mcp"
    echo
    echo "Stopped: $PROFILE"
}

status_service() {
    cleanup_stale_pid "$SSH_PID_FILE"
    cleanup_stale_pid "$TUNNEL_PID_FILE"

    echo "Profile: $PROFILE"
    echo "DevSpace control plane: $DEVSPACE_CONTROL_PLANE"
    echo "Tunnel ID: $TUNNEL_ID"
    echo

    if is_running "$SSH_PID_FILE"; then
        echo "ssh-mcp: RUNNING PID=$(cat "$SSH_PID_FILE")"
        echo -n "  health: "
        curl -fsS "http://127.0.0.1:$MCP_PORT/health" 2>/dev/null || echo "unavailable"
        echo
    else
        echo "ssh-mcp: STOPPED"
    fi

    echo

    if is_running "$TUNNEL_PID_FILE"; then
        echo "browser-tunnel: RUNNING PID=$(cat "$TUNNEL_PID_FILE")"
        echo "  watchdog: ${DEVSPACE_BROWSER_WATCHDOG_SECONDS}s"
        echo "  log: $TUNNEL_LOG"
    else
        echo "browser-tunnel: STOPPED"
    fi
}

show_log() {
    local which="$1"
    local file
    case "$which" in
        tunnel) file="$TUNNEL_LOG" ;;
        ssh) file="$SSH_LOG" ;;
        *) return 1 ;;
    esac

    if [[ ! -f "$file" ]]; then
        echo "No log file yet: $file"
        exit 1
    fi
    tail -n 100 -f "$file"
}

case "$ACTION" in
    probe) probe_service ;;
    start) start_service ;;
    stop) stop_service ;;
    restart)
        stop_service
        sleep 1
        start_service
        ;;
    status) status_service ;;
    log|logs) show_log tunnel ;;
    ssh-log) show_log ssh ;;
    *) usage ;;
esac
