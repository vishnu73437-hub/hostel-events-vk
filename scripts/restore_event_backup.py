#!/usr/bin/env python3
"""Validate an EventHub JSON backup and generate SQL for an EMPTY Cloudflare D1 database.

This tool never connects to Cloudflare and never executes SQL. Review the output,
verify the target D1 database is empty, then apply it manually with Wrangler.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sqlite3
import sys
from pathlib import Path

TABLE_ORDER = [
    "events",
    "app_users",
    "guests",
    "pending_registrations",
    "event_app_users",
    "event_volunteers",
    "event_checkpoints",
    "event_checkpoint_assignments",
    "scans",
    "event_checkpoint_scans",
    "event_storage_configs",
    "proof_storage",
    "proof_not_collected",
    "event_exit_records",
    "pass_design",
    "sheets_outbox",
    "event_announcements",
    "announcement_deliveries",
    "audit_log",
    "event_backup_snapshots",
    "event_app_settings",
]


def fail(message: str) -> None:
    raise SystemExit(f"Backup restore refused: {message}")


def sql_value(value: object) -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            fail("backup contains a non-finite number")
        return repr(value)
    if isinstance(value, str):
        return "'" + value.replace("'", "''") + "'"
    fail(f"unsupported SQL value type: {type(value).__name__}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("backup", type=Path, help="Downloaded EventHub .json backup")
    parser.add_argument("-o", "--output", type=Path, help="SQL output path (default: <backup>.restore.sql)")
    args = parser.parse_args()

    try:
        raw = args.backup.read_text(encoding="utf-8")
        backup = json.loads(raw)
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        fail(f"cannot read valid UTF-8 JSON: {exc}")

    if not isinstance(backup, dict) or backup.get("format") != "eventhub-event-backup" or backup.get("version") != 1:
        fail("unsupported backup format/version")
    supplied_hash = backup.get("sha256")
    if not isinstance(supplied_hash, str) or len(supplied_hash) != 64:
        fail("missing or malformed SHA-256 checksum")
    hash_payload = dict(backup)
    hash_payload.pop("sha256", None)
    canonical = json.dumps(hash_payload, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    actual_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    if actual_hash.lower() != supplied_hash.lower():
        fail("SHA-256 checksum does not match; the backup may be damaged or modified")

    event_id = backup.get("event_id")
    if not isinstance(event_id, int) or event_id <= 0:
        fail("invalid event_id")
    tables = backup.get("tables")
    if not isinstance(tables, dict):
        fail("missing tables object")
    missing = set(TABLE_ORDER) - set(tables)
    extra = set(tables) - set(TABLE_ORDER)
    if missing:
        fail("backup is missing tables: " + ", ".join(sorted(missing)))
    if extra:
        fail("backup contains unexpected tables: " + ", ".join(sorted(extra)))

    schema_path = Path(__file__).resolve().parents[1] / "cloudflare" / "schema.sql"
    try:
        schema = schema_path.read_text(encoding="utf-8")
    except OSError as exc:
        fail(f"cannot read repository schema {schema_path}: {exc}")

    validation_db = sqlite3.connect(":memory:")
    validation_db.execute("PRAGMA foreign_keys=ON")
    try:
        validation_db.executescript(schema)
        statements: list[str] = []
        total = 0
        for table in TABLE_ORDER:
            rows = tables[table]
            if not isinstance(rows, list):
                fail(f"table {table} must contain an array")
            for row in rows:
                if not isinstance(row, dict):
                    fail(f"table {table} contains a non-object row")
                columns = [info[1] for info in validation_db.execute(f"PRAGMA table_info({table})")]
                if not columns or set(row) != set(columns):
                    fail(f"table {table} row columns do not match the current schema")
                values = [row[column] for column in columns]
                placeholders = ",".join("?" for _ in columns)
                validation_db.execute(
                    f"INSERT INTO {table} ({','.join(columns)}) VALUES ({placeholders})",
                    values,
                )
                sql_columns = ",".join('"' + column.replace('"', '""') + '"' for column in columns)
                sql_values = ",".join(sql_value(value) for value in values)
                statements.append(f'INSERT INTO "{table}" ({sql_columns}) VALUES ({sql_values});')
                total += 1
        event_rows = tables["events"]
        if len(event_rows) != 1 or event_rows[0].get("id") != event_id:
            fail("backup must contain exactly its selected event")
        if backup.get("event", {}).get("id") != event_id:
            fail("event metadata does not match event_id")
        validation_db.commit()
    except (sqlite3.Error, KeyError, TypeError, ValueError) as exc:
        fail(f"backup data failed schema/relationship validation: {exc}")
    finally:
        validation_db.close()

    output = args.output or args.backup.with_suffix(".restore.sql")
    header = (
        "-- EventHub event backup restore generated locally.\n"
        f"-- Event ID: {event_id}\n"
        f"-- Event: {backup.get('event', {}).get('name', '')}\n"
        f"-- Source SHA-256: {supplied_hash}\n"
        f"-- Rows: {total}\n"
        "-- IMPORTANT: Apply only to a newly-created, EMPTY EventHub D1 database.\n"
        "-- This file does not create the schema or restore Worker secrets/admin allowlists.\n"
        "PRAGMA foreign_keys = ON;\n"
    )
    try:
        output.write_text(header + "\n".join(statements) + "\n", encoding="utf-8")
    except OSError as exc:
        fail(f"cannot write SQL output: {exc}")

    print(f"Validated {total} rows for event {event_id}.")
    print(f"SQL restore file: {output}")
    print("No Cloudflare connection was made and no database was changed.")


if __name__ == "__main__":
    main()
