import http from 'http';
import https from 'https';

export interface HttpProbeResult {
  statusCode: number;
  json: any;
}

/**
 * Simple HTTP(S) GET probe. Returns status code + parsed JSON body.
 * Suitable for health checks and API verification probes.
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

    const req = mod.request(
      {
        method: 'GET',
        hostname: u.hostname,
        port: u.port ? Number(u.port) : isHttps ? 443 : 80,
        path: `${u.pathname}${u.search}`,
        timeout: opts?.timeout ?? 10000,
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
          resolve({ statusCode: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    req.end();
  });
}
