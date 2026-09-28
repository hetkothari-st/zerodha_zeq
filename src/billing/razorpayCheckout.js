const SRC = 'https://checkout.razorpay.com/v1/checkout.js';
let loading = null;

// Loads Razorpay Checkout.js once; a failed load can be retried.
export function loadCheckout() {
    if (window.Razorpay) return Promise.resolve(window.Razorpay);
    if (!loading) {
        loading = new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = SRC;
            s.async = true;
            s.onload = () => { if (window.Razorpay) return resolve(window.Razorpay); loading = null; reject(new Error('Razorpay failed to load')); };
            s.onerror = () => { loading = null; reject(new Error('Razorpay failed to load')); };
            document.head.appendChild(s);
        });
    }
    return loading;
}

export function __resetCheckoutForTests() { loading = null; }

// Opens Checkout for a subscription. Failed attempts keep the Razorpay modal open for a
// retry, so we only settle on success or when the user closes it.
export function openCheckout(Razorpay, { keyId, subscriptionId, name, description, prefill, color }) {
    return new Promise((resolve) => {
        let lastError = null;
        const rz = new Razorpay({
            key: keyId,
            subscription_id: subscriptionId,
            name,
            description,
            prefill,
            theme: { color },
            handler: () => resolve({ outcome: 'paid' }),
            modal: { ondismiss: () => resolve(lastError ? { outcome: 'dismissed', reason: lastError } : { outcome: 'dismissed' }) },
        });
        rz.on('payment.failed', (r) => { lastError = r?.error?.description || 'Payment failed.'; });
        rz.open();
    });
}
