import SellingPartner from 'amazon-sp-api';
import { kv } from '@vercel/kv';

// ─── ROUTER ──────────────────────────────────────────────────────────────────
//  GET ?action=sync        [&month=YYYY-MM]    — pull & aggregate one month
//  GET ?action=get         &month=YYYY-MM      — read one month's aggregates
//  GET ?action=get-range   &startMonth=&endMonth=  — read a contiguous range
//  GET ?action=get-months                       — list synced months
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
    if (action === 'sync')       return handleSync(req, res);
    if (action === 'get')        return handleGet(req, res);
    if (action === 'get-range')  return handleGetRange(req, res);
    if (action === 'get-months') return handleGetMonths(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── SYNC ────────────────────────────────────────────────────────────────────
// Cron hits with no params → previous month. Button hits with ?month=YYYY-MM.
async function handleSync(req, res) {
  try {
    const month = req.query.month || previousMonthISO();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }

    console.log(`[TRANSACTIONS SYNC] Starting sync for ${month}`);

    const { start, end } = monthBounds(month);
    const { pages, pageCount, eventCount } = await fetchFinancialEvents(start, end);
    const aggregates = aggregateEvents(pages, month);

    await kv.set(`transactions:${month}`, aggregates);
    const index = await kv.get('transactions:index') || [];
    const updatedIndex = [...new Set([...index, month])].sort();
    await kv.set('transactions:index', updatedIndex);
    await kv.set(`transactions:last-synced:${month}`, new Date().toISOString());

    console.log(`[TRANSACTIONS SYNC] ${month}: pages=${pageCount} events=${eventCount} aggregates=${aggregates.length}`);
    return res.status(200).json({
      success: true,
      month,
      pageCount,
      eventCount,
      records: aggregates.length,
      message: `Transactions sync complete for ${month}`
    });
  } catch (error) {
    console.error('[TRANSACTIONS SYNC] Error:', error);
    return res.status(500).json({ success: false, error: 'Sync failed: ' + error.message });
  }
}

// ─── GET ─────────────────────────────────────────────────────────────────────
async function handleGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month=YYYY-MM required' });
    }

    const [aggregates, lastSynced] = await Promise.all([
      kv.get(`transactions:${month}`),
      kv.get(`transactions:last-synced:${month}`)
    ]);

    return res.status(200).json({
      success: true,
      month,
      aggregates: aggregates || [],
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

    const index = await kv.get('transactions:index') || [];
    const months = index.filter(m => m >= startMonth && m <= endMonth);
    const buckets = await Promise.all(months.map(m => kv.get(`transactions:${m}`)));
    const aggregates = buckets.flat().filter(Boolean);

    return res.status(200).json({ success: true, startMonth, endMonth, aggregates });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get range: ' + error.message });
  }
}

async function handleGetMonths(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const index = await kv.get('transactions:index') || [];
    return res.status(200).json({ success: true, months: index });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to list months: ' + error.message });
  }
}

// ─── SP-API ──────────────────────────────────────────────────────────────────

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

// listFinancialEvents paginates; each page returns a FinancialEvents object
// containing event-type arrays (ShipmentEventList, RefundEventList, etc.).
// amazon-sp-api has historically returned different shapes across versions —
// sometimes { FinancialEvents, NextToken } at the top, sometimes wrapped in
// { payload: { ... } }. We defensively unwrap and hunt for NextToken.
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

    // Unwrap payload if the SDK didn't already.
    const body = raw?.payload ?? raw ?? {};
    const financialEvents = body.FinancialEvents || body.financialEvents || {};
    // NextToken sits at the top of the body, not inside FinancialEvents.
    nextToken = body.NextToken || body.nextToken || null;

    const pageEvents = countEvents(financialEvents);
    eventCount += pageEvents;
    pages.push(financialEvents);
    calls++;

    console.log(`[TRANSACTIONS SYNC] page ${calls}: events=${pageEvents} hasNextToken=${!!nextToken}`);

    if (nextToken) await sleep(500); // respect rate limits
  } while (nextToken && calls < 200); // safety cap

  return { pages, pageCount: calls, eventCount };
}

