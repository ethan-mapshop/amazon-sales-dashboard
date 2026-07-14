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
    if (action === 'get')                    return handleGet(req, res);
    if (action === 'get-v2')                 return handleGetV2(req, res);
    if (action === 'sync')                   return handleSync(req, res);
    if (action === 'get-summary')            return handleGetSummary(req, res);
    if (action === 'rebuild-summary')        return handleRebuildSummary(req, res);
    if (action === 'poll-flat-file-report')  return handlePollFlatFileReport(req, res);
    if (action === 'list-pending-reports')   return handleListPendingReports(req, res);
  }
  if (req.method === 'POST') {
    if (action === 'upload-orders-report')    return handleUploadOrdersReport(req, res);
    if (action === 'request-flat-file-report') return handleRequestFlatFileReport(req, res);
    if (action === 'delete-v2-months')        return handleDeleteV2Months(req, res);
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

    const { lineItems, seenOrderIds } = await fetchOrdersForDateRange(windowStart, windowEnd);
    console.log(`[ORDERS SYNC] Captured ${lineItems.length} new line items across ${seenOrderIds.size} orders for ${windowStart} → ${windowEnd}`);

    await upsertOrdersToKV(lineItems, seenOrderIds, windowStart, windowEnd);

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
      newRecords: lineItems.length,
      ordersSeen: seenOrderIds.size,
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

// ─── GET-V2 ──────────────────────────────────────────────────────────────────
// Same shape as handleGet but reads from the orders:v2:* keyspace (data
// ingested from Amazon's flat-file "All Orders" report via
// handleUploadOrdersReport). Sales & Volume flips its fetch URL to this
// action to consume the reconciled report data instead of the fragile
// getOrders/getOrderItems cron output. Old handleGet stays intact for
// rollback.
async function handleGetV2(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });

    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const { startDate, endDate } = req.query;

    const index = await kv.get('orders:v2:index') || [];
    if (index.length === 0) {
      return res.status(200).json({ success: true, orders: [] });
    }

    let monthsToFetch = index;
    if (startDate && endDate) {
      const start = startDate.slice(0, 7);
      const end = endDate.slice(0, 7);
      monthsToFetch = index.filter(m => m >= start && m <= end);
    }

    const buckets = await Promise.all(monthsToFetch.map(m => kv.get(`orders:v2:${m}`)));
    let orders = buckets.flat().filter(Boolean);

    if (startDate && endDate) {
      orders = orders.filter(o => o.orderDate >= startDate && o.orderDate <= endDate);
    }

    return res.status(200).json({ success: true, orders });

  } catch (error) {
    console.error('Error retrieving v2 orders:', error);
    return res.status(500).json({ error: 'Failed to retrieve orders: ' + error.message });
  }
}

// ─── UPLOAD ORDERS REPORT (Amazon flat-file "All Orders" report) ────────────
//
// Client-parsed Amazon flat-file `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_
// DATE_GENERAL` posted as JSON rows. Normalizes each row to the same shape
// the existing Sales & Volume code already consumes (orderDate / sku /
// asin / quantity / itemTotal / fulfillmentChannel), so no downstream
// changes are needed once we swap the read to handleGetV2.
//
// Why this exists: the getOrders + getOrderItems path we've been running
// on a daily cron systematically undercounts revenue (Pending orders with
// $0 item prices get locked in by skip-already-captured; business-buyer
// discounts and various edge cases don't round-trip cleanly). The flat
// file contains Amazon's actual transacted line-item amounts as they
// appear in Seller Central — matches Sales & Traffic by construction.
//
// Idempotency: refuses to overwrite an existing month's bucket unless
// `?overwrite=true` is passed. Prevents accidental data loss on re-upload.
//
// Body: { rows: [{ 'amazon-order-id', 'purchase-date', 'sku', 'asin',
// 'quantity', 'item-price', 'fulfillment-channel', 'item-status',
// 'is-business-order' }, ...] }
// Case-tolerant on keys (matches the transactions uploader pattern).
async function handleUploadOrdersReport(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rawRows) return res.status(400).json({ error: 'rows array required in body' });

    const overwrite = req.query.overwrite === 'true';
    const result = await _normalizeAndWriteOrdersMonth(rawRows, { overwrite });

    if (result.collision) {
      return res.status(409).json({
        error: `Months already have data: ${result.collidingMonths.join(', ')}. Re-upload with ?overwrite=true to replace.`,
        collidingMonths: result.collidingMonths
      });
    }

    return res.status(200).json({
      success: true,
      writtenMonths: result.writtenMonths,
      totalRows: result.totalRows,
      skippedCancelled: result.skippedCancelled,
      skippedNoDate: result.skippedNoDate,
      skippedNoOrder: result.skippedNoOrder,
      message: result.writtenMonths.length === 0
        ? 'No valid rows found in the upload'
        : `Uploaded ${result.totalRows} line items across ${result.writtenMonths.length} month${result.writtenMonths.length === 1 ? '' : 's'}${result.skippedCancelled ? `, skipped ${result.skippedCancelled} cancelled` : ''}.`
    });
  } catch (error) {
    console.error('[ORDERS UPLOAD-REPORT] Error:', error);
    return res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
}

