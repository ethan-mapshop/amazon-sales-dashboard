import SellingPartner from 'amazon-sp-api';
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const { action } = req.query;

  if (!action) {
    return res.status(400).json({ error: 'Action parameter required' });
  }

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    if (action === 'get')             return handleGet(req, res);
    if (action === 'sync')            return handleSync(req, res);
    if (action === 'get-summary')     return handleGetSummary(req, res);
    if (action === 'rebuild-summary') return handleRebuildSummary(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── GET ─────────────────────────────────────────────────────────────────────
// Returns stored orders from Upstash, optionally filtered by date range
async function handleGet(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });

    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const { startDate, endDate } = req.query;

    const index = await kv.get('orders:index') || [];
    if (index.length === 0) {
      return res.status(200).json({ success: true, orders: [] });
    }

    let monthsToFetch = index;
    if (startDate && endDate) {
      const start = startDate.slice(0, 7);
      const end = endDate.slice(0, 7);
      monthsToFetch = index.filter(m => m >= start && m <= end);
    }

    const buckets = await Promise.all(monthsToFetch.map(m => kv.get(`orders:${m}`)));
    let orders = buckets.flat().filter(Boolean);

    if (startDate && endDate) {
      orders = orders.filter(o => o.orderDate >= startDate && o.orderDate <= endDate);
    }

    return res.status(200).json({ success: true, orders });

  } catch (error) {
    console.error('Error retrieving orders:', error);
    return res.status(500).json({ error: 'Failed to retrieve orders: ' + error.message });
  }
}

// ─── SYNC ─────────────────────────────────────────────────────────────────────
// Two call patterns, chosen by query param:
//   ?date=YYYY-MM-DD           — fetch exactly that day (manual backfill)
//   ?days=N                    — fetch trailing N days [today-N .. yesterday]
//   neither                    — defaults to days=1 (yesterday only)
//
// `date` wins if both are present (explicit single-day overrides window). The
// daily cron now passes `&days=14` so each run re-fetches the last 2 weeks and
// catches SP-API order data that has settled since the original sync (Pending
// → Shipped transitions, returns, refunds). The dedup key in upsertOrdersToKV
// (`${orderId}:${sku}`) makes re-fetching idempotent — a re-fetched order
// just overwrites its previous record.
//
// The window also enables cancellation reconciliation: orders that were in KV
// for dates in the window but no longer come back from SP-API (because they
// were canceled) get evicted by upsertOrdersToKV. Without this, the trailing
// window would leave zombie canceled orders inflating revenue.
async function handleSync(req, res) {
  try {
    const dateParam = req.query.date || null;
    const daysParam = req.query.days || null;

    let windowStart;  // inclusive YYYY-MM-DD
    let windowEnd;    // inclusive YYYY-MM-DD

    if (dateParam) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
        return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      }
      windowStart = dateParam;
      windowEnd = dateParam;
    } else {
      // Default 1 day (= yesterday). Clamp days to [1, 60] — anything
      // larger doesn't make sense for "trailing window" semantics and
      // risks pushing wall time toward the 300s function timeout.
      let n = parseInt(daysParam || '1', 10);
      if (!Number.isFinite(n) || n < 1) n = 1;
      if (n > 60) n = 60;

      const today = new Date();
      const yesterday = new Date(today);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const start = new Date(today);
      start.setUTCDate(start.getUTCDate() - n);

      windowStart = start.toISOString().slice(0, 10);
      windowEnd = yesterday.toISOString().slice(0, 10);
    }

    console.log(`[ORDERS SYNC] Starting sync for ${windowStart} → ${windowEnd}`);

    const orders = await fetchOrdersForDateRange(windowStart, windowEnd);
    console.log(`[ORDERS SYNC] Fetched ${orders.length} line items for ${windowStart} → ${windowEnd}`);

    await upsertOrdersToKV(orders, windowStart, windowEnd);

    // Rebuild summary cache in the background (fire and forget)
    rebuildSummaryCache().catch(e => console.warn('[SYNC] Summary rebuild failed:', e.message));

    return res.status(200).json({
      success: true,
      startDate: windowStart,
      endDate: windowEnd,
      // Preserve the legacy field shape for runOrdersBackfill (single-day
      // callers used to read `data.date` and `data.newRecords`). The new
      // `date` field aliases startDate when start==end.
      date: windowStart === windowEnd ? windowStart : undefined,
      newRecords: orders.length,
      message: `Orders sync complete for ${windowStart} → ${windowEnd}`
    });

  } catch (error) {
    console.error('[ORDERS SYNC] Error:', error);
    return res.status(500).json({ success: false, error: 'Sync failed: ' + error.message });
  }
}


