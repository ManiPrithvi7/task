import mongoose from 'mongoose';
import { MongoService, createMongoService, getMongoService } from '@/services/mongoService';
import { logger } from '@/utils/logger';

const mockHandlers: Record<string, (...args: unknown[]) => void> = {};

let mockAdmin: { ping: jest.Mock };

const mockConnection: any = {
  host: 'h',
  port: 27017,
  name: 'db',
  readyState: 1,
  db: null,
  getClient: jest.fn(() => ({ on: jest.fn() })),
  on: jest.fn((event: string, cb: (...args: unknown[]) => void) => {
    mockHandlers[event] = cb;
  })
};

function setMockDb() {
  mockAdmin = { ping: jest.fn().mockResolvedValue(undefined) };
  mockConnection.db = {
    admin: jest.fn(() => mockAdmin),
    createCollection: jest.fn().mockResolvedValue({}),
    dropCollection: jest.fn().mockResolvedValue(undefined)
  };
}

jest.mock('mongoose', () => {
  const fake = {
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn().mockResolvedValue(undefined),
    connection: mockConnection,
  };
  return { __esModule: true, default: fake, ...fake };
});

jest.mock('@/config/mongoConnection', () => ({
  mongoDriverTimeouts: jest.fn(() => ({ serverSelectionTimeoutMS: 30000, connectTimeoutMS: 20000 }))
}));

const mongooseMock = mongoose as unknown as {
  connect: jest.Mock;
  disconnect: jest.Mock;
};

