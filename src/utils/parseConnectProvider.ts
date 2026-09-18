import { Provider } from '../models/Social';

/** Map Next (`instagram`/`gmb`) and Prisma (`INSTAGRAM`/`GOOGLE_BUSINESS`) to Social.provider. */
export function parseConnectProvider(raw: string | undefined): Provider | null {
  const key = raw?.trim().toUpperCase();
  if (!key) return null;
  if (key === 'INSTAGRAM' || key === 'IG') return Provider.INSTAGRAM;
  if (key === 'GOOGLE_BUSINESS' || key === 'GMB' || key === 'GOOGLE-BUSINESS') {
    return Provider.GOOGLE_BUSINESS;
  }
  return null;
}
