# EventHub Cloudflare runtime

This directory mirrors the currently deployed EventHub production Worker.

- `worker.js`: Worker backend and embedded VK Mini App frontend.
- `qrcode.mjs`: bundled QR-code implementation imported by the Worker.
- `wrangler.toml`: non-secret Worker/D1/AI/Cron configuration.
- `test/`: source-contract tests; these do not replace end-to-end acceptance testing.

## Runtime

- Cloudflare Worker: `eventhub-vk`
- D1 database: `eventhub-db`
- D1 binding: `DB`
- Workers AI binding: `AI`
- Cron: every minute; it processes a bounded Google Sheets outbox batch.
- VK Mini App ID and Global Application Admin ID are public identifiers, not secrets.

## Required secret bindings

Configure secrets through Cloudflare, never commit them here:

- `VK_APP_SECRET`: required for VK launch signature verification.
- `SHEETS_SYNC_SECRET`: required for the Google Sheets receiver.
- `VK_GROUP_TOKEN`: optional, but required for VK group announcement delivery. It is not currently present in the production Worker bindings.

Do not put secret values in `wrangler.toml`, CI logs, source control, screenshots or chat messages.

## Safe deployment policy

The workflow `.github/workflows/eventhub-worker-ci.yml` runs syntax and source-contract tests only. It deliberately does not deploy to production.

Before a manual deployment, compare the Cloudflare Worker settings and all secret bindings with the existing production configuration. A code-only upload must preserve the D1 binding, AI binding, plaintext variables, secret bindings and Cron trigger. Never use this mirror to reset or recreate the production D1 database.

## Current functional caveats

- Offline QR captures are stored locally on the device and are **not attendance records** until the volunteer reconnects, verifies each pass and records the action online.
- D1 Time Travel is the database-level recovery path. An in-place restore rewinds the whole database; do not test restoration on production without a separately agreed recovery plan.
- The event-specific JSON backup action is a manual export and contains personal data and QR tokens. Store downloaded backups securely.
- Announcement delivery requires `VK_GROUP_TOKEN`.
- CI contract tests validate source structure; they do not prove VK in-app browser camera support, Android/iOS compatibility, real messaging delivery or production-scale load.

## Local checks

Use Node.js 22 or newer:

```sh
npm run check
npm test
```
