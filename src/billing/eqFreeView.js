export const FREE_BUCKET = 5; // minutes

// What the Eq dashboard may show for the current plan. Saved state is left untouched.
export function eqFreeView({ isPro, monitors, activeMonitorId, bucketSizes, extraStocks, volumeUnit }) {
    const shown = isPro ? monitors : monitors.slice(0, 1);
    const activeId = shown.some((m) => m.id === activeMonitorId) ? activeMonitorId : shown[0]?.id;
    return {
        monitors: shown,
        activeId,
        bucketFor: (id) => (isPro ? bucketSizes[id] || 1 : FREE_BUCKET),
        extraFor: (id) => (isPro ? extraStocks[id] || [] : []),
        volumeUnit: isPro ? volumeUnit : 'auto',
    };
}
