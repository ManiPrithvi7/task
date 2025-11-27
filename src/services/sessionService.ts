/**
 * Session Service - In-memory session management
 * Sessions are temporary and don't need MongoDB persistence
 */

import { logger } from '../utils/logger';
import { v4 as uuidv4 } from 'uuid';

export interface SessionData {
  clientId: string;
  username?: string;
  connectedAt: Date;
  lastSeen: Date;
  metadata?: Record<string, any>;
}

export class SessionService {
  private sessions: Map<string, SessionData> = new Map();
  private sessionTTL: number;
  private cleanupInterval?: NodeJS.Timeout;

  constructor(sessionTTL: number = 3600) {
    this.sessionTTL = sessionTTL;
  }

  /**
   * Initialize session service
   */
  async initialize(): Promise<void> {
    logger.info('SessionService initialized (in-memory)', {
      sessionTTL: `${this.sessionTTL}s`
    });

    // Start cleanup task
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, 60000); // Cleanup every minute
  }

  /**
   * Create a new session
   */
  async createSession(data: Omit<SessionData, 'lastSeen'>): Promise<string> {
    const sessionId = uuidv4();
    
    this.sessions.set(sessionId, {
      ...data,
      lastSeen: new Date()
    });

    logger.debug('Session created', { sessionId, clientId: data.clientId });
    
    return sessionId;
  }

  /**
   * Get session by ID
   */
  async getSession(sessionId: string): Promise<SessionData | null> {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return null;
    }

    // Update last seen
    session.lastSeen = new Date();
    
    return session;
  }

  /**
   * Get all sessions
   */
  async getAllSessions(): Promise<Map<string, SessionData>> {
    return new Map(this.sessions);
  }

  /**
   * Get session by client ID
   */
  async getSessionByClientId(clientId: string): Promise<SessionData | null> {
    for (const [, session] of this.sessions) {
      if (session.clientId === clientId) {
        return session;
      }
    }
    return null;
  }

  /**
   * Update session
   */
  async updateSession(sessionId: string, data: Partial<SessionData>): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return false;
    }

    Object.assign(session, data, { lastSeen: new Date() });
    
    logger.debug('Session updated', { sessionId });
    
    return true;
  }

  /**
   * Delete session
   */
  async deleteSession(sessionId: string): Promise<boolean> {
    const deleted = this.sessions.delete(sessionId);
    
    if (deleted) {
      logger.debug('Session deleted', { sessionId });
    }
    
    return deleted;
  }

  /**
   * Cleanup expired sessions
   */
  private cleanupExpiredSessions(): void {
    const now = Date.now();
    const ttlMs = this.sessionTTL * 1000;
    let cleanedCount = 0;

    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastSeen.getTime() > ttlMs) {
        this.sessions.delete(sessionId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.debug('Cleaned up expired sessions', { count: cleanedCount });
    }
  }

  /**
   * Close service
   */
  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.sessions.clear();
    logger.info('SessionService closed');
  }
}

