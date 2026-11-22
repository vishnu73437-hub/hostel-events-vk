# KSMU EventHub – VK Mini App

KSMU EventHub is a VK Mini App for managing event registration, guest QR passes, volunteer roles, checkpoint scanning, event operations and Google Sheets synchronization.

## Current production architecture

The live production runtime is **Cloudflare Workers + D1**, not the older Render/FastAPI prototype.

| Component | Production configuration |
|---|---|
| Worker | `eventhub-vk` |
| Worker URL | `https://eventhub-vk.ksmu.workers.dev` |
| D1 database | `eventhub-db` |
| D1 binding | `DB` |
| Workers AI binding | `AI` |
| VK Mini App ID | `54902627` |
| Scheduled sync | Every minute |

The current Worker source has been mirrored from the live Cloudflare deployment into [`cloudflare/`](cloudflare/). Treat the Worker deployed in Cloudflare as the production source of truth until a reviewed deployment process is agreed.

## Repository layout

- `cloudflare/worker.js` – deployed Worker backend and embedded Mini App frontend.
- `cloudflare/qrcode.mjs` – QR code module imported by the Worker.
- `cloudflare/wrangler.toml` – non-secret Worker, D1, AI and Cron configuration reference.
- `cloudflare/test/` – automated source-contract tests.
- `.github/workflows/eventhub-worker-ci.yml` – syntax checks and contract tests; no production deployment.
- `app.py`, `render.yaml` – retained legacy Render/FastAPI prototype and migration reference. They are not the current production runtime.

## Implemented production capabilities

The current Cloudflare Worker includes VK launch parameter signature verification, event-scoped registration, admin approval/rejection, QR pass generation and revocation, event-specific volunteer roles, checkpoint assignments and scans, event operations, audit history, per-event Google Sheets outbox delivery, pass image downloads, bilingual UI strings, and manual event backup export.

Google Sheets synchronization is configured as a recurring one-minute Worker Cron job. The outbox uses bounded batches and event-tab setup before guest upserts.

## Important operational limitations

- Offline QR captures are held in the local device queue. They are **not attendance records** until a volunteer reconnects, verifies each pass and records the action online.
- VK announcement delivery requires the Worker secret `VK_GROUP_TOKEN`. That secret is not currently configured in the production Worker. Do not attempt announcement delivery until it is added securely in Cloudflare.
- The event backup button creates a manual event-scoped JSON export containing personal data and QR pass tokens. Store downloaded files securely.
- D1 Time Travel is the database-level recovery mechanism. A point-in-time restore rewinds the entire D1 database and must not be tested destructively against production.
- Source-contract tests and CI do not replace Android/iOS/VK browser camera testing, multi-device acceptance testing or a production-scale load test.

## Secrets

Set secret values only in Cloudflare Worker secret bindings. Never commit them to GitHub or include them in CI output.

- `VK_APP_SECRET` – required for VK launch signature verification.
- `SHEETS_SYNC_SECRET` – required for the Sheets receiver.
- `VK_GROUP_TOKEN` – required for VK group announcement delivery; currently absent from production bindings.

The Worker also uses the non-secret `VK_APP_ID` and `VK_ADMIN_IDS` settings. The reference configuration is in `cloudflare/wrangler.toml`.

## CI and local checks

The GitHub Actions workflow checks Worker JavaScript syntax and runs contract tests using Node.js 22. It intentionally does **not** deploy to production.

From the Cloudflare directory:

```sh
npm run check
npm test
```

## Deployment safety

Do not use the legacy Render files to deploy the current production system. Do not recreate, reset or migrate the production D1 database as part of a Worker code update. Before any manual production deployment, compare all existing Worker bindings, secrets, database association and Cron schedules with the live Cloudflare settings.

All production changes must preserve existing events, guest registrations, QR tokens, scan history, volunteer assignments, audit records and settings.
