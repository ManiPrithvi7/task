import { describe, expect, it } from 'bun:test';
import { ScreenLiveHub, type ScreenLiveClient } from '@/services/screenLiveHub';

const DEVICE = '274968B43A1D';

function fakeClient() {
  const sent: string[] = [];
  const closed: Array<{ code: number; reason?: string }> = [];
  const client: ScreenLiveClient = {
    send: (data) => {
      sent.push(data);
    },
    close: (code, reason) => {
      closed.push({ code, reason });
    }
  };
  return { client, sent, closed };
}

function parsed(sent: string[]) {
  return sent.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('ScreenLiveHub', () => {
  it('rejects a device that is not on the connect-burst allowlist', () => {
    const hub = new ScreenLiveHub();
    const { client, sent, closed } = fakeClient();
    const ok = hub.accept(
      {
        deviceId: 'OTHER',
        allowlisted: false,
        burstFinished: false,
        userId: 'biz-1',
        businessId: 'biz-1',
        followers: 4
      },
      client
    );
    expect(ok).toBe(false);
    expect(closed[0]?.code).toBe(4403);
    expect(parsed(sent)[0]?.event).toBe('screen.error');
  });

  it('rejects an allowlisted device after the burst has finished', () => {
    const hub = new ScreenLiveHub();
    const { client, closed } = fakeClient();
    const ok = hub.accept(
      {
        deviceId: DEVICE,
        allowlisted: true,
        burstFinished: true,
        userId: 'biz-1',
        businessId: 'biz-1'
      },
      client
    );
    expect(ok).toBe(false);
    expect(closed[0]?.code).toBe(4403);
  });

  it('sends a snapshot of cached followers and reviews on accept', () => {
    const hub = new ScreenLiveHub();
    const { client, sent } = fakeClient();
    const ok = hub.accept(
      {
        deviceId: DEVICE,
        allowlisted: true,
        burstFinished: false,
        userId: 'biz-1',
        businessId: 'biz-1',
        followers: 5,
        reviews: 2
      },
      client
    );
    expect(ok).toBe(true);
    const frame = parsed(sent)[0];
    expect(frame).toMatchObject({
      event: 'screen.count',
      deviceId: DEVICE,
      followers: 5,
      reviews: 2
    });
  });

  it('pushes only the field it was notified about', () => {
    const hub = new ScreenLiveHub();
    const { client, sent } = fakeClient();
    hub.accept(
      {
        deviceId: DEVICE,
        allowlisted: true,
        burstFinished: false,
        userId: 'biz-1',
        businessId: 'biz-1',
        followers: 5
      },
      client
    );
    expect(sent).toHaveLength(1);

    hub.pushFollowers(DEVICE, 6);
    const change = parsed(sent)[1];
    expect(change).toMatchObject({ event: 'screen.count', deviceId: DEVICE, followers: 6 });
    expect(change).not.toHaveProperty('reviews');

    hub.pushReviews(DEVICE, 3);
    const reviews = parsed(sent)[2];
    expect(reviews).toMatchObject({ event: 'screen.count', reviews: 3 });
    expect(reviews).not.toHaveProperty('followers');
  });

  it('closes subscribers when the burst ends', () => {
    const hub = new ScreenLiveHub();
    const { client, sent, closed } = fakeClient();
    hub.accept(
      {
        deviceId: DEVICE,
        allowlisted: true,
        burstFinished: false,
        userId: 'biz-1',
        businessId: 'biz-1'
      },
      client
    );

    hub.closeDevice(DEVICE);
    expect(parsed(sent).at(-1)).toMatchObject({ event: 'screen.burst.ended', deviceId: DEVICE });
    expect(closed[0]).toEqual({ code: 1000, reason: 'burst ended' });

    hub.pushFollowers(DEVICE, 9);
    expect(sent.filter((line) => line.includes('"followers"'))).toHaveLength(0);
  });
});
