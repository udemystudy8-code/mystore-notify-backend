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

// ---------------------------------------------------------------------------
// DASHBOARD / PERSISTENCE ADDITIONS (new — does not touch anything below
// that sends WhatsApp messages). Every signup and every successful restock
// notification gets logged to `allEvents`, which is persisted to a Shopify
// metaobject (type: notify_me_events_log, handle: notify-me-events-log) via
// the Shopify Admin GraphQL API, so the history survives Render's free-tier
// restarts/spin-downs. Requires SHOPIFY_STORE_DOMAIN and SHOPIFY_ADMIN_TOKEN
// env vars (a custom-app Admin API access token with write_metaobjects
// scope). If they aren't set, logging just no-ops — nothing else is
// affected.
// ---------------------------------------------------------------------------
const SHOPIFY_METAOBJECT_TYPE = 'notify_me_events_log';
const SHOPIFY_METAOBJECT_HANDLE = 'notify-me-events-log';
const SHOPIFY_API_VERSION = '2026-07';

let allEvents = [];

async function shopifyGraphQL(query, variables) {
  const resp = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': process.env.SHOPIFY_ADMIN_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  return resp.json();
}

async function loadEventsFromShopify() {
  if (!process.env.SHOPIFY_STORE_DOMAIN || !process.env.SHOPIFY_ADMIN_TOKEN) {
    console.log('Shopify storage env vars not set, dashboard persistence disabled');
    return;
  }
  try {
    const query = `
      query GetEventsLog($handle: MetaobjectHandleInput!) {
        metaobjectByHandle(handle: $handle) {
          id
          fields { key value }
        }
      }
    `;
    const variables = { handle: { type: SHOPIFY_METAOBJECT_TYPE, handle: SHOPIFY_METAOBJECT_HANDLE } };
    const data = await shopifyGraphQL(query, variables);
    if (data.errors) {
      console.error('loadEventsFromShopify GraphQL errors:', JSON.stringify(data.errors));
      return;
    }
    const metaobject = data.data && data.data.metaobjectByHandle;
    if (!metaobject) {
      console.log('No existing events metaobject yet, dashboard will start empty');
      return;
    }
    const dataField = (metaobject.fields || []).find(f => f.key === 'data');
    if (dataField && dataField.value) {
      const parsed = JSON.parse(dataField.value);
      allEvents = parsed.events || [];
    }
    console.log('Loaded', allEvents.length, 'events from Shopify');
  } catch (err) {
    console.error('loadEventsFromShopify failed:', err);
  }
}

// Serialize writes so two events landing close together don't race on the
// metaobject (a naive read-modify-write from two concurrent calls could
// otherwise clobber each other).
let persistQueue = Promise.resolve();
function persistEventsToShopify() {
  persistQueue = persistQueue.then(async () => {
    if (!process.env.SHOPIFY_STORE_DOMAIN || !process.env.SHOPIFY_ADMIN_TOKEN) return;
    try {
      const mutation = `
        mutation UpsertEventsLog($handle: MetaobjectHandleInput!, $metaobject: MetaobjectUpsertInput!) {
          metaobjectUpsert(handle: $handle, metaobject: $metaobject) {
            metaobject { id }
            userErrors { field message }
          }
        }
      `;
      const variables = {
        handle: { type: SHOPIFY_METAOBJECT_TYPE, handle: SHOPIFY_METAOBJECT_HANDLE },
        metaobject: {
          fields: [
            { key: 'data', value: JSON.stringify({ events: allEvents }) }
          ]
        }
      };
      const data = await shopifyGraphQL(mutation, variables);
      const errors = data.errors || (data.data && data.data.metaobjectUpsert && data.data.metaobjectUpsert.userErrors);
      if (errors && errors.length) {
        console.error('persistEventsToShopify failed:', JSON.stringify(errors));
      }
    } catch (err) {
      console.error('persistEventsToShopify error:', err);
    }
  });
  return persistQueue;
}

function logEvent(type, data) {
  allEvents.push(Object.assign({ type }, data, { ts: new Date().toISOString() }));
  persistEventsToShopify().catch(err => console.error('persist error:', err));
}