// ─── GET SUMMARY ─────────────────────────────────────────────────────────────
// Returns pre-aggregated monthly summary from cache. Fast single KV read.
async function handleGetSummary(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const summary = await kv.get('orders:monthly-summary');
    return res.status(200).json({ success: true, summary: summary || [] });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get summary: ' + error.message });
  }
}

// ─── REBUILD SUMMARY ─────────────────────────────────────────────────────────
// Core logic extracted so it can be called from sync without auth overhead.
async function rebuildSummaryCache() {
  const index = await kv.get('orders:index') || [];
  const buckets = await Promise.all(index.map(m => kv.get(`orders:${m}`)));
  const allOrders = buckets.flat().filter(Boolean);

  const aggMap = {};
  for (const o of allOrders) {
    const key = `${o.orderDate.slice(0, 7)}|${o.sku}`;
    if (!aggMap[key]) aggMap[key] = { yearMonth: o.orderDate.slice(0, 7), sku: o.sku, revenue: 0, units: 0 };
    aggMap[key].revenue += o.itemTotal || 0;
    aggMap[key].units   += o.quantity  || 0;
  }

  const summary = Object.values(aggMap).sort((a, b) => a.yearMonth.localeCompare(b.yearMonth));
  await kv.set('orders:monthly-summary', summary);
  console.log(`[SUMMARY] Rebuilt: ${summary.length} SKU-month records from ${allOrders.length} orders`);
  return summary;
}

