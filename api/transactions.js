import SellingPartner from 'amazon-sp-api';
import { kv } from '@vercel/kv';

// ─── ROUTER ──────────────────────────────────────────────────────────────────
//   GET  ?action=sync            [&month=YYYY-MM]            — pull SP-API → KV
//   GET  ?action=get             &month=YYYY-MM              — raw pages, one month
//   GET  ?action=get-range       &startMonth=&endMonth=      — raw pages, many months
//   GET  ?action=get-months                                  — list of synced months
//   GET  ?action=fetch-order-raw &orderId=                   — one order straight from SP-API
//
// KV layout (raw only — no pre-processed store):
//   transactions:raw:YYYY-MM         → { pages: [<FinancialEvents>, ...] }
//   transactions:index               → ['YYYY-MM', ...]
//   transactions:last-synced:YYYY-MM → ISO timestamp
//
// The derivation into report-ready rows happens client-side in
// overview-upstash.js so mapping changes don't require a re-sync.
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
    if (action === 'sync')            return handleSync(req, res);
    if (action === 'get')             return handleGet(req, res);
    if (action === 'get-range')       return handleGetRange(req, res);
    if (action === 'get-months')      return handleGetMonths(req, res);
    if (action === 'fetch-order-raw') return handleFetchOrderRaw(req, res);
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

    console.log(`[TRANSACTIONS SYNC] Starting sync for ${month}`);

    const { start, end } = monthBounds(month);
    const { pages, pageCount, eventCount } = await fetchFinancialEvents(start, end);

    await kv.set(`transactions:raw:${month}`, { pages });
    const index = (await kv.get('transactions:index')) || [];
    const updatedIndex = [...new Set([...index, month])].sort();
    await kv.set('transactions:index', updatedIndex);
    await kv.set(`transactions:last-synced:${month}`, new Date().toISOString());

    console.log(`[TRANSACTIONS SYNC] ${month}: pages=${pageCount} events=${eventCount}`);
    return res.status(200).json({
      success: true,
      month,
      pageCount,
      eventCount,
      message: `Transactions sync complete for ${month}`
    });
  } catch (error) {
    console.error('[TRANSACTIONS SYNC] Error:', error);
    return res.status(500).json({ success: false, error: 'Sync failed: ' + error.message });
  }
}

// ─── READ ────────────────────────────────────────────────────────────────────
async function handleGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month=YYYY-MM required' });
    }

    const [stored, lastSynced] = await Promise.all([
      kv.get(`transactions:raw:${month}`),
      kv.get(`transactions:last-synced:${month}`)
    ]);

    return res.status(200).json({
      success: true,
      month,
      pages: stored?.pages || [],
      lastSynced: lastSynced || null
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get transactions: ' + error.message });
  }
}

async function handleGetRange(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { startMonth, endMonth } = req.query;
    if (!startMonth || !endMonth) {
      return res.status(400).json({ error: 'startMonth and endMonth required (YYYY-MM)' });
    }

    const index = (await kv.get('transactions:index')) || [];
    const months = index.filter(m => m >= startMonth && m <= endMonth);
    const buckets = await Promise.all(months.map(m => kv.get(`transactions:raw:${m}`)));

    // Flatten: all months' pages concatenated into one pages array. Order is
    // month-then-page within month, matching how the raw data was synced.
    const pages = [];
    for (const b of buckets) {
      if (!b || !Array.isArray(b.pages)) continue;
      for (const p of b.pages) pages.push(p);
    }

    return res.status(200).json({ success: true, startMonth, endMonth, months, pages });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get range: ' + error.message });
  }
}

async function handleGetMonths(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const index = (await kv.get('transactions:index')) || [];
    return res.status(200).json({ success: true, months: index });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to list months: ' + error.message });
  }
}

// Fetches a single order directly from SP-API (bypasses KV entirely). For
// debugging / schema discovery — returns exactly what listFinancialEventsByOrderId
// produced, no reshaping. Paginates in case the order has more events than
// fit on one page.
async function handleFetchOrderRaw(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const orderId = req.query.orderId;
    if (!orderId) return res.status(400).json({ error: 'orderId query param required' });

    const sp = createSellingPartner();
    const pages = [];
    let nextToken = null;
    let calls = 0;
    do {
      const raw = await sp.callAPI({
        operation: 'listFinancialEventsByOrderId',
        endpoint: 'finances',
        path: { orderId },
        query: { MaxResultsPerPage: 100, ...(nextToken ? { NextToken: nextToken } : {}) }
      });
      const body = raw?.payload ?? raw ?? {};
      pages.push(body);
      nextToken = body.NextToken || body.nextToken || null;
      calls++;
      if (nextToken) await sleep(500);
    } while (nextToken && calls < 20);

    return res.status(200).json({ success: true, orderId, pageCount: calls, pages });
  } catch (error) {
    console.error('[FETCH ORDER RAW] Error:', error);
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

// ─── SP-API FETCH ────────────────────────────────────────────────────────────

function createSellingPartner() {
  return new SellingPartner({
    region: 'na',
    refresh_token: process.env.AMAZON_REFRESH_TOKEN,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: process.env.AMAZON_LWA_CLIENT_ID,
      SELLING_PARTNER_APP_CLIENT_SECRET: process.env.AMAZON_LWA_CLIENT_SECRET
    }
  });
}

async function fetchFinancialEvents(postedAfter, postedBefore) {
  const sp = createSellingPartner();
  const pages = [];
  let nextToken = null;
  let calls = 0;
  let eventCount = 0;

  do {
    const raw = await sp.callAPI({
      operation: 'listFinancialEvents',
      endpoint: 'finances',
      query: {
        PostedAfter: postedAfter,
        PostedBefore: postedBefore,
        MaxResultsPerPage: 100,
        ...(nextToken ? { NextToken: nextToken } : {})
      }
    });
    const body = raw?.payload ?? raw ?? {};
    const financialEvents = body.FinancialEvents || body.financialEvents || {};
    nextToken = body.NextToken || body.nextToken || null;

    const pageEvents = countEvents(financialEvents);
    eventCount += pageEvents;
    pages.push(financialEvents);
    calls++;

    console.log(`[TRANSACTIONS SYNC] page ${calls}: events=${pageEvents} hasNextToken=${!!nextToken}`);
    if (nextToken) await sleep(500);
  } while (nextToken && calls < 200);

  return { pages, pageCount: calls, eventCount };
}

function countEvents(fe) {
  const lists = [
    'ShipmentEventList', 'RefundEventList', 'GuaranteeClaimEventList',
    'ChargebackEventList', 'ServiceFeeEventList', 'AdjustmentEventList',
    'PayWithAmazonEventList', 'RentalTransactionEventList',
    'ProductAdsPaymentEventList', 'RetrochargeEventList',
    'PerformanceBondRefundEventList', 'TrialShipmentEventList'
  ];
  let total = 0;
  for (const name of lists) {
    const arr = fe[name];
    if (Array.isArray(arr)) total += arr.length;
  }
  return total;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function verifyGoogleToken(req) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return { ok: false, error: 'No access token provided' };
  const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verify.ok) return { ok: false, error: 'Invalid access token' };
  return { ok: true };
}

function monthBounds(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const startDate = new Date(Date.UTC(y, m - 1, 1));
  const endDate = new Date(Date.UTC(y, m, 1));
  return {
    start: startDate.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    end:   endDate.toISOString().replace(/\.\d{3}Z$/, 'Z')
  };
}

function previousMonthISO() {
  const now = new Date();
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
