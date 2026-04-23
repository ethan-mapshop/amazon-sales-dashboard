import SellingPartner from 'amazon-sp-api';
import { kv } from '@vercel/kv';

// ─── ROUTER ──────────────────────────────────────────────────────────────────
//  GET ?action=sync        [&month=YYYY-MM]            — pull SP-API & store
//  GET ?action=get         &month=YYYY-MM              — Sheets-shape rows for one month
//  GET ?action=get-range   &startMonth=&endMonth=      — Sheets-shape rows over a span
//  GET ?action=get-months                               — list of synced months
//
// KV layout:
//   transactions:YYYY-MM         → { values: [[headerRow], ...dataRows] }
//                                  Rows mirror the Amazon "Date Range Financial
//                                  Activity" CSV that the existing Sheets-backed
//                                  Profitability Overview parses. One row per
//                                  ShipmentItem / refund-item / service-fee /
//                                  adjustment — never pre-aggregated.
//   transactions:index           → ['YYYY-MM', ...]
//   transactions:last-synced:YYYY-MM → ISO timestamp
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
    if (action === 'get-raw')    return handleGetRaw(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// Column names exactly as the existing Sheets Transactions tab uses them,
// matched lowercase by js/brand-product.js parseTransactions /
// calculateFinancialStatement. Do not change the order or casing.
const SHEET_HEADERS = [
  'date/time', 'type', 'order id', 'sku', 'description', 'quantity', 'fulfillment',
  'product sales', 'shipping credits', 'gift wrap credits', 'promotional rebates',
  'selling fees', 'fba fees', 'other', 'total'
];

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
    const rows = extractRows(pages);

    const values = [SHEET_HEADERS, ...rows];
    await kv.set(`transactions:${month}`, { values });

    // Also store the raw SP-API payload so the user can inspect every
    // field Amazon returned — the Sheets-shape rows drop fields we
    // didn't map (FeeReason on ServiceFee events, AdjustmentType on
    // AdjustmentEvents, individual FeeList entries, etc.). A debug
    // endpoint and the "Export Detail CSV" button both read this back.
    await kv.set(`transactions:raw:${month}`, { pages });

    const index = (await kv.get('transactions:index')) || [];
    const updatedIndex = [...new Set([...index, month])].sort();
    await kv.set('transactions:index', updatedIndex);
    await kv.set(`transactions:last-synced:${month}`, new Date().toISOString());

    console.log(`[TRANSACTIONS SYNC] ${month}: pages=${pageCount} events=${eventCount} rows=${rows.length}`);
    return res.status(200).json({
      success: true,
      month,
      pageCount,
      eventCount,
      rows: rows.length,
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
      kv.get(`transactions:${month}`),
      kv.get(`transactions:last-synced:${month}`)
    ]);

    // Response intentionally mirrors the Google Sheets API response shape so
    // the existing loadOverviewData logic can consume either source
    // unchanged: { values: [[header], ...rows] }. No extra normalization.
    const values = stored?.values || [SHEET_HEADERS];

    return res.status(200).json({
      success: true,
      month,
      values,
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
    const buckets = await Promise.all(months.map(m => kv.get(`transactions:${m}`)));

    // Merge many monthly buckets into a single { values: [...] } that looks
    // just like what one big Sheets read would return — header once, then
    // every data row from every month in order.
    const values = [SHEET_HEADERS];
    for (const b of buckets) {
      if (!b || !Array.isArray(b.values) || b.values.length < 2) continue;
      for (let i = 1; i < b.values.length; i++) values.push(b.values[i]);
    }

    return res.status(200).json({ success: true, startMonth, endMonth, values });
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

// Returns the raw SP-API FinancialEvents pages for one month exactly as
// they came back from listFinancialEvents. For debugging / mapping work
// where the Sheets-shape rows have lost fields (FeeReason on ServiceFee,
// AdjustmentType on Adjustment, per-FeeList entries, etc.).
async function handleGetRaw(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month=YYYY-MM required' });
    }

    const stored = await kv.get(`transactions:raw:${month}`);
    return res.status(200).json({
      success: true,
      month,
      pages: stored?.pages || []
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to get raw: ' + error.message });
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

// ─── ROW EXTRACTION ──────────────────────────────────────────────────────────
// Emit one Sheets-shape row per SP-API line item. No aggregation. The existing
// loadOverviewData categorizer will group these by type/fulfillment/description
// on the client side, identically to how it handles Sheets-sourced rows.

function extractRows(pages) {
  // Shipment events give us a reliable SKU → fulfillment ("Amazon" / "Seller")
  // map. Refunds and other events often lack the FBA fee signal, so we fall
  // back to this hint when emitting their rows.
  const hint = buildSkuFulfillmentHint(pages);
  const rows = [];

  for (const events of pages) {
    // ── Orders ────────────────────────────────────────────────────────
    for (const ev of (events.ShipmentEventList || [])) {
      pushItemRows(rows, ev, 'Order', +1, ev.ShipmentItemList, hint);
    }

    // ── Refunds ──────────────────────────────────────────────────────
    for (const ev of (events.RefundEventList || [])) {
      pushItemRows(rows, ev, 'Refund', -1, itemAdjList(ev), hint);
    }

    // ── Chargeback-like events ───────────────────────────────────────
    for (const ev of (events.GuaranteeClaimEventList || [])) {
      pushItemRows(rows, ev, 'Chargeback Refund', -1, itemAdjList(ev), hint);
    }
    for (const ev of (events.ChargebackEventList || [])) {
      pushItemRows(rows, ev, 'Chargeback Refund', -1, itemAdjList(ev), hint);
    }

    // ── Retrocharges ─────────────────────────────────────────────────
    for (const ev of (events.RetrochargeEventList || [])) {
      pushItemRows(rows, ev, 'Order_Retrocharge', +1, itemAdjList(ev), hint);
    }

    // ── Service fees (storage, subscriptions, inbound placement, ...) ──
    for (const ev of (events.ServiceFeeEventList || [])) {
      pushServiceFeeRow(rows, ev);
    }

    // ── Adjustments (inventory reimbursements, corrections, ...) ──────
    for (const ev of (events.AdjustmentEventList || [])) {
      pushAdjustmentRows(rows, ev);
    }
  }

  return rows;
}

function itemAdjList(ev) {
  return ev.ShipmentItemAdjustmentList || ev.ShipmentItemList || [];
}

function buildSkuFulfillmentHint(pages) {
  const hint = {};
  for (const events of pages) {
    for (const shipment of (events.ShipmentEventList || [])) {
      for (const item of (shipment.ShipmentItemList || [])) {
        const sku = item.SellerSKU;
        if (!sku) continue;
        const label = inferFulfillmentLabel(item);
        // "Amazon" (FBA) wins — a SKU that shipped FBA at least once this
        // month is treated as FBA for refund/adjustment attribution below.
        if (label === 'Amazon' || !hint[sku]) hint[sku] = label;
      }
    }
  }
  return hint;
}

function inferFulfillmentLabel(item) {
  const fees = extractList(item.ItemFeeList || item.ItemFeeAdjustmentList);
  const hasFBAFee = fees.some(f => typeof f?.FeeType === 'string' && f.FeeType.startsWith('FBA'));
  return hasFBAFee ? 'Amazon' : 'Seller';
}

// For ShipmentEvent and refund/chargeback/retrocharge events: emit one row
// per line item, collapsing the item's ItemChargeList + ItemFeeList into
// the Amazon report's 7 money columns.
function pushItemRows(rows, event, type, quantitySign, itemList, hint) {
  // Emit YYYY-MM-DD only — loadOverviewData's date filter does
  // `new Date(transDate + 'T00:00:00')`, which breaks on a full ISO
  // timestamp. The Sheets Transactions tab stores just the date.
  const date = (event.PostedDate || '').substring(0, 10);
  const orderId = event.AmazonOrderId || '';

  for (const item of (itemList || [])) {
    const sku = item.SellerSKU || '';
    const fulfillment = (sku && hint[sku]) ? hint[sku] : inferFulfillmentLabel(item);
    const quantity = (parseInt(item.QuantityShipped, 10) || 0) * quantitySign;

    const b = emptyMoneyBuckets();
    for (const c of extractList(item.ItemChargeList || item.ItemChargeAdjustmentList)) {
      categorizeCharge(b, c.ChargeType, currencyAmount(c.ChargeAmount));
    }
    for (const f of extractList(item.ItemFeeList || item.ItemFeeAdjustmentList)) {
      categorizeFee(b, f.FeeType, currencyAmount(f.FeeAmount));
    }
    const total = sumBuckets(b);

    rows.push([
      date, type, orderId, sku, '', quantity, fulfillment,
      round2(b.productSales), round2(b.shippingCredits), round2(b.giftWrapCredits),
      round2(b.promotionalRebates), round2(b.sellingFees), round2(b.fbaFees),
      round2(b.other), round2(total)
    ]);
  }
}

// Service fees (storage, inbound placement, subscriptions, etc.) — emit one
// row per event. All amounts land in the "other" column so the existing
// categorizer routes them by description / type string. The type string is
// chosen to match how Amazon's Transaction report labels these.
function pushServiceFeeRow(rows, event) {
  // Emit YYYY-MM-DD only — loadOverviewData's date filter does
  // `new Date(transDate + 'T00:00:00')`, which breaks on a full ISO
  // timestamp. The Sheets Transactions tab stores just the date.
  const date = (event.PostedDate || '').substring(0, 10);
  const orderId = event.AmazonOrderId || '';
  const sku = event.SellerSKU || '';
  const description = event.FeeDescription || event.FeeReason || '';
  const fulfillment = event.FulfillmentChannel === 'AFN' ? 'Amazon' : 'Seller';
  const type = looksLikeFBAInventoryFee(description) ? 'FBA Inventory Fee' : 'Service Fee';

  let otherTotal = 0;
  let fbaFeesTotal = 0;
  for (const f of (event.FeeList || [])) {
    const amt = currencyAmount(f.FeeAmount);
    if (typeof f.FeeType === 'string' && f.FeeType.startsWith('FBA')) {
      fbaFeesTotal += amt;
    } else {
      otherTotal += amt;
    }
  }

  rows.push([
    date, type, orderId, sku, description, 0, fulfillment,
    0, 0, 0, 0, 0, round2(fbaFeesTotal), round2(otherTotal),
    round2(fbaFeesTotal + otherTotal)
  ]);
}

function looksLikeFBAInventoryFee(desc) {
  if (!desc) return false;
  const d = desc.toLowerCase();
  return d.includes('storage') || d.includes('inbound') || d.includes('fba');
}

// AdjustmentEvent covers inventory reimbursements and misc corrections.
// Emit one row per adjustment item so per-SKU amounts don't get lost.
function pushAdjustmentRows(rows, event) {
  // Emit YYYY-MM-DD only — loadOverviewData's date filter does
  // `new Date(transDate + 'T00:00:00')`, which breaks on a full ISO
  // timestamp. The Sheets Transactions tab stores just the date.
  const date = (event.PostedDate || '').substring(0, 10);
  const adjustmentType = event.AdjustmentType || '';
  const items = event.AdjustmentItemList || [];
  const isReimbursement = /reimburs/i.test(adjustmentType);
  const description = isReimbursement
    ? `FBA Inventory Reimbursement${adjustmentType ? ' - ' + adjustmentType : ''}`
    : adjustmentType;

  if (items.length === 0) {
    // Event-level adjustment with no per-item rows.
    const amt = currencyAmount(event.AdjustmentAmount);
    rows.push([
      date, 'Fee Adjustment', '', '', description, 0, 'Seller',
      0, 0, 0, 0, 0, 0, round2(amt), round2(amt)
    ]);
    return;
  }

  for (const item of items) {
    const sku = item.SellerSKU || '';
    const perUnit = currencyAmount(item.PerUnitAmount);
    const qty = parseInt(item.Quantity, 10) || 0;
    const amt = perUnit * qty;
    const productDescription = item.ProductDescription || description;

    rows.push([
      date, 'Fee Adjustment', '', sku, productDescription, qty, 'Seller',
      0, 0, 0, 0, 0, 0, round2(amt), round2(amt)
    ]);
  }
}

// ─── MONEY-COLUMN BUCKETING ──────────────────────────────────────────────────
// Maps SP-API ChargeType / FeeType strings to the 7 columns Amazon's
// Date Range Financial Activity report uses.

function emptyMoneyBuckets() {
  return {
    productSales: 0, shippingCredits: 0, giftWrapCredits: 0,
    promotionalRebates: 0, sellingFees: 0, fbaFees: 0, other: 0
  };
}

function sumBuckets(b) {
  return b.productSales + b.shippingCredits + b.giftWrapCredits +
         b.promotionalRebates + b.sellingFees + b.fbaFees + b.other;
}

function categorizeCharge(b, type, amount) {
  if (!type || !Number.isFinite(amount) || amount === 0) return;
  switch (type) {
    case 'Principal':          b.productSales += amount; return;
    case 'Shipping':           b.shippingCredits += amount; return;
    case 'GiftWrap':           b.giftWrapCredits += amount; return;
    case 'ShippingPromotion':
    case 'ItemPromotion':
    case 'Promotion':          b.promotionalRebates += amount; return;
    case 'Tax':
    case 'GiftWrapTax':
    case 'ShippingTax':
    case 'MarketplaceFacilitatorTax-Principal':
    case 'MarketplaceFacilitatorTax-Shipping':
    case 'MarketplaceFacilitatorVAT-Principal':
    case 'MarketplaceFacilitatorVAT-Shipping':
      return; // Marketplace facilitator tax is net-zero to the seller.
    default:                   b.other += amount; return;
  }
}

function categorizeFee(b, type, amount) {
  if (!type || !Number.isFinite(amount) || amount === 0) return;
  switch (type) {
    case 'Commission':
    case 'FixedClosingFee':
    case 'VariableClosingFee':
    case 'RefundCommission':
    case 'PerItemFee':         b.sellingFees += amount; return;
    case 'FBAPerUnitFulfillmentFee':
    case 'FBAPerOrderFulfillmentFee':
    case 'FBAWeightBasedFee':  b.fbaFees += amount; return;
    default:                   b.other += amount; return;
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function verifyGoogleToken(req) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return { ok: false, error: 'No access token provided' };
  const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verify.ok) return { ok: false, error: 'Invalid access token' };
  return { ok: true };
}

function extractList(maybeWrapped) {
  if (!maybeWrapped) return [];
  if (Array.isArray(maybeWrapped)) return maybeWrapped;
  const inner = maybeWrapped.ItemChargeList || maybeWrapped.ItemFeeList ||
                maybeWrapped.FeeList || maybeWrapped.ChargeList ||
                maybeWrapped.ItemChargeAdjustmentList || maybeWrapped.ItemFeeAdjustmentList;
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

function round2(n) {
  return Math.round(n * 100) / 100;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
