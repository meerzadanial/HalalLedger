import { Router, Response } from 'express';
import { query, validationResult } from 'express-validator';
import { IncomeService } from '../services/IncomeService';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();
const incomeService = new IncomeService();

/**
 * GET /api/analytics/totals
 * Calculate income totals with optional filtering
 * 
 * Headers:
 * - Authorization: Bearer <token> (required)
 * 
 * Query Parameters:
 * - startDate: ISO date string (optional) - filter entries from this date
 * - endDate: ISO date string (optional) - filter entries until this date
 * - restaurantStatus: "halal" | "non-halal" (optional) - filter by restaurant status
 * - paymentType: "cash" | "digital" | "both" (optional) - filter by payment type (currently informational)
 * 
 * Response:
 * - 200: { 
 *     totalHalalIncome: number, 
 *     totalNonHalalIncome: number,
 *     totalCashIncome: number,
 *     totalDigitalIncome: number
 *   } - Income totals breakdown
 * - 400: { error: string, details?: string[] } - Validation errors
 * - 401: { error: string } - Missing or invalid authentication
 * - 500: { error: string } - Server error
 * 
 * Validates: Requirements 8.5, 8.6, 8.7
 */
router.get(
  '/totals',
  authenticateToken,
  [
    query('startDate')
      .optional()
      .isISO8601()
      .withMessage('Start date must be a valid ISO 8601 date'),
    query('endDate')
      .optional()
      .isISO8601()
      .withMessage('End date must be a valid ISO 8601 date')
      .custom((value, { req }) => {
        if (value && req.query.startDate) {
          const startDate = new Date(req.query.startDate as string);
          const endDate = new Date(value);
          if (endDate < startDate) {
            throw new Error('End date must be after or equal to start date');
          }
        }
        return true;
      }),
    query('restaurantStatus')
      .optional()
      .isString()
      .isIn(['halal', 'non-halal'])
      .withMessage('Restaurant status must be either "halal" or "non-halal"'),
    query('paymentType')
      .optional()
      .isString()
      .isIn(['cash', 'digital', 'both'])
      .withMessage('Payment type must be "cash", "digital", or "both"'),
  ],
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      // Check for validation errors
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json({
          error: 'Validation failed',
          details: errors.array().map((err) => err.msg),
        });
        return;
      }

      // Ensure user is authenticated
      if (!req.user) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      // Extract query parameters
      const { startDate, endDate, restaurantStatus, paymentType } = req.query;

      // Build filters object
      const filters: any = {};

      if (startDate) {
        filters.startDate = new Date(startDate as string);
      }

      if (endDate) {
        filters.endDate = new Date(endDate as string);
      }

      if (restaurantStatus) {
        filters.restaurantStatus = restaurantStatus as 'halal' | 'non-halal';
      }

      // Note: paymentType parameter is accepted for API consistency but not used
      // in calculateTotals as it returns both cash and digital totals regardless

      // Calculate totals from service
      const totals = await incomeService.calculateTotals(
        req.user.userId,
        filters
      );

      // Return totals breakdown
      res.status(200).json(totals);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Analytics totals calculation error:', errorMessage);

      res.status(500).json({ error: 'Failed to calculate income totals' });
    }
  }
);

export default router;
