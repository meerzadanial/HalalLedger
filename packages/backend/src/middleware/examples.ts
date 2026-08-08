/**
 * Authentication Middleware Usage Examples
 * 
 * This file demonstrates how to use the authentication middleware
 * for protecting API endpoints with token validation, session timeout,
 * and user data isolation.
 * 
 * Task 3.2: Authentication Middleware Implementation
 * - Token validation middleware
 * - Session timeout detection (30 minutes)
 * - User data isolation checks
 * 
 * Validates: Requirements 1.3, 1.5
 */

import express, { Router, Request, Response } from 'express';
import {
  authenticateToken,
  requireUserDataIsolation,
  optionalAuthentication,
  AuthenticatedRequest,
} from './auth';

// Example 1: Basic Protected Route
// ================================
// Protect a route that requires authentication but doesn't need
// user-specific data isolation (e.g., getting current user's profile)

const basicProtectedRouter = Router();

basicProtectedRouter.get('/profile', authenticateToken, (req: AuthenticatedRequest, res: Response) => {
  // req.user is guaranteed to exist after authenticateToken middleware
  const { userId, email } = req.user!;
  
  res.json({
    message: 'Profile data',
    user: { userId, email },
  });
});

// Example 2: Protected Route with User Data Isolation (URL Parameters)
// ====================================================================
// Ensure users can only access their own income entries

const incomeEntriesRouter = Router();

// GET /api/users/:userId/income-entries
// Users can only fetch their own entries
incomeEntriesRouter.get(
  '/users/:userId/income-entries',
  authenticateToken,
  requireUserDataIsolation('userId', 'params'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { userId } = req.user!;
    
    // The middleware guarantees that req.params.userId === req.user.userId
    // Safe to query database for this user's data
    
    res.json({
      message: `Income entries for user ${userId}`,
      entries: [], // Would fetch from database
    });
  }
);

// Example 3: Protected Route with User Data Isolation (Request Body)
// ==================================================================
// Ensure users can only create entries for themselves

incomeEntriesRouter.post(
  '/income-entries',
  authenticateToken,
  requireUserDataIsolation('userId', 'body'),
  async (req: AuthenticatedRequest, res: Response) => {
    const { userId } = req.user!;
    const { amount, categoryId, date, notes } = req.body;
    
    // If userId is in body, middleware ensures it matches authenticated user
    // Otherwise, we use req.user.userId
    
    const entryUserId = req.body.userId || userId;
    
    res.json({
      message: 'Income entry created',
      entry: { userId: entryUserId, amount, categoryId, date, notes },
    });
  }
);

// Example 4: Optional Authentication
// ===================================
// Route that behaves differently for authenticated vs anonymous users

const dashboardRouter = Router();

dashboardRouter.get(
  '/dashboard',
  optionalAuthentication,
  (req: AuthenticatedRequest, res: Response) => {
    if (req.user) {
      // User is authenticated - show personalized dashboard
      res.json({
        message: 'Personalized dashboard',
        userId: req.user.userId,
        email: req.user.email,
      });
    } else {
      // User is not authenticated - show public dashboard
      res.json({
        message: 'Public dashboard',
        hint: 'Login to see your personalized data',
      });
    }
  }
);

// Example 5: Combining Multiple Middleware Functions
// ==================================================
// Chain multiple middleware for complex authorization logic

const adminRouter = Router();

// Custom middleware to check if user is admin (example)
const requireAdmin = (req: AuthenticatedRequest, res: Response, next: Function) => {
  // This is just an example - actual implementation would check user role in database
  const isAdmin = req.user?.email?.includes('admin');
  
  if (!isAdmin) {
    res.status(403).json({ error: 'Admin access required' });
    return;
  }
  
  next();
};

adminRouter.get(
  '/admin/users',
  authenticateToken,  // First, verify user is authenticated
  requireAdmin,       // Then, verify user is an admin
  (_req: AuthenticatedRequest, res: Response) => {
    res.json({
      message: 'Admin user list',
      users: [], // Would fetch all users from database
    });
  }
);

// Example 6: Protecting All Routes in a Router
// ============================================
// Apply authentication middleware to all routes in a router

const protectedApiRouter = Router();

// Apply authentication to all routes in this router
protectedApiRouter.use(authenticateToken);

// All these routes are now automatically protected
protectedApiRouter.get('/categories', (req: AuthenticatedRequest, res: Response) => {
  const { userId } = req.user!;
  res.json({ message: 'User categories', userId });
});

protectedApiRouter.get('/analytics', (req: AuthenticatedRequest, res: Response) => {
  const { userId } = req.user!;
  res.json({ message: 'User analytics', userId });
});

