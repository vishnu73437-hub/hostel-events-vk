import sqlite3
from pathlib import Path

schema = Path("cloudflare/schema.sql").read_text(encoding="utf-8")
db = sqlite3.connect(":memory:")
db.execute("PRAGMA foreign_keys=ON")
db.executescript(schema)

tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
required = {
    "events", "guests", "pending_registrations", "app_users", "event_app_users", "app_admins",
    "event_volunteers", "event_checkpoints", "event_checkpoint_assignments", "scans",
    "event_checkpoint_scans", "event_storage_configs", "proof_storage",
    "proof_not_collected", "event_exit_records", "pass_design", "sheets_outbox",
    "event_announcements", "event_notices", "announcement_deliveries", "audit_log", "event_backup_snapshots",
    "event_app_settings"
}
assert required <= tables, f"Missing tables: {required - tables}"

event_columns = {row[1]: row for row in db.execute("PRAGMA table_info(events)")}
for flag in ("entry_enabled", "proof_storage_enabled", "exit_enabled"):
    assert flag in event_columns, f"Missing event workflow flag: {flag}"
    assert event_columns[flag][3] == 1 and event_columns[flag][4] == "1", f"{flag} must default to enabled"

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

# Fresh EventHub records must carry a verified VK identity; there are no Telegram identity columns.
for table in ("guests", "pending_registrations"):
    columns = {row[1]: row for row in db.execute(f"PRAGMA table_info({table})")}
    assert "legacy_telegram_id" not in columns, f"{table} must not contain Telegram identity data"
    assert columns["vk_user_id"][3] == 1, f"{table}.vk_user_id must be NOT NULL"
    try:
        db.execute(
            f"INSERT INTO {table}(event_id,full_name,registered_at) VALUES(?,?,?)" if table == "guests"
            else f"INSERT INTO {table}(event_id,full_name,created_at) VALUES(?,?,?)",
            (event_a, "Missing VK identity", "now")
        )
        raise AssertionError(f"{table} accepted a record without a VK user ID")
    except sqlite3.IntegrityError:
        pass

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
