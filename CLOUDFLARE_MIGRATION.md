# EventHub Cloudflare migration (in progress)

## Source of truth and scope

The new VK EventHub is a clean-slate deployment. No Telegram/Botkeep registrations, attendance, QR passes, volunteer records, or historical data will be imported. New records will be collected after launch. The migration reuses the desired EventHub workflows while using VK identity and VK-native delivery.

EventHub and BRS are separate products:
- EventHub: this repository, its own Worker, static site, and one dedicated D1 database.
- BRS: a different repository/site, Worker, and D1 database. Never share tables, bindings, tokens, admin roles, or student data between them.
- One VK bot may link to both independent apps. A VK numeric user ID is not an authorization grant; each app verifies the VK launch signature and its own roles.

## EventHub feature parity checklist

The D1 schema is being expanded to retain:
- Multiple event workspaces with draft / active / archived lifecycle, per-event description, date, time, venue, theme, registration-open switch, food-collection switch, and configurable registration form schema.
- Guest and pending-registration records, approval/rejection, pass issuance, reissue, revoke/reactivate, and entry/food status reset.
- Event-scoped volunteer roles (entry, food, proof, checkpoint, scanner, event lead), global volunteer/admin recovery roles, and checkpoint-specific assignments.
- Standard entry and food actions plus additional attendance checkpoints.
- Proof hand-off workflow: assign a physical storage slot, accept a guest without proof, record proof return, and block exit until the stored proof is returned.
- Configurable storage layout, capacity validation, unique active slots, proof-storage report, and event exit records.
- QR pass design, staff passes, guest search, CSV export, event statistics, audit history, and downloadable event backup/restore.
- Durable Google Sheets outbox with retry metadata; scanner actions must not wait for Sheets network delivery.
- Event announcements and delivery reports will be adapted to VK messaging, not Telegram messaging.

## Identity rule

This is a fresh VK-only database. Every registration is tied to the VK user ID verified from the signed VK Mini App launch parameters. There are no Telegram identity columns or legacy-account linking tools.

## Cost guardrails

- Cloudflare Workers Free + Workers Static Assets + D1 Free only.
- No paid plans, automatic upgrades, R2, Queues, Durable Objects, paid AI, or paid add-ons.
- Use a D1 outbox table and bounded request/cron processing only if the applicable free quotas are confirmed.
- If a free quota is reached, fail safely and notify the admin. Never silently switch to a paid service.
- Backups should be generated as a downloadable export; do not upload them to paid object storage.

## Implementation status

Implemented on the migration branch:
- VK launch signature validation with a one-hour freshness window and app-ID check.
- Event-scoped role lookup, event selection, event details, registration and approved-pass retrieval.
- Locally generated QR SVG pass payloads; no QR image CDN dependency.
- Event-scoped entry, food, proof deposit, no-proof, proof return, exit, and additional checkpoint scan endpoints.
- Configurable proof-storage capacity with active-slot uniqueness and refusal to shrink around occupied slots.
- Event-scoped admin actions for lifecycle, approvals, guest pass actions, volunteers, checkpoint teams, reports, audit and settings.
- VK community announcement queue with small delivery batches and unsend history.
- D1 Sheets outbox with bounded retry/backoff and a five-minute Cron Trigger.
- VK-native frontend auth header, same-origin API calls, native Chrome BarcodeDetector scanning and manual-code fallback.
- Basic VK auth tests, D1 schema tests, and a GitHub Actions workflow.

Still pending before production:
- Verify the CI run and execute the schema against a local D1-compatible environment.
- Add a tested downloadable backup/export and restore workflow for new EventHub data.
- Add end-to-end tests for all admin and event-day workflows.
- Confirm the existing Google Apps Script receiver includes the saved EventHub event-log merge helper.
- Configure and test the actual VK app secret, admin VK IDs, optional VK group token and Sheets endpoint.
- Verify scanner permissions inside the real VK Android webview and test the VK announcement permission edge cases.
- Review every admin action against the saved EventHub source before calling feature parity complete.

## Branch and deployment state

- Existing `main` branch remains untouched.
- Work is isolated on `cloudflare-migration`.
- No production Worker, D1 database, secrets, or VK app settings have been created or modified.
- The current Worker/frontend scaffold is not production-ready yet; it must be brought to feature parity and tested before deployment.

## Migration sequence

1. Complete the D1 schema and Worker API for the full feature set above.
2. Adapt the EventHub frontend to VK Mini Apps launch parameters and same-origin Worker API calls.
3. Add automated tests for VK signature validation, event isolation, registration, role checks, duplicate scans, proof storage capacity, proof return, and exit gating.
4. Create a fresh, empty EventHub D1 database. Do not import Telegram/Botkeep data.
5. Configure VK app ID, VK secret, VK admin IDs, optional VK group messaging token, and optional Google Sheets endpoint as secrets/vars.
6. Test with designated VK accounts and test guests. Only then update the VK Mini App URL.
7. After VK EventHub is verified, decide separately whether the old Telegram/Botkeep service should be shut down.

## Current D1 design

One EventHub D1 database uses `event_id` partitioning for event isolation. This is deliberate: it avoids creating one D1 database per event and keeps the EventHub/BRS separation clear while preserving event-scoped queries. Every guest, pending registration, volunteer assignment, checkpoint, scan, proof record, exit record, announcement, and audit item must be scoped to the correct event.
