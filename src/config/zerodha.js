export const ZERODHA_CONFIG = {
    API_KEY: import.meta.env.VITE_ZERODHA_API_KEY || '',
    get ACCESS_TOKEN() {
        return localStorage.getItem('kite_access_token') || import.meta.env.VITE_ZERODHA_ACCESS_TOKEN || '';
    },

    WS_URL: 'wss://ws.kite.trade',
    API_BASE: 'https://api.kite.trade',

    // Well-known index instrument_tokens (fixed by Zerodha)
    INDEX_TOKENS: {
        256265: 'NIFTY 50',
        260105: 'NIFTY BANK',
        265:    'SENSEX',
    },

    // Reverse map: name → instrument_token
    INDEX_TOKEN_BY_NAME: {
        'NIFTY 50':  256265,
        'NIFTY50':   256265,
        'NIFTY':     256265,
        'NIFTY BANK': 260105,
        'NIFTYBANK': 260105,
        'BANKNIFTY': 260105,
        'SENSEX':    265,
    },

    // instrument_token = exchange_token * 256 + exchange_code
    // Verified from actual Zerodha instrument CSV (modulo 256)
    EXCHANGE_CODES: {
        NSE:   1,   // NSE equity stocks (verified: instrument_token = exchange_token*256+1)
        NSECM: 1,   // alias used in stocks_nsecm.json
        NFO:   2,   // NSE F&O (verified: 16054786%256=2)
        NSEFO: 2,   // alias used in contracts_nsefo.json
        BSE:   4,   // BSE equity (verified: 128000516%256=4? TBC)
        BSECM: 4,
        BFO:   5,   // BSE F&O (verified: 211574533%256=5)
        BSEFO: 5,   // alias used in contracts_nsefo.json
        CDS:   3,
    },

    // Old broker token → Zerodha index name mapping
    OLD_INDEX_MAP: {
        '26000': 'NIFTY 50',
        '26009': 'NIFTY BANK',
        '1':     'SENSEX',
    },
};
