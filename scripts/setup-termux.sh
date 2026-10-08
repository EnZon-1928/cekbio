#!/data/data/com.termux/files/usr/bin/bash

set -Eeuo pipefail

REPOSITORY_URL="https://github.com/EnZon-1928/cekbio.git"
REPOSITORY_NAME="EnZon-1928/cekbio"
BRANCH="main"
MIN_NODE_MAJOR=20

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

is_project_directory() {
    [[ -f "$1/package.json" && -f "$1/index.js" && -f "$1/web/server.js" ]] \
        && grep -Eq '"name"[[:space:]]*:[[:space:]]*"cekbio"' "$1/package.json"
}

is_expected_repository() {
    local remote
    remote="$(git -C "$1" remote get-url origin 2>/dev/null)" || return 1
    [[ "$remote" == "https://github.com/$REPOSITORY_NAME.git" \
        || "$remote" == "https://github.com/$REPOSITORY_NAME" \
        || "$remote" == "git@github.com:$REPOSITORY_NAME.git" \
        || "$remote" == "ssh://git@github.com/$REPOSITORY_NAME.git" ]]
}

[[ "${PREFIX:-}" == */com.termux/files/usr ]] \
    || fail "This setup script must run inside Termux on Android."
command -v pkg >/dev/null 2>&1 || fail "Termux package manager 'pkg' is unavailable."
command -v bash >/dev/null 2>&1 || fail "Bash is required to run this setup script."

missing_packages=()
if ! command -v git >/dev/null 2>&1; then
    missing_packages+=(git)
fi
if ! command -v curl >/dev/null 2>&1; then
    missing_packages+=(curl)
fi
if ! command -v node >/dev/null 2>&1 \
    || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= $MIN_NODE_MAJOR ? 0 : 1)" \
    || ! command -v npm >/dev/null 2>&1; then
    missing_packages+=(nodejs-lts)
fi
if ! command -v termux-open-url >/dev/null 2>&1; then
    missing_packages+=(termux-tools)
fi

if ((${#missing_packages[@]})); then
    printf 'Installing missing Termux packages: %s\n' "${missing_packages[*]}"
    pkg update -y
    pkg install -y "${missing_packages[@]}"
else
    printf 'Termux prerequisites are already installed; skipping package installation.\n'
fi

command -v git >/dev/null 2>&1 || fail "Git installation did not complete."
command -v curl >/dev/null 2>&1 || fail "curl installation did not complete."
command -v node >/dev/null 2>&1 || fail "Node.js installation did not complete."
command -v npm >/dev/null 2>&1 || fail "npm is unavailable after Node.js installation."
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= $MIN_NODE_MAJOR ? 0 : 1)" \
    || fail "Node.js $MIN_NODE_MAJOR or newer is required."

HOME_DIR="$(cd "$HOME" && pwd -P)"
CURRENT_DIR="$(pwd -P)"
PROJECT_DIR=""
case "$CURRENT_DIR/" in
    "$HOME_DIR/"*)
        if is_project_directory "$CURRENT_DIR"; then
            PROJECT_DIR="$CURRENT_DIR"
        fi
        ;;
esac

if [[ -z "$PROJECT_DIR" ]]; then
    PROJECT_DIR="$HOME_DIR/cekbio"
    if [[ -e "$PROJECT_DIR" ]]; then
        is_project_directory "$PROJECT_DIR" \
            || fail "$PROJECT_DIR already exists but does not look like cekbio. Move it or choose another directory before running setup."
    else
        printf 'Cloning cekbio into %s...\n' "$PROJECT_DIR"
        git clone --depth 1 --branch "$BRANCH" "$REPOSITORY_URL" "$PROJECT_DIR" \
            || fail "Could not clone cekbio. Check your internet connection and try again."
    fi
fi

if [[ -d "$PROJECT_DIR/.git" ]] && ! is_expected_repository "$PROJECT_DIR"; then
    fail "$PROJECT_DIR is a Git repository, but its origin is not the expected cekbio repository."
fi

PROJECT_DIR="$(cd "$PROJECT_DIR" && pwd -P)"
case "$PROJECT_DIR/" in
    "$HOME_DIR/"*) ;;
    *) fail "Keep the project under Termux's private home directory, not shared storage." ;;
