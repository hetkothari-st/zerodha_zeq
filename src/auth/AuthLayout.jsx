import React, { useEffect, useState } from 'react';
import { theme } from './theme';
import MarketPanel from './panels/MarketPanel';

function useCompact() {
    const query = '(max-width: 899px)';
    const [compact, setCompact] = useState(() => window.matchMedia(query).matches);
    useEffect(() => {
        const mql = window.matchMedia(query);
        const on = () => setCompact(mql.matches);
        mql.addEventListener('change', on);
        return () => mql.removeEventListener('change', on);
    }, []);
    return compact;
}

export default function AuthLayout({ children }) {
    const compact = useCompact();
    return (
        <div className={theme.classes.page}>
            <aside className={theme.classes.panel} aria-hidden="true"><MarketPanel compact={compact} /></aside>
            <main className={theme.classes.formSide}><div className="w-full max-w-sm">{children}</div></main>
        </div>
    );
}
