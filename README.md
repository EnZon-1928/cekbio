<div align="center">

# cekbio

**Scan WhatsApp account lists from a simple, local web dashboard.**

Manage sender sessions, scan target lists, and review results from your own device.

[![Node.js 20+](https://img.shields.io/badge/Node.js-20%2B-339933?logo=nodedotjs&logoColor=white)](#requirements-and-behavior)
[![Android, Windows, Linux](https://img.shields.io/badge/Platforms-Android%20%7C%20Windows%20%7C%20Linux-3973a5)](#choose-your-platform)
[![Local only](https://img.shields.io/badge/Operation-Local%20only-17825d)](#your-data-stays-local)

</div>

## 🚀 Get started

### Android

1. Install [Termux](https://github.com/termux/termux-app#installation) from one of its official sources. Install and update Termux from the same source.
2. Open Termux. If `curl` is not available, install it first:

   ```sh
   pkg update
   pkg install -y curl
   ```

3. Run the setup command:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/EnZon-1928/cekbio/main/scripts/setup-termux.sh | bash
   ```

4. The setup checks and installs missing requirements, downloads cekbio, installs dependencies, starts the dashboard, and asks Android to open your default browser. Keep Termux open while using cekbio.

> [!IMPORTANT]
> This command downloads and executes the setup script. [Review the script](./scripts/setup-termux.sh) before running it if you want to inspect its actions.

### Choose your platform

| Platform | Start here |
| --- | --- |
| 📱 Android | [Termux quick setup](#android) · [Manual steps](#android-manual-setup) |
| 🪟 Windows | [Manual setup](#windows-manual-setup) |
| 🐧 Linux | [Manual setup](#linux-manual-setup) |

## 🧭 How it works

**Senders** → **Scan** → **Results**

Add or select a sender session, choose a `.txt` target list, then review the generated results in the dashboard.

## 🔒 Your data stays local

- Sender sessions, target lists, checkpoints, and results are stored in the application directory on your device.
- The web server listens on `127.0.0.1` and is intended for use from the same device. Do not expose it through a public proxy, tunnel, or port forwarding.
- Keep the application directory private. It contains WhatsApp session credentials and scan data.
- On Android, keep Termux open during a scan. Android may stop background processes to save battery; battery settings and wake locks cannot guarantee that it will keep running.

## 📖 Manual setup

<details>
<summary>📱 Android with Termux</summary>

### Android manual setup

1. Install and open [Termux](https://github.com/termux/termux-app#installation). No root access or shared-storage permission is required.
2. Update Termux and install Git, Node.js, and curl:

   ```sh
   pkg update
   pkg upgrade -y
   pkg install -y git nodejs-lts curl
   ```

3. Check the installed tools. Node.js 20 or newer is required:

   ```sh
   node --version
   npm --version
   git --version
   ```

4. Clone cekbio into Termux's private home directory. Do not put the project in shared storage:

   ```sh
   cd "$HOME"
   git clone https://github.com/EnZon-1928/cekbio.git
   cd cekbio
   git config --local --add url."https://github.com/".insteadOf "ssh://git@github.com/"
   git config --local --add url."https://github.com/".insteadOf "git@github.com:"
   ```

   These repository-local Git settings let Git fetch public GitHub dependencies over HTTPS without an SSH key. They do not change your global Git configuration.

5. Install dependencies and run cekbio:

   ```sh
   npm install
   npm run web
   ```

6. Open `http://127.0.0.1:3000` in a browser on the same phone. Keep Termux open and press **Ctrl+C** in Termux when you want to stop the server.

</details>

<details>
<summary>🐧 Linux</summary>

### Linux manual setup

The commands below use Debian/Ubuntu. For another distribution, use its package manager to install Git and curl.

1. Install Git and curl:

   ```sh
   sudo apt update
   sudo apt install -y git curl
   ```

2. Install [nvm](https://github.com/nvm-sh/nvm) and Node.js LTS (Node.js 20 or newer is required):

   ```sh
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
   export NVM_DIR="$HOME/.nvm"
   . "$NVM_DIR/nvm.sh"
   nvm install --lts
   node --version
   npm --version
   git --version
   ```

3. Clone the project, configure Git to fetch public GitHub dependencies over HTTPS, and install dependencies:

   ```sh
   git clone https://github.com/EnZon-1928/cekbio.git
   cd cekbio
   git config --local --add url."https://github.com/".insteadOf "ssh://git@github.com/"
   git config --local --add url."https://github.com/".insteadOf "git@github.com:"
   npm install
   ```

4. Start cekbio and open the local URL:

   ```sh
   npm run web
   ```

   Open `http://127.0.0.1:3000` in a browser on the same computer. Press **Ctrl+C** in the terminal to stop the server.

</details>

<details>
<summary>🪟 Windows</summary>

### Windows manual setup

1. Install [Node.js 20 or newer](https://nodejs.org/en/download) and [Git for Windows](https://git-scm.com/download/win).
2. Open PowerShell and check the tools:

   ```powershell
   node --version
   npm --version
   git --version
   ```

3. Clone the project, configure Git to fetch public GitHub dependencies over HTTPS, and install dependencies:

   ```powershell
   Set-Location $HOME
   git clone https://github.com/EnZon-1928/cekbio.git
   Set-Location .\cekbio
   git config --local --add url."https://github.com/".insteadOf "ssh://git@github.com/"
   git config --local --add url."https://github.com/".insteadOf "git@github.com:"
   npm install
   ```

   Install dependencies in this Windows project directory. Do not reuse `node_modules` from WSL/Linux; native packages and paths are platform-specific.

4. Start cekbio:

   ```powershell
   npm run web
   ```

   Open `http://127.0.0.1:3000` in a browser on the same computer. Press **Ctrl+C** in PowerShell to stop the server.

</details>

## 🖥️ Using the dashboard

The dashboard has three sections:

- **Senders** — add a sender and manage its local session.
- **Scan** — upload or select a `.txt` target list or `.xlsx` workbook, select a sender, configure batch size, and monitor progress.
- **Results** — search, filter, download, or remove generated results. Only categories with findings are listed.

XLSX uploads are processed locally. cekbio reads all worksheets and cells, keeps phone-number candidates with at least six digits in their original order (including duplicates), and converts them into a `.txt` target list. The XLSX source is not retained. Files are limited to 10 MB and a combined worksheet range of one million cells per workbook. For reliable results, store long phone numbers and numbers with leading zeroes as text in Excel; numeric cells may already have lost leading zeroes or precision before upload.

The existing CLI remains available:

```sh
node index.js
```

Use the CLI separately from the web dashboard. The optional Telegram bot runs in the same process as the dashboard; do not open the same sender session from another cekbio process at the same time.

### Optional Telegram control (Windows)

The Telegram bot can run alongside the dashboard on the same Windows Node.js process. It uses long polling, so no public inbound port is needed. Keep the computer awake and connected to the internet while you want the bot available.

1. Create a bot with [@BotFather](https://t.me/BotFather) using `/newbot`. Keep its token private.
2. In the project directory, create a private `.env` file from the example and enter the bot token:

   ```powershell
   Copy-Item .env.example .env
   notepad .env
   ```

3. In `.env`, set `TELEGRAM_BOT_TOKEN` to the token from BotFather. Save the file, then run the temporary ID helper:

   ```powershell
   npm run telegram-id
   ```

   Open your bot's private chat and send `/myid`. Copy the numeric ID returned in the chat, stop the helper with **Ctrl+C**, and add that value as `TELEGRAM_OWNER_ID` in `.env`.

4. Start the dashboard and Telegram bot together:

   ```powershell
   npm run local
   ```

   Open the local dashboard at `http://127.0.0.1:3000`. In your private Telegram chat, send `/start` or `/help` to open the button menu. The menu shows **Status**, **Senders**, **Scan**, and **Results**, followed by a **Targets** section with **Upload Targets** and one button per available target. Send a `.txt` or `.xlsx` document to the chat after choosing **Upload Targets**; the menu refreshes to show the uploaded list. Select one target to mark it active. **Scan** uses that target by default, and you can still choose a different one there. The active selection lasts until the bot restarts. Scan setup also offers sender, batch-size, and checkpoint choices with Back/Cancel buttons. You can still use slash commands. While pairing is in progress, **Status** updates automatically; use **Copy code** to copy only the pairing code. The code is hidden once pairing is complete.

The bot accepts commands only from the configured Telegram user ID in a private chat; group chats and all other users are ignored. It can manage sender sessions, start scans, and explicitly send generated `result_*.txt` files to your Telegram chat. It never sends target lists, internal `target_*.json` data, or WhatsApp session credentials. Keep `.env` private and do not send its contents to anyone or commit it. Use `npm run web` if you want to run only the dashboard.

## 🛠️ Troubleshooting

<details>
<summary>The dashboard did not open in my browser</summary>

Keep the terminal running, then open `http://127.0.0.1:3000` manually in a browser on the same device.

</details>

<details>
<summary>The server says the port is already in use</summary>

Stop the other cekbio process with **Ctrl+C**, or start cekbio on a different port:

```sh
PORT=3001 npm run web
```

For the Android setup script, use:

```sh
PORT=3001 bash <(curl -fsSL https://raw.githubusercontent.com/EnZon-1928/cekbio/main/scripts/setup-termux.sh)
```

Then open `http://127.0.0.1:3001`.

</details>

<details>
<summary>Dependency installation failed</summary>

Confirm that the device has an internet connection and Git is installed, then retry `npm install` from the cekbio project directory. On Windows, run it in the Windows directory, not from WSL.

</details>

<details>
<summary>Android stopped the scan or server</summary>

Android may stop Termux when it is in the background or under battery pressure. Keep Termux open during scans and, if available, allow unrestricted battery use for Termux. If the process has stopped, reopen Termux and start cekbio again.

</details>

## ⚙️ Requirements and behavior

- Node.js 20 or newer and npm.
- Git is required to clone the project and install its Git-hosted dependencies.
- Add a sender session in the dashboard before starting a scan, or use an existing `session_*` folder.
- Target uploads may be `.txt` files or `.xlsx` workbooks up to 10 MB.
- New text result files use the `result_` prefix, for example `result_business_targets.txt`. Internal `target_*` JSON files remain on disk for recovery and are not listed in the dashboard.
- Older `report_*.txt` files are left untouched, not shown in Results, and excluded from target discovery.
- The scanner's batch behavior, result content, and checkpoint format remain unchanged. Pause and cancel controls are not provided.
- Use **Shut down** in the dashboard to stop the local Node.js application. It does not shut down the operating system and refuses to stop while a scan or sender operation is active.
- For Telegram control on Windows, configure `.env` from `.env.example` and run `npm run local`; `npm run web` starts only the dashboard.

To choose a different web port:

```sh
PORT=3001 npm run web
```
