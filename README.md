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

The web panel can add and check sender sessions, upload `.txt` target files (up to 10 MB), start and monitor scans, resume or discard an existing checkpoint, and download generated text reports. Internal JSON result files remain in the application directory for scan recovery and are not listed in the dashboard. Individual target lists and text reports can be removed after confirmation; removing a target list also removes its checkpoint, but does not remove its generated reports. Uploaded targets and generated data are stored in the application's working directory, alongside the files used by the CLI. Keep this directory private because it contains WhatsApp session credentials and target/report data.

During a scan, the dashboard shows the in-memory account summary, batch status, and the number of targets completed at batch boundaries. Use the Reports search and category filter to narrow the visible text reports; these controls do not change or delete report files.

The scanner's existing batch behavior, report format, and checkpoint format are retained. Pause and cancel controls are not provided.
Use either the CLI or web interface at a time; do not open the same sender session in both processes simultaneously.

Use **Shut down** in the dashboard to stop the local Node.js application. It does not shut down Windows. The application refuses to shut down while a scan or sender operation is active; wait for the operation to finish and try again.

To use another local port, set `PORT` before starting the web server, for example:

```sh
PORT=3001 npm run web
```
