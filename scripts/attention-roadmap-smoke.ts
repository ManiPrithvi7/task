/**
 * Optional smoke check for attention / Instagram pipeline ops (Phase F).
 * Run with the server up: `npm run smoke:attention`
 *
 * Env:
 *   SMOKE_BASE_URL — default http://127.0.0.1:<PORT>
 *   PORT or HTTP_PORT — used if SMOKE_BASE_URL unset (default 3002)
 */
import dotenv from 'dotenv';

dotenv.config();

function baseUrl(): string {
  const explicit = process.env.SMOKE_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');
  const port = process.env.PORT || process.env.HTTP_PORT || '3002';
  return `http://127.0.0.1:${port}`;
}

async function getJson(path: string): Promise<unknown> {
  const url = `${baseUrl()}${path}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  const text = await res.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

async function main(): Promise<void> {
  const base = baseUrl();
  console.log(`Smoke: GET ${base}/health and ${base}/ready\n`);

  const health = (await getJson('/health')) as { ok: boolean; status: number; body: unknown };
  console.log('GET /health', health.status, health.ok ? 'OK' : 'FAIL');
  console.log(JSON.stringify(health.body, null, 2));

  const ready = (await getJson('/ready')) as { ok: boolean; status: number; body: unknown };
  console.log('\nGET /ready', ready.status, ready.ok ? 'OK' : 'FAIL');
  console.log(JSON.stringify(ready.body, null, 2));

  if (!health.ok || !ready.ok) {
    process.exitCode = 1;
  }
}

main().catch((e: unknown) => {
  const cause = e && typeof e === 'object' && 'cause' in e
    ? (e as { cause?: { code?: string } }).cause
    : undefined;
  if (cause?.code === 'ECONNREFUSED') {
    console.error(`Cannot connect to ${baseUrl()} — start the server or set SMOKE_BASE_URL.`);
  } else {
    console.error(e);
  }
  process.exitCode = 1;
});
