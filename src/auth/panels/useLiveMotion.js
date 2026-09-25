import { useEffect, useState } from 'react';

// True when decorative animation may run: user allows motion and the tab is visible.
export function useLiveMotion() {
    const [reduced, setReduced] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    const [visible, setVisible] = useState(() => typeof document === 'undefined' || !document.hidden);
    useEffect(() => {
        const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
        const onMotion = () => setReduced(mql.matches);
        const onVis = () => setVisible(!document.hidden);
        mql.addEventListener('change', onMotion);
        document.addEventListener('visibilitychange', onVis);
        return () => { mql.removeEventListener('change', onMotion); document.removeEventListener('visibilitychange', onVis); };
    }, []);
    return !reduced && visible;
}