// Shared ingestion helper — used by both the manual upload path
// (handleUploadOrdersReport) and the SP-API pull path
// (handlePollFlatFileReport). Takes raw flat-file report rows (case-
// tolerant keys) and does: drop-cancelled → normalize per-row → group
// by month → refuse-if-exists guard → write per-month buckets → update
// index.
//
// Returns:
//   {
//     collision: false, writtenMonths: [...], totalRows, skippedCancelled,
//     skippedNoDate, skippedNoOrder
//   }
// OR, when overwrite is false and any target month already has data:
//   { collision: true, collidingMonths: [...] }
//
// Options:
//   overwrite: boolean — if true, skip the collision guard entirely
//
// Both call sites want to render slightly different response shapes on
// top of this, so this helper only returns the aggregates. The caller
// wraps them into an HTTP response.
async function _normalizeAndWriteOrdersMonth(rawRows, { overwrite = false } = {}) {
  const pick = (obj, ...keys) => {
    for (const k of keys) if (obj[k] !== undefined) return obj[k];
    const lower = {};
    for (const k of Object.keys(obj)) lower[k.toLowerCase()] = obj[k];
    for (const k of keys) {
      const v = lower[k.toLowerCase()];
      if (v !== undefined) return v;
    }
    return undefined;
  };

  const byMonth = {};
  let skippedCancelled = 0;
  let skippedNoDate = 0;
  let skippedNoOrder = 0;
  for (const r of rawRows) {
    if (!r || typeof r !== 'object') continue;

    // Drop cancelled rows at ingest — matches existing filter behavior
    // in fetchOrdersForDateRange. Amazon spells it "Cancelled" (two Ls)
    // in the flat file; belt-and-braces check for both spellings.
    const status = String(pick(r, 'item-status', 'itemStatus') || '').trim();
    if (status === 'Cancelled' || status === 'Canceled') { skippedCancelled++; continue; }

    const orderDateRaw = String(pick(r, 'purchase-date', 'purchaseDate') || '').trim();
    const orderDate = orderDateRaw.slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(orderDate)) { skippedNoDate++; continue; }

    const orderId = String(pick(r, 'amazon-order-id', 'amazonOrderId', 'orderId') || '').trim();
    if (!orderId) { skippedNoOrder++; continue; }

    const sku = String(pick(r, 'sku') || '').trim();
    const asin = String(pick(r, 'asin') || '').trim();
    const qtyRaw = pick(r, 'quantity');
    const quantity = parseInt(String(qtyRaw ?? '0').replace(/[,]/g, ''), 10) || 0;

    // item-price is the actual transacted line total (unit price × qty,
    // reflecting business-buyer discounts and any other Amazon-side
    // pricing adjustments). Strip $ / commas defensively.
    const priceRaw = pick(r, 'item-price', 'itemPrice');
    const itemTotal = parseFloat(String(priceRaw ?? '0').replace(/[$,]/g, '')) || 0;

    // fulfillment-channel is already AFN/MFN in the flat file — same
    // shape we store today. Fall through as-is; downstream filters
    // compare exactly against 'AFN' and 'MFN'.
    const fulfillmentChannel = String(pick(r, 'fulfillment-channel', 'fulfillmentChannel') || '').trim();

    const isBusinessRaw = pick(r, 'is-business-order', 'isBusinessOrder');
    const isBusinessOrder = isBusinessRaw === true ||
                            isBusinessRaw === 'true' ||
                            isBusinessRaw === 'True' ||
                            isBusinessRaw === 'TRUE' ||
                            isBusinessRaw === 1 ||
                            isBusinessRaw === '1';

    const month = orderDate.slice(0, 7);
    if (!byMonth[month]) byMonth[month] = [];
    byMonth[month].push({
      orderDate, orderId, sku, asin, quantity,
      itemTotal, fulfillmentChannel, isBusinessOrder
    });
  }

  const monthsToWrite = Object.keys(byMonth).sort();
  if (monthsToWrite.length === 0) {
    return {
      collision: false,
      writtenMonths: [], totalRows: 0, rawRowCount: rawRows.length,
      skippedCancelled, skippedNoDate, skippedNoOrder
    };
  }

  // Refuse to overwrite months that already have data unless the
  // caller explicitly passes overwrite=true. Protects against
  // accidental data loss on re-upload / re-pull.
  if (!overwrite) {
    const collisions = [];
    for (const m of monthsToWrite) {
      const existing = await kv.get(`orders:v2:${m}`);
      if (Array.isArray(existing) && existing.length > 0) collisions.push(m);
    }
    if (collisions.length > 0) {
      return { collision: true, collidingMonths: collisions };
    }
  }

  // Write per-month buckets, then update the index. Data-first-then-
  // pointer order so a partial failure doesn't leave dangling index
  // entries pointing at empty keys.
  let totalRows = 0;
  for (const m of monthsToWrite) {
    const rows = byMonth[m].sort((a, b) => a.orderDate.localeCompare(b.orderDate));
    await kv.set(`orders:v2:${m}`, rows);
    totalRows += rows.length;
  }
  const existingIndex = (await kv.get('orders:v2:index')) || [];
  const mergedIndex = [...new Set([...existingIndex, ...monthsToWrite])].sort();
  await kv.set('orders:v2:index', mergedIndex);

  return {
    collision: false,
    writtenMonths: monthsToWrite, totalRows, rawRowCount: rawRows.length,
    skippedCancelled, skippedNoDate, skippedNoOrder
  };
}

