import { describe, it, expect, beforeEach, afterEach, vi, beforeAll } from 'vitest';
import { DatabaseClient } from './client';
import { PrismaClient } from '@prisma/client';

// Set up environment variable for tests
beforeAll(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/testdb';
});

// Mock PrismaClient
vi.mock('@prisma/client', () => {
  const mockPrismaClient = {
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $queryRaw: vi.fn(),
    $queryRawUnsafe: vi.fn(),
    $transaction: vi.fn(),
  };

  return {
    PrismaClient: vi.fn(() => mockPrismaClient),
    Prisma: {},
  };
});

describe('DatabaseClient', () => {
  let dbClient: DatabaseClient;
  let mockPrisma: any;

  beforeEach(() => {
    // Clear all mocks before each test
    vi.clearAllMocks();
    
    // Create a new instance
    dbClient = new DatabaseClient(30000, 3);
    
    // Get the mocked Prisma instance
    mockPrisma = (dbClient as any).prisma;
  });

  afterEach(async () => {
    // Clean up after each test
    try {
      await dbClient.disconnect();
    } catch {
      // Ignore errors during cleanup
    }
  });

  describe('Connection Management', () => {
    it('should establish database connection successfully', async () => {
      mockPrisma.$connect.mockResolvedValueOnce(undefined);
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);

      await dbClient.connect();

      expect(mockPrisma.$connect).toHaveBeenCalledTimes(1);
      expect(mockPrisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('should not reconnect if already connected', async () => {
      mockPrisma.$connect.mockResolvedValueOnce(undefined);
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);

      await dbClient.connect();
      await dbClient.connect();

      expect(mockPrisma.$connect).toHaveBeenCalledTimes(1);
    });

    it('should retry connection on failure with exponential backoff', async () => {
      // Fail twice, succeed on third attempt
      mockPrisma.$connect
        .mockRejectedValueOnce(new Error('ECONNREFUSED'))
        .mockRejectedValueOnce(new Error('ETIMEDOUT'))
        .mockResolvedValueOnce(undefined);

      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ '?column?': 1 }]);

      const startTime = Date.now();
      await dbClient.connect();
      const endTime = Date.now();

      // Should have retried 3 times (initial + 2 retries)
      expect(mockPrisma.$connect).toHaveBeenCalledTimes(3);
      
      // Verify exponential backoff occurred (1s + 2s = 3000ms minimum)
      expect(endTime - startTime).toBeGreaterThanOrEqual(3000);
    });

    it('should throw error after max retry attempts', async () => {
      mockPrisma.$connect.mockRejectedValue(new Error('Connection refused'));

      await expect(dbClient.connect()).rejects.toThrow(
        'Failed to connect to database after 3 attempts'
      );

      expect(mockPrisma.$connect).toHaveBeenCalledTimes(3);
    });

    it('should disconnect from database successfully', async () => {
      mockPrisma.$connect.mockResolvedValueOnce(undefined);
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
      mockPrisma.$disconnect.mockResolvedValueOnce(undefined);

      await dbClient.connect();
      
      // Clear mock to verify disconnect is called
      mockPrisma.$disconnect.mockClear();
      
      await dbClient.disconnect();

      expect(mockPrisma.$disconnect).toHaveBeenCalledTimes(1);
    });

    it('should handle disconnect when not connected', async () => {
      mockPrisma.$disconnect.mockResolvedValueOnce(undefined);

      await expect(dbClient.disconnect()).resolves.not.toThrow();
      
      // Should not call $disconnect if not connected
      expect(mockPrisma.$disconnect).not.toHaveBeenCalled();
    });
  });

  describe('Connection Pool Configuration', () => {
    it('should configure connection pool with correct parameters', () => {
      const poolInfo = dbClient.getPoolInfo();

      expect(poolInfo.min).toBe(5);
      expect(poolInfo.max).toBe(20);
      expect(poolInfo.timeout).toBe(30000);
    });

    it('should use custom timeout when provided', () => {
      const customClient = new DatabaseClient(60000);
      const poolInfo = customClient.getPoolInfo();

      expect(poolInfo.timeout).toBe(60000);
    });
  });

  describe('Transaction Management', () => {
    beforeEach(async () => {
      mockPrisma.$connect.mockResolvedValueOnce(undefined);
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
      await dbClient.connect();
    });

    it('should execute transaction successfully', async () => {
      const mockResult = { id: '123', name: 'Test' };
      mockPrisma.$transaction.mockImplementation(async (fn: any) => {
        return await fn(mockPrisma);
      });

      const result = await dbClient.transaction(async (tx) => {
        return mockResult;
      });

      expect(result).toEqual(mockResult);
      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('should rollback transaction on error', async () => {
      const testError = new Error('Transaction failed');
      mockPrisma.$transaction.mockRejectedValueOnce(testError);

      await expect(
        dbClient.transaction(async (tx) => {
          throw testError;
        })
      ).rejects.toThrow('Transaction failed');

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
    });

    it('should throw error if transaction called without connection', async () => {
      const disconnectedClient = new DatabaseClient();

      await expect(
        disconnectedClient.transaction(async (tx) => {
          return 'test';
        })
      ).rejects.toThrow('Database not connected');
    });

    it('should pass transaction options correctly', async () => {
      mockPrisma.$transaction.mockImplementation(async (fn: any, options: any) => {
        expect(options.maxWait).toBe(30000);
        expect(options.timeout).toBe(30000);
        return await fn(mockPrisma);
      });

      await dbClient.transaction(async (tx) => {
        return 'test';
      });

      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });
  });

  describe('Prepared Statement Execution', () => {
    beforeEach(async () => {
      mockPrisma.$connect.mockResolvedValueOnce(undefined);
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
      await dbClient.connect();
    });

    it('should execute query with parameters', async () => {
      const mockResult = [{ id: '1', name: 'John' }];
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(mockResult);

      const result = await dbClient.query(
        'SELECT * FROM users WHERE id = $1',
        ['1']
      );

      expect(result).toEqual(mockResult);
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        'SELECT * FROM users WHERE id = $1',
        '1'
      );
    });

    it('should execute query without parameters', async () => {
      const mockResult = [{ count: 5 }];
      mockPrisma.$queryRawUnsafe.mockResolvedValueOnce(mockResult);

      const result = await dbClient.query('SELECT COUNT(*) FROM users');

      expect(result).toEqual(mockResult);
      expect(mockPrisma.$queryRawUnsafe).toHaveBeenCalledWith(
        'SELECT COUNT(*) FROM users'
      );
    });

    it('should handle query execution errors', async () => {
      mockPrisma.$queryRawUnsafe.mockRejectedValueOnce(new Error('Syntax error'));

      await expect(
        dbClient.query('SELECT * FROM invalid_table')
      ).rejects.toThrow('Query failed');
    });

    it('should throw error if query called without connection', async () => {
      const disconnectedClient = new DatabaseClient();

      await expect(
        disconnectedClient.query('SELECT 1')
      ).rejects.toThrow('Database not connected');
    });
  });

  describe('Retry Logic with Exponential Backoff', () => {
    beforeEach(async () => {
      mockPrisma.$connect.mockResolvedValueOnce(undefined);
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);
      await dbClient.connect();
    });

    it('should retry operation on retryable error', async () => {
      let attempts = 0;
      const operation = vi.fn(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('ETIMEDOUT');
        }
        return 'success';
      });

      const result = await dbClient.executeWithRetry(operation, 3);

      expect(result).toBe('success');
      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should not retry on non-retryable error', async () => {
      const operation = vi.fn(async () => {
        throw new Error('Validation error');
      });

      await expect(
        dbClient.executeWithRetry(operation, 3)
      ).rejects.toThrow('Validation error');

      expect(operation).toHaveBeenCalledTimes(1);
    });

    it('should throw after max retry attempts', async () => {
      const operation = vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      });

      await expect(
        dbClient.executeWithRetry(operation, 3)
      ).rejects.toThrow('Operation failed after 3 attempts');

      expect(operation).toHaveBeenCalledTimes(3);
    });

    it('should apply exponential backoff between retries', async () => {
      let attempts = 0;
      const operation = vi.fn(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Connection lost');
        }
        return 'success';
      });

      const startTime = Date.now();
      await dbClient.executeWithRetry(operation, 3);
      const endTime = Date.now();

      // Should have delays of 1s + 2s = 3000ms minimum
      expect(endTime - startTime).toBeGreaterThanOrEqual(3000);
    });

    it('should identify retryable errors correctly', async () => {
      const retryableErrors = [
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'ECONNRESET',
        'EPIPE',
      ];

      for (const errorMsg of retryableErrors) {
        let attempts = 0;
        const operation = vi.fn(async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error(errorMsg);
          }
          return 'success';
        });

        const result = await dbClient.executeWithRetry(operation, 3);
        expect(result).toBe('success');
        expect(operation).toHaveBeenCalledTimes(2);
      }
    }, 10000); // Increased timeout for this test
  });

  describe('Health Check', () => {
    it('should return true for healthy connection', async () => {
      mockPrisma.$connect.mockResolvedValueOnce(undefined);
      mockPrisma.$queryRaw.mockResolvedValue([{ '?column?': 1 }]);

      await dbClient.connect();
      const isHealthy = await dbClient.healthCheck();

      expect(isHealthy).toBe(true);
    });

    it('should return false for unhealthy connection', async () => {
      mockPrisma.$connect.mockResolvedValueOnce(undefined);
      mockPrisma.$queryRaw
        .mockResolvedValueOnce([{ '?column?': 1 }])
        .mockRejectedValueOnce(new Error('Connection lost'));

      await dbClient.connect();
      const isHealthy = await dbClient.healthCheck();

      expect(isHealthy).toBe(false);
    });
  });

  describe('Client Access', () => {
    it('should return Prisma client when connected', async () => {
      mockPrisma.$connect.mockResolvedValueOnce(undefined);
      mockPrisma.$queryRaw.mockResolvedValueOnce([{ '?column?': 1 }]);

      await dbClient.connect();
      const client = dbClient.getClient();

      expect(client).toBeDefined();
      expect(client).toBe(mockPrisma);
    });

    it('should throw error when getting client without connection', () => {
      expect(() => dbClient.getClient()).toThrow('Database not connected');
    });
  });
});
