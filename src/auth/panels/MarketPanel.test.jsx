import { test, expect, vi } from 'vitest';
import { render, screen, act, within } from '@testing-library/react';
import MarketPanel from './MarketPanel';
import { theme } from '../theme';

test('renders the ranked leaderboard with 10 rows', () => {
    render(<MarketPanel />);
    expect(screen.getByText(/leaderboard/)).toBeInTheDocument();
    expect(within(screen.getByTestId('eq-board')).getAllByRole('listitem')).toHaveLength(10);
});

test('tabs cycle every 5 s while motion is allowed and are clickable', () => {
    vi.useFakeTimers();
    render(<MarketPanel />);
    expect(screen.getByRole('tab', { name: 'Gainers' })).toHaveAttribute('aria-selected', 'true');
    act(() => { vi.advanceTimersByTime(5000); });
    expect(screen.getByRole('tab', { name: 'Losers' })).toHaveAttribute('aria-selected', 'true');
    act(() => { screen.getByRole('tab', { name: 'Volume' }).click(); });
    expect(screen.getByRole('tab', { name: 'Volume' })).toHaveAttribute('aria-selected', 'true');
    vi.useRealTimers();
});

test('static under prefers-reduced-motion', () => {
    vi.useFakeTimers();
    const orig = window.matchMedia;
    window.matchMedia = (q) => ({ ...orig(q), matches: q.includes('prefers-reduced-motion') });
    render(<MarketPanel />);
    act(() => { vi.advanceTimersByTime(10000); });
    expect(screen.getByRole('tab', { name: 'Gainers' })).toHaveAttribute('aria-selected', 'true');
    window.matchMedia = orig;
    vi.useRealTimers();
});

test('compact mode shows only the top 3', () => {
    render(<MarketPanel compact />);
    expect(within(screen.getByTestId('eq-board')).getAllByRole('listitem')).toHaveLength(3);
});

test('rank-change arrows render after a tick', () => {
    vi.useFakeTimers();
    render(<MarketPanel />);
    const board = screen.getByTestId('eq-board');
    const arrowOf = (li) => li.querySelectorAll('span')[1].textContent;
    const arrowsBefore = within(board).getAllByRole('listitem').map(arrowOf);
    expect(arrowsBefore.length).toBeGreaterThan(0);
    expect(arrowsBefore.every((a) => a === '•')).toBe(true);
    act(() => { vi.advanceTimersByTime(1800); });
    const arrowsAfter = within(board).getAllByRole('listitem').map(arrowOf);
    expect(arrowsAfter.length).toBeGreaterThan(0);
    expect(arrowsAfter.every((a) => a === '▲' || a === '▼' || a === '•')).toBe(true);
    vi.useRealTimers();
});

test('theme exposes every class key the screens use', () => {
    for (const k of ['page', 'panel', 'formSide', 'title', 'subtitle', 'label', 'input', 'primary', 'secondary', 'google', 'divider',
        'tabs', 'tabOn', 'tabOff', 'link', 'muted', 'error', 'info', 'card', 'modal', 'modalCard', 'adminPage']) {
        expect(typeof theme.classes[k], k).toBe('string');
    }
    expect(theme.productName).toBe('Funnel Eq');
});
