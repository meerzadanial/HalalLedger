# Authentication Service Implementation

## Overview

The `AuthenticationService` class provides JWT-based authentication with secure password hashing using bcrypt. This implementation fulfills task 3.1 of the HalalOrNot Income Tracking System.

## Features

### 1. Password Hashing with bcrypt
- **Configurable rounds**: Default 10 rounds (configurable via constructor)
- **Salt generation**: Automatic salt generation per password
- **Validation**: Secure password comparison using bcrypt.compare()
- **Requirements**: Validates Requirement 1.4 (industry-standard encryption)

### 2. JWT Token Generation
- **30-minute expiration**: Configurable token lifetime (default: 30 minutes)
- **Secure signing**: Uses HS256 algorithm with configurable JWT secret
- **Payload**: Contains userId and email
- **Requirements**: Validates Requirements 1.1, 1.2, 1.3

### 3. Token Refresh Mechanism
- **Automatic refresh**: Generates new token with extended expiration
- **Old token invalidation**: Previous token is invalidated on refresh
- **Session continuity**: Maintains user session without re-authentication

### 4. Session Management
- **Database persistence**: Session tokens stored in PostgreSQL via Prisma
- **Token hashing**: Tokens hashed (SHA-256) before database storage
- **Expiration tracking**: Automatic cleanup of expired tokens
- **Multi-session support**: Users can have multiple active sessions

## API Reference

### Constructor

```typescript
new AuthenticationService(
  jwtSecret?: string,           // JWT signing secret (default: env.JWT_SECRET)
  tokenExpirationMinutes?: number, // Token expiration in minutes (default: 30)
  bcryptRounds?: number         // Bcrypt hashing rounds (default: 10)
)
```

### Methods

#### `hashPassword(password: string): Promise<string>`
Hashes a password using bcrypt.

#### `verifyPassword(password: string, hash: string): Promise<boolean>`
Verifies a password against its hash.

#### `createUser(email: string, password: string): Promise<{ id: string; email: string }>`
Creates a new user account with hashed password.

#### `login(email: string, password: string): Promise<{ token: string; expiresAt: Date }>`
Authenticates user and generates JWT token.
- **Validates**: Requirements 1.1 (valid credentials), 1.2 (invalid credentials)

#### `validateToken(token: string): Promise<{ userId: string; email: string }>`
Validates JWT token and returns user information.
- **Validates**: Requirement 1.3 (30-minute session timeout)

#### `logout(token: string): Promise<void>`
Invalidates a token by removing it from the database.

#### `refreshToken(token: string): Promise<{ token: string; expiresAt: Date }>`
Refreshes a token by generating a new one with extended expiration.

#### `getActiveSessions(userId: string): Promise<{ id: string; expiresAt: Date }[]>`
Gets all active sessions for a user.

#### `logoutAllSessions(userId: string): Promise<void>`
Logs out all sessions for a user.

## Usage Example

```typescript
import { getAuthenticationService } from './services/AuthenticationService';

const authService = getAuthenticationService();

// Create a new user
const user = await authService.createUser('user@example.com', 'SecurePassword123!');

// Login
const { token, expiresAt } = await authService.login('user@example.com', 'SecurePassword123!');

// Validate token
const { userId, email } = await authService.validateToken(token);

// Refresh token
const { token: newToken } = await authService.refreshToken(token);

// Logout
await authService.logout(newToken);
```

## Security Features

### 1. Password Security
- **No plaintext storage**: Passwords are hashed with bcrypt before storage
- **Salt generation**: Each password has a unique salt
- **Configurable difficulty**: Bcrypt rounds can be adjusted for security/performance

### 2. Token Security
- **Hashed storage**: JWT tokens are hashed (SHA-256) before database storage
- **Expiration enforcement**: Tokens expire after 30 minutes (configurable)
- **Session validation**: Both JWT expiration and database session checked

### 3. Error Handling
- **Generic errors**: Authentication errors don't expose sensitive information
- **No password leakage**: Error messages never contain password values
- **Logging**: Errors logged server-side without exposing to client

## Testing

The implementation includes comprehensive unit tests covering:

- Password hashing and verification
- User creation and duplicate prevention
- Login with valid/invalid credentials
- Token validation and expiration
- Logout functionality
- Token refresh mechanism
- Session management
- Security properties

### Running Tests

```bash
# Run all tests
npm test

# Run authentication tests only
npm test -- AuthenticationService.test.ts

# Run tests in watch mode
npm run test:watch
```

**Note**: Tests require a PostgreSQL database connection. Set up a test database and configure `DATABASE_URL` in your `.env` file.

## Environment Configuration

Required environment variables:

```bash
# JWT Secret (required for production)
JWT_SECRET="your-secret-key-change-this-in-production"

# JWT Expiration (optional, default: 30m)
JWT_EXPIRES_IN="30m"

# Database connection string
DATABASE_URL="postgresql://username:password@localhost:5432/halalornot"
```

## Requirements Validation

This implementation validates the following requirements:

- **Requirement 1.1**: ✅ Grant access with valid credentials
- **Requirement 1.2**: ✅ Deny access with invalid credentials and display error
- **Requirement 1.3**: ✅ Session expires after 30 minutes of inactivity
- **Requirement 1.4**: ✅ Encrypt credentials using industry-standard encryption (bcrypt)

## Next Steps

Task 3.2 will implement:
- Authentication middleware for Express routes
- Session timeout detection
- User data isolation checks

## Dependencies

- `bcrypt`: Password hashing
- `jsonwebtoken`: JWT token generation and validation
- `@prisma/client`: Database ORM for session storage
- `crypto`: Token hashing (Node.js built-in)
