# Project instructions

## Communication

- Respond to the user in Indonesian unless they explicitly request another language.
- Keep user-facing Telegram bot copy in professional, consistent English when adding or editing UI text.
- Preserve established technical terms such as “sender” when they are clear and appropriate.

## Preserve application behavior

- This project is a Node.js/CommonJS WhatsApp scanning application with an interactive CLI and a Telegram bot on the `telegram_bot` branch.
- Telegram is a local control interface. Keep its operations as thin adapters over shared local operations; do not duplicate or rewrite scan and sender logic.
- Preserve Baileys integration, sender session format, checkpoint behavior, report contents, and CLI workflows unless the user explicitly requests a behavior change.
- Do not introduce scan controls or capabilities that the engine does not safely support.
- The web dashboard and HTTP API belong to the separate `main` branch; do not reintroduce them on `telegram_bot`.

## Local operation and data

- Do not expose sender credentials, sessions, targets, or reports remotely.
- Validate uploaded filenames, request input, and filesystem operations. Keep sender deletion explicit and confirmed.
- Keep internal `target_*` JSON results on disk for recovery; do not list or send them through Telegram.
- A Telegram shutdown action may stop only the local Node.js application, never the operating system; require confirmation and refuse shutdown while a scan or sender operation is active.
- Do not copy, log, or expose WhatsApp session credentials, Telegram tokens, or target data unnecessarily.
- Keep `.env` private and out of version control.
- The application can run on Android/Termux, Windows, or Linux. Install dependencies in the specific project directory being used.

## Changes and verification

- Keep changes focused on the user's request and do not edit unrelated bot copy.
- Check the existing CLI and Telegram behavior when changing shared code.
- Run available syntax checks and focused automated tests.
- When working in WSL/Linux, if the matching Windows working copy exists (`C:\Users\izhar\cekbio`), synchronize each changed project file to that copy as part of the task. Before copying, inspect differences and preserve any Windows-only edits; do not overwrite conflicting changes without resolving them. Copy only relevant changed source/documentation files, never `node_modules`, `.env`, sender sessions, credentials, target lists, or scan results. Verify the synchronized files match after copying.
