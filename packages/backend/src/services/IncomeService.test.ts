/**
 * IncomeService Unit Tests
 * 
 * Tests for automatic income segregation logic.
 * Validates Requirements 3.1-3.5 and 4.1-4.5.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Decimal } from '@prisma/client/runtime/library';

// Mock the database client
vi.mock('../database', () => {
  let mockEntries: any[] = [];

  const mockPrisma = {
    deliveryEntry: {
      create: vi.fn(async ({ data }: any) => {
        const entry = {
          id: `entry-${Date.now()}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
          fareAmount: new Decimal(data.fareAmount),
          cashAmount: data.cashAmount ? new Decimal(data.cashAmount) : null,
        };
        mockEntries.push(entry);
        return entry;
      }),
      findMany: vi.fn(async ({ where }: any) => {
        let filtered = [...mockEntries];
        
        if (where?.userId) {
          filtered = filtered.filter((e: any) => e.userId === where.userId);
        }
        
        if (where?.restaurantStatus) {
          filtered = filtered.filter((e: any) => e.restaurantStatus === where.restaurantStatus);
        }
        
        if (where?.entryDate?.gte || where?.entryDate?.lte) {
          filtered = filtered.filter((e: any) => {
            const entryDate = new Date(e.entryDate);
            if (where.entryDate.gte && entryDate < new Date(where.entryDate.gte)) {
              return false;
            }
            if (where.entryDate.lte && entryDate > new Date(where.entryDate.lte)) {
              return false;
            }
            return true;
          });
        }
        
        return filtered;
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const entry = mockEntries.find((e: any) => {
          if (where.id && e.id !== where.id) return false;
          if (where.userId && e.userId !== where.userId) return false;
          return true;
        });
        return entry || null;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const index = mockEntries.findIndex((e: any) => e.id === where.id);
        if (index === -1) throw new Error('Entry not found');
        
        const updated = {
          ...mockEntries[index],
          ...data,
          updatedAt: new Date(),
        };
        
        if (data.fareAmount !== undefined) {
          updated.fareAmount = new Decimal(data.fareAmount);
        }
        if (data.cashAmount !== undefined) {
          updated.cashAmount = data.cashAmount ? new Decimal(data.cashAmount) : null;
        }
        
        mockEntries[index] = updated;
        return updated;
      }),
      delete: vi.fn(async ({ where }: any) => {
        const index = mockEntries.findIndex((e: any) => e.id === where.id);
        if (index === -1) throw new Error('Entry not found');
        const deleted = mockEntries[index];
        mockEntries.splice(index, 1);
        return deleted;
      }),
      count: vi.fn(async ({ where }: any) => {
        let filtered = [...mockEntries];
        if (where?.userId) {
          filtered = filtered.filter((e: any) => e.userId === where.userId);
        }
        return filtered.length;
      }),
    },
  };

  const mockDbClient = {
    getClient: vi.fn(() => mockPrisma),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    transaction: vi.fn(async (fn: any) => fn(mockPrisma)),
    executeWithRetry: vi.fn(async (fn: any) => fn()),
    query: vi.fn(async () => []),
    healthCheck: vi.fn(async () => true),
    getPoolInfo: vi.fn(() => ({ min: 5, max: 20, timeout: 30000 })),
  };

  return {
    getDatabaseClient: vi.fn(() => mockDbClient),
    closeDatabase: vi.fn(async () => {}),
    __resetMockEntries: () => {
      mockEntries = [];
    },
  };
});

describe('IncomeService - Automatic Income Segregation', () => {
  let service: any;
  const testUserId = 'test-user-id';

  beforeEach(async () => {
    const { __resetMockEntries } = await import('../database');
    __resetMockEntries();
    
    // Import service after mock setup
    const { IncomeService: ServiceClass } = await import('./IncomeService');
    service = new ServiceClass();
  });

  describe('Requirement 3.1: Classify halal restaurant income as Halal_Income', () => {
    it('should classify fare amount from halal restaurant as halal income', async () => {
      await service.createEntry(testUserId, {
        restaurantName: 'Halal Pizza',
        restaurantStatus: 'halal',
        fareAmount: 25.50,
        hasCashOrder: false,
      });

      const segregation = await service.calculateTotals(testUserId);

      expect(segregation.totalHalalIncome).toBe(25.50);
      expect(segregation.totalNonHalalIncome).toBe(0);
    });

    it('should classify fare and cash amount from halal restaurant as halal income', async () => {
      await service.createEntry(testUserId, {
        restaurantName: 'Halal Burgers',
        restaurantStatus: 'halal',
        fareAmount: 20.00,
        hasCashOrder: true,
        cashAmount: 5.00,
      });

      const segregation = await service.calculateTotals(testUserId);

      expect(segregation.totalHalalIncome).toBe(25.00);
      expect(segregation.totalNonHalalIncome).toBe(0);
    });
  });

  describe('Requirement 3.2: Classify non-halal restaurant income as NonHalal_Income', () => {
    it('should classify fare amount from non-halal restaurant as non-halal income', async () => {
      await service.createEntry(testUserId, {
        restaurantName: 'Regular Pizza',
        restaurantStatus: 'non-halal',
        fareAmount: 30.00,
        hasCashOrder: false,
      });

      const segregation = await service.calculateTotals(testUserId);

      expect(segregation.totalHalalIncome).toBe(0);
      expect(segregation.totalNonHalalIncome).toBe(30.00);
    });

    it('should classify fare and cash from non-halal restaurant as non-halal income', async () => {
      await service.createEntry(testUserId, {
        restaurantName: 'BBQ Place',
        restaurantStatus: 'non-halal',
        fareAmount: 18.50,
        hasCashOrder: true,
        cashAmount: 3.50,
      });

      const segregation = await service.calculateTotals(testUserId);

      expect(segregation.totalHalalIncome).toBe(0);
      expect(segregation.totalNonHalalIncome).toBe(22.00);
    });
  });

  describe('Requirement 3.3: Include both Fare_Amount and Cash_Amount', () => {
    it('should include both fare and cash in income calculation', async () => {
      await service.createEntry(testUserId, {
        restaurantName: 'Test Restaurant',
        restaurantStatus: 'halal',
        fareAmount: 15.75,
        hasCashOrder: true,
        cashAmount: 4.25,
      });

      const segregation = await service.calculateTotals(testUserId);

      expect(segregation.totalHalalIncome).toBe(20.00);
    });
  });

  describe('Requirement 3.4: Calculate total Halal_Income', () => {
    it('should sum all halal income from multiple entries', async () => {
      await service.createEntry(testUserId, {
        restaurantName: 'Halal Place 1',
        restaurantStatus: 'halal',
        fareAmount: 10.00,
        hasCashOrder: false,
      });

      await service.createEntry(testUserId, {
        restaurantName: 'Halal Place 2',
        restaurantStatus: 'halal',
        fareAmount: 15.50,
        hasCashOrder: true,
        cashAmount: 2.50,
      });

      const segregation = await service.calculateTotals(testUserId);

      expect(segregation.totalHalalIncome).toBe(28.00);
    });
  });

  describe('Requirement 3.5: Calculate total NonHalal_Income', () => {
    it('should sum all non-halal income from multiple entries', async () => {
      await service.createEntry(testUserId, {
        restaurantName: 'Non-Halal Place 1',
        restaurantStatus: 'non-halal',
        fareAmount: 12.00,
        hasCashOrder: false,
      });

      await service.createEntry(testUserId, {
        restaurantName: 'Non-Halal Place 2',
        restaurantStatus: 'non-halal',
        fareAmount: 8.50,
        hasCashOrder: true,
        cashAmount: 1.50,
      });

      const segregation = await service.calculateTotals(testUserId);

      expect(segregation.totalNonHalalIncome).toBe(22.00);
    });
  });

  describe('Requirement 4.1: Treat Fare_Amount as digital payment income', () => {
    it('should count fare amount as digital income', async () => {
      await service.createEntry(testUserId, {
        restaurantName: 'Test Restaurant',
        restaurantStatus: 'halal',
        fareAmount: 25.00,
        hasCashOrder: false,
      });

      const segregation = await service.calculateTotals(testUserId);

      expect(segregation.totalDigitalIncome).toBe(25.00);
    });
  });

  describe('Requirement 4.3: Store Cash_Amount separately', () => {
    it('should track cash amount separately', async () => {
      await service.createEntry(testUserId, {
        restaurantName: 'Test Restaurant',
        restaurantStatus: 'halal',
        fareAmount: 20.00,
        hasCashOrder: true,
        cashAmount: 5.00,
      });

      const segregation = await service.calculateTotals(testUserId);

      expect(segregation.totalDigitalIncome).toBe(20.00);
      expect(segregation.totalCashIncome).toBe(5.00);
    });
  });

  describe('Requirement 4.4: Calculate total cash income', () => {
    it('should sum all cash amounts from entries', async () => {
      await service.createEntry(testUserId, {
        restaurantName: 'Restaurant 1',
        restaurantStatus: 'halal',
        fareAmount: 20.00,
        hasCashOrder: true,
        cashAmount: 5.00,
      });

      await service.createEntry(testUserId, {
        restaurantName: 'Restaurant 2',
        restaurantStatus: 'non-halal',
        fareAmount: 15.00,
        hasCashOrder: true,
        cashAmount: 3.50,
      });

      const segregation = await service.calculateTotals(testUserId);

      expect(segregation.totalCashIncome).toBe(8.50);
    });
  });
});
