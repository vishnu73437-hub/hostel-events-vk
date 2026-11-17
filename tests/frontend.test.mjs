import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const frontend = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

function inlineApplicationScript(html) {
  const scripts = [...html.matchAll(/<script>([\\s\\S]*?)<\\/script>/g)];
  assert.ok(scripts.length, "frontend must include its application script");
  return scripts[scripts.length - 1][1];
}

test("frontend inline JavaScript parses", () => {
  assert.doesNotThrow(() => new vm.Script(inlineApplicationScript(frontend), {
    filename: "public/index.html:inline-script"
  }));
});

test("language selector exposes English and Russian and persists the selection", () => {
  assert.match(frontend, /id="languageSelect"/);
  assert.match(frontend, /<option value="en">English<\\/option>/);
  assert.match(frontend, /<option value="ru">Русский<\\/option>/);
  assert.match(frontend, /eventhub\\.language\\.v1/);
  assert.match(frontend, /navigator\\.language/);
  assert.match(frontend, /function setLanguage\\(/);
});

test("Russian dictionary covers core guest and volunteer flows", () => {
  for (const phrase of [
    "Register now", "Submit registration", "My QR pass", "Start camera",
    "Record entry", "Record food collection", "Record exit",
    "Pending registrations", "Guest register", "Proof storage"
  ]) assert.ok(frontend.includes(phrase), `missing source phrase: ${phrase}`);
  assert.match(frontend, /'Register now':'Зарегистрироваться'/);
  assert.match(frontend, /'Start camera':'Включить камеру'/);
  assert.match(frontend, /'Record entry':'Отметить вход'/);
});

test("scanner start is guarded against overlapping and stale permission requests", () => {
  assert.match(frontend, /let scannerStartGeneration=0/);
  assert.match(frontend, /let scannerStartPending=false/);
  assert.match(frontend, /state\\.scanner\\?\\.active\\|\\|scannerStartPending/);
  assert.match(frontend, /generation!==scannerStartGeneration/);
  assert.match(frontend, /scannerStartGeneration\\+\\+/);
  assert.match(frontend, /scanner\\.active&&state\\.scanner===scanner/);
});

test("offline QR queue clearly distinguishes saved scans from attendance", () => {
  assert.match(frontend, /not attendance records/i);
  assert.match(frontend, /verify each pass and record its action/i);
  assert.match(frontend, /eventhub-offline-scans-v1/);
});
