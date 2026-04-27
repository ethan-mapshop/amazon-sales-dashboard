import SellingPartner from 'amazon-sp-api';
import { kv } from '@vercel/kv';

// ─── ROUTER ──────────────────────────────────────────────────────────────────
//   GET  ?action=sync            [&month=YYYY-MM]            — pull SP-API → KV (v0 listFinancialEvents)
//   GET  ?action=get             &month=YYYY-MM              — raw pages, one month
//   GET  ?action=get-range       &startMonth=&endMonth=      — raw pages, many months
//   GET  ?action=get-months                                  — list of synced months
//   GET  ?action=fetch-order-raw &orderId=                   — one order straight from SP-API
//   GET  ?action=probe-v2024     [&month=|&orderId=]         — Finances v2024-06-19 probe (see below)
//   GET  ?action=sync-v2024      [&month=YYYY-MM]            — pull SP-API listTransactions → KV
//   GET  ?action=get-v2024       &month=YYYY-MM              — raw transactions, one month
//   GET  ?action=get-range-v2024 &startMonth=&endMonth=      — raw transactions, many months
//   GET  ?action=get-months-v2024                            — list of v2024-synced months
//
// probe-v2024 is the diagnostic that confirmed v0 listFinancialEvents
// silently excludes Deferred transactions (notably B2B Invoiced Orders).
// sync-v2024 / get-v2024 are the production migration off v0 — they hit
// the v2024-06-19 listTransactions endpoint which surfaces deferred
// transactions with transactionStatus DEFERRED|RELEASED|DEFERRED_RELEASED.
// Dedup rule (skip RELEASED with DEFERRED_TRANSACTION_ID) lives in the
// derivation, not here — see _deriveV2024Rows in overview-upstash.js.
//
// KV layout — v0 (legacy, will be retired after v2024 cutover):
//   transactions:raw:YYYY-MM         → { pages: [<FinancialEvents>, ...] }
//   transactions:index               → ['YYYY-MM', ...]
//   transactions:last-synced:YYYY-MM → ISO timestamp
//
// KV layout — v2024 (parallel during migration, replaces v0 after cutover):
//   transactions:v2024:raw:YYYY-MM         → { transactions: [<Transaction>, ...] }
//   transactions:v2024:index               → ['YYYY-MM', ...]
//   transactions:v2024:last-synced:YYYY-MM → ISO timestamp
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
    if (action === 'sync-v2024')      return handleSyncV2024(req, res);
    if (action === 'get-v2024')       return handleGetV2024(req, res);
    if (action === 'get-range-v2024') return handleGetRangeV2024(req, res);
    if (action === 'get-months-v2024') return handleGetMonthsV2024(req, res);
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

// ─── SYNC v2024 ──────────────────────────────────────────────────────────────
// Mirrors handleSync but hits the v2024-06-19 listTransactions endpoint via
// api_path (so it works regardless of whether the bundled amazon-sp-api
// version recognizes the operation). Stores the raw transactions array
// under a separate KV namespace so v0 and v2024 can coexist during the
// migration. No dedup or derivation here — that lives client-side so
// mapping iteration doesn't require a re-sync.
async function handleSyncV2024(req, res) {
  try {
    const month = req.query.month || previousMonthISO();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }

    console.log(`[TRANSACTIONS SYNC v2024] Starting sync for ${month}`);

    const { start, end } = monthBounds(month);
    const { transactions, pageCount } = await fetchListTransactions(start, end);

    await kv.set(`transactions:v2024:raw:${month}`, { transactions });
    const index = (await kv.get('transactions:v2024:index')) || [];
    const updatedIndex = [...new Set([...index, month])].sort();
    await kv.set('transactions:v2024:index', updatedIndex);
    await kv.set(`transactions:v2024:last-synced:${month}`, new Date().toISOString());

    console.log(`[TRANSACTIONS SYNC v2024] ${month}: pages=${pageCount} transactions=${transactions.length}`);
    return res.status(200).json({
      success: true,
      month,
      pageCount,
      transactionCount: transactions.length,
      message: `v2024 transactions sync complete for ${month}`
    });
  } catch (error) {
    console.error('[TRANSACTIONS SYNC v2024] Error:', error);
    return res.status(500).json({ success: false, error: 'Sync failed: ' + error.message });
  }
}

