import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const frontend = await readFile(new URL("../public/index.html", import.meta.url), "utf8");
const backend = await readFile(new URL("../src/index.js", import.meta.url), "utf8");

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
test("Russian translations cover dashboard, admin, volunteer, scanner and storage screens", () => {
  for (const [source, translated] of [
    ["Event overview", "Обзор мероприятия"],
    ["Google Sheets sync", "Синхронизация с Google Таблицами"],
    ["Registration form builder", "Конструктор регистрационной формы"],
    ["Event volunteer access", "Доступ волонтёров к мероприятию"],
    ["Proof storage", "Хранение вещей"],
    ["Announcement history", "История объявлений"],
    ["Automatic database recovery", "Автоматическое восстановление базы данных"],
    ["The server took too long to respond. Check the connection and try again.", "Сервер слишком долго не отвечает."],
    ["Could not reach EventHub. Check your internet connection and Cloudflare API address.", "Не удалось подключиться к EventHub."]
  ]) {
    assert.ok(frontend.includes(source), `missing English UI phrase: ${source}`);
    assert.ok(frontend.includes(translated), `missing Russian translation: ${translated}`);
  }
});

test("toast messages and native confirmation dialogs use the selected language", () => {
  assert.ok(frontend.includes("translateLanguageText(el.__eventHubToastSource)"));
  assert.ok(frontend.includes("function confirmLocalized(message)"));
  assert.ok(frontend.includes("function promptLocalized(message"));
  assert.ok(frontend.includes("confirmLocalized("));
});

test("mobile admin navigation is accessible and keeps desktop navigation", () => {
  assert.ok(frontend.includes('admin-nav-desktop'));
  assert.ok(frontend.includes('admin-nav-mobile'));
  assert.ok(frontend.includes('id="adminMobileNav"'));
  assert.ok(frontend.includes("bindMobileAdminNav()"));
  assert.ok(frontend.includes('class="skip-link"'));
  assert.ok(frontend.includes(":focus-visible"));
  assert.ok(frontend.includes("prefers-reduced-motion:reduce"));
});

test("admin dashboard preview is compact and its metrics navigate to relevant screens", () => {
  assert.ok(frontend.includes('<details class="section card admin-preview">'));
  assert.ok(frontend.includes('class="stat stat-link"'));
  assert.ok(frontend.includes('data-admin-page="guests"'));
  assert.ok(frontend.includes('data-admin-page="staff"'));
});

test("scanner activity distinguishes verification from confirmed attendance", () => {
  assert.ok(frontend.includes("function addRecentScannerActivity("));
  assert.ok(frontend.includes("This list is only for this open app session."));
  assert.ok(frontend.includes("Verification only — no attendance action was recorded yet."));
  assert.ok(frontend.includes("Offline QR saved on this device only"));
  assert.ok(frontend.includes("setScannerStatus(r.message||'Action recorded successfully.','good')"));
  assert.ok(frontend.includes("aria-live=\"polite\""));
});

test("volunteer screen supports name/ID search, role filters and event activity", () => {
  assert.ok(frontend.includes('id="volunteerSearch"'));
  assert.ok(frontend.includes('id="volunteerRoleFilter"'));
  assert.ok(frontend.includes("adminCall('audit')"));
  assert.ok(frontend.includes("Recently active"));
  assert.ok(frontend.includes("No recorded volunteer activity for this event yet."));
});

test("guest profile timeline is loaded through an event-scoped read-only admin action", () => {
  assert.ok(frontend.includes('data-guest-profile='));
  assert.ok(frontend.includes("adminCall('guest_profile'"));
  assert.ok(frontend.includes("Attendance timeline"));
  assert.ok(backend.includes('if(action==="guest_profile")'));
  assert.ok(backend.includes("WHERE id=? AND event_id=?"));
  assert.ok(backend.includes("target_type='guest' AND target_id=?"));
  assert.ok(backend.includes("return json({ok:true,guest,proof:proof||null,noProof:!!noProof,exitRecorded:!!exitRow,timeline:timeline.slice(0,100)})"));
});

test("new mobile, scanner, guest and volunteer controls have Russian text", () => {
  for (const [source, translated] of [
    ["Go to section", "Перейти к разделу"],
    ["Recent scanner activity", "Последняя активность сканера"],
    ["Recent volunteer activity", "Последняя активность волонтёров"],
    ["Attendance timeline", "Хронология посещения"],
    ["Search by name or VK ID", "Поиск по имени или VK ID"],
    ["Filter by role", "Фильтр по роли"],
    ["Pass verified", "Пропуск проверен"],
    ["Entry recorded", "Вход отмечен"]
  ]) {
    assert.ok(frontend.includes(source), `missing English UI phrase: ${source}`);
    assert.ok(frontend.includes(translated), `missing Russian translation: ${translated}`);
  }
});
