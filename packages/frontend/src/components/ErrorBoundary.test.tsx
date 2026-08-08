import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ErrorBoundary from './ErrorBoundary';

// Component that throws an error for testing
const ThrowError = ({ shouldThrow = true }: { shouldThrow?: boolean }) => {
  if (shouldThrow) {
    throw new Error('Test error message');
  }
  return <div>No error</div>;
};

// Suppress console.error during tests to avoid noisy output
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ErrorBoundary', () => {
  describe('Normal Operation', () => {
    it('should render children when no error occurs', () => {
      render(
        <ErrorBoundary>
          <div>Test content</div>
        </ErrorBoundary>
      );

      expect(screen.getByText('Test content')).toBeInTheDocument();
    });

    it('should render multiple children when no error occurs', () => {
      render(
        <ErrorBoundary>
          <div>Child 1</div>
          <div>Child 2</div>
        </ErrorBoundary>
      );

      expect(screen.getByText('Child 1')).toBeInTheDocument();
      expect(screen.getByText('Child 2')).toBeInTheDocument();
    });
  });

  describe('Error Handling', () => {
    it('should catch errors thrown by child components', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('should display user-friendly error message', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(
        screen.getByText(/We encountered an unexpected error/i)
      ).toBeInTheDocument();
    });

    it('should display error icon in fallback UI', () => {
      const { container } = render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      // Check for SVG icon
      const icon = container.querySelector('svg');
      expect(icon).toBeInTheDocument();
      expect(icon).toHaveClass('text-red-600');
    });

    it('should show error details in development mode', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Test error message')).toBeInTheDocument();

      process.env.NODE_ENV = originalEnv;
    });

    it('should hide error details in production mode', () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.queryByText('Test error message')).not.toBeInTheDocument();

      process.env.NODE_ENV = originalEnv;
    });

    it('should log error to console', () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Error Recovery', () => {
    it('should render "Try Again" button when error occurs', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Try Again')).toBeInTheDocument();
    });

    it('should render "Go to Home" button when error occurs', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Go to Home')).toBeInTheDocument();
    });

    it('should reset error state when "Try Again" is clicked', () => {
      // Test that clicking Try Again calls resetError and clears the error state
      let shouldThrow = true;
      
      const ConditionalError = () => {
        if (shouldThrow) {
          throw new Error('Test error');
        }
        return <div>Success</div>;
      };

      render(
        <ErrorBoundary>
          <ConditionalError />
        </ErrorBoundary>
      );

      // Error boundary should show fallback UI
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();

      // Stop throwing errors
      shouldThrow = false;

      // Click "Try Again" - this resets the error boundary internal state
      const tryAgainButton = screen.getByText('Try Again');
      fireEvent.click(tryAgainButton);

      // After reset, the component should try to render children again
      // Since shouldThrow is now false, it should render successfully
      expect(screen.getByText('Success')).toBeInTheDocument();
      expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
    });

    it('should navigate to home when "Go to Home" is clicked', () => {
      const originalLocation = window.location;
      delete (window as any).location;
      (window as any).location = { ...originalLocation, href: '' };

      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      const goHomeButton = screen.getByText('Go to Home');
      fireEvent.click(goHomeButton);

      expect(window.location.href).toBe('/');

      (window as any).location = originalLocation;
    });
  });

  describe('Custom Fallback', () => {
    it('should render custom fallback when provided', () => {
      const customFallback = (error: Error) => (
        <div>Custom error: {error.message}</div>
      );

      render(
        <ErrorBoundary fallback={customFallback}>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Custom error: Test error message')).toBeInTheDocument();
    });

    it('should call resetError callback in custom fallback', () => {
      let shouldError = true;
      
      const ToggleError = () => {
        if (shouldError) {
          throw new Error('Custom test error');
        }
        return <div>No error</div>;
      };

      const customFallback = (_error: Error, resetError: () => void) => (
        <div>
          <div>Custom error</div>
          <button onClick={resetError}>Reset</button>
        </div>
      );

      render(
        <ErrorBoundary fallback={customFallback}>
          <ToggleError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Custom error')).toBeInTheDocument();

      // Update to not throw
      shouldError = false;

      // Click custom reset button
      const resetButton = screen.getByText('Reset');
      fireEvent.click(resetButton);

      // After reset, should render without error
      expect(screen.getByText('No error')).toBeInTheDocument();
    });
  });

  describe('Edge Cases', () => {
    it('should handle errors with empty message', () => {
      const ThrowEmptyError = () => {
        throw new Error('');
      };

      render(
        <ErrorBoundary>
          <ThrowEmptyError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });

    it('should handle nested ErrorBoundaries', () => {
      const ThrowInNested = () => {
        throw new Error('Nested error');
      };

      render(
        <ErrorBoundary>
          <div>Outer content</div>
          <ErrorBoundary>
            <ThrowInNested />
          </ErrorBoundary>
        </ErrorBoundary>
      );

      // Inner ErrorBoundary should catch the error
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
      // Outer content should still be visible since inner ErrorBoundary caught it
      expect(screen.getByText('Outer content')).toBeInTheDocument();
    });

    it('should maintain error state across re-renders', () => {
      const { rerender } = render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      expect(screen.getByText('Something went wrong')).toBeInTheDocument();

      // Re-render without changing children
      rerender(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      // Error state should persist
      expect(screen.getByText('Something went wrong')).toBeInTheDocument();
    });
  });

  describe('Accessibility', () => {
    it('should have accessible button elements', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      const tryAgainButton = screen.getByRole('button', { name: /try again/i });
      const goHomeButton = screen.getByRole('button', { name: /go to home/i });

      expect(tryAgainButton).toBeInTheDocument();
      expect(goHomeButton).toBeInTheDocument();
    });

    it('should have proper focus management for buttons', () => {
      render(
        <ErrorBoundary>
          <ThrowError />
        </ErrorBoundary>
      );

      const tryAgainButton = screen.getByRole('button', { name: /try again/i });
      
      // Button should be focusable
      tryAgainButton.focus();
      expect(document.activeElement).toBe(tryAgainButton);
    });
  });
});
