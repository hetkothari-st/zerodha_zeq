import React, { useState } from 'react';
import { Field, PrimaryButton, Notice, TextButton } from './ui';
import { toIndianE164, isOtp } from './core/validators';

// Two-step form: mobile number → 6-digit code. sendCode/verifyCode resolve to { error }.
export default function PhoneOtpForm({ sendCode, verifyCode, idPrefix = 'otp' }) {
    const [phoneInput, setPhoneInput] = useState('');
    const [phone, setPhone] = useState(null);
    const [code, setCode] = useState('');
    const [error, setError] = useState(null);
    const [busy, setBusy] = useState(false);

    async function onSend(e) {
        e.preventDefault();
        const e164 = toIndianE164(phoneInput);
        if (!e164) { setError('Enter a valid 10-digit Indian mobile number.'); return; }
        setBusy(true); setError(null);
        try {
            const r = await sendCode(e164);
            if (r.error) { setError(r.error); return; }
            setPhone(e164);
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
            <TextButton onClick={() => { setPhone(null); setCode(''); setError(null); }}>Change number</TextButton>
        </form>
    );
}
