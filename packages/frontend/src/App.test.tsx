import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import App from './App';

describe('App Component', () => {
  it('should render the application with routing', () => {
    render(<App />);
    // The app should render and redirect to /login which shows the login page
    const titleElement = screen.getByRole('heading', { name: 'Welcome' });
    expect(titleElement).toBeInTheDocument();
  });

  it('should render the HalalOrNot Income Tracker subtitle', () => {
    render(<App />);
    const subtitleElement = screen.getByText(/Please Login to Continue/i);
    expect(subtitleElement).toBeInTheDocument();
  });
});
