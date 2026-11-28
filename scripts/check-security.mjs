#!/usr/bin/env node
/**
 * Security settings check for a deployed site (Dev 4, Phase 3).
 *
 *   node scripts/check-security.mjs https://clinic-emr.onrender.com
 *   node scripts/check-security.mjs https://clinic-emr.onrender.com --rate-limit
 *
 * Checks, without signing in:
 *   - plain HTTP redirects to HTTPS
 *   - security headers (HSTS, CSP, nosniff, framing, referrer, no X-Powered-By)
 *   - /health/ready answers ok
 *   - the API refuses an anonymous request, without caching it
 *   - cookie flags (HttpOnly, Secure, SameSite) on every cookie the site sets
 *
 * --rate-limit also sends 11 failed sign-ins for a made-up username and expects
 * the 11th to be refused (429). No real account is touched, but it blocks
 * sign-ins from YOUR network for 15 minutes. Never run it from the clinic's
 * Wi-Fi before a demo.
 *
 * Cookie flags on a real sign-in: set CHECK_USERNAME and CHECK_PASSWORD in the
 * shell for that one run (never in a file). The script stops at the
 * authenticator step, so it never completes a sign-in.
 *
 * Needs Node 18 or later. Exits 1 if any check fails.
 */

const args = process.argv.slice(2);
const base = args.find(a => !a.startsWith('--'));
const withRateLimit = args.includes('--rate-limit');
if (!base || !/^https:\/\//.test(base)) {
  console.error('Usage: node scripts/check-security.mjs https://<site> [--rate-limit]');
  process.exit(2);
}
const origin = new URL(base).origin;
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });
const cookiesSeen = [];

async function get(url, init = {}) {
  const res = await fetch(url, { redirect: 'manual', ...init, headers: { 'User-Agent': 'clinic-security-check', ...(init.headers ?? {}) } });
  for (const c of res.headers.getSetCookie?.() ?? []) cookiesSeen.push(c);
  return res;
}

// Free Render sites sleep. Wake it first so timeouts are not read as failures.
process.stdout.write(`Waking ${origin} ...`);
for (let i = 0; i < 12; i++) {
  try {
    const r = await get(origin + '/health/ready');
    if (r.status < 500) break;
  } catch { /* still waking */ }
  await new Promise(r => setTimeout(r, 5000));
}
console.log(' done\n');

// 1. HTTP -> HTTPS
try {
  const plain = await get(origin.replace(/^https:/, 'http:') + '/');
  const location = plain.headers.get('location') ?? '';
  check('HTTP redirects to HTTPS', [301, 302, 307, 308].includes(plain.status) && location.startsWith('https://'),
    `${plain.status} -> ${location || '(no Location)'}`);
} catch (err) {
  check('HTTP redirects to HTTPS', false, String(err.message ?? err));
}

// 2. Security headers on the page
const page = await get(origin + '/');
const h = (n) => page.headers.get(n) ?? '';
const hsts = h('strict-transport-security');
const maxAge = Number(/max-age=(\d+)/.exec(hsts)?.[1] ?? 0);
check('Page loads over HTTPS', page.status === 200, String(page.status));
check('HSTS (Strict-Transport-Security, 180+ days)', maxAge >= 15552000, hsts || '(missing)');
const csp = h('content-security-policy');
check("Content-Security-Policy with default-src 'self'", csp.includes("default-src 'self'"), csp ? csp.slice(0, 80) + '...' : '(missing)');
check('Framing blocked (X-Frame-Options or frame-ancestors)',
  /deny|sameorigin/i.test(h('x-frame-options')) || /frame-ancestors '(self|none)'/.test(csp), h('x-frame-options') || 'frame-ancestors in CSP');
check('X-Content-Type-Options: nosniff', h('x-content-type-options') === 'nosniff', h('x-content-type-options') || '(missing)');
check('Referrer-Policy set', h('referrer-policy') !== '', h('referrer-policy') || '(missing)');
check('No X-Powered-By header', h('x-powered-by') === '', h('x-powered-by') || 'absent');

// 3. Readiness
const ready = await get(origin + '/health/ready');
const readyBody = await ready.text();
check('/health/ready reports ready', ready.status === 200 && /"status":"ready"/.test(readyBody), `${ready.status} ${readyBody.slice(0, 80)}`);

// 4. API refuses anonymous access and is not cached
const me = await get(origin + '/api/auth/me');
check('API refuses anonymous request (401)', me.status === 401, String(me.status));
check('API responses are not cached (no-store)', /no-store/.test(me.headers.get('cache-control') ?? ''), me.headers.get('cache-control') ?? '(missing)');
check('API sends rate-limit headers', (me.headers.get('ratelimit') ?? me.headers.get('ratelimit-policy') ?? '') !== '',
  me.headers.get('ratelimit') ?? '(missing)');

// 5. Optional: password step of a real sign-in, for the session cookie
if (process.env.CHECK_USERNAME && process.env.CHECK_PASSWORD) {
  const login = await get(origin + '/api/auth/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: process.env.CHECK_USERNAME, password: process.env.CHECK_PASSWORD }),
  });
  check('Password step accepted, authenticator code required (202)', login.status === 202, String(login.status));
}

// 6. Cookie flags on everything the site set
if (cookiesSeen.length === 0) {
  check('Cookie flags', true, 'no cookie set without signing in (set CHECK_USERNAME/CHECK_PASSWORD to check the session cookie)');
} else {
  for (const c of cookiesSeen) {
    const name = c.split('=')[0];
    const missing = ['HttpOnly', 'Secure', 'SameSite'].filter(f => !new RegExp(`;\\s*${f}`, 'i').test(c));
    check(`Cookie "${name}" is HttpOnly, Secure, SameSite`, missing.length === 0, missing.length ? 'missing ' + missing.join(', ') : 'ok');
  }
}

// 7. Optional: sign-in rate limit
if (withRateLimit) {
  const fake = 'security-check-' + Math.random().toString(36).slice(2, 10);
  let status = 0;
  for (let i = 1; i <= 11; i++) {
    const r = await get(origin + '/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: fake, password: 'not-a-real-password-' + i }),
    });
    status = r.status;
    if (status === 429) break;
  }
  check('Sign-in rate limit refuses the 11th failure (429)', status === 429, `last status ${status}`);
}

// Report
const width = Math.max(...results.map(r => r.name.length));
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(width)}  ${r.detail}`);
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${withRateLimit ? '' : ' (rate limit not tested; add --rate-limit)'}`);
process.exit(failed ? 1 : 0);
