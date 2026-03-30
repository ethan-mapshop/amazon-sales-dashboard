import SellingPartner from 'amazon-sp-api';
import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  const { action } = req.query;

  if (!action) {
    return res.status(400).json({ error: 'Action parameter required' });
  }

  // Handle GET requests
  if (req.method === 'GET') {
    if (action === 'get') {
      return handleGet(req, res);
    } else if (action === 'sync') {
      return handleSync(req, res);
    }
  }

  // Handle POST requests
  if (req.method === 'POST') {
    if (action === 'backfill') {
      return handleBackfill(req, res);
    }
  }

  // Handle OPTIONS for CORS
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(200).end();
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── GET ────────────────────────────────────────────────────────────────────
// Returns stored orders from Upstash for a date range (or all if no range given)
async function handleGet(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });

    const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verifyResponse.ok) return res.status(401).json({ error: 'Invalid access token' });

    const { startDate, endDate } = req.query;

    // Get index of available months
    const index = await kv.get('orders:index') || [];

    if (index.length === 0) {
      return res.status(200).json({ success: true, orders: [] });
    }

    // Filter index to only months overlapping the requested date range
    let monthsToFetch = index;
    if (startDate && endDate) {
      const start = startDate.slice(0, 7); // YYYY-MM
      const end = endDate.slice(0, 7);
      monthsToFetch = index.filter(m => m >= start && m <= end);
    }

    // Fetch all relevant monthly buckets in parallel
    const buckets = await Promise.all(monthsToFetch.map(m => kv.get(`orders:${m}`)));
    let orders = buckets.flat().filter(Boolean);

    // Apply date filter if provided
    if (startDate && endDate) {
      orders = orders.filter(o => o.orderDate >= startDate && o.orderDate <= endDate);
    }

    return res.status(200).json({ success: true, orders });

  } catch (error) {
    console.error('Error retrieving orders:', error);
    return res.status(500).json({ error: 'Failed to retrieve orders: ' + error.message });
  }
}

// ─── SYNC ────────────────────────────────────────────────────────────────────
// Daily cron: fetches yesterday's orders and appends to Upstash
async function handleSync(req, res) {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const dateStr = yesterday.toISOString().split('T')[0];

    console.log(`[ORDERS SYNC] Starting sync for ${dateStr}`);

    const orders = await fetchOrdersForDateRange(dateStr, dateStr);
    console.log(`[ORDERS SYNC] Fetched ${orders.length} line items for ${dateStr}`);

    await upsertOrdersToKV(orders);

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

// ─── BACKFILL ────────────────────────────────────────────────────────────────
// One-time or manual: fetch a custom date range and store in Upstash
// Streams progress via SSE so the UI can show status
async function handleBackfill(req, res) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return res.status(401).json({ error: 'No access token provided' });

  const verifyResponse = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verifyResponse.ok) return res.status(401).json({ error: 'Invalid access token' });

  const { startDate, endDate } = req.body;
  if (!startDate || !endDate) {
    return res.status(400).json({ error: 'startDate and endDate required (YYYY-MM-DD)' });
  }

  // Stream progress back to the client
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  try {
    res.write(`data: Starting backfill from ${startDate} to ${endDate}...\n\n`);

    // Process month by month to keep each fetch manageable
    const months = getMonthsInRange(startDate, endDate);
    let totalRecords = 0;

    for (const { monthStart, monthEnd } of months) {
      // Clamp to the requested range
      const fetchStart = monthStart < startDate ? startDate : monthStart;
      const fetchEnd = monthEnd > endDate ? endDate : monthEnd;

      res.write(`data: Fetching ${fetchStart} to ${fetchEnd}...\n\n`);

      try {
        const orders = await fetchOrdersForDateRange(fetchStart, fetchEnd);
        await upsertOrdersToKV(orders);
        totalRecords += orders.length;
        res.write(`data: ✓ ${fetchStart.slice(0, 7)} — ${orders.length} line items stored (${totalRecords} total)\n\n`);
      } catch (err) {
        res.write(`data: ⚠ Error for ${fetchStart.slice(0, 7)}: ${err.message}\n\n`);
      }

      // Brief pause between months to avoid rate limits
      await sleep(1000);
    }

    res.write(`data: COMPLETE — ${totalRecords} total order line items stored\n\n`);
    res.end();

  } catch (error) {
    res.write(`data: FAILED — ${error.message}\n\n`);
    res.end();
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

// Fetches all non-cancelled orders + their line items for a date range.
// Returns a flat array of order line items ready to store.
async function fetchOrdersForDateRange(startDate, endDate) {
  const sp = createSellingPartner();
  const marketplaceId = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER';

  const lineItems = [];
  let nextToken = null;

  // Page through all orders in the date range
  do {
    const params = {
      operation: 'getOrders',
      endpoint: 'orders',
      query: {
        MarketplaceIds: marketplaceId,
        CreatedAfter: `${startDate}T00:00:00Z`,
        CreatedBefore: `${endDate}T23:59:59Z`,
        OrderStatuses: 'Unshipped,PartiallyShipped,Shipped,InvoiceUnconfirmed,Canceled,Unfulfillable',
        ...(nextToken ? { NextToken: nextToken } : {})
      }
    };

    const response = await sp.callAPI(params);
    const orders = response.Orders || [];
    nextToken = response.NextToken || null;

    // Filter out cancelled orders, then fetch line items for each
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
          fulfillmentChannel: order.FulfillmentChannel // 'AFN' = FBA, 'MFN' = Seller
        });
      }

      // Small delay between order item fetches to respect rate limits
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

// Saves orders to Upstash, sharded by YYYY-MM.
// Merges with existing data, deduplicating by orderId+sku.
async function upsertOrdersToKV(newOrders) {
  if (newOrders.length === 0) return;

  // Group new orders by month
  const byMonth = {};
  for (const order of newOrders) {
    const month = order.orderDate.slice(0, 7); // YYYY-MM
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push(order);
  }

  // Update index
  const index = await kv.get('orders:index') || [];
  const updatedIndex = [...new Set([...index, ...Object.keys(byMonth)])].sort();
  await kv.set('orders:index', updatedIndex);

  // Merge each month's data
  for (const [month, orders] of Object.entries(byMonth)) {
    const existing = await kv.get(`orders:${month}`) || [];

    // Deduplicate: build a map keyed by orderId+sku, new data wins
    const dedupeMap = {};
    for (const o of existing) {
      dedupeMap[`${o.orderId}:${o.sku}`] = o;
    }
    for (const o of orders) {
      dedupeMap[`${o.orderId}:${o.sku}`] = o;
    }

    const merged = Object.values(dedupeMap).sort((a, b) => a.orderDate.localeCompare(b.orderDate));
    await kv.set(`orders:${month}`, merged);
    console.log(`[ORDERS] Saved ${merged.length} records for ${month}`);
  }
}

// Returns an array of { monthStart, monthEnd } for each calendar month in range
function getMonthsInRange(startDate, endDate) {
  const months = [];
  const start = new Date(startDate);
  const end = new Date(endDate);

  let current = new Date(start.getFullYear(), start.getMonth(), 1);

  while (current <= end) {
    const monthStart = current.toISOString().split('T')[0];
    const lastDay = new Date(current.getFullYear(), current.getMonth() + 1, 0);
    const monthEnd = lastDay.toISOString().split('T')[0];
    months.push({ monthStart, monthEnd });
    current.setMonth(current.getMonth() + 1);
  }

  return months;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
