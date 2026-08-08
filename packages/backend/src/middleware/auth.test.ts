import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import {
  authenticateToken,
  requireUserDataIsolation,
  optionalAuthentication,
  AuthenticatedRequest,
} from './auth';
import * as AuthService from '../services/AuthenticationService';

// Mock the AuthenticationService
vi.mock('../services/AuthenticationService', () => ({
  getAuthenticationService: vi.fn(),
}));

describe('Authentication Middleware', () => {
  let mockRequest: Partial<AuthenticatedRequest>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let mockAuthService: {
    validateToken: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    // Reset mocks before each test
    mockRequest = {
      headers: {},
      params: {},
      query: {},
      body: {},
    };

    mockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    mockNext = vi.fn();

    mockAuthService = {
      validateToken: vi.fn(),
    };

    vi.mocked(AuthService.getAuthenticationService).mockReturnValue(
      mockAuthService as any
    );
  });

  describe('authenticateToken', () => {
    it('should authenticate valid token and attach user to request', async () => {
      // Arrange
      const token = 'valid-token-123';
      mockRequest.headers = {
        authorization: `Bearer ${token}`,
      };

      mockAuthService.validateToken.mockResolvedValue({
        userId: 'user-123',
        email: 'test@example.com',
      });

      // Act
      await authenticateToken(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response,
        mockNext
      );

      // Assert
      expect(mockAuthService.validateToken).toHaveBeenCalledWith(token);
      expect(mockRequest.user).toEqual({
        userId: 'user-123',
        email: 'test@example.com',
      });
      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('should return 401 when no authorization header is provided', async () => {
      // Arrange
      mockRequest.headers = {};

      // Act
      await authenticateToken(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response,
        mockNext
      );

      // Assert
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Authentication required',
        details: 'No token provided',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 when authorization header does not start with Bearer', async () => {
      // Arrange
      mockRequest.headers = {
        authorization: 'Basic some-credentials',
      };

      // Act
      await authenticateToken(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response,
        mockNext
      );

      // Assert
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Authentication required',
        details: 'No token provided',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 when token is expired (30-minute timeout)', async () => {
      // Arrange
      const token = 'expired-token';
      mockRequest.headers = {
        authorization: `Bearer ${token}`,
      };

      mockAuthService.validateToken.mockRejectedValue(
        new Error('Session expired')
      );

      // Act
      await authenticateToken(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response,
        mockNext
      );

      // Assert
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Session expired',
        details: 'Your session has expired after 30 minutes of inactivity. Please log in again.',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 when token is invalid', async () => {
      // Arrange
      const token = 'invalid-token';
      mockRequest.headers = {
        authorization: `Bearer ${token}`,
      };

      mockAuthService.validateToken.mockRejectedValue(
        new Error('Invalid token')
      );

      // Act
      await authenticateToken(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response,
        mockNext
      );

      // Assert
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Invalid token',
        details: 'The provided authentication token is invalid.',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 401 when session is not found', async () => {
      // Arrange
      const token = 'unknown-token';
      mockRequest.headers = {
        authorization: `Bearer ${token}`,
      };

      mockAuthService.validateToken.mockRejectedValue(
        new Error('Session not found')
      );

      // Act
      await authenticateToken(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response,
        mockNext
      );

      // Assert
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Invalid token',
        details: 'The provided authentication token is invalid.',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should return 500 on unexpected authentication service error', async () => {
      // Arrange
      const token = 'valid-token';
      mockRequest.headers = {
        authorization: `Bearer ${token}`,
      };

      mockAuthService.validateToken.mockRejectedValue(
        new Error('Database connection failed')
      );

      // Act
      await authenticateToken(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response,
        mockNext
      );

      // Assert
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Authentication failed',
        details: 'Database connection failed',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });
  });

  describe('requireUserDataIsolation', () => {
    beforeEach(() => {
      // Set up authenticated user
      mockRequest.user = {
        userId: 'user-123',
        email: 'test@example.com',
      };
    });

    describe('params location', () => {
      it('should allow access when userId in params matches authenticated user', () => {
        // Arrange
        mockRequest.params = { userId: 'user-123' };
        const middleware = requireUserDataIsolation('userId', 'params');

        // Act
        middleware(
          mockRequest as AuthenticatedRequest,
          mockResponse as Response,
          mockNext
        );

        // Assert
        expect(mockNext).toHaveBeenCalled();
        expect(mockResponse.status).not.toHaveBeenCalled();
      });

      it('should return 403 when userId in params does not match authenticated user', () => {
        // Arrange
        mockRequest.params = { userId: 'user-456' };
        const middleware = requireUserDataIsolation('userId', 'params');

        // Act
        middleware(
          mockRequest as AuthenticatedRequest,
          mockResponse as Response,
          mockNext
        );

        // Assert
        expect(mockResponse.status).toHaveBeenCalledWith(403);
        expect(mockResponse.json).toHaveBeenCalledWith({
          error: 'Access denied',
          details: 'You can only access your own data',
        });
        expect(mockNext).not.toHaveBeenCalled();
      });

      it('should allow access when no userId is in params', () => {
        // Arrange
        mockRequest.params = {};
        const middleware = requireUserDataIsolation('userId', 'params');

        // Act
        middleware(
          mockRequest as AuthenticatedRequest,
          mockResponse as Response,
          mockNext
        );

        // Assert
        expect(mockNext).toHaveBeenCalled();
        expect(mockResponse.status).not.toHaveBeenCalled();
      });
    });

    describe('query location', () => {
      it('should allow access when userId in query matches authenticated user', () => {
        // Arrange
        mockRequest.query = { userId: 'user-123' };
        const middleware = requireUserDataIsolation('userId', 'query');

        // Act
        middleware(
          mockRequest as AuthenticatedRequest,
          mockResponse as Response,
          mockNext
        );

        // Assert
        expect(mockNext).toHaveBeenCalled();
        expect(mockResponse.status).not.toHaveBeenCalled();
      });

      it('should return 403 when userId in query does not match authenticated user', () => {
        // Arrange
        mockRequest.query = { userId: 'user-789' };
        const middleware = requireUserDataIsolation('userId', 'query');

        // Act
        middleware(
          mockRequest as AuthenticatedRequest,
          mockResponse as Response,
          mockNext
        );

        // Assert
        expect(mockResponse.status).toHaveBeenCalledWith(403);
        expect(mockResponse.json).toHaveBeenCalledWith({
          error: 'Access denied',
          details: 'You can only access your own data',
        });
        expect(mockNext).not.toHaveBeenCalled();
      });
    });

    describe('body location', () => {
      it('should allow access when userId in body matches authenticated user', () => {
        // Arrange
        mockRequest.body = { userId: 'user-123' };
        const middleware = requireUserDataIsolation('userId', 'body');

        // Act
        middleware(
          mockRequest as AuthenticatedRequest,
          mockResponse as Response,
          mockNext
        );

        // Assert
        expect(mockNext).toHaveBeenCalled();
        expect(mockResponse.status).not.toHaveBeenCalled();
      });

      it('should return 403 when userId in body does not match authenticated user', () => {
        // Arrange
        mockRequest.body = { userId: 'user-999' };
        const middleware = requireUserDataIsolation('userId', 'body');

        // Act
        middleware(
          mockRequest as AuthenticatedRequest,
          mockResponse as Response,
          mockNext
        );

        // Assert
        expect(mockResponse.status).toHaveBeenCalledWith(403);
        expect(mockResponse.json).toHaveBeenCalledWith({
          error: 'Access denied',
          details: 'You can only access your own data',
        });
        expect(mockNext).not.toHaveBeenCalled();
      });
    });

    it('should return 401 when user is not authenticated', () => {
      // Arrange
      mockRequest.user = undefined;
      mockRequest.params = { userId: 'user-123' };
      const middleware = requireUserDataIsolation('userId', 'params');

      // Act
      middleware(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response,
        mockNext
      );

      // Assert
      expect(mockResponse.status).toHaveBeenCalledWith(401);
      expect(mockResponse.json).toHaveBeenCalledWith({
        error: 'Authentication required',
        details: 'User must be authenticated to access this resource',
      });
      expect(mockNext).not.toHaveBeenCalled();
    });

    it('should work with custom parameter name', () => {
      // Arrange
      mockRequest.params = { ownerId: 'user-123' };
      const middleware = requireUserDataIsolation('ownerId', 'params');

      // Act
      middleware(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response,
        mockNext
      );

      // Assert
      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });
  });

  describe('optionalAuthentication', () => {
    it('should attach user to request when valid token is provided', async () => {
      // Arrange
      const token = 'valid-token-123';
      mockRequest.headers = {
        authorization: `Bearer ${token}`,
      };

      mockAuthService.validateToken.mockResolvedValue({
        userId: 'user-123',
        email: 'test@example.com',
      });

      // Act
      await optionalAuthentication(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response,
        mockNext
      );

      // Assert
      expect(mockAuthService.validateToken).toHaveBeenCalledWith(token);
      expect(mockRequest.user).toEqual({
        userId: 'user-123',
        email: 'test@example.com',
      });
      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('should continue without user when no token is provided', async () => {
      // Arrange
      mockRequest.headers = {};

      // Act
      await optionalAuthentication(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response,
        mockNext
      );

      // Assert
      expect(mockAuthService.validateToken).not.toHaveBeenCalled();
      expect(mockRequest.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('should continue without user when token is invalid', async () => {
      // Arrange
      const token = 'invalid-token';
      mockRequest.headers = {
        authorization: `Bearer ${token}`,
      };

      mockAuthService.validateToken.mockRejectedValue(
        new Error('Invalid token')
      );

      // Act
      await optionalAuthentication(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response,
        mockNext
      );

      // Assert
      expect(mockAuthService.validateToken).toHaveBeenCalledWith(token);
      expect(mockRequest.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });

    it('should continue without user when token is expired', async () => {
      // Arrange
      const token = 'expired-token';
      mockRequest.headers = {
        authorization: `Bearer ${token}`,
      };

      mockAuthService.validateToken.mockRejectedValue(
        new Error('Token expired')
      );

      // Act
      await optionalAuthentication(
        mockRequest as AuthenticatedRequest,
        mockResponse as Response,
        mockNext
      );

      // Assert
      expect(mockAuthService.validateToken).toHaveBeenCalledWith(token);
      expect(mockRequest.user).toBeUndefined();
      expect(mockNext).toHaveBeenCalled();
      expect(mockResponse.status).not.toHaveBeenCalled();
    });
  });
});

/**
 * Integration-style tests for edge cases
 */
describe('Authentication Middleware - Edge Cases', () => {
  let mockRequest: Partial<AuthenticatedRequest>;
  let mockResponse: Partial<Response>;
  let mockNext: NextFunction;
  let mockAuthService: {
    validateToken: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockRequest = {
      headers: {},
      params: {},
      query: {},
      body: {},
    };

    mockResponse = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
    };

    mockNext = vi.fn();

    mockAuthService = {
      validateToken: vi.fn(),
    };

    vi.mocked(AuthService.getAuthenticationService).mockReturnValue(
      mockAuthService as any
    );
  });

  it('should handle authorization header with proper Bearer format', async () => {
    // Arrange
    mockRequest.headers = {
      authorization: 'Bearer valid-token-123',
    };

    mockAuthService.validateToken.mockResolvedValue({
      userId: 'user-123',
      email: 'test@example.com',
    });

    // Act
    await authenticateToken(
      mockRequest as AuthenticatedRequest,
      mockResponse as Response,
      mockNext
    );

    // Assert - should extract token correctly after 'Bearer '
    expect(mockAuthService.validateToken).toHaveBeenCalledWith('valid-token-123');
    expect(mockNext).toHaveBeenCalled();
  });

  it('should prevent data isolation bypass with empty string userId', () => {
    // Arrange
    mockRequest.user = {
      userId: 'user-123',
      email: 'test@example.com',
    };
    mockRequest.params = { userId: '' };
    const middleware = requireUserDataIsolation('userId', 'params');

    // Act
    middleware(
      mockRequest as AuthenticatedRequest,
      mockResponse as Response,
      mockNext
    );

    // Assert - empty string should be treated as no userId provided
    expect(mockNext).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });

  it('should handle missing body gracefully in data isolation check', () => {
    // Arrange
    mockRequest.user = {
      userId: 'user-123',
      email: 'test@example.com',
    };
    mockRequest.body = undefined;
    const middleware = requireUserDataIsolation('userId', 'body');

    // Act
    middleware(
      mockRequest as AuthenticatedRequest,
      mockResponse as Response,
      mockNext
    );

    // Assert
    expect(mockNext).toHaveBeenCalled();
    expect(mockResponse.status).not.toHaveBeenCalled();
  });
});
