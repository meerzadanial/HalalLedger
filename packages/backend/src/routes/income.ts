import { Router, Response } from 'express';
import { body, query, validationResult } from 'express-validator';
import { IncomeService } from '../services/IncomeService';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';
import { DeliveryEntryFormData } from '../types';

const router = Router();
const incomeService = new IncomeService();

/**
 * POST /api/income-entries
 * Creates a new delivery entry
 * 
 * Headers:
 * - Authorization: Bearer <token> (required)
 * 
 * Request Body:
 * - restaurantName: string (required, 1-100 characters)
 * - restaurantStatus: "halal" | "non-halal" (required)
 * - fareAmount: number (required, > 0, max 2 decimals)
 * - hasCashOrder: boolean (required)
 * - cashAmount: number (optional, > 0 if provided, max 2 decimals)
 * - entryDate: ISO date string (optional, defaults to current date)
 * 
 * Response:
 * - 201: { entry: DeliveryEntry } - Entry created successfully
 * - 400: { error: string, details?: string[] } - Validation errors
 * - 401: { error: string } - Missing or invalid authentication
 * - 500: { error: string } - Server error
 * 
 * Validates: Requirements 2.7, 7.1
 */
router.post(
  '/',
  authenticateToken,
  [
    body('restaurantName')
      .isString()
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage('Restaurant name must be between 1 and 100 characters'),
    body('restaurantStatus')
      .isString()
      .isIn(['halal', 'non-halal'])
      .withMessage('Restaurant status must be either "halal" or "non-halal"'),
    body('fareAmount')
      .isFloat({ min: 0.01 })
      .withMessage('Fare amount must be greater than 0')
      .custom((value) => {
        // Check if value has at most 2 decimal places
        const decimalPlaces = (value.toString().split('.')[1] || '').length;
        if (decimalPlaces > 2) {
          throw new Error('Fare amount must have at most 2 decimal places');
        }
        return true;
      }),
    body('hasCashOrder')
      .isBoolean()
      .withMessage('hasCashOrder must be a boolean'),
    body('cashAmount')
      .optional({ nullable: true })
      .isFloat({ min: 0.01 })
      .withMessage('Cash amount must be greater than 0 if provided')
      .custom((value) => {
        if (value !== null && value !== undefined) {
          const decimalPlaces = (value.toString().split('.')[1] || '').length;
          if (decimalPlaces > 2) {
            throw new Error('Cash amount must have at most 2 decimal places');
          }
        }
        return true;
      }),
    body('entryDate')
      .optional()
      .isISO8601()
      .withMessage('Entry date must be a valid ISO 8601 date')
      .custom((value) => {
        if (value) {
          const entryDate = new Date(value);
          const today = new Date();
          today.setHours(23, 59, 59, 999); // End of today
          if (entryDate > today) {
            throw new Error('Entry date cannot be in the future');
          }
        }
        return true;
      }),
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

      // Extract and validate request body
      const {
        restaurantName,
        restaurantStatus,
        fareAmount,
        hasCashOrder,
        cashAmount,
        entryDate,
      } = req.body;

      // Additional validation: if hasCashOrder is true, cashAmount must be provided
      if (hasCashOrder && (cashAmount === null || cashAmount === undefined)) {
        res.status(400).json({
          error: 'Validation failed',
          details: ['Cash amount is required when hasCashOrder is true'],
        });
        return;
      }

      // Prepare delivery entry data
      const deliveryData: DeliveryEntryFormData = {
        restaurantName,
        restaurantStatus,
        fareAmount,
        hasCashOrder,
        cashAmount: hasCashOrder ? cashAmount : undefined,
        entryDate: entryDate ? new Date(entryDate) : undefined,
      };

      // Create the entry with a 2-second timeout requirement
      const startTime = Date.now();
      const entry = await incomeService.createEntry(req.user.userId, deliveryData);
      const duration = Date.now() - startTime;

      // Log performance metric (Requirements 7.1 - database write within 2 seconds)
      if (duration > 2000) {
        console.warn(
          `Database write exceeded 2 seconds: ${duration}ms for entry ${entry.id}`
        );
      }

      // Return created entry with 201 status
      res.status(201).json({ entry });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Income entry creation error:', errorMessage);

      // Handle specific error cases
      if (errorMessage.includes('duplicate') || errorMessage.includes('Duplicate')) {
        res.status(409).json({ error: 'Duplicate entry detected' });
        return;
      }

      res.status(500).json({ error: 'Failed to create income entry' });
    }
  }
);

