import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;
import worker from "../src/index.js";

const secret = "backup-test-secret";
const appId = "123456";
const userId = "987654";
const event = {
  id: 7, name: "Backup Test Event", description: "Test", event_date: "2026-11-17",
  event_time: "18:00", venue: "Test Hall", theme_json: "{}", registration_schema: "[]",
  status: "active", active: 1, registration_open: 1, food_enabled: 1,
  timezone: "Europe/Moscow", sheets_url: "", created_by: userId,
  created_at: "2026-11-17T10:00:00.000Z", archived_at: null
};

async function signedLaunchParams() {
  const params = new URLSearchParams({
    vk_app_id: appId,
    vk_user_id: userId,
    vk_ts: String(Math.floor(Date.now() / 1000))
  });
  const canonical = new URLSearchParams([...params.entries()].sort(([a],[b]) => a.localeCompare(b))).toString();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)));
  const sign = Buffer.from(digest).toString("base64url");
  params.set("sign", sign);
  return params.toString();
}

function makeEnv({ admin = true } = {}) {
  const calls = [];
  const DB = {
    prepare(sql) {
      calls.push(sql);
      return {
        bind(...params) {
          return {
            async first() {
              if (sql.includes("FROM events WHERE id=?")) return event;
              if (sql.includes("FROM event_backup_snapshots")) return { n: 0 };
              if (sql.includes("FROM app_admins")) return admin ? null : null;
              return null;
            },
            async all() {
              if (sql.includes("FROM events WHERE id=? ORDER BY id")) return { results: [event] };
              return { results: [] };
            },
            async run() {
              if (sql.includes("INSERT INTO event_backup_snapshots")) return { meta: { last_row_id: 31, changes: 1 } };
              return { meta: { changes: 1 } };
            }
          };
        }
      };
    }
  };
  return {
    env: { DB, VK_APP_ID: appId, VK_APP_SECRET: secret, VK_ADMIN_IDS: admin ? userId : "" },
    calls
  };
}

test("admin backup endpoint returns an event-scoped JSON backup with a verifiable checksum", async () => {
  const { env, calls } = makeEnv({ admin: true });
  const request = new Request("https://eventhub.example/api/admin", {
    method: "POST",
    headers: { "content-type": "application/json", "X-VK-Launch-Params": await signedLaunchParams() },
    body: JSON.stringify({ action: "backup", event_id: event.id })
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-disposition") || "", /eventhub-backup-test-event-7-/);
  assert.match(response.headers.get("cache-control") || "", /no-store/);
  const backup = await response.json();
  assert.equal(backup.format, "eventhub-event-backup");
  assert.equal(backup.event_id, event.id);
  assert.deepEqual(backup.tables.events, [event]);
  assert.equal(backup.row_counts.events, 1);
  const payload = { ...backup };
  delete payload.sha256;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload))));
  assert.equal(backup.sha256, Buffer.from(digest).toString("hex"));
  assert.ok(calls.some(sql => sql.includes("INSERT INTO event_backup_snapshots")));
  assert.ok(calls.some(sql => sql.includes("INSERT INTO audit_log")));
  assert.ok(calls.filter(sql => sql.startsWith("SELECT")).length >= 20);
});

test("backup endpoint rejects a VK user who is not an administrator", async () => {
  const { env } = makeEnv({ admin: false });
  const request = new Request("https://eventhub.example/api/admin", {
    method: "POST",
    headers: { "content-type": "application/json", "X-VK-Launch-Params": await signedLaunchParams() },
    body: JSON.stringify({ action: "backup", event_id: event.id })
  });
  const response = await worker.fetch(request, env);
  assert.equal(response.status, 403);
  assert.match((await response.json()).detail, /Administrator access required/);
});
