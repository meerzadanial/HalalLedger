import { Router, Request, Response } from 'express';
import { body, validationResult } from 'express-validator';
import { getAuthenticationService } from '../services/AuthenticationService';
import { authenticateToken, AuthenticatedRequest } from '../middleware/auth';

const router = Router();

/**
 * POST /api/auth/login
 * Authenticates user with email and password
 * 
 * Request Body:
 * - email: string (required, valid email format)
 * - password: string (required, min 6 characters)
 * 
 * Response:
 * - 200: { token: string, expiresAt: string }
 * - 400: { error: string, details?: string[] } - Validation errors
 * - 401: { error: string } - Invalid credentials
 * - 500: { error: string } - Server error
 * 
 * Validates: Requirements 1.1 (grant access with valid credentials), 1.2 (deny access with invalid credentials)
 */
router.post(
  '/login',
  [
    body('email')
      .isEmail()
      .withMessage('Valid email is required')
      .normalizeEmail(),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
  ],
  async (req: Request, res: Response): Promise<void> => {
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

      const { email, password } = req.body;

      // Authenticate user
      const authService = getAuthenticationService();
      const { token, expiresAt } = await authService.login(email, password);

      res.status(200).json({
        token,
        expiresAt: expiresAt.toISOString(),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Handle invalid credentials
      if (errorMessage === 'Invalid credentials') {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }

      // Log unexpected errors
      console.error('Login error:', errorMessage);
      res.status(500).json({ error: 'Authentication failed' });
    }
  }
);

/**
 * POST /api/auth/register
 * Creates a new user account with email and password
 * 
 * Request Body:
 * - email: string (required, valid email format)
 * - password: string (required, min 6 characters)
 * 
 * Response:
 * - 201: { id: string, email: string }
 * - 400: { error: string, details?: string[] } - Validation errors
 * - 409: { error: string } - Email already registered
 * - 500: { error: string } - Server error
 * 
 * Validates: Requirements 1.4 (password encryption), 1.1 (account creation)
 */
router.post(
  '/register',
  [
    body('email')
      .isEmail()
      .withMessage('Valid email is required')
      .normalizeEmail(),
    body('password')
      .isLength({ min: 6 })
      .withMessage('Password must be at least 6 characters'),
  ],
  async (req: Request, res: Response): Promise<void> => {
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

      const { email, password } = req.body;

      // Create user
      const authService = getAuthenticationService();
      const user = await authService.createUser(email, password);

      res.status(201).json(user);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Handle duplicate email
      if (errorMessage === 'User already exists') {
        res.status(409).json({ error: 'An account with this email already exists' });
        return;
      }

      // Log unexpected errors
      console.error('Registration error:', errorMessage);
      res.status(500).json({ error: 'Registration failed' });
    }
  }
);

/**
 * POST /api/auth/logout
 * Invalidates the user's current session token
 * 
 * Headers:
 * - Authorization: Bearer <token> (required)
 * 
 * Response:
 * - 200: { success: boolean }
 * - 401: { error: string } - Missing or invalid token
 * - 500: { error: string } - Server error
 * 
 * Validates: Requirements 1.1 (session management)
 */
router.post(
  '/logout',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      const authHeader = req.headers.authorization;
      
      if (!authHeader) {
        res.status(401).json({ error: 'Missing authorization header' });
        return;
      }

      // Extract token
      const token = authHeader.startsWith('Bearer ')
        ? authHeader.substring(7)
        : authHeader;

      // Logout (invalidate token)
      const authService = getAuthenticationService();
      await authService.logout(token);

      res.status(200).json({ success: true });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Logout error:', errorMessage);
      res.status(500).json({ error: 'Logout failed' });
    }
  }
);

/**
 * GET /api/auth/session
 * Retrieves current session information for authenticated user
 * 
 * Headers:
 * - Authorization: Bearer <token> (required)
 * 
 * Response:
 * - 200: { userId: string, email: string, expiresAt: string }
 * - 401: { error: string } - Missing, invalid, or expired token
 * - 500: { error: string } - Server error
 * 
 * Validates: Requirements 1.3 (session timeout after 30 minutes)
 */
router.get(
  '/session',
  authenticateToken,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    try {
      if (!req.user) {
        res.status(401).json({ error: 'User not authenticated' });
        return;
      }

      const authHeader = req.headers.authorization;
      
      if (!authHeader) {
        res.status(401).json({ error: 'Missing authorization header' });
        return;
      }

      // Extract token to get expiration from database
      const token = authHeader.startsWith('Bearer ')
        ? authHeader.substring(7)
        : authHeader;

      // Get token hash to look up session
      const authService = getAuthenticationService();
      const tokenHash = (authService as any).hashToken(token);

      // Get session from database
      const prisma = (authService as any).prisma;
      const session = await prisma.sessionToken.findUnique({
        where: { tokenHash },
        select: { expiresAt: true },
      });

      if (!session) {
        res.status(401).json({ error: 'Session not found' });
        return;
      }

      res.status(200).json({
        userId: req.user.userId,
        email: req.user.email,
        expiresAt: session.expiresAt.toISOString(),
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Session retrieval error:', errorMessage);
      res.status(500).json({ error: 'Failed to retrieve session' });
    }
  }
);

export default router;
