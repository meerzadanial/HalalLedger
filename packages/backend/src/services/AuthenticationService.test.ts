import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { AuthenticationService } from './AuthenticationService';
import { initializeDatabase, closeDatabase, getDatabaseClient } from '../database/client';

describe('AuthenticationService', () => {
  let authService: AuthenticationService;
  const testEmail = 'test@example.com';
  const testPassword = 'SecurePassword123!';
  const testJwtSecret = 'test-jwt-secret-for-unit-tests-only-do-not-use-in-production';

  beforeAll(async () => {
    // Initialize database connection
    await initializeDatabase();
    authService = new AuthenticationService(testJwtSecret, 30, 10);
  });

  afterAll(async () => {
    // Clean up and close database connection
    await closeDatabase();
  });

  beforeEach(async () => {
    // Clean up test data before each test
    const prisma = getDatabaseClient().getClient();
    await prisma.sessionToken.deleteMany({});
    await prisma.user.deleteMany({});
  });

  describe('Password Hashing', () => {
    it('should hash a password successfully', async () => {
      const hashedPassword = await authService.hashPassword(testPassword);
      
      expect(hashedPassword).toBeDefined();
      expect(hashedPassword).not.toBe(testPassword);
      expect(hashedPassword.length).toBeGreaterThan(0);
    });

    it('should generate different hashes for the same password', async () => {
      const hash1 = await authService.hashPassword(testPassword);
      const hash2 = await authService.hashPassword(testPassword);
      
      expect(hash1).not.toBe(hash2); // bcrypt includes salt, so hashes differ
    });

    it('should verify a correct password', async () => {
      const hash = await authService.hashPassword(testPassword);
      const isValid = await authService.verifyPassword(testPassword, hash);
      
      expect(isValid).toBe(true);
    });

    it('should reject an incorrect password', async () => {
      const hash = await authService.hashPassword(testPassword);
      const isValid = await authService.verifyPassword('WrongPassword', hash);
      
      expect(isValid).toBe(false);
    });
  });

  describe('User Creation', () => {
    it('should create a new user successfully', async () => {
      const user = await authService.createUser(testEmail, testPassword);
      
      expect(user).toBeDefined();
      expect(user.email).toBe(testEmail);
      expect(user.id).toBeDefined();
    });

    it('should reject duplicate email addresses', async () => {
      await authService.createUser(testEmail, testPassword);
      
      await expect(
        authService.createUser(testEmail, testPassword)
      ).rejects.toThrow('User already exists');
    });
  });

  describe('Login', () => {
    beforeEach(async () => {
      // Create a test user for login tests
      await authService.createUser(testEmail, testPassword);
    });

    it('should login with valid credentials', async () => {
      const result = await authService.login(testEmail, testPassword);
      
      expect(result).toBeDefined();
      expect(result.token).toBeDefined();
      expect(result.expiresAt).toBeInstanceOf(Date);
      expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('should reject login with invalid email', async () => {
      await expect(
        authService.login('nonexistent@example.com', testPassword)
      ).rejects.toThrow('Invalid credentials');
    });

    it('should reject login with invalid password', async () => {
      await expect(
        authService.login(testEmail, 'WrongPassword')
      ).rejects.toThrow('Invalid credentials');
    });

    it('should create a session token in the database', async () => {
      const prisma = getDatabaseClient().getClient();
      
      await authService.login(testEmail, testPassword);
      
      const user = await prisma.user.findUnique({
        where: { email: testEmail },
        include: { sessions: true },
      });
      
      expect(user?.sessions.length).toBeGreaterThan(0);
    });
  });

  describe('Token Validation', () => {
    let validToken: string;

    beforeEach(async () => {
      // Create user and login to get a valid token
      await authService.createUser(testEmail, testPassword);
      const result = await authService.login(testEmail, testPassword);
      validToken = result.token;
    });

    it('should validate a valid token', async () => {
      const result = await authService.validateToken(validToken);
      
      expect(result).toBeDefined();
      expect(result.email).toBe(testEmail);
      expect(result.userId).toBeDefined();
    });

    it('should reject an invalid token', async () => {
      const invalidToken = 'invalid.jwt.token';
      
      await expect(
        authService.validateToken(invalidToken)
      ).rejects.toThrow();
    });

    it('should reject a token that is not in the database', async () => {
      // Logout to remove token from database
      await authService.logout(validToken);
      
      await expect(
        authService.validateToken(validToken)
      ).rejects.toThrow('Session not found');
    });
  });

  describe('Logout', () => {
    let validToken: string;

    beforeEach(async () => {
      await authService.createUser(testEmail, testPassword);
      const result = await authService.login(testEmail, testPassword);
      validToken = result.token;
    });

    it('should logout and invalidate token', async () => {
      await authService.logout(validToken);
      
      await expect(
        authService.validateToken(validToken)
      ).rejects.toThrow('Session not found');
    });

    it('should be idempotent (logout twice does not error)', async () => {
      await authService.logout(validToken);
      await expect(authService.logout(validToken)).resolves.not.toThrow();
    });
  });

  describe('Token Refresh', () => {
    let validToken: string;

    beforeEach(async () => {
      await authService.createUser(testEmail, testPassword);
      const result = await authService.login(testEmail, testPassword);
      validToken = result.token;
    });

    it('should refresh a valid token', async () => {
      const result = await authService.refreshToken(validToken);
      
      expect(result).toBeDefined();
      expect(result.token).toBeDefined();
      expect(result.token).not.toBe(validToken); // New token is different
      expect(result.expiresAt).toBeInstanceOf(Date);
    });

    it('should invalidate the old token after refresh', async () => {
      await authService.refreshToken(validToken);
      
      await expect(
        authService.validateToken(validToken)
      ).rejects.toThrow('Session not found');
    });

    it('should reject refresh with an invalid token', async () => {
      const invalidToken = 'invalid.jwt.token';
      
      await expect(
        authService.refreshToken(invalidToken)
      ).rejects.toThrow();
    });
  });

  describe('Session Management', () => {
    let userId: string;

    beforeEach(async () => {
      const user = await authService.createUser(testEmail, testPassword);
      userId = user.id;
    });

    it('should get active sessions for a user', async () => {
      // Create multiple sessions
      await authService.login(testEmail, testPassword);
      await authService.login(testEmail, testPassword);
      
      const sessions = await authService.getActiveSessions(userId);
      
      expect(sessions.length).toBe(2);
    });

    it('should logout all sessions for a user', async () => {
      // Create multiple sessions
      await authService.login(testEmail, testPassword);
      await authService.login(testEmail, testPassword);
      
      await authService.logoutAllSessions(userId);
      
      const sessions = await authService.getActiveSessions(userId);
      expect(sessions.length).toBe(0);
    });
  });

  describe('Token Expiration', () => {
    it('should set token expiration to 30 minutes in the future', async () => {
      await authService.createUser(testEmail, testPassword);
      const result = await authService.login(testEmail, testPassword);
      
      const expectedExpiration = Date.now() + 30 * 60 * 1000;
      const actualExpiration = result.expiresAt.getTime();
      
      // Allow 1 second tolerance for test execution time
      expect(Math.abs(actualExpiration - expectedExpiration)).toBeLessThan(1000);
    });

    it('should use custom expiration time when configured', async () => {
      const customAuthService = new AuthenticationService(testJwtSecret, 60); // 60 minutes
      await customAuthService.createUser('custom@example.com', testPassword);
      
      const result = await customAuthService.login('custom@example.com', testPassword);
      
      const expectedExpiration = Date.now() + 60 * 60 * 1000;
      const actualExpiration = result.expiresAt.getTime();
      
      expect(Math.abs(actualExpiration - expectedExpiration)).toBeLessThan(1000);
    });
  });

  describe('Password Requirements Validation', () => {
    it('should accept passwords with various characters', async () => {
      const passwords = [
        'SimplePass123',
        'Complex!@#Pass123',
        'with spaces 123',
        'unicode-ñoño-123',
      ];

      for (const password of passwords) {
        const email = `test${passwords.indexOf(password)}@example.com`;
        await expect(
          authService.createUser(email, password)
        ).resolves.toBeDefined();
      }
    });
  });

  describe('Security Properties', () => {
    it('should not expose password in error messages', async () => {
      try {
        await authService.login('nonexistent@example.com', testPassword);
        expect.fail('Should have thrown an error');
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : '';
        expect(errorMessage).not.toContain(testPassword);
      }
    });

    it('should hash tokens before storing in database', async () => {
      const prisma = getDatabaseClient().getClient();
      
      await authService.createUser(testEmail, testPassword);
      const result = await authService.login(testEmail, testPassword);
      
      const sessionToken = await prisma.sessionToken.findFirst({
        where: {
          user: { email: testEmail },
        },
      });
      
      expect(sessionToken?.tokenHash).not.toBe(result.token);
      expect(sessionToken?.tokenHash.length).toBe(64); // SHA-256 hex digest length
    });
  });
});