// ─── REQUEST FLAT-FILE REPORT (SP-API createReport) ─────────────────────────
//
// Kicks off Amazon's report generation for
// GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL scoped to a single
// month (the report type accepts up to 30 days per request; a calendar
// month always fits). Reports take minutes to hours on Amazon's side —
// this endpoint returns immediately with a reportId and the client (or
// a cron) polls poll-flat-file-report later to check status and
// download when ready.
//
// The reportId is stashed in KV key `orders:v2:pending-reports` (an
// array of { reportId, month, requestedAt, name }). Same pending-queue
// pattern as api/adspend.js.
//
// Body: { month: 'YYYY-MM' }
async function handleRequestFlatFileReport(req, res) {
  // Declared outside the try so the catch can record a per-month
  // failure to orders:v2:report-lastresult (so it surfaces in the UI's
  // status panel and survives a page reload).
  let month;
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    month = req.body?.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month=YYYY-MM required in body' });
    }

    // If a report for this month is already in the pending queue, reuse
    // it instead of requesting a duplicate from Amazon.
    const pending = (await kv.get('orders:v2:pending-reports')) || [];
    const existing = pending.find(p => p.month === month);
    if (existing) {
      return res.status(200).json({
        success: true,
        reportId: existing.reportId,
        month,
        alreadyPending: true,
        message: `Report for ${month} already pending since ${existing.requestedAt}`
      });
    }

    // ISO 8601 UTC bounds for the calendar month. Amazon's report is
    // by-order-date (PurchaseDate); using UTC month boundaries gives us
    // a clean per-month partition.
    const [y, m] = month.split('-').map(Number);
    const dataStartTime = new Date(Date.UTC(y, m - 1, 1)).toISOString();
    // Last millisecond of the month — inclusive end. Matches sessions.js
    // which uses `endDate + 'T23:59:59Z'` for the same purpose.
    const dataEndTime = new Date(Date.UTC(y, m, 1) - 1).toISOString();

    const sp = createSellingPartner();
    const marketplaceId = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER';

    let reportId;
    try {
      const response = await sp.callAPI({
        operation: 'createReport',
        endpoint: 'reports',
        body: {
          reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
          marketplaceIds: [marketplaceId],
          dataStartTime,
          dataEndTime
        }
      });
      reportId = response.reportId;
    } catch (err) {
      // SP-API 425 (Duplicate) means Amazon still has an identical
      // request in flight and won't create a new one. The response body
      // typically embeds the existing reportId in the errors array.
      // Best-effort extract; if we can't find it, surface the error so
      // the user can see what happened.
      const isDuplicate = err?.statusCode === 425 ||
                          /duplicate|already.+request/i.test(err?.message || '');
      if (isDuplicate) {
        const errBody = err?.response?.data || err?.body || {};
        const errArr = Array.isArray(errBody?.errors) ? errBody.errors : [];
        const numMatch = (s) => (typeof s === 'string' && s.match(/[0-9]{12,}/)) ? s.match(/[0-9]{12,}/)[0] : null;
        const dupId = errArr.map(e => numMatch(e.details) || numMatch(e.message)).find(Boolean);
        if (dupId) {
          reportId = dupId;
        } else {
          throw new Error(`SP-API 425 duplicate but no reportId extractable: ${JSON.stringify(errBody).slice(0, 300)}`);
        }
      } else {
        throw err;
      }
    }

    const updated = [...pending, {
      reportId,
      month,
      requestedAt: new Date().toISOString(),
      name: `AllOrders ${month}`
    }];
    await kv.set('orders:v2:pending-reports', updated);

    // Clear any stale lastResults entry for this month — a previous
    // failure shouldn't linger in the UI now that we've successfully
    // re-queued the report.
    const lastResults = (await kv.get('orders:v2:report-lastresult')) || {};
    if (lastResults[month]) {
      delete lastResults[month];
      await kv.set('orders:v2:report-lastresult', lastResults);
    }

    return res.status(200).json({
      success: true,
      reportId,
      month,
      alreadyPending: false
    });
  } catch (error) {
    const errorMsg = _extractSpApiErrorMessage(error);
    console.error('[ORDERS REQUEST-REPORT] Error:', errorMsg);

    // Persist request-time failures to lastResults so the status panel
    // can render them. Without this, request-time failures were only
    // visible via a raw JSON response in DevTools — users never saw
    // "why did July 2024 fail?" in the UI. Best-effort; a KV write
    // failure here shouldn't mask the underlying error we return.
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      try {
        const lastResults = (await kv.get('orders:v2:report-lastresult')) || {};
        lastResults[month] = {
          status: 'FAILED',
          error: errorMsg,
          completedAt: new Date().toISOString(),
          phase: 'request'
        };
        await kv.set('orders:v2:report-lastresult', lastResults);
      } catch { /* best-effort */ }
    }

    return res.status(500).json({ error: 'Request failed: ' + errorMsg, month });
  }
}

