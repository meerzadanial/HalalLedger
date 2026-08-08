import { Request, Response, NextFunction } from 'express';
import { getAuthenticationService } from '../services/AuthenticationService';

/**
 * Extended Express Request interface with authenticated user information
 */
export interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    email: string;
  };
}

/**
 * Authentication Middleware for API Endpoints
 * 
 * Implements:
 * - Token validation from Authorization header
 * - Session timeout detection (30 minutes)
 * - User data isolation checks
 * 
 * Validates: Requirements 1.3, 1.5
 * 
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 * 
 * @returns 401 if token is missing, invalid, or expired
 * @returns 403 if user tries to access another user's data
 */
export async function authenticateToken(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : null;

    if (!token) {
      res.status(401).json({
        error: 'Authentication required',
        details: 'No token provided',
      });
      return;
    }

    // Validate token using AuthenticationService
    const authService = getAuthenticationService();
    
    try {
      // This validates the token signature, checks expiration (30-minute timeout),
      // and verifies the session exists in the database
      const userInfo = await authService.validateToken(token);

      // Attach user information to request for downstream handlers
      req.user = {
        userId: userInfo.userId,
        email: userInfo.email,
      };

      // Continue to next middleware/route handler
      next();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      // Handle different authentication errors
      if (errorMessage.includes('expired') || errorMessage.includes('Session expired')) {
        res.status(401).json({
          error: 'Session expired',
          details: 'Your session has expired after 30 minutes of inactivity. Please log in again.',
        });
        return;
      }

      if (errorMessage.includes('Invalid token') || errorMessage.includes('Session not found')) {
        res.status(401).json({
          error: 'Invalid token',
          details: 'The provided authentication token is invalid.',
        });
        return;
      }

      // Generic authentication failure
      res.status(401).json({
        error: 'Authentication failed',
        details: errorMessage,
      });
      return;
    }
  } catch (error) {
    // Unexpected error
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Authentication middleware error:', errorMessage);
    
    res.status(500).json({
      error: 'Internal server error',
      details: 'An unexpected error occurred during authentication',
    });
    return;
  }
}

/**
 * User Data Isolation Middleware
 * 
 * Ensures that users can only access their own data by validating
 * that resource identifiers (like userId in params or query) match
 * the authenticated user's ID.
 * 
 * This middleware should be used AFTER authenticateToken middleware.
 * 
 * Validates: Requirement 1.5 (user data isolation)
 * 
 * @param paramName - Name of the parameter to check (e.g., 'userId')
 * @param location - Where to look for the parameter: 'params', 'query', or 'body'
 * @returns Express middleware function
 * 
 * @example
 * // Protect route parameter
 * router.get('/users/:userId/entries', 
 *   authenticateToken,
 *   requireUserDataIsolation('userId', 'params'),
 *   getEntriesHandler
 * );
 * 
 * @example
 * // Protect request body
 * router.post('/entries',
 *   authenticateToken,
 *   requireUserDataIsolation('userId', 'body'),
 *   createEntryHandler
 * );
 */
export function requireUserDataIsolation(
  paramName: string = 'userId',
  location: 'params' | 'query' | 'body' = 'params'
) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    try {
      // Ensure user is authenticated
      if (!req.user || !req.user.userId) {
        res.status(401).json({
          error: 'Authentication required',
          details: 'User must be authenticated to access this resource',
        });
        return;
      }

      // Extract the userId from the specified location
      let requestedUserId: string | undefined;

      switch (location) {
        case 'params':
          requestedUserId = req.params[paramName];
          break;
        case 'query':
          requestedUserId = req.query[paramName] as string;
          break;
        case 'body':
          requestedUserId = req.body?.[paramName];
          break;
      }

      // If no userId is being requested, allow the request
      // (The route handler will use req.user.userId by default)
      if (!requestedUserId) {
        next();
        return;
      }

      // Verify that the requested userId matches the authenticated user's ID
      if (requestedUserId !== req.user.userId) {
        res.status(403).json({
          error: 'Access denied',
          details: 'You can only access your own data',
        });
        return;
      }

      // User is accessing their own data, allow request
      next();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Data isolation middleware error:', errorMessage);
      
      res.status(500).json({
        error: 'Internal server error',
        details: 'An unexpected error occurred during authorization',
      });
      return;
    }
  };
}

/**
 * Optional Authentication Middleware
 * 
 * Similar to authenticateToken, but doesn't return an error if no token is provided.
 * Instead, it attaches user info if a valid token exists, or continues without it.
 * 
 * Useful for endpoints that have different behavior for authenticated vs unauthenticated users.
 * 
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export async function optionalAuthentication(
  req: AuthenticatedRequest,
  _res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Extract token from Authorization header
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.startsWith('Bearer ')
      ? authHeader.substring(7)
      : null;

    // If no token, continue without authentication
    if (!token) {
      next();
      return;
    }

    // Attempt to validate token
    const authService = getAuthenticationService();
    
    try {
      const userInfo = await authService.validateToken(token);
      req.user = {
        userId: userInfo.userId,
        email: userInfo.email,
      };
    } catch (error) {
      // Token is invalid or expired, but we don't block the request
      // Just continue without attaching user info
      console.warn('Optional authentication failed:', error instanceof Error ? error.message : 'Unknown error');
    }

    next();
  } catch (error) {
    // Unexpected error - log but don't block request
    console.error('Optional authentication middleware error:', error);
    next();
  }
}
