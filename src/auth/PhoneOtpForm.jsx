import React, { useEffect, useState } from 'react';
import { Field, PrimaryButton, Notice, TextButton } from './ui';
import { toIndianE164, isOtp } from './core/validators';

const RESEND_COOLDOWN_MS = 60000;

// Two-step form: mobile number → 6-digit code. sendCode/verifyCode resolve to { error }.
export default function PhoneOtpForm({ sendCode, verifyCode, idPrefix = 'otp' }) {
    const [phoneInput, setPhoneInput] = useState('');
    const [phone, setPhone] = useState(null);
    const [code, setCode] = useState('');
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);
    const [resendAt, setResendAt] = useState(0); // when "Resend code" becomes available (ms epoch)
    const [now, setNow] = useState(() => Date.now());

    useEffect(() => {
        if (!resendAt) return undefined;
        const id = setInterval(() => {
            const t = Date.now();
            setNow(t);
            if (t >= resendAt) clearInterval(id);
        }, 1000);
        return () => clearInterval(id);
    }, [resendAt]);

    const cooldown = resendAt ? Math.max(0, Math.ceil((resendAt - now) / 1000)) : 0;
    const startCooldown = () => { const t = Date.now(); setNow(t); setResendAt(t + RESEND_COOLDOWN_MS); };

    async function onSend(e) {
        e.preventDefault();
        const e164 = toIndianE164(phoneInput);
        if (!e164) { setError('Enter a valid 10-digit Indian mobile number.'); return; }
        setBusy(true); setError(null);
        try {
            const r = await sendCode(e164);
            if (r.error) { setError(r.error); return; }
            setPhone(e164);
            startCooldown();
        } catch {
            setError('Something went wrong. Please try again.');
        } finally {
            setBusy(false);
        }
    }

    async function onVerify(e) {
        e.preventDefault();
        if (!isOtp(code)) { setError('Enter the 6-digit code.'); return; }
        setBusy(true); setError(null);
        try {
            const r = await verifyCode(phone, code.trim());
            if (r.error) setError(r.error);
        } catch {
            setError('Something went wrong. Please try again.');
        } finally {
            setBusy(false);
        }
    }

    async function onResend() {
        if (busy || cooldown > 0) return;
        setBusy(true); setError(null);
        try {
            const r = await sendCode(phone);
            if (r.error) { setError(r.error); return; }
            startCooldown();
        } catch {
            setError('Something went wrong. Please try again.');
        } finally {
            setBusy(false);
        }
    }

    if (!phone) {
        return (
            <form onSubmit={onSend} className="flex flex-col gap-3" noValidate>
                <Field id={`${idPrefix}-phone`} label="Mobile number" inputMode="tel" autoComplete="tel-national"
                    placeholder="98765 43210" value={phoneInput} onChange={(e) => setPhoneInput(e.target.value)} />
                <Notice>{error}</Notice>
                <PrimaryButton busy={busy}>Send code</PrimaryButton>
            </form>
        );
    }
    return (
        <form onSubmit={onVerify} className="flex flex-col gap-3" noValidate>
            <Notice kind="info">We sent a code to {phone}.</Notice>
            <Field id={`${idPrefix}-code`} label="6-digit code" inputMode="numeric" autoComplete="one-time-code"
                maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            <Notice>{error}</Notice>
            <PrimaryButton busy={busy}>Verify</PrimaryButton>
            <TextButton onClick={onResend} disabled={busy || cooldown > 0}>
                {cooldown > 0 ? `Resend code in ${cooldown}s` : 'Resend code'}
            </TextButton>
            <TextButton onClick={() => { setPhone(null); setCode(''); setError(null); setResendAt(0); }}>Change number</TextButton>
        </form>
    );
}
