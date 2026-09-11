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

// Dashboard page itself — served from this same domain (not claude.ai) so its
// fetch() calls to /admin/stats are same-origin and never get blocked as
// cross-site. Static HTML/CSS/JS only, no external calls besides this API.
const DASHBOARD_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Notify Me Dashboard</title>
<style>
:root{
  --bg:#f6f7f5; --card:#ffffff; --border:#e3e5e0; --text:#1c1f1a; --muted:#6b7268;
  --accent:#1f8a4c; --accent-soft:#e6f4ec; --waiting:#b8860b; --waiting-soft:#fbf1dc;
  --danger:#b3261e; --input-bg:#ffffff;
}
@media (prefers-color-scheme: dark){
  :root{
    --bg:#151713; --card:#1e211c; --border:#2c2f28; --text:#eef0ea; --muted:#9aa196;
    --accent:#3fbd74; --accent-soft:#173824; --waiting:#e0b13a; --waiting-soft:#332608;
    --danger:#ff6b62; --input-bg:#262a22;
  }
}
*{box-sizing:border-box;}
body{background:var(--bg); color:var(--text); margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; padding:20px 16px 48px;}
.wrap{max-width:920px; margin:0 auto;}
h1{font-size:1.35rem; margin:0 0 4px;}
.sub{color:var(--muted); font-size:0.88rem; margin:0 0 20px;}
.setup{background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px; margin-bottom:20px;}
.setup label{display:block; font-size:0.78rem; color:var(--muted); margin-bottom:4px;}
.setup-row{display:flex; gap:10px; flex-wrap:wrap; align-items:flex-end;}
.field{flex:1; min-width:180px;}
input[type="password"]{width:100%; padding:9px 10px; border-radius:8px; border:1px solid var(--border); background:var(--input-bg); color:var(--text); font-size:0.9rem;}
button{padding:9px 16px; border-radius:8px; border:1px solid var(--accent); background:var(--accent); color:#fff; font-size:0.9rem; cursor:pointer; font-weight:600;}
button.secondary{background:transparent; color:var(--text); border-color:var(--border); font-weight:500;}
button:disabled{opacity:0.55; cursor:default;}
.status-line{font-size:0.82rem; color:var(--muted); margin-top:10px;}
.status-line.error{color:var(--danger);}
.cards{display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:12px; margin-bottom:20px;}
.card{background:var(--card); border:1px solid var(--border); border-radius:12px; padding:16px;}
.card .n{font-size:1.7rem; font-weight:700; line-height:1.1;}
.card .l{font-size:0.8rem; color:var(--muted); margin-top:4px;}
.toolbar{display:flex; gap:8px; align-items:center; margin-bottom:12px; flex-wrap:wrap;}
.tab{padding:6px 12px; border-radius:999px; border:1px solid var(--border); background:transparent; color:var(--text); font-size:0.82rem; cursor:pointer; font-weight:500;}
.tab.active{background:var(--accent-soft); border-color:var(--accent); color:var(--accent);}
.table-wrap{background:var(--card); border:1px solid var(--border); border-radius:12px; overflow:auto; max-width:100%;}
table{border-collapse:collapse; width:100%; font-size:0.85rem; min-width:560px;}
th,td{text-align:left; padding:10px 12px; border-bottom:1px solid var(--border); white-space:nowrap;}
th{color:var(--muted); font-weight:600; font-size:0.75rem; text-transform:uppercase; letter-spacing:0.03em;}
tr:last-child td{border-bottom:none;}
.badge{display:inline-block; padding:2px 9px; border-radius:999px; font-size:0.72rem; font-weight:600;}
.badge.signup{background:var(--waiting-soft); color:var(--waiting);}
.badge.notified{background:var(--accent-soft); color:var(--accent);}
.empty{padding:32px 16px; text-align:center; color:var(--muted); font-size:0.88rem;}
</style>
</head>
<body>
<div class="wrap">
<h1>Notify Me Dashboard</h1>
<p class="sub">Every WhatsApp restock-alert signup on your store, logged and counted.</p>

<div class="setup">
<div class="setup-row">
<div class="field">
<label for="adminKey">Admin key</label>
<input type="password" id="adminKey" placeholder="ADMIN_KEY value">
</div>
<button id="loadBtn" type="button">Load</button>
</div>
<div class="status-line" id="statusLine">Enter your admin key and click Load. (This service can take up to a minute to wake up if it has been idle.)</div>
</div>

<div id="content" hidden>
<div class="cards">
<div class="card"><div class="n" id="statSignups">-</div><div class="l">Total notify-me signups</div></div>
<div class="card"><div class="n" id="statNotified">-</div><div class="l">Restock alerts sent</div></div>
<div class="card"><div class="n" id="statWaiting">-</div><div class="l">Currently waiting</div></div>
</div>

<div class="toolbar">
<button class="tab active" data-filter="all" type="button">All</button>
<button class="tab" data-filter="signup" type="button">Signups</button>
<button class="tab" data-filter="notified" type="button">Notified</button>
<button class="secondary" id="exportBtn" type="button" style="margin-left:auto;">Export CSV</button>
<button class="secondary" id="refreshBtn" type="button">Refresh</button>
</div>

<div class="table-wrap">
<table>
<thead><tr><th>Type</th><th>Phone</th><th>Product</th><th>Size</th><th>When</th></tr></thead>
<tbody id="eventsBody"></tbody>
</table>
<div class="empty" id="emptyState" hidden>No events yet.</div>
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

try {
  var savedKey = localStorage.getItem('nim_admin_key');
  if (savedKey) keyInput.value = savedKey;
} catch (e) {}

function fmtDate(iso){ try { return new Date(iso).toLocaleString(); } catch(e){ return iso; } }

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

function exportCSV(){
  var filtered = currentFilter === 'all' ? lastEvents : lastEvents.filter(function(e){ return e.type === currentFilter; });
  if (!filtered.length){
    statusLine.className = 'status-line error';
    statusLine.textContent = 'Nothing to export for this filter.';
    return;
  }
  var header = ['Type', 'Phone', 'Product', 'Size', 'When'];
  var rows = filtered.map(function(e){
    var badgeLabel = e.type === 'notified' ? 'Notified' : 'Signup';
    return [
      badgeLabel,
      e.phone || '',
      e.productTitle || '',
      e.variantTitle || e.variantId || '',
      fmtDate(e.ts)
    ].map(csvField).join(',');
  });
  var csv = header.map(csvField).join(',') + '\\n' + rows.join('\\n');
  var blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  a.href = url;
  a.download = 'notify-me-' + currentFilter + '-' + stamp + '.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(function(){ URL.revokeObjectURL(url); }, 1000);
}

exportBtn.addEventListener('click', exportCSV);

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
