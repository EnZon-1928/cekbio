# Project instructions

## Communication and UI language

- Respond to the user in Indonesian unless they explicitly request another language.
- Keep user-facing dashboard and web interface copy in professional, consistent English when adding or editing UI text.
- Preserve established technical terms such as “sender” when they are clear and appropriate.
- Do not translate or revise existing dashboard copy unless the user explicitly asks for that change.

## Preserve application behavior

- This project is a Node.js/CommonJS WhatsApp scanning application with both a CLI and a local web interface.
- Treat the web interface as an additional way to operate the existing application, not as a reason to rewrite its scanning or sender logic.
- Preserve existing scan behavior, Baileys integration, sender session format, checkpoint behavior, report contents, and CLI workflows unless the user explicitly requests a behavior change.
- Prefer thin UI/API adapters that call shared existing operations; avoid duplicating business logic.
- Do not introduce scan controls or capabilities that the current engine does not safely support.

## Local operation and data

- The web server must remain bound to loopback (`127.0.0.1`) by default. Do not expose sender credentials, sessions, target lists, or reports to remote clients.
- Validate uploaded filenames, request input, and filesystem operations. Keep sender deletion explicit and confirmed.
- Keep internal `target_*` JSON results on disk for recovery, but do not list them in the dashboard.
- A dashboard shutdown control may stop only the local Node.js application, never the operating system; require confirmation and refuse shutdown while a scan or sender operation is active.
- Do not copy, log, or expose WhatsApp session credentials or target data unnecessarily.
- The application can be run from either WSL/Linux or Windows. Run `npm install` in the specific project directory being used, then start the web interface with `npm run web`.

## Changes and verification

- Keep changes focused on the user's request and do not edit dashboard copy as a side effect.
- Check the existing CLI and web behavior when changing shared code.
- Run available syntax checks and focused smoke tests. The package currently does not define a real automated test suite.
