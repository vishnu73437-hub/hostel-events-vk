import { performance } from "node:perf_hooks";

const target = process.env.EVENTHUB_TARGET_URL || "https://eventhub-vk.ksmu.workers.dev";
const vus = Number(process.env.VUS || 600);
const rounds = Number(process.env.ROUNDS || 3);
const timeoutMs = Number(process.env.TIMEOUT_MS || 10000);
const maxP95Ms = Number(process.env.MAX_P95_MS || 5000);

if (!Number.isInteger(vus) || vus < 1 || vus > 600) throw new Error("VUS must be an integer between 1 and 600.");
if (!Number.isInteger(rounds) || rounds < 1 || rounds > 10) throw new Error("ROUNDS must be an integer between 1 and 10.");

const url = new URL("/api/health", target).toString();
const samples = [];
const errors = [];
const started = performance.now();

async function hit(user, round) {
  const t0 = performance.now();
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { "accept": "application/json", "cache-control": "no-store", "x-load-test-client": String(user) },
      signal: AbortSignal.timeout(timeoutMs)
    });
    const elapsed = performance.now() - t0;
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    if (data.ok !== true || data.service !== "vk-eventhub-cloudflare") {
      throw new Error("Unexpected health payload");
    }
    samples.push(elapsed);
  } catch (error) {
    errors.push({ user, round, error: String(error?.message || error).slice(0, 180) });
  }
}

for (let round = 1; round <= rounds; round++) {
  await Promise.all(Array.from({ length: vus }, (_, i) => hit(i + 1, round)));
}

samples.sort((a,b)=>a-b);
const percentile = p => samples.length ? samples[Math.min(samples.length-1, Math.ceil(p*samples.length)-1)] : null;
const elapsedMs = performance.now() - started;
const total = vus * rounds;
const report = {
  target: new URL(target).origin,
  endpoint: "/api/health",
  scenario: "read-only edge health smoke test; no registration, guest, QR or D1 mutation",
  virtual_users: vus,
  rounds,
  requests: total,
  successful: samples.length,
  failed: errors.length,
  duration_ms: Math.round(elapsedMs),
  requests_per_second: Number((samples.length / (elapsedMs/1000)).toFixed(1)),
  latency_ms: {
    min: samples.length ? Number(samples[0].toFixed(1)) : null,
    p50: percentile(0.50) === null ? null : Number(percentile(0.50).toFixed(1)),
    p95: percentile(0.95) === null ? null : Number(percentile(0.95).toFixed(1)),
    p99: percentile(0.99) === null ? null : Number(percentile(0.99).toFixed(1)),
    max: samples.length ? Number(samples[samples.length-1].toFixed(1)) : null
  },
  sample_errors: errors.slice(0, 10)
};
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
if (percentile(0.95) !== null && percentile(0.95) > maxP95Ms) {
  console.error("p95 exceeded MAX_P95_MS=" + maxP95Ms);
  process.exitCode = 1;
}
