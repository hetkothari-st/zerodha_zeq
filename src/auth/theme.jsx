import React from 'react';

function Wordmark() {
    return (
        <span className="font-['Sora',sans-serif] text-2xl font-extrabold tracking-tight text-gray-900">
            Funnel<span className="text-[#059669]">Eq</span>
        </span>
    );
}

export const theme = {
    productName: 'Funnel Eq',
    tagline: 'Track every move on your watchlist.',
    Wordmark,
    classes: {
        page: "min-h-screen flex flex-col min-[900px]:flex-row bg-[#f7f6f2] text-gray-900 font-['Inter',sans-serif]",
        panel: 'relative h-44 shrink-0 overflow-hidden border-b border-[#ecebe6] min-[900px]:h-auto min-[900px]:flex-[1.3] min-[900px]:border-b-0 min-[900px]:border-r',
        formSide: 'flex flex-1 items-center justify-center bg-white px-4 py-10',
        title: "text-2xl font-extrabold tracking-tight font-['Sora',sans-serif] text-gray-900",
        subtitle: 'text-sm text-gray-500',
        label: 'text-xs font-semibold text-gray-500',
        input: 'w-full rounded-[10px] border border-gray-200 bg-white px-3 py-2.5 text-sm text-gray-900 placeholder-gray-400 outline-none focus:border-[#059669]',
        primary: 'w-full rounded-[10px] bg-[#059669] py-2.5 text-sm font-extrabold text-white hover:bg-[#047857] disabled:opacity-50',
        secondary: 'w-full rounded-[10px] border border-gray-200 bg-white py-2.5 text-sm font-semibold text-gray-800 hover:border-[#059669] disabled:opacity-50',
        google: 'flex w-full items-center justify-center gap-2 rounded-[10px] border border-gray-200 bg-white py-2.5 text-sm font-semibold text-[#1f1f1f] hover:bg-gray-50 disabled:opacity-50',
        divider: 'flex items-center gap-3 text-[10px] uppercase tracking-[0.12em] text-gray-400 before:h-px before:flex-1 before:bg-gray-200 after:h-px after:flex-1 after:bg-gray-200',
        tabs: 'flex rounded-[10px] bg-gray-100 p-1 text-xs font-semibold',
        tabOn: 'flex-1 rounded-lg bg-white py-1.5 text-gray-900 shadow-sm',
        tabOff: 'flex-1 rounded-lg py-1.5 text-gray-500 hover:text-gray-800',
        link: 'font-semibold text-[#059669] hover:underline',
        muted: 'text-xs text-gray-400',
        error: 'rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700',
        info: 'rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800',
        card: 'rounded-xl border border-gray-200 bg-white p-4',
        modal: 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4',
        modalCard: 'flex w-full max-w-sm flex-col gap-4 rounded-2xl border border-gray-200 bg-white p-6',
        adminPage: "min-h-screen bg-[#f7f6f2] px-4 py-8 text-gray-900 font-['Inter',sans-serif]",
    },
};