// SP-API errors from the amazon-sp-api npm package come in a few shapes
// depending on version. This walker pulls the user-facing message from
// wherever it lives. Prefers structured errors[] over raw .message so
// we get e.g. "InvalidInput: dataStartTime must be within the last 2
// years" instead of the wrapper's opaque "Request failed" string.
function _extractSpApiErrorMessage(err) {
  if (!err) return 'Unknown error';
  const body = err?.response?.data || err?.body || err?.data;
  if (body?.errors && Array.isArray(body.errors) && body.errors.length > 0) {
    return body.errors.map(e => {
      const code = e.code ? `${e.code}: ` : '';
      const msg = e.message || e.details || '';
      return `${code}${msg}`.trim();
    }).filter(Boolean).join('; ');
  }
  if (typeof err.message === 'string' && err.message) return err.message;
  return String(err);
}

// ─── POLL FLAT-FILE REPORT (SP-API getReport + getReportDocument) ───────────
//
// Walks the pending queue (`orders:v2:pending-reports`), processes up
// to 5 entries per call to stay well within the 300s Vercel function
// timeout. For each entry: calls getReport to check status. If DONE,
// pulls the download URL via getReportDocument, fetches + gunzips the
// TSV, parses it, runs the shared normalization helper, writes to
// `orders:v2:${month}`. Removes DONE and FAILED entries from the
// queue; leaves IN_QUEUE / IN_PROGRESS entries for the next poll.
//
// Query params: `overwrite=true` (optional) — pass through to the
// normalization helper's overwrite behavior. Default false.
//
// Returns { success, collected, stillPending, failed, remaining }.
async function handlePollFlatFileReport(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const overwrite = req.query.overwrite === 'true';
    const pending = (await kv.get('orders:v2:pending-reports')) || [];
    if (pending.length === 0) {
      return res.status(200).json({
        success: true, collected: [], stillPending: [], failed: [], remaining: 0
      });
    }

    const sp = createSellingPartner();
    const MAX_PER_CALL = 5;
    const toProcess = pending.slice(0, MAX_PER_CALL);
    const untouchedTail = pending.slice(MAX_PER_CALL);

    const collected = [];
    const failed = [];
    const stillPending = [];
    const lastResults = (await kv.get('orders:v2:report-lastresult')) || {};

    for (const p of toProcess) {
      try {
        const statusResp = await sp.callAPI({
          operation: 'getReport',
          endpoint: 'reports',
          path: { reportId: p.reportId }
        });
        const status = statusResp.processingStatus;

        if (status === 'DONE') {
          const docId = statusResp.reportDocumentId;
          const doc = await sp.callAPI({
            operation: 'getReportDocument',
            endpoint: 'reports',
            path: { reportDocumentId: docId }
          });
          const dlResp = await fetch(doc.url);
          if (!dlResp.ok) throw new Error(`Report download failed (${dlResp.status})`);
          const buf = Buffer.from(await dlResp.arrayBuffer());
          // Amazon says GZIP is the default compression for this report
          // type, but be defensive — some documents come uncompressed.
          const { gunzipSync } = await import('zlib');
          const text = doc.compressionAlgorithm === 'GZIP'
            ? gunzipSync(buf).toString('utf-8')
            : buf.toString('utf-8');
          const rows = _parseTsv(text);
          const result = await _normalizeAndWriteOrdersMonth(rows, { overwrite });

          if (result.collision) {
            failed.push({
              reportId: p.reportId,
              month: p.month,
              status: 'COLLISION',
              error: `Month ${p.month} already has data. Re-run with overwrite=true to replace.`
            });
            lastResults[p.month] = {
              status: 'FAILED',
              error: 'Refused to overwrite existing month',
              completedAt: new Date().toISOString()
            };
          } else {
            collected.push({
              reportId: p.reportId,
              month: p.month,
              status: 'DONE',
              rowCount: result.totalRows,
              rawRowCount: result.rawRowCount,
              skippedCancelled: result.skippedCancelled
            });
            lastResults[p.month] = {
              status: 'DONE',
              rowCount: result.totalRows,
              // Raw row count = what the parser produced (post-header). Lets
              // the UI distinguish "Amazon returned empty" from "we filtered
              // everything." A 0/0 is almost always Amazon returning an
              // empty report — either genuinely no orders that month or
              // (much more likely for older months) the month is outside
              // the ~2-year order-report retention window.
              rawRowCount: result.rawRowCount,
              skippedCancelled: result.skippedCancelled,
              skippedNoDate: result.skippedNoDate,
              skippedNoOrder: result.skippedNoOrder,
              completedAt: new Date().toISOString()
            };
          }
        } else if (status === 'CANCELLED' || status === 'FATAL') {
          failed.push({
            reportId: p.reportId,
            month: p.month,
            status,
            error: `Amazon returned processingStatus=${status}`
          });
          lastResults[p.month] = {
            status: 'FAILED',
            error: `Amazon returned processingStatus=${status}`,
            completedAt: new Date().toISOString()
          };
        } else {
          // IN_QUEUE / IN_PROGRESS — keep waiting.
          stillPending.push({ ...p, currentStatus: status });
        }
      } catch (err) {
        console.error(`[ORDERS POLL] Error processing reportId ${p.reportId}:`, err);
        // Don't drop on transient errors — leave in queue with the last
        // error recorded so a subsequent poll retries.
        stillPending.push({ ...p, lastError: err.message });
      }
    }

    // Reconstruct queue: newly stillPending (from processed batch) +
    // untouched tail. Collected and failed are removed.
    const nextQueue = [...stillPending, ...untouchedTail];
    await kv.set('orders:v2:pending-reports', nextQueue);
    await kv.set('orders:v2:report-lastresult', lastResults);

    return res.status(200).json({
      success: true,
      collected,
      stillPending: nextQueue,
      failed,
      remaining: nextQueue.length
    });
  } catch (error) {
    console.error('[ORDERS POLL-REPORT] Error:', error);
    return res.status(500).json({ error: 'Poll failed: ' + error.message });
  }
}

