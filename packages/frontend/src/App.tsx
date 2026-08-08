import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import ErrorBoundary from './components/ErrorBoundary';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import EntryPage from './pages/EntryPage';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});

/**
 * App - Main application component with routing and authentication
 * 
 * Routes:
 * - /login - User authentication
 * - /dashboard - Main dashboard (protected with authentication)
 * - /entry - New delivery entry workflow (protected with authentication)
 * - / - Redirects to login
 * 
 * Features:
 * - AuthProvider wraps entire app for global authentication state
 * - ProtectedRoute guards dashboard and entry pages from unauthenticated access
 * - Session persistence and token validation on mount
 * 
 * Validates Requirements: 1.1, 1.3, 10.1, 10.2, 10.3
 */
function App() {
  // Matches the Vite `base` config so routing works when hosted under a
  // GitHub Pages subpath (e.g. https://<user>.github.io/<repo>/).
  const basename = import.meta.env.BASE_URL.replace(/\/$/, '');

  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <BrowserRouter basename={basename}>
          <ErrorBoundary>
            <Toaster />
            <Routes>
              <Route path="/login" element={<LoginPage />} />
              <Route
                path="/dashboard"
                element={
                  <ProtectedRoute>
                    <DashboardPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/entry"
                element={
                  <ProtectedRoute>
                    <EntryPage />
                  </ProtectedRoute>
                }
              />
              <Route
                path="/entry/:id"
                element={
                  <ProtectedRoute>
                    <EntryPage />
                  </ProtectedRoute>
                }
              />
              <Route path="/" element={<Navigate to="/login" replace />} />
            </Routes>
          </ErrorBoundary>
        </BrowserRouter>
      </AuthProvider>
    </QueryClientProvider>
  );
}

export default App;
