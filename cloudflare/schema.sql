PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  event_date TEXT NOT NULL,
  venue TEXT NOT NULL,
  food_enabled INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_events_single_active ON events(active) WHERE active=1;

CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  vk_user_id TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  residence TEXT NOT NULL,
  hostel TEXT NOT NULL,
  room TEXT NOT NULL,
  food_preference TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  pass_code TEXT UNIQUE,
  qr_token TEXT UNIQUE,
  registered_at TEXT NOT NULL,
  approved_at TEXT,
  revoked_at TEXT,
  UNIQUE(event_id, vk_user_id)
);
CREATE INDEX IF NOT EXISTS idx_guests_event_status ON guests(event_id,status);
CREATE INDEX IF NOT EXISTS idx_guests_qr_token ON guests(qr_token);

CREATE TABLE IF NOT EXISTS volunteers (
  vk_user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  added_by TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  added_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id INTEGER NOT NULL REFERENCES guests(id),
  stage TEXT NOT NULL,
  scanned_by TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  UNIQUE(guest_id,stage)
);
CREATE INDEX IF NOT EXISTS idx_scans_guest ON scans(guest_id);

CREATE TABLE IF NOT EXISTS pass_design (
  event_id INTEGER PRIMARY KEY REFERENCES events(id),
  design_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sheets_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  guest_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  synced_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_sheets_outbox_pending ON sheets_outbox(synced_at,id);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT NOT NULL,
  details_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_log(created_at);