// ─── READ v2024 ──────────────────────────────────────────────────────────────
async function handleGetV2024(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month=YYYY-MM required' });
    }

    const [stored, lastSynced] = await Promise.all([
      kv.get(`transactions:v2024:raw:${month}`),
      kv.get(`transactions:v2024:last-synced:${month}`)
    ]);

    return res.status(200).json({
      success: true,
      month,
      transactions: stored?.transactions || [],
      lastSynced: lastSynced || null
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get v2024 transactions: ' + error.message });
  }
}

async function handleGetRangeV2024(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { startMonth, endMonth } = req.query;
    if (!startMonth || !endMonth) {
      return res.status(400).json({ error: 'startMonth and endMonth required (YYYY-MM)' });
    }

    const index = (await kv.get('transactions:v2024:index')) || [];
    const months = index.filter(m => m >= startMonth && m <= endMonth);
    const buckets = await Promise.all(months.map(m => kv.get(`transactions:v2024:raw:${m}`)));

    // Flatten: all months' transactions concatenated. Dedup happens later
    // in the client-side derivation, since the dedup rule needs to inspect
    // each transaction's relatedIdentifiers.
    const transactions = [];
    for (const b of buckets) {
      if (!b || !Array.isArray(b.transactions)) continue;
      for (const t of b.transactions) transactions.push(t);
    }

    return res.status(200).json({ success: true, startMonth, endMonth, months, transactions });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get v2024 range: ' + error.message });
  }
}

