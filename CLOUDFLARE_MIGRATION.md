# EventHub Cloudflare migration (in progress)

This branch prepares EventHub for Cloudflare Workers + Workers Static Assets + one dedicated D1 database.

## Cost guardrails
- Use the Cloudflare Workers Free plan and D1 Free allowance only.
- Do not create paid resources, enable paid plans, or configure automatic upgrades.
- Do not use R2, Queues, Durable Objects, paid AI, or paid add-ons in this migration.
- When free quotas are exhausted, operations should fail safely; do not silently move to a paid service.
- BRS must use a separate Worker/site and a separate D1 database. Never bind BRS data to EventHub.

## Current state
- `main` remains the existing Python/SQLite/Render version.
- This branch contains the first D1 schema and Worker migration scaffold.
- No production Worker or D1 database has been created or modified.
- Existing Telegram/Render data must be exported, backed up, reviewed, and imported only after schema mapping and a dry run.

## Setup (not yet performed)
1. Create a dedicated D1 database named `eventhub-db` on the Free plan.
2. Replace the placeholder `database_id` in `wrangler.jsonc`.
3. Apply `cloudflare/schema.sql`.
4. Set `VK_APP_SECRET` as a Worker secret; set `VK_APP_ID`, `VK_ADMIN_IDS`, and event settings as vars.
5. Deploy the Worker with static assets after local validation.
6. Test VK launch signatures, registration, approval, pass display, every checkpoint, duplicate scan rejection, volunteer access, CSV export, and audit history.
7. Import a reviewed backup and reconcile record counts before switching the VK Mini App URL.

## Data isolation
EventHub has its own D1 binding and schema. BRS is intentionally not included in this database or Worker.
