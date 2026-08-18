# Contributing

Thanks for helping improve Codex Bridge.

## Development setup

Use Node.js 22.13 or newer and npm with the committed lockfile:

```powershell
npm ci
npm run typecheck
npm run lint
npm test
```

Android changes additionally require JDK 21 and Android SDK 35. On Windows, `scripts/setup-android-toolchain.ps1` can prepare an isolated toolchain under ignored directories.

## Pull requests

- Keep changes focused and explain the user-visible behavior.
- Add or update regression tests for behavior changes.
- Run type checking, linting, and the full test suite before opening a Pull Request.
- Do not commit APKs, build outputs, logs, `.env` files, signing keys, tokens, pairing QR codes, personal filesystem screenshots, or private Codex conversations.
- State the tested Codex version when changing App Server compatibility. Generate reference schemas into the ignored `.tmp-appserver-schema` directory.
- Keep public defaults generic. Use `bridge.example.com` and documentation-only IP ranges in examples.

## Project structure

- `app/`: mobile web UI and API proxy
- `host/`: Windows Host, Codex App Server integration, history and queue handling
- `relay/`: authenticated public Relay
- `android/`: Android WebView shell and native image viewer
- `desktop/`: Windows tray application
- `macos/`: macOS browser manager, supervisor, and pairing integration
- `scripts/*.sh`: macOS Host/Web lifecycle, login startup, and release tooling
- `tests/`: Node regression tests

By contributing, you agree that your contributions are licensed under Apache License 2.0.