// HTTP handler — auth-gated, calls rebuildSummaryCache()
async function handleRebuildSummary(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const summary = await rebuildSummaryCache();
    return res.status(200).json({ success: true, records: summary.length });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to rebuild summary: ' + error.message });
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

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

async function fetchOrdersForDateRange(startDate, endDate) {
  const sp = createSellingPartner();
  const marketplaceId = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER';

  const lineItems = [];
  let nextToken = null;

  do {
    const query = {
      MarketplaceIds: marketplaceId,
      CreatedAfter: `${startDate}T00:00:00Z`,
      CreatedBefore: `${endDate}T23:59:59Z`,
      ...(nextToken ? { NextToken: nextToken } : {})
    };

    const response = await sp.callAPI({
      operation: 'getOrders',
      endpoint: 'orders',
      query
    });

    const orders = response.Orders || [];
    nextToken = response.NextToken || null;

    const activeOrders = orders.filter(o => o.OrderStatus !== 'Canceled');

    for (const order of activeOrders) {
      const items = await fetchOrderItems(sp, order.AmazonOrderId);
      for (const item of items) {
        lineItems.push({
          orderDate: order.PurchaseDate.split('T')[0],
          orderId: order.AmazonOrderId,
          sku: item.SellerSKU,
          asin: item.ASIN,
          quantity: parseInt(item.QuantityOrdered) || 0,
          itemTotal: parseFloat(item.ItemPrice?.Amount || 0),
          fulfillmentChannel: order.FulfillmentChannel // AFN = FBA, MFN = Seller
        });
      }
      await sleep(200);
    }

  } while (nextToken);

  return lineItems;
}

// Retry on SP-API rate-limit (429 / QuotaExceeded). Without this, a
// throttled getOrderItems silently dropped the order's items — meaning the
// trailing-window re-fetch (14× more calls/run than the old yesterday-only
// cron) would re-introduce the same silent data loss this plan is meant to
// fix. Exponential backoff: 2s, 4s, 8s; 3 retries max before falling back
// to the original silent-failure path (so a persistent outage doesn't kill
// the whole sync, just the orders that won't respond).
async function fetchOrderItems(sp, orderId, attempt = 0) {
  try {
    const response = await sp.callAPI({
      operation: 'getOrderItems',
      endpoint: 'orders',
      path: { orderId }
    });
    return response.OrderItems || [];
  } catch (error) {
    const is429 = error?.statusCode === 429
                  || error?.code === 'QuotaExceeded'
                  || /quota|throttl|too many|rate.?limit/i.test(error?.message || '');
    if (is429 && attempt < 3) {
      const wait = 2000 * Math.pow(2, attempt); // 2s, 4s, 8s
      console.warn(`[ORDERS] Throttled on ${orderId}, retry ${attempt + 1}/3 in ${wait}ms`);
      await sleep(wait);
      return fetchOrderItems(sp, orderId, attempt + 1);
    }
    console.error(`Error fetching items for order ${orderId}:`, error);
    return [];
  }
}

// Writes newOrders to KV month-by-month, deduping by `${orderId}:${sku}` so
// re-fetched orders overwrite their previous records. Optional window params
// enable cancellation reconciliation: when handleSync passes
// `[windowStart, windowEnd]`, any KV record whose orderDate falls in that
// window but whose orderId is missing from the new fetch is considered
// canceled-since-original-sync and gets evicted. Without this, the daily
// 14-day re-fetch would leave canceled orders in place as zombie revenue.
//
// `windowStart`/`windowEnd` are optional — when omitted (no current caller,
// kept for forward-compatibility), the function preserves its pre-change
// add-only behavior. handleSync always supplies them.
async function upsertOrdersToKV(newOrders, windowStart, windowEnd) {
  // When a window was supplied we still need to run the reconciliation
  // pass even if zero new orders came back — the empty result is itself
  // a signal that everything in that window was canceled. Skip only if
  // the caller didn't provide a window AND there's nothing to write.
  if (newOrders.length === 0 && !windowStart) return;

  const byMonth = {};
  for (const order of newOrders) {
    const month = order.orderDate.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push(order);
  }

  // When reconciling we also need to touch any month that the window
  // straddles, even if zero new orders for that month came back. Add
  // those months to the work list with an empty bucket — the eviction
  // pass below handles them.
  if (windowStart && windowEnd) {
    const ws = windowStart.slice(0, 7);
    const we = windowEnd.slice(0, 7);
    // Most windows span 1–2 months; this loop runs at most ~3× even
    // for the monthly cron (Feb has 28–29 days, etc.).
    let cur = ws;
    while (cur <= we) {
      if (!byMonth[cur]) byMonth[cur] = [];
      // Increment to next month (string math via Date to keep edge
      // cases — Dec→Jan, leap years — out of this code).
      const [y, m] = cur.split('-').map(Number);
      const next = new Date(Date.UTC(y, m, 1));
      cur = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}`;
    }
  }

  const index = await kv.get('orders:index') || [];
  const updatedIndex = [...new Set([...index, ...Object.keys(byMonth)])].sort();
  await kv.set('orders:index', updatedIndex);

  const fetchedOrderIds = (windowStart && windowEnd)
    ? new Set(newOrders.map(o => o.orderId))
    : null;

  for (const [month, orders] of Object.entries(byMonth)) {
    const existing = await kv.get(`orders:${month}`) || [];
    const dedupeMap = {};
    for (const o of existing) dedupeMap[`${o.orderId}:${o.sku}`] = o;
    for (const o of orders) dedupeMap[`${o.orderId}:${o.sku}`] = o;

    // Cancellation reconciliation: drop KV records whose orderDate is
    // inside the re-fetched window but whose orderId is not in the new
    // result set. fetchOrdersForDateRange already filters out Canceled
    // orders (`api/orders.js` activeOrders filter), so a missing orderId
    // means "canceled or otherwise disappeared on Amazon's side".
    let evictedCount = 0;
    if (fetchedOrderIds) {
      for (const key of Object.keys(dedupeMap)) {
        const o = dedupeMap[key];
        if (o.orderDate >= windowStart && o.orderDate <= windowEnd
            && !fetchedOrderIds.has(o.orderId)) {
          delete dedupeMap[key];
          evictedCount++;
        }
      }
    }

    const merged = Object.values(dedupeMap).sort((a, b) => a.orderDate.localeCompare(b.orderDate));
    await kv.set(`orders:${month}`, merged);
    const evictedNote = evictedCount > 0 ? ` (evicted ${evictedCount} canceled)` : '';
    console.log(`[ORDERS] Saved ${merged.length} records for ${month}${evictedNote}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
