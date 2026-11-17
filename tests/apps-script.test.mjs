import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const receiver = await readFile(new URL("../google-apps-script/Code.gs", import.meta.url), "utf8");
const worker = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

test("Apps Script receiver is valid JavaScript and exposes v5 health endpoint", () => {
  assert.doesNotThrow(() => new Function(receiver));
  assert.match(receiver, /function doGet\(\)/);
  assert.match(receiver, /service:"EventHub Google Sheets Sync",version:Number\(EH_VERSION\)/);
  assert.match(receiver, /const EH_VERSION = "5"/);
});

test("Apps Script receiver authenticates and isolates both supported actions by event_id", () => {
  assert.match(receiver, /SCRIPT_SECRET/);
  assert.match(receiver, /action !== "upsert" && action !== "event_log"/);
  assert.match(receiver, /A positive event_id is required/);
  assert.match(receiver, /ehTabName_\("Guests",eventId\)/);
  assert.match(receiver, /ehTabName_\("Event Log",eventId\)/);
  assert.match(receiver, /matchEntireCell\(true\)/);
});

test("worker uses one stable VK-based guest key for pending, approved and event-log sheet rows", () => {
  assert.match(worker, /guest_id:"event:"\+eventId\+":vk:"\+guest\.vk_user_id/);
  assert.equal((worker.match(/guest_id:snapshot\.guest_id/g) || []).length, 2);
  assert.equal(worker.split('action:"event_log",action_id:crypto.randomUUID(),event_id:eventId').length - 1, 2);
});

test("event-log retry updates live tabs but deduplicates append-only actions", () => {
  assert.match(receiver, /ehUpsertEvent_\(ss,eventId,snapshot\)/);
  assert.match(receiver, /if \(match\) return; \/\/ idempotent retry/);
  assert.match(receiver, /last_updated = actionTime/);
  assert.match(receiver, /newTime < oldTime/);
});

test("obsolete unscoped legacy API routes and implicit event creation are removed", () => {
  assert.doesNotMatch(worker, /\/api\/bootstrap/);
  assert.doesNotMatch(worker, /\/api\/scan/);
  assert.doesNotMatch(worker, /async function activeEvent/);
  assert.doesNotMatch(worker, /async function requireStaff/);
});
