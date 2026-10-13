# Project instructions

## Communication

- Respond to the user in Indonesian unless they explicitly request another language.
- Keep user-facing Telegram bot copy in professional, consistent English when adding or editing UI text.
- Preserve established technical terms such as “sender” when they are clear and appropriate.

## Preserve application behavior

- This project is a Node.js/CommonJS WhatsApp scanning application with an interactive CLI and a Telegram bot on the `telegram_bot` branch.
- Telegram is a local control interface. Keep its operations as thin adapters over shared local operations; do not duplicate or rewrite scan and sender logic.
- Preserve Baileys integration, sender session format, result contents, checkpoint behavior, and CLI workflows unless the user explicitly requests a behavior change.
- Do not introduce scan controls or capabilities that the engine does not safely support.
- The web dashboard and HTTP API belong to the separate `main` branch; do not reintroduce them on `telegram_bot`.

## Local operation and data

- Do not expose sender credentials, sessions, targets, or results remotely.
- Validate uploaded filenames, request input, and filesystem operations. Keep sender deletion explicit and confirmed.
- A Telegram shutdown action may stop only the local Node.js application, never the operating system; require confirmation and refuse shutdown while a scan or sender operation is active.
- Do not copy, log, or expose WhatsApp session credentials, Telegram tokens, or target data unnecessarily.
- Keep `.env` private and out of version control.
- The application can run on Android/Termux, Windows, or Linux. Install dependencies in the specific project directory being used.

## Changes and verification

- Keep changes focused on the user's request and do not edit unrelated bot copy.
- Check the existing CLI and Telegram behavior when changing shared code.
- Run available syntax checks and focused automated tests.
- When working in WSL/Linux, if the matching Windows working copy exists (`C:\Users\izhar\cekbio`), synchronize each changed project file to that copy as part of the task. Before copying, inspect differences and preserve any Windows-only edits; do not overwrite conflicting changes without resolving them. Copy only relevant changed source/documentation files, never `node_modules`, `.env`, sender sessions, credentials, target lists, or scan results. Verify the synchronized files match after copying.

## Context Mode

Use Context Mode when it materially reduces how much raw data needs to enter the conversation:

- For requests to count, search, filter, compare, aggregate, or summarize many files, logs, command results, or fetched pages, prefer `ctx_execute`, `ctx_execute_file`, `ctx_batch_execute`, or `ctx_fetch_and_index` as appropriate. Compute inside the sandbox and return only the requested answer or a concise summary.
- Choose the tool by data shape: `ctx_execute` for a short script or calculation; `ctx_execute_file` to analyze one file without exposing its contents; `ctx_batch_execute` for several shell commands or sources that should be gathered and queried together; `ctx_fetch_and_index` followed by `ctx_search` for web sources or reusable reference material.
- For focused code navigation, small outputs, and edits, use the normal workspace tools. Do not route code that must be edited through a sandbox, and do not use Context Mode just to add an unnecessary tool call.
- Before using a Context Mode tool, verify that the tool is actually available in this chat. If unavailable, say which tool is missing. When the user specifically asks for Context Mode, do not silently substitute Bash, Git, or another tool and present it as a Context Mode run.
- If the user asks for `ctx stats` or Context Mode statistics, call `ctx_stats` and report its result accurately. Do not substitute session/Git metadata. Distinguish per-session calls and savings from the cross-adapter `Skipped` filter; stats are Context Mode estimates, not official Copilot billing.
- Do not claim a task saved tokens unless `ctx_stats` reports savings. Calling `ctx_stats` only reads statistics; it does not itself save context.
- Keep sender credentials, WhatsApp sessions, target lists, and scan results out of tool output and indexing unless explicitly needed; never print or index sensitive data unnecessarily.
