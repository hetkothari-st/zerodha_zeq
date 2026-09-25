import { test, expect } from 'vitest';
import { hubUrlWithToken, reconnectPolicy, HUB_CLOSE, nextRetryDelay } from './hubUrl';

test('hubUrlWithToken appends an encoded token', () => {
    expect(hubUrlWithToken('wss://hub.example', 'a.b+c')).toBe('wss://hub.example?token=a.b%2Bc');
    expect(hubUrlWithToken('wss://hub.example/?x=1', 't')).toBe('wss://hub.example/?x=1&token=t');
});
test('reconnectPolicy', () => {
    expect(reconnectPolicy(HUB_CLOSE.signedInElsewhere)).toBe('displaced');
    expect(reconnectPolicy(HUB_CLOSE.notApproved)).toBe('stop');
    expect(reconnectPolicy(HUB_CLOSE.unauthenticated)).toBe('retry');
    expect(reconnectPolicy(1006)).toBe('retry');
});
test('nextRetryDelay backs off exponentially with a 60s cap', () => {
    expect(nextRetryDelay(0)).toBe(3000);
    expect(nextRetryDelay(1)).toBe(6000);
    expect(nextRetryDelay(5)).toBe(60000);
    expect(nextRetryDelay(10)).toBe(60000);
});
