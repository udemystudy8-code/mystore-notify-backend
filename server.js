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
    subscribers.push({ phone, variantId: String(variantId), productTitle, productUrl });
    console.log('Saved subscriber:', phone, variantId);
    res.json({ success: true });
});

async function getVariantIdForInventoryItem(inventoryItemId) {
    const query = `
        query($id: ID!) {
              inventoryItem(id: $id) {
                      variant { id }
                            }
                                }
                                  `;
    const resp = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/2024-01/graphql.json`, {
          method: 'POST',
          headers: {
                  'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
                  'Content-Type': 'application/json'
          },
          body: JSON.stringify({
                  query,
                  variables: { id: `gid://shopify/InventoryItem/${inventoryItemId}` }
          })
    });
    const data = await resp.json();
    const gid = data && data.data && data.data.inventoryItem && data.data.inventoryItem.variant && data.data.inventoryItem.variant.id;
    if (!gid) return null;
    return gid.split('/').pop();
}

app.post('/webhook/inventory', async (req, res) => {
    res.sendStatus(200);

           const { available, inventory_item_id } = req.body;
    if (!(available > 0)) return;

           try {
                 const variantId = await getVariantIdForInventoryItem(inventory_item_id);
                 if (!variantId) return;

      const matches = subscribers.filter(s => s.variantId === String(variantId));
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
                 for (const sub of matches) {
                         const idx = subscribers.indexOf(sub);
                         if (idx > -1) subscribers.splice(idx, 1);
                 }
           } catch (err) {
                 console.error('Webhook processing failed:', err);
           }
});

app.listen(process.env.PORT || 3000, () => console.log('Server running!'));
