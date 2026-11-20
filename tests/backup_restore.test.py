import hashlib
import json
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "restore_event_backup.py"
SCHEMA = ROOT / "cloudflare" / "schema.sql"
TABLE_ORDER = [
    "events", "app_users", "guests", "pending_registrations", "event_app_users",
    "event_volunteers", "event_checkpoints", "event_checkpoint_assignments", "scans",
    "event_checkpoint_scans", "event_storage_configs", "proof_storage", "proof_not_collected",
    "event_exit_records", "pass_design", "sheets_outbox", "event_announcements", "event_notices",
    "announcement_deliveries", "audit_log", "event_backup_snapshots", "event_app_settings",
]


def make_backup():
    db = sqlite3.connect(":memory:")
    db.execute("PRAGMA foreign_keys=ON")
    db.executescript(SCHEMA.read_text(encoding="utf-8"))
    event_id = db.execute(
        "INSERT INTO events(name,created_at) VALUES(?,?)", ("Backup Test Event", "2026-11-17T10:00:00Z")
    ).lastrowid
    event = dict(zip([x[1] for x in db.execute("PRAGMA table_info(events)")],
                     db.execute("SELECT * FROM events WHERE id=?", (event_id,)).fetchone()))
    notice_id = db.execute(
        "INSERT INTO event_notices(event_id,title,message,created_by,created_at) VALUES(?,?,?,?,?)",
        (event_id, "Test notice", "Welcome, don't forget your pass", "vk-admin", "2026-11-17T10:00:00Z")
    ).lastrowid
    notice = dict(zip([x[1] for x in db.execute("PRAGMA table_info(event_notices)")],
                      db.execute("SELECT * FROM event_notices WHERE id=?", (notice_id,)).fetchone()))
    tables = {table: [] for table in TABLE_ORDER}
    tables["events"] = [event]
    tables["event_notices"] = [notice]
    backup = {
        "format": "eventhub-event-backup",
        "version": 1,
        "file_name": "eventhub-backup-test.json",
        "created_at": "2026-11-17T10:01:00Z",
        "event_id": event_id,
        "event": event,
        "tables": tables,
        "row_counts": {table: len(rows) for table, rows in tables.items()},
        "security_notice": "test",
    }
    canonical = json.dumps(backup, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    backup["sha256"] = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    db.close()
    return backup


class BackupRestoreTests(unittest.TestCase):
    def test_valid_backup_generates_sql_that_restores(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            backup_path = root / "backup.json"
            sql_path = root / "restore.sql"
            backup_path.write_text(json.dumps(make_backup(), ensure_ascii=False), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(backup_path), "--output", str(sql_path)],
                capture_output=True, text=True,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Validated", result.stdout)
            generated_sql = sql_path.read_text(encoding="utf-8")
            self.assertNotIn("BEGIN TRANSACTION", generated_sql)
            self.assertNotIn("COMMIT;", generated_sql)
            self.assertNotIn("PRAGMA foreign_keys", generated_sql)
            target = sqlite3.connect(":memory:")
            target.execute("PRAGMA foreign_keys=ON")
            target.executescript(SCHEMA.read_text(encoding="utf-8"))
            target.executescript(sql_path.read_text(encoding="utf-8"))
            self.assertEqual(target.execute("SELECT name FROM events").fetchone()[0], "Backup Test Event")
            self.assertEqual(target.execute("SELECT message FROM event_notices").fetchone()[0], "Welcome, don't forget your pass")
            target.close()

    def test_modified_backup_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            backup_path = Path(directory) / "tampered.json"
            backup = make_backup()
            backup["event"]["name"] = "Changed after export"
            backup_path.write_text(json.dumps(backup, ensure_ascii=False), encoding="utf-8")
            result = subprocess.run(
                [sys.executable, str(SCRIPT), str(backup_path)],
                capture_output=True, text=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("SHA-256 checksum does not match", result.stderr)


if __name__ == "__main__":
    unittest.main()
