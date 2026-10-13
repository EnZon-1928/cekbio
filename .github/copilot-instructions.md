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

## Context Mode

Use Context Mode when it materially reduces how much raw data needs to enter the conversation:

- Use Context Mode for substantial data processing—counting, filtering, aggregating, comparing, or summarizing large/multiple files, logs, command outputs, or web sources—so raw input stays out of the conversation and only the derived answer is returned.
- Pick the tool by task: `ctx_execute` for a short computation or script; `ctx_execute_file` to analyze a workspace file without displaying its contents; `ctx_batch_execute` to run related commands and query their indexed output in one call; `ctx_fetch_and_index` plus `ctx_search` for web material that needs follow-up lookup. Use `ctx_index` only when content should be retained for later search.
- For repository commands sent through `ctx_batch_execute` or `ctx_execute`, always pass `cwd` as the repository root. In this WSL workspace the root is `/home/izhchyt12/cekbio`; never assume the MCP server's default directory is the project (it may be VS Code's installation directory). Keep `npm test`, build, lint, and other stateful commands sequential (`concurrency: 1`).
- When running tests or other commands with potentially long output, derive a concise summary inside the command (for example, totals plus failing test names and relevant error excerpts) and preserve the command's exit status. Do not send the entire raw output to the context just to report whether the command passed.
- For focused code navigation, small fixed outputs, and edits, use normal workspace tools. Read source normally when exact text is needed for an edit. Do not route code that must be edited through a sandbox, and do not call Context Mode when it adds no meaningful value.
- Use only Context Mode tools actually available in the current chat. If a requested tool is missing or invocation fails, state that accurately and do not claim the task ran through Context Mode; use another method only if the user permits or the task can proceed without that requirement.
- If the user asks for `ctx stats` or Context Mode statistics, call `ctx_stats` and report its output accurately. Do not substitute session or Git metadata. Explain that `Skipped` is the adapter activity filter, and that Context Mode savings are estimates—not official Copilot billing or proof that this individual task saved that amount.
- Do not claim a task saved tokens unless `ctx_stats` reports savings. Calling `ctx_stats` only reads statistics; it does not itself save context. When comparing savings, distinguish current-task results from session/lifetime aggregates.
- Keep sender credentials, WhatsApp sessions, Telegram tokens, target lists, and scan results out of command output, indexing, and conversation unless explicitly needed. Redact sensitive values in diagnostic summaries; never print or index them unnecessarily.
