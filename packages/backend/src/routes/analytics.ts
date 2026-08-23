import { Router, Response } from 'express';
import { query, validationResult } from 'express-validator';
import { IncomeService, type TotalsQuery } from '../services/IncomeService';
import {
  normalizeExplicitDateRange,
  parseDateOnly,
  type PaymentType,
  type RestaurantStatus,
} from '../services/incomeQuery';
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
 * - startDate: canonical YYYY-MM-DD string (optional) - filter entries from this date
 * - endDate: canonical YYYY-MM-DD string (optional) - filter entries until this date
 * - restaurantStatus: "halal" | "non-halal" (optional) - filter by restaurant status
 * - paymentType: "cash" | "digital" | "both" (optional) - filter the matching set by payment type
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
      .custom((value) => parseDateOnly(value))
      .withMessage('Start date must be a canonical date in YYYY-MM-DD format'),
    query('endDate')
      .optional()
      .custom((value) => parseDateOnly(value))
      .withMessage('End date must be a canonical date in YYYY-MM-DD format'),
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

      let dateRange: ReturnType<typeof normalizeExplicitDateRange>;
      try {
        dateRange = normalizeExplicitDateRange(
          req.query.startDate,
          req.query.endDate,
        );
      } catch (error) {
        res.status(400).json({
          error: 'Validation failed',
          details: [
            error instanceof Error
              ? error.message
              : 'Invalid date range',
          ],
        });
        return;
      }

      const filters: TotalsQuery = {
        ...(dateRange && { dateRange }),
        ...(req.query.restaurantStatus && {
          restaurantStatus: req.query.restaurantStatus as RestaurantStatus,
        }),
        ...(req.query.paymentType && {
          paymentType: req.query.paymentType as PaymentType,
        }),
      };

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
