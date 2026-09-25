const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Email (Resend) + SMS (MSG91 Flow API). Best effort: never throws, so an outage can't fail an approval.
export function createNotifier({
    productName, appOrigin, resendApiKey, emailFrom, msg91AuthKey, msg91ApprovedTemplateId,
    fetchImpl = fetch, log = console,
}) {
    async function post(label, url, headers, body) {
        try {
            const res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
            if (!res.ok) log.error(`[notify] ${label} failed: ${res.status}`);
            return res.ok;
        } catch (err) {
            log.error(`[notify] ${label} error:`, err.message);
            return false;
        }
    }

    function email(to, subject, html) {
        if (!resendApiKey || !emailFrom || !to) {
            log.warn(`[notify] email skipped (not configured): ${subject}`);
            return Promise.resolve(false);
        }
        return post('email', 'https://api.resend.com/emails', { Authorization: `Bearer ${resendApiKey}` }, { from: emailFrom, to: [to], subject, html });
    }

    function sms(phone, vars) {
        if (!msg91AuthKey || !msg91ApprovedTemplateId || !phone) {
            log.warn('[notify] sms skipped (not configured)');
            return Promise.resolve(false);
        }
        return post('sms', 'https://control.msg91.com/api/v5/flow', { authkey: msg91AuthKey }, {
            template_id: msg91ApprovedTemplateId,
            short_url: '0',
            recipients: [{ mobiles: String(phone).replace(/^\+/, ''), ...vars }],
        });
    }

    return {
        async userApproved(p) {
            const name = escapeHtml(p.full_name);
            await Promise.all([
                email(p.email, `You're in: welcome to ${productName}`,
                    `<p>Hi ${name},</p><p>Your ${productName} account has been approved.</p><p><a href="${appOrigin}">Sign in to ${productName}</a></p>`),
                sms(p.phone, { name: p.full_name, product: productName, link: appOrigin }),
            ]);
        },
        async userRejected(p) {
            await email(p.email, `Your ${productName} access request`,
                `<p>Hi ${escapeHtml(p.full_name)},</p><p>Thanks for your interest in ${productName}. We can't approve your account right now, and we'll be in touch if that changes.</p>`);
        },
    };
}
