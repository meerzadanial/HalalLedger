import { createContext, useCallback, useEffect, useRef, useState, ReactNode } from 'react';
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
  // Every auth operation owns a monotonically increasing id. A response may
  // update auth state only while it still owns the latest id. This prevents a
  // suspended startup validation (common when an iOS standalone app resumes)
  // from clearing a token written by a later successful login.
  const authOperationId = useRef(0);
  const beginAuthOperation = useCallback(() => ++authOperationId.current, []);
  const isCurrentOperation = useCallback(
    (operationId: number) => authOperationId.current === operationId,
    [],
  );

  const checkSession = useCallback(async () => {
    const operationId = beginAuthOperation();
    const token = localStorage.getItem('authToken');
    setIsLoading(true);

    if (!token) {
      if (isCurrentOperation(operationId)) {
        setUser(null);
        setExpiresAt(null);
        setIsLoading(false);
      }
      return;
    }

    try {
      const sessionData = await authApi.getSession();

      // The request was made for `token`. Ignore it if login/logout replaced
      // that token or another auth operation started while it was in flight.
      if (
        !isCurrentOperation(operationId) ||
        localStorage.getItem('authToken') !== token
      ) {
        return;
      }

      setUser({
        userId: sessionData.userId,
        email: sessionData.email,
      });
      setExpiresAt(new Date(sessionData.expiresAt));
    } catch (error) {
      if (!isCurrentOperation(operationId)) return;

      console.error('Session validation failed:', error);
      // Never let validation for an older token remove a newer login token.
      if (localStorage.getItem('authToken') === token) {
        localStorage.removeItem('authToken');
      }
      setUser(null);
      setExpiresAt(null);
    } finally {
      if (isCurrentOperation(operationId)) {
        setIsLoading(false);
      }
    }
  }, [beginAuthOperation, isCurrentOperation]);

  // Check if the user has a valid session on mount. StrictMode may start this
  // effect twice in development; operation ownership makes that safe as well.
  useEffect(() => {
    void checkSession();
  }, [checkSession]);

  const login = async (email: string, password: string) => {
    const operationId = beginAuthOperation();
    setIsLoading(true);

    try {
      // authApi.login persists the token before getSession reads it.
      await authApi.login(email, password);
      const sessionData = await authApi.getSession();

      if (!isCurrentOperation(operationId)) return;

      setUser({
        userId: sessionData.userId,
        email: sessionData.email,
      });
      setExpiresAt(new Date(sessionData.expiresAt));
    } catch (error) {
      if (!isCurrentOperation(operationId)) return;

      localStorage.removeItem('authToken');
      setUser(null);
      setExpiresAt(null);
      throw error;
    } finally {
      if (isCurrentOperation(operationId)) {
        setIsLoading(false);
      }
    }
  };

  const register = async (email: string, password: string) => {
    const operationId = beginAuthOperation();
    setIsLoading(true);

    try {
      await authApi.register(email, password);
    } catch (error) {
      if (isCurrentOperation(operationId)) {
        setIsLoading(false);
        throw error;
      }
      return;
    }

    if (!isCurrentOperation(operationId)) return;
    // login owns the next operation and propagates any authentication failure.
    await login(email, password);
  };

  const logout = async () => {
    const operationId = beginAuthOperation();
    setIsLoading(true);

    try {
      await authApi.logout();
    } catch (error) {
      if (isCurrentOperation(operationId)) {
        console.error('Logout error:', error);
      }
    } finally {
      if (isCurrentOperation(operationId)) {
        localStorage.removeItem('authToken');
        setUser(null);
        setExpiresAt(null);
        setIsLoading(false);
      }
    }
  };

  const extendSession = async () => {
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
