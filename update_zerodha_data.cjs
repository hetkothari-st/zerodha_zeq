#!/usr/bin/env node
// Downloads Zerodha's instrument list and rebuilds:
//   src/instrument_map.json   — exchange_token → instrument_token (NFO + BFO)
//   src/contracts_nsefo.json  — option contracts in the format the app expects
//
// Usage: node update_zerodha_data.cjs

const https = require('https');
const fs = require('fs');
const path = require('path');

const INSTRUMENTS_URL = 'https://api.kite.trade/instruments';

function download(url) {
    return new Promise((resolve, reject) => {
        https.get(url, (res) => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                res.resume();
                return;
            }
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            res.on('error', reject);
        }).on('error', reject);
    });
}

async function main() {
    console.log('Downloading Zerodha instrument list...');
    const csv = await download(INSTRUMENTS_URL);

    const lines = csv.split('\n');
    const header = lines[0].split(',');

    const iIT  = header.indexOf('instrument_token');
    const iET  = header.indexOf('exchange_token');
    const iEX  = header.indexOf('exchange');
    const iTSY = header.indexOf('tradingsymbol');
    const iNM  = header.indexOf('name');
    const iEXP = header.indexOf('expiry');
    const iSTR = header.indexOf('strike');
    const iITP = header.indexOf('instrument_type');

    if ([iIT,iET,iEX,iTSY,iNM,iEXP,iSTR,iITP].some(i => i === -1)) {
        throw new Error('CSV missing expected columns. Header: ' + header.join(','));
    }

    const instrumentMap = {};   // exchange_token → instrument_token
    const contracts = [];       // app-format option contracts

    let nfo = 0, bfo = 0;

    const strip = s => s ? s.replace(/^"|"$/g, '').trim() : '';

    for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',');
        if (cols.length < header.length) continue;

        const ex      = strip(cols[iEX]);
        const itype   = strip(cols[iITP]);
        const name    = strip(cols[iNM]);
        const et      = strip(cols[iET]);
        const it      = parseInt(strip(cols[iIT]));
        const expiry  = strip(cols[iEXP]);   // "YYYY-MM-DD"
        const strike  = strip(cols[iSTR]);
        const tsym    = strip(cols[iTSY]);

        // Instrument map: NFO + BFO + NSE equities (for reliable stock token lookup)
        if (ex === 'NFO' || ex === 'BFO' || ex === 'NSE') {
            instrumentMap[et] = it;
            if (ex === 'NFO') nfo++;
            else if (ex === 'BFO') bfo++;
        }

        // Option contracts: CE/PE on NIFTY (NFO) and SENSEX/BSX (BFO)
        if ((itype !== 'CE' && itype !== 'PE')) continue;

        let appSymbol = null;
        if (ex === 'NFO' && name === 'NIFTY') appSymbol = 'NIFTY';
        if (ex === 'NFO' && name === 'BANKNIFTY') appSymbol = 'BANKNIFTY';
        if (ex === 'BFO' && (name === 'SENSEX' || name === 'BSX' || name === 'SENSEX50')) appSymbol = 'BSX';

        if (!appSymbol || !expiry || !strike) continue;

        // Display name: "NIFTY 24-APR-2026 CE 24000"
        const expDate = new Date(expiry + 'T00:00:00');
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const dispExpiry = `${expDate.getDate().toString().padStart(2,'0')}-${months[expDate.getMonth()].toUpperCase()}-${expDate.getFullYear()}`;

        contracts.push({
            t: et,                             // NSE exchange_token — maps to Zerodha via instrument_map
            s: appSymbol,
            e: expiry + 'T00:00:00',           // ISO string matching app's date comparison
            st: parseFloat(strike).toFixed(5),
            p: itype,
            d: `${appSymbol} ${dispExpiry} ${itype} ${parseFloat(strike)}`,
        });
    }

    // Sort contracts by expiry ascending, then symbol, then strike
    contracts.sort((a, b) => {
        if (a.e !== b.e) return a.e < b.e ? -1 : 1;
        if (a.s !== b.s) return a.s < b.s ? -1 : 1;
        return parseFloat(a.st) - parseFloat(b.st);
    });

    // Write instrument_map.json
    const mapPath = path.join(__dirname, 'src', 'instrument_map.json');
    fs.writeFileSync(mapPath, JSON.stringify(instrumentMap));
    console.log(`instrument_map.json: ${nfo} NFO + ${bfo} BFO = ${nfo+bfo} entries`);

    // Write contracts_nsefo.json
    const ctrPath = path.join(__dirname, 'src', 'contracts_nsefo.json');
    fs.writeFileSync(ctrPath, JSON.stringify(contracts));
    console.log(`contracts_nsefo.json: ${contracts.length} option contracts`);

    // Verify a few lookups
    if (contracts.length > 0) {
        const sample = contracts[0];
        const instToken = instrumentMap[sample.t];
        console.log(`\nSample: ${sample.d}`);
        console.log(`  exchange_token: ${sample.t}  →  instrument_token: ${instToken || '(not found — formula will be used)'}`);
    }

    console.log('\nDone! Both files updated from Zerodha.');
}

main().catch(err => {
    console.error('Failed:', err.message);
    process.exit(1);
});
