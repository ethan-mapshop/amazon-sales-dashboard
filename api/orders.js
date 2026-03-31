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
// Daily cron calls with no params → fetches yesterday.
// Backfill calls with ?date=YYYY-MM-DD → fetches that specific day.
async function handleSync(req, res) {
  try {
    let dateStr = req.query.date || null;

    if (!dateStr) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      dateStr = yesterday.toISOString().split('T')[0];
    }

    console.log(`[ORDERS SYNC] Starting sync for ${dateStr}`);

    const orders = await fetchOrdersForDateRange(dateStr, dateStr);
    console.log(`[ORDERS SYNC] Fetched ${orders.length} line items for ${dateStr}`);

    await upsertOrdersToKV(orders);

    // Rebuild summary cache in the background (fire and forget)
    rebuildSummaryCache().catch(e => console.warn('[SYNC] Summary rebuild failed:', e.message));

    return res.status(200).json({
      success: true,
      date: dateStr,
      newRecords: orders.length,
      message: `Orders sync complete for ${dateStr}`
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

async function fetchOrderItems(sp, orderId) {
  try {
    const response = await sp.callAPI({
      operation: 'getOrderItems',
      endpoint: 'orders',
      path: { orderId }
    });
    return response.OrderItems || [];
  } catch (error) {
    console.error(`Error fetching items for order ${orderId}:`, error);
    return [];
  }
}

async function upsertOrdersToKV(newOrders) {
  if (newOrders.length === 0) return;

  const byMonth = {};
  for (const order of newOrders) {
    const month = order.orderDate.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push(order);
  }

  const index = await kv.get('orders:index') || [];
  const updatedIndex = [...new Set([...index, ...Object.keys(byMonth)])].sort();
  await kv.set('orders:index', updatedIndex);

  for (const [month, orders] of Object.entries(byMonth)) {
    const existing = await kv.get(`orders:${month}`) || [];
    const dedupeMap = {};
    for (const o of existing) dedupeMap[`${o.orderId}:${o.sku}`] = o;
    for (const o of orders) dedupeMap[`${o.orderId}:${o.sku}`] = o;
    const merged = Object.values(dedupeMap).sort((a, b) => a.orderDate.localeCompare(b.orderDate));
    await kv.set(`orders:${month}`, merged);
    console.log(`[ORDERS] Saved ${merged.length} records for ${month}`);
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
