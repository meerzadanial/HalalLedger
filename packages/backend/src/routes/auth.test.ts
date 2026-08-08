import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import express, { Express } from 'express';
import authRoutes from './auth';
import { getAuthenticationService } from '../services/AuthenticationService';

// Mock the authentication service
vi.mock('../services/AuthenticationService', () => {
  const mockAuthService = {
    login: vi.fn(),
    logout: vi.fn(),
    validateToken: vi.fn(),
    hashToken: vi.fn(),
    prisma: {
      sessionToken: {
        findUnique: vi.fn(),
      },
    },
  };

  return {
    getAuthenticationService: vi.fn(() => mockAuthService),
  };
});

describe('Authentication API Routes', () => {
  let app: Express;
  let mockAuthService: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/auth', authRoutes);

    mockAuthService = getAuthenticationService();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /api/auth/login', () => {
    it('should successfully login with valid credentials', async () => {
      const mockToken = 'mock-jwt-token';
      const mockExpiresAt = new Date(Date.now() + 30 * 60 * 1000);

      mockAuthService.login.mockResolvedValue({
        token: mockToken,
        expiresAt: mockExpiresAt,
      });

      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'test@example.com',
          password: 'password123',
        });

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('token', mockToken);
      expect(response.body).toHaveProperty('expiresAt');
      expect(mockAuthService.login).toHaveBeenCalledWith(
        'test@example.com',
        'password123'
      );
    });

    it('should return 401 for invalid credentials', async () => {
      mockAuthService.login.mockRejectedValue(new Error('Invalid credentials'));

      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'test@example.com',
          password: 'wrongpassword',
        });

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error', 'Invalid credentials');
    });

    it('should return 400 for invalid email format', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'not-an-email',
          password: 'password123',
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Validation failed');
      expect(response.body.details).toContain('Valid email is required');
    });

    it('should return 400 for short password', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'test@example.com',
          password: '12345',
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Validation failed');
      expect(response.body.details).toContain(
        'Password must be at least 6 characters'
      );
    });

    it('should return 400 for missing email', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          password: 'password123',
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Validation failed');
    });

    it('should return 400 for missing password', async () => {
      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'test@example.com',
        });

      expect(response.status).toBe(400);
      expect(response.body).toHaveProperty('error', 'Validation failed');
    });

    it('should return 500 for unexpected server errors', async () => {
      mockAuthService.login.mockRejectedValue(new Error('Database connection failed'));

      const response = await request(app)
        .post('/api/auth/login')
        .send({
          email: 'test@example.com',
          password: 'password123',
        });

      expect(response.status).toBe(500);
      expect(response.body).toHaveProperty('error', 'Authentication failed');
    });
  });

  describe('POST /api/auth/logout', () => {
    it('should successfully logout with valid token', async () => {
      mockAuthService.validateToken.mockResolvedValue({
        userId: 'user-123',
        email: 'test@example.com',
      });
      mockAuthService.logout.mockResolvedValue(undefined);

      const response = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('success', true);
      expect(mockAuthService.logout).toHaveBeenCalledWith('valid-token');
    });

    it('should return 401 for missing authorization header', async () => {
      const response = await request(app).post('/api/auth/logout');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error', 'Authentication required');
    });

    it('should return 401 for invalid token', async () => {
      mockAuthService.validateToken.mockRejectedValue(new Error('Invalid token'));

      const response = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', 'Bearer invalid-token');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error', 'Invalid token');
    });

    it('should return 401 for expired token', async () => {
      mockAuthService.validateToken.mockRejectedValue(new Error('Session expired'));

      const response = await request(app)
        .post('/api/auth/logout')
        .set('Authorization', 'Bearer expired-token');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error', 'Session expired');
    });
  });

  describe('GET /api/auth/session', () => {
    it('should return session information for valid token', async () => {
      const mockExpiresAt = new Date(Date.now() + 30 * 60 * 1000);

      mockAuthService.validateToken.mockResolvedValue({
        userId: 'user-123',
        email: 'test@example.com',
      });
      mockAuthService.hashToken.mockReturnValue('hashed-token');
      mockAuthService.prisma.sessionToken.findUnique.mockResolvedValue({
        expiresAt: mockExpiresAt,
      });

      const response = await request(app)
        .get('/api/auth/session')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(200);
      expect(response.body).toHaveProperty('userId', 'user-123');
      expect(response.body).toHaveProperty('email', 'test@example.com');
      expect(response.body).toHaveProperty('expiresAt');
    });

    it('should return 401 for missing authorization header', async () => {
      const response = await request(app).get('/api/auth/session');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error', 'Authentication required');
    });

    it('should return 401 for invalid token', async () => {
      mockAuthService.validateToken.mockRejectedValue(new Error('Invalid token'));

      const response = await request(app)
        .get('/api/auth/session')
        .set('Authorization', 'Bearer invalid-token');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error', 'Invalid token');
    });

    it('should return 401 for expired session', async () => {
      mockAuthService.validateToken.mockRejectedValue(new Error('Session expired'));

      const response = await request(app)
        .get('/api/auth/session')
        .set('Authorization', 'Bearer expired-token');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error', 'Session expired');
    });

    it('should return 401 when session not found in database', async () => {
      mockAuthService.validateToken.mockResolvedValue({
        userId: 'user-123',
        email: 'test@example.com',
      });
      mockAuthService.hashToken.mockReturnValue('hashed-token');
      mockAuthService.prisma.sessionToken.findUnique.mockResolvedValue(null);

      const response = await request(app)
        .get('/api/auth/session')
        .set('Authorization', 'Bearer valid-token');

      expect(response.status).toBe(401);
      expect(response.body).toHaveProperty('error', 'Session not found');
    });
  });
});