/**
 * DELETE /api/income-entries/:id
 * Deletes an existing delivery entry
 * 
 * Headers:
 * - Authorization: Bearer <token> (required)
 * 
 * URL Parameters:
 * - id: string (required, UUID format)
 * 
 * Response:
 * - 200: { success: true, message: string } - Entry deleted successfully
 * - 400: { error: string } - Invalid entry ID format
 * - 401: { error: string } - Missing or invalid authentication
 * - 404: { error: string } - Entry not found or does not belong to user
 * - 500: { error: string } - Server error
 * 
 * Validates: Requirements 14.3, 14.4
 */
router.delete(
  '/:id',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      // Ensure user is authenticated
      if (!req.user) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const { id } = req.params;

      // Validate UUID format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!id || !uuidRegex.test(id)) {
        res.status(400).json({ error: 'Invalid entry ID format' });
        return;
      }

      // Delete the entry (validates ownership inside service)
      await incomeService.deleteEntry(req.user.userId, id);

      // Return success response
      res.status(200).json({ 
        success: true, 
        message: 'Entry deleted successfully' 
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Income entry deletion error:', errorMessage);

      // Handle specific error cases
      if (errorMessage.includes('not found') || errorMessage.includes('does not belong')) {
        res.status(404).json({ error: 'Entry not found or does not belong to user' });
        return;
      }

      res.status(500).json({ error: 'Failed to delete income entry' });
    }
  }
);

/**
 * PUT /api/income-entries/:id
 * Updates an existing delivery entry
 * 
 * Headers:
 * - Authorization: Bearer <token> (required)
 * 
 * URL Parameters:
 * - id: UUID of the entry to update
 * 
 * Request Body (all fields optional):
 * - restaurantName: string (1-100 characters)
 * - restaurantStatus: "halal" | "non-halal"
 * - fareAmount: number (> 0, max 2 decimals)
 * - hasCashOrder: boolean
 * - cashAmount: number (> 0 if provided, max 2 decimals)
 * - entryDate: ISO date string (not in the future)
 * 
 * Response:
 * - 200: { entry: DeliveryEntry } - Entry updated successfully
 * - 400: { error: string, details?: string[] } - Validation errors
 * - 401: { error: string } - Missing or invalid authentication
 * - 404: { error: string } - Entry not found or doesn't belong to user
 * - 500: { error: string } - Server error
 * 
 * Validates: Requirements 14.1, 14.2
 */
