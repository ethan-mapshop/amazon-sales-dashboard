import { kv } from '@vercel/kv';
import { gunzip } from 'zlib';
import { promisify } from 'util';

const gunzipAsync = promisify(gunzip);

// ─── ROUTER ──────────────────────────────────────────────────────────────────
// Amazon Advertising API, v3 reporting endpoints. Reports are async:
//   POST /reporting/reports        → returns reportId (queued)
//   GET  /reporting/reports/{id}   → status; when COMPLETED, includes url
//   GET  {url}                     → gzipped JSON of daily rows
//
// Because report generation takes 1–5+ minutes, a single HTTP request can't
// reliably request + poll + download in one shot. So we split:
//   sync-request  → POSTs the SP + SB report requests, stashes reportIds.
//   sync-collect  → polls status; downloads + stores when ready. Idempotent.
//   sync-status   → inspect pending state.
//
// KV layout:
//   adspend:pending                  → [{ reportId, type, month, requestedAt, name }]
//   adspend:<type>:raw:YYYY-MM       → { rows: [...] }           type ∈ {sp, sb}
//   adspend:<type>:index             → ['YYYY-MM', ...]
//   adspend:last-synced:YYYY-MM      → ISO timestamp (most recent successful write)
//
// Row shape (normalized across API-sourced and Sheets-backfilled):
//   SP rows (API): { date, campaign, adGroup?, sku?, asin?, cost,
//                    impressions?, clicks?, purchases7d?, sales7d? }
//   SB rows (API): { date, campaign, cost, impressions?, clicks? }
//   Historical (Sheets backfill): { date, campaign, cost }  — no sku/asin.
// Client-side allocation checks for `sku` to decide between direct-SKU
// attribution (new API data) and campaign→SKU mapping (historical).

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
    if (action === 'sync-request')        return handleSyncRequest(req, res);
    if (action === 'sync-collect')        return handleSyncCollect(req, res);
    if (action === 'sync-status')         return handleSyncStatus(req, res);
    if (action === 'get')                 return handleGet(req, res);
    if (action === 'get-range')           return handleGetRange(req, res);
    if (action === 'get-months')          return handleGetMonths(req, res);
  }
  if (req.method === 'POST') {
    if (action === 'migrate-from-sheets') return handleMigrateFromSheets(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── SYNC REQUEST ────────────────────────────────────────────────────────────
// Kicks off both the SP Advertised Product and SB Campaigns reports for the
// requested month. Each returns a reportId that we stash in adspend:pending;
// sync-collect later polls those IDs and downloads the results when ready.
async function handleSyncRequest(req, res) {
  try {
    const month = req.query.month || previousMonthISO();
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return res.status(400).json({ error: 'month must be YYYY-MM' });
    }
    const { start, end } = monthBoundDates(month);

    const accessToken = await getAdsAccessToken();
    const requested = [];

    // Sponsored Products — SKU-level spend attribution via "advertised product".
    try {
      const spReportId = await requestReport(accessToken, {
        name: `SP Advertised Product ${month}`,
        startDate: start,
        endDate: end,
        configuration: {
          adProduct: 'SPONSORED_PRODUCTS',
          groupBy: ['advertiser'],
          columns: [
            'date', 'campaignName', 'adGroupName',
            'advertisedSku', 'advertisedAsin',
            'cost', 'impressions', 'clicks',
            'purchases7d', 'sales7d'
          ],
          reportTypeId: 'spAdvertisedProduct',
          timeUnit: 'DAILY',
          format: 'GZIP_JSON'
        }
      });
      requested.push({ reportId: spReportId, type: 'sp', month, requestedAt: new Date().toISOString(), name: `SP Advertised Product ${month}` });
    } catch (err) {
      console.error('[ADSPEND] SP request failed:', err.message);
      requested.push({ type: 'sp', month, error: err.message });
    }

    // Sponsored Brands — campaign-level (SB doesn't expose per-SKU spend).
    try {
      const sbReportId = await requestReport(accessToken, {
        name: `SB Campaigns ${month}`,
        startDate: start,
        endDate: end,
        configuration: {
          adProduct: 'SPONSORED_BRANDS',
          groupBy: ['campaign'],
          columns: [
            'date', 'campaignName', 'campaignId',
            'cost', 'impressions', 'clicks'
          ],
          reportTypeId: 'sbCampaigns',
          timeUnit: 'DAILY',
          format: 'GZIP_JSON'
        }
      });
      requested.push({ reportId: sbReportId, type: 'sb', month, requestedAt: new Date().toISOString(), name: `SB Campaigns ${month}` });
    } catch (err) {
      console.error('[ADSPEND] SB request failed:', err.message);
      requested.push({ type: 'sb', month, error: err.message });
    }

    // Merge new report requests into the pending list (keep existing ones).
    const pending = (await kv.get('adspend:pending')) || [];
    const goodOnes = requested.filter(r => r.reportId);
    await kv.set('adspend:pending', [...pending, ...goodOnes]);

    return res.status(200).json({
      success: true,
      month,
      requested,
      pendingNow: pending.length + goodOnes.length,
      message: 'Reports requested from Amazon. Call sync-collect in ~1–5 minutes to download when ready.'
    });
  } catch (error) {
    console.error('[ADSPEND SYNC-REQUEST] Error:', error);
    return res.status(500).json({ error: 'Sync-request failed: ' + error.message });
  }
}

// ─── SYNC COLLECT ────────────────────────────────────────────────────────────
// Walks every pending report, checks status, downloads + stores any that are
// done. Idempotent: safe to call repeatedly (UI polling) or on a cron.
async function handleSyncCollect(req, res) {
  try {
    const pending = (await kv.get('adspend:pending')) || [];
    if (pending.length === 0) {
      return res.status(200).json({ success: true, collected: [], stillPending: [], message: 'Nothing pending.' });
    }

    const accessToken = await getAdsAccessToken();
    const collected = [];
    const stillPending = [];
    const failed = [];

    for (const p of pending) {
      try {
        const status = await getReportStatus(accessToken, p.reportId);
        const statusStr = (status.status || '').toUpperCase();

        if (statusStr === 'COMPLETED' || statusStr === 'SUCCESS') {
          if (!status.url) {
            // Some tenants return `url` at the top level; others nest it.
            // Defensive: surface failure rather than silently dropping.
            failed.push({ ...p, error: 'COMPLETED but no url on status response' });
            continue;
          }
          const rawRows = await downloadReport(status.url);
          const normalized = normalizeRows(rawRows, p.type);
          await storeMonthly(p.type, p.month, normalized);
          await kv.set(`adspend:last-synced:${p.month}`, new Date().toISOString());
          collected.push({ ...p, rowCount: normalized.length });
        } else if (statusStr === 'FAILURE' || statusStr === 'CANCELLED') {
          failed.push({ ...p, error: status.statusDetails || `status=${statusStr}` });
        } else {
          // PENDING / PROCESSING / etc. — keep waiting.
          stillPending.push({ ...p, currentStatus: statusStr });
        }
      } catch (err) {
        console.error('[ADSPEND] Collect failure for report', p.reportId, err.message);
        // Don't drop from pending on transient errors; try again next collect call.
        stillPending.push({ ...p, lastError: err.message });
      }
    }

    // Anything collected or explicitly failed is removed from pending. Still-
    // pending items stay for the next call.
    await kv.set('adspend:pending', stillPending);

    return res.status(200).json({
      success: true,
      collected,
      failed,
      stillPending,
      message:
        collected.length === 0 && stillPending.length > 0
          ? 'Reports still generating on Amazon\'s side. Try again in a minute.'
          : `Collected ${collected.length}; ${stillPending.length} still pending; ${failed.length} failed.`
    });
  } catch (error) {
    console.error('[ADSPEND SYNC-COLLECT] Error:', error);
    return res.status(500).json({ error: 'Sync-collect failed: ' + error.message });
  }
}

async function handleSyncStatus(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const pending = (await kv.get('adspend:pending')) || [];
    return res.status(200).json({ success: true, pending, count: pending.length });
  } catch (error) {
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

// ─── READ ────────────────────────────────────────────────────────────────────
async function handleGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { type, month } = req.query;
    if (!['sp', 'sb'].includes(type)) return res.status(400).json({ error: 'type must be sp or sb' });
    if (!/^\d{4}-\d{2}$/.test(month))  return res.status(400).json({ error: 'month=YYYY-MM required' });

    const [stored, lastSynced] = await Promise.all([
      kv.get(`adspend:${type}:raw:${month}`),
      kv.get(`adspend:last-synced:${month}`)
    ]);
    return res.status(200).json({
      success: true,
      type,
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

    const { type, startMonth, endMonth } = req.query;
    if (!['sp', 'sb'].includes(type)) return res.status(400).json({ error: 'type must be sp or sb' });
    if (!startMonth || !endMonth)      return res.status(400).json({ error: 'startMonth and endMonth required' });

    const index = (await kv.get(`adspend:${type}:index`)) || [];
    const months = index.filter(m => m >= startMonth && m <= endMonth);
    const buckets = await Promise.all(months.map(m => kv.get(`adspend:${type}:raw:${m}`)));
    const rows = [];
    for (const b of buckets) {
      if (b && Array.isArray(b.rows)) for (const r of b.rows) rows.push(r);
    }
    return res.status(200).json({ success: true, type, startMonth, endMonth, months, rows });
  } catch (error) {
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

async function handleGetMonths(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const [spIndex, sbIndex] = await Promise.all([
      kv.get('adspend:sp:index'),
      kv.get('adspend:sb:index')
    ]);
    return res.status(200).json({ success: true, sp: spIndex || [], sb: sbIndex || [] });
  } catch (error) {
    return res.status(500).json({ error: 'Failed: ' + error.message });
  }
}

// ─── MIGRATE FROM SHEETS ─────────────────────────────────────────────────────
// Reads ProductAdSpend / BrandAdSpend tabs from the user's Google Sheet and
// stores each month's daily rows under the corresponding adspend:<type>:raw
// keys. Historical rows don't have SKU attribution (Sheets was campaign-level
// only) — those are stored as { date, campaign, cost } and the client uses the
// existing campaign→SKU mapping for allocation.
async function handleMigrateFromSheets(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });
    const accessToken = req.headers.authorization?.replace('Bearer ', '');

    const spreadsheetId = req.body?.spreadsheetId;
    if (!spreadsheetId) return res.status(400).json({ error: 'spreadsheetId required' });

    const readSheet = async (tab) => {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${tab}`;
      const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!r.ok) throw new Error(`${tab} read failed (${r.status})`);
      return (await r.json()).values || [];
    };

    const counts = {};
    for (const { type, tab } of [
      { type: 'sp', tab: 'ProductAdSpend' },
      { type: 'sb', tab: 'BrandAdSpend' }
    ]) {
      const values = await readSheet(tab);
      if (values.length < 2) { counts[type] = 0; continue; }

      const headers = values[0].map(h => String(h || '').trim().toLowerCase());
      const iDate     = headers.indexOf('date');
      const iCampaign = headers.findIndex(h => h === 'campaign name' || h === 'campaign');
      const iCost     = headers.findIndex(h => h === 'spend' || h === 'cost');
      if (iDate === -1 || iCampaign === -1 || iCost === -1) {
        throw new Error(`${tab} missing required columns (date, campaign name, spend)`);
      }

      const byMonth = {};
      for (let i = 1; i < values.length; i++) {
        const row = values[i] || [];
        const date = String(row[iDate] || '').trim().substring(0, 10);
        const campaign = String(row[iCampaign] || '').trim();
        const cost = parseFloat(row[iCost]);
        if (!date || !campaign || !Number.isFinite(cost)) continue;
        const month = date.substring(0, 7);
        if (!/^\d{4}-\d{2}$/.test(month)) continue;
        if (!byMonth[month]) byMonth[month] = [];
        byMonth[month].push({ date, campaign, cost });
      }

      // Write each month as its own raw bucket. Append-merge with any
      // existing rows so running this twice doesn't wipe good data.
      const index = (await kv.get(`adspend:${type}:index`)) || [];
      let total = 0;
      for (const [month, rows] of Object.entries(byMonth)) {
        const existing = await kv.get(`adspend:${type}:raw:${month}`);
        const existingRows = (existing && Array.isArray(existing.rows)) ? existing.rows : [];
        const merged = dedupeRows([...existingRows, ...rows]);
        await kv.set(`adspend:${type}:raw:${month}`, { rows: merged });
        total += rows.length;
        if (!index.includes(month)) index.push(month);
      }
      index.sort();
      await kv.set(`adspend:${type}:index`, index);
      counts[type] = total;
    }

    return res.status(200).json({ success: true, counts, message: `Migrated from Sheets: SP=${counts.sp} rows, SB=${counts.sb} rows.` });
  } catch (error) {
    console.error('[ADSPEND MIGRATE] Error:', error);
    return res.status(500).json({ error: 'Migrate failed: ' + error.message });
  }
}

// ─── ADVERTISING API CLIENT ──────────────────────────────────────────────────

async function getAdsAccessToken() {
  const params = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: process.env.ADV_REFRESH_TOKEN,
    client_id: process.env.ADV_CLIENT_ID,
    client_secret: process.env.ADV_CLIENT_SECRET
  });
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });
  const body = await res.json();
  if (!res.ok || !body.access_token) {
    throw new Error('Token refresh failed: ' + JSON.stringify(body));
  }
  return body.access_token;
}

function adsAuthHeaders(accessToken, extra = {}) {
  return {
    'Authorization': `Bearer ${accessToken}`,
    'Amazon-Advertising-API-ClientId': process.env.ADV_CLIENT_ID,
    'Amazon-Advertising-API-Scope': process.env.ADV_PROFILE_ID,
    ...extra
  };
}

async function requestReport(accessToken, body) {
  const res = await fetch('https://advertising-api.amazon.com/reporting/reports', {
    method: 'POST',
    headers: adsAuthHeaders(accessToken, {
      'Content-Type': 'application/vnd.createasyncreportrequest.v3+json',
      'Accept': 'application/vnd.createasyncreportrequest.v3+json'
    }),
    body: JSON.stringify(body)
  });
  const resp = await res.json();
  if (!res.ok || !resp.reportId) {
    throw new Error(`Report request failed (${res.status}): ${JSON.stringify(resp)}`);
  }
  return resp.reportId;
}

async function getReportStatus(accessToken, reportId) {
  const res = await fetch(`https://advertising-api.amazon.com/reporting/reports/${reportId}`, {
    headers: adsAuthHeaders(accessToken, {
      'Accept': 'application/vnd.getasyncreportrequest.v3+json'
    })
  });
  const resp = await res.json();
  if (!res.ok) {
    throw new Error(`Status check failed (${res.status}): ${JSON.stringify(resp)}`);
  }
  return resp;
}

