<div align="center">

# cekbio

**Scan WhatsApp account lists locally and control cekbio through a private Telegram bot.**

[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](#requirements)
[![Platforms](https://img.shields.io/badge/Platforms-Android%20%7C%20Windows%20%7C%20Linux-3973a5)](#choose-your-platform)
[![Local only](https://img.shields.io/badge/Operation-Local%20only-17825d)](#your-data-stays-local)

</div>

## Get started

### Android with Termux

1. Install [Termux](https://github.com/termux/termux-app#installation) from an official source and open it.
2. Install curl if needed:

   ```sh
   pkg update
   pkg install -y curl
   ```

3. Run the Telegram setup helper:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/EnZon-1928/cekbio/telegram_bot/scripts/setup-termux.sh | bash
   ```

4. Follow the printed steps to configure the bot, then run `npm run local` from `~/cekbio`.

> [!IMPORTANT]
> This command downloads and runs the setup script. [Review the script](./scripts/setup-termux.sh) before running it.

### Choose your platform

| Platform | Start here |
| --- | --- |
| Android | [Termux quick setup](#android-with-termux) |
| Windows | [Windows setup](#windows) |
| Linux | [Linux setup](#linux) |

## How it works

**Senders** → **Scan** → **Results**

Add or select a sender session, choose a `.txt` target list, then review the generated results in your private Telegram chat. The bot runs locally on your device and uses Telegram long polling; it does not start a web server or require a public inbound port.

## Your data stays local

- Sender sessions, target lists, checkpoints, internal results, and reports stay in the project directory.
- The bot accepts commands only from the configured Telegram user ID in a private chat.
- The bot never sends target lists, internal `target_*` JSON data, or WhatsApp session credentials to Telegram.
- Keep `.env` and the application directory private. Do not commit or share bot tokens, sender credentials, target lists, or scan results.
- Do not run multiple cekbio processes against the same sender session at the same time.
- On Android, keep Termux open during a scan. Android may stop background processes to save battery.

## Configure Telegram

1. Create a bot with [@BotFather](https://t.me/BotFather) using `/newbot`. Keep the token private.
2. In the project directory, copy the example configuration:

   ```sh
   cp .env.example .env
   ```

   On PowerShell:

   ```powershell
   Copy-Item .env.example .env
   ```

3. Put the BotFather token in `TELEGRAM_BOT_TOKEN` in `.env`. Do not share this file.
4. Start the temporary ID helper:

   ```sh
   npm run telegram-id
   ```

   Open a private chat with your bot, send `/myid`, then stop the helper with **Ctrl+C**. Add the returned numeric ID as `TELEGRAM_OWNER_ID` in `.env`.
5. Start cekbio:

   ```sh
   npm run local
   ```

   Keep the terminal or Termux open while the bot is in use. Press **Ctrl+C** to stop the local application.

Use `/start` to open the button menu. The only slash commands shown by the bot are `/start` and `/shutdown`; other operations are available through the buttons. The menu focuses on **Senders**, **Scan**, and **Results**, followed by the **Targets** section and a **Shutdown** button at the bottom. While a scan is running, the Scan button opens its progress view. Standard actions use Telegram's blue button style; selected targets and active senders are green, while unselected targets, inactive senders, Remove, and Cancel are red. Checking senders remain blue until their status is known. Exact shades follow the Telegram app's theme. Choose **Upload Targets** before sending a `.txt` or `.xlsx` document. Select one target from the main menu; Scan uses that target and all sender sessions that connect successfully. Scan setup offers batch-size and checkpoint choices. Sender health checks run automatically, the Sender sessions view keeps the same status legend while refreshing, and sender deletion requires confirmation.

The bot keeps one control dashboard message per chat while the process is running. Menu navigation, scan progress, pairing status, upload feedback, validation messages, and errors update that dashboard instead of adding bot chat bubbles. Repeated `/start` updates the same dashboard; after restarting the local process, `/start` may create a new one. During pairing, the code appears on a copy button that copies the code alone. Scan and pairing status update automatically; there are no manual Refresh buttons. Scan progress keeps the overall summary and shows up to three sender details. User-sent messages remain in the chat, and a result file you explicitly request is sent as a separate document.

The **Shutdown** button asks for confirmation. Confirming removes the confirmation buttons and leaves a shutdown notice visible while the local application stops. Shutdown affects only the cekbio process, never the operating system, and is refused while a scan or sender operation is active.

The bot can explicitly send generated `result_*.txt` files to your private chat. It never sends target files, internal result JSON, or WhatsApp session data.

## Choose your platform

### Windows

1. Install [Node.js 20 or newer](https://nodejs.org/en/download) and [Git for Windows](https://git-scm.com/download/win).
2. Open PowerShell and clone the Telegram branch:

   ```powershell
   Set-Location $HOME
   git clone --branch telegram_bot https://github.com/EnZon-1928/cekbio.git
   Set-Location .\cekbio
   git config --local --add url."https://github.com/".insteadOf "ssh://git@github.com/"
   git config --local --add url."https://github.com/".insteadOf "git@github.com:"
   npm install
   ```

3. Configure Telegram as described in [Configure Telegram](#configure-telegram), then run `npm run local`.

Install dependencies in the Windows project directory. Do not reuse `node_modules` from WSL/Linux; native packages and paths are platform-specific.

### Linux

1. Install Git, curl, and Node.js 20 or newer.
2. Clone the Telegram branch and install dependencies:

   ```sh
   git clone --branch telegram_bot https://github.com/EnZon-1928/cekbio.git
   cd cekbio
   git config --local --add url."https://github.com/".insteadOf "ssh://git@github.com/"
   git config --local --add url."https://github.com/".insteadOf "git@github.com:"
   npm install
   ```

3. Configure Telegram as described in [Configure Telegram](#configure-telegram), then run `npm run local`.

### Android manual setup

1. Install and open [Termux](https://github.com/termux/termux-app#installation).
2. Install Git and Node.js:

   ```sh
   pkg update
   pkg upgrade -y
   pkg install -y git nodejs-lts
   ```

3. Clone the Telegram branch into Termux's private home and install dependencies:

   ```sh
   cd "$HOME"
   git clone --branch telegram_bot https://github.com/EnZon-1928/cekbio.git
   cd cekbio
   git config --local --add url."https://github.com/".insteadOf "ssh://git@github.com/"
   git config --local --add url."https://github.com/".insteadOf "git@github.com:"
   npm install
   ```

4. Configure Telegram as described in [Configure Telegram](#configure-telegram), then run `npm run local`. Keep Termux open during scans.

## Target workbooks

XLSX uploads are processed locally. cekbio reads all worksheets and cells, keeps phone-number candidates with at least six digits in their original order (including duplicates), and converts them into a `.txt` target list. The XLSX source is not retained. Files are limited to 10 MB and a combined worksheet range of one million cells per workbook. For reliable results, store long phone numbers and numbers with leading zeroes as text in Excel; numeric cells may already have lost leading zeroes or precision before upload.

## CLI

The interactive CLI remains available:

```sh
node index.js
```

Do not use the CLI and Telegram bot simultaneously with the same sender session.

## Requirements and behavior

- Node.js 20 or newer and npm.
- Git is required to clone the project and install its Git-hosted dependencies.
- Configure `TELEGRAM_BOT_TOKEN` and the numeric `TELEGRAM_OWNER_ID` in a private `.env` file before running `npm run local`.
- Target uploads may be `.txt` files or `.xlsx` workbooks up to 10 MB.
- New text result files use the `result_` prefix, for example `result_business_targets.txt`. Internal `target_*` JSON files remain on disk for recovery and are not shown in Telegram.
- Older `report_*.txt` files are left untouched and excluded from target discovery.
- Telegram scans use connected sender sessions as workers. A sender that disconnects is excluded, unfinished batches are retried by remaining workers, and the scan saves a checkpoint if no workers remain.
- `npm run telegram-id` starts a temporary helper that reports your numeric user ID to you in the bot's private chat.
- `npm test` runs the automated test suite.

The web dashboard and its HTTP API are not included in this branch. The web version remains on `main`.