router.put(
  '/:id',
  authenticateToken,
  [
    body('restaurantName')
      .optional()
      .isString()
      .trim()
      .isLength({ min: 1, max: 100 })
      .withMessage('Restaurant name must be between 1 and 100 characters'),
    body('restaurantStatus')
      .optional()
      .isString()
      .isIn(['halal', 'non-halal'])
      .withMessage('Restaurant status must be either "halal" or "non-halal"'),
    body('fareAmount')
      .optional()
      .isFloat({ min: 0.01 })
      .withMessage('Fare amount must be greater than 0')
      .custom((value) => {
        if (value !== undefined) {
          const decimalPlaces = (value.toString().split('.')[1] || '').length;
          if (decimalPlaces > 2) {
            throw new Error('Fare amount must have at most 2 decimal places');
          }
        }
        return true;
      }),
    body('hasCashOrder')
      .optional()
      .isBoolean({ strict: true })
      .withMessage('hasCashOrder must be a boolean'),
    body('cashAmount')
      .optional({ nullable: true })
      .isFloat({ min: 0.01 })
      .withMessage('Cash amount must be greater than 0 if provided')
      .custom((value) => {
        if (value !== null && value !== undefined) {
          const decimalPlaces = (value.toString().split('.')[1] || '').length;
          if (decimalPlaces > 2) {
            throw new Error('Cash amount must have at most 2 decimal places');
          }
        }
        return true;
      }),
    body('entryDate')
      .optional()
      .isISO8601()
      .withMessage('Entry date must be a valid ISO 8601 date')
      .custom((value) => {
        if (value) {
          const entryDate = new Date(value);
          const today = new Date();
          today.setHours(23, 59, 59, 999);
          if (entryDate > today) {
            throw new Error('Entry date cannot be in the future');
          }
        }
        return true;
      }),
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

      const entryId = req.params.id;
      const {
        restaurantName,
        restaurantStatus,
        fareAmount,
        hasCashOrder,
        cashAmount,
        entryDate,
      } = req.body;

      // Additional validation: if hasCashOrder is being set to true, cashAmount must be provided
      if (hasCashOrder === true && (cashAmount === null || cashAmount === undefined)) {
        res.status(400).json({
          error: 'Validation failed',
          details: ['Cash amount is required when hasCashOrder is true'],
        });
        return;
      }

      // Prepare partial delivery entry data
      const deliveryData: Partial<DeliveryEntryFormData> = {};
      
      if (restaurantName !== undefined) deliveryData.restaurantName = restaurantName;
      if (restaurantStatus !== undefined) deliveryData.restaurantStatus = restaurantStatus;
      if (fareAmount !== undefined) deliveryData.fareAmount = fareAmount;
      if (hasCashOrder !== undefined) deliveryData.hasCashOrder = hasCashOrder;
      if (cashAmount !== undefined) deliveryData.cashAmount = cashAmount;
      if (entryDate !== undefined) deliveryData.entryDate = new Date(entryDate);

      // Update the entry with a 2-second timeout requirement
      const startTime = Date.now();
      const entry = await incomeService.updateEntry(req.user.userId, entryId, deliveryData);
      const duration = Date.now() - startTime;

      // Log performance metric (Requirements 7.2 - database update within 2 seconds)
      if (duration > 2000) {
        console.warn(
          `Database update exceeded 2 seconds: ${duration}ms for entry ${entry.id}`
        );
      }

      // Return updated entry with 200 status
      res.status(200).json({ entry });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Income entry update error:', errorMessage);

      // Handle specific error cases
      if (errorMessage.includes('not found') || errorMessage.includes('does not belong')) {
        res.status(404).json({ error: 'Entry not found or does not belong to user' });
        return;
      }

      res.status(500).json({ error: 'Failed to update income entry' });
    }
  }
);

/**
 * GET /api/income-entries
 * Retrieves delivery entries with optional filtering
 * 
 * Headers:
 * - Authorization: Bearer <token> (required)
 * 
 * Query Parameters:
 * - startDate: ISO date string (optional) - filter entries from this date
 * - endDate: ISO date string (optional) - filter entries until this date
 * - restaurantStatus: "halal" | "non-halal" (optional) - filter by restaurant status
 * - paymentType: "cash" | "digital" | "both" (optional) - filter by payment type
 * - limit: number (optional, default: 50, max: 100) - number of entries to return
 * - offset: number (optional, default: 0) - number of entries to skip for pagination
 * 
 * Response:
 * - 200: { entries: DeliveryEntry[], total: number } - List of entries with total count
 * - 400: { error: string, details?: string[] } - Validation errors
 * - 401: { error: string } - Missing or invalid authentication
 * - 500: { error: string } - Server error
 * 
 * Validates: Requirements 8.1, 8.2, 8.3, 8.4
 */
router.get(
  '/',
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
        if (value && req.query?.startDate) {
          const startDate = new Date(req.query?.startDate as string);
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
    query('limit')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Limit must be an integer between 1 and 100')
      .toInt(),
    query('offset')
      .optional()
      .isInt({ min: 0 })
      .withMessage('Offset must be a non-negative integer')
      .toInt(),
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
      const {
        startDate,
        endDate,
        restaurantStatus,
        paymentType,
        limit = 50,
        offset = 0,
      } = req.query;

      // Build filters object
      const filters: any = {
        limit: Number(limit),
        offset: Number(offset),
      };

      if (startDate) {
        filters.startDate = new Date(startDate as string);
      }

      if (endDate) {
        filters.endDate = new Date(endDate as string);
      }

      if (restaurantStatus) {
        filters.restaurantStatus = restaurantStatus as 'halal' | 'non-halal';
      }

      if (paymentType) {
        filters.paymentType = paymentType as 'cash' | 'digital' | 'both';
      }

      // Get entries from service
      const result = await incomeService.getEntries(req.user.userId, filters);

      // Return entries with total count
      res.status(200).json(result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Income entries retrieval error:', errorMessage);

      res.status(500).json({ error: 'Failed to retrieve income entries' });
    }
  }
);

