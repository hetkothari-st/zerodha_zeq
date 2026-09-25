import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

vi.mock('./theme', () => ({
    theme: { productName: 'Funnel Test', tagline: 't', Wordmark: () => <span>WM</span>, classes: new Proxy({}, { get: () => '' }) },
}));
const { default: PhoneOtpForm } = await import('./PhoneOtpForm');

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

async function reachCodeStep(sendCode) {
    render(<PhoneOtpForm sendCode={sendCode} verifyCode={vi.fn(async () => ({ error: null }))} />);
    fireEvent.change(screen.getByLabelText('Mobile number'), { target: { value: '9876543210' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Send code' })); });
}

test('code step: Resend code is disabled with a countdown for 60 s, then resends', async () => {
    const sendCode = vi.fn(async () => ({ error: null }));
    await reachCodeStep(sendCode);
    expect(sendCode).toHaveBeenCalledTimes(1);
    const resend = screen.getByRole('button', { name: 'Resend code in 60s' });
    expect(resend).toBeDisabled();

    await act(async () => { vi.advanceTimersByTime(15000); });
    expect(screen.getByRole('button', { name: 'Resend code in 45s' })).toBeDisabled();

    await act(async () => { vi.advanceTimersByTime(45000); });
    const ready = screen.getByRole('button', { name: 'Resend code' });
    expect(ready).not.toBeDisabled();

    await act(async () => { fireEvent.click(ready); });
    expect(sendCode).toHaveBeenCalledTimes(2);
    expect(sendCode).toHaveBeenLastCalledWith('+919876543210');
    // Cooldown restarts after each send.
    expect(screen.getByRole('button', { name: 'Resend code in 60s' })).toBeDisabled();
});

test('a failed resend shows the error and keeps Resend available', async () => {
    const sendCode = vi.fn(async () => ({ error: null }));
    await reachCodeStep(sendCode);
    await act(async () => { vi.advanceTimersByTime(60000); });
    sendCode.mockResolvedValueOnce({ error: 'Too many codes sent. Please wait a minute and try again.' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Resend code' })); });
    expect(screen.getByRole('alert')).toHaveTextContent('Too many codes sent.');
    expect(screen.getByRole('button', { name: 'Resend code' })).not.toBeDisabled();
});
