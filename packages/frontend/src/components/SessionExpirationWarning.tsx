import { useEffect, useState } from 'react';

/**
 * SessionExpirationWarning - Modal warning for impending session expiration
 * 
 * Features:
 * - Shows warning 5 minutes before session expires
 * - Displays countdown timer
 * - Allows user to extend session or logout
 * - Auto-redirects to login on expiration
 * 
 * Validates Requirements: 1.3
 */

interface SessionExpirationWarningProps {
  expiresAt: Date | null;
  onExtendSession: () => Promise<void>;
  onLogout: () => Promise<void>;
}

export function SessionExpirationWarning({
  expiresAt,
  onExtendSession,
  onLogout,
}: SessionExpirationWarningProps) {
  const [showWarning, setShowWarning] = useState(false);
  const [timeRemaining, setTimeRemaining] = useState(0);
  const [isExtending, setIsExtending] = useState(false);

  useEffect(() => {
    if (!expiresAt) {
      setShowWarning(false);
      return;
    }

    const updateTimer = () => {
      const now = new Date().getTime();
      const expiryTime = new Date(expiresAt).getTime();
      const remainingMs = expiryTime - now;
      const remainingSeconds = Math.floor(remainingMs / 1000);

      setTimeRemaining(remainingSeconds);

      // Show warning 5 minutes (300 seconds) before expiration
      if (remainingSeconds <= 300 && remainingSeconds > 0) {
        setShowWarning(true);
      } else if (remainingSeconds <= 0) {
        setShowWarning(false);
        // Session has expired - logout will be handled by the auth context
      } else {
        setShowWarning(false);
      }
    };

    // Update immediately
    updateTimer();

    // Update every second
    const interval = setInterval(updateTimer, 1000);

    return () => clearInterval(interval);
  }, [expiresAt]);

  const handleExtendSession = async () => {
    setIsExtending(true);
    try {
      await onExtendSession();
      setShowWarning(false);
    } catch (error) {
      console.error('Failed to extend session:', error);
      // Error will be handled by the parent component
    } finally {
      setIsExtending(false);
    }
  };

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  if (!showWarning) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50">
      <div className="bg-white rounded-lg shadow-xl p-6 max-w-md w-full mx-4">
        <div className="flex items-center mb-4">
          <div className="bg-yellow-100 rounded-full p-3 mr-4">
            <svg
              className="w-6 h-6 text-yellow-600"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900">
              Session Expiring Soon
            </h3>
            <p className="text-sm text-gray-600">
              Your session will expire in {formatTime(timeRemaining)}
            </p>
          </div>
        </div>

        <p className="text-gray-700 mb-6">
          Would you like to extend your session? Any unsaved work will be preserved.
        </p>

        <div className="flex gap-3">
          <button
            onClick={handleExtendSession}
            disabled={isExtending}
            className="flex-1 bg-blue-600 text-white py-2 px-4 rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed transition-colors"
          >
            {isExtending ? 'Extending...' : 'Extend Session'}
          </button>
          <button
            onClick={onLogout}
            disabled={isExtending}
            className="flex-1 bg-gray-200 text-gray-800 py-2 px-4 rounded-lg hover:bg-gray-300 disabled:bg-gray-100 disabled:cursor-not-allowed transition-colors"
          >
            Logout
          </button>
        </div>
      </div>
    </div>
  );
}
