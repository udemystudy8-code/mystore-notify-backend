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
  subscribers.push({ phone, variantId, productTitle, productUrl });
  console.log('Saved subscriber:', phone, variantId);
  res.json({ success: true });
});

app.post('/webhook/inventory', async (req, res) => {
  const { available, inventory_item_id } = req.body;
  if (available > 0) {
    const matches = subscribers.filter(s => s.variantId == inventory_item_id);
    for (const sub of matches) {
      await fetch(`https://graph.facebook.com/v18.0/${process.env.PHONE_ID}/messages`, {
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
    }
  }
  res.sendStatus(200);
});

app.listen(3000, () => console.log('Server running!'));
