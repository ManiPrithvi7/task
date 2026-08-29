import http from 'http';
import https from 'https';

export interface HttpProbeResult {
  statusCode: number;
  json: any;
}

/**
 * Simple HTTP(S) GET probe. Returns status code + parsed JSON body.
 * Suitable for health checks and API verification probes.
 *
 * The timeout is enforced with an explicit absolute timer: Bun does not
 * reliably emit the request 'timeout' event for stalled connections, which
 * previously left this promise pending forever and deadlocked startup.
 */
export function httpGet(url: string, opts?: {
  timeout?: number;
  headers?: Record<string, string>;
}): Promise<HttpProbeResult> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.hostname === 'localhost') u.hostname = '127.0.0.1';
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const timeoutMs = opts?.timeout ?? 10000;

    let settled = false;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const req = mod.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port ? Number(u.port) : isHttps ? 443 : 80,
        path: `${u.pathname}${u.search}`,
        headers: opts?.headers,
      },
      (res) => {
        let raw = '';
        res.on('data', (c: string) => (raw += c));
        res.on('end', () => {
          let json: any = {};
          try {
            json = raw ? JSON.parse(raw) : {};
          } catch {
            json = {};
          }
          settle(() => resolve({ statusCode: res.statusCode ?? 0, json }));
        });
        res.on('error', (err: Error) => settle(() => reject(err)));
      },
    );

    // eslint-disable-next-line prefer-const -- assigned once; declared late because `settle` clears it
    let timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      req.destroy();
      settle(() => reject(new Error(`timeout after ${timeoutMs}ms`)));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    req.on('timeout', () => req.destroy());
    req.on('error', (err) => settle(() => reject(err)));
    req.end();
  });
}
