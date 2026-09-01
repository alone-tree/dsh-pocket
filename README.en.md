# DSH Pocket security refactor

This branch is undergoing a security-first redesign and currently maintains the authoritative documentation in Chinese only.

Please read [`README.md`](./README.md). The implementation replaces LAN/PIN/Quick Tunnel access with a fixed HTTPS Cloudflare Named Tunnel and a locally approved Passkey/WebAuthn device allowlist.

The branch is not yet released and still requires real-device end-to-end validation.
