import { FileStorage } from './fileStorage';
import { SessionData } from '../types';
import { logger } from '../utils/logger';

export class SessionStorage {
  private storage: FileStorage<SessionData>;
  private readonly defaultTTL: number;

  constructor(dataDir: string, defaultTTL: number = 86400) {
    this.storage = new FileStorage<SessionData>('sessions.json', dataDir);
    this.defaultTTL = defaultTTL;
  }

  async initialize(): Promise<void> {
    await this.storage.initialize();
    logger.info('Session storage initialized');
  }

  async createSession(
    sessionData: SessionData,
    ttl?: number
  ): Promise<string> {
    const sessionId = `session:${sessionData.clientId}:${Date.now()}`;
    await this.storage.set(sessionId, sessionData, ttl || this.defaultTTL);
    logger.info('Session created', { sessionId, clientId: sessionData.clientId });
    return sessionId;
  }

  async getSession(sessionId: string): Promise<SessionData | null> {
    return await this.storage.get(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.storage.delete(sessionId);
    logger.info('Session deleted', { sessionId });
  }

  async getAllSessions(): Promise<Map<string, SessionData>> {
    return await this.storage.getAll();
  }

  async getSessionByClientId(clientId: string): Promise<SessionData | null> {
    const allSessions = await this.storage.getAll();
    for (const [_, sessionData] of allSessions) {
      if (sessionData.clientId === clientId) {
        return sessionData;
      }
    }
    return null;
  }

  async updateSession(sessionId: string, updates: Partial<SessionData>): Promise<boolean> {
    const session = await this.storage.get(sessionId);
    if (!session) {
      return false;
    }

    const updatedSession = { ...session, ...updates };
    await this.storage.set(sessionId, updatedSession, this.defaultTTL);
    logger.info('Session updated', { sessionId });
    return true;
  }

  async close(): Promise<void> {
    await this.storage.close();
  }
}
