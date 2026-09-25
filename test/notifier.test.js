import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifier } from '../server/notify/notifier.js';

const quiet = { warn() {}, error() {} };
const profile = { id: 'u1', full_name: 'Asha', email: 'asha@example.com', phone: '+919876543210' };
const configured = { productName: 'Funnel Op', appOrigin: 'https://funnelop.in', resendApiKey: 're_key', emailFrom: 'Funnel Op <hello@funnelop.in>', msg91AuthKey: 'msgkey', msg91ApprovedTemplateId: 'tmpl1', log: quiet };

function recorder(status = 200) {
    const calls = [];
    const fetchImpl = async (url, init) => { calls.push({ url, init, body: JSON.parse(init.body) }); return new Response('{}', { status }); };
    return { calls, fetchImpl };
}

test('approved: sends branded email via Resend and SMS via MSG91', async () => {
    const r = recorder();
    await createNotifier({ ...configured, fetchImpl: r.fetchImpl }).userApproved(profile);
    const email = r.calls.find((c) => c.url === 'https://api.resend.com/emails');
    assert.equal(email.init.headers.Authorization, 'Bearer re_key');
    assert.deepEqual(email.body.to, ['asha@example.com']);
    assert.equal(email.body.from, 'Funnel Op <hello@funnelop.in>');
    assert.match(email.body.subject, /Funnel Op/);
    assert.match(email.body.html, /https:\/\/funnelop\.in/);
    const sms = r.calls.find((c) => c.url === 'https://control.msg91.com/api/v5/flow');
    assert.equal(sms.init.headers.authkey, 'msgkey');
    assert.deepEqual(sms.body, { template_id: 'tmpl1', short_url: '0', recipients: [{ mobiles: '919876543210', name: 'Asha', product: 'Funnel Op', link: 'https://funnelop.in' }] });
});

test('rejected: email only', async () => {
    const r = recorder();
    await createNotifier({ ...configured, fetchImpl: r.fetchImpl }).userRejected(profile);
    assert.deepEqual(r.calls.map((c) => c.url), ['https://api.resend.com/emails']);
});

test('escapes HTML in names', async () => {
    const r = recorder();
    await createNotifier({ ...configured, fetchImpl: r.fetchImpl }).userApproved({ ...profile, full_name: '<script>x</script>' });
    const html = r.calls.find((c) => c.url === 'https://api.resend.com/emails').body.html;
    assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;script&gt;'));
});

test('skips channels that are not configured', async () => {
    const r = recorder();
    await createNotifier({ productName: 'Funnel Op', appOrigin: 'https://funnelop.in', log: quiet, fetchImpl: r.fetchImpl }).userApproved(profile);
    assert.equal(r.calls.length, 0);
});

test('never throws: network errors and HTTP errors are swallowed', async () => {
    const boom = createNotifier({ ...configured, fetchImpl: async () => { throw new Error('ECONNRESET'); } });
    await boom.userApproved(profile);
    await boom.userRejected(profile);
    const http500 = createNotifier({ ...configured, fetchImpl: recorder(500).fetchImpl });
    await http500.userApproved(profile);
});
