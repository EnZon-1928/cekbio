#!/data/data/com.termux/files/usr/bin/bash

set -Eeuo pipefail

REPOSITORY_URL="https://github.com/EnZon-1928/cekbio.git"
REPOSITORY_NAME="EnZon-1928/cekbio"
BRANCH="telegram_bot"
MIN_NODE_MAJOR=20

fail() {
    printf 'Error: %s\n' "$*" >&2
    exit 1
}

is_project_directory() {
    [[ -f "$1/package.json" && -f "$1/index.js" && -f "$1/core/local-service.js" ]] \
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
if ! command -v node >/dev/null 2>&1 \
    || ! node -e "process.exit(Number(process.versions.node.split('.')[0]) >= $MIN_NODE_MAJOR ? 0 : 1)" \
    || ! command -v npm >/dev/null 2>&1; then
    missing_packages+=(nodejs-lts)
fi

if ((${#missing_packages[@]})); then
    printf 'Installing missing Termux packages: %s\n' "${missing_packages[*]}"
    pkg update -y
    pkg install -y "${missing_packages[@]}"
else
    printf 'Termux prerequisites are already installed; skipping package installation.\n'
fi

command -v git >/dev/null 2>&1 || fail "Git installation did not complete."
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
            || fail "$PROJECT_DIR already exists but does not look like the Telegram cekbio branch. Keep any local data, then choose the telegram_bot branch or another directory."
    else
        printf 'Cloning the cekbio Telegram branch into %s...\n' "$PROJECT_DIR"
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
    printf 'Installing project dependencies. This can take several minutes...\n'
    GIT_CONFIG_COUNT=2 \
        GIT_CONFIG_KEY_0='url.https://github.com/.insteadOf' \
        GIT_CONFIG_VALUE_0='ssh://git@github.com/' \
        GIT_CONFIG_KEY_1='url.https://github.com/.insteadOf' \
        GIT_CONFIG_VALUE_1='git@github.com:' \
        npm install --no-audit --no-fund \
        || fail "Dependency installation failed. Review the npm error above, then retry this setup command."
fi

if [[ ! -f .env ]]; then
    [[ -f .env.example ]] || fail "The Telegram environment template .env.example is missing."
    umask 077
    cp .env.example .env
    printf 'Created a private .env file. Configure TELEGRAM_BOT_TOKEN and TELEGRAM_OWNER_ID before starting the bot.\n'
fi
chmod 600 .env

if ! grep -Eq '^TELEGRAM_BOT_TOKEN=.+$' .env \
    || ! grep -Eq '^TELEGRAM_OWNER_ID=[0-9]+$' .env; then
    printf '\nTelegram configuration is incomplete. Edit %s/.env without sharing it.\n' "$PROJECT_DIR"
    printf '1. Set TELEGRAM_BOT_TOKEN using the private token from @BotFather.\n'
    printf '2. Run "npm run telegram-id", send /myid to your bot in a private chat, then stop the helper with Ctrl+C.\n'
    printf '3. Set TELEGRAM_OWNER_ID to the numeric ID returned by the bot.\n'
    printf '4. Run "npm run local" from this project directory. Keep Termux open while scanning.\n'
    exit 0
fi

printf 'Starting cekbio Telegram bot. Press Ctrl+C to stop it.\n\n'
exec npm run local
