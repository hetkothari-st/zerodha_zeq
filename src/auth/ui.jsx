import React from 'react';
import { theme } from './theme';

const c = theme.classes;

export function Title({ title, subtitle }) {
    return (
        <div className="flex flex-col gap-2">
            <h1 className={c.title}>{title}</h1>
            {subtitle && <p className={c.subtitle}>{subtitle}</p>}
        </div>
    );
}

export function Field({ label, id, ...props }) {
    return (
        <label htmlFor={id} className="flex flex-col gap-1.5">
            <span className={c.label}>{label}</span>
            <input id={id} className={c.input} {...props} />
        </label>
    );
}

export function PrimaryButton({ children, busy = false, disabled = false, type = 'submit', ...props }) {
    return (
        <button {...props} type={type} className={c.primary} disabled={busy || disabled}>
            {busy ? 'Please wait…' : children}
        </button>
    );
}

export function SecondaryButton({ children, type = 'button', ...props }) {
    return <button {...props} type={type} className={c.secondary}>{children}</button>;
}

export function TextButton({ children, ...props }) {
    return <button type="button" className={c.link} {...props}>{children}</button>;
}

function GoogleIcon() {
    return (
        <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
            <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9 3.5l6.7-6.7C35.6 2.4 30.2 0 24 0 14.6 0 6.6 5.4 2.7 13.2l7.8 6.1C12.4 13.6 17.7 9.5 24 9.5z" />
            <path fill="#4285F4" d="M46.1 24.6c0-1.6-.1-3.1-.4-4.6H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.8c4.3-4 6.9-9.9 6.9-17.1z" />
            <path fill="#FBBC05" d="M10.5 28.7c-.5-1.4-.8-2.9-.8-4.7s.3-3.2.8-4.7l-7.8-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.8l7.8-6.1z" />
            <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.8c-2.1 1.4-4.8 2.2-8.5 2.2-6.3 0-11.6-4.1-13.5-9.8l-7.8 6.1C6.6 42.6 14.6 48 24 48z" />
        </svg>
    );
}

export function GoogleButton({ onClick, busy }) {
    return (
        <button type="button" className={c.google} onClick={onClick} disabled={busy}>
            <GoogleIcon /> Continue with Google
        </button>
    );
}

export function Divider() {
    return <div className={c.divider}>or</div>;
}

export function Tabs({ value, onChange, options }) {
    return (
        <div role="tablist" className={c.tabs}>
            {options.map((o) => (
                <button key={o.value} type="button" role="tab" aria-selected={value === o.value}
                    className={value === o.value ? c.tabOn : c.tabOff} onClick={() => onChange(o.value)}>
                    {o.label}
                </button>
            ))}
        </div>
    );
}

export function Notice({ kind = 'error', children }) {
    if (!children) return null;
    return <div role={kind === 'error' ? 'alert' : 'status'} className={kind === 'error' ? c.error : c.info}>{children}</div>;
}

export function Legal() {
    return <p className={`${c.muted} text-center`}>Market panel is illustrative, not live data. Analytics tool, not investment advice.</p>;
}
