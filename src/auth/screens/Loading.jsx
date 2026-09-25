import React from 'react';
import { theme } from '../theme';

export default function Loading() {
    return <div role="status" className={`${theme.classes.muted} text-center`}>Loading…</div>;
}
