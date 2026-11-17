import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
const schema = await readFile(new URL("../cloudflare/schema.sql", import.meta.url), "utf8");
const frontend = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

test("entry and food actions use conditional updates to reject duplicate scans", () => {
  assert.match(worker, /UPDATE guests SET entry_used=1,entry_used_at=\? WHERE id=\? AND entry_used=0 AND status='approved'/);
  assert.match(worker, /UPDATE guests SET food_used=1,food_used_at=\? WHERE id=\? AND food_used=0 AND entry_used=1 AND status='approved'/);
});

test("proof return checks the conditional update result under concurrent scans", () => {
  assert.match(worker, /UPDATE proof_storage SET returned_at=\?,returned_by=\? WHERE guest_id=\? AND returned_at IS NULL/);
  assert.match(worker, /if\(!changed\.meta\.changes\) return fail\("Proof return was already recorded by another scanner\."/);
});

test("proof storage and checkpoint uniqueness are enforced by D1 indexes", () => {
  assert.match(schema, /CREATE UNIQUE INDEX[^;]*proof_storage[^;]*event_id[^;]*box_number[^;]*section_letter[^;]*slot_number/i);
  assert.ok(schema.includes("CREATE TABLE IF NOT EXISTS event_checkpoint_scans"));
  assert.ok(schema.includes("UNIQUE(checkpoint_id,guest_id)"));
});

test("exit requires proof return or a recorded no-proof decision", () => {
  assert.match(worker, /Return the guest's stored proof before completing exit/);
  assert.match(worker, /Record proof storage or confirm no proof was provided before completing exit/);
});

test("checkpoint scans are limited by role and attendance state", () => {
  assert.match(worker, /Your volunteer role does not include checkpoint scanning/);
  assert.match(worker, /Record guest entry before scanning an additional checkpoint/);
  assert.match(worker, /Additional checkpoint scans are disabled/);
  assert.match(worker, /status='approved' AND revoked_at IS NULL/);
});

test("scanner UI filters actions by the signed-in volunteer role", () => {
  assert.match(frontend, /const staffRole=state\.staffRole\|\|''/);
  assert.match(frontend, /staffRole==='entry'.*proof_no_proof/s);
  assert.match(frontend, /staffRole==='food'.*action==='food'/s);
  assert.match(frontend, /staffRole==='proof'.*proof_return/s);
  assert.match(frontend, /g\.entryUsed&&!g\.exitRecorded/);
});
