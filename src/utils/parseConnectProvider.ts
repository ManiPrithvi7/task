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

export type IntegrationConnectAction = 'connect' | 'disconnect';

/** Connect is the default; unlink may send action, connected:false, or social.disconnected. */
export function parseConnectAction(body: {
  action?: unknown;
  connected?: unknown;
  event?: unknown;
}): IntegrationConnectAction {
  const action = typeof body.action === 'string' ? body.action.trim().toLowerCase() : '';
  if (action === 'disconnect' || action === 'disconnected') return 'disconnect';
  if (body.connected === false || body.connected === 'false') return 'disconnect';
  const event = typeof body.event === 'string' ? body.event.trim().toLowerCase() : '';
  if (event === 'social.disconnected') return 'disconnect';
  return 'connect';
}
