import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
globalThis.crypto ??= webcrypto;
import { verifyLaunchParams } from "../src/index.js";

const secret = "test-only-secret";
const appId = "123456";
async function signedParams(overrides = {}) {
  const values = {
    vk_app_id: appId,
    vk_user_id: "987654",
    vk_ts: String(Math.floor(Date.now() / 1000)),
    vk_platform: "android",
    vk_language: "en",
    ...overrides
  };
  const canonical = new URLSearchParams(Object.entries(values).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)).toString();
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical)));
  const sign = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return new URLSearchParams({ ...values, sign }).toString();
}
const env = { VK_APP_ID: appId, VK_APP_SECRET: secret };

test("accepts a correctly signed VK launch query", async () => {
  const raw = await signedParams();
  assert.equal(await verifyLaunchParams(raw, env), "987654");
});

test("rejects a modified user ID", async () => {
  const raw = await signedParams();
  const changed = raw.replace("vk_user_id=987654", "vk_user_id=111111");
  await assert.rejects(() => verifyLaunchParams(changed, env), /signature verification failed/);
});

test("rejects a stale launch timestamp", async () => {
  const raw = await signedParams({ vk_ts: String(Math.floor(Date.now() / 1000) - 7200) });
  await assert.rejects(() => verifyLaunchParams(raw, env), /expired/);
});

test("rejects a launch query for another app", async () => {
  const raw = await signedParams({ vk_app_id: "999999" });
  await assert.rejects(() => verifyLaunchParams(raw, env), /Unexpected VK application ID/);
});

test("rejects a missing signature", async () => {
  await assert.rejects(() => verifyLaunchParams("vk_user_id=987654&vk_app_id=123456", env), /incomplete/);
});
