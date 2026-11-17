PRAGMA foreign_keys = ON;

-- One EventHub database contains multiple strictly event-scoped workspaces.
-- BRS is not part of this schema and must use a different Worker + D1 database.

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  event_date TEXT NOT NULL DEFAULT '',
  event_time TEXT NOT NULL DEFAULT '',
  venue TEXT NOT NULL DEFAULT '',
  theme_json TEXT NOT NULL DEFAULT '{}',
  registration_schema TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','archived')),
  active INTEGER NOT NULL DEFAULT 0,
  registration_open INTEGER NOT NULL DEFAULT 1,
  food_enabled INTEGER NOT NULL DEFAULT 1,
  timezone TEXT NOT NULL DEFAULT 'Europe/Moscow',
  sheets_url TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_status ON events(status,id);
CREATE INDEX IF NOT EXISTS idx_events_active ON events(active,id);

CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  vk_user_id TEXT,
  legacy_telegram_id TEXT,
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT NOT NULL DEFAULT '',
  residence TEXT NOT NULL DEFAULT '',
  residence_type TEXT NOT NULL DEFAULT 'Apartment',
  hostel TEXT NOT NULL DEFAULT '',
  hostel_number TEXT NOT NULL DEFAULT '',
  room TEXT NOT NULL DEFAULT '',
  room_number TEXT NOT NULL DEFAULT '',
  food_preference TEXT NOT NULL DEFAULT 'Not applicable',
  registration_data TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','revoked')),
  pass_code TEXT UNIQUE,
  qr_token TEXT UNIQUE,
  registered_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT '',
  approved_at TEXT,
  revoked_at TEXT,
  entry_used INTEGER NOT NULL DEFAULT 0,
  entry_used_at TEXT,
  food_used INTEGER NOT NULL DEFAULT 0,
  food_used_at TEXT,
  UNIQUE(event_id,vk_user_id),
  UNIQUE(event_id,legacy_telegram_id)
);
CREATE INDEX IF NOT EXISTS idx_guests_event_status ON guests(event_id,status,registered_at);
CREATE INDEX IF NOT EXISTS idx_guests_qr_token ON guests(qr_token);
CREATE INDEX IF NOT EXISTS idx_guests_pass_code ON guests(pass_code);

CREATE TABLE IF NOT EXISTS pending_registrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  vk_user_id TEXT,
  legacy_telegram_id TEXT,
  full_name TEXT NOT NULL,
  email TEXT,
  phone TEXT NOT NULL DEFAULT '',
  food_preference TEXT NOT NULL DEFAULT 'Not applicable',
  residence_type TEXT NOT NULL DEFAULT 'Apartment',
  hostel_number TEXT NOT NULL DEFAULT '',
  room_number TEXT NOT NULL DEFAULT '',
  registration_data TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','revoked')),
  UNIQUE(event_id,vk_user_id),
  UNIQUE(event_id,legacy_telegram_id)
);
CREATE INDEX IF NOT EXISTS idx_pending_event_status ON pending_registrations(event_id,status,created_at);

