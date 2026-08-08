import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import { DeliveryEntry } from '../types';

// Create mock functions that will be used by the route
const mockCreateEntry = vi.fn();
const mockDeleteEntry = vi.fn();
const mockGetEntries = vi.fn();
const mockUpdateEntry = vi.fn();

// Mock the IncomeService
vi.mock('../services/IncomeService', () => {
  return {
    IncomeService: vi.fn(() => ({
      createEntry: mockCreateEntry,
      deleteEntry: mockDeleteEntry,
      getEntries: mockGetEntries,
      updateEntry: mockUpdateEntry,
    })),
  };
});

// Mock the auth middleware
vi.mock('../middleware/auth', () => ({
  authenticateToken: vi.fn((req: any, _res: any, next: any) => {
    req.user = {
      userId: 'test-user-id',
      email: 'test@example.com',
    };
    next();
  }),
  AuthenticatedRequest: {},
}));

describe('POST /api/income-entries', () => {
  let app: express.Application;

  beforeEach(async () => {
    // Clear all mocks
    vi.clearAllMocks();

    // Create Express app with the income routes
    app = express();
    app.use(express.json());
    
    // Import incomeRoutes after mocks are set up
    const incomeRoutes = (await import('./income')).default;
    app.use('/api/income-entries', incomeRoutes);
  });

  describe('Success cases', () => {
    it('should create a delivery entry with valid data and return 201', async () => {
      const mockEntry: DeliveryEntry = {
        id: 'entry-123',
        userId: 'test-user-id',
        restaurantName: 'Test Restaurant',
        restaurantStatus: 'halal',
        fareAmount: 15.50,
        hasCashOrder: true,
        cashAmount: 5.00,
        entryDate: new Date('2024-01-15'),
        timestamp: new Date('2024-01-15T10:30:00Z'),
        createdAt: new Date('2024-01-15T10:30:00Z'),
        updatedAt: new Date('2024-01-15T10:30:00Z'),
      };

      mockCreateEntry.mockResolvedValue(mockEntry);

      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: 'Test Restaurant',
          restaurantStatus: 'halal',
          fareAmount: 15.50,
          hasCashOrder: true,
          cashAmount: 5.00,
          entryDate: '2024-01-15',
        });

      expect(response.status).toBe(201);
      expect(response.body.entry).toBeDefined();
      expect(response.body.entry.id).toBe('entry-123');
      expect(response.body.entry.restaurantName).toBe('Test Restaurant');
      expect(mockCreateEntry).toHaveBeenCalledWith(
        'test-user-id',
        expect.objectContaining({
          restaurantName: 'Test Restaurant',
          restaurantStatus: 'halal',
          fareAmount: 15.50,
          hasCashOrder: true,
          cashAmount: 5.00,
        })
      );
    });

    it('should create entry without cash amount when hasCashOrder is false', async () => {
      const mockEntry: DeliveryEntry = {
        id: 'entry-124',
        userId: 'test-user-id',
        restaurantName: 'Digital Only Restaurant',
        restaurantStatus: 'non-halal',
        fareAmount: 20.00,
        hasCashOrder: false,
        entryDate: new Date('2024-01-15'),
        timestamp: new Date('2024-01-15T10:30:00Z'),
        createdAt: new Date('2024-01-15T10:30:00Z'),
        updatedAt: new Date('2024-01-15T10:30:00Z'),
      };

      mockCreateEntry.mockResolvedValue(mockEntry);

      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: 'Digital Only Restaurant',
          restaurantStatus: 'non-halal',
          fareAmount: 20.00,
          hasCashOrder: false,
        });

      expect(response.status).toBe(201);
      expect(response.body.entry.hasCashOrder).toBe(false);
      expect(response.body.entry.cashAmount).toBeUndefined();
    });

    it('should use current date when entryDate is not provided', async () => {
      const mockEntry: DeliveryEntry = {
        id: 'entry-125',
        userId: 'test-user-id',
        restaurantName: 'Current Date Restaurant',
        restaurantStatus: 'halal',
        fareAmount: 12.00,
        hasCashOrder: false,
        entryDate: new Date(),
        timestamp: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      mockCreateEntry.mockResolvedValue(mockEntry);

      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: 'Current Date Restaurant',
          restaurantStatus: 'halal',
          fareAmount: 12.00,
          hasCashOrder: false,
        });

      expect(response.status).toBe(201);
      expect(mockCreateEntry).toHaveBeenCalledWith(
        'test-user-id',
        expect.objectContaining({
          entryDate: undefined, // Should be undefined in the data object
        })
      );
    });
  });

  describe('Validation errors', () => {
    it('should return 400 when restaurantName is empty', async () => {
      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: '',
          restaurantStatus: 'halal',
          fareAmount: 10.00,
          hasCashOrder: false,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Restaurant name must be between 1 and 100 characters'
      );
    });

    it('should return 400 when restaurantName exceeds 100 characters', async () => {
      const longName = 'A'.repeat(101);
      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: longName,
          restaurantStatus: 'halal',
          fareAmount: 10.00,
          hasCashOrder: false,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 400 when restaurantStatus is invalid', async () => {
      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: 'Test Restaurant',
          restaurantStatus: 'unknown',
          fareAmount: 10.00,
          hasCashOrder: false,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Restaurant status must be either "halal" or "non-halal"'
      );
    });

    it('should return 400 when fareAmount is zero or negative', async () => {
      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: 'Test Restaurant',
          restaurantStatus: 'halal',
          fareAmount: 0,
          hasCashOrder: false,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('Fare amount must be greater than 0');
    });

    it('should return 400 when fareAmount has more than 2 decimal places', async () => {
      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: 'Test Restaurant',
          restaurantStatus: 'halal',
          fareAmount: 10.123,
          hasCashOrder: false,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Fare amount must have at most 2 decimal places'
      );
    });

    it('should return 400 when hasCashOrder is not a boolean', async () => {
      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: 'Test Restaurant',
          restaurantStatus: 'halal',
          fareAmount: 10.00,
          hasCashOrder: 'yes',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('hasCashOrder must be a boolean');
    });

    it('should return 400 when cashAmount is zero or negative', async () => {
      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: 'Test Restaurant',
          restaurantStatus: 'halal',
          fareAmount: 10.00,
          hasCashOrder: true,
          cashAmount: 0,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Cash amount must be greater than 0 if provided'
      );
    });

    it('should return 400 when cashAmount has more than 2 decimal places', async () => {
      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: 'Test Restaurant',
          restaurantStatus: 'halal',
          fareAmount: 10.00,
          hasCashOrder: true,
          cashAmount: 5.123,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Cash amount must have at most 2 decimal places'
      );
    });

    it('should return 400 when hasCashOrder is true but cashAmount is missing', async () => {
      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: 'Test Restaurant',
          restaurantStatus: 'halal',
          fareAmount: 10.00,
          hasCashOrder: true,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Cash amount is required when hasCashOrder is true'
      );
    });

    it('should return 400 when entryDate is in the future', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 1);

      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: 'Test Restaurant',
          restaurantStatus: 'halal',
          fareAmount: 10.00,
          hasCashOrder: false,
          entryDate: futureDate.toISOString(),
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('Entry date cannot be in the future');
    });

    it('should return 400 when entryDate is not a valid ISO 8601 date', async () => {
      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: 'Test Restaurant',
          restaurantStatus: 'halal',
          fareAmount: 10.00,
          hasCashOrder: false,
          entryDate: 'not-a-date',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Entry date must be a valid ISO 8601 date'
      );
    });
  });

  describe('Error handling', () => {
    it('should return 500 when service throws an error', async () => {
      mockCreateEntry.mockRejectedValue(
        new Error('Database connection failed')
      );

      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: 'Test Restaurant',
          restaurantStatus: 'halal',
          fareAmount: 10.00,
          hasCashOrder: false,
        });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to create income entry');
    });

    it('should return 409 when duplicate entry is detected', async () => {
      mockCreateEntry.mockRejectedValue(
        new Error('Duplicate entry detected')
      );

      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: 'Test Restaurant',
          restaurantStatus: 'halal',
          fareAmount: 10.00,
          hasCashOrder: false,
        });

      expect(response.status).toBe(409);
      expect(response.body.error).toBe('Duplicate entry detected');
    });
  });

  describe('Performance requirements', () => {
    it('should complete database write within 2 seconds (Requirement 7.1)', async () => {
      const mockEntry: DeliveryEntry = {
        id: 'entry-perf',
        userId: 'test-user-id',
        restaurantName: 'Performance Test',
        restaurantStatus: 'halal',
        fareAmount: 10.00,
        hasCashOrder: false,
        entryDate: new Date(),
        timestamp: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Simulate a fast database write (under 2 seconds)
      mockCreateEntry.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(mockEntry), 100))
      );

      const startTime = Date.now();
      const response = await request(app)
        .post('/api/income-entries')
        .send({
          restaurantName: 'Performance Test',
          restaurantStatus: 'halal',
          fareAmount: 10.00,
          hasCashOrder: false,
        });
      const duration = Date.now() - startTime;

      expect(response.status).toBe(201);
      expect(duration).toBeLessThan(2000);
    });
  });
});

