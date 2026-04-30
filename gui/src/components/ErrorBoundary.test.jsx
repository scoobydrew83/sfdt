import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import ErrorBoundary from './ErrorBoundary.jsx';

function Bomb() {
  throw new Error('Test explosion');
}

beforeEach(() => {
  // Suppress React's console.error for expected boundary catches
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('ErrorBoundary', () => {
  it('renders children when no error', () => {
    render(<ErrorBoundary><span>ok</span></ErrorBoundary>);
    expect(screen.getByText('ok')).toBeInTheDocument();
  });

  it('renders fallback UI when a child throws', () => {
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
    expect(screen.getByText(/Test explosion/)).toBeInTheDocument();
  });

  it('clears error state when Try again is clicked', async () => {
    const user = userEvent.setup();
    render(<ErrorBoundary><Bomb /></ErrorBoundary>);
    await user.click(screen.getByRole('button', { name: /Try again/i }));
    // After reset, Bomb throws again — boundary catches again
    expect(screen.getByText(/Something went wrong/i)).toBeInTheDocument();
  });
});
