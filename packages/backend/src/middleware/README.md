# Authentication Middleware

This module provides Express middleware for protecting API endpoints with JWT token validation, session timeout detection, and user data isolation.

## Task 3.2: Implementation Summary

✅ **Implemented:**
- Token validation middleware (`authenticateToken`)
- Session timeout detection (30 minutes)
- User data isolation checks (`requireUserDataIsolation`)

✅ **Validates Requirements:**
- **Requirement 1.3**: Session expires after 30 minutes of inactivity
- **Requirement 1.5**: Multi-user data isolation

## Features

### 1. Token Authentication (`authenticateToken`)

Validates JWT tokens from the `Authorization` header and attaches user information to the request.

```typescript
import { authenticateToken } from './middleware';

app.get('/api/profile', authenticateToken, (req, res) => {
  // req.user contains { userId, email }
  res.json({ user: req.user });
});
```

**Behavior:**
- Extracts JWT token from `Authorization: Bearer <token>` header
- Validates token signature using `JWT_SECRET`
- Checks token expiration (30-minute timeout)
- Verifies session exists in database and is not expired
- Attaches `user` object to request: `{ userId: string, email: string }`

**Error Responses:**
- `401` - No token provided
- `401` - Invalid token
- `401` - Session expired (after 30 minutes)
- `500` - Unexpected server error

### 2. User Data Isolation (`requireUserDataIsolation`)

Ensures users can only access their own data by validating that requested user IDs match the authenticated user.

```typescript
import { authenticateToken, requireUserDataIsolation } from './middleware';

// Protect route parameter
app.get(
  '/api/users/:userId/entries',
  authenticateToken,
  requireUserDataIsolation('userId', 'params'),
  getEntriesHandler
);

// Protect request body
app.post(
  '/api/entries',
  authenticateToken,
  requireUserDataIsolation('userId', 'body'),
  createEntryHandler
);

// Protect query parameter
app.get(
  '/api/analytics',
  authenticateToken,
  requireUserDataIsolation('userId', 'query'),
  getAnalyticsHandler
);
```

**Parameters:**
- `paramName` (default: `'userId'`) - Name of the parameter to check
- `location` (default: `'params'`) - Where to look: `'params'`, `'query'`, or `'body'`

**Behavior:**
- Compares `req.user.userId` with the userId in the specified location
- If no userId is present, allows the request (route handler will use `req.user.userId`)
- If userId doesn't match authenticated user, returns 403

**Error Responses:**
- `401` - User not authenticated
- `403` - Access denied (userId mismatch)
- `500` - Unexpected server error

### 3. Optional Authentication (`optionalAuthentication`)

Attempts authentication but doesn't block the request if no token is provided. Useful for endpoints with different behavior for authenticated vs anonymous users.

```typescript
import { optionalAuthentication } from './middleware';

app.get('/api/dashboard', optionalAuthentication, (req, res) => {
  if (req.user) {
    // User is authenticated
    res.json({ personalized: true, userId: req.user.userId });
  } else {
    // User is anonymous
    res.json({ personalized: false });
  }
});
```

**Behavior:**
- If valid token exists, attaches user to request
- If no token or invalid token, continues without user
- Never blocks the request

## Session Timeout

Sessions expire **30 minutes** after creation, as specified in Requirement 1.3.

**How it works:**
1. JWT tokens are issued with 30-minute expiration (`exp` claim)
2. Session records in database have `expiresAt` timestamp
3. Both checks are performed on every request
4. Expired sessions are cleaned up automatically

**Client handling:**
```typescript
// Frontend should handle session expiration
const response = await fetch('/api/data', {
  headers: { 'Authorization': `Bearer ${token}` }
});

if (response.status === 401) {
  const error = await response.json();
  if (error.error === 'Session expired') {
    // Redirect to login
    window.location.href = '/login';
  }
}
```

## Usage Examples

See [`examples.ts`](./examples.ts) for comprehensive usage examples including:
- Basic protected routes
- User data isolation (params, query, body)
- Optional authentication
- Combining multiple middleware
- Protecting entire routers
- Token refresh patterns
- Testing protected routes

## Type Definitions

```typescript
interface AuthenticatedRequest extends Request {
  user?: {
    userId: string;
    email: string;
  };
}
```

## Security Considerations

1. **Always use HTTPS** in production to prevent token interception
2. **Store tokens securely** on client (httpOnly cookies or secure storage)
3. **Implement CSRF protection** for cookie-based authentication
4. **Use short-lived tokens** (30 minutes) to limit exposure window
5. **Implement token refresh** for better UX without compromising security
6. **Rate limit auth endpoints** to prevent brute force attacks
7. **Log authentication failures** for security monitoring

## Testing

Comprehensive test suite in [`auth.test.ts`](./auth.test.ts) with 23 test cases covering:
- Token validation
- Session expiration
- User data isolation
- Error handling
- Edge cases

Run tests:
```bash
npm test -- auth.test.ts
```

## Implementation Details

### Token Validation Flow

```
Request → Extract token from header
       ↓
    Validate JWT signature
       ↓
    Check JWT expiration
       ↓
    Query database for session
       ↓
    Check session expiration
       ↓
    Attach user to request
       ↓
    Continue to route handler
```

### Data Isolation Flow

```
Request → Check user authenticated
       ↓
    Extract userId from specified location
       ↓
    Compare with authenticated userId
       ↓
    If match: Continue
    If mismatch: Return 403
    If not present: Continue
```

## Dependencies

- `express` - Web framework
- `jsonwebtoken` - JWT token handling (via AuthenticationService)
- `@prisma/client` - Database access (via AuthenticationService)

## Related Modules

- [`AuthenticationService`](../services/AuthenticationService.ts) - Handles token generation, validation, and user authentication
- [`DatabaseClient`](../database/client.ts) - Manages database connections and queries

## API Endpoints Protected by This Middleware

These middleware functions should be applied to:
- `/api/income-entries` - Income entry management (requires data isolation)
- `/api/categories` - Category management (requires authentication)
- `/api/analytics` - Analytics endpoints (requires data isolation)
- `/api/profile` - User profile (requires authentication)
- All other user-specific endpoints

## Configuration

Token expiration and other settings are configured in `AuthenticationService`:

```typescript
// Default: 30 minutes
const authService = new AuthenticationService(
  process.env.JWT_SECRET,
  30, // tokenExpirationMinutes
  10  // bcryptRounds
);
```

## Error Codes Reference

| Status | Error | Description |
|--------|-------|-------------|
| 401 | Authentication required | No token provided |
| 401 | Invalid token | Token signature invalid or format incorrect |
| 401 | Session expired | Session exceeded 30-minute timeout |
| 403 | Access denied | User trying to access another user's data |
| 500 | Internal server error | Unexpected server error |

## Best Practices

1. **Apply `authenticateToken` first** before any route-specific middleware
2. **Use `requireUserDataIsolation`** for any endpoint that accesses user-specific data
3. **Use `optionalAuthentication`** for public endpoints with enhanced features for authenticated users
4. **Chain middleware** for complex authorization requirements
5. **Test thoroughly** with various token states (valid, expired, invalid, missing)

## Task Completion Checklist

- ✅ Implement token validation middleware
- ✅ Add session timeout detection (30 minutes)
- ✅ Implement user data isolation checks
- ✅ Write comprehensive unit tests (23 test cases, all passing)
- ✅ Create usage examples
- ✅ Document API and security considerations
- ✅ Validate Requirements 1.3 and 1.5
