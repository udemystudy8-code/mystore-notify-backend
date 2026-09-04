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

app.post('/notify', (req, res) => {
    const { phone, variantId, productTitle, productUrl } = req.body;
    if (!phone || !variantId || !productUrl) {
        return res.status(400).json({ success: false, error: 'Missing fields' });
    }
    subscribers.push({ phone, variantId: String(variantId), productTitle, productUrl });
    console.log('Saved subscriber:', phone, variantId, 'total:', subscribers.length);
    res.json({ success: true });
});

async function sendWhatsApp(sub) {
    const resp = await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_ID}/messages`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${process.env.WA_TOKEN}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            messaging_product: 'whatsapp',
            to: sub.phone,
            type: 'template',
            template: {
                name: 'back_in_stock',
                language: { code: 'en' },
                components: [{ type: 'body', parameters: [
                    { type: 'text', text: sub.productTitle },
                    { type: 'text', text: sub.productUrl }
                    ]}]
            }
        })
    });
    const data = await resp.json();
    console.log('WhatsApp send result for', sub.phone, JSON.stringify(data));
    return resp.ok;
}

async function checkStock() {
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
        const resp = await fetch(jsonUrl);
        if (!resp.ok) continue;
        const product = await resp.json();

    for (const sub of byUrl[productUrl]) {
        const variant = (product.variants || []).find(v => String(v.id) === sub.variantId);
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
}

app.post('/webhook/inventory', (req, res) => {
    res.sendStatus(200);
    checkStock().catch(err => console.error('checkStock error:', err));
});

setInterval(() => {
    checkStock().catch(err => console.error('checkStock error:', err));
}, 3 * 60 * 1000);

app.get('/', (req, res) => res.send('Notify backend running. Subscribers: ' + subscribers.length));

app.listen(process.env.PORT || 3000, () => console.log('Server running!'));