async function downloadReport(url) {
  // The download URL is pre-signed — no auth headers needed.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const decompressed = await gunzipAsync(buffer);
  const text = decompressed.toString('utf-8');
  // V3 reports return a JSON array. Some tenants return NDJSON (one row per line);
  // handle either.
  try {
    return JSON.parse(text);
  } catch {
    return text
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => JSON.parse(l));
  }
}

// Normalize an API row to our stored shape. Different report types return
// different column names; collapse to a common schema here so the client
// doesn't have to care.
function normalizeRows(rawRows, type) {
  if (!Array.isArray(rawRows)) return [];
  if (type === 'sp') {
    return rawRows.map(r => ({
      date:        (r.date || '').substring(0, 10),
      campaign:    r.campaignName || '',
      adGroup:     r.adGroupName || '',
      sku:         r.advertisedSku || '',
      asin:        r.advertisedAsin || '',
      cost:        num(r.cost),
      impressions: num(r.impressions),
      clicks:      num(r.clicks),
      purchases7d: num(r.purchases7d),
      sales7d:     num(r.sales7d)
    })).filter(r => r.date && r.campaign);
  }
  if (type === 'sb') {
    return rawRows.map(r => ({
      date:        (r.date || '').substring(0, 10),
      campaign:    r.campaignName || '',
      campaignId:  r.campaignId || '',
      cost:        num(r.cost),
      impressions: num(r.impressions),
      clicks:      num(r.clicks)
    })).filter(r => r.date && r.campaign);
  }
  return [];
}

async function storeMonthly(type, month, rows) {
  // Append-merge so a re-pull (or partial result) doesn't wipe prior data.
  const existing = await kv.get(`adspend:${type}:raw:${month}`);
  const existingRows = (existing && Array.isArray(existing.rows)) ? existing.rows : [];
  const merged = dedupeRows([...existingRows, ...rows]);
  await kv.set(`adspend:${type}:raw:${month}`, { rows: merged });

  const index = (await kv.get(`adspend:${type}:index`)) || [];
  if (!index.includes(month)) {
    index.push(month);
    index.sort();
    await kv.set(`adspend:${type}:index`, index);
  }
}

// Best-effort dedupe: drop rows that match on the dimension fields and cost.
// Prevents duplicate entries if a sync pull overlaps an existing stored set.
function dedupeRows(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const key = `${r.date}|${r.campaign}|${r.sku || ''}|${r.adGroup || ''}|${r.cost}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function verifyGoogleToken(req) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return { ok: false, error: 'No access token provided' };
  const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verify.ok) return { ok: false, error: 'Invalid access token' };
  return { ok: true };
}

function num(v) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
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
