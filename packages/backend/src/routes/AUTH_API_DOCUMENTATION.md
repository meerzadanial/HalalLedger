# Authentication API Documentation

This document describes the authentication API endpoints implemented for the HalalOrNot Income Tracking System.

## Overview

The authentication API provides secure user authentication with JWT tokens, session management, and proper error handling for invalid credentials and expired sessions.

**Base URL:** `/api/auth`

**Authentication Method:** Bearer Token (JWT)

**Session Duration:** 30 minutes

## Endpoints

### 1. POST /api/auth/login

Authenticates a user with email and password credentials.

**Request:**
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "user@example.com",
  "password": "securepassword123"
}
```

**Success Response (200 OK):**
```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expiresAt": "2024-01-15T10:30:00.000Z"
}
```

**Error Responses:**

- **400 Bad Request** - Validation errors
```json
{
  "error": "Validation failed",
  "details": [
    "Valid email is required",
    "Password must be at least 6 characters"
  ]
}
```

- **401 Unauthorized** - Invalid credentials
```json
{
  "error": "Invalid credentials"
}
```

- **500 Internal Server Error** - Server error
```json
{
  "error": "Authentication failed"
}
```

**Validation Rules:**
- `email`: Must be a valid email format
- `password`: Minimum 6 characters

**Validates Requirements:** 1.1 (grant access with valid credentials), 1.2 (deny access with invalid credentials)

---

### 2. POST /api/auth/logout

Invalidates the user's current session token.

**Request:**
```http
POST /api/auth/logout
Authorization: Bearer <token>
```

**Success Response (200 OK):**
```json
{
  "success": true
}
```

**Error Responses:**

- **401 Unauthorized** - Missing or invalid token
```json
{
  "error": "Authentication required",
  "details": "No token provided"
}
```

```json
{
  "error": "Invalid token",
  "details": "The provided authentication token is invalid."
}
```

```json
{
  "error": "Session expired",
  "details": "Your session has expired after 30 minutes of inactivity. Please log in again."
}
```

- **500 Internal Server Error** - Server error
```json
{
  "error": "Logout failed"
}
```

**Validates Requirements:** 1.1 (session management)

---

### 3. GET /api/auth/session

Retrieves current session information for an authenticated user.

**Request:**
```http
GET /api/auth/session
Authorization: Bearer <token>
```

**Success Response (200 OK):**
```json
{
  "userId": "550e8400-e29b-41d4-a716-446655440000",
  "email": "user@example.com",
  "expiresAt": "2024-01-15T10:30:00.000Z"
}
```

**Error Responses:**

- **401 Unauthorized** - Missing, invalid, or expired token
```json
{
  "error": "Authentication required",
  "details": "No token provided"
}
```

```json
{
  "error": "Invalid token",
  "details": "The provided authentication token is invalid."
}
```

```json
{
  "error": "Session expired",
  "details": "Your session has expired after 30 minutes of inactivity. Please log in again."
}
```

```json
{
  "error": "Session not found"
}
```

- **500 Internal Server Error** - Server error
```json
{
  "error": "Failed to retrieve session"
}
```

**Validates Requirements:** 1.3 (session timeout after 30 minutes)

---

## Authentication Flow

### Initial Login
1. Client sends email and password to `/api/auth/login`
2. Server validates credentials
3. Server generates JWT token with 30-minute expiration
4. Server stores session token (hashed) in database
5. Server returns token and expiration time to client
6. Client stores token for subsequent requests

### Authenticated Requests
1. Client includes token in `Authorization: Bearer <token>` header
2. Server validates token using authentication middleware
3. Middleware checks:
   - Token signature is valid
   - Token has not expired (30-minute timeout)
   - Session exists in database
4. If valid, request proceeds with user information attached
5. If invalid/expired, server returns 401 error

### Logout
1. Client sends logout request with token
2. Server removes session from database
3. Token becomes invalid for future requests

### Session Expiration
- Sessions automatically expire after 30 minutes
- Expired tokens return 401 error with "Session expired" message
- Client should redirect user to login page

---

## Security Features

### Password Security
- Passwords are hashed using bcrypt with 10 rounds
- Plain text passwords are never stored in the database
- Password validation requires minimum 6 characters

### Token Security
- JWT tokens signed with secret key (from JWT_SECRET env variable)
- Tokens stored as SHA-256 hashes in database
- 30-minute expiration enforces session timeout
- Token invalidation on logout

### Error Handling
- Generic error messages for authentication failures (no information leakage)
- Detailed validation errors for input mistakes
- Proper HTTP status codes for different error types

### Data Isolation
- Each user's data is isolated by userId
- JWT tokens contain userId claim
- Authentication middleware attaches user info to requests

---

## Usage Examples

### JavaScript/TypeScript (Fetch API)

```typescript
// Login
async function login(email: string, password: string) {
  const response = await fetch('http://localhost:3001/api/auth/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }

  const { token, expiresAt } = await response.json();
  
  // Store token in localStorage or memory
  localStorage.setItem('authToken', token);
  localStorage.setItem('tokenExpiry', expiresAt);
  
  return { token, expiresAt };
}

// Logout
async function logout(token: string) {
  const response = await fetch('http://localhost:3001/api/auth/logout', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error);
  }

  // Clear stored token
  localStorage.removeItem('authToken');
  localStorage.removeItem('tokenExpiry');
  
  return await response.json();
}

