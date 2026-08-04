import { SessionService } from '@/services/sessionService';
import { logger } from '@/utils/logger';


describe('SessionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('createSession returns a session id and stores data with lastSeen', async () => {
    const svc = new SessionService();
    const id = await svc.createSession({ clientId: 'c1', username: 'u1', connectedAt: new Date() });
    expect(typeof id).toBe('string');
    expect(id.length).toBeGreaterThan(0);
    const session = await svc.getSession(id);
    expect(session).toMatchObject({ clientId: 'c1', username: 'u1' });
    expect(session?.lastSeen).toBeInstanceOf(Date);
  });

  it('getSession returns null for unknown id', async () => {
    const svc = new SessionService();
    expect(await svc.getSession('nope')).toBeNull();
  });

  it('getSession refreshes lastSeen', async () => {
    const svc = new SessionService();
    const id = await svc.createSession({ clientId: 'c1', connectedAt: new Date() });
    const first = (await svc.getSession(id))?.lastSeen;
    jest.advanceTimersByTime(5000);
    const second = (await svc.getSession(id))?.lastSeen;
    expect(second && first && second.getTime()).toBeGreaterThan(first.getTime());
  });

  it('getSessionByClientId finds session and returns null when absent', async () => {
    const svc = new SessionService();
    const id = await svc.createSession({ clientId: 'c1', connectedAt: new Date() });
    expect((await svc.getSessionByClientId('c1'))?.clientId).toBe('c1');
    expect(await svc.getSessionByClientId('missing')).toBeNull();
    expect(await svc.getSessionByClientId(id)).toBeNull();
  });

  it('getAllSessions returns a copy', async () => {
    const svc = new SessionService();
    await svc.createSession({ clientId: 'c1', connectedAt: new Date() });
    const all = await svc.getAllSessions();
    expect(all.size).toBe(1);
    all.clear();
    expect((await svc.getAllSessions()).size).toBe(1);
  });

  it('updateSession merges data and refreshes lastSeen; false for missing', async () => {
    const svc = new SessionService();
    const id = await svc.createSession({ clientId: 'c1', connectedAt: new Date() });
    expect(await svc.updateSession(id, { metadata: { k: 'v' } })).toBe(true);
    const session = await svc.getSession(id);
    expect(session?.metadata).toEqual({ k: 'v' });
    expect(await svc.updateSession('nope', {})).toBe(false);
  });

  it('deleteSession removes and reports existence', async () => {
    const svc = new SessionService();
    const id = await svc.createSession({ clientId: 'c1', connectedAt: new Date() });
    expect(await svc.deleteSession(id)).toBe(true);
    expect(await svc.getSession(id)).toBeNull();
    expect(await svc.deleteSession(id)).toBe(false);
  });

  it('cleanupExpiredSessions removes stale sessions after TTL, keeps fresh ones', async () => {
    const svc = new SessionService(60); // 60s TTL, cleanup ticks every 60s
    await svc.initialize();
    const staleId = await svc.createSession({ clientId: 'stale', connectedAt: new Date() });
    jest.advanceTimersByTime(60000); // tick 1: stale age == TTL -> survives
    jest.advanceTimersByTime(60000); // tick 2: stale age 120s > 60s -> deleted
    const freshId = await svc.createSession({ clientId: 'fresh', connectedAt: new Date() });
    jest.advanceTimersByTime(60000); // tick 3: fresh age == TTL -> survives

    expect(await svc.getSession(staleId)).toBeNull();
    expect(await svc.getSession(freshId)).not.toBeNull();
    expect(logger.debug).toHaveBeenCalledWith('Cleaned up expired sessions', expect.objectContaining({ count: 1 }));
  });

  it('close clears the interval and empties sessions', async () => {
    const svc = new SessionService();
    await svc.initialize();
    await svc.createSession({ clientId: 'c1', connectedAt: new Date() });
    await svc.close();
    expect((await svc.getAllSessions()).size).toBe(0);
    // advancing timers after close must not throw
    jest.advanceTimersByTime(120000);
    expect(logger.info).toHaveBeenCalledWith('SessionService closed');
  });
});
