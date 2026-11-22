import assert from "node:assert/strict";
import { chromium, webkit } from "playwright";

const target = process.env.EVENTHUB_TARGET_URL || "https://eventhub-vk.ksmu.workers.dev";
const cases = [
  { name: "Android-sized mobile", width: 412, height: 915, isMobile: true, hasTouch: true },
  { name: "iPhone-sized mobile", width: 390, height: 844, isMobile: true, hasTouch: true },
  { name: "iPad-sized tablet", width: 820, height: 1180, isMobile: true, hasTouch: true },
  { name: "Desktop", width: 1440, height: 900, isMobile: false, hasTouch: false }
];
const results = [];

for (const engine of [
  { name: "Chromium", impl: chromium },
  { name: "WebKit", impl: webkit }
]) {
  const browser = await engine.impl.launch({ headless: true });
  try {
    for (const device of cases) {
      const context = await browser.newContext({
        viewport: { width: device.width, height: device.height },
        deviceScaleFactor: device.isMobile ? 2 : 1,
        isMobile: device.isMobile,
        hasTouch: device.hasTouch
      });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", error => pageErrors.push(String(error.message).slice(0, 180)));
      const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
      assert.ok(response && response.status() === 200, engine.name + " " + device.name + ": app page did not return HTTP 200");
      await page.waitForSelector(".shell", { timeout: 15000 });
      await page.waitForTimeout(1200);
      const layout = await page.evaluate(() => ({
        title: document.title,
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        shellVisible: !!document.querySelector(".shell") && getComputedStyle(document.querySelector(".shell")).display !== "none",
        languageControl: !!document.querySelector(".language-select"),
        topbar: !!document.querySelector(".topbar")
      }));
      assert.ok(layout.shellVisible, engine.name + " " + device.name + ": app shell hidden");
      assert.ok(layout.documentWidth <= layout.viewport + 2, engine.name + " " + device.name + ": horizontal page overflow (" + layout.documentWidth + " > " + layout.viewport + ")");
      assert.ok(layout.topbar, engine.name + " " + device.name + ": topbar missing");
      results.push({ engine: engine.name, device: device.name, status: "passed", layout, pageErrors });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
console.log(JSON.stringify({ target: new URL(target).origin, tests: results.length, passed: results.length, failed: 0, results }, null, 2));
