import SellingPartner from 'amazon-sp-api';
import { kv } from '@vercel/kv';

// ─── ROUTER ──────────────────────────────────────────────────────────────────
//   GET  ?action=sync            [&month=YYYY-MM]            — pull SP-API → KV
//   GET  ?action=get             &month=YYYY-MM              — raw pages, one month
//   GET  ?action=get-range       &startMonth=&endMonth=      — raw pages, many months
//   GET  ?action=get-months                                  — list of synced months
//   GET  ?action=fetch-order-raw &orderId=                   — one order straight from SP-API
//   GET  ?action=probe-v2024     [&month=|&orderId=]         — Finances v2024-06-19 probe (see below)
//
// probe-v2024 is a diagnostic for the planned migration away from v0
// listFinancialEvents. The v0 endpoint silently excludes Deferred
// transactions (notably B2B Invoiced Orders), so we're investigating the
// newer v2024-06-19 listTransactions endpoint which surfaces them with
// a transactionStatus field. This probe issues a tiny (1-day default, or
// month-bounded, or order-id-filtered) request and returns the raw shape
// + a summary so we can map breakdownType strings and deferralReasons to
// our statement lines before writing production sync code.
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
    if (action === 'probe-v2024')     return handleProbeV2024(req, res);
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

// ─── FINANCES v2024-06-19 PROBE ──────────────────────────────────────────────
// Diagnostic-only. Does NOT write to KV. Issues listTransactions against the
// new Finances API surface and returns the raw response plus a summary
// (counts by transactionType / transactionStatus, every breakdownType and
// deferralReason seen, the first transaction, and the first deferred
// transaction found). Three input modes, in priority order:
//   &orderId=114-...      — filter to one order (fastest, use this to find
//                           the known-missing $6,412 sale)
//   &month=YYYY-MM        — month window, capped at 10 paginated calls
//   (default)             — last 24h, capped at 5 paginated calls
//
// Uses api_path to bypass whatever operation map the amazon-sp-api library
// bundles — works regardless of library version. The library still signs
// the request and manages the access token normally.
async function handleProbeV2024(req, res) {
  try {
    // No Google auth check — matches handleSync's posture. SP-API creds
    // live in env vars, the endpoint is bounded (pagination cap), and
    // there are no KV writes. Paste the URL straight into a browser.
    const { orderId, month } = req.query;
    // &summary=1 drops allTransactions from the response so a month-wide
    // probe doesn't dump 1000+ records. Summary fields + sampleFirst /
    // sampleDeferred still come through (enough to map breakdowns).
    const summaryOnly = req.query.summary === '1' || req.query.summary === 'true';
    let query;
    let maxCalls;
    if (orderId) {
      // relatedIdentifierName/Value is the documented filter as of 2026-01-28.
      // postedAfter is required and Amazon rejects anything older than
      // ~2 years from now, so use "now minus 23 months" — the widest window
      // Amazon will accept.
      const now = new Date();
      const windowStart = new Date(now.getTime());
      windowStart.setUTCMonth(windowStart.getUTCMonth() - 23);
      query = {
        relatedIdentifierName: 'ORDER_ID',
        relatedIdentifierValue: orderId,
        postedAfter: windowStart.toISOString().replace(/\.\d{3}Z$/, 'Z')
      };
      maxCalls = 20;
    } else if (month) {
      if (!/^\d{4}-\d{2}$/.test(month)) {
        return res.status(400).json({ error: 'month must be YYYY-MM' });
      }
      const { start, end } = monthBounds(month);
      query = { postedAfter: start, postedBefore: end };
      maxCalls = 50;
    } else {
      const now = new Date();
      const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
      query = {
        postedAfter: dayAgo.toISOString().replace(/\.\d{3}Z$/, 'Z'),
        postedBefore: now.toISOString().replace(/\.\d{3}Z$/, 'Z')
      };
      maxCalls = 5;
    }

    const sp = createSellingPartner();
    const transactions = [];
    let nextToken = null;
    let calls = 0;

    do {
      const raw = await sp.callAPI({
        api_path: '/finances/2024-06-19/transactions',
        method: 'GET',
        query: { ...query, ...(nextToken ? { nextToken } : {}) }
      });
      const body = raw?.payload ?? raw ?? {};
      const list = Array.isArray(body.transactions) ? body.transactions : [];
      transactions.push(...list);
      nextToken = body.nextToken || null;
      calls++;
      console.log(`[PROBE V2024] page ${calls}: transactions=${list.length} hasNextToken=${!!nextToken}`);
      // Rate limit is 0.5 req/s with burst of 10, so 2.2s between calls is safe.
      if (nextToken && calls < maxCalls) await sleep(2200);
    } while (nextToken && calls < maxCalls);

    // Summary: what types/statuses came back, what breakdownType strings
    // appear (so we know how to map to FBA Fees / Selling Fees / etc.), and
    // what deferralReasons we see (so we know what to look for in production
    // sync). All transactions included in the response for manual inspection.
    const byType = {};
    const byStatus = {};
    const breakdownTypes = new Set();
    const deferralReasons = new Set();
    const relatedIdentifierNames = new Set();
    let sampleDeferred = null;

    const walkBreakdowns = (bs) => {
      for (const b of (bs || [])) {
        if (b?.breakdownType) breakdownTypes.add(b.breakdownType);
        if (Array.isArray(b?.breakdowns)) walkBreakdowns(b.breakdowns);
      }
    };

    for (const t of transactions) {
      const tType = t.transactionType || '(null)';
      const tStatus = t.transactionStatus || '(null)';
      byType[tType] = (byType[tType] || 0) + 1;
      byStatus[tStatus] = (byStatus[tStatus] || 0) + 1;
      walkBreakdowns(t.breakdowns);
      for (const item of (t.items || [])) walkBreakdowns(item.breakdowns);
      for (const ctx of (t.contexts || [])) {
        if (ctx?.deferralReason) deferralReasons.add(ctx.deferralReason);
      }
      for (const rid of (t.relatedIdentifiers || [])) {
        if (rid?.relatedIdentifierName) relatedIdentifierNames.add(rid.relatedIdentifierName);
      }
      if (!sampleDeferred && (tStatus === 'DEFERRED' || tStatus === 'DEFERRED_RELEASED')) {
        sampleDeferred = t;
      }
    }

    const response = {
      success: true,
      query,
      pageCount: calls,
      hitPageCap: nextToken !== null && calls >= maxCalls,
      totalTransactions: transactions.length,
      byType,
      byStatus,
      breakdownTypesSeen: [...breakdownTypes].sort(),
      deferralReasonsSeen: [...deferralReasons].sort(),
      relatedIdentifierNamesSeen: [...relatedIdentifierNames].sort(),
      sampleFirst: transactions[0] || null,
      sampleDeferred
    };
    if (!summaryOnly) response.allTransactions = transactions;
    return res.status(200).json(response);
  } catch (error) {
    console.error('[PROBE V2024] Error:', error);
    return res.status(500).json({ error: 'Probe failed: ' + error.message, stack: error.stack });
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
