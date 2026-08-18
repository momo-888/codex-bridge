# Security Policy

## Supported versions

Security fixes are applied to the latest release on the default branch. Early preview releases may contain breaking changes and should not be exposed directly to the public internet.

## Threat model

Codex Bridge is designed for one trusted user controlling their own Windows or macOS computer.

- The desktop Host reads local Codex history and can start or continue Codex tasks.
- A valid phone or host bearer token grants powerful access. Treat these tokens as passwords.
- Pairing codes are short-lived and single-use, but the token obtained after pairing remains valid until it is rotated.
- The public Relay terminates TLS and forwards message, task, approval, attachment, and event data. The current protocol does not provide end-to-end encryption from phone to Host.
- Direct HTTP is supported only for private networks that already provide link encryption and access control. Never expose port `43110` directly to the public internet.
- The Android app stores connection settings locally and excludes its private application data from Android backup.
- Markdown may reference remote images. Opening a remote image can reveal the phone's IP address and user agent to that image host.

The Relay is not a multi-tenant isolation boundary. Run a separate deployment and separate tokens for each trusted user.

## Safer deployment defaults

- Keep the Host bound to `127.0.0.1` unless private-network access is explicitly required.
- The macOS management page is deliberately fixed to `127.0.0.1:43109`; do not proxy or expose it to another device.
- Put public deployments behind HTTPS/WSS and a maintained reverse proxy.
- Enable `CODEX_RELAY_TRUST_PROXY=true` only when the Relay port is reachable exclusively through a trusted reverse proxy.
- Restrict firewall access, rotate both Relay tokens after suspected exposure, and keep `%USERPROFILE%\.codex-bridge` or `~/.codex-bridge` private.
- Store Android signing keys and deployment secrets outside the repository.
- Review dependency alerts and install updates promptly.

## Reporting a vulnerability

Please do not disclose exploitable vulnerabilities, tokens, private conversations, or pairing QR codes in a public issue. Use the repository's private GitHub Security Advisory reporting flow. Include affected versions, reproduction steps, impact, and any suggested mitigation.

If private reporting is not yet enabled, contact the maintainer privately through the GitHub profile before publishing details.
