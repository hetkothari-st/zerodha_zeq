import React, { useEffect, useRef, useState } from 'react';
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
    // The panel is decorative: aria-hidden hides it from assistive tech and inert keeps
    // anything inside it out of the tab order (React 18 doesn't know the inert prop).
    const asideRef = useRef(null);
    useEffect(() => { asideRef.current?.setAttribute('inert', ''); }, []);
    return (
        <div className={theme.classes.page}>
            <aside ref={asideRef} className={theme.classes.panel} aria-hidden="true"><MarketPanel compact={compact} /></aside>
            <main className={theme.classes.formSide}><div className="w-full max-w-sm">{children}</div></main>
        </div>
    );
}
