import { describe, it, expect, vi, afterEach } from 'vitest';
import { loadCheckout, openCheckout, __resetCheckoutForTests } from './razorpayCheckout';

afterEach(() => { delete window.Razorpay; __resetCheckoutForTests(); document.head.innerHTML = ''; });

describe('loadCheckout', () => {
    it('resolves immediately when Razorpay is already loaded', async () => {
        window.Razorpay = function R() {};
        await expect(loadCheckout()).resolves.toBe(window.Razorpay);
        expect(document.head.querySelector('script')).toBeNull();
    });
    it('injects the script once and resolves on load', async () => {
        const p1 = loadCheckout();
        const p2 = loadCheckout();
        const scripts = document.head.querySelectorAll('script[src="https://checkout.razorpay.com/v1/checkout.js"]');
        expect(scripts).toHaveLength(1);
        window.Razorpay = function R() {};
        scripts[0].onload();
        await expect(p1).resolves.toBe(window.Razorpay);
        await expect(p2).resolves.toBe(window.Razorpay);
    });
    it('rejects on error and allows a retry', async () => {
        const p = loadCheckout();
        document.head.querySelector('script').onerror();
        await expect(p).rejects.toThrow('failed to load');
        loadCheckout();
        expect(document.head.querySelectorAll('script')).toHaveLength(2);
    });
    it('onload without Razorpay rejects and allows a retry', async () => {
        const p = loadCheckout();
        document.head.querySelector('script').onload();
        await expect(p).rejects.toThrow('failed to load');
        loadCheckout();
        expect(document.head.querySelectorAll('script')).toHaveLength(2);
    });
});

describe('openCheckout', () => {
    function fakeRazorpay() {
        const inst = { handlers: {}, opened: false, on(ev, fn) { this.handlers[ev] = fn; }, open() { this.opened = true; } };
        const Ctor = vi.fn(function (opts) { inst.opts = opts; return inst; });
        return { Ctor, inst };
    }
    it('passes subscription options and resolves paid on handler', async () => {
        const { Ctor, inst } = fakeRazorpay();
        const p = openCheckout(Ctor, { keyId: 'k', subscriptionId: 'sub_1', name: 'Funnel Op', description: 'Pro', prefill: { email: 'a@b.c' }, color: '#38bdf8' });
        expect(inst.opened).toBe(true);
        expect(inst.opts).toMatchObject({ key: 'k', subscription_id: 'sub_1', name: 'Funnel Op', prefill: { email: 'a@b.c' }, theme: { color: '#38bdf8' } });
        inst.opts.handler({ razorpay_payment_id: 'pay_1' });
        await expect(p).resolves.toEqual({ outcome: 'paid' });
    });
    it('a failed attempt followed by dismiss resolves dismissed with the reason', async () => {
        const { Ctor, inst } = fakeRazorpay();
        const p = openCheckout(Ctor, { keyId: 'k', subscriptionId: 'sub_1' });
        inst.handlers['payment.failed']({ error: { description: 'UPI mandate declined' } });
        inst.opts.modal.ondismiss();
        await expect(p).resolves.toEqual({ outcome: 'dismissed', reason: 'UPI mandate declined' });
    });
    it('a failed attempt then a successful retry resolves paid', async () => {
        const { Ctor, inst } = fakeRazorpay();
        const p = openCheckout(Ctor, { keyId: 'k', subscriptionId: 'sub_1' });
        inst.handlers['payment.failed']({ error: { description: 'declined' } });
        inst.opts.handler({});
        await expect(p).resolves.toEqual({ outcome: 'paid' });
    });
});
