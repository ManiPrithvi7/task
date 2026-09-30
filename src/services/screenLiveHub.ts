import { logger } from '../utils/logger';

export type ScreenLiveClient = {
  send: (data: string) => void;
  close: (code: number, reason?: string) => void;
};

export type ScreenLiveAcceptInput = {
  deviceId: string;
  allowlisted: boolean;
  burstFinished: boolean;
  userId?: string;
  businessId?: string;
  followers?: number;
  reviews?: number;
};

/**
 * In-memory fanout for the connect-burst window.
 * MQTT still owns the device screen. This only talks to browser sockets.
 */
export class ScreenLiveHub {
  private readonly rooms = new Map<string, Set<ScreenLiveClient>>();

  accept(input: ScreenLiveAcceptInput, client: ScreenLiveClient): boolean {
    if (!input.allowlisted) {
      this.reject(client, 'device not allowlisted');
      return false;
    }
    if (input.burstFinished) {
      this.reject(client, 'connect burst finished');
      return false;
    }
    if (!input.userId || !input.businessId || input.userId !== input.businessId) {
      this.reject(client, 'business mismatch');
      return false;
    }

    let room = this.rooms.get(input.deviceId);
    if (!room) {
      room = new Set();
      this.rooms.set(input.deviceId, room);
    }
    room.add(client);

    const snapshot: Record<string, unknown> = {
      event: 'screen.count',
      deviceId: input.deviceId,
      at: new Date().toISOString()
    };
    if (input.followers !== undefined) snapshot.followers = input.followers;
    if (input.reviews !== undefined) snapshot.reviews = input.reviews;
    client.send(JSON.stringify(snapshot));
    return true;
  }

  detach(deviceId: string, client: ScreenLiveClient): void {
    const room = this.rooms.get(deviceId);
    if (!room) return;
    room.delete(client);
    if (room.size === 0) this.rooms.delete(deviceId);
  }

  pushFollowers(deviceId: string, followers: number): void {
    this.push(deviceId, { followers });
  }

  pushReviews(deviceId: string, reviews: number): void {
    this.push(deviceId, { reviews });
  }

  closeDevice(deviceId: string): void {
    const room = this.rooms.get(deviceId);
    if (!room) return;
    this.rooms.delete(deviceId);
    const ended = JSON.stringify({ event: 'screen.burst.ended', deviceId });
    for (const client of room) {
      try {
        client.send(ended);
      } catch {
        /* ignore */
      }
      try {
        client.close(1000, 'burst ended');
      } catch {
        /* ignore */
      }
    }
  }

  private push(deviceId: string, patch: { followers?: number; reviews?: number }): void {
    const room = this.rooms.get(deviceId);
    if (!room || room.size === 0) return;
    const body = JSON.stringify({
      event: 'screen.count',
      deviceId,
      ...patch,
      at: new Date().toISOString()
    });
    logger.info('[SCREEN_LIVE] dispatched', {
      deviceId,
      ...patch,
      clients: room.size
    });
    for (const client of room) {
      try {
        client.send(body);
      } catch {
        /* ignore */
      }
    }
  }

  private reject(client: ScreenLiveClient, reason: string): void {
    try {
      client.send(JSON.stringify({ event: 'screen.error', code: 'FORBIDDEN', message: reason }));
    } catch {
      /* ignore */
    }
    client.close(4403, reason);
  }
}

let singleton: ScreenLiveHub | null = null;

export function getScreenLiveHub(): ScreenLiveHub {
  if (!singleton) singleton = new ScreenLiveHub();
  return singleton;
}

export function resetScreenLiveHubForTests(): void {
  singleton = null;
}
