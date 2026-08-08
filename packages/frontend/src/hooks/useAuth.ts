import { useContext } from 'react';
import { AuthContext } from '../contexts/AuthContext';

/**
 * useAuth - Custom hook for consuming authentication context
 * 
 * Provides easy access to authentication state and functions
 * 
 * Usage:
 * ```
 * const { user, isAuthenticated, login, logout } = useAuth();
 * ```
 * 
 * Validates Requirements: 1.1, 1.2, 1.3
 */
export function useAuth() {
  const context = useContext(AuthContext);
  
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  
  return context;
}
