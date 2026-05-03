import type { ConnectOptions } from 'mongoose';

/**
 * Driver timeouts for Atlas / mongodb+srv (DNS + TLS handshakes often exceed 5s).
 * Override via MONGODB_SERVER_SELECTION_TIMEOUT_MS / MONGODB_CONNECT_TIMEOUT_MS.
 */
export function mongoDriverTimeouts(): Pick<
  ConnectOptions,
  'serverSelectionTimeoutMS' | 'connectTimeoutMS'
> {
  const selRaw = parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS ?? '', 10);
  const connRaw = parseInt(process.env.MONGODB_CONNECT_TIMEOUT_MS ?? '', 10);
  const serverSelectionTimeoutMS =
    Number.isFinite(selRaw) && selRaw > 0 ? selRaw : 30_000;
  const connectTimeoutMS = Number.isFinite(connRaw) && connRaw > 0 ? connRaw : 20_000;
  return { serverSelectionTimeoutMS, connectTimeoutMS };
}
