# cekbio

cekbio is a local Node.js CLI and web interface for managing sender sessions, scanning target lists, and saving the existing text/JSON reports.

## Requirements

- Node.js supported by the installed Baileys dependencies
- Dependencies installed with `npm install`
- An existing `session_*` folder to run a scan

## Run the CLI

```sh
node index.js
```

The terminal menu remains available and uses the same sender, scan, checkpoint, and report logic.

## Run the local web interface

```sh
npm run web
```

Open the local URL printed by the server (by default `http://127.0.0.1:3000`). The server binds only to `127.0.0.1`; do not expose it through port forwarding or a public reverse proxy.

The web panel can add and check sender sessions, upload `.txt` target files (up to 10 MB), start and monitor scans, resume or discard an existing checkpoint, and download generated text reports and JSON result files. Individual target lists and result files can also be removed after confirmation; removing a target list also removes its checkpoint, but does not remove its generated reports. Uploaded targets and generated data are stored in the application's working directory, alongside the files used by the CLI. Keep this directory private because it contains WhatsApp session credentials and target/report data.

The scanner's existing batch behavior, report format, and checkpoint format are retained. Pause and cancel controls are not provided.
Use either the CLI or web interface at a time; do not open the same sender session in both processes simultaneously.

To use another local port, set `PORT` before starting the web server, for example:

```sh
PORT=3001 npm run web
```
