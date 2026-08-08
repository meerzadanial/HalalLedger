import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';
import { getDatabaseClient } from '../database/client';

/**
 * AuthenticationService - Manages user authentication with JWT tokens
 * 
 * Features:
 * - Password hashing with bcrypt (10 rounds)
 * - JWT token generation with 30-minute expiration
 * - Token validation and session management
 * - Secure token storage with hashed values
 * - Token refresh mechanism
 * 
 * Validates Requirements: 1.1, 1.2, 1.4
 */
export class AuthenticationService {
  private prisma: PrismaClient;
  private jwtSecret: string;
  private tokenExpirationMinutes: number;
  private bcryptRounds: number;

  /**
   * Creates a new AuthenticationService instance
   * @param jwtSecret - Secret key for JWT signing (default from env JWT_SECRET)
   * @param tokenExpirationMinutes - Token expiration time in minutes (default: 30)
   * @param bcryptRounds - Number of bcrypt hashing rounds (default: 10)
   */
  constructor(
    jwtSecret?: string,
    tokenExpirationMinutes: number = 30,
    bcryptRounds: number = 10
  ) {
    const dbClient = getDatabaseClient();
    this.prisma = dbClient.getClient();
    this.jwtSecret = jwtSecret || process.env.JWT_SECRET || this.generateDefaultSecret();
    this.tokenExpirationMinutes = tokenExpirationMinutes;
    this.bcryptRounds = bcryptRounds;

    if (!process.env.JWT_SECRET) {
      console.warn('⚠️  JWT_SECRET not set in environment. Using generated secret (not suitable for production).');
    }
  }

  /**
   * Generates a default JWT secret for development use only
   * @returns Random secret string
   */
  private generateDefaultSecret(): string {
    return crypto.randomBytes(32).toString('hex');
  }