// Example 7: Error Handling for Token Expiration
// ==============================================
/**
 * Client should handle 401 responses for expired tokens
 * 
 * Frontend example (React/TypeScript):
 * 
 * const fetchProtectedData = async () => {
 *   const token = localStorage.getItem('authToken');
 *   const response = await fetch('/api/income-entries', {
 *     headers: { 'Authorization': `Bearer ${token}` }
 *   });
 *   
 *   if (response.status === 401) {
 *     const error = await response.json();
 *     if (error.error === 'Session expired') {
 *       localStorage.removeItem('authToken');
 *       window.location.href = '/login';
 *     }
 *   }
 *   return response.json();
 * };
 */

// Example 8: Complete API Setup
// =============================
// Putting it all together in an Express application

export function setupAuthenticatedAPI(): express.Application {
  const app = express();
  
  // Middleware
  app.use(express.json());
  
  // Public routes (no authentication required)
  app.post('/api/auth/login', (_req: Request, res: Response) => {
    res.json({ message: 'Login endpoint - not protected' });
  });
  
  app.post('/api/auth/register', (_req: Request, res: Response) => {
    res.json({ message: 'Registration endpoint - not protected' });
  });
  
  // Protected routes
  app.use('/api/profile', basicProtectedRouter);
  app.use('/api', incomeEntriesRouter);
  app.use('/api', dashboardRouter);
  app.use('/api', adminRouter);
  app.use('/api/protected', protectedApiRouter);
  
  // Error handler for authentication errors
  app.use((err: any, _req: Request, res: Response, _next: Function) => {
    if (err.name === 'UnauthorizedError') {
      res.status(401).json({
        error: 'Unauthorized',
        details: err.message,
      });
      return;
    }
    _next(err);
  });
  
  return app;
}

// Example 9: Testing Protected Routes
// ===================================
/**
 * How to test routes that use authentication middleware
 * 
 * See auth.test.ts for complete test examples
 */

// Example 10: Session Timeout Behavior
// ====================================
/**
 * Session Timeout Details:
 * 
 * - Sessions expire after 30 minutes of creation (not inactivity)
 * - The JWT token contains an 'exp' claim set to 30 minutes from creation
 * - The database session_tokens table also stores the expiration timestamp
 * - When a request comes in, the middleware checks:
 *   1. JWT signature is valid
 *   2. JWT is not expired
 *   3. Session token exists in database
 *   4. Database session token is not expired
 * 
 * - If any check fails, the middleware returns 401 with appropriate error
 * - Clients should:
 *   1. Store the expiresAt timestamp from login response
 *   2. Implement a token refresh mechanism before expiration
 *   3. Redirect to login when receiving 'Session expired' error
 * 
 * Token Refresh Pattern:
 */

const tokenRefreshRouter = Router();

tokenRefreshRouter.post('/auth/refresh', authenticateToken, async (req: AuthenticatedRequest, res: Response) => {
  // Extract current token from header
  const token = req.headers.authorization?.substring(7);
  
  if (!token) {
    res.status(400).json({ error: 'Token required' });
    return;
  }
  
  // Get authentication service (example)
  // const authService = getAuthenticationService();
  // const { token: newToken, expiresAt } = await authService.refreshToken(token);
  
  res.json({
    token: 'new-token-here',
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
  });
});

/**
 * Implementation Notes:
 * 
 * 1. Token Validation:
 *    - Validates JWT signature using JWT_SECRET from environment
 *    - Checks token expiration timestamp
 *    - Verifies session exists in database and is not expired
 * 
 * 2. Session Timeout (30 minutes):
 *    - Configured in AuthenticationService constructor
 *    - Can be overridden via environment variable if needed
 *    - Session tokens are cleaned up on logout or login
 * 
 * 3. User Data Isolation:
 *    - requireUserDataIsolation middleware prevents users from accessing
 *      other users' data by comparing authenticated userId with requested userId
 *    - Can check userId in params, query, or body
 *    - Returns 403 if userId mismatch is detected
 * 
 * 4. Security Considerations:
 *    - Always use HTTPS in production to prevent token interception
 *    - Store tokens securely on client (httpOnly cookies or secure storage)
 *    - Implement CSRF protection for cookie-based authentication
 *    - Use short-lived tokens (30 minutes) to limit exposure window
 *    - Implement token refresh to improve UX without compromising security
 * 
 * 5. Best Practices:
 *    - Apply authenticateToken before any route-specific middleware
 *    - Use requireUserDataIsolation for any route that accesses user-specific data
 *    - Log authentication failures for security monitoring
 *    - Rate limit authentication endpoints to prevent brute force attacks
 *    - Implement account lockout after multiple failed attempts
 */

export {
  basicProtectedRouter,
  incomeEntriesRouter,
  dashboardRouter,
  adminRouter,
  protectedApiRouter,
  tokenRefreshRouter,
};
