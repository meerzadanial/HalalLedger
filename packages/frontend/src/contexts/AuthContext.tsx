import { createContext, useState, useEffect, ReactNode } from 'react';
import { authApi } from '../services/api';
import { SessionExpirationWarning } from '../components/SessionExpirationWarning';

/**
 * AuthContext - Authentication state management
 * 
 * Features:
 * - User authentication state (isAuthenticated, user info)
 * - Login/logout functions
 * - Loading states during authentication
 * - Token persistence and validation on mount
 * - Session expiration handling with 5-minute warning
 * - Automatic redirect to login on session expiry
 * - Form state preservation in localStorage
 * 
 * Validates Requirements: 1.1, 1.2, 1.3
 */

interface User {
  userId: string;
  email: string;
}

export interface AuthContextValue {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  expiresAt: Date | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  checkSession: () => Promise<void>;
  extendSession: () => Promise<void>;
}

export const AuthContext = createContext<AuthContextValue | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [expiresAt, setExpiresAt] = useState<Date | null>(null);

  // Check if user has a valid session on mount
  useEffect(() => {
    checkSession();
  }, []);

  const checkSession = async () => {
    setIsLoading(true);
    
    try {
      const token = localStorage.getItem('authToken');
      
      if (!token) {
        setUser(null);
        setExpiresAt(null);
        setIsLoading(false);
        return;
      }

      // Validate token with backend
      const sessionData = await authApi.getSession();
      
      setUser({
        userId: sessionData.userId,
        email: sessionData.email,
      });
      setExpiresAt(new Date(sessionData.expiresAt));
    } catch (error) {
      // Token is invalid or expired
      console.error('Session validation failed:', error);
      localStorage.removeItem('authToken');
      setUser(null);
      setExpiresAt(null);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (email: string, password: string) => {
    setIsLoading(true);
    
    try {
      // authApi.login already stores the token in localStorage
      await authApi.login(email, password);

      // Fetch user session data after successful login
      const sessionData = await authApi.getSession();
      
      setUser({
        userId: sessionData.userId,
        email: sessionData.email,
      });
      setExpiresAt(new Date(sessionData.expiresAt));
    } catch (error) {
      // Clear any stale data
      localStorage.removeItem('authToken');
      setUser(null);
      setExpiresAt(null);
      throw error; // Re-throw for component to handle
    } finally {
      setIsLoading(false);
    }
  };

  const register = async (email: string, password: string) => {
    setIsLoading(true);

    try {
      // Create the account
      await authApi.register(email, password);

      // Log in immediately after successful registration
      await login(email, password);
    } catch (error) {
      throw error; // Re-throw for component to handle
    } finally {
      setIsLoading(false);
    }
  };

  const logout = async () => {
    setIsLoading(true);
    
    try {
      await authApi.logout();
    } catch (error) {
      console.error('Logout error:', error);
      // Continue with local logout even if API call fails
    } finally {
      // Clear local state regardless of API call success
      localStorage.removeItem('authToken');
      setUser(null);
      setExpiresAt(null);
      setIsLoading(false);
    }
  };

  const extendSession = async () => {
    // Re-check session to extend it
    await checkSession();
  };

  const value: AuthContextValue = {
    user,
    isAuthenticated: !!user,
    isLoading,
    expiresAt,
    login,
    register,
    logout,
    checkSession,
    extendSession,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
      <SessionExpirationWarning
        expiresAt={expiresAt}
        onExtendSession={extendSession}
        onLogout={logout}
      />
    </AuthContext.Provider>
  );
}
