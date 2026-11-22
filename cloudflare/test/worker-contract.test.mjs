import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, "worker.js"), "utf8");
const qrModule = readFileSync(join(root, "qrcode.mjs"), "utf8");

test("worker imports the bundled QR implementation", () => {
  assert.match(source, /import qrcode from ["']\.\/qrcode\.mjs["']/);
  assert.ok(qrModule.length > 1000);
});

test("production API routes are registered", () => {
  for (const route of [
    "/api/health", "/api/platform_status", "/api/role", "/api/admin",
    "/api/event_details", "/api/register", "/api/my_pass", "/api/guest",
    "/api/action", "/api/checkpoints", "/api/checkpoint_scan",
    "/api/pass_download_prepare"
  ]) {
    assert.ok(source.includes(route), "missing route " + route);
  }
});

test("VK launch authentication validates app ID, signature and timestamp", () => {
  assert.match(source, /function verifyLaunchParams\(raw, env\)/);
  assert.ok(source.includes("VK_APP_SECRET"));
  assert.ok(source.includes("VK_APP_ID"));
  assert.ok(source.includes("vk_ts"));
  assert.ok(source.includes("nowSeconds - ts > 3600"));
  assert.ok(source.includes("safeEqual(expected, sign)"));
});

test("platform status uses current event-scoped tables", () => {
  const start = source.indexOf("async function platformStatusApi");
  const end = source.indexOf("async function passDownloadTokenHash", start);
  assert.ok(start >= 0 && end > start, "platform status handler not found");
  const handler = source.slice(start, end);
  assert.ok(handler.includes("FROM guests WHERE status='pending'"));
  assert.ok(handler.includes("FROM event_checkpoint_scans"));
  assert.ok(handler.includes("FROM event_volunteers"));
  assert.ok(!handler.includes("FROM pending_registrations WHERE status='pending'"));
  assert.ok(!handler.includes("FROM scans) AS scans"));
  assert.ok(!handler.includes("FROM volunteers WHERE active=1"));
});

test("scheduled processing runs the Sheets queue in bounded batches", () => {
  assert.match(source, /async scheduled\(controller, env\)\s*\{\s*await syncSheetsBatch\(env,\s*10\)/);
  assert.ok(source.includes("action='ensure_event'"));
  assert.ok(source.includes("sheets_outbox"));
});

test("event volunteer access is event-scoped", () => {
  assert.ok(source.includes("event_volunteers WHERE event_id=? AND vk_user_id=?"));
  for (const role of ["entry", "food", "proof", "checkpoint", "scanner", "event_lead"]) {
    assert.ok(source.includes('"' + role + '"') || source.includes("'" + role + "'"), "missing role " + role);
  }
});

test("checkpoint scanning enforces active passes and unique checkpoint scans", () => {
  assert.ok(source.includes("status='approved' AND revoked_at IS NULL"));
  assert.ok(source.includes("event_checkpoint_assignments"));
  assert.ok(source.includes("event_checkpoint_scans"));
  assert.ok(source.includes("UNIQUE(checkpoint_id,guest_id)") || source.includes("INSERT OR IGNORE"));
});

test("offline queue does not present unverified captures as attendance", () => {
  assert.ok(source.includes("eventhub-offline-scans-v1"));
  assert.ok(source.includes("not attendance records"));
  assert.ok(source.includes("Verify when online"));
});

test("backup exports contain a cryptographic digest and event-scoped records", () => {
  assert.ok(source.includes("eventhub-event-backup"));
  assert.ok(source.includes('crypto.subtle.digest("SHA-256"'));
  assert.ok(source.includes("event_backup_snapshots"));
  assert.ok(source.includes("SELECT * FROM guests WHERE event_id=? ORDER BY id"));
});

test("announcements fail closed when the VK group secret is absent", () => {
  assert.ok(source.includes("if(!env.VK_GROUP_TOKEN)"));
  assert.ok(source.includes("VK group messaging is not configured"));
});

test("health route is public, while platform status is admin-only", () => {
  assert.match(source, /path === ["']\/api\/health["'] && method === ["']GET["']/);
  assert.match(source, /async function platformStatusApi\(request, env\)\s*\{\s*await requireAdmin\(request,env\)/);
});
