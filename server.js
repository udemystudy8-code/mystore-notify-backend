const express = require('express');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const app = express();
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const subscribers = [];

// Meta's WhatsApp API matches recipients (and the sandbox allow-list) against
// the full E.164 number including country code. Shopify's storefront just
// collects a raw 10-digit Indian mobile number with no country code, so
// "8585918999" gets saved/sent as-is and never matches the allow-listed
// "918585918999" — Meta silently rejects it as "not in allowed list", even
// though it's the same phone. Normalize every number to include the 91
// country code before it's ever saved or sent.
function normalizePhone(raw) {
    let digits = String(raw || '').replace(/\D/g, '');
    if (digits.length === 10) {
        digits = '91' + digits; // bare local mobile number
    } else if (digits.length === 11 && digits.startsWith('0')) {
        digits = '91' + digits.slice(1); // leading trunk 0
    }
    // 12-digit numbers already starting with 91 (or any other country code
    // length) are left untouched.
    return digits;
}

// Generic helper: send any approved WhatsApp template message.
async function sendTemplate(phone, templateName, languageCode) {
    const to = normalizePhone(phone);
    const resp = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_ID}/messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.WA_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'template',
            template: {
                name: templateName,
                language: { code: languageCode }
            }
        })
    });
    const data = await resp.json();
    console.log('WhatsApp send result for', to, templateName, resp.status, JSON.stringify(data));
    return resp.ok;
}

// Used by checkStock() when an item a customer subscribed to is actually
// back in stock. Uses the approved "back_in_stock" template ("Hi! Great
// news, the size you wanted is back in stock...") since that message is
// only ever true at this point in the flow.
async function sendWhatsApp(sub) {
    return sendTemplate(sub.phone, 'back_in_stock', 'en');
}

// Used the moment someone clicks "Notify me" — confirms we received the
// request. Deliberately NOT the back_in_stock template (the item is sold
// out at this point, so "it's back in stock" would be false). Falls back to
// hello_world until a proper "we got your request" template is approved
// (notify_confirmation, submitted for Meta review).
async function sendConfirmation(phone) {
    try {
        const ok = await sendTemplate(phone, 'notify_confirmation', 'en');
        if (ok) return true;
        console.log('notify_confirmation send not ok, falling back to hello_world');
    } catch (err) {
        console.error('notify_confirmation send failed, falling back to hello_world:', err);
    }
    return sendTemplate(phone, 'hello_world', 'en_US');
}

app.post('/notify', async (req, res) => {
    const { phone: rawPhone, variantId, variantTitle, productTitle, productUrl } = req.body;
    if (!rawPhone || !variantId || !productUrl) {
        return res.status(400).json({ success: false, error: 'Missing fields' });
    }
    const phone = normalizePhone(rawPhone);
    subscribers.push({ phone, variantId: String(variantId), productTitle, productUrl });
    console.log('Saved subscriber:', phone, '(raw:', rawPhone + ')', variantId, 'total:', subscribers.length);

    // Send an immediate WhatsApp confirmation every time someone submits the form,
    // regardless of which size/variant it was for. This is independent of the
    // restock-detection loop below, which still runs separately.
    let confirmSent = false;
    try {
        confirmSent = await sendConfirmation(phone);
    } catch (err) {
        console.error('Immediate confirm send failed:', err);
    }

    res.json({ success: true, confirmSent });
});

app.get('/test-whatsapp', async (req, res) => {
    try {
        const resp = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_ID}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${process.env.WA_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                messaging_product: 'whatsapp',
                to: '918585918999',
                type: 'template',
                template: {
                    name: 'back_in_stock',
                    language: { code: 'en' }
                }
            })
        });
        const data = await resp.json();
        console.log('Test WhatsApp send result:', resp.status, JSON.stringify(data));
        res.json({ status: resp.status, data });
    } catch (err) {
        console.error('Test WhatsApp error:', err);
        res.status(500).json({ error: String(err) });
    }
});

async function checkStock() {
    console.log('checkStock running, subscribers:', subscribers.length);
    if (subscribers.length === 0) return;

    const byUrl = {};
    for (const sub of subscribers) {
        if (!byUrl[sub.productUrl]) byUrl[sub.productUrl] = [];
        byUrl[sub.productUrl].push(sub);
    }

    const notified = [];

    for (const productUrl of Object.keys(byUrl)) {
        try {
            const jsonUrl = productUrl.split('?')[0].replace(/\/$/, '') + '.js';
            console.log('Checking', jsonUrl);
            const resp = await fetch(jsonUrl);
            if (!resp.ok) {
                console.log('Fetch failed', resp.status);
                continue;
            }
            const product = await resp.json();

            for (const sub of byUrl[productUrl]) {
                const variant = (product.variants || []).find(v => String(v.id) === sub.variantId);
                console.log('Variant', sub.variantId, 'available:', variant && variant.available);
                if (variant && variant.available) {
                    console.log('Back in stock, notifying:', sub.phone, sub.variantId);
                    const ok = await sendWhatsApp(sub).catch(err => {
                        console.error('WhatsApp send failed:', err);
                        return false;
                    });
                    if (ok) notified.push(sub);
                }
            }
        } catch (err) {
            console.error('Stock check failed for', productUrl, err);
        }
    }

    for (const sub of notified) {
        const idx = subscribers.indexOf(sub);
        if (idx > -1) subscribers.splice(idx, 1);
    }
    console.log('checkStock done, notified:', notified.length, 'remaining:', subscribers.length);
}

app.post('/webhook/inventory', async (req, res) => {
    try {
        await checkStock();
    } catch (err) {
        console.error('checkStock error:', err);
    }
    res.sendStatus(200);
});

setInterval(() => {
    checkStock().catch(err => console.error('checkStock error:', err));
}, 3 * 60 * 1000);

app.get('/', (req, res) => res.send('Notify backend running. Subscribers: ' + subscribers.length));

app.listen(process.env.PORT || 3000, () => console.log('Server running!'));
