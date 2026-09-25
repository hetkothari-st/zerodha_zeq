import { test, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('./auth/AuthGate', () => ({ AuthGate: ({ children }) => <div data-testid="gate">{children}</div> }));
vi.mock('./admin/AdminPage', () => ({ default: () => <p>admin page</p> }));
const { default: Root } = await import('./Root');

test('/admin renders the admin page inside the gate', () => {
    window.history.replaceState(null, '', '/admin');
    render(<Root App={() => <p>trading app</p>} />);
    expect(screen.getByTestId('gate')).toHaveTextContent('admin page');
});

test('any other path renders the app inside the gate', () => {
    window.history.replaceState(null, '', '/');
    render(<Root App={() => <p>trading app</p>} />);
    expect(screen.getByTestId('gate')).toHaveTextContent('trading app');
});