/**
 * GET /api/income-entries/export
 * Exports delivery entries to CSV format
 * 
 * Headers:
 * - Authorization: Bearer <token> (required)
 * 
 * Query Parameters:
 * - startDate: ISO date string (optional) - filter entries from this date
 * - endDate: ISO date string (optional) - filter entries until this date
 * - restaurantStatus: "halal" | "non-halal" (optional) - filter by restaurant status
 * - paymentType: "cash" | "digital" | "both" (optional) - filter by payment type
 * 
 * Response:
 * - 200: CSV file download with all delivery entry fields
 * - 400: { error: string, details?: string[] } - Validation errors
 * - 401: { error: string } - Missing or invalid authentication
 * - 500: { error: string } - Server error
 * 
 * Validates: Requirements 8.8
 */
router.get(
  '/export',
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
        if (value && req.query?.startDate) {
          const startDate = new Date(req.query?.startDate as string);
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
      const {
        startDate,
        endDate,
        restaurantStatus,
        paymentType,
      } = req.query;

      // Build filters object (no pagination for export)
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

      if (paymentType) {
        filters.paymentType = paymentType as 'cash' | 'digital' | 'both';
      }

      // Get all entries matching filters (no limit for export)
      const result = await incomeService.getEntries(req.user.userId, filters);

      // Convert entries to CSV format
      const csvHeader = 'Restaurant Name,Status,Fare Amount,Has Cash Order,Cash Amount,Entry Date,Timestamp\n';
      
      const csvRows = result.entries.map((entry) => {
        const restaurantName = `"${entry.restaurantName.replace(/"/g, '""')}"`;
        const status = entry.restaurantStatus;
        const fareAmount = entry.fareAmount.toFixed(2);
        const hasCashOrder = entry.hasCashOrder ? 'Yes' : 'No';
        const cashAmount = entry.cashAmount ? entry.cashAmount.toFixed(2) : '';
        const entryDate = entry.entryDate.toISOString().split('T')[0];
        const timestamp = entry.timestamp.toISOString();

        return `${restaurantName},${status},${fareAmount},${hasCashOrder},${cashAmount},${entryDate},${timestamp}`;
      }).join('\n');

      const csvContent = csvHeader + csvRows;

      // Set headers for file download
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="income-entries.csv"');
      
      // Send CSV content
      res.status(200).send(csvContent);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Income entries export error:', errorMessage);

      res.status(500).json({ error: 'Failed to export income entries' });
    }
  }
);

/**
 * GET /api/income-entries/:id
 * Retrieves a single delivery entry by ID
 * 
 * Headers:
 * - Authorization: Bearer <token> (required)
 * 
 * URL Parameters:
 * - id: UUID of the entry to retrieve
 * 
 * Response:
 * - 200: DeliveryEntry - Entry retrieved successfully
 * - 400: { error: string } - Invalid entry ID format
 * - 401: { error: string } - Missing or invalid authentication
 * - 404: { error: string } - Entry not found or doesn't belong to user
 * - 500: { error: string } - Server error
 * 
 * Validates: Requirements 14.1
 */
router.get(
  '/:id',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      // Ensure user is authenticated
      if (!req.user) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const { id } = req.params;

      // Validate UUID format
      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (!id || !uuidRegex.test(id)) {
        res.status(400).json({ error: 'Invalid entry ID format' });
        return;
      }

      // Get the entry (validates ownership inside service)
      const entry = await incomeService.getEntryById(req.user.userId, id);

      if (!entry) {
        res.status(404).json({ error: 'Entry not found or does not belong to user' });
        return;
      }

      // Return the entry
      res.status(200).json(entry);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Income entry retrieval error:', errorMessage);

      // Handle specific error cases
      if (errorMessage.includes('not found') || errorMessage.includes('does not belong')) {
        res.status(404).json({ error: 'Entry not found or does not belong to user' });
        return;
      }

      res.status(500).json({ error: 'Failed to retrieve income entry' });
    }
  }
);

export default router;