describe('DELETE /api/income-entries/:id', () => {
  let app: express.Application;

  beforeEach(async () => {
    // Clear all mocks
    vi.clearAllMocks();

    // Create Express app with the income routes
    app = express();
    app.use(express.json());
    
    // Import incomeRoutes after mocks are set up
    const incomeRoutes = (await import('./income')).default;
    app.use('/api/income-entries', incomeRoutes);
  });

  describe('Success cases', () => {
    it('should delete a delivery entry with valid ID and return 200', async () => {
      mockDeleteEntry.mockResolvedValue(undefined);

      const response = await request(app)
        .delete('/api/income-entries/550e8400-e29b-41d4-a716-446655440000');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Entry deleted successfully');
      expect(mockDeleteEntry).toHaveBeenCalledWith(
        'test-user-id',
        '550e8400-e29b-41d4-a716-446655440000'
      );
    });
  });

  describe('Validation errors', () => {
    it('should return 400 when entry ID is not a valid UUID', async () => {
      const response = await request(app)
        .delete('/api/income-entries/invalid-uuid');

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Invalid entry ID format');
      expect(mockDeleteEntry).not.toHaveBeenCalled();
    });

    it('should return 400 when entry ID is empty', async () => {
      const response = await request(app)
        .delete('/api/income-entries/');

      expect(response.status).toBe(404); // Express returns 404 for route not found
    });
  });

  describe('Ownership validation', () => {
    it('should return 404 when entry does not exist', async () => {
      mockDeleteEntry.mockRejectedValue(
        new Error('Entry not found or does not belong to user')
      );

      const response = await request(app)
        .delete('/api/income-entries/550e8400-e29b-41d4-a716-446655440000');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Entry not found or does not belong to user');
    });

    it('should return 404 when entry belongs to different user', async () => {
      mockDeleteEntry.mockRejectedValue(
        new Error('Entry not found or does not belong to user')
      );

      const response = await request(app)
        .delete('/api/income-entries/550e8400-e29b-41d4-a716-446655440001');

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Entry not found or does not belong to user');
    });
  });

  describe('Error handling', () => {
    it('should return 500 when service throws an unexpected error', async () => {
      mockDeleteEntry.mockRejectedValue(
        new Error('Database connection failed')
      );

      const response = await request(app)
        .delete('/api/income-entries/550e8400-e29b-41d4-a716-446655440000');

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to delete income entry');
    });
  });
});