// ─── LIST PENDING REPORTS ───────────────────────────────────────────────────
//
// Returns the current pending queue + last-result-per-month state so
// the UI can render "what's in flight" and "what happened last time"
// without triggering a poll (which would consume SP-API quota).
async function handleListPendingReports(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const [pending, lastResults] = await Promise.all([
      kv.get('orders:v2:pending-reports'),
      kv.get('orders:v2:report-lastresult')
    ]);

    return res.status(200).json({
      success: true,
      pending: Array.isArray(pending) ? pending : [],
      lastResults: (lastResults && typeof lastResults === 'object') ? lastResults : {}
    });
  } catch (error) {
    console.error('[ORDERS LIST-PENDING] Error:', error);
    return res.status(500).json({ error: 'List failed: ' + error.message });
  }
}

// ─── DELETE V2 MONTHS ───────────────────────────────────────────────────────
//
// Clears specified months from the orders:v2:* keyspace so they can be
// re-populated cleanly (e.g. after a partial-month API pull that only
// caught the tail end of a retention-bounded month). Removes three
// things per month:
//   1. `orders:v2:${month}` — the actual line-item bucket
//   2. entries from `orders:v2:index`
//   3. entries from `orders:v2:report-lastresult` — so the UI's Recent
//      results panel doesn't render stale "42 rows" for a month that's
//      now empty
//
// Body: { months: ['YYYY-MM', ...] }
async function handleDeleteV2Months(req, res) {
  try {
    const accessToken = req.headers.authorization?.replace('Bearer ', '');
    if (!accessToken) return res.status(401).json({ error: 'No access token provided' });
    const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
    if (!verify.ok) return res.status(401).json({ error: 'Invalid access token' });

    const months = Array.isArray(req.body?.months) ? req.body.months : null;
    if (!months || months.length === 0) {
      return res.status(400).json({ error: 'months array required in body' });
    }
    const invalid = months.filter(m => !/^\d{4}-\d{2}$/.test(m));
    if (invalid.length > 0) {
      return res.status(400).json({ error: `Invalid month format: ${invalid.join(', ')}. Use YYYY-MM.` });
    }

    // 1. Delete the per-month buckets in parallel.
    await Promise.all(months.map(m => kv.del(`orders:v2:${m}`)));

    // 2. Remove from the index.
    const existingIndex = (await kv.get('orders:v2:index')) || [];
    const toRemove = new Set(months);
    const newIndex = existingIndex.filter(m => !toRemove.has(m));
    if (newIndex.length !== existingIndex.length) {
      await kv.set('orders:v2:index', newIndex);
    }

    // 3. Remove from lastResults (so the UI doesn't render stale "N
    // rows" entries for months whose bucket is now empty).
    const lastResults = (await kv.get('orders:v2:report-lastresult')) || {};
    let lastResultsChanged = false;
    for (const m of months) {
      if (lastResults[m]) {
        delete lastResults[m];
        lastResultsChanged = true;
      }
    }
    if (lastResultsChanged) {
      await kv.set('orders:v2:report-lastresult', lastResults);
    }

    return res.status(200).json({
      success: true,
      deleted: months,
      message: `Deleted ${months.length} month${months.length === 1 ? '' : 's'} from the dashboard.`
    });
  } catch (error) {
    console.error('[ORDERS DELETE-V2] Error:', error);
    return res.status(500).json({ error: 'Delete failed: ' + error.message });
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

// Minimal tab-separated-values parser. Amazon's flat-file reports come
// back as gzipped TSV; after gunzip we have a string, and we want an
// array of objects keyed by header column name so the shared
// _normalizeAndWriteOrdersMonth helper can consume it identically to
// rows from the client-side manual upload.
//
// Assumptions (all safe for Amazon's flat file):
//   • Fields don't contain tabs (Amazon escapes any tab characters in
//     values before shipping the report)
//   • Fields don't contain newlines within a single value
//   • Trailing blank lines are ignored
//   • CRLF line endings handled
function _parseTsv(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.split(/\r?\n/);
  while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
  if (lines.length < 2) return [];
  const headers = lines[0].split('\t');
  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i].split('\t');
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = cells[j] ?? '';
    }
    out.push(row);
  }
  return out;
}

