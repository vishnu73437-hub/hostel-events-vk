import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const frontend = await readFile(new URL("../public/index.html", import.meta.url), "utf8");

function inlineApplicationScript(html) {
  const start = html.indexOf("<script>");
  assert.notEqual(start, -1, "frontend must include its application script");
  const contentStart = start + "<script>".length;
  const end = html.indexOf("</script>", contentStart);
  assert.notEqual(end, -1, "frontend application script must be closed");
  return html.slice(contentStart, end);
}

test("frontend inline JavaScript parses", () => {
  assert.doesNotThrow(() => new vm.Script(inlineApplicationScript(frontend), {
    filename: "public/index.html:inline-script"
  }));
});

test("language selector exposes English and Russian and persists the selection", () => {
  assert.ok(frontend.includes('id="languageSelect"'));
  assert.ok(frontend.includes('<option value="en">English</option>'));
  assert.ok(frontend.includes('<option value="ru">Русский</option>'));
  assert.ok(frontend.includes("eventhub.language.v1"));
  assert.ok(frontend.includes("navigator.language"));
  assert.ok(frontend.includes("function setLanguage("));
});

test("Russian dictionary covers core guest and volunteer flows", () => {
  for (const phrase of [
    "Register now", "Submit registration", "My QR pass", "Start camera",
    "Record entry", "Record food collection", "Record exit",
    "Pending registrations", "Guest register", "Proof storage"
  ]) assert.ok(frontend.includes(phrase), `missing source phrase: ${phrase}`);
  assert.ok(frontend.includes("'Register now':'Зарегистрироваться'"));
  assert.ok(frontend.includes("'Start camera':'Включить камеру'"));
  assert.ok(frontend.includes("'Record entry':'Отметить вход'"));
});

test("scanner start is guarded against overlapping and stale permission requests", () => {
  for (const fragment of [
    "let scannerStartGeneration=0",
    "let scannerStartPending=false",
    "state.scanner?.active||scannerStartPending",
    "generation!==scannerStartGeneration",
    "scannerStartGeneration++",
    "scanner.active&&state.scanner===scanner"
  ]) assert.ok(frontend.includes(fragment), `missing scanner safeguard: ${fragment}`);
});

test("offline QR queue clearly distinguishes saved scans from attendance", () => {
  assert.ok(frontend.toLowerCase().includes("not attendance records"));
  assert.ok(frontend.toLowerCase().includes("verify each pass and record its action"));
  assert.ok(frontend.includes("eventhub-offline-scans-v1"));
});
test("VK Bridge CDN cannot block the EventHub application startup", () => {
  const bridgeTag = frontend.match(/<script[^>]*id="vkBridgeScript"[^>]*>/)?.[0] || "";
  assert.ok(bridgeTag, "VK Bridge script must have a stable element ID");
  assert.match(bridgeTag, /\basync\b/, "VK Bridge must load asynchronously");
  assert.ok(frontend.includes("addEventListener('load', initializeVkBridge"), "VK initialization must run when the async bridge becomes available");
});