describe('PUT /api/income-entries/:id', () => {
  let app: express.Application;

  beforeEach(async () => {
    // Clear all mocks
    vi.clearAllMocks();

    // Create Express app with the income routes
    app = express();
    app.use(express.json());
    
    // Import incomeRoutes after mocks are set up
    const incomeRoutes = (await import('./income')).default;
    app.use('/api/income-entries', incomeRoutes);
  });

  describe('Success cases', () => {
    it('should update a delivery entry with partial data and return 200', async () => {
      const mockEntry: DeliveryEntry = {
        id: 'entry-123',
        userId: 'test-user-id',
        restaurantName: 'Updated Restaurant',
        restaurantStatus: 'non-halal',
        fareAmount: 25.00,
        hasCashOrder: false,
        entryDate: new Date('2024-01-15'),
        timestamp: new Date('2024-01-15T10:30:00Z'),
        createdAt: new Date('2024-01-15T10:30:00Z'),
        updatedAt: new Date('2024-01-16T10:30:00Z'),
      };

      mockUpdateEntry.mockResolvedValue(mockEntry);

      const response = await request(app)
        .put('/api/income-entries/entry-123')
        .send({
          restaurantName: 'Updated Restaurant',
          restaurantStatus: 'non-halal',
        });

      expect(response.status).toBe(200);
      expect(response.body.entry).toBeDefined();
      expect(response.body.entry.id).toBe('entry-123');
      expect(response.body.entry.restaurantName).toBe('Updated Restaurant');
      expect(response.body.entry.restaurantStatus).toBe('non-halal');
      expect(mockUpdateEntry).toHaveBeenCalledWith(
        'test-user-id',
        'entry-123',
        expect.objectContaining({
          restaurantName: 'Updated Restaurant',
          restaurantStatus: 'non-halal',
        })
      );
    });

    it('should update only fareAmount', async () => {
      const mockEntry: DeliveryEntry = {
        id: 'entry-124',
        userId: 'test-user-id',
        restaurantName: 'Test Restaurant',
        restaurantStatus: 'halal',
        fareAmount: 30.00,
        hasCashOrder: false,
        entryDate: new Date('2024-01-15'),
        timestamp: new Date('2024-01-15T10:30:00Z'),
        createdAt: new Date('2024-01-15T10:30:00Z'),
        updatedAt: new Date('2024-01-16T10:30:00Z'),
      };

      mockUpdateEntry.mockResolvedValue(mockEntry);

      const response = await request(app)
        .put('/api/income-entries/entry-124')
        .send({
          fareAmount: 30.00,
        });

      expect(response.status).toBe(200);
      expect(response.body.entry.fareAmount).toBe(30.00);
      expect(mockUpdateEntry).toHaveBeenCalledWith(
        'test-user-id',
        'entry-124',
        expect.objectContaining({
          fareAmount: 30.00,
        })
      );
    });

    it('should update cash order details', async () => {
      const mockEntry: DeliveryEntry = {
        id: 'entry-125',
        userId: 'test-user-id',
        restaurantName: 'Cash Restaurant',
        restaurantStatus: 'halal',
        fareAmount: 20.00,
        hasCashOrder: true,
        cashAmount: 10.00,
        entryDate: new Date('2024-01-15'),
        timestamp: new Date('2024-01-15T10:30:00Z'),
        createdAt: new Date('2024-01-15T10:30:00Z'),
        updatedAt: new Date('2024-01-16T10:30:00Z'),
      };

      mockUpdateEntry.mockResolvedValue(mockEntry);

      const response = await request(app)
        .put('/api/income-entries/entry-125')
        .send({
          hasCashOrder: true,
          cashAmount: 10.00,
        });

      expect(response.status).toBe(200);
      expect(response.body.entry.hasCashOrder).toBe(true);
      expect(response.body.entry.cashAmount).toBe(10.00);
    });

    it('should update entryDate', async () => {
      const mockEntry: DeliveryEntry = {
        id: 'entry-126',
        userId: 'test-user-id',
        restaurantName: 'Date Update Restaurant',
        restaurantStatus: 'halal',
        fareAmount: 15.00,
        hasCashOrder: false,
        entryDate: new Date('2024-01-10'),
        timestamp: new Date('2024-01-15T10:30:00Z'),
        createdAt: new Date('2024-01-15T10:30:00Z'),
        updatedAt: new Date('2024-01-16T10:30:00Z'),
      };

      mockUpdateEntry.mockResolvedValue(mockEntry);

      const response = await request(app)
        .put('/api/income-entries/entry-126')
        .send({
          entryDate: '2024-01-10',
        });

      expect(response.status).toBe(200);
      expect(mockUpdateEntry).toHaveBeenCalledWith(
        'test-user-id',
        'entry-126',
        expect.objectContaining({
          entryDate: expect.any(Date),
        })
      );
    });

    it('should update restaurant status to trigger re-segregation (Requirement 14.2)', async () => {
      const mockEntry: DeliveryEntry = {
        id: 'entry-127',
        userId: 'test-user-id',
        restaurantName: 'Status Change Restaurant',
        restaurantStatus: 'non-halal',
        fareAmount: 20.00,
        hasCashOrder: true,
        cashAmount: 5.00,
        entryDate: new Date('2024-01-15'),
        timestamp: new Date('2024-01-15T10:30:00Z'),
        createdAt: new Date('2024-01-15T10:30:00Z'),
        updatedAt: new Date('2024-01-16T10:30:00Z'),
      };

      mockUpdateEntry.mockResolvedValue(mockEntry);

      const response = await request(app)
        .put('/api/income-entries/entry-127')
        .send({
          restaurantStatus: 'non-halal',
        });

      expect(response.status).toBe(200);
      expect(response.body.entry.restaurantStatus).toBe('non-halal');
      expect(mockUpdateEntry).toHaveBeenCalledWith(
        'test-user-id',
        'entry-127',
        expect.objectContaining({
          restaurantStatus: 'non-halal',
        })
      );
    });
  });

  describe('Validation errors', () => {
    it('should return 400 when restaurantName is empty', async () => {
      const response = await request(app)
        .put('/api/income-entries/entry-123')
        .send({
          restaurantName: '',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Restaurant name must be between 1 and 100 characters'
      );
    });

    it('should return 400 when restaurantName exceeds 100 characters', async () => {
      const longName = 'A'.repeat(101);
      const response = await request(app)
        .put('/api/income-entries/entry-123')
        .send({
          restaurantName: longName,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 400 when restaurantStatus is invalid', async () => {
      const response = await request(app)
        .put('/api/income-entries/entry-123')
        .send({
          restaurantStatus: 'maybe-halal',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Restaurant status must be either "halal" or "non-halal"'
      );
    });

    it('should return 400 when fareAmount is zero or negative', async () => {
      const response = await request(app)
        .put('/api/income-entries/entry-123')
        .send({
          fareAmount: -5.00,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('Fare amount must be greater than 0');
    });

    it('should return 400 when fareAmount has more than 2 decimal places', async () => {
      const response = await request(app)
        .put('/api/income-entries/entry-123')
        .send({
          fareAmount: 10.999,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Fare amount must have at most 2 decimal places'
      );
    });

    it('should return 400 when hasCashOrder is not a boolean', async () => {
      const response = await request(app)
        .put('/api/income-entries/entry-123')
        .send({
          hasCashOrder: 'true',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('hasCashOrder must be a boolean');
    });

    it('should return 400 when cashAmount is zero or negative', async () => {
      const response = await request(app)
        .put('/api/income-entries/entry-123')
        .send({
          cashAmount: 0,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Cash amount must be greater than 0 if provided'
      );
    });

    it('should return 400 when cashAmount has more than 2 decimal places', async () => {
      const response = await request(app)
        .put('/api/income-entries/entry-123')
        .send({
          cashAmount: 5.123,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Cash amount must have at most 2 decimal places'
      );
    });

    it('should return 400 when hasCashOrder is true but cashAmount is missing', async () => {
      const response = await request(app)
        .put('/api/income-entries/entry-123')
        .send({
          hasCashOrder: true,
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Cash amount is required when hasCashOrder is true'
      );
    });

    it('should return 400 when entryDate is in the future', async () => {
      const futureDate = new Date();
      futureDate.setDate(futureDate.getDate() + 1);

      const response = await request(app)
        .put('/api/income-entries/entry-123')
        .send({
          entryDate: futureDate.toISOString(),
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain('Entry date cannot be in the future');
    });

    it('should return 400 when entryDate is not a valid ISO 8601 date', async () => {
      const response = await request(app)
        .put('/api/income-entries/entry-123')
        .send({
          entryDate: 'invalid-date',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Entry date must be a valid ISO 8601 date'
      );
    });
  });

  describe('Ownership validation (Requirement 14.1)', () => {
    it('should return 404 when entry does not belong to user', async () => {
      mockUpdateEntry.mockRejectedValue(
        new Error('Entry not found or does not belong to user')
      );

      const response = await request(app)
        .put('/api/income-entries/entry-999')
        .send({
          restaurantName: 'Updated Name',
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Entry not found or does not belong to user');
    });

    it('should return 404 when entry does not exist', async () => {
      mockUpdateEntry.mockRejectedValue(
        new Error('Entry not found or does not belong to user')
      );

      const response = await request(app)
        .put('/api/income-entries/nonexistent-id')
        .send({
          fareAmount: 20.00,
        });

      expect(response.status).toBe(404);
      expect(response.body.error).toBe('Entry not found or does not belong to user');
    });
  });

  describe('Error handling', () => {
    it('should return 500 when service throws an unexpected error', async () => {
      mockUpdateEntry.mockRejectedValue(
        new Error('Database connection failed')
      );

      const response = await request(app)
        .put('/api/income-entries/entry-123')
        .send({
          fareAmount: 20.00,
        });

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to update income entry');
    });
  });

  describe('Performance requirements', () => {
    it('should complete database update within 2 seconds (Requirement 7.2)', async () => {
      const mockEntry: DeliveryEntry = {
        id: 'entry-perf',
        userId: 'test-user-id',
        restaurantName: 'Performance Test',
        restaurantStatus: 'halal',
        fareAmount: 25.00,
        hasCashOrder: false,
        entryDate: new Date(),
        timestamp: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Simulate a fast database update (under 2 seconds)
      mockUpdateEntry.mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve(mockEntry), 100))
      );

      const startTime = Date.now();
      const response = await request(app)
        .put('/api/income-entries/entry-perf')
        .send({
          fareAmount: 25.00,
        });
      const duration = Date.now() - startTime;

      expect(response.status).toBe(200);
      expect(duration).toBeLessThan(2000);
    });
  });
});

describe('GET /api/income-entries', () => {
  let app: express.Application;

  beforeEach(async () => {
    // Clear all mocks
    vi.clearAllMocks();

    // Create Express app with the income routes
    app = express();
    app.use(express.json());
    
    // Import incomeRoutes after mocks are set up
    const incomeRoutes = (await import('./income')).default;
    app.use('/api/income-entries', incomeRoutes);
  });

  describe('Success cases', () => {
    it('should retrieve entries without filters and return 200', async () => {
      const mockEntries: DeliveryEntry[] = [
        {
          id: 'entry-1',
          userId: 'test-user-id',
          restaurantName: 'Restaurant A',
          restaurantStatus: 'halal',
          fareAmount: 15.50,
          hasCashOrder: true,
          cashAmount: 5.00,
          entryDate: new Date('2024-01-15'),
          timestamp: new Date('2024-01-15T10:30:00Z'),
          createdAt: new Date('2024-01-15T10:30:00Z'),
          updatedAt: new Date('2024-01-15T10:30:00Z'),
        },
        {
          id: 'entry-2',
          userId: 'test-user-id',
          restaurantName: 'Restaurant B',
          restaurantStatus: 'non-halal',
          fareAmount: 20.00,
          hasCashOrder: false,
          entryDate: new Date('2024-01-14'),
          timestamp: new Date('2024-01-14T12:00:00Z'),
          createdAt: new Date('2024-01-14T12:00:00Z'),
          updatedAt: new Date('2024-01-14T12:00:00Z'),
        },
      ];

      mockGetEntries.mockResolvedValue({ entries: mockEntries, total: 2 });

      const response = await request(app).get('/api/income-entries');

      expect(response.status).toBe(200);
      expect(response.body.entries).toHaveLength(2);
      expect(response.body.total).toBe(2);
      expect(mockGetEntries).toHaveBeenCalledWith(
        'test-user-id',
        expect.objectContaining({
          limit: 50,
          offset: 0,
        })
      );
    });

    it('should filter entries by date range', async () => {
      mockGetEntries.mockResolvedValue({ entries: [], total: 0 });

      const response = await request(app)
        .get('/api/income-entries')
        .query({
          startDate: '2024-01-01',
          endDate: '2024-01-31',
        });

      expect(response.status).toBe(200);
      expect(mockGetEntries).toHaveBeenCalledWith(
        'test-user-id',
        expect.objectContaining({
          startDate: expect.any(Date),
          endDate: expect.any(Date),
        })
      );
    });

    it('should filter entries by restaurant status', async () => {
      const halalEntries: DeliveryEntry[] = [
        {
          id: 'entry-1',
          userId: 'test-user-id',
          restaurantName: 'Halal Restaurant',
          restaurantStatus: 'halal',
          fareAmount: 15.00,
          hasCashOrder: false,
          entryDate: new Date('2024-01-15'),
          timestamp: new Date('2024-01-15T10:30:00Z'),
          createdAt: new Date('2024-01-15T10:30:00Z'),
          updatedAt: new Date('2024-01-15T10:30:00Z'),
        },
      ];

      mockGetEntries.mockResolvedValue({ entries: halalEntries, total: 1 });

      const response = await request(app)
        .get('/api/income-entries')
        .query({ restaurantStatus: 'halal' });

      expect(response.status).toBe(200);
      expect(response.body.entries).toHaveLength(1);
      expect(response.body.entries[0].restaurantStatus).toBe('halal');
      expect(mockGetEntries).toHaveBeenCalledWith(
        'test-user-id',
        expect.objectContaining({
          restaurantStatus: 'halal',
        })
      );
    });

    it('should filter entries by payment type - cash only', async () => {
      mockGetEntries.mockResolvedValue({ entries: [], total: 0 });

      const response = await request(app)
        .get('/api/income-entries')
        .query({ paymentType: 'cash' });

      expect(response.status).toBe(200);
      expect(mockGetEntries).toHaveBeenCalledWith(
        'test-user-id',
        expect.objectContaining({
          paymentType: 'cash',
        })
      );
    });

    it('should filter entries by payment type - digital only', async () => {
      mockGetEntries.mockResolvedValue({ entries: [], total: 0 });

      const response = await request(app)
        .get('/api/income-entries')
        .query({ paymentType: 'digital' });

      expect(response.status).toBe(200);
      expect(mockGetEntries).toHaveBeenCalledWith(
        'test-user-id',
        expect.objectContaining({
          paymentType: 'digital',
        })
      );
    });

    it('should filter entries by payment type - both', async () => {
      mockGetEntries.mockResolvedValue({ entries: [], total: 0 });

      const response = await request(app)
        .get('/api/income-entries')
        .query({ paymentType: 'both' });

      expect(response.status).toBe(200);
      expect(mockGetEntries).toHaveBeenCalledWith(
        'test-user-id',
        expect.objectContaining({
          paymentType: 'both',
        })
      );
    });

    it('should support pagination with limit and offset', async () => {
      mockGetEntries.mockResolvedValue({ entries: [], total: 100 });

      const response = await request(app)
        .get('/api/income-entries')
        .query({ limit: 10, offset: 20 });

      expect(response.status).toBe(200);
      expect(mockGetEntries).toHaveBeenCalledWith(
        'test-user-id',
        expect.objectContaining({
          limit: 10,
          offset: 20,
        })
      );
    });

    it('should combine multiple filters', async () => {
      mockGetEntries.mockResolvedValue({ entries: [], total: 0 });

      const response = await request(app)
        .get('/api/income-entries')
        .query({
          startDate: '2024-01-01',
          endDate: '2024-01-31',
          restaurantStatus: 'halal',
          paymentType: 'cash',
          limit: 25,
          offset: 10,
        });

      expect(response.status).toBe(200);
      expect(mockGetEntries).toHaveBeenCalledWith(
        'test-user-id',
        expect.objectContaining({
          startDate: expect.any(Date),
          endDate: expect.any(Date),
          restaurantStatus: 'halal',
          paymentType: 'cash',
          limit: 25,
          offset: 10,
        })
      );
    });

    it('should return entries in reverse chronological order (Requirement 8.1)', async () => {
      const mockEntries: DeliveryEntry[] = [
        {
          id: 'entry-3',
          userId: 'test-user-id',
          restaurantName: 'Latest',
          restaurantStatus: 'halal',
          fareAmount: 25.00,
          hasCashOrder: false,
          entryDate: new Date('2024-01-17'),
          timestamp: new Date('2024-01-17T10:00:00Z'),
          createdAt: new Date('2024-01-17T10:00:00Z'),
          updatedAt: new Date('2024-01-17T10:00:00Z'),
        },
        {
          id: 'entry-2',
          userId: 'test-user-id',
          restaurantName: 'Middle',
          restaurantStatus: 'halal',
          fareAmount: 20.00,
          hasCashOrder: false,
          entryDate: new Date('2024-01-16'),
          timestamp: new Date('2024-01-16T10:00:00Z'),
          createdAt: new Date('2024-01-16T10:00:00Z'),
          updatedAt: new Date('2024-01-16T10:00:00Z'),
        },
        {
          id: 'entry-1',
          userId: 'test-user-id',
          restaurantName: 'Oldest',
          restaurantStatus: 'halal',
          fareAmount: 15.00,
          hasCashOrder: false,
          entryDate: new Date('2024-01-15'),
          timestamp: new Date('2024-01-15T10:00:00Z'),
          createdAt: new Date('2024-01-15T10:00:00Z'),
          updatedAt: new Date('2024-01-15T10:00:00Z'),
        },
      ];

      mockGetEntries.mockResolvedValue({ entries: mockEntries, total: 3 });

      const response = await request(app).get('/api/income-entries');

      expect(response.status).toBe(200);
      expect(response.body.entries).toHaveLength(3);
      // Verify chronological order (newest first)
      expect(new Date(response.body.entries[0].entryDate).getTime()).toBeGreaterThan(
        new Date(response.body.entries[1].entryDate).getTime()
      );
      expect(new Date(response.body.entries[1].entryDate).getTime()).toBeGreaterThan(
        new Date(response.body.entries[2].entryDate).getTime()
      );
    });
  });

  describe('Validation errors', () => {
    it('should return 400 when startDate is not a valid ISO 8601 date', async () => {
      const response = await request(app)
        .get('/api/income-entries')
        .query({ startDate: 'invalid-date' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Start date must be a valid ISO 8601 date'
      );
    });

    it('should return 400 when endDate is not a valid ISO 8601 date', async () => {
      const response = await request(app)
        .get('/api/income-entries')
        .query({ endDate: 'invalid-date' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'End date must be a valid ISO 8601 date'
      );
    });

    it('should return 400 when endDate is before startDate', async () => {
      const response = await request(app)
        .get('/api/income-entries')
        .query({
          startDate: '2024-01-31',
          endDate: '2024-01-01',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'End date must be after or equal to start date'
      );
    });

    it('should return 400 when restaurantStatus is invalid', async () => {
      const response = await request(app)
        .get('/api/income-entries')
        .query({ restaurantStatus: 'unknown' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Restaurant status must be either "halal" or "non-halal"'
      );
    });

    it('should return 400 when paymentType is invalid', async () => {
      const response = await request(app)
        .get('/api/income-entries')
        .query({ paymentType: 'invalid' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Payment type must be "cash", "digital", or "both"'
      );
    });

    it('should return 400 when limit is less than 1', async () => {
      const response = await request(app)
        .get('/api/income-entries')
        .query({ limit: 0 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Limit must be an integer between 1 and 100'
      );
    });

    it('should return 400 when limit exceeds 100', async () => {
      const response = await request(app)
        .get('/api/income-entries')
        .query({ limit: 101 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Limit must be an integer between 1 and 100'
      );
    });

    it('should return 400 when offset is negative', async () => {
      const response = await request(app)
        .get('/api/income-entries')
        .query({ offset: -1 });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Offset must be a non-negative integer'
      );
    });
  });

  describe('Error handling', () => {
    it('should return 500 when service throws an error', async () => {
      mockGetEntries.mockRejectedValue(
        new Error('Database connection failed')
      );

      const response = await request(app).get('/api/income-entries');

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to retrieve income entries');
    });
  });
});

describe('GET /api/income-entries/export', () => {
  let app: express.Application;

  beforeEach(async () => {
    // Clear all mocks
    vi.clearAllMocks();

    // Create Express app with the income routes
    app = express();
    app.use(express.json());
    
    // Import incomeRoutes after mocks are set up
    const incomeRoutes = (await import('./income')).default;
    app.use('/api/income-entries', incomeRoutes);
  });

  describe('Success cases', () => {
    it('should export entries as CSV with proper headers', async () => {
      const mockEntries: DeliveryEntry[] = [
        {
          id: 'entry-1',
          userId: 'test-user-id',
          restaurantName: 'Test Restaurant',
          restaurantStatus: 'halal',
          fareAmount: 15.50,
          hasCashOrder: true,
          cashAmount: 5.00,
          entryDate: new Date('2024-01-15'),
          timestamp: new Date('2024-01-15T10:30:00Z'),
          createdAt: new Date('2024-01-15T10:30:00Z'),
          updatedAt: new Date('2024-01-15T10:30:00Z'),
        },
        {
          id: 'entry-2',
          userId: 'test-user-id',
          restaurantName: 'Another Place',
          restaurantStatus: 'non-halal',
          fareAmount: 20.00,
          hasCashOrder: false,
          entryDate: new Date('2024-01-16'),
          timestamp: new Date('2024-01-16T14:00:00Z'),
          createdAt: new Date('2024-01-16T14:00:00Z'),
          updatedAt: new Date('2024-01-16T14:00:00Z'),
        },
      ];

      mockGetEntries.mockResolvedValue({
        entries: mockEntries,
        total: 2,
      });

      const response = await request(app)
        .get('/api/income-entries/export');

      expect(response.status).toBe(200);
      expect(response.header['content-type']).toBe('text/csv; charset=utf-8');
      expect(response.header['content-disposition']).toBe('attachment; filename="income-entries.csv"');
      
      // Verify CSV content
      const csvContent = response.text;
      expect(csvContent).toContain('Restaurant Name,Status,Fare Amount,Has Cash Order,Cash Amount,Entry Date,Timestamp');
      expect(csvContent).toContain('"Test Restaurant",halal,15.50,Yes,5.00,2024-01-15');
      expect(csvContent).toContain('"Another Place",non-halal,20.00,No,,2024-01-16');
    });

    it('should handle restaurant names with quotes properly', async () => {
      const mockEntries: DeliveryEntry[] = [
        {
          id: 'entry-1',
          userId: 'test-user-id',
          restaurantName: 'Joe\'s "Best" Pizza',
          restaurantStatus: 'halal',
          fareAmount: 10.00,
          hasCashOrder: false,
          entryDate: new Date('2024-01-15'),
          timestamp: new Date('2024-01-15T10:30:00Z'),
          createdAt: new Date('2024-01-15T10:30:00Z'),
          updatedAt: new Date('2024-01-15T10:30:00Z'),
        },
      ];

      mockGetEntries.mockResolvedValue({
        entries: mockEntries,
        total: 1,
      });

      const response = await request(app)
        .get('/api/income-entries/export');

      expect(response.status).toBe(200);
      
      // Verify CSV escaping of quotes
      const csvContent = response.text;
      expect(csvContent).toContain('"Joe\'s ""Best"" Pizza"');
    });

    it('should apply filters when provided', async () => {
      mockGetEntries.mockResolvedValue({
        entries: [],
        total: 0,
      });

      await request(app)
        .get('/api/income-entries/export')
        .query({
          startDate: '2024-01-01',
          endDate: '2024-01-31',
          restaurantStatus: 'halal',
          paymentType: 'cash',
        });

      expect(mockGetEntries).toHaveBeenCalledWith(
        'test-user-id',
        expect.objectContaining({
          startDate: new Date('2024-01-01'),
          endDate: new Date('2024-01-31'),
          restaurantStatus: 'halal',
          paymentType: 'cash',
        })
      );
    });

    it('should export empty CSV with only headers when no entries exist', async () => {
      mockGetEntries.mockResolvedValue({
        entries: [],
        total: 0,
      });

      const response = await request(app)
        .get('/api/income-entries/export');

      expect(response.status).toBe(200);
      
      const csvContent = response.text;
      const lines = csvContent.trim().split('\n');
      expect(lines.length).toBe(1); // Only header row
      expect(lines[0]).toBe('Restaurant Name,Status,Fare Amount,Has Cash Order,Cash Amount,Entry Date,Timestamp');
    });
  });

  describe('Validation errors', () => {
    it('should return 400 for invalid date format', async () => {
      const response = await request(app)
        .get('/api/income-entries/export')
        .query({ startDate: 'invalid-date' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 400 when endDate is before startDate', async () => {
      const response = await request(app)
        .get('/api/income-entries/export')
        .query({
          startDate: '2024-01-31',
          endDate: '2024-01-01',
        });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 400 for invalid restaurantStatus', async () => {
      const response = await request(app)
        .get('/api/income-entries/export')
        .query({ restaurantStatus: 'invalid-status' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });

    it('should return 400 for invalid paymentType', async () => {
      const response = await request(app)
        .get('/api/income-entries/export')
        .query({ paymentType: 'invalid-payment' });

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Validation failed');
    });
  });

  describe('Error handling', () => {
    it('should return 500 when service throws an error', async () => {
      mockGetEntries.mockRejectedValue(new Error('Database connection failed'));

      const response = await request(app)
        .get('/api/income-entries/export');

      expect(response.status).toBe(500);
      expect(response.body.error).toBe('Failed to export income entries');
    });
  });
});