// Returns { lineItems, seenOrderIds }.
//
// `lineItems` are the per-SKU rows for orders newly captured during this
// run. `seenOrderIds` is every order ID returned by SP-API's getOrders in
// the window (whether or not we re-fetched its items) — needed by
// upsertOrdersToKV's cancellation-reconciliation pass to tell "this order
// still exists" apart from "this order was canceled and should be evicted".
//
// Why we skip getOrderItems for orders we already have:
//   - getOrderItems is the slow part (200ms sleep + 200–500ms network per
//     call). On a 14-day window with hundreds of orders, calling it for
//     every order pushes wall time past Vercel's 300s function timeout
//     — that's the bug we're fixing here.
//   - Once an order has any line items in KV, its existence is captured.
//     The bug that justified the trailing window was orders silently
//     missing because getOrderItems returned empty while they were
//     Pending. Re-checking an order whose items are already in KV adds
//     no information (orders' line items don't materially change after
//     they leave Pending; quantity drift after first capture is rare
//     enough that the user can manually backfill if they spot it).
//
// Trade-off: line-item-level value updates (e.g. quantity change on a B2B
// order after partial cancellation) won't propagate after first capture.
// For Sales & Volume (order existence + initial captured volume), this
// is acceptable. Profitability uses a different data pipeline entirely
// and is unaffected.
async function fetchOrdersForDateRange(startDate, endDate) {
  const sp = createSellingPartner();
  const marketplaceId = process.env.AMAZON_MARKETPLACE_ID || 'ATVPDKIKX0DER';

  // Pass 1: pull every order header in the window from getOrders. This is
  // the cheap part — paginated, no per-order API call. We need the full
  // list before we can decide which ones to re-fetch items for, since the
  // "already have items?" check is keyed on orderId.
  const allOrders = []; // [{ AmazonOrderId, PurchaseDate, FulfillmentChannel }]
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

    // Filter Canceled here so they don't enter seenOrderIds either — the
    // reconciliation pass in upsertOrdersToKV then correctly evicts them
    // from KV (any prior captured record without a matching seenOrderId
    // in the window is treated as canceled).
    for (const o of orders) {
      if (o.OrderStatus !== 'Canceled') allOrders.push(o);
    }
  } while (nextToken);

  const seenOrderIds = new Set(allOrders.map(o => o.AmazonOrderId));

  // Pass 2: build the set of orderIds we already have line items for in
  // KV. Read every month bucket the window could touch (almost always 1
  // or 2). The Set lets us skip getOrderItems for orders that are
  // already fully captured.
  const monthsInWindow = new Set();
  for (const o of allOrders) {
    const month = o.PurchaseDate.slice(0, 7);
    monthsInWindow.add(month);
  }
  const existingOrderIds = new Set();
  for (const month of monthsInWindow) {
    const bucket = (await kv.get(`orders:${month}`)) || [];
    for (const row of bucket) {
      if (row && row.orderId) existingOrderIds.add(row.orderId);
    }
  }

  // Pass 3: fetch items only for orders we don't already have. Sleeps and
  // throttle retries scale with new-orders count, not total-orders count
  // — so a 14-day window with mostly-already-captured orders runs in
  // seconds instead of minutes.
  const lineItems = [];
  let fetchedCount = 0;
  let skippedCount = 0;
  for (const order of allOrders) {
    if (existingOrderIds.has(order.AmazonOrderId)) {
      skippedCount++;
      continue;
    }
    fetchedCount++;
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
  console.log(`[ORDERS] Items pass: fetched=${fetchedCount} skipped-already-captured=${skippedCount} (${allOrders.length} orders in window)`);

  return { lineItems, seenOrderIds };
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

// Writes newLineItems to KV month-by-month, deduping by `${orderId}:${sku}`.
// `seenOrderIds` is the set of every active order ID returned by getOrders
// for the window (NOT just orders whose items were re-fetched this run —
// fetchOrdersForDateRange now skips re-fetching items for orders already
// captured, so newLineItems alone is no longer a complete view of "which
// orders exist for this window"). seenOrderIds is what cancellation
// reconciliation uses to tell "still on Amazon" apart from "canceled".
//
// When a window is provided, any KV record whose orderDate falls in
// `[windowStart, windowEnd]` AND whose orderId is missing from
// seenOrderIds is considered canceled-since-original-sync and gets
// evicted. Without this, the trailing window would leave canceled
// orders in place as zombie revenue.
//
// `seenOrderIds`/`windowStart`/`windowEnd` are optional — when omitted
// (no current caller, kept for forward-compatibility), the function
// preserves its pre-change add-only behavior.
async function upsertOrdersToKV(newLineItems, seenOrderIds, windowStart, windowEnd) {
  // Skip only if there's nothing to write AND no reconciliation work
  // (no window means no eviction pass). When a window IS supplied, even
  // an empty newLineItems still triggers the per-month read so eviction
  // can run.
  if (newLineItems.length === 0 && !windowStart) return;

  const byMonth = {};
  for (const order of newLineItems) {
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
    // for a 30-day window crossing a month boundary.
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

  const reconcile = !!(seenOrderIds && windowStart && windowEnd);

  for (const [month, orders] of Object.entries(byMonth)) {
    const existing = await kv.get(`orders:${month}`) || [];
    const dedupeMap = {};
    for (const o of existing) dedupeMap[`${o.orderId}:${o.sku}`] = o;
    for (const o of orders) dedupeMap[`${o.orderId}:${o.sku}`] = o;

    // Cancellation reconciliation: drop KV records whose orderDate is
    // inside the re-fetched window but whose orderId is NOT in
    // seenOrderIds. fetchOrdersForDateRange filters out Canceled orders
    // before building seenOrderIds, so a missing orderId means "canceled
    // or otherwise disappeared on Amazon's side".
    let evictedCount = 0;
    if (reconcile) {
      for (const key of Object.keys(dedupeMap)) {
        const o = dedupeMap[key];
        if (o.orderDate >= windowStart && o.orderDate <= windowEnd
            && !seenOrderIds.has(o.orderId)) {
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