  /**
   * Hashes a password using bcrypt
   * @param password - Plain text password to hash
   * @returns Promise resolving to hashed password
   * 
   * Validates: Requirements 1.4 (password encryption)
   */
  async hashPassword(password: string): Promise<string> {
    try {
      const hash = await bcrypt.hash(password, this.bcryptRounds);
      return hash;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to hash password: ${errorMessage}`);
    }
  }

  /**
   * Verifies a password against a hash
   * @param password - Plain text password to verify
   * @param hash - Hashed password to compare against
   * @returns Promise resolving to true if password matches
   * 
   * Validates: Requirements 1.1 (credential validation)
   */
  async verifyPassword(password: string, hash: string): Promise<boolean> {
    try {
      const isMatch = await bcrypt.compare(password, hash);
      return isMatch;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Password verification error:', errorMessage);
      return false;
    }
  }

  /**
   * Authenticates a user and generates a JWT token
   * @param email - User email address
   * @param password - User password
   * @returns Promise resolving to token and expiration date
   * @throws Error if credentials are invalid
   * 
   * Validates: Requirements 1.1 (grant access with valid credentials), 1.2 (deny access with invalid credentials)
   */
  async login(email: string, password: string): Promise<{ token: string; expiresAt: Date }> {
    try {
      // Find user by email
      const user = await this.prisma.user.findUnique({
        where: { email },
      });

      if (!user) {
        throw new Error('Invalid credentials');
      }

      // Verify password
      const isPasswordValid = await this.verifyPassword(password, user.passwordHash);
      if (!isPasswordValid) {
        throw new Error('Invalid credentials');
      }

      // Generate JWT token with unique jti (JWT ID) to ensure uniqueness
      const expiresAt = new Date(Date.now() + this.tokenExpirationMinutes * 60 * 1000);
      const token = jwt.sign(
        {
          userId: user.id,
          email: user.email,
          jti: `${user.id}-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`, // Unique token ID
        },
        this.jwtSecret,
        {
          expiresIn: `${this.tokenExpirationMinutes}m`,
        }
      );

      // Hash the token for storage
      const tokenHash = this.hashToken(token);

      // Store session token in database
      await this.prisma.sessionToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt,
        },
      });

      // Clean up expired tokens for this user
      await this.cleanupExpiredTokens(user.id);

      return { token, expiresAt };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      
      // Don't expose internal errors to the caller
      if (errorMessage === 'Invalid credentials') {
        throw error;
      }
      
      console.error('Login error:', errorMessage);
      throw new Error('Authentication failed');
    }
  }

  /**
   * Validates a JWT token and returns user information
   * @param token - JWT token to validate
   * @returns Promise resolving to user ID and email
   * @throws Error if token is invalid or expired
   * 
   * Validates: Requirements 1.3 (session timeout after 30 minutes)
   */
  async validateToken(token: string): Promise<{ userId: string; email: string }> {
    try {
      // Verify JWT signature and expiration
      const decoded = jwt.verify(token, this.jwtSecret) as {
        userId: string;
        email: string;
        exp: number;
      };

      // Hash the token to look up in database
      const tokenHash = this.hashToken(token);

      // Check if token exists in database and is not expired
      const sessionToken = await this.prisma.sessionToken.findUnique({
        where: { tokenHash },
      });

      if (!sessionToken) {
        throw new Error('Session not found');
      }

      if (sessionToken.expiresAt < new Date()) {
        // Clean up expired token
        await this.prisma.sessionToken.delete({
          where: { tokenHash },
        });
        throw new Error('Session expired');
      }

      return {
        userId: decoded.userId,
        email: decoded.email,
      };
    } catch (error) {
      if (error instanceof jwt.JsonWebTokenError) {
        throw new Error('Invalid token');
      }
      if (error instanceof jwt.TokenExpiredError) {
        throw new Error('Token expired');
      }
      throw error;
    }
  }

  /**
   * Logs out a user by invalidating their token
   * @param token - JWT token to invalidate
   * @returns Promise resolving when logout is complete
   */
  async logout(token: string): Promise<void> {
    try {
      const tokenHash = this.hashToken(token);

      // Delete session token from database
      await this.prisma.sessionToken.deleteMany({
        where: { tokenHash },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Logout error:', errorMessage);
      // Don't throw - logout should be idempotent
    }
  }

  /**
   * Refreshes a token by generating a new one with extended expiration
   * @param token - Current JWT token
   * @returns Promise resolving to new token and expiration date
   * @throws Error if token is invalid
   */
  async refreshToken(token: string): Promise<{ token: string; expiresAt: Date }> {
    try {
      // Validate the current token
      const { userId, email } = await this.validateToken(token);

      // Invalidate the old token
      await this.logout(token);

      // Generate new token with unique jti (JWT ID) to ensure uniqueness
      const expiresAt = new Date(Date.now() + this.tokenExpirationMinutes * 60 * 1000);
      const newToken = jwt.sign(
        {
          userId,
          email,
          jti: `${userId}-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`, // Unique token ID
        },
        this.jwtSecret,
        {
          expiresIn: `${this.tokenExpirationMinutes}m`,
        }
      );

      // Hash and store new token
      const tokenHash = this.hashToken(newToken);
      await this.prisma.sessionToken.create({
        data: {
          userId,
          tokenHash,
          expiresAt,
        },
      });

      return { token: newToken, expiresAt };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to refresh token: ${errorMessage}`);
    }
  }

  /**
   * Creates a new user account
   * @param email - User email address
   * @param password - User password (will be hashed)
   * @returns Promise resolving to created user
   * @throws Error if email already exists
   */
  async createUser(email: string, password: string): Promise<{ id: string; email: string }> {
    try {
      // Check if user already exists
      const existingUser = await this.prisma.user.findUnique({
        where: { email },
      });

      if (existingUser) {
        throw new Error('User already exists');
      }

      // Hash password
      const passwordHash = await this.hashPassword(password);

      // Create user
      const user = await this.prisma.user.create({
        data: {
          email,
          passwordHash,
        },
        select: {
          id: true,
          email: true,
        },
      });

      return user;
    } catch (error) {
      if (error instanceof Error && error.message === 'User already exists') {
        throw error;
      }
      
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to create user: ${errorMessage}`);
    }
  }

  /**
   * Hashes a token for secure storage using SHA-256
   * @param token - Token to hash
   * @returns Hashed token string
   */
  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  /**
   * Cleans up expired session tokens for a user
   * @param userId - User ID to clean up tokens for
   */
  private async cleanupExpiredTokens(userId: string): Promise<void> {
    try {
      await this.prisma.sessionToken.deleteMany({
        where: {
          userId,
          expiresAt: {
            lt: new Date(),
          },
        },
      });
    } catch (error) {
      // Log but don't throw - cleanup is best-effort
      console.error('Failed to cleanup expired tokens:', error);
    }
  }

  /**
   * Gets all active sessions for a user
   * @param userId - User ID to get sessions for
   * @returns Promise resolving to array of session expiration dates
   */
  async getActiveSessions(userId: string): Promise<{ id: string; expiresAt: Date }[]> {
    try {
      const sessions = await this.prisma.sessionToken.findMany({
        where: {
          userId,
          expiresAt: {
            gt: new Date(),
          },
        },
        select: {
          id: true,
          expiresAt: true,
        },
        orderBy: {
          expiresAt: 'desc',
        },
      });

      return sessions;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get active sessions: ${errorMessage}`);
    }
  }

  /**
   * Logs out all sessions for a user
   * @param userId - User ID to log out
   */
  async logoutAllSessions(userId: string): Promise<void> {
    try {
      await this.prisma.sessionToken.deleteMany({
        where: { userId },
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to logout all sessions:', errorMessage);
      throw new Error('Failed to logout all sessions');
    }
  }
}

// Singleton instance for application-wide use
let authServiceInstance: AuthenticationService | null = null;

/**
 * Gets or creates a singleton AuthenticationService instance
 * @returns AuthenticationService singleton instance
 */
export function getAuthenticationService(): AuthenticationService {
  if (!authServiceInstance) {
    authServiceInstance = new AuthenticationService();
  }
  return authServiceInstance;
}
