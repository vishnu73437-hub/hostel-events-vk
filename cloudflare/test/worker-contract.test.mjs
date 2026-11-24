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
  assert.ok(source.includes('String(e.message).toLowerCase().includes("unique")'));
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

test("each event volunteer role has its explicit action permissions", () => {
  assert.match(source, /const roleActions = \{ entry:\["entry","proof_deposit","proof_no_proof"\], food:\["food"\], proof:\["proof_deposit","proof_no_proof","proof_return","exit"\], checkpoint:\[\], scanner:\[\.\.\.allowed\], event_lead:\[\.\.\.allowed\], admin:\[\.\.\.allowed\] \}/);
  const scanStart = source.indexOf("async function checkpointScanApi");
  const scanEnd = source.indexOf("async function adminApi", scanStart);
  const scanHandler = source.slice(scanStart, scanEnd);
  assert.ok(scanHandler.includes('["admin","scanner","event_lead","checkpoint"]'));
  assert.ok(scanHandler.includes("event_checkpoint_assignments WHERE event_id=? AND checkpoint_id=? AND vk_user_id=?"));
  const checkpointStart = source.indexOf("async function checkpointsApi");
  const checkpointEnd = source.indexOf("async function checkpointScanApi", checkpointStart);
  const checkpointHandler = source.slice(checkpointStart, checkpointEnd);
  assert.ok(checkpointHandler.includes('["admin","scanner","event_lead","checkpoint"]'));
  assert.ok(checkpointHandler.includes("event_checkpoint_assignments"));
});

test("registration-to-pass lifecycle enforces approval and active QR identity", () => {
  const start = source.indexOf("async function registerApi");
  const end = source.indexOf("async function myPassApi", start);
  const registration = source.slice(start, end);
  assert.ok(registration.includes("INSERT INTO pending_registrations"));
  assert.ok(registration.includes("status='pending'"));
  assert.ok(registration.includes("Enter a valid phone number"));
  assert.ok(registration.includes("requestedResidence !== \"Hostel\""));
  const adminApproval = source.slice(source.indexOf('if(action==="registration_decision")'), source.indexOf('if(action==="guest_action")'));
  assert.ok(adminApproval.includes('["approve","reject"]'));
  assert.ok(adminApproval.includes("INSERT INTO guests"));
  assert.ok(adminApproval.includes("crypto.getRandomValues(new Uint8Array(32))"));
  const passStart = source.indexOf("async function myPassApi");
  const passEnd = source.indexOf("async function guestLookupApi", passStart);
  const passHandler = source.slice(passStart, passEnd);
  assert.ok(passHandler.includes('guest.status !== "approved" || guest.revoked_at'));
  assert.ok(passHandler.includes('qr.addData("EVENTHUB:"'));
});

test("entry, food, proof and exit actions enforce prerequisites and single-use state", () => {
  const start = source.indexOf("async function actionApi");
  const end = source.indexOf("async function checkpointsApi", start);
  const handler = source.slice(start, end);
  assert.ok(handler.includes("guest.entry_used"));
  assert.ok(handler.includes("guest.food_used"));
  assert.ok(handler.includes("Proof storage is full"));
  assert.ok(handler.includes("UPDATE guests SET entry_used=1"));
  assert.ok(handler.includes("UPDATE guests SET food_used=1"));
  assert.ok(handler.includes("event_exit_records"));
  assert.ok(handler.includes("UNIQUE") || handler.includes("already recorded"));
});


test("successful attendance actions refresh the current Google Sheets guest row", () => {
  assert.match(source, /async function queueGuestSheetsState\(env,eventId,guestId\)/);
  assert.match(source, /outbox\(env,eventId,guestId,"upsert"/);
  const start = source.indexOf("async function actionApi");
  const end = source.indexOf("async function checkpointsApi", start);
  const handler = source.slice(start, end);
  assert.ok(handler.includes("await queueGuestSheetsState(env,eventId,guest.id)"));
});

test("duplicate attendance attempts stay auditable and re-sync without duplicating actions", () => {
  assert.match(source, /async function rejectGuestAction\(/);
  assert.ok(source.includes('action.toUpperCase()+"_SKIPPED"'));
  assert.ok(source.includes('return rejectGuestAction(env,uid,eventId,guest,action,"Entry already recorded for this pass.")'));
  assert.ok(source.includes('return rejectGuestAction(env,uid,eventId,guest,action,"Food collection already recorded for this pass.")'));
});

test("checkpoint success and duplicate attempts keep the guest sheet row current", () => {
  const start = source.indexOf("async function checkpointScanApi");
  const end = source.indexOf("async function adminApi", start);
  const handler = source.slice(start, end);
  assert.ok(handler.includes("await queueGuestSheetsState(env,eventId,guest.id)"));
  assert.ok(handler.includes('rejectGuestAction(env,uid,eventId,guest,"checkpoint_scan"'));
});


test("iOS VK scanner uses a QR decoding fallback and a camera/photo picker", () => {
  assert.ok(source.includes("function ensureQrDecoder()"));
  assert.ok(source.includes("function scanQrPhoto(file)"));
  assert.ok(source.includes("window.jsQR"));
  assert.ok(source.includes("getImageData(0,0"));
  assert.ok(source.includes("inversionAttempts:'attemptBoth'"));
  assert.ok(source.includes("qrPhotoInput"));
  assert.ok(source.includes("scanFromPhoto"));
  assert.ok(source.includes("getUserMedia!=='function'"));
  assert.ok(!source.includes("!('BarcodeDetector' in window)"), "native BarcodeDetector must not be a hard requirement");
});

test("QR decoder fallback is served same-origin and scanner access remains role-restricted", () => {
  assert.ok(source.includes("async function serveQrDecoder(request,ctx)"));
  assert.ok(source.includes('url.pathname==="/qr-decoder.js"'));
  assert.ok(source.includes("https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js"));
  assert.ok(source.includes("https://fastly.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js"));
  assert.ok(!source.includes("cdnjs.cloudflare.com/ajax/libs/jsQR"), "decoder source must use a confirmed jsQR CDN path");
  const scannerStart = source.indexOf("async function renderScanner(host)");
  const scannerEnd = source.indexOf("let scannerStartGeneration", scannerStart);
  assert.ok(scannerStart >= 0 && scannerEnd > scannerStart, "scanner view should exist");
  const scannerView = source.slice(scannerStart, scannerEnd);
  assert.ok(scannerView.includes("state.role!=='admin'&&state.role!=='volunteer'"), "camera and photo scanning must remain restricted to volunteers/admins");
});
