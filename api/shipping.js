import { kv } from '@vercel/kv';

// ─── ROUTER ──────────────────────────────────────────────────────────────────
// ShipStation V1 API (ssapi.shipstation.com) with HTTP Basic auth.
//
//   GET  ?action=sync            [&month=YYYY-MM]  — pull ShipStation → KV
//   GET  ?action=get             &month=YYYY-MM    — rows for one month
//   GET  ?action=get-range       &startMonth=&endMonth=
//   GET  ?action=get-months                        — list of synced months
//   POST ?action=migrate-from-sheets               — backfill from Sheets tab
//   POST ?action=delete-sheets-rows                — cleanup helper (same
//                                                     pattern as adspend)
//
// Env vars:
//   SHIPSTATION_API_KEY
//   SHIPSTATION_API_SECRET
//
// KV layout:
//   shipping:raw:YYYY-MM           → { rows: [...] }
//   shipping:index                 → ['YYYY-MM', ...]
//   shipping:last-synced:YYYY-MM   → ISO timestamp
//
// Row shape (unified across API + Sheets backfill):
//   { shipDate, orderId, sku, qty, cost, carrier?, service? }
// API rows populate sku/qty by walking shipmentItems and allocating the
// shipment's total cost across items by quantity (so a shipment of 3×A + 2×B
// with $5 shipping produces rows A:$3.00, B:$2.00). Sheets rows have no
// sku — shipping cost for those still lands in FBM Shipping Costs totals
// but loses per-SKU drill-down.
export default async function handler(req, res) {
  const { action } = req.query;
  if (!action) return res.status(400).json({ error: 'Action parameter required' });

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    if (action === 'sync')                return handleSync(req, res);
    if (action === 'get')                 return handleGet(req, res);
    if (action === 'get-range')           return handleGetRange(req, res);
    if (action === 'get-months')          return handleGetMonths(req, res);
  }
  if (req.method === 'POST') {
    if (action === 'migrate-from-sheets') return handleMigrateFromSheets(req, res);
    if (action === 'delete-sheets-rows')  return handleDeleteSheetsRows(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── SYNC ────────────────────────────────────────────────────────────────────
async function handleSync(req, res) {
  try {
    const month = req.query.month || previousMonthISO();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }
    if (!process.env.SHIPSTATION_API_KEY || !process.env.SHIPSTATION_API_SECRET) {
      return res.status(500).json({ error: 'SHIPSTATION_API_KEY / SHIPSTATION_API_SECRET not set' });
    }

    console.log(`[SHIPPING SYNC] Starting sync for ${month}`);
    const { start, end } = monthBoundDates(month);
    const shipments = await fetchAllShipments(start, end);
    const rows = normalizeShipments(shipments);

    await kv.set(`shipping:raw:${month}`, { rows });
    const index = (await kv.get('shipping:index')) || [];
    if (!index.includes(month)) {
      index.push(month);
      index.sort();
      await kv.set('shipping:index', index);
    }
    await kv.set(`shipping:last-synced:${month}`, new Date().toISOString());

    console.log(`[SHIPPING SYNC] ${month}: shipments=${shipments.length} rows=${rows.length}`);
    return res.status(200).json({
      success: true,
      month,
      shipmentCount: shipments.length,
      rows: rows.length,
      totalCost: round2(rows.reduce((s, r) => s + (r.cost || 0), 0)),
      message: `Synced ${shipments.length} shipments → ${rows.length} per-SKU rows for ${month}`
    });
  } catch (error) {
    console.error('[SHIPPING SYNC] Error:', error);
    return res.status(500).json({ error: 'Sync failed: ' + error.message });
  }
}

// ─── READ ────────────────────────────────────────────────────────────────────
async function handleGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { month } = req.query;
    if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month=YYYY-MM required' });

    const [stored, lastSynced] = await Promise.all([
      kv.get(`shipping:raw:${month}`),
      kv.get(`shipping:last-synced:${month}`)
    ]);
    return res.status(200).json({
      success: true,
      month,
      rows: stored?.rows || [],
      lastSynced: lastSynced || null
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

async function handleGetRange(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { startMonth, endMonth } = req.query;
    if (!startMonth || !endMonth) return res.status(400).json({ error: 'startMonth and endMonth required' });

    const index = (await kv.get('shipping:index')) || [];
    const months = index.filter(m => m >= startMonth && m <= endMonth);
    const buckets = await Promise.all(months.map(m => kv.get(`shipping:raw:${m}`)));
    const rows = [];
    for (const b of buckets) {
      if (b && Array.isArray(b.rows)) for (const r of b.rows) rows.push(r);
    }
    return res.status(200).json({ success: true, startMonth, endMonth, months, rows });
  } catch (error) {
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

async function handleGetMonths(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const index = (await kv.get('shipping:index')) || [];
    return res.status(200).json({ success: true, months: index });
  } catch (error) {
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

// ─── MIGRATE FROM SHEETS ─────────────────────────────────────────────────────
// Reads the Sheets ShippingCosts tab (Order #, Ship Date, Shipping Cost).
// Historical rows don't have SKU — stored with sku='' so the client can
// choose to lump them into the FBM total or surface as "pre-API" shipments.
async function handleMigrateFromSheets(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const accessToken = req.headers.authorization?.replace('Bearer ', '');

    const spreadsheetId = req.body?.spreadsheetId;
    if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId required' });

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/ShippingCosts`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!r.ok) return res.status(502).json({ error: `ShippingCosts read failed (${r.status})` });
    const values = (await r.json()).values || [];
    if (values.length < 2) return res.status(200).json({ success: true, rows: 0, skippedMonths: [] });

    const headers = values[0].map(h => String(h || '').trim().toLowerCase());
    const iDate  = headers.indexOf('ship date');
    const iOrder = headers.findIndex(h => h === 'order #' || h === 'order number' || h === 'orderid');
    const iCost  = headers.indexOf('shipping cost');
    if (iDate === -1 || iCost === -1) {
      return res.status(400).json({ error: 'ShippingCosts missing required columns (Ship Date, Shipping Cost)' });
    }

    const byMonth = {};
    for (let i = 1; i < values.length; i++) {
      const row = values[i] || [];
      const shipDate = String(row[iDate] || '').trim().substring(0, 10);
      const cost = parseFloat(row[iCost]);
      if (!shipDate || !/^\d{4}-\d{2}-\d{2}$/.test(shipDate) || !Number.isFinite(cost)) continue;
      const month = shipDate.substring(0, 7);
      if (!byMonth[month]) byMonth[month] = [];
      byMonth[month].push({
        shipDate,
        orderId: iOrder === -1 ? '' : String(row[iOrder] || '').trim(),
        sku: '',
        qty: 0,
        cost
      });
    }

    // Same "skip if API data present" rule as ad spend. API rows have sku.
    const index = (await kv.get('shipping:index')) || [];
    let writtenRows = 0;
    const skippedMonths = [];
    for (const [month, rows] of Object.entries(byMonth)) {
      const existing = await kv.get(`shipping:raw:${month}`);
      const existingRows = (existing && Array.isArray(existing.rows)) ? existing.rows : [];
      if (existingRows.some(r => r && r.sku)) {
        skippedMonths.push(month);
        continue;
      }
      await kv.set(`shipping:raw:${month}`, { rows });
      writtenRows += rows.length;
      if (!index.includes(month)) index.push(month);
    }
    index.sort();
    await kv.set('shipping:index', index);

    return res.status(200).json({
      success: true,
      rows: writtenRows,
      skippedMonths,
      message: `Migrated ${writtenRows} rows; skipped ${skippedMonths.length} months with existing API data.`
    });
  } catch (error) {
    return res.status(500).json({ error: 'Migrate failed: ' + error.message });
  }
}

// ─── DELETE SHEETS-ONLY ROWS (same cleanup helper as adspend) ────────────────
async function handleDeleteSheetsRows(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const { month } = req.body || {};
    if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month=YYYY-MM required' });

    const stored = await kv.get(`shipping:raw:${month}`);
    const rows = (stored && Array.isArray(stored.rows)) ? stored.rows : [];
    const before = rows.length;
    const kept = rows.filter(r => r && typeof r.sku === 'string' && r.sku.length > 0);
    await kv.set(`shipping:raw:${month}`, { rows: kept });
    return res.status(200).json({
      success: true, month,
      before: { rows: before, totalCost: round2(rows.reduce((s, r) => s + (r.cost || 0), 0)) },
      after:  { rows: kept.length, totalCost: round2(kept.reduce((s, r) => s + (r.cost || 0), 0)) },
      dropped: before - kept.length
    });
  } catch (error) {
    return res.status(500).json({ error: 'Delete failed: ' + error.message });
  }
}

// ─── SHIPSTATION API CLIENT ──────────────────────────────────────────────────

function ssAuthHeader() {
  const basic = Buffer.from(
    `${process.env.SHIPSTATION_API_KEY}:${process.env.SHIPSTATION_API_SECRET}`
  ).toString('base64');
  return { Authorization: `Basic ${basic}`, Accept: 'application/json' };
}

// Walks ShipStation's /shipments endpoint with pagination and returns every
// shipment in [start, end]. includeShipmentItems=true attaches the items
// array so we can do per-SKU cost allocation.
async function fetchAllShipments(shipDateStart, shipDateEnd) {
  const all = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = `https://ssapi.shipstation.com/shipments?` +
                `shipDateStart=${shipDateStart}&shipDateEnd=${shipDateEnd}` +
                `&pageSize=500&page=${page}&includeShipmentItems=true`;
    const res = await fetch(url, { headers: ssAuthHeader() });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ShipStation ${res.status}: ${text}`);
    }
    const body = await res.json();
    const shipments = body.shipments || [];
    all.push(...shipments);
    totalPages = Number(body.pages) || 1;

    // ShipStation rate limit is 40/min. Light throttle between pages keeps
    // us well under even with a busy month.
    if (page < totalPages) await sleep(500);
    page++;
  } while (page <= totalPages && page < 200);

  return all;
}

// Expand each shipment into one row per SKU, allocating the shipment's total
// cost across items by quantity. A 3×A + 2×B shipment at $5.00 gets split
// A:$3.00, B:$2.00. Shipments with no itemized detail emit one sku-less row
// carrying the full cost so the monthly total still reconciles.
function normalizeShipments(shipments) {
  const rows = [];
  for (const s of shipments) {
    const shipDate = (s.shipDate || '').substring(0, 10);
    if (!shipDate) continue;
    const orderId = s.orderNumber || String(s.orderId || '') || '';
    const cost = Number(s.shipmentCost) || 0;
    const carrier = s.carrierCode || '';
    const service = s.serviceCode || '';
    const items = Array.isArray(s.shipmentItems) ? s.shipmentItems : [];

    if (items.length === 0) {
      rows.push({ shipDate, orderId, sku: '', qty: 0, cost: round2(cost), carrier, service });
      continue;
    }
    const totalQty = items.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);
    if (totalQty === 0) {
      // Items present but qty zero — treat as sku-less to not lose the cost.
      rows.push({ shipDate, orderId, sku: '', qty: 0, cost: round2(cost), carrier, service });
      continue;
    }
    for (const item of items) {
      const qty = Number(item.quantity) || 0;
      if (qty === 0) continue;
      const allocated = cost * (qty / totalQty);
      rows.push({
        shipDate,
        orderId,
        sku: String(item.sku || '').trim(),
        qty,
        cost: round2(allocated),
        carrier,
        service
      });
    }
  }
  return rows;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function verifyGoogleToken(req) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return { ok: false, error: 'No access token provided' };
  const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verify.ok) return { ok: false, error: 'Invalid access token' };
  return { ok: true };
}

function monthBoundDates(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const endExclusive = new Date(Date.UTC(y, m, 1));
  const endInclusive = new Date(endExclusive.getTime() - 86400000);
  const ymd = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  return { start: ymd(start), end: ymd(endInclusive) };
}

function previousMonthISO() {
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