// Get session info
async function getSession(token: string) {
  const response = await fetch('http://localhost:3001/api/auth/session', {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const error = await response.json();
    
    // Handle session expiration
    if (error.error === 'Session expired') {
      // Redirect to login
      window.location.href = '/login';
    }
    
    throw new Error(error.error);
  }

  return await response.json();
}

// Check if token is expired
function isTokenExpired(): boolean {
  const expiryString = localStorage.getItem('tokenExpiry');
  if (!expiryString) return true;
  
  const expiry = new Date(expiryString);
  return expiry <= new Date();
}

// Get stored token
function getStoredToken(): string | null {
  if (isTokenExpired()) {
    localStorage.removeItem('authToken');
    localStorage.removeItem('tokenExpiry');
    return null;
  }
  
  return localStorage.getItem('authToken');
}
```

### cURL Examples

```bash
# Login
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"user@example.com","password":"password123"}'

# Logout
curl -X POST http://localhost:3001/api/auth/logout \
  -H "Authorization: Bearer <your-token-here>"

# Get session
curl -X GET http://localhost:3001/api/auth/session \
  -H "Authorization: Bearer <your-token-here>"
```

---

## Error Handling Best Practices

### Client-Side Error Handling

```typescript
async function handleAuthRequest<T>(requestFn: () => Promise<T>): Promise<T> {
  try {
    return await requestFn();
  } catch (error) {
    if (error instanceof Error) {
      const message = error.message;
      
      // Session expired - redirect to login
      if (message.includes('Session expired') || message.includes('expired')) {
        localStorage.removeItem('authToken');
        localStorage.removeItem('tokenExpiry');
        window.location.href = '/login';
        throw error;
      }
      
      // Invalid token - redirect to login
      if (message.includes('Invalid token') || message.includes('Authentication required')) {
        localStorage.removeItem('authToken');
        localStorage.removeItem('tokenExpiry');
        window.location.href = '/login';
        throw error;
      }
      
      // Invalid credentials - show error message
      if (message.includes('Invalid credentials')) {
        // Display error to user
        alert('Invalid email or password');
        throw error;
      }
      
      // Validation errors - show specific messages
      if (message.includes('Validation failed')) {
        // Display validation errors
        alert('Please check your input');
        throw error;
      }
    }
    
    // Unknown error
    console.error('Authentication error:', error);
    throw error;
  }
}
```

---

## Testing

The authentication endpoints include comprehensive unit tests covering:
- ✅ Successful login with valid credentials
- ✅ Failed login with invalid credentials
- ✅ Input validation (email format, password length)
- ✅ Missing required fields
- ✅ Successful logout
- ✅ Logout with missing/invalid token
- ✅ Session retrieval with valid token
- ✅ Session retrieval with expired token
- ✅ Session retrieval with invalid token
- ✅ Server error handling

**Run tests:**
```bash
npm test -- src/routes/auth.test.ts --run
```

---

## Implementation Details

### Files Created
- `/packages/backend/src/routes/auth.ts` - Authentication route handlers
- `/packages/backend/src/middleware/auth.ts` - Authentication middleware (reused existing)
- `/packages/backend/src/routes/auth.test.ts` - Comprehensive unit tests

### Files Modified
- `/packages/backend/src/index.ts` - Integrated authentication routes

### Dependencies Used
- `express` - Web framework
- `express-validator` - Request validation
- `jsonwebtoken` - JWT token generation and validation
- `bcrypt` - Password hashing
- `@prisma/client` - Database operations

### Requirements Validated
- ✅ **Requirement 1.1** - Grant access with valid credentials, deny with invalid
- ✅ **Requirement 1.2** - Deny access and display error for invalid credentials
- ✅ **Requirement 1.3** - Session timeout after 30 minutes of inactivity

---

## Next Steps

To complete the authentication system:
1. ✅ Authentication API endpoints (completed in this task)
2. ⏭️ Create user registration endpoint (future task)
3. ⏭️ Implement password reset functionality (future task)
4. ⏭️ Add rate limiting for login attempts (future task)
5. ⏭️ Implement refresh token mechanism (future task)
