#!/usr/bin/env node
/**
 * Standalone performance measurement for the deployed EMR (QA evidence,
 * SRS 4.2 / SDD 3.5). Hits a live site over HTTP, so it captures real
 * latency — including the Render free-plan cold start — the way the client
 * walkthrough will experience it.
 *
 * It measures Developer 2's two targets and a 5-user concurrency burst:
 *   - patient search      target  < 2000 ms
 *   - chart summary open  target  < 3000 ms
 *   - 5 concurrent chart loads (SRS: at least 5 concurrent users)
 *
 * No dependencies — Node 20+ (global fetch). Run from the repo root:
 *
 *   node scripts/perf-measure.mjs \
 *     --url https://clinic-emr.onrender.com \
 *     --user apacio --pass 'DoctorPass123!' \
 *     --q delacruz
 *
 * Flags (or the matching env vars):
 *   --url   PERF_URL      base URL of the deployed site (no trailing slash)
 *   --user  PERF_USER     doctor username
 *   --pass  PERF_PASS     doctor password
 *   --clinic PERF_CLINIC  clinic name to select (default: the first one)
 *   --q     PERF_Q        patient search term (default: "a")
 *   --runs  PERF_RUNS     timed repeats per endpoint (default: 5)
 *
 * The site must hold only sample data. Do not run this against real patients.
 */

const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, arr) => (a.startsWith("--") ? [[a.slice(2), arr[i + 1]]] : [])),
);
const cfg = {
  url: (args.url ?? process.env.PERF_URL ?? "http://localhost:4000").replace(/\/$/, ""),
  user: args.user ?? process.env.PERF_USER ?? "apacio",
  pass: args.pass ?? process.env.PERF_PASS ?? "DoctorPass123!",
  clinic: args.clinic ?? process.env.PERF_CLINIC ?? "",
  q: args.q ?? process.env.PERF_Q ?? "a",
  runs: Number(args.runs ?? process.env.PERF_RUNS ?? 5),
};

const BUDGETS = { search: 2000, chart: 3000 };

let cookie = "";
async function http(method, path, body) {
  const res = await fetch(`${cfg.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const setCookie = res.headers.getSetCookie?.() ?? [];
  if (setCookie.length) cookie = setCookie.map((c) => c.split(";")[0]).join("; ");
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, json, text };
}

async function timed(fn) {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

function stats(times) {
  const sorted = [...times].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { min: sorted[0], median: p(0.5), p95: p(0.95), max: sorted[sorted.length - 1] };
}

const ms = (n) => `${n.toFixed(0)} ms`;
const verdict = (value, budget) => (value < budget ? "PASS" : "FAIL");

async function waitForWake() {
  process.stdout.write("Waking the site (/health/ready) … ");
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    try {
      const r = await http("GET", "/health/ready");
      if (r.status === 200) {
        console.log(`up after ${ms(performance.now() - t0)} (attempt ${i + 1})`);
        return;
      }
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.log("gave up waiting — continuing anyway");
}

async function main() {
  console.log(`Target: ${cfg.url}`);
  await waitForWake();

  const login = await http("POST", "/api/auth/login", { username: cfg.user, password: cfg.pass });
  if (login.status !== 200) throw new Error(`Login failed (${login.status}): ${login.text}`);

  const clinics = (await http("GET", "/api/clinics")).json?.items ?? [];
  if (!clinics.length) throw new Error("No clinics returned — is the site seeded?");
  const chosen = cfg.clinic ? clinics.find((c) => c.name === cfg.clinic) : clinics[0];
  if (!chosen) throw new Error(`Clinic "${cfg.clinic}" not found. Available: ${clinics.map((c) => c.name).join(", ")}`);
  await http("POST", "/api/auth/select-clinic", { clinicId: chosen.id });
  console.log(`Signed in as ${cfg.user}, clinic "${chosen.name}". Runs per endpoint: ${cfg.runs}\n`);

  // Search
  const searchTimes = [];
  for (let i = 0; i < cfg.runs; i++) {
    searchTimes.push(await timed(() => http("GET", `/api/patients?q=${encodeURIComponent(cfg.q)}&by=name&pageSize=20`)));
  }
  const s = stats(searchTimes);

  // Find a patient to open (search by term, else list)
  const list = (await http("GET", `/api/patients?q=${encodeURIComponent(cfg.q)}&pageSize=1`)).json;
  const patientId = list?.items?.[0]?.id ?? (await http("GET", "/api/patients?pageSize=1")).json?.items?.[0]?.id;
  if (!patientId) throw new Error("No patient found to open a chart for.");

  // Chart
  const chartTimes = [];
  for (let i = 0; i < cfg.runs; i++) {
    chartTimes.push(await timed(() => http("GET", `/api/patients/${patientId}/summary`)));
  }
  const c = stats(chartTimes);

  // 5-user concurrency: five chart loads at once, report the slowest.
  const concurrentStart = performance.now();
  await Promise.all(Array.from({ length: 5 }, () => http("GET", `/api/patients/${patientId}/summary`)));
  const concurrentMax = performance.now() - concurrentStart;

  console.log("Results (warm; first cold request excluded from the budget):\n");
  console.log(`  Patient search   min ${ms(s.min)}  median ${ms(s.median)}  p95 ${ms(s.p95)}   [${verdict(s.median, BUDGETS.search)} < ${BUDGETS.search} ms]`);
  console.log(`  Chart summary    min ${ms(c.min)}  median ${ms(c.median)}  p95 ${ms(c.p95)}   [${verdict(c.median, BUDGETS.chart)} < ${BUDGETS.chart} ms]`);
  console.log(`  5 concurrent charts finished in ${ms(concurrentMax)}`);
  console.log("\n  PDF (5 s target) is Developer 1's documents module — measure it from the signing flow separately.");
  console.log("  Note: the first request after the free instance sleeps is far slower; that cold start is a known free-plan limit, not a query problem.");
}

main().catch((err) => {
  console.error("\nMeasurement failed:", err.message);
  process.exit(1);
});