loadEventsFromShopify().catch(err => console.error(err));
// ---------------------------------------------------------------------------
// END dashboard/persistence additions. Everything below this point is the
// original notification logic, unchanged.
// ---------------------------------------------------------------------------

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
// back in stock. "back_in_stock" is a Marketing-category template, and
// WhatsApp does not guarantee delivery of Marketing templates the way it
// does Utility ones — messages can come back "accepted" from the API and
// still never reach the device. "restock_alert_v2" is the Utility-category
// replacement (same info, phrased as a status update on the customer's own
// request rather than a promo) which gets reliable delivery like
// notify_confirmation does. Falls back to the old Marketing template only
// if the new one isn't approved yet.
async function sendWhatsApp(sub) {
  const ok = await sendTemplate(sub.phone, 'restock_alert_v2', 'en');
  if (ok) return true;
  console.log('restock_alert_v2 send not ok, falling back to back_in_stock');
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
  logEvent('signup', { phone, variantId: String(variantId), variantTitle, productTitle, productUrl });

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
          name: 'restock_alert_v2',
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
          if (ok) {
            notified.push(sub);
            logEvent('notified', { phone: sub.phone, variantId: sub.variantId, productTitle: sub.productTitle, productUrl: sub.productUrl });
          }
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

// Dashboard read endpoint — returns aggregate stats + the full event log.
// Protected by a shared secret (ADMIN_KEY env var) passed as ?key=... so a
// random visitor can't read everyone's phone numbers. Read-only, does not
// touch subscribers/messaging state.
app.get('/admin/stats', (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const totalSignups = allEvents.filter(e => e.type === 'signup').length;
  const totalNotified = allEvents.filter(e => e.type === 'notified').length;
  res.json({
    totalSignups,
    totalNotified,
    currentlyWaiting: subscribers.length,
    events: allEvents.slice().reverse()
  });
});

// ---------------------------------------------------------------------------
// SHOPIFY STORE STATS (new — read-only, does not touch subscribers,
// messaging, or the events log above). Uses its OWN isolated Admin API
// token — SHOPIFY_STATS_TOKEN — from a separate, read-only app
// ("Evara Order Stats", scopes: read_orders, read_customers) so the
// existing SHOPIFY_ADMIN_TOKEN (used above for write_metaobjects event
// persistence) never has to be touched or have its scopes changed.
// Falls back to SHOPIFY_ADMIN_TOKEN only if SHOPIFY_STATS_TOKEN isn't set,
// so this still works standalone if that's the only token available.
// Nothing in this section can create, edit, cancel, or refund anything in
// the store. If either scope is missing, the affected number degrades to
// "n/a" instead of failing the whole endpoint.
// ---------------------------------------------------------------------------
async function shopifyStatsGraphQL(query, variables) {
  const token = process.env.SHOPIFY_STATS_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN;
  const resp = await fetch(`https://${process.env.SHOPIFY_STORE_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': token,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query, variables })
  });
  return resp.json();
}

async function fetchShopifyOrderStats() {
  const query = `
    query DashboardOrders($first: Int!) {
      orders(first: $first, sortKey: CREATED_AT, reverse: true) {
        edges {
          node {
            name
            createdAt
            cancelledAt
            displayFinancialStatus
            lineItems(first: 5) {
              edges {
                node { title quantity variantTitle }
              }
            }
          }
        }
      }
    }
  `;
  const data = await shopifyStatsGraphQL(query, { first: 100 });
  if (data.errors) {
    throw new Error(data.errors.map(e => e.message).join('; '));
  }
  const edges = (data.data && data.data.orders && data.data.orders.edges) || [];
  return edges.map(e => e.node);
}

async function fetchShopifyCustomerCount() {
  const query = `query CustomerCount { customersCount { count } }`;
  const data = await shopifyStatsGraphQL(query, {});
  if (data.errors) {
    throw new Error(data.errors.map(e => e.message).join('; '));
  }
  return (data.data && data.data.customersCount && data.data.customersCount.count) || 0;
}

function statusFromOrder(order) {
  if (order.cancelledAt) return 'Cancelled';
  const s = (order.displayFinancialStatus || '').toUpperCase();
  if (s === 'PAID' || s === 'PARTIALLY_REFUNDED' || s === 'REFUNDED') return 'Paid';
  return 'Pending';
}

// Protected the same way as /admin/stats (shared ADMIN_KEY). Read-only.
app.get('/admin/shopify-stats', async (req, res) => {
  if (!process.env.ADMIN_KEY || req.query.key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (!process.env.SHOPIFY_STORE_DOMAIN || !(process.env.SHOPIFY_STATS_TOKEN || process.env.SHOPIFY_ADMIN_TOKEN)) {
    return res.status(503).json({ error: 'Shopify env vars not set (SHOPIFY_STORE_DOMAIN / SHOPIFY_STATS_TOKEN).' });
  }
  try {
    const [orders, totalCustomers] = await Promise.all([
      fetchShopifyOrderStats(),
      fetchShopifyCustomerCount().catch(err => {
        console.error('fetchShopifyCustomerCount failed (likely missing read_customers scope):', err.message);
        return null;
      })
    ]);

    let ordersCompleted = 0, ordersPending = 0, ordersCancelled = 0;
    const unitsByProduct = {};
    const recentOrders = [];

    for (const order of orders) {
      const status = statusFromOrder(order);
      if (status === 'Paid') ordersCompleted++;
      else if (status === 'Cancelled') ordersCancelled++;
      else ordersPending++;

      const lineItems = ((order.lineItems && order.lineItems.edges) || []).map(e => e.node);
      const qty = lineItems.reduce((sum, li) => sum + (li.quantity || 0), 0);
      const firstItem = lineItems[0] || {};
      const productLabel = lineItems.length > 1
        ? firstItem.title + ' +' + (lineItems.length - 1) + ' more'
        : (firstItem.title || order.name);

      if (recentOrders.length < 15) {
        recentOrders.push({
          product: productLabel,
          size: firstItem.variantTitle || '',
          qty,
          status,
          createdAt: order.createdAt
        });
      }

      for (const li of lineItems) {
        if (!li.title) continue;
        unitsByProduct[li.title] = (unitsByProduct[li.title] || 0) + (li.quantity || 0);
      }
    }

    const totalUnits = Object.values(unitsByProduct).reduce((a, b) => a + b, 0);
    const bestSellers = Object.entries(unitsByProduct)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([product, units]) => ({
        product,
        units,
        share: totalUnits ? Math.round((units / totalUnits) * 100) : 0
      }));

    res.json({
      ordersCompleted,
      ordersPending,
      ordersCancelled,
      totalCustomers: totalCustomers != null ? totalCustomers : 'n/a (add read_customers scope)',
      recentOrders,
      bestSellers,
      basedOnOrders: orders.length
    });
  } catch (err) {
    console.error('shopify-stats failed:', err.message);
    res.status(502).json({ error: 'Shopify API error: ' + err.message + ' — check that the app has read_orders scope.' });
  }
});

// Dashboard page itself — served from this same domain (not claude.ai) so its
// fetch() calls to /admin/stats are same-origin and never get blocked as
// cross-site. Static HTML/CSS/JS only, no external calls besides this API
// (and Google Fonts for the Inter typeface used in the Evara-styled UI
// below). This section is purely presentational — it does not read from or
// write to subscribers/messaging state; all data still comes from the same
// /admin/stats and /admin/shopify-stats endpoints above, unchanged.
const DASHBOARD_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notify Me Dashboard</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<style>
:root{
  --maroon:#4D1010; --maroon-soft:#F5E6E6; --maroon-text:#4D1010;
  --bg:#FAF6F5; --card:#ffffff; --border:#EDE1E1; --text:#211313; --muted:#8C7676;
  --green:#1F8A4C; --green-soft:#E6F4EC;
  --amber:#A9760A; --amber-soft:#FBF1DC;
  --red:#B3261E; --red-soft:#FBE7E5;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#150e0e; --card:#211515; --border:#3a2424; --text:#f3e8e8; --muted:#b39a9a;
    --maroon-soft:#3a1c1c; --maroon-text:#e59a9a;
    --green-soft:#173824; --amber-soft:#332608; --red-soft:#3a1414;
  }
}
*{box-sizing:border-box;}
html{scroll-behavior:smooth;}
body{background:var(--bg); color:var(--text); margin:0; font-family:'Inter',-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;}
.app{display:flex; min-height:100vh;}

.sidebar{position:fixed; top:0; left:0; bottom:0; width:72px; background:var(--maroon); display:flex; flex-direction:column; align-items:center; padding:18px 0; z-index:5;}
.brand{width:36px; height:36px; border-radius:10px; background:rgba(255,255,255,0.16); color:#fff; font-weight:800; font-size:1rem; display:flex; align-items:center; justify-content:center; margin-bottom:26px; letter-spacing:0.02em;}
.side-nav{display:flex; flex-direction:column; gap:6px;}
.side-link{width:40px; height:40px; border-radius:10px; display:flex; align-items:center; justify-content:center; color:rgba(255,255,255,0.6); text-decoration:none; transition:background .15s, color .15s;}
.side-link svg{width:19px; height:19px;}
.side-link:hover{background:rgba(255,255,255,0.12); color:#fff;}
.side-link.active{background:rgba(255,255,255,0.2); color:#fff;}
.side-bottom{margin-top:auto;}

.main{margin-left:72px; flex:1; min-width:0; padding-bottom:48px;}
.topbar{display:flex; align-items:center; justify-content:space-between; gap:16px; padding:24px 28px 14px; flex-wrap:wrap;}
.greeting{font-size:1.25rem; font-weight:800;}
.greeting-sub{font-size:0.85rem; color:var(--muted); margin-top:2px;}
.auth-row{display:flex; gap:8px; align-items:center; flex-wrap:wrap;}
.key-field{position:relative; display:flex; align-items:center;}
.key-field input{padding:10px 38px 10px 14px; border-radius:999px; border:1px solid var(--border); background:var(--card); color:var(--text); font-size:0.85rem; width:180px; font-family:inherit;}
.key-toggle{position:absolute; right:4px; top:50%; transform:translateY(-50%); width:28px; height:28px; padding:0; border:none; background:transparent; color:var(--muted); display:flex; align-items:center; justify-content:center; cursor:pointer;}
.key-toggle svg{width:16px; height:16px; margin:0;}
.key-toggle:hover{color:var(--maroon-text);}
.status-line{padding:0 28px 16px; font-size:0.8rem; color:var(--muted);}
.status-line.error{color:var(--red);}

.content-area{padding:6px 28px 20px;}
.section-title{font-size:1.08rem; font-weight:800; margin:26px 0 3px;}
.section-sub{color:var(--muted); font-size:0.85rem; margin:0 0 16px;}

.cards{display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:14px; margin-bottom:18px;}
.card{background:var(--card); border:1px solid var(--border); border-radius:14px; padding:16px; box-shadow:0 1px 2px rgba(77,16,16,0.04);}
.icon-chip{width:34px; height:34px; border-radius:9px; display:flex; align-items:center; justify-content:center; margin-bottom:10px;}
.icon-chip svg{width:17px; height:17px;}
.icon-chip.maroon{background:var(--maroon-soft); color:var(--maroon-text);}
.icon-chip.green{background:var(--green-soft); color:var(--green);}
.icon-chip.amber{background:var(--amber-soft); color:var(--amber);}
.icon-chip.red{background:var(--red-soft); color:var(--red);}
.card .n{font-size:1.55rem; font-weight:800; line-height:1.1;}
.card .l{font-size:0.78rem; color:var(--muted); margin-top:4px;}

.toolbar{display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap;}
.toolbar-title{font-size:0.85rem; color:var(--muted); font-weight:700;}
.tab{padding:7px 14px; border-radius:999px; border:1px solid var(--border); background:transparent; color:var(--text); font-size:0.82rem; cursor:pointer; font-weight:600; font-family:inherit;}
.tab.active{background:var(--maroon-soft); border-color:var(--maroon); color:var(--maroon-text);}
button{padding:9px 16px; border-radius:999px; border:1px solid var(--maroon); background:var(--maroon); color:#fff; font-size:0.85rem; cursor:pointer; font-weight:700; font-family:inherit; display:inline-flex; align-items:center;}
button svg{width:14px; height:14px; margin-right:5px;}
button.secondary{background:transparent; color:var(--text); border-color:var(--border); font-weight:600;}
button:disabled{opacity:0.5; cursor:default;}

.table-wrap{background:var(--card); border:1px solid var(--border); border-radius:14px; overflow:auto; max-width:100%;}
table{border-collapse:collapse; width:100%; font-size:0.85rem; min-width:520px;}
th,td{text-align:left; padding:11px 14px; border-bottom:1px solid var(--border); white-space:nowrap;}
th{color:var(--muted); font-weight:700; font-size:0.72rem; text-transform:uppercase; letter-spacing:0.04em;}
tr:last-child td{border-bottom:none;}
.badge{display:inline-block; padding:3px 10px; border-radius:999px; font-size:0.72rem; font-weight:700;}
.badge.signup{background:var(--amber-soft); color:var(--amber);}
.badge.notified{background:var(--green-soft); color:var(--green);}
.badge.paid{background:var(--green-soft); color:var(--green);}
.badge.pending{background:var(--amber-soft); color:var(--amber);}
.badge.cancelled{background:var(--red-soft); color:var(--red);}
.empty{padding:32px 16px; text-align:center; color:var(--muted); font-size:0.88rem;}

.split{display:grid; grid-template-columns:1.6fr 1fr; gap:16px; align-items:start; margin-bottom:28px;}
.panel{background:var(--card); border:1px solid var(--border); border-radius:14px; padding:16px;}
.panel-title{font-size:0.85rem; color:var(--muted); font-weight:700; margin-bottom:14px;}
.bar-list{display:flex; flex-direction:column; gap:14px;}
.bar-item-top{display:flex; justify-content:space-between; font-size:0.82rem; margin-bottom:5px; gap:8px;}
.bar-item-name{font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;}
.bar-item-val{color:var(--muted); white-space:nowrap;}
.bar-track{height:6px; border-radius:999px; background:var(--maroon-soft); overflow:hidden;}
.bar-fill{height:100%; border-radius:999px;}

@media (max-width:900px){ .split{grid-template-columns:1fr;} }
@media (max-width:640px){
  .sidebar{width:56px;}
  .main{margin-left:56px;}
  .topbar{padding:18px 16px 10px;}
  .content-area{padding:4px 16px 20px;}
  .status-line{padding:0 16px 12px;}
  .key-field input{width:140px;}
}
</style>
</head>
<body>
<div class="app">

  <aside class="sidebar">
    <div class="brand">E</div>
    <nav class="side-nav">
      <a href="#top" class="side-link active" title="Overview"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/></svg></a>
      <a href="#notifySection" class="side-link" title="Notify Me"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.5 21a1.5 1.5 0 0 0 3 0"/></svg></a>
      <a href="#storeSection" class="side-link" title="Store Overview"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10"/><path d="M12 20V4"/><path d="M20 20v-7"/></svg></a>
      <a href="#storeSection" class="side-link" title="Customers"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.2c2.5.4 4.5 2.6 4.5 5.3"/></svg></a>
    </nav>
    <div class="side-bottom">
      <a href="#" class="side-link" title="Settings" onclick="return false;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg></a>
    </div>
  </aside>

  <div class="main" id="top">
    <header class="topbar">
      <div>
        <div class="greeting">Hi — welcome back</div>
        <div class="greeting-sub">Evara · Notify Me &amp; Store Overview</div>
      </div>
      <div class="auth-row">
        <div class="key-field">
          <input type="password" id="adminKey" placeholder="Admin key">
          <button class="key-toggle" id="toggleKeyBtn" type="button" title="Show admin key" aria-label="Show admin key">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>
          </button>
        </div>
        <button id="loadBtn" type="button">Unlock</button>
      </div>
    </header>
    <div class="status-line" id="statusLine">Enter your admin key and click Unlock. (This service can take up to a minute to wake up if it has been idle.)</div>

    <div class="content-area">

      <section id="notifySection">
        <div class="section-title">Notify Me</div>
        <p class="section-sub">Every WhatsApp restock-alert signup on your store, logged and counted.</p>

        <div id="content" hidden>
          <div class="cards">
            <div class="card">
              <div class="icon-chip maroon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.5 21a1.5 1.5 0 0 0 3 0"/></svg></div>
              <div class="n" id="statSignups">-</div><div class="l">Total notify-me signups</div>
            </div>
            <div class="card">
              <div class="icon-chip green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.3 2.3L16 9.6"/></svg></div>
              <div class="n" id="statNotified">-</div><div class="l">Restock alerts sent</div>
            </div>
            <div class="card">
              <div class="icon-chip amber"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/></svg></div>
              <div class="n" id="statWaiting">-</div><div class="l">Currently waiting</div>
            </div>
          </div>

          <div class="toolbar">
            <button class="tab active" data-filter="all" type="button">All</button>
            <button class="tab" data-filter="signup" type="button">Signups</button>
            <button class="tab" data-filter="notified" type="button">Notified</button>
            <button class="secondary" id="exportBtn" type="button" style="margin-left:auto;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>Export CSV</button>
            <button class="secondary" id="refreshBtn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 21v-5h5"/></svg>Refresh</button>
          </div>

          <div class="table-wrap">
            <table>
              <thead><tr><th>Type</th><th>Phone</th><th>Product</th><th>Size</th><th>When</th></tr></thead>
              <tbody id="eventsBody"></tbody>
            </table>
            <div class="empty" id="emptyState" hidden>No events yet.</div>
          </div>
        </div>
      </section>

      <section id="storeSection">
        <div id="shopifySection" hidden>
          <div class="section-title">Store Overview</div>
          <p class="section-sub">Live order data pulled from Shopify. Uses the same admin key above.</p>

          <div class="cards">
            <div class="card">
              <div class="icon-chip green"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m8.5 12.5 2.3 2.3L16 9.6"/></svg></div>
              <div class="n" id="shopOrdersCompleted">-</div><div class="l">Orders Completed</div>
            </div>
            <div class="card">
              <div class="icon-chip amber"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/></svg></div>
              <div class="n" id="shopOrdersPending">-</div><div class="l">Orders Pending</div>
            </div>
            <div class="card">
              <div class="icon-chip red"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m9 9 6 6M15 9l-6 6"/></svg></div>
              <div class="n" id="shopOrdersCancelled">-</div><div class="l">Orders Cancelled</div>
            </div>
            <div class="card">
              <div class="icon-chip maroon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.6"/><path d="M15.5 14.2c2.5.4 4.5 2.6 4.5 5.3"/></svg></div>
              <div class="n" id="shopCustomers">-</div><div class="l">Total Customers</div>
            </div>
          </div>

          <div class="split">
            <div class="split-main">
              <div class="toolbar">
                <div class="toolbar-title">Recent orders</div>
                <button class="secondary" id="shopExportBtn" type="button" style="margin-left:auto;"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/></svg>Export CSV</button>
                <button class="secondary" id="shopRefreshBtn" type="button"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 0 1 15.4-6.4L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-15.4 6.4L3 16"/><path d="M3 21v-5h5"/></svg>Refresh</button>
              </div>
              <div class="table-wrap">
                <table>
                  <thead><tr><th>Product</th><th>Size</th><th>Qty</th><th>Status</th><th>Date</th><th>Time</th></tr></thead>
                  <tbody id="shopOrdersBody"></tbody>
                </table>
                <div class="empty" id="shopOrdersEmpty" hidden>No orders yet.</div>
              </div>
            </div>

            <aside class="split-side">
              <div class="panel">
                <div class="panel-title">Best-selling products</div>
                <div id="shopBestSellersBody" class="bar-list"></div>
                <div class="empty" id="shopBestSellersEmpty" hidden>Not enough order data yet.</div>
              </div>
            </aside>
          </div>
        </div>
      </section>

    </div>
  </div>
</div>

<script>
(function(){
  var keyInput = document.getElementById('adminKey');
  var loadBtn = document.getElementById('loadBtn');
  var refreshBtn = document.getElementById('refreshBtn');
  var exportBtn = document.getElementById('exportBtn');
  var statusLine = document.getElementById('statusLine');
  var content = document.getElementById('content');
  var tbody = document.getElementById('eventsBody');
  var emptyState = document.getElementById('emptyState');
  var tabs = document.querySelectorAll('.tab');
  var lastEvents = [];
  var currentFilter = 'all';

  var shopifySection = document.getElementById('shopifySection');
  var shopRefreshBtn = document.getElementById('shopRefreshBtn');
  var shopExportBtn = document.getElementById('shopExportBtn');
  var shopOrdersBody = document.getElementById('shopOrdersBody');
  var shopOrdersEmpty = document.getElementById('shopOrdersEmpty');
  var shopBestSellersBody = document.getElementById('shopBestSellersBody');
  var shopBestSellersEmpty = document.getElementById('shopBestSellersEmpty');
  var lastShopOrders = [];

  try {
    var savedKey = localStorage.getItem('nim_admin_key');
    if (savedKey) keyInput.value = savedKey;
  } catch (e) {}

  var toggleKeyBtn = document.getElementById('toggleKeyBtn');
  var eyeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
  var eyeOffIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18"/><path d="M10.6 5.2A10.6 10.6 0 0 1 12 5c6.5 0 10 7 10 7a17.9 17.9 0 0 1-3.2 4.2M6.6 6.6C3.9 8.3 2 12 2 12s3.5 7 10 7c1.4 0 2.7-.3 3.9-.8"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  toggleKeyBtn.addEventListener('click', function(){
    var showing = keyInput.type === 'text';
    keyInput.type = showing ? 'password' : 'text';
    toggleKeyBtn.innerHTML = showing ? eyeIcon : eyeOffIcon;
    toggleKeyBtn.title = showing ? 'Show admin key' : 'Hide admin key';
    toggleKeyBtn.setAttribute('aria-label', toggleKeyBtn.title);
  });

  function fmtDate(iso){ try { return new Date(iso).toLocaleString(); } catch(e){ return iso; } }
  function fmtDateOnly(iso){ try { return new Date(iso).toLocaleDateString(); } catch(e){ return iso; } }
  function fmtTimeOnly(iso){ try { return new Date(iso).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); } catch(e){ return iso; } }

  function render(){
    var filtered = currentFilter === 'all' ? lastEvents : lastEvents.filter(function(e){ return e.type === currentFilter; });
    tbody.innerHTML = '';
    if (!filtered.length){ emptyState.hidden = false; }
    else {
      emptyState.hidden = true;
      filtered.forEach(function(e){
        var tr = document.createElement('tr');
        var badgeClass = e.type === 'notified' ? 'notified' : 'signup';
        var badgeLabel = e.type === 'notified' ? 'Notified' : 'Signup';
        tr.innerHTML =
          '<td><span class="badge ' + badgeClass + '">' + badgeLabel + '</span></td>' +
          '<td>' + (e.phone || '') + '</td>' +
          '<td>' + (e.productTitle || '') + '</td>' +
          '<td>' + (e.variantTitle || e.variantId || '') + '</td>' +
          '<td>' + fmtDate(e.ts) + '</td>';
        tbody.appendChild(tr);
      });
    }
  }

  tabs.forEach(function(tab){
    tab.addEventListener('click', function(){
      tabs.forEach(function(t){ t.classList.remove('active'); });
      tab.classList.add('active');
      currentFilter = tab.getAttribute('data-filter');
      render();
    });
  });

  function csvField(val){
    var s = (val === null || val === undefined) ? '' : String(val);
    if (/[",\\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function downloadCSV(header, rows, filenamePrefix){
    if (!rows.length){
      statusLine.className = 'status-line error';
      statusLine.textContent = 'Nothing to export.';
      return;
    }
    var csv = header.map(csvField).join(',') + '\\n' + rows.map(function(r){ return r.map(csvField).join(','); }).join('\\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    a.href = url;
    a.download = filenamePrefix + '-' + stamp + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
  }

  function exportCSV(){
    var filtered = currentFilter === 'all' ? lastEvents : lastEvents.filter(function(e){ return e.type === currentFilter; });
    var header = ['Type', 'Phone', 'Product', 'Size', 'When'];
    var rows = filtered.map(function(e){
      var badgeLabel = e.type === 'notified' ? 'Notified' : 'Signup';
      return [badgeLabel, e.phone || '', e.productTitle || '', e.variantTitle || e.variantId || '', fmtDate(e.ts)];
    });
    downloadCSV(header, rows, 'notify-me-' + currentFilter);
  }

  exportBtn.addEventListener('click', exportCSV);

  function renderShopOrders(){
    shopOrdersBody.innerHTML = '';
    if (!lastShopOrders.length){
      shopOrdersEmpty.hidden = false;
      shopOrdersEmpty.textContent = 'No orders yet.';
      return;
    }
    shopOrdersEmpty.hidden = true;
    lastShopOrders.forEach(function(o){
      var tr = document.createElement('tr');
      var badgeClass = o.status === 'Paid' ? 'paid' : (o.status === 'Cancelled' ? 'cancelled' : 'pending');
      tr.innerHTML =
        '<td>' + (o.product || '') + '</td>' +
        '<td>' + (o.size || '') + '</td>' +
        '<td>' + (o.qty != null ? o.qty : '') + '</td>' +
        '<td><span class="badge ' + badgeClass + '">' + (o.status || '') + '</span></td>' +
        '<td>' + fmtDateOnly(o.createdAt) + '</td>' +
        '<td>' + fmtTimeOnly(o.createdAt) + '</td>';
      shopOrdersBody.appendChild(tr);
    });
  }

  function renderBestSellers(list){
    shopBestSellersBody.innerHTML = '';
    if (!list || !list.length){ shopBestSellersEmpty.hidden = false; return; }
    shopBestSellersEmpty.hidden = true;
    var colors = ['#4D1010', '#1F8A4C', '#A9760A', '#2B6CB0', '#7A4B94'];
    list.forEach(function(b, i){
      var row = document.createElement('div');
      row.className = 'bar-item';
      row.innerHTML =
        '<div class="bar-item-top"><span class="bar-item-name">' + (b.product || '') + '</span><span class="bar-item-val">' + b.units + ' units</span></div>' +
        '<div class="bar-track"><div class="bar-fill" style="width:' + b.share + '%; background:' + colors[i % colors.length] + '"></div></div>';
      shopBestSellersBody.appendChild(row);
    });
  }

  function shopExportCSV(){
    var header = ['Product', 'Size', 'Qty', 'Status', 'Date', 'Time'];
    var rows = lastShopOrders.map(function(o){
      return [o.product || '', o.size || '', o.qty != null ? o.qty : '', o.status || '', fmtDateOnly(o.createdAt), fmtTimeOnly(o.createdAt)];
    });
    downloadCSV(header, rows, 'evara-orders');
  }

  shopExportBtn.addEventListener('click', shopExportCSV);

  async function loadShopifyStats(key){
    try {
      var resp = await fetch('/admin/shopify-stats?key=' + encodeURIComponent(key));
      if (!resp.ok) {
        var errBody = await resp.json().catch(function(){ return {}; });
        shopifySection.hidden = false;
        shopOrdersEmpty.hidden = false;
        shopOrdersEmpty.textContent = errBody.error || ('Could not load store data (HTTP ' + resp.status + ').');
        return;
      }
      var data = await resp.json();
      shopifySection.hidden = false;
      document.getElementById('shopOrdersCompleted').textContent = data.ordersCompleted;
      document.getElementById('shopOrdersPending').textContent = data.ordersPending;
      document.getElementById('shopOrdersCancelled').textContent = data.ordersCancelled;
      document.getElementById('shopCustomers').textContent = data.totalCustomers;
      lastShopOrders = data.recentOrders || [];
      renderShopOrders();
      renderBestSellers(data.bestSellers || []);
    } catch (err) {
      shopifySection.hidden = false;
      shopOrdersEmpty.hidden = false;
      shopOrdersEmpty.textContent = 'Could not load store data (' + err.message + ').';
    }
  }

  shopRefreshBtn.addEventListener('click', function(){
    var key = (keyInput.value || '').trim();
    if (key) loadShopifyStats(key);
  });

  async function load(){
    var key = (keyInput.value || '').trim();
    if (!key){ statusLine.className = 'status-line error'; statusLine.textContent = 'Enter the admin key.'; return; }
    try { localStorage.setItem('nim_admin_key', key); } catch(e){}
    loadBtn.disabled = true; refreshBtn.disabled = true;
    statusLine.className = 'status-line';
    statusLine.textContent = 'Loading...';
    try {
      var resp = await fetch('/admin/stats?key=' + encodeURIComponent(key));
      if (resp.status === 401){
        statusLine.className = 'status-line error';
        statusLine.textContent = 'Unauthorized - check the admin key.';
        loadBtn.disabled = false; refreshBtn.disabled = false;
        return;
      }
      if (!resp.ok) throw new Error('HTTP ' + resp.status);
      var data = await resp.json();
      lastEvents = data.events || [];
      document.getElementById('statSignups').textContent = data.totalSignups != null ? data.totalSignups : '-';
      document.getElementById('statNotified').textContent = data.totalNotified != null ? data.totalNotified : '-';
      document.getElementById('statWaiting').textContent = data.currentlyWaiting != null ? data.currentlyWaiting : '-';
      content.hidden = false;
      statusLine.textContent = 'Last updated ' + new Date().toLocaleTimeString();
      render();
      loadShopifyStats(key);
    } catch (err) {
      statusLine.className = 'status-line error';
      statusLine.textContent = 'Could not load stats (' + err.message + '). Wait a few seconds and click Refresh.';
    } finally {
      loadBtn.disabled = false; refreshBtn.disabled = false;
    }
  }

  loadBtn.addEventListener('click', load);
  refreshBtn.addEventListener('click', load);
  try { if (localStorage.getItem('nim_admin_key')) load(); } catch(e){}
})();
</script>
</body>
</html>`;

app.get('/dashboard', (req, res) => {
  res.type('html').send(DASHBOARD_HTML);
});

app.listen(process.env.PORT || 3000, () => console.log('Server running!'));
