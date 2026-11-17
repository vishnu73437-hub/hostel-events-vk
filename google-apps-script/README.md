# EventHub Google Sheets receiver v5

This is the complete Apps Script receiver used by the VK EventHub Cloudflare outbox. It accepts only the `upsert` and `event_log` actions, validates a shared secret, and routes rows into separate tabs for each numeric `event_id`.

## What it creates

For each event ID it creates deterministic tabs:

- `Guests - <event_id> - <hash>` — full live guest register
- `Food - <event_id> - <hash>` — food collection tracker
- `Storage - <event_id> - <hash>` — proof-storage tracker
- `Event Log - <event_id> - <hash>` — append-only event-day actions

Existing `Sheet1`, legacy `Event Log`, and other tabs are not cleared, renamed, or deleted. A retry with the same `action_id` does not append a duplicate event-log row. Older guest snapshots cannot overwrite a newer `Last Updated` record.

The guest register preserves the existing exact 34-column header order (from Guest ID through Exit Volunteer ID). The guest row uses a stable event-scoped VK identity (`event:<event_id>:vk:<vk_user_id>`) so a pending registration is updated in place when it is approved and receives a numeric guest serial number.

## Install / deploy

1. Open the existing spreadsheet-bound Apps Script project for spreadsheet ID `1zYn-20i1fzdGWOzimmusUrHJhTpHncCZY7o6elFkwao`.
2. Replace the receiver source with `Code.gs` from this folder. This is a complete receiver, not an additive snippet; do not leave duplicate `doPost` functions in the project.
3. In **Project Settings → Script Properties**, set:
   - `SPREADSHEET_ID` = `1zYn-20i1fzdGWOzimmusUrHJhTpHncCZY7o6elFkwao`
   - `SCRIPT_SECRET` = a new private random secret (do not reuse any previously exposed secret)
   - `DEFAULT_TIMEZONE` = `Europe/Moscow`
4. Run `setupEventHubSheets` once from the Apps Script editor and approve the spreadsheet permission prompt.
5. Deploy → Manage deployments → Edit the existing Web App deployment → create a **new version**. Execute as **Me**; set access to **Anyone** so Cloudflare can call it. The shared secret protects POST requests.
6. Copy the Web App URL ending in `/exec`. Keep it private enough to avoid accidental changes, but it is not the authentication secret.
7. In Cloudflare Worker settings for `eventhub-vk`, set:
   - `SHEETS_SYNC_URL` = the Web App `/exec` URL
   - `SHEETS_SYNC_SECRET` = the same new secret used for `SCRIPT_SECRET`
8. Test the URL with a browser GET. Expected JSON: `{"ok":true,"service":"EventHub Google Sheets Sync","version":5}`.

## Important

- Cloudflare D1 remains the source of truth. The Sheets outbox retries failures; do not manually clear the outbox to force a sync.
- Set a Sheets URL per event in EventHub Settings if different events need different spreadsheets. If blank, the Worker uses `SHEETS_SYNC_URL`.
- Event tabs are separated by event ID, even when multiple events share one spreadsheet.
- The current VK EventHub database is a clean slate. This receiver does not import Telegram/Botkeep records.
- Do not put the shared secret in frontend code, a public repository, a spreadsheet cell, or a URL query parameter.