-- VK identity records are local to EventHub. The same VK user may independently
-- exist in BRS, whose separate database has its own user table and permissions.
CREATE TABLE IF NOT EXISTS app_users (
  vk_user_id TEXT PRIMARY KEY,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  screen_name TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS app_admins (
  vk_user_id TEXT PRIMARY KEY,
  added_at TEXT NOT NULL,
  added_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS volunteers (
  vk_user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL,
  added_by TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS global_volunteers (
  vk_user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL,
  added_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS event_volunteers (
  event_id INTEGER NOT NULL REFERENCES events(id),
  vk_user_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'scanner' CHECK(role IN ('entry','food','proof','checkpoint','scanner','event_lead')),
  assigned_by TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY(event_id,vk_user_id)
);
CREATE INDEX IF NOT EXISTS idx_event_volunteers_user ON event_volunteers(vk_user_id,event_id);

CREATE TABLE IF NOT EXISTS event_checkpoints (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  name TEXT NOT NULL,
  checkpoint_type TEXT NOT NULL DEFAULT 'entry' CHECK(checkpoint_type IN ('entry','food','workshop','other')),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_event ON event_checkpoints(event_id,enabled,id);
CREATE TABLE IF NOT EXISTS event_checkpoint_assignments (
  event_id INTEGER NOT NULL REFERENCES events(id),
  checkpoint_id INTEGER NOT NULL REFERENCES event_checkpoints(id),
  vk_user_id TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  assigned_at TEXT NOT NULL,
  PRIMARY KEY(event_id,checkpoint_id,vk_user_id)
);
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guest_id INTEGER NOT NULL REFERENCES guests(id),
  stage TEXT NOT NULL,
  scanned_by TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  UNIQUE(guest_id,stage)
);
CREATE TABLE IF NOT EXISTS event_checkpoint_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  checkpoint_id INTEGER NOT NULL REFERENCES event_checkpoints(id),
  guest_id INTEGER NOT NULL REFERENCES guests(id),
  volunteer_vk_user_id TEXT NOT NULL,
  scanned_at TEXT NOT NULL,
  UNIQUE(checkpoint_id,guest_id)
);
CREATE INDEX IF NOT EXISTS idx_checkpoint_scans_event ON event_checkpoint_scans(event_id,scanned_at);

CREATE TABLE IF NOT EXISTS event_storage_configs (
  event_id INTEGER PRIMARY KEY REFERENCES events(id),
  unit_count INTEGER NOT NULL DEFAULT 5,
  sections_per_unit INTEGER NOT NULL DEFAULT 4,
  capacity_per_section INTEGER NOT NULL DEFAULT 10,
  unit_prefix TEXT NOT NULL DEFAULT 'Box',
  section_prefix TEXT NOT NULL DEFAULT 'Section',
  updated_at TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS proof_storage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  guest_id INTEGER NOT NULL UNIQUE REFERENCES guests(id),
  box_number INTEGER NOT NULL,
  section_letter TEXT NOT NULL,
  slot_number INTEGER,
  assigned_at TEXT NOT NULL,
  assigned_by TEXT NOT NULL,
  deposited_at TEXT,
  deposited_by TEXT,
  returned_at TEXT,
  returned_by TEXT,
  exit_at TEXT,
  exit_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_proof_storage_event_slot ON proof_storage(event_id,box_number,section_letter);
CREATE UNIQUE INDEX IF NOT EXISTS idx_proof_storage_active_slot
  ON proof_storage(event_id,box_number,section_letter,slot_number)
  WHERE returned_at IS NULL AND slot_number IS NOT NULL;
CREATE TABLE IF NOT EXISTS proof_not_collected (
  event_id INTEGER NOT NULL REFERENCES events(id),
  guest_id INTEGER NOT NULL UNIQUE REFERENCES guests(id),
  recorded_at TEXT NOT NULL,
  recorded_by TEXT NOT NULL,
  PRIMARY KEY(event_id,guest_id)
);
CREATE TABLE IF NOT EXISTS event_exit_records (
  event_id INTEGER NOT NULL REFERENCES events(id),
  guest_id INTEGER NOT NULL UNIQUE REFERENCES guests(id),
  exit_at TEXT NOT NULL,
  exit_by TEXT NOT NULL,
  PRIMARY KEY(event_id,guest_id)
);

CREATE TABLE IF NOT EXISTS pass_design (
  event_id INTEGER PRIMARY KEY REFERENCES events(id),
  design_json TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS staff_passes (
  vk_user_id TEXT PRIMARY KEY,
  pass_token TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  staff_role TEXT NOT NULL DEFAULT 'volunteer',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sheets_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  guest_id INTEGER NOT NULL DEFAULT 0,
  action TEXT NOT NULL DEFAULT '',
  event_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  synced_at TEXT,
  last_error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_sheets_outbox_ready ON sheets_outbox(synced_at,next_attempt_at,id);

CREATE TABLE IF NOT EXISTS event_announcements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  created_by TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  recipients INTEGER NOT NULL DEFAULT 0,
  attachment_type TEXT NOT NULL DEFAULT '',
  attachment_name TEXT NOT NULL DEFAULT '',
  attachment_ref TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS announcement_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  announcement_id INTEGER NOT NULL REFERENCES event_announcements(id),
  vk_user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  delivered_at TEXT NOT NULL,
  message_id TEXT,
  UNIQUE(announcement_id,vk_user_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER REFERENCES events(id),
  actor TEXT NOT NULL DEFAULT '',
  actor_vk_user_id TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id TEXT NOT NULL DEFAULT '',
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_event_created ON audit_log(event_id,created_at,id);

CREATE TABLE IF NOT EXISTS event_backup_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL REFERENCES events(id),
  created_by TEXT NOT NULL,
  file_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS event_app_settings (
  event_id INTEGER PRIMARY KEY REFERENCES events(id),
  welcome_message TEXT NOT NULL DEFAULT '',
  register_label TEXT NOT NULL DEFAULT 'Register / Get Pass',
  mypass_label TEXT NOT NULL DEFAULT 'My Pass',
  event_details_label TEXT NOT NULL DEFAULT 'Event Details',
  open_app_label TEXT NOT NULL DEFAULT 'Open EventHub',
  switch_event_label TEXT NOT NULL DEFAULT 'Switch Event',
  support_label TEXT NOT NULL DEFAULT 'Event Support',
  updated_at TEXT NOT NULL DEFAULT '',
  updated_by TEXT NOT NULL DEFAULT ''
);
