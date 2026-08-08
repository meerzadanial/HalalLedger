/**
 * Authentication Service Usage Examples
 * 
 * This file demonstrates how to use the AuthenticationService
 * for common authentication workflows.
 */

import { getAuthenticationService } from './AuthenticationService';

/**
 * Example 1: User Registration
 */
export async function registerUser(email: string, password: string) {
  const authService = getAuthenticationService();
  
  try {
    const user = await authService.createUser(email, password);
    console.log('✅ User registered successfully:', user.email);
    return user;
  } catch (error) {
    if (error instanceof Error && error.message === 'User already exists') {
      console.error('❌ Registration failed: Email already registered');
    } else {
      console.error('❌ Registration failed:', error);
    }
    throw error;
  }
}

/**
 * Example 2: User Login
 */
export async function loginUser(email: string, password: string) {
  const authService = getAuthenticationService();
  
  try {
    const { token, expiresAt } = await authService.login(email, password);
    console.log('✅ Login successful');
    console.log('   Token expires at:', expiresAt);
    return { token, expiresAt };
  } catch (error) {
    if (error instanceof Error && error.message === 'Invalid credentials') {
      console.error('❌ Login failed: Invalid email or password');
    } else {
      console.error('❌ Login failed:', error);
    }
    throw error;
  }
}

/**
 * Example 3: Token Validation (Middleware Use Case)
 */
export async function validateUserToken(token: string) {
  const authService = getAuthenticationService();
  
  try {
    const { userId, email } = await authService.validateToken(token);
    console.log('✅ Token valid for user:', email);
    return { userId, email };
  } catch (error) {
    if (error instanceof Error) {
      if (error.message === 'Session expired' || error.message === 'Token expired') {
        console.error('❌ Token validation failed: Session expired');
      } else if (error.message === 'Session not found') {
        console.error('❌ Token validation failed: Session not found');
      } else if (error.message === 'Invalid token') {
        console.error('❌ Token validation failed: Invalid token');
      }
    }
    throw error;
  }
}

/**
 * Example 4: Token Refresh
 */
export async function refreshUserToken(currentToken: string) {
  const authService = getAuthenticationService();
  
  try {
    const { token: newToken, expiresAt } = await authService.refreshToken(currentToken);
    console.log('✅ Token refreshed successfully');
    console.log('   New token expires at:', expiresAt);
    return { token: newToken, expiresAt };
  } catch (error) {
    console.error('❌ Token refresh failed:', error);
    throw error;
  }
}

/**
 * Example 5: User Logout
 */
export async function logoutUser(token: string) {
  const authService = getAuthenticationService();
  
  try {
    await authService.logout(token);
    console.log('✅ Logout successful');
  } catch (error) {
    console.error('❌ Logout failed:', error);
    throw error;
  }
}

/**
 * Example 6: Check Active Sessions
 */
export async function checkActiveSessions(userId: string) {
  const authService = getAuthenticationService();
  
  try {
    const sessions = await authService.getActiveSessions(userId);
    console.log(`✅ User has ${sessions.length} active session(s)`);
    sessions.forEach((session, index) => {
      console.log(`   Session ${index + 1} expires at:`, session.expiresAt);
    });
    return sessions;
  } catch (error) {
    console.error('❌ Failed to get active sessions:', error);
    throw error;
  }
}

/**
 * Example 7: Logout All Sessions (Security Feature)
 */
export async function logoutAllUserSessions(userId: string) {
  const authService = getAuthenticationService();
  
  try {
    await authService.logoutAllSessions(userId);
    console.log('✅ All sessions logged out successfully');
  } catch (error) {
    console.error('❌ Failed to logout all sessions:', error);
    throw error;
  }
}

/**
 * Example 8: Complete Authentication Flow
 */
export async function completeAuthFlow() {
  const email = 'demo@example.com';
  const password = 'SecurePassword123!';
  
  try {
    // 1. Register
    console.log('\n📝 Step 1: Registering user...');
    const user = await registerUser(email, password);
    
    // 2. Login
    console.log('\n🔐 Step 2: Logging in...');
    const { token } = await loginUser(email, password);
    
    // 3. Validate token
    console.log('\n✓ Step 3: Validating token...');
    await validateUserToken(token);
    
    // 4. Check active sessions
    console.log('\n👥 Step 4: Checking active sessions...');
    await checkActiveSessions(user.id);
    
    // 5. Refresh token
    console.log('\n🔄 Step 5: Refreshing token...');
    const { token: newToken } = await refreshUserToken(token);
    
    // 6. Logout
    console.log('\n👋 Step 6: Logging out...');
    await logoutUser(newToken);
    
    console.log('\n✅ Complete authentication flow successful!');
  } catch (error) {
    console.error('\n❌ Authentication flow failed:', error);
  }
}

/**
 * Example 9: Password Hashing (Direct API)
 */
export async function hashPassword(password: string) {
  const authService = getAuthenticationService();
  
  try {
    const hash = await authService.hashPassword(password);
    console.log('✅ Password hashed successfully');
    return hash;
  } catch (error) {
    console.error('❌ Password hashing failed:', error);
    throw error;
  }
}

/**
 * Example 10: Password Verification (Direct API)
 */
export async function verifyPassword(password: string, hash: string) {
  const authService = getAuthenticationService();
  
  try {
    const isValid = await authService.verifyPassword(password, hash);
    if (isValid) {
      console.log('✅ Password is valid');
    } else {
      console.log('❌ Password is invalid');
    }
    return isValid;
  } catch (error) {
    console.error('❌ Password verification failed:', error);
    throw error;
  }
}

// Run the complete flow if this file is executed directly
if (require.main === module) {
  completeAuthFlow()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
