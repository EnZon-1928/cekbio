<div align="center">

# cekbio

**Run WhatsApp scans locally and manage them through a private Telegram bot.**

[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](#requirements-and-notes)
[![Android · Windows · Linux](https://img.shields.io/badge/Platforms-Android%20%7C%20Windows%20%7C%20Linux-3973a5)](#installation)
[![Local processing](https://img.shields.io/badge/Processing-Local-17825d)](#privacy-and-data)

</div>

cekbio is a Node.js application for scanning target lists with WhatsApp sender sessions. The application runs on your device; Telegram provides a private control interface. It does not expose a web dashboard or require a public inbound port.

## Contents

- [Quick start](#quick-start)
- [What the bot does](#what-the-bot-does)
- [Privacy and data](#privacy-and-data)
- [Installation](#installation)
- [Telegram configuration](#telegram-configuration)
- [Target workbooks](#target-workbooks)
- [Command-line interface](#command-line-interface)
- [Requirements and notes](#requirements-and-notes)

## Quick start

Choose the setup guide for your device:

| Platform | Guide |
| --- | --- |
| Android | [Termux quick setup](#android-termux-quick-setup) |
| Windows | [Windows installation](#windows) |
| Linux | [Linux installation](#linux) |

For Android, the setup script automates installation. Windows and Linux users can follow their platform guide and then complete [Telegram configuration](#telegram-configuration).

### Android: Termux quick setup

1. Install [Termux](https://github.com/termux/termux-app#installation) from an official source and open it.
2. Install `curl` if needed:

   ```sh
   pkg update
   pkg install -y curl
   ```

3. Run the setup script:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/EnZon-1928/cekbio/telegram_bot/scripts/setup-termux.sh | bash
   ```

4. Follow the displayed instructions to configure Telegram. Start the bot from `~/cekbio`:

   ```sh
   npm run local
   ```

> [!IMPORTANT]
> This command downloads and runs a setup script. Review [`scripts/setup-termux.sh`](./scripts/setup-termux.sh) before running it.

## What the bot does

The Telegram bot provides a button-based workflow:

1. **Senders** — add sender sessions and view their connection status.
2. **Targets** — select one target list from the main menu or upload a `.txt` or `.xlsx` file.
3. **Scan** — choose a batch size and checkpoint option, then monitor progress in Telegram.
4. **Results** — download result files or remove them with confirmation.
5. **Updates** — check the official `telegram_bot` branch, review whether an update is available, then confirm to install it and restart cekbio.

The Scan button uses the currently selected target and all sender sessions that connect successfully. When a scan completes, available result files appear as direct download buttons on the progress dashboard. Longer lists are paginated. Button labels show the category and target name with spaces, without the `.txt` extension; the underlying file names remain unchanged.

The bot keeps one control dashboard message per chat while running. Menu actions, progress, pairing status, upload feedback, and errors update that message. A requested result file is sent as a separate document. Scan and pairing status update automatically; there are no manual Refresh buttons.

Use `/start` to open the menu. The bot publishes `/start` and `/shutdown` as its slash commands; other operations are available from buttons. Sender health is checked on `/start` and when opening **Sender Sessions**. Removing a result requires confirmation and also removes its related checkpoint, if present. Shutting down requires confirmation, stops only the local cekbio process, and is refused while a scan or sender operation is active.

To update, choose **Check for updates** from the main menu. cekbio checks the official `EnZon-1928/cekbio` repository's `telegram_bot` branch, regardless of your GitHub account. An available update is applied only after you confirm; cekbio then restarts automatically. Updates are refused if you are on another branch, have tracked local changes, or a scan/sender operation is active. Keep target lists and other local data in place; the updater does not clean untracked files. If Git cannot safely fast-forward because a local file would be overwritten, the update stops and leaves that file untouched. If dependency installation fails after the code update, resolve the displayed dependency error, install dependencies with `npm install` from the project directory, and start cekbio again with `npm run local`.

Button colors indicate state: green means selected or active, red means inactive or destructive, and blue is used for standard actions and checks in progress. Exact shades depend on the Telegram app theme.

## Privacy and data

- Sender sessions, target lists, checkpoints, internal result data, and reports remain in the project directory.
- The bot accepts updates only from the configured Telegram user ID in a private chat.
- Target lists, internal `target_*` JSON files, and WhatsApp session credentials are not sent to Telegram.
- Result `.txt` files are sent only when you explicitly request a download.
- Keep `.env` and the application directory private. Never commit or share bot tokens, sender credentials, target lists, or scan results.
- Do not run multiple cekbio processes against the same sender session at the same time.
- On Android, keep Termux open during scans. Android may stop background processes to save battery.

## Installation

Install dependencies separately on each operating system. Do not reuse `node_modules` between Windows and WSL/Linux; native dependencies and paths are platform-specific.

### Windows

1. Install [Node.js 20 or newer](https://nodejs.org/en/download) and [Git for Windows](https://git-scm.com/download/win).
2. Open PowerShell and clone the `telegram_bot` branch:

   ```powershell
   Set-Location $HOME
   git clone --branch telegram_bot https://github.com/EnZon-1928/cekbio.git
   Set-Location .\cekbio
   git config --local --add url."https://github.com/".insteadOf "ssh://git@github.com/"
   git config --local --add url."https://github.com/".insteadOf "git@github.com:"
   npm install
   ```

3. Complete [Telegram configuration](#telegram-configuration), then run `npm run local`.

### Linux

1. Install Git, `curl`, and Node.js 20 or newer.
2. Clone the `telegram_bot` branch and install dependencies:

   ```sh
   git clone --branch telegram_bot https://github.com/EnZon-1928/cekbio.git
   cd cekbio
   git config --local --add url."https://github.com/".insteadOf "ssh://git@github.com/"
   git config --local --add url."https://github.com/".insteadOf "git@github.com:"
   npm install
   ```

3. Complete [Telegram configuration](#telegram-configuration), then run `npm run local`.

### Android: manual Termux installation

Use this method if you prefer to install cekbio without the quick setup script.

1. Install and open [Termux](https://github.com/termux/termux-app#installation).
2. Install Git and Node.js:

   ```sh
   pkg update
   pkg upgrade -y
   pkg install -y git nodejs-lts
   ```

3. Clone the `telegram_bot` branch into Termux's private home directory:

   ```sh
   cd "$HOME"
   git clone --branch telegram_bot https://github.com/EnZon-1928/cekbio.git
   cd cekbio
   git config --local --add url."https://github.com/".insteadOf "ssh://git@github.com/"
   git config --local --add url."https://github.com/".insteadOf "git@github.com:"
   npm install
   ```

4. Complete [Telegram configuration](#telegram-configuration), then run `npm run local`. Keep Termux open while scans are running.

## Telegram configuration

1. Create a bot with [@BotFather](https://t.me/BotFather) using `/newbot`. Keep the token private.
2. In the project directory, create `.env` from the example:

   **macOS, Linux, or Termux**

   ```sh
   cp .env.example .env
   ```

   **Windows PowerShell**

   ```powershell
   Copy-Item .env.example .env
   ```

3. Add the BotFather token as `TELEGRAM_BOT_TOKEN` in `.env`.
4. In a terminal in the project directory, start the temporary ID helper:

   ```sh
   npm run telegram-id
   ```

   Open a private chat with your bot and send `/myid`. Stop the helper with **Ctrl+C**, then add the numeric ID it reports as `TELEGRAM_OWNER_ID` in `.env`.
5. Start cekbio:

   ```sh
   npm run local
   ```

Keep the terminal or Termux session open while using the bot. Press **Ctrl+C** to stop the local application.

## Target workbooks

XLSX files are processed locally. cekbio reads all worksheets and cells, retains phone-number candidates with at least six digits in their original order (including duplicates), and converts them into a `.txt` target list. The uploaded workbook is not retained.

Uploads are limited to 10 MB and a combined worksheet range of one million cells per workbook. For reliable results, store long phone numbers and numbers with leading zeroes as text in Excel. Numeric cells may already have lost leading zeroes or precision before upload.

## Command-line interface

The interactive CLI remains available:

```sh
node index.js
```

Do not run the CLI and Telegram bot simultaneously with the same sender session.

## Requirements and notes

- Node.js 20 or newer and npm.
- Git is required to clone the project and install its Git-hosted dependencies.
- Configure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_ID` in a private `.env` file before running `npm run local`.
- Target uploads support `.txt` files and `.xlsx` workbooks up to 10 MB.
- Generated text result files use the `result_` prefix, for example `result_business_targets.txt`. Internal `target_*` JSON files remain on disk for recovery and are not listed in Telegram.
- Older `report_*.txt` files are left untouched and excluded from target discovery.
- Telegram scans use connected sender sessions as workers. A disconnected sender is excluded; unfinished batches are retried by remaining workers. If no workers remain, the scan saves a checkpoint.
- `npm run telegram-id` starts a temporary helper that reports your numeric Telegram user ID in the bot's private chat.
- Run `npm test` to execute the automated test suite.
- This `telegram_bot` branch does not include the web dashboard or HTTP API. The web version remains on `main`.
