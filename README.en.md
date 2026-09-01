# DSH Pocket security refactor

This branch is undergoing a security-first redesign and maintains the authoritative documentation in Chinese.

Please read [`README.md`](./README.md). The implementation replaces LAN, legacy PIN, Quick Tunnel, and WebAuthn access with a fixed HTTPS Cloudflare Named Tunnel plus a locally approved browser device credential and per-device password.

The new authentication code and automated tests are complete. The branch has not been released or redeployed to DSH Desktop and still requires real-device end-to-end validation on the target Honor 50.