describe('MongoService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockConnection.readyState = 1;
    setMockDb();
  });

  describe('URI building with dbName', () => {
    it('appends dbName when URI has no database path', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017', dbName: 'newdb' });
      await service.connect();
      expect(mongooseMock.connect).toHaveBeenCalledWith('mongodb://h:27017/newdb', expect.any(Object));
    });

    it('appends dbName when URI has trailing slash', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/', dbName: 'newdb' });
      await service.connect();
      expect(mongooseMock.connect).toHaveBeenCalledWith('mongodb://h:27017/newdb', expect.any(Object));
    });

    it('replaces existing database path with dbName', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/olddb', dbName: 'newdb' });
      await service.connect();
      expect(mongooseMock.connect).toHaveBeenCalledWith('mongodb://h:27017/newdb', expect.any(Object));
    });

    it('leaves URI untouched when dbName already present, but sets options.dbName', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/mydb', dbName: 'mydb' });
      await service.connect();
      const [, options] = mongooseMock.connect.mock.calls[0] as [string, any];
      expect(mongooseMock.connect).toHaveBeenCalledWith('mongodb://h:27017/mydb', expect.any(Object));
      expect(options.dbName).toBe('mydb');
    });

    it('skips URI rewrite entirely when URI contains a query string', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db?replicaSet=rs0', dbName: 'newdb' });
      await service.connect();
      expect(mongooseMock.connect).toHaveBeenCalledWith('mongodb://h:27017/db?replicaSet=rs0', expect.any(Object));
    });

    it('handles mongodb+srv URIs with credentials', async () => {
      const service = new MongoService({ uri: 'mongodb+srv://user:pass@cluster.mdb.net/db', dbName: 'newdb' });
      await service.connect();
      expect(mongooseMock.connect).toHaveBeenCalledWith('mongodb+srv://user:pass@cluster.mdb.net/newdb', expect.any(Object));
    });

    it('does not set options.dbName when dbName absent', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      await service.connect();
      const [, options] = mongooseMock.connect.mock.calls[0] as [string, any];
      expect(options.dbName).toBeUndefined();
    });
  });

  describe('connect() options and lifecycle', () => {
    it('applies default pool sizes and driver timeouts with config.options overriding', async () => {
      const service = new MongoService({
        uri: 'mongodb://h:27017/db',
        options: { maxPoolSize: 25, socketTimeoutMS: 60000 }
      });
      await service.connect();
      const [, options] = mongooseMock.connect.mock.calls[0] as [string, any];
      expect(options).toMatchObject({
        maxPoolSize: 25,
        minPoolSize: 2,
        serverSelectionTimeoutMS: 30000,
        connectTimeoutMS: 20000,
        socketTimeoutMS: 60000,
        bufferCommands: false,
        retryWrites: true,
        retryReads: true
      });
    });

    it('uses configured maxPoolSize/minPoolSize when provided', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db', maxPoolSize: 5, minPoolSize: 1 });
      await service.connect();
      const [, options] = mongooseMock.connect.mock.calls[0] as [string, any];
      expect(options.maxPoolSize).toBe(5);
      expect(options.minPoolSize).toBe(1);
    });

    it('early-returns when already connected (no second mongoose.connect)', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      await service.connect();
      await service.connect();
      expect(mongooseMock.connect).toHaveBeenCalledTimes(1);
    });

    it('on failure rethrows wrapped error and logs sanitized URI', async () => {
      mongooseMock.connect.mockRejectedValueOnce(new Error('boom'));
      const service = new MongoService({ uri: 'mongodb://user:pass@h:27017/db' });
      await expect(service.connect()).rejects.toThrow('MongoDB connection failed: boom');
      const errCall = (logger.error as jest.Mock).mock.calls.find((c) => c[0] === 'Failed to connect to MongoDB');
      expect(errCall[1].uri).toBe('mongodb://h:27017/db');
    });

    it('sanitizes srv URIs in failure logs', async () => {
      mongooseMock.connect.mockRejectedValueOnce(new Error('boom'));
      const service = new MongoService({ uri: 'mongodb+srv://user:pass@cluster.mdb.net/db' });
      await expect(service.connect()).rejects.toThrow();
      const errCall = (logger.error as jest.Mock).mock.calls.find((c) => c[0] === 'Failed to connect to MongoDB');
      expect(errCall[1].uri).toBe('mongodb+srv://cluster.mdb.net/db');
    });

    it('sanitizeUri fallback strips password but keeps username for non-mongodb schemes', async () => {
      mongooseMock.connect.mockRejectedValueOnce(new Error('boom'));
      const service = new MongoService({ uri: 'custom://user:pass@h:27017/db' });
      await expect(service.connect()).rejects.toThrow();
      const errCall = (logger.error as jest.Mock).mock.calls.find((c) => c[0] === 'Failed to connect to MongoDB');
      expect(errCall[1].uri).toBe('custom://user@h:27017/db');
    });

    it('logs sanitized URI on attempt with dbName default', async () => {
      const service = new MongoService({ uri: 'mongodb://u:p@h:27017/db' });
      await service.connect();
      const infoCall = (logger.info as jest.Mock).mock.calls.find((c) => c[0] === 'Attempting MongoDB connection');
      expect(infoCall[1]).toMatchObject({ uri: 'mongodb://h:27017/db', dbName: 'default' });
    });
  });

  describe('disconnect()', () => {
    it('early-returns when not connected', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      await service.disconnect();
      expect(mongooseMock.disconnect).not.toHaveBeenCalled();
    });

    it('disconnects, nulls connection and clears flag', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      await service.connect();
      expect(service.isMongoConnected()).toBe(true);
      await service.disconnect();
      expect(mongooseMock.disconnect).toHaveBeenCalledTimes(1);
      expect(service.isMongoConnected()).toBe(false);
      expect(service.getConnection()).toBeNull();
    });

    it('wraps disconnect failures', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      await service.connect();
      mongooseMock.disconnect.mockRejectedValueOnce(new Error('down'));
      await expect(service.disconnect()).rejects.toThrow('MongoDB disconnection failed: down');
    });
  });

  describe('isMongoConnected()', () => {
    it('requires both flag and readyState === 1', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      await service.connect();
      expect(service.isMongoConnected()).toBe(true);
      mockConnection.readyState = 2;
      expect(service.isMongoConnected()).toBe(false);
      mockConnection.readyState = 0;
      expect(service.isMongoConnected()).toBe(false);
      mockConnection.readyState = 1;
      expect(service.isMongoConnected()).toBe(true);
    });

    it('is false before connect', () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      expect(service.isMongoConnected()).toBe(false);
    });
  });

  describe('healthCheck()', () => {
    it('returns false when not connected (no ping)', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      expect(await service.healthCheck()).toBe(false);
    });

    it('pings admin and returns true when connected', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      await service.connect();
      const admin = mockConnection.db.admin();
      expect(await service.healthCheck()).toBe(true);
      expect(admin.ping).toHaveBeenCalled();
    });

    it('returns false when ping rejects', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      await service.connect();
      const admin = mockConnection.db.admin();
      admin.ping.mockRejectedValueOnce(new Error('ping fail'));
      expect(await service.healthCheck()).toBe(false);
      expect(logger.error).toHaveBeenCalledWith('MongoDB health check failed', expect.anything());
    });

    it('PINNED DEFECT: returns true without pinging when connection.db is falsy', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      await service.connect();
      mockConnection.db = null;
      expect(await service.healthCheck()).toBe(true);
      expect(logger.error).not.toHaveBeenCalled();
    });
  });

  describe('event handlers', () => {
    it('flips isConnected on connection lifecycle events', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      await service.connect();
      expect(service.isMongoConnected()).toBe(true);

      mockHandlers.disconnected?.();
      expect(service.isMongoConnected()).toBe(false);

      mockHandlers.connected?.();
      expect(service.isMongoConnected()).toBe(true);

      mockHandlers.error?.(new Error('x'));
      expect(service.isMongoConnected()).toBe(false);

      mockHandlers.reconnected?.();
      expect(service.isMongoConnected()).toBe(true);

      mockHandlers.close?.();
      expect(service.isMongoConnected()).toBe(false);
    });
  });

  describe('createCollection / dropCollection', () => {
    it('createCollection throws when not connected', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      await expect(service.createCollection('x')).rejects.toThrow('MongoDB not connected');
    });

    it('createCollection throws when db unavailable', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      await service.connect();
      mockConnection.db = null;
      await expect(service.createCollection('x')).rejects.toThrow('MongoDB database not available');
    });

    it('createCollection delegates to db.createCollection', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      await service.connect();
      await service.createCollection('devices');
      expect(mockConnection.db.createCollection).toHaveBeenCalledWith('devices');
    });

    it('dropCollection returns true on success and false when drop fails', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      await service.connect();
      expect(await service.dropCollection('devices')).toBe(true);
      mockConnection.db.dropCollection.mockRejectedValueOnce(new Error('locked'));
      expect(await service.dropCollection('devices')).toBe(false);
    });

    it('dropCollection throws when not connected', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      await expect(service.dropCollection('x')).rejects.toThrow('MongoDB not connected');
    });
  });

  describe('singleton factory', () => {
    it('returns null before create, then the created instance', () => {
      expect(getMongoService()).toBeNull();
      const inst = createMongoService({ uri: 'mongodb://h:27017/db' });
      expect(getMongoService()).toBe(inst);
      expect(inst).toBeInstanceOf(MongoService);
    });
  });

  describe('getDatabase()', () => {
    it('returns connection db or null', async () => {
      const service = new MongoService({ uri: 'mongodb://h:27017/db' });
      expect(service.getDatabase()).toBeNull();
      await service.connect();
      expect(service.getDatabase()).toBe(mockConnection.db);
    });
  });
});
