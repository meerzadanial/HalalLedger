import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import ProtectedRoute from './ProtectedRoute';
import { AuthContext } from '../contexts/AuthContext';

// Mock useNavigate
const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    Navigate: ({ to }: { to: string }) => {
      mockNavigate(to);
      return <div data-testid="navigate">{to}</div>;
    },
  };
});

describe('ProtectedRoute', () => {
  const mockAuthValue = {
    user: null,
    isAuthenticated: false,
    isLoading: false,
    expiresAt: null,
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    checkSession: vi.fn(),
    extendSession: vi.fn(),
  };

  it('should show loading state when authentication is being checked', () => {
    const loadingAuthValue = {
      ...mockAuthValue,
      isLoading: true,
    };

    render(
      <BrowserRouter>
        <AuthContext.Provider value={loadingAuthValue}>
          <ProtectedRoute>
            <div>Protected Content</div>
          </ProtectedRoute>
        </AuthContext.Provider>
      </BrowserRouter>
    );

    expect(screen.getByText('Loading...')).toBeInTheDocument();
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
  });

  it('should redirect to login when user is not authenticated', () => {
    const unauthenticatedValue = {
      ...mockAuthValue,
      isAuthenticated: false,
      isLoading: false,
    };

    render(
      <BrowserRouter>
        <AuthContext.Provider value={unauthenticatedValue}>
          <ProtectedRoute>
            <div>Protected Content</div>
          </ProtectedRoute>
        </AuthContext.Provider>
      </BrowserRouter>
    );

    expect(screen.getByTestId('navigate')).toBeInTheDocument();
    expect(screen.getByTestId('navigate').textContent).toBe('/login');
    expect(screen.queryByText('Protected Content')).not.toBeInTheDocument();
  });

  it('should render protected content when user is authenticated', () => {
    const authenticatedValue = {
      ...mockAuthValue,
      user: { userId: 'user-123', email: 'test@example.com' },
      isAuthenticated: true,
      isLoading: false,
    };

    render(
      <BrowserRouter>
        <AuthContext.Provider value={authenticatedValue}>
          <ProtectedRoute>
            <div>Protected Content</div>
          </ProtectedRoute>
        </AuthContext.Provider>
      </BrowserRouter>
    );

    expect(screen.getByText('Protected Content')).toBeInTheDocument();
    expect(screen.queryByTestId('navigate')).not.toBeInTheDocument();
  });

  it('should render children components correctly', () => {
    const authenticatedValue = {
      ...mockAuthValue,
      user: { userId: 'user-123', email: 'test@example.com' },
      isAuthenticated: true,
      isLoading: false,
    };

    render(
      <BrowserRouter>
        <AuthContext.Provider value={authenticatedValue}>
          <ProtectedRoute>
            <div>
              <h1>Dashboard</h1>
              <p>Welcome to the dashboard</p>
            </div>
          </ProtectedRoute>
        </AuthContext.Provider>
      </BrowserRouter>
    );

    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Welcome to the dashboard')).toBeInTheDocument();
  });
});
