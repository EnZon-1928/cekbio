# cekbio

cekbio is a local Node.js CLI and web interface for managing sender sessions, scanning target lists, and saving the existing text/JSON reports.

## Requirements

- Node.js 20 or newer and npm
- Git (required to clone the project and install its Git-hosted dependencies)
- An existing `session_*` folder to run a scan; sender sessions can also be added from the web dashboard

## Android (Termux, no root)

The web dashboard runs locally on the Android device. Root access, an emulator, and shared-storage access are not required.

### Quick setup

1. Install Termux from one of the sources listed in the [official Termux installation instructions](https://github.com/termux/termux-app#installation). Install/update Termux from the same source; do not mix builds from different sources.
2. Open Termux and run:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/EnZon-1928/cekbio/main/scripts/setup-termux.sh | bash
   ```

   The script checks for Termux prerequisites, installs only missing packages, uses a cekbio project in the current private Termux home when possible or clones it into `$HOME/cekbio`, checks the Node.js dependencies, starts the web server, and asks Android to open the default browser. If Chrome is the default browser, it opens in Chrome. Review the [setup script](./scripts/setup-termux.sh) before running it if you want to inspect what it does; piping a remote script to Bash executes that code on your device.

   The script does not overwrite an unrelated folder, delete app data, or automatically pull changes into an existing clone. To update an existing clone, review your changes and update it manually with `git pull --ff-only`.
3. Keep Termux open while using the dashboard. If the browser does not open automatically, open `http://127.0.0.1:3000` manually.

### Manual Android setup

1. Install and open Termux using the official source above. No root access is needed.
2. Install/update Termux packages:

   ```sh
   pkg update
   pkg upgrade -y
   pkg install -y git nodejs-lts curl
   ```

3. Check that Node.js is version 20 or newer and that npm is available:

   ```sh
   node --version
   npm --version
   git --version
   ```

4. Clone the repository into Termux's private home directory. Avoid `$HOME/storage/shared` or other shared-storage folders; keeping the project in `$HOME` avoids execution-permission issues and helps protect WhatsApp sessions and scan data.

   ```sh
   cd "$HOME"
   git clone https://github.com/EnZon-1928/cekbio.git
   cd cekbio
   git config --local --add url."https://github.com/".insteadOf "ssh://git@github.com/"
   git config --local --add url."https://github.com/".insteadOf "git@github.com:"
   ```

   The GitHub-hosted dependencies are public. These per-project URL rewrites let Git fetch them over HTTPS without requiring a GitHub SSH key; they do not change your global Git configuration.

5. Install dependencies and start the web interface:

   ```sh
   npm install
   npm run web
   ```

6. Open `http://127.0.0.1:3000` in Chrome or another browser on the same phone. Keep the Termux process running while using the page. Press **Ctrl+C** in Termux to stop the server.

### Android background behavior and data

- Android may stop background processes to save battery. Keep Termux open and, if Android offers the setting, allow Termux unrestricted battery use while scanning. Battery settings and wake locks cannot guarantee that Android will never stop the process.
- The script does not require `termux-setup-storage` or the Termux:API companion app. Keep sender sessions, targets, checkpoints, and reports in the app's private Termux directory.
- The dashboard server binds only to `127.0.0.1`; it is intended to be accessed from the same device. Do not expose it through a network tunnel or port forwarding.
- Stop scans/sender operations before closing Termux. Do not run the CLI and web interface against the same sender session at the same time.

## Linux (manual setup)

The commands below are for Debian/Ubuntu. Use your distribution's package manager on other Linux distributions, and ensure it provides Node.js 20 or newer.

1. Install Git and curl. The following package command is for Debian/Ubuntu:

   ```sh
   sudo apt update
   sudo apt install -y git curl
   ```

   Install Node Version Manager (nvm), then install the current Node.js LTS release (Node.js 20 or newer is required):

   ```sh
   curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash
   export NVM_DIR="$HOME/.nvm"
   . "$NVM_DIR/nvm.sh"
   nvm install --lts
   node --version
   npm --version
   git --version
   ```

   For other Linux distributions, install `git` and `curl` with the system package manager, then follow the same nvm commands.

2. Clone the repository and install dependencies:

   ```sh
   git clone https://github.com/EnZon-1928/cekbio.git
   cd cekbio
   git config --local --add url."https://github.com/".insteadOf "ssh://git@github.com/"
   git config --local --add url."https://github.com/".insteadOf "git@github.com:"
   npm install
   ```

3. Start the web interface:

   ```sh
   npm run web
   ```

4. Open `http://127.0.0.1:3000` in a browser on the same computer. Press **Ctrl+C** in the terminal to stop the server.

## Windows (manual setup)

1. Install Node.js 20 or newer from [nodejs.org](https://nodejs.org/en/download) and Git for Windows from [git-scm.com](https://git-scm.com/download/win).
2. Open PowerShell and verify that Node.js, npm, and Git are available:

   ```powershell
   node --version
   npm --version
   git --version
   ```

3. Clone the project into a Windows directory, install its dependencies, and start the web interface:

   ```powershell
   Set-Location $HOME
   git clone https://github.com/EnZon-1928/cekbio.git
   Set-Location .\cekbio
   git config --local --add url."https://github.com/".insteadOf "ssh://git@github.com/"
   git config --local --add url."https://github.com/".insteadOf "git@github.com:"
   npm install
   npm run web
   ```

4. Open `http://127.0.0.1:3000` in a browser on the same computer. Press **Ctrl+C** in PowerShell to stop the server.

   Install dependencies separately in the Windows project directory. Do not reuse `node_modules` from WSL/Linux; native packages and paths are platform-specific.

## Run the CLI

From the project directory, run:

```sh
node index.js
```

The terminal menu remains available and uses the same sender, scan, checkpoint, and report logic.

## Web interface behavior and local data

The web panel can add and check sender sessions, upload `.txt` target files (up to 10 MB), start and monitor scans, resume or discard an existing checkpoint, and download generated text reports. Internal JSON result files remain in the application directory for scan recovery and are not listed in the dashboard. Individual target lists and text reports can be removed after confirmation; removing a target list also removes its checkpoint, but does not remove its generated reports.

Uploaded targets, sender sessions, checkpoints, and generated data are stored in the application's working directory. Keep this directory private because it contains WhatsApp session credentials and target/report data.

During a scan, the dashboard shows the in-memory account summary, batch status, and the number of targets completed at batch boundaries. Use the Reports search and category filter to narrow the visible text reports; these controls do not change or delete report files.

The scanner's existing batch behavior, report format, and checkpoint format are retained. Pause and cancel controls are not provided. Use either the CLI or web interface at a time; do not open the same sender session in both processes simultaneously.

Use **Shut down** in the dashboard to stop the local Node.js application. It does not shut down the operating system. The application refuses to shut down while a scan or sender operation is active; wait for the operation to finish and try again.

To use another local port, set `PORT` before starting the web server, for example:

```sh
PORT=3001 npm run web
```

On Android, set the same variable before running the Termux setup script to use a different port:

```sh
PORT=3001 bash <(curl -fsSL https://raw.githubusercontent.com/EnZon-1928/cekbio/main/scripts/setup-termux.sh)
```