async function handleGetMonthsV2024(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const index = (await kv.get('transactions:v2024:index')) || [];
    return res.status(200).json({ success: true, months: index });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to list v2024 months: ' + error.message });
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
    // Response is always a compact distilled summary (counts, shape per
    // type/status, dedup rule validation, every breakdownType seen). Add
    // &raw=1 to additionally include the full untransformed transactions
    // array — only useful for one-off deep inspection, not for decisions.
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

    // Distill each transaction into a compact shape descriptor so a single
    // response tells us everything the derivation needs to know: counts per
    // (type, status), which related-identifier names appear per partition
    // (that's the dedup-rule check), every breakdownType string ever seen,
    // and one distilled example per (type, status) combo. Full raw
    // transactions only included when &raw=1 is set.
    const byType = {};
    const byStatus = {};
    const breakdownTypes = new Set();
    const deferralReasons = new Set();
    const relatedIdentifierNames = new Set();
    const typeStatusShapes = {}; // key: "type|status" → { count, sample: {...} }
    let releasedWithDeferredAncestor = 0;
    let releasedPure = 0;
    const pureReleasedRidNames = new Set();
    const ancestorReleasedRidNames = new Set();

    const walkBreakdowns = (bs, out) => {
      for (const b of (bs || [])) {
        if (b?.breakdownType) {
          breakdownTypes.add(b.breakdownType);
          if (out) out.add(b.breakdownType);
        }
        if (Array.isArray(b?.breakdowns)) walkBreakdowns(b.breakdowns, out);
      }
    };

    const hasDeferredAncestor = (t) =>
      (t.relatedIdentifiers || []).some(r => r?.relatedIdentifierName === 'DEFERRED_TRANSACTION_ID');

    const distill = (t) => {
      const ridNames = [...new Set((t.relatedIdentifiers || [])
        .map(r => r?.relatedIdentifierName).filter(Boolean))].sort();
      const ctxTypes = [...new Set((t.contexts || [])
        .map(c => c?.contextType).filter(Boolean))].sort();
      const topBreakdowns = new Set();
      walkBreakdowns(t.breakdowns, topBreakdowns);
      const itemCount = Array.isArray(t.items) ? t.items.length : 0;
      const itemBreakdowns = new Set();
      let itemFulfillmentNetwork = null;
      let itemHasSku = false;
      if (itemCount > 0) {
        for (const item of t.items) {
          walkBreakdowns(item.breakdowns, itemBreakdowns);
          for (const c of (item.contexts || [])) {
            if (c?.contextType === 'ProductContext') {
              if (c.fulfillmentNetwork) itemFulfillmentNetwork = c.fulfillmentNetwork;
              if (c.sku) itemHasSku = true;
            }
          }
        }
      }
      const deferralReason = (t.contexts || [])
        .find(c => c?.contextType === 'DeferredContext')?.deferralReason || null;
      return {
        transactionId: t.transactionId || null,
        description: t.description || null,
        totalAmount: t.totalAmount?.currencyAmount ?? null,
        postedDate: t.postedDate || null,
        accountType: t.sellingPartnerMetadata?.accountType || null,
        relatedIdentifierNames: ridNames,
        contextTypes: ctxTypes,
        deferralReason,
        topLevelBreakdownTypes: [...topBreakdowns].sort(),
        itemCount,
        itemBreakdownTypes: [...itemBreakdowns].sort(),
        itemFulfillmentNetwork,
        itemHasSku
      };
    };

    for (const t of transactions) {
      const tType = t.transactionType || '(null)';
      const tStatus = t.transactionStatus || '(null)';
      byType[tType] = (byType[tType] || 0) + 1;
      byStatus[tStatus] = (byStatus[tStatus] || 0) + 1;
      const key = `${tType}|${tStatus}`;
      if (!typeStatusShapes[key]) typeStatusShapes[key] = { count: 0, sample: distill(t) };
      typeStatusShapes[key].count++;
      walkBreakdowns(t.breakdowns, null);
      for (const item of (t.items || [])) walkBreakdowns(item.breakdowns, null);
      for (const ctx of (t.contexts || [])) {
        if (ctx?.deferralReason) deferralReasons.add(ctx.deferralReason);
      }
      for (const rid of (t.relatedIdentifiers || [])) {
        if (rid?.relatedIdentifierName) relatedIdentifierNames.add(rid.relatedIdentifierName);
      }
      if (tStatus === 'RELEASED') {
        const names = (t.relatedIdentifiers || []).map(r => r?.relatedIdentifierName).filter(Boolean);
        if (hasDeferredAncestor(t)) {
          releasedWithDeferredAncestor++;
          for (const n of names) ancestorReleasedRidNames.add(n);
        } else {
          releasedPure++;
          for (const n of names) pureReleasedRidNames.add(n);
        }
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
      dedup: {
        releasedWithDeferredAncestor,
        releasedPure,
        pureReleasedIdentifierNames: [...pureReleasedRidNames].sort(),
        ancestorReleasedIdentifierNames: [...ancestorReleasedRidNames].sort(),
        ruleValidated: !pureReleasedRidNames.has('DEFERRED_TRANSACTION_ID') &&
                        ancestorReleasedRidNames.has('DEFERRED_TRANSACTION_ID')
      },
      breakdownTypesSeen: [...breakdownTypes].sort(),
      deferralReasonsSeen: [...deferralReasons].sort(),
      relatedIdentifierNamesSeen: [...relatedIdentifierNames].sort(),
      typeStatusShapes
    };
    if (req.query.raw === '1') response.allTransactions = transactions;
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

// Same shape as fetchFinancialEvents but for the v2024-06-19 listTransactions
// endpoint. Calls via api_path so it's not dependent on the bundled
// amazon-sp-api version's endpoint map. Rate limit is 0.5 req/s with burst
// 10, so we wait 2.2s between paginated calls. Returns the flat transactions
// array — dedup happens later in the client-side derivation.
async function fetchListTransactions(postedAfter, postedBefore) {
  const sp = createSellingPartner();
  const transactions = [];
  let nextToken = null;
  let calls = 0;

  do {
    const raw = await sp.callAPI({
      api_path: '/finances/2024-06-19/transactions',
      method: 'GET',
      query: {
        postedAfter,
        postedBefore,
        ...(nextToken ? { nextToken } : {})
      }
    });
    const body = raw?.payload ?? raw ?? {};
    const list = Array.isArray(body.transactions) ? body.transactions : [];
    transactions.push(...list);
    nextToken = body.nextToken || null;
    calls++;

    console.log(`[TRANSACTIONS SYNC v2024] page ${calls}: transactions=${list.length} hasNextToken=${!!nextToken}`);
    if (nextToken) await sleep(2200);
  } while (nextToken && calls < 200);

  return { transactions, pageCount: calls };
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
