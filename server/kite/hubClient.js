// Pushes a fresh Kite access token to ws-hub. Never throws: the hub may be down.
export function createHubClient({ hubUrl, secret, fetchImpl = fetch }) {
    return {
        async pushToken(accessToken) {
            try {
                const res = await fetchImpl(`${hubUrl}/api/update-token`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Hub-Secret': secret },
                    body: JSON.stringify({ access_token: accessToken }),
                });
                if (!res.ok) console.warn(`[kite] ws-hub rejected token update: ${res.status}`);
                return res.ok;
            } catch (err) {
                console.warn('[kite] Could not notify ws-hub:', err.message);
                return false;
            }
        },
    };
}