esac

cd "$PROJECT_DIR"
printf 'Using project directory: %s\n' "$PROJECT_DIR"

if npm ls --depth=0 >/dev/null 2>&1; then
    printf 'Project dependencies are already installed; skipping npm install.\n'
else
    printf 'Installing missing project dependencies. This can take several minutes...\n'
    GIT_CONFIG_COUNT=2 \
        GIT_CONFIG_KEY_0='url.https://github.com/.insteadOf' \
        GIT_CONFIG_VALUE_0='ssh://git@github.com/' \
        GIT_CONFIG_KEY_1='url.https://github.com/.insteadOf' \
        GIT_CONFIG_VALUE_1='git@github.com:' \
        npm install --no-audit --no-fund \
        || fail "Dependency installation failed. Review the npm error above, then retry this setup command."
fi

PORT="${PORT:-3000}"
[[ "$PORT" =~ ^[0-9]{1,5}$ ]] \
    || fail "PORT must be a number between 1 and 65535."
PORT_NUMBER=$((10#$PORT))
((PORT_NUMBER >= 1 && PORT_NUMBER <= 65535)) \
    || fail "PORT must be a number between 1 and 65535."
PORT="$PORT_NUMBER"
URL="http://127.0.0.1:$PORT"

open_dashboard() {
    if command -v termux-open-url >/dev/null 2>&1 \
        && termux-open-url "$URL" >/dev/null 2>&1; then
        return 0
    fi
    if command -v am >/dev/null 2>&1 \
        && am start -a android.intent.action.VIEW -d "$URL" >/dev/null 2>&1; then
        return 0
    fi
    return 1
}

if curl --silent --show-error --fail --max-time 2 "$URL/api/status" 2>/dev/null \
    | grep -Eq '"scan"|"sender"'; then
    printf 'A cekbio web server is already responding at %s; not starting a duplicate.\n' "$URL"
    open_dashboard || printf 'Open this URL manually in your browser: %s\n' "$URL"
    exit 0
fi

LOG_FILE="$(mktemp "${TMPDIR:-$PREFIX/tmp}/cekbio-web.XXXXXX")" \
    || fail "Could not create a temporary server log."
chmod 600 "$LOG_FILE"
SERVER_PID=""
LOG_PID=""

cleanup() {
    local exit_status=$?
    trap - EXIT INT TERM

    if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
        kill -INT "$SERVER_PID" 2>/dev/null || true
        wait "$SERVER_PID" 2>/dev/null || true
    fi
    if [[ -n "$LOG_PID" ]] && kill -0 "$LOG_PID" 2>/dev/null; then
        kill "$LOG_PID" 2>/dev/null || true
        wait "$LOG_PID" 2>/dev/null || true
    fi
    rm -f "$LOG_FILE"
    exit "$exit_status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

node index.js web >"$LOG_FILE" 2>&1 &
SERVER_PID=$!

printf 'Starting the cekbio web server...'
ready=false
for _ in {1..30}; do
    if curl --silent --fail --max-time 1 "$URL/api/status" 2>/dev/null \
        | grep -Eq '"scan"|"sender"'; then
        ready=true
        break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
        break
    fi
    sleep 1
    printf '.'
done
printf '\n'

if [[ "$ready" != true ]]; then
    printf 'The web server did not become ready. Server output:\n' >&2
    cat "$LOG_FILE" >&2
    fail "Check whether port $PORT is already in use. You can retry with PORT=3001."
fi

printf 'Dashboard is available at %s\n' "$URL"
if open_dashboard; then
    printf 'Opening the default Android browser. Keep Termux open while using cekbio.\n'
else
    printf 'Could not open a browser automatically. Open this URL manually: %s\n' "$URL"
fi
printf 'Press Ctrl+C in Termux to stop the server.\n\n'

tail -n +1 -f "$LOG_FILE" &
LOG_PID=$!

wait "$SERVER_PID"
