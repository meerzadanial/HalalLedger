import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, AuthContext } from './AuthContext';
import { useContext } from 'react';
import * as apiModule from '../services/api';

// Mock the API module
vi.mock('../services/api', () => ({
  authApi: {
    login: vi.fn(),
    logout: vi.fn(),
    getSession: vi.fn(),
  },
}));

// Test component that uses AuthContext
function TestConsumer() {
  const auth = useContext(AuthContext);
  
  if (!auth) {
    return <div>No context</div>;
  }

  return (
    <div>
      <div data-testid="isAuthenticated">{auth.isAuthenticated.toString()}</div>
      <div data-testid="isLoading">{auth.isLoading.toString()}</div>
      <div data-testid="user">{auth.user ? auth.user.email : 'null'}</div>
      <button onClick={() => auth.login('test@example.com', 'password')}>
        Login
      </button>
      <button onClick={() => auth.logout()}>Logout</button>
    </div>
  );
}

describe('AuthContext', () => {
  beforeEach(() => {
    // Clear localStorage before each test
    localStorage.clear();
    vi.clearAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('should provide auth context values', () => {
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    expect(screen.getByTestId('isAuthenticated')).toBeInTheDocument();
    expect(screen.getByTestId('isLoading')).toBeInTheDocument();
    expect(screen.getByTestId('user')).toBeInTheDocument();
  });

  it('should initialize with no user when no token in localStorage', async () => {
    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('isAuthenticated').textContent).toBe('false');
      expect(screen.getByTestId('user').textContent).toBe('null');
    });
  });

  it('should validate token on mount if token exists', async () => {
    localStorage.setItem('authToken', 'valid-token');
    
    const mockSession = {
      userId: 'user-123',
      email: 'test@example.com',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };

    vi.mocked(apiModule.authApi.getSession).mockResolvedValue(mockSession);

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('isAuthenticated').textContent).toBe('true');
      expect(screen.getByTestId('user').textContent).toBe('test@example.com');
    });

    expect(apiModule.authApi.getSession).toHaveBeenCalledTimes(1);
  });

  it('should clear token if session validation fails', async () => {
    localStorage.setItem('authToken', 'invalid-token');
    
    vi.mocked(apiModule.authApi.getSession).mockRejectedValue(new Error('Invalid token'));

    render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('isAuthenticated').textContent).toBe('false');
      expect(localStorage.getItem('authToken')).toBeNull();
    });
  });

  it('should handle login successfully', async () => {
    const mockAuthResponse = {
      token: 'new-token',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };

    const mockSession = {
      userId: 'user-123',
      email: 'test@example.com',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };

    vi.mocked(apiModule.authApi.login).mockResolvedValue(mockAuthResponse);
    vi.mocked(apiModule.authApi.getSession).mockResolvedValue(mockSession);

    const { getByText } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('isLoading').textContent).toBe('false');
    });

    const loginButton = getByText('Login');
    loginButton.click();

    await waitFor(() => {
      expect(screen.getByTestId('isAuthenticated').textContent).toBe('true');
      expect(screen.getByTestId('user').textContent).toBe('test@example.com');
    });

    expect(apiModule.authApi.login).toHaveBeenCalledWith('test@example.com', 'password');
    expect(apiModule.authApi.getSession).toHaveBeenCalled();
  });

  it('should handle logout successfully', async () => {
    // Set up authenticated state
    localStorage.setItem('authToken', 'valid-token');
    
    const mockSession = {
      userId: 'user-123',
      email: 'test@example.com',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };

    vi.mocked(apiModule.authApi.getSession).mockResolvedValue(mockSession);
    vi.mocked(apiModule.authApi.logout).mockResolvedValue();

    const { getByText } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    // Wait for initial authentication
    await waitFor(() => {
      expect(screen.getByTestId('isAuthenticated').textContent).toBe('true');
    });

    const logoutButton = getByText('Logout');
    logoutButton.click();

    await waitFor(() => {
      expect(screen.getByTestId('isAuthenticated').textContent).toBe('false');
      expect(screen.getByTestId('user').textContent).toBe('null');
      expect(localStorage.getItem('authToken')).toBeNull();
    });

    expect(apiModule.authApi.logout).toHaveBeenCalledTimes(1);
  });

  it('should clear local state even if logout API call fails', async () => {
    // Set up authenticated state
    localStorage.setItem('authToken', 'valid-token');
    
    const mockSession = {
      userId: 'user-123',
      email: 'test@example.com',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    };

    vi.mocked(apiModule.authApi.getSession).mockResolvedValue(mockSession);
    vi.mocked(apiModule.authApi.logout).mockRejectedValue(new Error('Network error'));

    const { getByText } = render(
      <AuthProvider>
        <TestConsumer />
      </AuthProvider>
    );

    // Wait for initial authentication
    await waitFor(() => {
      expect(screen.getByTestId('isAuthenticated').textContent).toBe('true');
    });

    const logoutButton = getByText('Logout');
    logoutButton.click();

    await waitFor(() => {
      expect(screen.getByTestId('isAuthenticated').textContent).toBe('false');
      expect(localStorage.getItem('authToken')).toBeNull();
    });
  });
});