// Count every event across all the known list fields on one page so we can
// tell legitimate "100 unique SKUs" from "pagination silently bailed."
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

// ─── AGGREGATION ─────────────────────────────────────────────────────────────
// Collapse raw SP-API events into monthly per-(sku, fulfillment) rows whose
// columns mirror the Amazon "Date Range Financial Activity" report shape
// the Sheets-based loader already expects.

function aggregateEvents(pages, yearMonth) {
  const agg = {};

  for (const events of pages) {
    for (const shipment of (events.ShipmentEventList || [])) {
      applyItems(agg, yearMonth, shipment.ShipmentItemList, +1);
    }
    for (const refund of (events.RefundEventList || [])) {
      // Refund amounts are already signed negative by Amazon.
      applyItems(agg, yearMonth, refund.ShipmentItemAdjustmentList, +1);
    }
    for (const ga of (events.GuaranteeClaimEventList || [])) {
      applyItems(agg, yearMonth, ga.ShipmentItemAdjustmentList, +1);
    }
    for (const cb of (events.ChargebackEventList || [])) {
      applyItems(agg, yearMonth, cb.ShipmentItemAdjustmentList, +1);
    }
    // Order-level / subscription-level fees without SKU attribution:
    for (const fee of (events.ServiceFeeEventList || [])) {
      applyOrderLevelFees(agg, yearMonth, fee.FeeList, fee.FulfillmentChannel || 'MFN');
    }
    for (const adj of (events.AdjustmentEventList || [])) {
      applyOrderLevelAdjustments(agg, yearMonth, adj);
    }
  }

  // Finalize totalAmount from bucketed columns (matches Sheets "total" column).
  const rows = Object.values(agg);
  for (const r of rows) {
    r.totalAmount = round2(
      r.productSales + r.shippingCredits + r.giftWrapCredits +
      r.promotionalRebates + r.sellingFees + r.fbaFees + r.other
    );
  }
  return rows;
}

function applyItems(agg, yearMonth, items, sign) {
  for (const item of (items || [])) {
    const sku = item.SellerSKU || '';
    const fulfillment = inferFulfillment(item);
    const bucket = getBucket(agg, yearMonth, sku, fulfillment);

    bucket.quantity += (parseInt(item.QuantityShipped) || 0) * sign;

    for (const charge of extractList(item.ItemChargeList)) {
      const amt = currencyAmount(charge.ChargeAmount) * sign;
      categorize(bucket, 'charge', charge.ChargeType, amt);
    }
    for (const fee of extractList(item.ItemFeeList)) {
      const amt = currencyAmount(fee.FeeAmount) * sign;
      categorize(bucket, 'fee', fee.FeeType, amt);
    }
    // Refund-specific extras (PromotionAdjustmentList, ItemTaxWithheldList) are
    // skipped for now — they belong in "other" by default via categorize().
  }
}

function applyOrderLevelFees(agg, yearMonth, feeList, fulfillment) {
  const bucket = getBucket(agg, yearMonth, '', fulfillment);
  for (const fee of (feeList || [])) {
    const amt = currencyAmount(fee.FeeAmount);
    categorize(bucket, 'fee', fee.FeeType, amt);
  }
}

function applyOrderLevelAdjustments(agg, yearMonth, adj) {
  const bucket = getBucket(agg, yearMonth, '', 'MFN');
  for (const item of (adj.AdjustmentItemList || [])) {
    const amt = currencyAmount(item.PerUnitAmount) * (parseInt(item.Quantity) || 1);
    bucket.other += amt;
  }
}

