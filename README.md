# VK EventHub

VK Mini App migration of the DEEPOTSAV / Telegram EventHub workflows.

## Implemented in this repository
- VK Mini Apps launch-parameter signature verification on the backend.
- Guest registration with required full name, phone, residence, hostel and room.
- Food preference is collected only when food collection is enabled.
- Admin approval/rejection/revocation; QR token and pass code are created on approval.
- Volunteer management with server-enforced role checks.
- Checkpoints: entry, proof storage, food collection, exit and proof return.
- Duplicate checkpoint protection (one scan per guest per checkpoint).
- Central pass design settings; saving a design does not regenerate QR tokens or erase scan history.
- Admin dashboard, registration counts, CSV export, audit log and a persistent Sheets outbox queue.

## Deploy
1. Import this repository into Render as a Web Service (the included `render.yaml` is a Blueprint).
2. Set `VK_APP_ID`, `VK_APP_SECRET`, and `VK_ADMIN_IDS` (comma-separated VK numeric user IDs).
3. Set `EVENT_DATE`, `EVENT_VENUE`, and `FOOD_COLLECTION_ENABLED`.
4. Set the VK Mini App launch URL to the deployed HTTPS URL.
5. **Before accepting real registrations, configure persistent storage.** The free Render filesystem is ephemeral and can lose SQLite data on redeploy/restart. Use a persistent disk with `DATABASE_PATH` pointing into its mount path, or migrate to managed PostgreSQL.
6. Keep `DEV_MODE=false` in production. Never put `VK_APP_SECRET` in frontend code.

## Local development
```bash
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
DEV_MODE=true DEV_VK_USER_ID=1 VK_ADMIN_IDS=1 uvicorn app:app --reload
```
Open http://localhost:8000. The development identity bypass is only for local testing and must remain disabled in production.

## Important migration notes
- Existing Telegram registrations are not automatically imported. Do not point this service at the Telegram SQLite database. Use a reviewed export/import after confirming the old data and schema.
- Google Sheets delivery is not yet connected. Registration, approval and scan changes are kept in `sheets_outbox`; the queue is not deleted or silently reset.
- Offline scanner queue/sync, a complete visual pass editor, multi-event creation UI, admin notifications and a production Sheets sync worker remain follow-up work.
- The current VK app uses one active event record; the schema supports event-scoped guests and designs, but multi-event administration UI is not finished.
- QR camera scanning depends on the VK in-app browser supporting `BarcodeDetector`; manual QR token entry remains available as a fallback.
