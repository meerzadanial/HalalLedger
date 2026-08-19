import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import ProtectedRoute from '../components/ProtectedRoute';
import LoginPage from '../pages/LoginPage';
import { AuthProvider } from './AuthContext';
import { authApi } from '../services/api';

vi.mock('../services/api', () => ({
  authApi: { login: vi.fn(), logout: vi.fn(), getSession: vi.fn(), register: vi.fn() },
}));

const deferred = <T,>() => {
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((_resolve, rejectPromise) => { reject = rejectPromise; });
  return { promise, reject };
};

describe('AuthContext login race regression', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
  });

  it('keeps a successful standalone login when stale startup validation fails', async () => {
    localStorage.setItem('authToken', 'stale-token');
    const startupSession = deferred<never>();
    vi.mocked(authApi.getSession)
      .mockImplementationOnce(() => startupSession.promise)
      .mockResolvedValueOnce({ userId: 'user-1', email: 'driver@example.com', expiresAt: '2099-01-01T00:00:00.000Z' });
    vi.mocked(authApi.login).mockImplementation(async () => {
      localStorage.setItem('authToken', 'fresh-token');
      return { token: 'fresh-token', expiresAt: '2099-01-01T00:00:00.000Z' };
    });

    render(<AuthProvider><MemoryRouter initialEntries={['/login']}><Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/dashboard" element={<ProtectedRoute><div>Authenticated dashboard</div></ProtectedRoute>} />
    </Routes></MemoryRouter></AuthProvider>);
    await waitFor(() => expect(authApi.getSession).toHaveBeenCalledTimes(1));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Email address'), 'driver@example.com');
    await user.type(screen.getByLabelText('Password'), 'password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByText('Authenticated dashboard')).toBeInTheDocument();

    await act(async () => { startupSession.reject(new Error('Invalid token')); });
    await waitFor(() => expect(localStorage.getItem('authToken')).toBe('fresh-token'));
    expect(screen.getByText('Authenticated dashboard')).toBeInTheDocument();
  });
});