function getBucket(agg, yearMonth, sku, fulfillment) {
  const key = `${sku}|${fulfillment}`;
  if (!agg[key]) {
    agg[key] = {
      yearMonth, sku, fulfillment,
      productSales: 0, shippingCredits: 0, giftWrapCredits: 0,
      promotionalRebates: 0, sellingFees: 0, fbaFees: 0, other: 0,
      totalAmount: 0, quantity: 0
    };
  }
  return agg[key];
}

// Bucket a charge/fee amount into one of the 7 Amazon report columns.
function categorize(bucket, kind, type, amount) {
  if (!type || !Number.isFinite(amount) || amount === 0) return;

  if (kind === 'charge') {
    switch (type) {
      case 'Principal':
        bucket.productSales += amount; return;
      case 'Shipping':
        bucket.shippingCredits += amount; return;
      case 'GiftWrap':
        bucket.giftWrapCredits += amount; return;
      case 'ShippingPromotion':
      case 'ItemPromotion':
      case 'Promotion':
        bucket.promotionalRebates += amount; return;
      case 'Tax':
      case 'GiftWrapTax':
      case 'ShippingTax':
      case 'MarketplaceFacilitatorTax-Principal':
      case 'MarketplaceFacilitatorTax-Shipping':
      case 'MarketplaceFacilitatorVAT-Principal':
      case 'MarketplaceFacilitatorVAT-Shipping':
        // Tax is collected & remitted by Amazon — net-zero to the seller.
        return;
      default:
        bucket.other += amount; return;
    }
  }

  if (kind === 'fee') {
    switch (type) {
      case 'Commission':
      case 'FixedClosingFee':
      case 'VariableClosingFee':
      case 'RefundCommission':
      case 'PerItemFee':
        bucket.sellingFees += amount; return;
      case 'FBAPerUnitFulfillmentFee':
      case 'FBAPerOrderFulfillmentFee':
      case 'FBAWeightBasedFee':
        bucket.fbaFees += amount; return;
      default:
        bucket.other += amount; return;
    }
  }
}

// FBA vs FBM heuristic: item-level fees include FBAPerUnitFulfillmentFee when
// Amazon fulfilled it. Matches the current Sheets column well enough for our
// monthly aggregation; we can cross-reference orders KV later if needed.
function inferFulfillment(item) {
  const fees = extractList(item.ItemFeeList);
  const hasFBAFee = fees.some(f => typeof f.FeeType === 'string' && f.FeeType.startsWith('FBA'));
  return hasFBAFee ? 'AFN' : 'MFN';
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function verifyGoogleToken(req) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return { ok: false, error: 'No access token provided' };
  const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verify.ok) return { ok: false, error: 'Invalid access token' };
  return { ok: true };
}

// SP-API sometimes returns ItemChargeList as { ItemChargeList: [...] } and
// sometimes as the plain array — normalize both.
function extractList(maybeWrapped) {
  if (!maybeWrapped) return [];
  if (Array.isArray(maybeWrapped)) return maybeWrapped;
  const inner = maybeWrapped.ItemChargeList || maybeWrapped.ItemFeeList ||
                maybeWrapped.FeeList || maybeWrapped.ChargeList;
  return Array.isArray(inner) ? inner : [];
}

function currencyAmount(money) {
  if (money == null) return 0;
  const n = parseFloat(money.CurrencyAmount ?? money.Amount ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function monthBounds(yyyymm) {
  const [y, m] = yyyymm.split('-').map(Number);
  const startDate = new Date(Date.UTC(y, m - 1, 1));
  const endDate = new Date(Date.UTC(y, m, 1)); // first of next month, exclusive
  return {
    start: startDate.toISOString().replace(/\.\d{3}Z$/, 'Z'),
    end:   endDate.toISOString().replace(/\.\d{3}Z$/, 'Z')
  };
}

function previousMonthISO() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-indexed; prev month
  const prev = new Date(Date.UTC(y, m - 1, 1));
  return `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}`;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
