import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express from 'express';

// Create mock functions that will be used by the route
const mockCalculateTotals = vi.fn();

// Mock the IncomeService
vi.mock('../services/IncomeService', () => {
  return {
    IncomeService: vi.fn(() => ({
      calculateTotals: mockCalculateTotals,
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

describe('Analytics Routes', () => {
  let app: express.Application;

  beforeEach(async () => {
    // Clear all mocks
    vi.clearAllMocks();

    // Create Express app with the analytics routes
    app = express();
    app.use(express.json());
    
    // Import analyticsRoutes after mocks are set up
    const analyticsRoutes = (await import('./analytics')).default;
    app.use('/api/analytics', analyticsRoutes);
  });

  describe('GET /api/analytics/totals', () => {
    it('should calculate totals without filters', async () => {
      const mockTotals = {
        totalHalalIncome: 150.0,
        totalNonHalalIncome: 100.0,
        totalCashIncome: 50.0,
        totalDigitalIncome: 200.0,
      };

      mockCalculateTotals.mockResolvedValue(mockTotals);

      const response = await request(app)
        .get('/api/analytics/totals')
        .expect(200);

      expect(response.body).toEqual(mockTotals);
      expect(mockCalculateTotals).toHaveBeenCalledWith(
        'test-user-id',
        {}
      );
    });

    it('should calculate totals with date range filter', async () => {
      const mockTotals = {
        totalHalalIncome: 75.0,
        totalNonHalalIncome: 50.0,
        totalCashIncome: 25.0,
        totalDigitalIncome: 100.0,
      };

      mockCalculateTotals.mockResolvedValue(mockTotals);

      const startDate = '2024-01-01';
      const endDate = '2024-01-31';

      const response = await request(app)
        .get('/api/analytics/totals')
        .query({ startDate, endDate })
        .expect(200);

      expect(response.body).toEqual(mockTotals);
      expect(mockCalculateTotals).toHaveBeenCalledWith(
        'test-user-id',
        {
          startDate: new Date(startDate),
          endDate: new Date(endDate),
        }
      );
    });

    it('should calculate totals with restaurant status filter', async () => {
      const mockTotals = {
        totalHalalIncome: 150.0,
        totalNonHalalIncome: 0,
        totalCashIncome: 30.0,
        totalDigitalIncome: 120.0,
      };

      mockCalculateTotals.mockResolvedValue(mockTotals);

      const response = await request(app)
        .get('/api/analytics/totals')
        .query({ restaurantStatus: 'halal' })
        .expect(200);

      expect(response.body).toEqual(mockTotals);
      expect(mockCalculateTotals).toHaveBeenCalledWith(
        'test-user-id',
        {
          restaurantStatus: 'halal',
        }
      );
    });

    it('should calculate totals with all filters combined', async () => {
      const mockTotals = {
        totalHalalIncome: 50.0,
        totalNonHalalIncome: 0,
        totalCashIncome: 10.0,
        totalDigitalIncome: 40.0,
      };

      mockCalculateTotals.mockResolvedValue(mockTotals);

      const startDate = '2024-01-01';
      const endDate = '2024-01-31';

      const response = await request(app)
        .get('/api/analytics/totals')
        .query({
          startDate,
          endDate,
          restaurantStatus: 'halal',
          paymentType: 'both',
        })
        .expect(200);

      expect(response.body).toEqual(mockTotals);
      expect(mockCalculateTotals).toHaveBeenCalledWith(
        'test-user-id',
        {
          startDate: new Date(startDate),
          endDate: new Date(endDate),
          restaurantStatus: 'halal',
        }
      );
    });

    it('should return 400 for invalid start date format', async () => {
      const response = await request(app)
        .get('/api/analytics/totals')
        .query({ startDate: 'invalid-date' })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Start date must be a valid ISO 8601 date'
      );
    });

    it('should return 400 for invalid end date format', async () => {
      const response = await request(app)
        .get('/api/analytics/totals')
        .query({ endDate: 'invalid-date' })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'End date must be a valid ISO 8601 date'
      );
    });

    it('should return 400 when end date is before start date', async () => {
      const response = await request(app)
        .get('/api/analytics/totals')
        .query({
          startDate: '2024-01-31',
          endDate: '2024-01-01',
        })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'End date must be after or equal to start date'
      );
    });

    it('should return 400 for invalid restaurant status', async () => {
      const response = await request(app)
        .get('/api/analytics/totals')
        .query({ restaurantStatus: 'invalid' })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Restaurant status must be either "halal" or "non-halal"'
      );
    });

    it('should return 400 for invalid payment type', async () => {
      const response = await request(app)
        .get('/api/analytics/totals')
        .query({ paymentType: 'invalid' })
        .expect(400);

      expect(response.body.error).toBe('Validation failed');
      expect(response.body.details).toContain(
        'Payment type must be "cash", "digital", or "both"'
      );
    });

    it('should return 500 when service throws an error', async () => {
      mockCalculateTotals.mockRejectedValue(new Error('Database connection failed'));

      const response = await request(app)
        .get('/api/analytics/totals')
        .expect(500);

      expect(response.body.error).toBe('Failed to calculate income totals');
    });

    it('should accept payment type parameter but not use it in filters', async () => {
      const mockTotals = {
        totalHalalIncome: 150.0,
        totalNonHalalIncome: 100.0,
        totalCashIncome: 50.0,
        totalDigitalIncome: 200.0,
      };

      mockCalculateTotals.mockResolvedValue(mockTotals);

      await request(app)
        .get('/api/analytics/totals')
        .query({ paymentType: 'cash' })
        .expect(200);

      // Verify paymentType is not passed to calculateTotals
      expect(mockCalculateTotals).toHaveBeenCalledWith(
        'test-user-id',
        {} // paymentType should not be in filters
      );
    });
  });
});
