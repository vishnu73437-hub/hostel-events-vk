import sqlite3
from pathlib import Path

schema = Path("cloudflare/schema.sql").read_text(encoding="utf-8")
db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
db.executescript(schema)

tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
required = {
    "events", "guests", "pending_registrations", "app_users", "app_admins",
    "event_volunteers", "event_checkpoints", "event_checkpoint_assignments",
    "event_checkpoint_scans", "event_storage_configs", "proof_storage",
    "proof_not_collected", "event_exit_records", "sheets_outbox",
    "event_announcements", "announcement_deliveries", "audit_log"
}
assert required <= tables, f"Missing tables: {required - tables}"

# Same VK user may participate in separate events, but not register twice in one event.
event_a = db.execute("INSERT INTO events(name,created_at,status,active) VALUES('A','now','active',1)").lastrowid
event_b = db.execute("INSERT INTO events(name,created_at,status,active) VALUES('B','now','active',1)").lastrowid
guest_a = db.execute(
    "INSERT INTO guests(event_id,vk_user_id,full_name,registered_at) VALUES(?,?,?,?)",
    (event_a, "vk-123", "Test User", "now")
).lastrowid
db.execute(
    "INSERT INTO guests(event_id,vk_user_id,full_name,registered_at) VALUES(?,?,?,?)",
    (event_b, "vk-123", "Test User", "now")
)
try:
    db.execute(
        "INSERT INTO guests(event_id,vk_user_id,full_name,registered_at) VALUES(?,?,?,?)",
        (event_a, "vk-123", "Duplicate", "now")
    )
    raise AssertionError("Duplicate registration in one event was accepted")
except sqlite3.IntegrityError:
    pass

# Legacy Telegram IDs remain in their own field and are never treated as VK IDs.
legacy_id = db.execute(
    "INSERT INTO guests(event_id,legacy_telegram_id,full_name,registered_at) VALUES(?,?,?,?)",
    (event_a, "998877", "Legacy User", "now")
).lastrowid
legacy = db.execute("SELECT vk_user_id,legacy_telegram_id FROM guests WHERE id=?", (legacy_id,)).fetchone()
assert legacy == (None, "998877")

# A checkpoint can only be recorded once for a given guest.
checkpoint = db.execute(
    "INSERT INTO event_checkpoints(event_id,name,created_at) VALUES(?,?,?)",
    (event_a, "Entry", "now")
).lastrowid
db.execute(
    "INSERT INTO event_checkpoint_scans(event_id,checkpoint_id,guest_id,volunteer_vk_user_id,scanned_at) VALUES(?,?,?,?,?)",
    (event_a, checkpoint, guest_a, "vk-staff", "now")
)
try:
    db.execute(
        "INSERT INTO event_checkpoint_scans(event_id,checkpoint_id,guest_id,volunteer_vk_user_id,scanned_at) VALUES(?,?,?,?,?)",
        (event_a, checkpoint, guest_a, "vk-staff-2", "later")
    )
    raise AssertionError("Duplicate checkpoint scan was accepted")
except sqlite3.IntegrityError:
    pass

# Active proof-storage slots are unique; returned slots can be reused.
db.execute(
    "INSERT INTO proof_storage(event_id,guest_id,box_number,section_letter,slot_number,assigned_at,assigned_by) VALUES(?,?,?,?,?,?,?)",
    (event_a, guest_a, 1, "A", 1, "now", "vk-staff")
)
guest_b = db.execute(
    "INSERT INTO guests(event_id,vk_user_id,full_name,registered_at) VALUES(?,?,?,?)",
    (event_a, "vk-456", "Second User", "now")
).lastrowid
try:
    db.execute(
        "INSERT INTO proof_storage(event_id,guest_id,box_number,section_letter,slot_number,assigned_at,assigned_by) VALUES(?,?,?,?,?,?,?)",
        (event_a, guest_b, 1, "A", 1, "now", "vk-staff")
    )
    raise AssertionError("Duplicate active storage slot was accepted")
except sqlite3.IntegrityError:
    pass
db.execute("UPDATE proof_storage SET returned_at='later' WHERE guest_id=?", (guest_a,))
db.execute(
    "INSERT INTO proof_storage(event_id,guest_id,box_number,section_letter,slot_number,assigned_at,assigned_by) VALUES(?,?,?,?,?,?,?)",
    (event_a, guest_b, 1, "A", 1, "later", "vk-staff")
)

print("EventHub D1 schema checks passed.")
