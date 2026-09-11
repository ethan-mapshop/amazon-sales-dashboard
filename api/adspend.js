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
// This file also hosts the Weekly Red Flag Monitor (weekly-request /
// weekly-status / weekly-collect) at the bottom. It shares the
// Advertising API client below but none of the KV layout described here — see
// that section's own banner. It is here only because Vercel's Hobby plan caps a
// deployment at 12 serverless functions.
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
    // Weekly Red Flag Monitor — see the section at the bottom of this file.
    if (action === 'weekly-request')      return handleWeeklyRequest(req, res);
    if (action === 'weekly-status')       return handleWeeklyStatus(req, res);
    if (action === 'weekly-collect')      return handleWeeklyCollect(req, res);
    // Bi-weekly tactical budget management — see the section at the bottom.
    if (action === 'biweekly-request')    return handleBiweeklyRequest(req, res);
    if (action === 'biweekly-status')     return handleBiweeklyStatus(req, res);
    if (action === 'biweekly-collect')    return handleBiweeklyCollect(req, res);
  }
  if (req.method === 'POST') {
    if (action === 'migrate-from-sheets')     return handleMigrateFromSheets(req, res);
    if (action === 'dedupe-sheets-vs-api')    return handleDedupeSheetsVsApi(req, res);
    if (action === 'delete-sheets-rows')      return handleDeleteSheetsRows(req, res);
    if (action === 'upload-yearly-csv')       return handleUploadYearlyCsv(req, res);
    if (action === 'biweekly-posture')        return handleBiweeklyPosture(req, res);
    if (action === 'biweekly-recompute')      return handleBiweeklyRecompute(req, res);
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

    // types=sp, types=sb, or types=sp,sb (default = both).
    const typesParam = (req.query.types || 'sp,sb').toLowerCase();
    const wanted = new Set(typesParam.split(',').map(s => s.trim()).filter(Boolean));

    const accessToken = await getAdsAccessToken();
    const requested = [];

    // Sponsored Products — SKU-level spend attribution via "advertised product".
    if (wanted.has('sp')) try {
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
    if (wanted.has('sb')) try {
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

    const [spIndex, sbIndex, spLatestMap, sbLatestMap] = await Promise.all([
      kv.get('adspend:sp:index'),
      kv.get('adspend:sb:index'),
      kv.get('adspend:sp:latest-posted'),
      kv.get('adspend:sb:latest-posted')
    ]);

    const sp = Array.isArray(spIndex) ? spIndex : [];
    const sb = Array.isArray(sbIndex) ? sbIndex : [];

    // Lazy backfill: the most recent month for each type may pre-date
    // the latest-posted-by-month dictionary. Scan that month's rows
    // once if missing so the overview "Most Recent Ad Spend Data" label
    // still shows the actual latest date (e.g. 3/31/26) rather than
    // being blank for users who haven't re-synced since this code
    // shipped.
    const sanitize = (v) => (v && typeof v === 'object') ? { ...v } : {};
    const spMap = sanitize(spLatestMap);
    const sbMap = sanitize(sbLatestMap);

    async function backfill(type, months, map, mapKey) {
      if (months.length === 0) return;
      const latestMonth = months[months.length - 1];
      if (map[latestMonth]) return;
      const stored = await kv.get(`adspend:${type}:raw:${latestMonth}`);
      const rows = (stored && Array.isArray(stored.rows)) ? stored.rows : [];
      let monthLatest = null;
      for (const r of rows) {
        const d = r?.date;
        if (d && (!monthLatest || d > monthLatest)) monthLatest = d;
      }
      if (monthLatest) {
        map[latestMonth] = monthLatest;
        await kv.set(mapKey, map);
      }
    }
    await Promise.all([
      backfill('sp', sp, spMap, 'adspend:sp:latest-posted'),
      backfill('sb', sb, sbMap, 'adspend:sb:latest-posted')
    ]);

    // Global latest across both ad-product types.
    let latestPostedDate = null;
    for (const v of [...Object.values(spMap), ...Object.values(sbMap)]) {
      if (v && (!latestPostedDate || v > latestPostedDate)) latestPostedDate = v;
    }

    return res.status(200).json({
      success: true,
      sp,
      sb,
      latestPostedDate,
      spLatestPostedByMonth: spMap,
      sbLatestPostedByMonth: sbMap
    });
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

      // Write each month as its own raw bucket, but skip any month where
      // API data already exists (detected by the presence of at least one
      // sku-bearing row). API data is richer and authoritative; we only
      // want Sheets migration to fill in months the API hasn't touched.
      const index = (await kv.get(`adspend:${type}:index`)) || [];
      let writtenRows = 0;
      const skippedMonths = [];
      for (const [month, rows] of Object.entries(byMonth)) {
        const existing = await kv.get(`adspend:${type}:raw:${month}`);
        const existingRows = (existing && Array.isArray(existing.rows)) ? existing.rows : [];
        const apiRowsPresent = existingRows.some(r => r && r.sku);
        if (apiRowsPresent) {
          skippedMonths.push(month);
          continue;
        }
        await kv.set(`adspend:${type}:raw:${month}`, { rows: dedupeRows(rows) });
        writtenRows += rows.length;
        if (!index.includes(month)) index.push(month);
      }
      index.sort();
      await kv.set(`adspend:${type}:index`, index);
      counts[type] = { rows: writtenRows, skippedMonths };
    }

    return res.status(200).json({
      success: true,
      counts,
      message: `Migrated from Sheets: SP=${counts.sp.rows} rows (skipped ${counts.sp.skippedMonths.length} months that already have API data), SB=${counts.sb.rows} rows (skipped ${counts.sb.skippedMonths.length}).`
    });
  } catch (error) {
    console.error('[ADSPEND MIGRATE] Error:', error);
    return res.status(500).json({ error: 'Migrate failed: ' + error.message });
  }
}

// ─── UPLOAD YEARLY CSV (Amazon Ads Sponsored Products Report) ───────────────
//
// Client-parsed Amazon Ads "Sponsored Products Campaign Performance" CSV
// posted as JSON rows. Same destination as handleMigrateFromSheets — the
// `adspend:sp:raw:YYYY-MM` bucket — but data comes from a file upload
// instead of a Google Sheets tab. The row shape we write is the same
// historical/Sheets shape ({ date, campaign, cost }, no SKU) which means
// allocation falls back to the campaign→SKU mapping table on the client.
//
// Body: { type: 'sp' | 'sb', rows: [{Date|date, "Campaign Name"|campaign,
// Spend|spend|cost}, ...] }. We accept either the raw CSV column casing
// or already-normalized lowercase keys; that way the client doesn't have
// to know which format the API expects.
async function handleUploadYearlyCsv(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const type = String(req.body?.type || '').toLowerCase();
    if (!['sp', 'sb'].includes(type)) {
      return res.status(400).json({ error: 'type must be "sp" or "sb"' });
    }
    const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : null;
    if (!rawRows) return res.status(400).json({ error: 'rows array required in body' });

    // Reuse the same casing-tolerant lookup pattern as the transactions
    // upload — pull the three fields we care about and ignore the rest.
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
    let skippedNoDate = 0;
    let skippedNoCost = 0;
    for (const r of rawRows) {
      if (!r || typeof r !== 'object') continue;
      let date = String(pick(r, 'date', 'Date') || '').trim().slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        // Tolerate the raw "Jan 01, 2024" form if the client didn't pre-
        // parse it (Amazon Ads exports it that way).
        const parsed = _adspendParseDateServer(date);
        if (parsed) date = parsed;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { skippedNoDate++; continue; }
      const campaign = String(pick(r, 'campaign', 'Campaign Name', 'campaign name') || '').trim();
      const costRaw = pick(r, 'cost', 'spend', 'Spend');
      const cost = parseFloat(String(costRaw ?? '').replace(/[$,]/g, ''));
      if (!campaign || !Number.isFinite(cost)) { skippedNoCost++; continue; }

      const month = date.slice(0, 7);
      if (!byMonth[month]) byMonth[month] = [];
      byMonth[month].push({ date, campaign, cost });
    }

    // Same "skip if API rows present" rule as migrate-from-sheets. API
    // rows are detected by the presence of a `sku` field on at least one
    // row — historical/Sheets/upload rows never set sku, so this check
    // cleanly separates the two sources.
    const index = (await kv.get(`adspend:${type}:index`)) || [];
    let writtenRows = 0;
    const writtenMonths = [];
    const skippedMonths = [];
    for (const [month, rows] of Object.entries(byMonth)) {
      const existing = await kv.get(`adspend:${type}:raw:${month}`);
      const existingRows = (existing && Array.isArray(existing.rows)) ? existing.rows : [];
      const apiRowsPresent = existingRows.some(rw => rw && rw.sku);
      if (apiRowsPresent) {
        skippedMonths.push(month);
        continue;
      }
      await kv.set(`adspend:${type}:raw:${month}`, { rows: dedupeRows(rows) });
      writtenRows += rows.length;
      writtenMonths.push(month);
      if (!index.includes(month)) index.push(month);
    }
    index.sort();
    await kv.set(`adspend:${type}:index`, index);

    return res.status(200).json({
      success: true,
      type,
      writtenMonths: writtenMonths.sort(),
      writtenRows,
      skippedMonths,
      skippedNoDate,
      skippedNoCost,
      message: `Uploaded ${writtenRows} ${type.toUpperCase()} rows across ${writtenMonths.length} months${skippedMonths.length ? `; skipped ${skippedMonths.length} months with API data already present` : ''}.`
    });
  } catch (error) {
    console.error('[ADSPEND UPLOAD-YEARLY] Error:', error);
    return res.status(500).json({ error: 'Upload failed: ' + error.message });
  }
}

function _adspendParseDateServer(s) {
  if (!s) return null;
  const m = String(s).match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
  if (!m) return null;
  const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
                   jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
  const mm = months[m[1].toLowerCase().substring(0, 3)];
  if (!mm) return null;
  return `${m[3]}-${mm}-${m[2].padStart(2, '0')}`;
}

// ─── DELETE SHEETS-MIGRATED ROWS ─────────────────────────────────────────────
// Brute-force version of the dedupe: wipe every row that's missing a `sku`
// from the specified month's bucket. Unconditional — doesn't check whether
// API data is present, so it also clears any pure-Sheets month if you aim
// it there. Leaves API rows (sku present) untouched. Returns before/after
// counts and total cost so the cleanup is easy to verify.
//
// POST body: { type: 'sp' | 'sb', month: 'YYYY-MM' }
async function handleDeleteSheetsRows(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { type, month } = req.body || {};
    if (!['sp', 'sb'].includes(type)) return res.status(400).json({ error: 'type must be sp or sb' });
    if (!/^\d{4}-\d{2}$/.test(month || '')) return res.status(400).json({ error: 'month=YYYY-MM required' });

    const stored = await kv.get(`adspend:${type}:raw:${month}`);
    const rows = (stored && Array.isArray(stored.rows)) ? stored.rows : [];
    const before = rows.length;
    const beforeCost = rows.reduce((s, r) => s + (Number(r?.cost) || 0), 0);

    const kept = rows.filter(r => r && typeof r.sku === 'string' && r.sku.length > 0);
    const dropped = before - kept.length;
    const keptCost = kept.reduce((s, r) => s + (Number(r.cost) || 0), 0);

    await kv.set(`adspend:${type}:raw:${month}`, { rows: kept });

    return res.status(200).json({
      success: true,
      type, month,
      before: { rows: before, totalCost: round2(beforeCost) },
      after:  { rows: kept.length, totalCost: round2(keptCost) },
      dropped
    });
  } catch (error) {
    return res.status(500).json({ error: 'Delete failed: ' + error.message });
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ─── DEDUPE SHEETS VS API ────────────────────────────────────────────────────
// One-shot fixup for months that were written both by migrate-from-sheets
// (campaign-level, no SKU) and by sync-collect (SKU-level from the API),
// producing doubled totals. Rule: within any month whose stored rows
// include at least one sku-bearing row, drop every sku-less row. Months
// that are still purely Sheets-sourced (no sku on any row) are untouched
// so historical data isn't wiped.
//
// POST body: { type: 'sp' | 'sb', month?: 'YYYY-MM' }
//   month omitted ⇒ walk every month in the type's index.
async function handleDedupeSheetsVsApi(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const { type, month } = req.body || {};
    if (!['sp', 'sb'].includes(type)) return res.status(400).json({ error: 'type must be sp or sb' });

    const monthsToCheck = month
      ? [month]
      : ((await kv.get(`adspend:${type}:index`)) || []);

    const results = [];
    for (const m of monthsToCheck) {
      const stored = await kv.get(`adspend:${type}:raw:${m}`);
      const rows = (stored && Array.isArray(stored.rows)) ? stored.rows : [];
      if (rows.length === 0) { results.push({ month: m, action: 'no-data' }); continue; }

      const hasApi = rows.some(r => r && r.sku);
      if (!hasApi) { results.push({ month: m, action: 'kept-as-sheets-only', rows: rows.length }); continue; }

      const kept = rows.filter(r => r && r.sku);
      const dropped = rows.length - kept.length;
      if (dropped === 0) { results.push({ month: m, action: 'already-clean', rows: rows.length }); continue; }

      await kv.set(`adspend:${type}:raw:${m}`, { rows: kept });
      results.push({ month: m, action: 'deduped', kept: kept.length, dropped });
    }

    return res.status(200).json({ success: true, type, results });
  } catch (error) {
    return res.status(500).json({ error: 'Dedupe failed: ' + error.message });
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
  const resp = await res.json().catch(() => ({}));
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
  const resp = await res.json().catch(() => ({}));
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
  // Replace rather than merge: API-sourced data is authoritative for the
  // month. Merging would stack Sheets-migrated campaign-level rows on top
  // of API-delivered SKU-level rows and double-count totals. Re-pulling
  // the same month is expected to overwrite cleanly.
  await kv.set(`adspend:${type}:raw:${month}`, { rows });

  const index = (await kv.get(`adspend:${type}:index`)) || [];
  if (!index.includes(month)) {
    index.push(month);
    index.sort();
    await kv.set(`adspend:${type}:index`, index);
  }

  // Track the latest daily date in this month's rows so the overview
  // page can render "Most Recent Ad Spend Data: 3/31/26" without
  // scanning every blob. Stored as a single dictionary key per type
  // keyed by YYYY-MM.
  let monthLatest = null;
  for (const r of rows) {
    const d = r?.date;
    if (d && (!monthLatest || d > monthLatest)) monthLatest = d;
  }
  if (monthLatest) {
    const map = (await kv.get(`adspend:${type}:latest-posted`)) || {};
    map[month] = monthLatest;
    await kv.set(`adspend:${type}:latest-posted`, map);
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

// ═════════════════════════════════════════════════════════════════════════════
// WEEKLY RED FLAG MONITOR
// ═════════════════════════════════════════════════════════════════════════════
// Implements Amazon_Ad_Management_Weekly.docx — the Tuesday cadence.
//
// OBSERVATIONAL ONLY. It reports; it never writes to Amazon and never adjusts
// anything. Adjustments belong to the bi-weekly cadence, and the separation is
// deliberate — do not add edit controls here.
//
// Two sources, and keeping them apart is the whole design:
//
//   CONFIGURATION — which campaigns exist, and their daily budget, state,
//                   brand and portfolio. Read from the Campaign Overview
//                   snapshot (adcampaigns:current). The reporting API has no
//                   column for any of it; asking it for configuration is what
//                   the previous implementation did, and it is why budgets and
//                   portfolios never worked.
//
//   PERFORMANCE   — cost, clicks, impressions, orders and sales per campaign
//                   per day. The 7-day week window and the 28-day trailing
//                   baseline abut, but v3 caps a report at MAX_REPORT_DAYS,
//                   and 35 is over it — so they go as separate requests, two
//                   per ad product. Nothing is stored between runs.
//
// The snapshot is the spine. Every enabled campaign in it is evaluated whether
// or not the report mentions it — a campaign with no report rows spent nothing
// that week, which is a fact rather than a gap. This is what makes the
// denominator knowable.
//
// Flow, client-driven because report generation takes 1–5+ minutes:
//   /api/adcampaigns?action=refresh  → freshen the census (step 0)
//   weekly-request                   → 2 report requests, returns reportIds
//   weekly-status                    → poll
//   weekly-collect                   → download, evaluate, return the note
//
// Persists nothing of its own — it reads adcampaigns:* and writes no KV key.
//
// Lives in this file rather than its own because Vercel's Hobby plan caps a
// deployment at 12 serverless functions. It shares the Advertising API client
// above but none of the adspend:* KV layout.

// ─── RF_CONFIG ───────────────────────────────────────────────────────────────
// Every threshold is from the cadence doc and is applied exactly — the doc's
// own words are "do not adjust for feel or context". Returned with each run so
// the output can be checked against the spec without reading this file.
const RF_CONFIG = {
  // 1 — budget cap emergencies
  CAP_DAY_RATIO:         0.95,  // a day counts as "at cap" at ≥ 95% of the daily budget
  CAP_DAYS_MIN:          4,     // ... on at least this many days of the week
  CAP_RETENTION_MIN:     0.50,  // ... and 28-day profit retention ≥ 50%
  RAISE_MIN:             0.25,  // suggested raise at CAP_DAYS_MIN days at cap
  RAISE_MAX:             0.50,  // ... rising to this when capped every day
  // 3 — spend collapse
  COLLAPSE_RATIO:        0.50,  // 7-day spend at or below half the trailing weekly average
  COLLAPSE_MIN_BASELINE: 10,    // ... and a baseline worth collapsing from
  // 4 — CTR collapse
  CTR_COLLAPSE_RATIO:    0.50,  // week CTR at or below half the baseline
  CTR_MIN_IMPRESSIONS:   2000,  // ... on enough impressions to mean anything
  // 5 — CPC spike
  CPC_SPIKE_MULTIPLE:    1.50,  // week CPC at or above 1.5× the baseline
  CPC_MIN_CLICKS:        20,    // ... on enough clicks in both windows
  CUT_MIN:               0.10,  // suggested bid cut at the flagging threshold
  CUT_MAX:               0.25,  // ... rising to this at twice the threshold
  // 6 — brand pacing
  PACING_DEVIATION:      0.30   // brand spend ±30% of trailing weekly average
};

// DEVIATIONS FROM THE CADENCE DOC, recorded so they stay decisions rather than
// drift. The doc's four checks predate knowing that Amazon's 7-day attribution
// window leaves conversion data incomplete for the days closest to the run —
// which is fatal for a cadence whose whole value is speed.
const RF_SPEC_DEVIATIONS = [
  'Checks 2 (runaway spenders) and 3 (stalled campaigns) are removed. Both turn ' +
  'on conversion metrics, which Amazon leaves incomplete for 7 days after the ' +
  'click, biased downward — so on a fresh window they manufacture runaways and ' +
  'stalls. Profitability judgements belong to the bi-weekly cadence, where the ' +
  'data has settled.',

  'Four checks added that use only impressions, clicks and spend, all final the ' +
  'day they happen: silent campaigns, spend collapse, CTR collapse and CPC spike.',

  'Check 1 counts days at cap rather than time-in-budget, which Amazon exposes ' +
  'only in the console Budget Report. Its profit retention gate reads the 28-day ' +
  'baseline rather than the week: campaign economics are a standing property, ' +
  'and there is no fresher retention to be had.',

  'Every enabled campaign is evaluated; the doc excludes campaigns under $5 of ' +
  'weekly spend. The reports are pulled in full either way.',

  'Sponsored Brands is not evaluated. Two campaigns out of ~142, and its report ' +
  'was the slow one gating every run. SB is reviewed in the monthly cadence, ' +
  'which already has a dedicated section for it.'
];

// Tier 1 in the doc cuts straight to a $1 floor. It is staged here instead:
// -40% on one bad fortnight, -70% when the prior fortnight was bad too. These
// campaigns are volatile enough that one fortnight is not proof, and a floored
// campaign produces too little data to ever demonstrate a recovery. Repeated,
// -70% reaches the floor on its own.
const BW_SPEC_DEVIATIONS = [
  'Rows are sorted alphabetically by campaign name; the doc sorts by magnitude ' +
  'of change. The list is worked down with checkboxes rather than skimmed, and ' +
  'the naming convention already groups each brand together.',

  'Tier 1 stages its response rather than cutting straight to the $1 floor: ' +
  '-40% on a single bad fortnight, -70% when the prior fortnight was bad too. ' +
  'Repeated, that reaches the floor anyway, with a chance to recover at each step.',

  'Sponsored Brands is not evaluated. Its 14-day attribution window does not ' +
  'settle inside the 8-day lag this cadence uses, so retention would read low — and ' +
  'Tier 1 acts on exactly that. SB is reviewed monthly.',

  'Capped campaigns under 25% retention hold, per the strict first-match rule ' +
  'the doc states. The Tier 3 scope line ("not capped or retention too low to ' +
  'scale") could ' +
  'be read as sending them to a decrease instead; holding never cuts a budget on ' +
  'an interpretation.'
];

// Gross margin per MARGIN SEGMENT. Brand comes from the census — which already
// applies the prefix table AND any manual override set on the Campaign
// Overview page — so there is no second brand table here. Only the BrightWay
// split needs the campaign name: Packs and Sets have materially different
// economics and nothing else distinguishes them.
const MARGINS = {
  BW_PACKS:   0.38,
  BW_SETS:    0.51,
  BW_BLENDED: 0.45,
  HUBBARD:    0.52,
  MAPSHOP:    0.44,
  SOK:        0.39
};

const BRAND_SEGMENT = {
  'BrightWay Educational': 'BW_BLENDED',
  'Hubbard Scientific':    'HUBBARD',
  'MapShop State Maps':    'MAPSHOP',
  'South of Kings':        'SOK'
};

function rfSegment(brand, campaignName) {
  if (brand !== 'BrightWay Educational') return BRAND_SEGMENT[brand] || null;
  const up = String(campaignName || '').trim().toUpperCase();
  if (up.startsWith('MAP PACKS') || up.startsWith('BW PACK')) return 'BW_PACKS';
  if (up.startsWith('BW SET')) return 'BW_SETS';
  return 'BW_BLENDED';
}

// Metrics only. Name, status, budget, budget type and portfolio all come from
// the census, so none of them are requested here — which is also why there is
// no fallback ladder: a refused column now means a real problem worth stopping
// for, not a cue to silently run on less data.
const RF_COLUMNS = {
  sp: ['date', 'campaignId', 'cost', 'clicks', 'impressions', 'purchases7d', 'sales7d']
  // No sb set: neither cadence requests a Sponsored Brands report any more.
};

// Amazon's v3 reporting API rejects a request whose date range exceeds this.
// It is the entire reason the week and the baseline cannot be one report: they
// are contiguous and total 35 days.
const MAX_REPORT_DAYS = 31;

// Two windows, Sponsored Products only. Rows from both are pooled and binned
// by their own `date`, so the split is a transport detail rather than
// something the evaluation has to know about.
//
// SPONSORED BRANDS IS DELIBERATELY ABSENT. Two campaigns out of ~142, and its
// report is the slow one — it gated the whole run for 1.4% of the account. SB
// is reviewed monthly instead, where the doc already has a dedicated section
// for it with new-to-brand metrics and a 30-day window.
//
// If SB ever comes back, it must return to the SPINE as well as here: a census
// row with no report behind it reads as zero impressions and zero spend, which
// would flag both campaigns as silent and collapsed on every single run.
const REPORT_KEYS = ['spWeek', 'spBase'];

function reportSpec(key, window) {
  return key.endsWith('Week')
    ? { product: 'sp', start: window.weekStart, end: window.weekEnd }
    : { product: 'sp', start: window.baseStart, end: window.baseEnd };
}
const REPORT_ID_RE = /^[A-Za-z0-9._-]{8,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ─── WEEKLY REQUEST ──────────────────────────────────────────────────────────
// Fires the two report requests SEQUENTIALLY. v3 returns 425 for a duplicate
// createReport while an identical one is still running, and has been observed
// to false-positive when similar reports go out in the same tick.
async function handleWeeklyRequest(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const missing = missingAdsCredentials();
    if (missing.length) {
      return res.status(500).json({ error: `Missing Advertising API credentials: ${missing.join(', ')}` });
    }

    const window = resolveWindow(new Date());
    const accessToken = await getAdsAccessToken();
    const reports = [];
    const failures = [];

    for (const key of REPORT_KEYS) {
      const spec = reportSpec(key, window);
      try {
        const r = await requestCampaignReport(accessToken, spec);
        reports.push({ key, ...r });
      } catch (err) {
        console.error(`[REDFLAGS REQUEST] ${key} failed:`, err.message);
        failures.push({
          key, error: err.message,
          window: `${spec.start}..${spec.end}`,
          invalidColumns: rfInvalidColumns(err.message)
        });
      }
      await sleep(600);
    }

    if (!reports.length) {
      // Amazon's reason goes in `error` as well as `failures`. A client that
      // reads only `error` on a non-2xx — which is the normal thing to do —
      // would otherwise show a generic sentence and drop the actual answer.
      return res.status(502).json({
        error: 'No report could be requested. ' + (failures[0] ? failures[0].error : ''),
        failures
      });
    }

    return res.status(200).json({
      success: true, window, reports, failures,
      requestedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[REDFLAGS REQUEST] Error:', error);
    return res.status(500).json({ error: 'Weekly-request failed: ' + error.message });
  }
}

// ─── WEEKLY STATUS ───────────────────────────────────────────────────────────
async function handleWeeklyStatus(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const parsed = parseReportsParam(req.query.reports);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const accessToken = await getAdsAccessToken();
    const statuses = [];
    for (const { key, reportId } of parsed.reports) {
      try {
        const status = await withAdsRetry(() => getReportStatus(accessToken, reportId));
        const norm = (status.status || '').toUpperCase();
        statuses.push({
          key, reportId, status: norm,
          done: norm === 'COMPLETED' || norm === 'SUCCESS',
          failed: norm === 'FAILURE' || norm === 'FAILED' || norm === 'CANCELLED'
        });
      } catch (err) {
        console.error(`[REDFLAGS STATUS] ${key} failed:`, err.message);
        statuses.push({ key, reportId, status: 'ERROR', done: false, failed: false, error: err.message });
      }
    }

    return res.status(200).json({
      success: true, statuses,
      allDone: statuses.every(s => s.done || s.failed),
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[REDFLAGS STATUS] Error:', error);
    return res.status(500).json({ error: 'Weekly-status failed: ' + error.message });
  }
}

// ─── WEEKLY COLLECT ──────────────────────────────────────────────────────────
async function handleWeeklyCollect(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const parsed = parseReportsParam(req.query.reports);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const window = parseWindowParam(req.query);
    if (window.error) return res.status(400).json({ error: window.error });

    const census = await loadCensus();
    if (!census.campaigns.length) {
      return res.status(409).json({
        error: 'No campaign snapshot stored. Refresh Campaign Overview first — ' +
               'the weekly check reads campaign budgets, brands and portfolios from it.'
      });
    }

    const accessToken = await getAdsAccessToken();
    const rows = [];
    const notes = [];

    for (const { key, reportId } of parsed.reports) {
      try {
        const status = await withAdsRetry(() => getReportStatus(accessToken, reportId));
        const url = status.url || status.location;
        if (!url) {
          notes.push({ key, note: `report not ready (${status.status || 'unknown'})` });
          continue;
        }
        const raw = await withAdsRetry(() => downloadReport(url));
        rows.push(...rfNormalizeRows(raw, key.startsWith('sp') ? 'SP' : 'SB'));
      } catch (err) {
        console.error(`[REDFLAGS COLLECT] ${key} failed:`, err.message);
        notes.push({ key, note: 'download failed: ' + err.message });
      }
    }

    if (!rows.length) {
      return res.status(502).json({ error: 'No report rows could be downloaded.', notes });
    }

    const result = evaluateWeek({ census, rows, window });

    return res.status(200).json({
      success: true,
      window,
      config: RF_CONFIG,
      deviations: RF_SPEC_DEVIATIONS,
      censusSyncedAt: census.syncedAt,
      ...result,
      notes,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[REDFLAGS COLLECT] Error:', error);
    return res.status(500).json({ error: 'Weekly-collect failed: ' + error.message });
  }
}

// ─── CENSUS ──────────────────────────────────────────────────────────────────
// The campaign configuration snapshot written by the Campaign Overview page.
// Read-only: nothing here writes an adcampaigns:* key.
async function loadCensus() {
  const [current, portfolios, changes] = await Promise.all([
    kv.get('adcampaigns:current'),
    kv.get('adcampaigns:portfolios'),
    // What changed and when. Five of the six checks say something moved without
    // saying why, and the most common why is that we moved it ourselves.
    kv.get('adcampaigns:changes')
  ]);
  const portfolioNames = {};
  for (const p of (portfolios?.rows || [])) {
    if (p.portfolioId) portfolioNames[String(p.portfolioId)] = p.name;
  }
  return {
    campaigns: current?.rows || [],
    portfolioNames,
    changes: changes?.rows || [],
    syncedAt: current?.syncedAt || null
  };
}

// ─── WINDOW ──────────────────────────────────────────────────────────────────

// Most recent COMPLETE Monday–Sunday week in Pacific time, plus the 28 days
// immediately before it. "Complete" means strictly before today, so the
// Tuesday run evaluates the week that ended Sunday. Pacific because Vercel
// runs UTC while Ads report dates are marketplace-local — a UTC-naive window
// sits a day ahead between 00:00 and 08:00 UTC.
function resolveWindow(nowInstant) {
  const today = _ptDate(nowInstant);
  const dow = new Date(today + 'T00:00:00Z').getUTCDay(); // 0=Sun … 6=Sat
  const back = dow === 0 ? 7 : dow;                       // → most recent past Sunday
  const weekEnd = _addDays(today, -back);
  const weekStart = _addDays(weekEnd, -6);
  const baseEnd = _addDays(weekStart, -1);
  const baseStart = _addDays(baseEnd, -27);
  return { weekStart, weekEnd, baseStart, baseEnd, asOf: today };
}

function parseWindowParam(q) {
  const window = {
    weekStart: String(q.weekStart || ''),
    weekEnd:   String(q.weekEnd   || ''),
    baseStart: String(q.baseStart || ''),
    baseEnd:   String(q.baseEnd   || '')
  };
  for (const [k, v] of Object.entries(window)) {
    if (!DATE_RE.test(v)) return { error: `${k} must be YYYY-MM-DD` };
  }
  if (daySpan(window.weekStart, window.weekEnd) !== 7) {
    return { error: 'week window must span exactly 7 days' };
  }
  if (daySpan(window.baseStart, window.baseEnd) !== 28) {
    return { error: 'baseline window must span exactly 28 days' };
  }
  if (_addDays(window.weekStart, -1) !== window.baseEnd) {
    return { error: 'baseline window must end the day before the week window starts' };
  }
  return window;
}

function daySpan(start, end) {
  const ms = new Date(end + 'T00:00:00Z') - new Date(start + 'T00:00:00Z');
  return Math.round(ms / 86400000) + 1;
}

// ─── EVALUATE ────────────────────────────────────────────────────────────────
// Pure, so the whole cadence can be exercised offline against fixtures.
//
// Six checks. Five read only impressions, clicks and spend from the week —
// all final the day they happen. The sixth, check 1's retention gate, reads
// the 28-day baseline, which ends 8+ days before the run and is therefore
// past Amazon's 7-day attribution window and settled.
//
// Nothing in the WEEK window touches conversions. That is the property the
// whole cadence rests on, and it is worth preserving deliberately.
function evaluateWeek({ census, rows, window }) {
  // Always the window's length, never how many days Amazon returned rows for.
  const weekDays = daySpan(window.weekStart, window.weekEnd);

  // ── the spine ──
  const campaigns = new Map();
  for (const row of census.campaigns) {
    if (String(row.state || '').toUpperCase() !== 'ENABLED') continue;
    // Sponsored Brands is not reported here, so it must not be in the spine
    // either — a row with no report behind it looks silent and collapsed.
    if (row.adProduct !== 'SP') continue;
    const brand = row.brand || null;
    const segment = brand ? rfSegment(brand, row.name) : null;
    campaigns.set(String(row.campaignId), {
      campaignId: String(row.campaignId),
      name: row.name || '',
      adProduct: row.adProduct || '',
      dailyBudget: typeof row.dailyBudget === 'number' ? row.dailyBudget : null,
      budgetType: row.budgetType || '',
      portfolioId: row.portfolioId || null,
      portfolio: (row.portfolioId && census.portfolioNames[row.portfolioId]) || null,
      // Only used to explain silence: an enabled campaign past its end date
      // serves nothing, and that is the whole answer rather than a lead.
      endDate: row.endDate || null,
      // The bid lever. adGroupId travels with it because the write goes to the
      // ad group, not the campaign.
      defaultBid: typeof row.defaultBid === 'number' ? row.defaultBid : null,
      adGroupId: row.adGroupId || null,
      brand,
      segment,
      grossMargin: segment ? MARGINS[segment] : null,
      // The week carries NO conversion metrics. Every weekly signal is built
      // from spend, clicks and impressions, which are final the day they
      // happen. Conversions are incomplete for 7 days after the click.
      spend7: 0, clicks7: 0, impressions7: 0,
      // The baseline is the comparison for every "versus normal" check, and it
      // ends 8+ days before the run, so its conversion data IS settled.
      spend28: 0, clicks28: 0, impressions28: 0, sales28: 0,
      // Per-day, because a week total cannot tell a campaign that spent evenly
      // from one that was clipped on three days and idle on four.
      spendByDate: new Map()
    });
  }

  // ── metrics fold onto the spine ──
  // A report row for a campaign the census does not list is counted rather
  // than dropped: it means the snapshot is stale, and that is worth saying.
  let orphanRows = 0;
  for (const r of rows) {
    const c = campaigns.get(r.campaignId);
    if (!c) { orphanRows++; continue; }
    if (r.date >= window.weekStart && r.date <= window.weekEnd) {
      c.spend7 += r.cost;
      c.clicks7 += r.clicks;
      c.impressions7 += r.impressions;
      c.spendByDate.set(r.date, (c.spendByDate.get(r.date) || 0) + r.cost);
    } else if (r.date >= window.baseStart && r.date <= window.baseEnd) {
      c.spend28 += r.cost;
      c.clicks28 += r.clicks;
      c.impressions28 += r.impressions;
      c.sales28 += r.sales;
    }
  }

  // ── derived ──
  for (const c of campaigns.values()) {
    c.baselineWeekly = r2(c.spend28 / 4);

    // Profit retention, from the BASELINE and labelled as such wherever it is
    // shown. Campaign economics are a standing property — price, cost, fees,
    // competitive conversion rate — not a weekly event, so a 28-day read is
    // both settled and a larger sample. There is no fresher retention to be
    // had; the alternative is none at all.
    c.acos28 = c.sales28 > 0 ? r4(c.spend28 / c.sales28) : null;
    // null, never 0, when it cannot be computed: an unmapped brand has no
    // margin and a campaign with no sales has no ACoS. Treating either as zero
    // retention would read as maximally unprofitable.
    c.retention28 = (c.grossMargin && c.acos28 !== null)
      ? r4((c.grossMargin - c.acos28) / c.grossMargin)
      : null;

    // Rates. Weekly and baseline, both conversion-free.
    c.ctr7  = c.impressions7  > 0 ? r4(c.clicks7  / c.impressions7)  : null;
    c.ctr28 = c.impressions28 > 0 ? r4(c.clicks28 / c.impressions28) : null;
    c.cpc7  = c.clicks7  > 0 ? r2(c.spend7  / c.clicks7)  : null;
    c.cpc28 = c.clicks28 > 0 ? r2(c.spend28 / c.clicks28) : null;

    // Days at cap. Amazon treats the daily budget as an average across the
    // month, so a campaign with real demand overshoots on some days and is
    // pulled back on others; a week total hides that. A day OVER budget counts
    // as at cap — under a lost-serving-time reading it would not, since Amazon
    // kept serving, but the question here is whether demand exceeded the
    // budget, and an overshoot is the strongest evidence that it did.
    //
    // Days with no report row had no spend, so they cannot reach the threshold
    // and are correctly absent.
    //
    // A LIFETIME budget has no daily ceiling to be at, so it is skipped rather
    // than measured wrong. An absent budgetType is treated as daily, which is
    // what Sponsored Products returns for effectively every campaign.
    const lifetime = /LIFETIME/i.test(c.budgetType);
    if (c.dailyBudget > 0 && !lifetime) {
      const atCap = c.dailyBudget * RF_CONFIG.CAP_DAY_RATIO;
      let days = 0;
      let peak = 0;
      for (const daySpend of c.spendByDate.values()) {
        if (daySpend >= atCap) days++;
        if (daySpend > peak) peak = daySpend;
      }
      c.cappedDays = days;
      c.maxDaySpend = r2(peak);
    } else {
      c.cappedDays = null;
      c.maxDaySpend = null;
    }
  }

  const flags = {
    budgetCap: [], silent: [], spendCollapse: [],
    ctrCollapse: [], cpcSpike: [], brandPacing: []
  };

  const base = (c) => ({
    campaignId: c.campaignId, campaign: c.name,
    adProduct: c.adProduct, brand: c.brand
  });

  for (const c of campaigns.values()) {

    // ── 1 · Budget cap emergencies ──
    // Current trigger, standing filter: the campaign is pressed against its
    // ceiling THIS week, and is a kind of campaign worth feeding.
    if (c.cappedDays !== null && c.cappedDays >= RF_CONFIG.CAP_DAYS_MIN &&
        c.retention28 !== null && c.retention28 >= RF_CONFIG.CAP_RETENTION_MIN) {
      flags.budgetCap.push({
        ...base(c),
        dailyBudget: c.dailyBudget,
        cappedDays: c.cappedDays, weekDays,
        maxDaySpend: c.maxDaySpend,
        recommendedBudget: rfRecommendBudget({
          dailyBudget: c.dailyBudget, cappedDays: c.cappedDays,
          weekDays, maxDaySpend: c.maxDaySpend
        }),
        spend7: r2(c.spend7),
        acos28: c.acos28, retention28: c.retention28
      });
    }

    // ── 2 · Silent campaigns ──
    // Enabled, funded, and served nothing at all. Deliberately requires prior
    // activity: a campaign that has never run is dormant, not broken, and
    // flagging every dormant campaign weekly would drown the report. This is a
    // CHANGE detector — it ran, and now it does not.
    const wasActive = c.impressions28 > 0;
    const silent = c.dailyBudget > 0 && c.impressions7 === 0 && wasActive;
    if (silent) {
      flags.silent.push({
        ...base(c),
        dailyBudget: c.dailyBudget,
        // An enabled campaign past its end date explains its own silence.
        endedBefore: (c.endDate && c.endDate < window.weekStart) ? c.endDate : null,
        baselineWeekly: c.baselineWeekly,
        baselineImpressions: Math.round(c.impressions28)
      });
    }

    // ── 3 · Spend collapse ──
    // Still serving, but spending far below its own normal. Skips campaigns
    // already reported silent, which would otherwise appear twice saying the
    // same thing less precisely.
    if (!silent && c.baselineWeekly >= RF_CONFIG.COLLAPSE_MIN_BASELINE &&
        c.spend7 <= c.baselineWeekly * RF_CONFIG.COLLAPSE_RATIO) {
      flags.spendCollapse.push({
        ...base(c),
        spend7: r2(c.spend7),
        baselineWeekly: c.baselineWeekly,
        change: r4((c.spend7 - c.baselineWeekly) / c.baselineWeekly),
        // Names its own cause, and therefore where the fix is.
        cause: rfDecomposeSpend(c)
      });
    }

    // ── 4 · CTR collapse ──
    // Impressions accumulating without clicks. Points at the listing — main
    // image, price, reviews — or at targeting drift, and it fires before the
    // money is spent rather than after. The impression floor is significance:
    // at a typical 0.4% CTR, a few hundred impressions cannot distinguish a
    // collapse from an ordinary quiet week.
    if (c.impressions7 >= RF_CONFIG.CTR_MIN_IMPRESSIONS &&
        c.ctr28 > 0 && c.ctr7 !== null &&
        c.ctr7 <= c.ctr28 * RF_CONFIG.CTR_COLLAPSE_RATIO) {
      flags.ctrCollapse.push({
        ...base(c),
        impressions7: Math.round(c.impressions7),
        clicks7: Math.round(c.clicks7),
        ctr7: c.ctr7, ctr28: c.ctr28,
        change: r4((c.ctr7 - c.ctr28) / c.ctr28)
      });
    }

    // ── 5 · CPC spike ──
    // Paying materially more per click than usual: competitive pressure, or
    // bid automation reaching. It is the leading indicator for the cap and
    // collapse checks — it shows up before it becomes a spend problem.
    if (c.clicks7 >= RF_CONFIG.CPC_MIN_CLICKS &&
        c.clicks28 >= RF_CONFIG.CPC_MIN_CLICKS &&
        c.cpc28 > 0 && c.cpc7 !== null &&
        c.cpc7 >= c.cpc28 * RF_CONFIG.CPC_SPIKE_MULTIPLE) {
      flags.cpcSpike.push({
        ...base(c),
        clicks7: Math.round(c.clicks7),
        spend7: r2(c.spend7),
        cpc7: c.cpc7, cpc28: c.cpc28,
        change: r4((c.cpc7 - c.cpc28) / c.cpc28),
        defaultBid: c.defaultBid,
        adGroupId: c.adGroupId,
        recommendedBid: rfRecommendBid({ defaultBid: c.defaultBid, cpc7: c.cpc7, cpc28: c.cpc28 })
      });
    }
  }

  // ── 6 · Brand pacing ──
  // The only account-level check, and structurally the soundest: it aggregates
  // 30-40 campaigns, so it is the least noisy thing here. Pure spend.
  const brands = new Map();
  for (const c of campaigns.values()) {
    if (!c.brand) continue;
    let b = brands.get(c.brand);
    if (!b) { b = { brand: c.brand, spend7: 0, spend28: 0, members: [] }; brands.set(c.brand, b); }
    b.spend7 += c.spend7;
    b.spend28 += c.spend28;
    // Kept so a brand-level move can name the campaigns that caused it. A
    // deviation with no attribution is a prompt to go looking, which is the
    // thing this page exists to avoid.
    b.members.push({ campaign: c.name, adProduct: c.adProduct,
                     delta: c.spend7 - c.baselineWeekly });
  }
  for (const b of brands.values()) {
    const baselineWeekly = r2(b.spend28 / 4);
    // No baseline means no deviation to measure — a brand that spent nothing
    // for 28 days and something this week is a launch, not a pacing problem.
    if (baselineWeekly <= 0) continue;
    const deviation = r4((b.spend7 - baselineWeekly) / baselineWeekly);
    if (Math.abs(deviation) > RF_CONFIG.PACING_DEVIATION) {
      // The campaigns that account for the move, largest first, in the same
      // direction as the move. Three is enough to explain a brand.
      const drivers = b.members
        .filter(m => (deviation > 0 ? m.delta > 0 : m.delta < 0))
        .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
        .slice(0, 3)
        .map(m => ({ campaign: m.campaign, adProduct: m.adProduct, delta: r2(m.delta) }));
      flags.brandPacing.push({
        brand: b.brand, spend7: r2(b.spend7), baselineWeekly, deviation, drivers
      });
    }
  }

  flags.budgetCap.sort((a, b) => b.spend7 - a.spend7);
  flags.silent.sort((a, b) => b.baselineWeekly - a.baselineWeekly);
  flags.spendCollapse.sort((a, b) => a.change - b.change);
  flags.ctrCollapse.sort((a, b) => a.change - b.change);
  flags.cpcSpike.sort((a, b) => b.change - a.change);
  flags.brandPacing.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));

  const flagCount = Object.values(flags).reduce((n, list) => n + list.length, 0);

  // The run's own receipt. Not a report of healthy campaigns — one line saying
  // what the denominator was, so a run that silently covers half the account
  // cannot look identical to a clean week.
  const all = [...campaigns.values()];
  const enabled = all.length;
  const withSpend = all.filter(c => c.spend7 > 0).length;
  // Campaigns that have never run at all. Not flagged: dormant is a config
  // cleanup job, not a weekly emergency, and reporting the same 60 campaigns
  // every week would bury the ones that actually broke.
  const neverActive = all.filter(c => c.impressions7 === 0 && c.impressions28 === 0).length;

  // Lists are limited to campaigns that actually spent: a dormant campaign
  // with no brand cannot affect any check, and naming it is just noise.
  const unmapped = all
    .filter(c => c.spend7 > 0 && !c.brand)
    .map(c => ({ campaign: c.name, adProduct: c.adProduct, spend7: r2(c.spend7) }))
    .sort((a, b) => b.spend7 - a.spend7);
  // Campaigns check 1 could not look at: no daily budget in the snapshot, or a
  // lifetime budget, which has no daily ceiling to be capped against.
  const noBudget = all
    .filter(c => c.spend7 > 0 && c.cappedDays === null)
    .map(c => ({ campaign: c.name, adProduct: c.adProduct, spend7: r2(c.spend7),
                 reason: /LIFETIME/i.test(c.budgetType) ? 'lifetime budget' : 'no daily budget' }))
    .sort((a, b) => b.spend7 - a.spend7);

  return {
    flags,
    flagCount,
    clean: flagCount === 0,
    coverage: { enabled, evaluated: enabled, withSpend, neverActive,
                orphanRows, unmapped, noBudget }
  };
}

// A capped campaign's real demand is unobservable — it was cut off before
// spending it. So this is a STEP, not a calculation, and it says so: raise in
// proportion to how often the budget bound, and never below a day the campaign
// has already proven it can spend.
//
// The floor matters because Amazon averages the daily budget across the month.
// A campaign that spent $28 on a $15 budget has demonstrated $28 of demand on
// that day; recommending $19 would be provably too low.
//
// Returns whole dollars. A recommendation of $18.73 reads as a calculation
// this cannot honestly claim to be.
function rfRecommendBudget({ dailyBudget, cappedDays, weekDays, maxDaySpend }) {
  if (!(dailyBudget > 0) || cappedDays === null || cappedDays === undefined) return null;
  const span = Math.max(1, weekDays - RF_CONFIG.CAP_DAYS_MIN);
  const over = Math.max(0, Math.min(cappedDays, weekDays) - RF_CONFIG.CAP_DAYS_MIN);
  const step = RF_CONFIG.RAISE_MIN +
               (RF_CONFIG.RAISE_MAX - RF_CONFIG.RAISE_MIN) * (over / span);
  const raised = Math.max(dailyBudget * (1 + step), maxDaySpend || 0);
  const rounded = Math.ceil(raised);
  // Never return the budget it already has — an "apply" that changes nothing
  // is worse than no button.
  return rounded > dailyBudget ? rounded : null;
}

// The mirror of rfRecommendBudget, and a step for the same reason: what a lower
// bid will actually cost per click is an auction outcome, not arithmetic. Bids
// and CPC are not even the same quantity — dynamic bidding and placement
// modifiers let the effective bid exceed the base one, so a campaign can pay
// more per click than its bid.
//
// Cutting by the full overshoot would be the naive move and would usually
// overshoot in the other direction, dropping the campaign out of the auction
// entirely. So: 10% at the flagging threshold, rising to 25% at twice it.
//
// Returns cents. Amazon's floor is $0.02, and a recommendation equal to the
// current bid is a no-op write, which is worse than no button.
function rfRecommendBid({ defaultBid, cpc7, cpc28 }) {
  if (!(defaultBid > 0) || !(cpc28 > 0) || !(cpc7 > 0)) return null;
  const overshoot = cpc7 / cpc28;
  if (overshoot < RF_CONFIG.CPC_SPIKE_MULTIPLE) return null;
  const span = RF_CONFIG.CPC_SPIKE_MULTIPLE;   // threshold → twice threshold
  const over = Math.min(overshoot - RF_CONFIG.CPC_SPIKE_MULTIPLE, span);
  const cut = RF_CONFIG.CUT_MIN + (RF_CONFIG.CUT_MAX - RF_CONFIG.CUT_MIN) * (over / span);
  const bid = Math.max(0.02, Math.round(defaultBid * (1 - cut) * 100) / 100);
  return bid < defaultBid ? bid : null;
}

// spend = impressions × CTR × CPC. All three are attribution-free and we hold
// both windows, so a collapse can name its own cause instead of sending you to
// look. Which factor moved decides WHERE the fix is — an impressions drop is a
// listing or Buy Box problem, a CPC drop is a bidding one.
function rfDecomposeSpend(c) {
  const weekly = (n) => n / 4;   // baseline is 28 days
  const ratio = (now, before) => (before > 0 ? r4(now / before) : null);
  const factors = [
    { factor: 'impressions', ratio: ratio(c.impressions7, weekly(c.impressions28)) },
    { factor: 'ctr',         ratio: ratio(c.ctr7, c.ctr28) },
    { factor: 'cpc',         ratio: ratio(c.cpc7, c.cpc28) }
  ].filter(f => f.ratio !== null);
  if (!factors.length) return null;
  // The biggest proportional fall is the driver. Ties do not matter: any of
  // them being this low is the thing worth looking at.
  const driver = factors.reduce((a, b) => (b.ratio < a.ratio ? b : a));
  return { driver: driver.factor, ratio: driver.ratio, factors };
}

// ─── ROW NORMALIZATION ───────────────────────────────────────────────────────
// SP carries 7-day attribution and SB 14-day, matching what the console
// exports show and therefore what these numbers have always been read against.
// Each field reads the first present candidate: Amazon has revved column names
// before, and a silent zero is worse than a loud mismatch.
function rfNormalizeRows(rawRows, adProduct) {
  if (!Array.isArray(rawRows)) return [];
  return rawRows.map(r => ({
    date:       String(rfPick(r, ['date', 'startDate']) || '').substring(0, 10),
    adProduct,
    campaignId: String(rfPick(r, ['campaignId']) || ''),
    cost:       num(rfPick(r, ['cost', 'spend'])),
    clicks:     num(rfPick(r, ['clicks'])),
    impressions: num(rfPick(r, ['impressions'])),
    orders:     num(rfPick(r, ['purchases7d', 'purchases', 'purchases14d'])),
    sales:      num(rfPick(r, ['sales7d', 'sales', 'sales14d']))
  })).filter(r => r.date && r.campaignId);
}

function rfPick(row, keys) {
  for (const k of keys) {
    if (row && row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k];
  }
  return undefined;
}

// ─── ADVERTISING API ─────────────────────────────────────────────────────────

function missingAdsCredentials() {
  return ['ADV_CLIENT_ID', 'ADV_CLIENT_SECRET', 'ADV_REFRESH_TOKEN', 'ADV_PROFILE_ID']
    .filter(k => !process.env[k]);
}

function buildReportBody(product, start, end) {
  if (daySpan(start, end) > MAX_REPORT_DAYS) {
    // Caught here rather than at Amazon, where it surfaces as an opaque 4xx.
    throw new Error(`report window ${start}..${end} is ${daySpan(start, end)} days, ` +
                    `over Amazon's ${MAX_REPORT_DAYS}-day limit`);
  }
  return {
    name: `RedFlags ${product.toUpperCase()} ${start}..${end}`,
    startDate: start,
    endDate: end,
    configuration: {
      adProduct: product === 'sp' ? 'SPONSORED_PRODUCTS' : 'SPONSORED_BRANDS',
      groupBy: ['campaign'],
      columns: RF_COLUMNS[product],
      reportTypeId: product === 'sp' ? 'spCampaigns' : 'sbCampaigns',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON'
    }
  };
}

// One column set, no fallback. Every column here is a metric Amazon documents
// for this report type; a refusal means something changed and the run should
// say so rather than quietly proceed on less data.
async function requestCampaignReport(accessToken, { product, start, end }) {
  try {
    const reportId = await withAdsRetry(
      () => requestReport(accessToken, buildReportBody(product, start, end))
    );
    return { reportId, columns: RF_COLUMNS[product] };
  } catch (err) {
    // 425 means an identical report is already generating. Adopting the id
    // Amazon names recovers a run that would otherwise be orphaned —
    // generating at Amazon with nothing left able to poll it, and blocking
    // every retry for as long as it lives.
    if (/\(425\)/.test(err.message)) {
      const adopted = rfDuplicateReportId(err.message);
      if (adopted) return { reportId: adopted, columns: RF_COLUMNS[product], adopted: true };
    }
    throw err;
  }
}

// Amazon names the in-flight report in the 425 body, in one of two shapes:
//   {"detail":"The Request is a duplicate of : a886b6d8-62c7-4257-8a4f-..."}
//   {"reportId":"a886b6d8-..."}
// The prose form is the one production actually returns. Missing it meant
// every retry re-requested, got refused again, and left four live reports at
// Amazon that nothing could ever collect.
function rfDuplicateReportId(message) {
  const text = String(message || '');
  const m = text.match(/duplicate of\s*:?\s*([A-Za-z0-9._-]{8,80})/i) ||
            text.match(/"reportId"\s*:\s*"([^"]+)"/);
  return (m && REPORT_ID_RE.test(m[1])) ? m[1] : null;
}

// Amazon's 400 body reads "configuration columns includes invalid values:
// (x). Allowed values: (...)" and then lists a hundred columns. The answer is
// the two words before the list.
function rfInvalidColumns(message) {
  const m = String(message || '').match(/includes invalid values:\s*\(([^)]*)\)/i);
  if (!m) return [];
  return m[1].split(',').map(x => x.trim()).filter(Boolean);
}

// Retry on throttling and transient server errors only. Never on 425 —
// retrying a duplicate guarantees another rejection — nor on a validation 4xx.
async function withAdsRetry(fn, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err.message || '');
      const retryable = /\(429\)|\(5\d\d\)/.test(msg);
      if (!retryable || i === attempts - 1) throw err;
      await sleep(1000 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Report IDs are interpolated into an Amazon API URL, so they are validated
// before any fetch — an ID carrying path traversal would re-target an
// authenticated request at a different endpoint using the account credentials.
function parseReportsParam(raw, allowed = REPORT_KEYS) {
  if (!raw) return { error: 'reports parameter required (key:reportId,...)' };
  const parts = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return { error: 'reports parameter is empty' };
  if (parts.length > allowed.length) return { error: 'too many report IDs' };

  const reports = [];
  const seen = new Set();
  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx < 1) return { error: `malformed report entry: ${part}` };
    const key = part.slice(0, idx);
    const reportId = part.slice(idx + 1);
    if (!allowed.includes(key)) return { error: `unknown report key: ${key}` };
    if (seen.has(key)) return { error: `duplicate report key: ${key}` };
    if (!REPORT_ID_RE.test(reportId)) return { error: `invalid report id for ${key}` };
    seen.add(key);
    reports.push({ key, reportId });
  }
  return { reports };
}

// UTC instant → 'YYYY-MM-DD' in America/Los_Angeles.
function _ptDate(instant) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

// Calendar arithmetic on a 'YYYY-MM-DD' label (timezone-free).
function _addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// Derived ratios are rounded before comparison — otherwise a deviation that
// should be exactly 0.30 lands at 0.30000000000000004 and trips a ">30%" rule.
function r4(n) { return Math.round(n * 10000) / 10000; }
function r2(n) { return Math.round(n * 100) / 100; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Exported for the offline cadence tests. Vercel only invokes the default
// export, so these are inert in production.

// ═════════════════════════════════════════════════════════════════════════════
// BI-WEEKLY TACTICAL BUDGET MANAGEMENT
// ═════════════════════════════════════════════════════════════════════════════
// Implements Amazon_Ad_Management_BiWeekly.docx — the Thursday, every-other-week
// cadence. Unlike the weekly, this one ACTS: every enabled campaign gets one of
// Increase, Decrease, Hold or Cut, and the page can write them.
//
// THE WINDOW IS LAGGED BY DESIGN. Amazon credits a sale to the click date and
// leaves it incomplete for 7 days, biased downward. The weekly could live with
// that because it only observed. This cadence cuts campaigns to a $1 floor on
// "zero orders", so a fresh window would floor healthy campaigns whose orders
// simply had not landed. The 14 days evaluated therefore END 8 DAYS AGO, and
// every day in them is past its attribution window.
//
// The prior 14 days come along for "trending down", so the whole pull is 28
// contiguous days — inside Amazon's 31-day report cap, one report per ad
// product.
//
// It reads the same census as the weekly for budgets, brands and portfolios,
// and writes through the same campaign update path. It stores one key of its
// own: the per-brand monthly posture.

// Every threshold is from the doc's Decision Tree section, applied in strict
// tier order, first match wins.
const BW_CONFIG = {
  LAG_DAYS:            8,     // days between the end of the window and today
  WINDOW_DAYS:         14,
  // Statistical significance floor, applied BEFORE the tiers
  MIN_SPEND:           10,    // "no increase or decrease if spend under $10..."
  MIN_ORDERS:          3,     // "...AND orders are under 3"
  // Tier 1 — hard stops
  T1_LOSS_SPEND:       20,    // spend > $20 AND retention < 0
  T1_NOORDER_SPEND:    15,    // spend > $15 AND zero orders
  // The doc cuts straight to a $1 floor. That is a 94% reduction on one
  // fortnight of evidence, and a floored campaign generates almost no data, so
  // it can never demonstrate a recovery — the cut becomes self-reinforcing.
  // Staged instead: a bad fortnight pulls back hard, a bad MONTH pulls back
  // harder. Repeated, -70% reaches the floor anyway ($17 → $5 → $2 → $1) with
  // a chance to recover at each step.
  T1_SINGLE:           -0.40, // the problem appeared this fortnight only
  T1_CONFIRMED:        -0.70, // ... and was there the fortnight before too
  FLOOR:               1,     // no budget ever rounds below this
  // Tier 2 — scale up, capped campaigns only
  T2_HIGH:             0.75,  // >= 75% retention
  T2_MID:              0.50,  // 50-74%
  T2_LOW:              0.25,  // 25-49%; below this, Hold even when capped
  // Tier 3 — scale down
  T3_BARELY:           0.10,  // 0-10% retention
  T3_WEAK:             0.25,  // 10-25%
  T3_MEDIOCRE:         0.50,  // 25-50% AND trending down
  // "Trending down" is undefined in the doc. Retention has to fall by more than
  // this against the prior 14 days, so ordinary week-to-week noise does not
  // trip a decrease.
  TRENDING_DOWN:       0.05,
  // Capped, carried over from the weekly: the doc asks for time-in-budget,
  // which Amazon exposes only in the console Budget Report.
  CAP_DAY_RATIO:       0.95,
  CAP_DAYS_MIN:        8      // of 14, the same proportion the weekly uses
};

// The ladders the monthly posture shifts along. "Scale brands get one tier of
// additional scaling (a 25-49% campaign that would normally get +15% gets
// +30%)"; constrain brands "skip Tier 2 increases and accept more aggressive
// Tier 3 decreases".
const BW_INCREASES = [0.15, 0.30, 0.50];
const BW_DECREASES = [0.15, 0.25, 0.40];

const BW_POSTURES = ['scale', 'hold', 'constrain'];
const BW_POSTURE_KEY = 'biweekly:posture';

// Sponsored Products only, for the reasons in the weekly's REPORT_KEYS note —
// plus one specific to this cadence: SB uses a 14-DAY attribution window, so
// the 8-day lag that settles SP leaves roughly six days of SB conversions
// still arriving. Retention would be understated, and Tier 1 cuts to $1 on
// exactly that. SB is reviewed monthly.
const BW_REPORT_KEYS = ['spBw'];

// ─── WINDOW ──────────────────────────────────────────────────────────────────
// Two 14-day halves, both fully attributed, ending LAG_DAYS before today.
function resolveBiweeklyWindow(nowInstant) {
  const today = _ptDate(nowInstant);
  const end = _addDays(today, -BW_CONFIG.LAG_DAYS);
  const start = _addDays(end, -(BW_CONFIG.WINDOW_DAYS - 1));
  const priorEnd = _addDays(start, -1);
  const priorStart = _addDays(priorEnd, -(BW_CONFIG.WINDOW_DAYS - 1));
  return { start, end, priorStart, priorEnd, asOf: today };
}

function bwReportSpec(key, window) {
  return {
    product: 'sp',
    // Both halves in one request: 28 contiguous days, under the 31-day cap.
    start: window.priorStart, end: window.end
  };
}

// ─── DECISION TREE ───────────────────────────────────────────────────────────
// Pure, and the whole point of the cadence. Every branch here is a line in the
// doc; nothing is inferred.
//
// `posture` is the brand's most recent monthly priority. Hold Steady is the
// documented default and means the standard tree, so a run with no monthly
// priorities behaves exactly as specified rather than approximating.
function bwDecide(c, posture = 'hold') {
  const cfg = BW_CONFIG;
  const decide = (action, pct, tier, reason) => ({ action, pct, tier, reason });
  // Tier 1 is still a distinct action from a Tier 3 decrease — "losing money"
  // reads differently from "underperforming" — it simply no longer goes
  // straight to the floor.
  const cut = (pct, tier, reason) => ({ action: 'cut', pct, tier, reason });

  // ── significance floor, before the tiers ──
  if (c.spend < cfg.MIN_SPEND && c.orders < cfg.MIN_ORDERS) {
    return decide('hold', 0, 'floor',
      'Insufficient data — review structurally in monthly, not here');
  }

  // ── Tier 1, hard stops ──
  // Confirmation means the same problem was present in the PRIOR fortnight, so
  // these campaigns have been failing for a month rather than a bad two weeks.
  // An absent prior half is never confirmation — a campaign that was not
  // running then has proved nothing.
  if (c.spend > cfg.T1_LOSS_SPEND && c.retention !== null && c.retention < 0) {
    const confirmed = c.priorRetention !== null && c.priorRetention < 0;
    return cut(confirmed ? cfg.T1_CONFIRMED : cfg.T1_SINGLE, 1,
      confirmed
        ? 'Below break-even two fortnights running — losing money on every ad sale'
        : 'Below break-even this fortnight — losing money on every ad sale');
  }
  if (c.spend > cfg.T1_NOORDER_SPEND && c.orders === 0) {
    // Zero prior orders only counts when the campaign was actually spending
    // then; otherwise "no orders" just means "not running".
    const confirmed = c.priorOrders === 0 && c.priorSpend > cfg.T1_NOORDER_SPEND;
    return cut(confirmed ? cfg.T1_CONFIRMED : cfg.T1_SINGLE, 1,
      confirmed
        ? 'No orders for a month — burning budget with nothing to show'
        : 'No orders this fortnight — burning budget with nothing to show');
  }

  // Retention drives Tiers 2 and 3, so a campaign without one cannot be placed.
  // An unmapped brand has no margin; a campaign with no sales has no ACoS.
  // Holding is the honest answer — treating unknown as 0% would land it in the
  // most aggressive decrease band.
  if (c.retention === null) {
    return decide('hold', 0, 4, 'No profit retention available — brand unmapped or no sales');
  }

  // ── Tier 2, scale up, capped only ──
  // A constrain brand skips this tier entirely, per the doc.
  if (c.capped && posture !== 'constrain') {
    let step = null;
    if (c.retention >= cfg.T2_HIGH) step = 2;
    else if (c.retention >= cfg.T2_MID) step = 1;
    else if (c.retention >= cfg.T2_LOW) step = 0;

    if (step === null) {
      return decide('hold', 0, 2, 'Capped but under 25% retention — not worth feeding');
    }
    // Scale brands get one tier of extra aggressiveness.
    const idx = Math.min(step + (posture === 'scale' ? 1 : 0), BW_INCREASES.length - 1);
    return decide('increase', BW_INCREASES[idx], 2,
      `Capped at ${Math.round(c.retention * 100)}% retention` +
      (posture === 'scale' && idx !== step ? ' — scale brand, one tier up' : ''));
  }

  // ── Tier 3, scale down ──
  let step = null;
  if (c.retention >= 0 && c.retention < cfg.T3_BARELY) step = 2;
  else if (c.retention >= cfg.T3_BARELY && c.retention < cfg.T3_WEAK) step = 1;
  else if (c.retention >= cfg.T3_WEAK && c.retention < cfg.T3_MEDIOCRE && c.trendingDown) step = 0;
  // Retention below zero that did not clear Tier 1's spend bar still belongs in
  // the most aggressive decrease band rather than falling through to Hold.
  else if (c.retention < 0) step = 2;

  if (step !== null) {
    const idx = Math.min(step + (posture === 'constrain' ? 1 : 0), BW_DECREASES.length - 1);
    const pct = BW_DECREASES[idx];
    const why = c.retention < 0 ? 'Below break-even'
              : step === 2 ? 'Barely profitable'
              : step === 1 ? 'Weak'
              : 'Mediocre and weakening';
    return decide('decrease', -pct, 3,
      `${why} at ${Math.round(c.retention * 100)}% retention` +
      (posture === 'constrain' && idx !== step ? ' — constrain brand, one tier down' : ''));
  }

  // ── Tier 4 ──
  return decide('hold', 0, 4,
    c.capped ? 'Healthy and capped, but posture is constrain'
             : 'Healthy retention and not capped');
}

// "Round to the nearest dollar (never round below the $1 floor)."
function bwNewBudget(current, decision) {
  if (!(current > 0)) return null;
  if (decision.action === 'hold' || !decision.pct) return current;
  return Math.max(BW_CONFIG.FLOOR, Math.round(current * (1 + decision.pct)));
}

// ─── EVALUATE ────────────────────────────────────────────────────────────────
// Every enabled campaign gets a row — the doc's output is the whole account,
// not a flag list. Pure, so the tree can be exercised against the doc offline.
// Split in two so the decision tree can be re-run without re-fetching reports.
// Reports are the expensive half - a queue that has run half an hour - and the
// tree is the half that keeps changing as thresholds and postures are tuned.
//
//   bwBuildInputs  aggregates report rows onto the census spine, once per run
//   bwDecideAll    applies the tree to those inputs, as often as you like
//
// The inputs are compact on purpose: everything the tree reads and nothing
// else, about 200 bytes a campaign, so a whole run travels in ~30KB.
function bwBuildInputs({ census, rows, window }) {
  const campaigns = new Map();
  for (const row of census.campaigns) {
    if (String(row.state || '').toUpperCase() !== 'ENABLED') continue;
    // No SB report is pulled, so SB must not be in the spine: a campaign with
    // no report behind it shows zero spend and zero orders, which trips the
    // significance floor and reads as "insufficient data" forever.
    if (row.adProduct !== 'SP') continue;
    campaigns.set(String(row.campaignId), {
      campaignId: String(row.campaignId),
      name: row.name || '',
      adProduct: row.adProduct || '',
      // Brand is stored, segment and margin are not: deriving them at decide
      // time means a margin-table change takes effect on a recompute too.
      brand: row.brand || null,
      dailyBudget: typeof row.dailyBudget === 'number' ? row.dailyBudget : null,
      budgetType: row.budgetType || '',
      portfolioId: row.portfolioId || null,
      spend: 0, orders: 0, sales: 0, clicks: 0, impressions: 0,
      // The prior fortnight confirms (or fails to confirm) a Tier 1 problem,
      // so it needs orders as well as money.
      priorSpend: 0, priorSales: 0, priorOrders: 0,
      // Daily spends, values only. The dates do not matter to the capped-day
      // count, and keeping the raw values means the at-cap threshold can be
      // retuned on a recompute rather than being baked in here.
      daily: []
    });
  }

  let orphanRows = 0;
  const byDate = new Map();
  for (const r of rows) {
    const c = campaigns.get(r.campaignId);
    if (!c) { orphanRows++; continue; }
    if (r.date >= window.start && r.date <= window.end) {
      c.spend += r.cost; c.orders += r.orders; c.sales += r.sales;
      c.clicks += r.clicks; c.impressions += r.impressions;
      const key = c.campaignId + '|' + r.date;
      byDate.set(key, (byDate.get(key) || 0) + r.cost);
    } else if (r.date >= window.priorStart && r.date <= window.priorEnd) {
      c.priorSpend += r.cost; c.priorSales += r.sales; c.priorOrders += r.orders;
    }
  }
  for (const [key, spend] of byDate) {
    const c = campaigns.get(key.slice(0, key.indexOf('|')));
    if (c) c.daily.push(r2(spend));
  }

  for (const c of campaigns.values()) {
    c.spend = r2(c.spend); c.sales = r2(c.sales); c.orders = Math.round(c.orders);
    c.clicks = Math.round(c.clicks); c.impressions = Math.round(c.impressions);
    c.priorSpend = r2(c.priorSpend); c.priorSales = r2(c.priorSales);
    c.priorOrders = Math.round(c.priorOrders);
  }

  return { inputs: [...campaigns.values()], orphanRows };
}

// Every enabled campaign gets a row - the doc's output is the whole account,
// not a flag list. Pure, so the tree can be exercised against the doc offline
// and re-run against stored inputs without touching Amazon.
function bwDecideAll({ inputs, window, postures = {}, recentRaises = {} }) {
  const retentionOf = (margin, spend, sales) => {
    if (!margin || !(sales > 0)) return null;
    return r4((margin - spend / sales) / margin);
  };

  const out = [];
  for (const i of inputs) {
    const segment = i.brand ? rfSegment(i.brand, i.name) : null;
    const grossMargin = segment ? MARGINS[segment] : null;

    const c = { ...i, segment, grossMargin };
    c.acos = c.sales > 0 ? r4(c.spend / c.sales) : null;
    c.retention = retentionOf(grossMargin, c.spend, c.sales);
    c.priorRetention = retentionOf(grossMargin, c.priorSpend, c.priorSales);
    c.trendingDown = (c.retention !== null && c.priorRetention !== null) &&
                     (c.priorRetention - c.retention) > BW_CONFIG.TRENDING_DOWN;

    // Capped by days rather than a period total - a campaign clipped on eight
    // days and idle on six is constrained even though the fortnight is not.
    const lifetime = /LIFETIME/i.test(c.budgetType);
    if (c.dailyBudget > 0 && !lifetime) {
      const atCap = c.dailyBudget * BW_CONFIG.CAP_DAY_RATIO;
      c.cappedDays = (c.daily || []).filter(v => v >= atCap).length;
      c.capped = c.cappedDays >= BW_CONFIG.CAP_DAYS_MIN;
    } else {
      c.cappedDays = null;
      c.capped = false;
    }

    const posture = BW_POSTURES.includes(postures[c.brand]) ? postures[c.brand] : 'hold';
    const decision = bwDecide(c, posture);
    const newBudget = bwNewBudget(c.dailyBudget, decision);
    const delta = (newBudget !== null && c.dailyBudget !== null) ? r2(newBudget - c.dailyBudget) : 0;

    out.push({
      campaignId: c.campaignId, campaign: c.name, adProduct: c.adProduct,
      brand: c.brand, posture,
      dailyBudget: c.dailyBudget,
      spend: c.spend, sales: c.sales, orders: c.orders,
      acos: c.acos, retention: c.retention,
      priorRetention: c.priorRetention, trendingDown: c.trendingDown,
      cappedDays: c.cappedDays, weekDays: BW_CONFIG.WINDOW_DAYS, capped: c.capped,
      action: decision.action, pct: decision.pct, tier: decision.tier,
      reason: decision.reason,
      newBudget, delta,
      // The weekly can raise a budget on the same campaign from a different
      // window. Applying both compounds them, so a recent raise is surfaced
      // rather than left for you to remember.
      raisedRecently: recentRaises[c.campaignId] || null
    });
  }

  // DEVIATION: the doc sorts by magnitude of change, biggest movers first.
  // Alphabetical by campaign name instead, because the list is now something
  // you work down with checkboxes rather than skim - and the naming convention
  // puts each brand's campaigns together anyway (BW, RR, SOK, STATE).
  out.sort((a, b) => String(a.campaign || '').localeCompare(String(b.campaign || ''),
                                                            'en', { numeric: true }));

  const counts = { increase: 0, decrease: 0, hold: 0, cut: 0 };
  for (const r of out) counts[r.action]++;

  // Brand summary. The doc asks for an SP/SB split, but with SB reviewed
  // monthly there is nothing to split.
  const brands = new Map();
  for (const r of out) {
    if (!r.brand) continue;
    let b = brands.get(r.brand);
    if (!b) { b = { brand: r.brand, posture: r.posture, spend: 0, sales: 0, orders: 0 }; brands.set(r.brand, b); }
    b.spend += r.spend; b.sales += r.sales; b.orders += r.orders;
  }
  const brandSummary = [...brands.values()].map(b => {
    const segment = BRAND_SEGMENT[b.brand] || null;
    const margin = segment ? MARGINS[segment] : null;
    return {
      brand: b.brand, posture: b.posture,
      spend: r2(b.spend), sales: r2(b.sales), orders: b.orders,
      acos: b.sales > 0 ? r4(b.spend / b.sales) : null,
      retention: retentionOf(margin, b.spend, b.sales)
    };
  }).sort((a, b) => b.spend - a.spend);

  return {
    rows: out, counts, brandSummary,
    coverage: {
      enabled: inputs.length,
      orphanRows: 0,
      unmapped: out.filter(r => !r.brand && r.spend > 0).length,
      noBudget: out.filter(r => r.dailyBudget === null).length
    }
  };
}

function evaluateBiweekly({ census, rows, window, postures = {}, recentRaises = {} }) {
  const { inputs, orphanRows } = bwBuildInputs({ census, rows, window });
  const result = bwDecideAll({ inputs, window, postures, recentRaises });
  result.coverage.orphanRows = orphanRows;
  // Returned so the client can ask for a re-decision later without a report.
  result.inputs = inputs;
  return result;
}



// Budget raises this tool made in the last fortnight, so the bi-weekly can say
// so before recommending another. Read from the census change log, which
// records dashboard edits with source 'edit'.
function bwRecentRaises(changes, window) {
  const out = {};
  for (const r of (changes || [])) {
    if (!r || r.field !== 'dailyBudget') continue;
    if (String(r.ptDate || '') < window.priorStart) continue;
    const from = Number(r.from), to = Number(r.to);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) continue;
    const prev = out[String(r.campaignId)];
    if (!prev || String(r.ptDate) > prev.ptDate) {
      out[String(r.campaignId)] = { from, to, ptDate: r.ptDate };
    }
  }
  return out;
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────

async function handleBiweeklyRequest(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const missing = missingAdsCredentials();
    if (missing.length) {
      return res.status(500).json({ error: `Missing Advertising API credentials: ${missing.join(', ')}` });
    }

    const window = resolveBiweeklyWindow(new Date());
    const accessToken = await getAdsAccessToken();
    const reports = [];
    const failures = [];

    for (const key of BW_REPORT_KEYS) {
      const spec = bwReportSpec(key, window);
      try {
        const r = await requestCampaignReport(accessToken, spec);
        reports.push({ key, ...r });
      } catch (err) {
        console.error(`[BIWEEKLY REQUEST] ${key} failed:`, err.message);
        failures.push({ key, error: err.message, window: `${spec.start}..${spec.end}`,
                        invalidColumns: rfInvalidColumns(err.message) });
      }
      await sleep(600);
    }

    if (!reports.length) {
      return res.status(502).json({
        error: 'No report could be requested. ' + (failures[0] ? failures[0].error : ''),
        failures
      });
    }
    return res.status(200).json({ success: true, window, reports, failures,
                                  requestedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[BIWEEKLY REQUEST] Error:', error);
    return res.status(500).json({ error: 'Biweekly-request failed: ' + error.message });
  }
}

async function handleBiweeklyStatus(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const parsed = parseReportsParam(req.query.reports, BW_REPORT_KEYS);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const accessToken = await getAdsAccessToken();
    const statuses = [];
    for (const { key, reportId } of parsed.reports) {
      try {
        const status = await withAdsRetry(() => getReportStatus(accessToken, reportId));
        const norm = (status.status || '').toUpperCase();
        statuses.push({ key, reportId, status: norm,
                        done: norm === 'COMPLETED' || norm === 'SUCCESS',
                        failed: norm === 'FAILURE' || norm === 'FAILED' || norm === 'CANCELLED' });
      } catch (err) {
        statuses.push({ key, reportId, status: 'ERROR', done: false, failed: false, error: err.message });
      }
    }
    return res.status(200).json({ success: true, statuses,
      allDone: statuses.every(s => s.done || s.failed), checkedAt: new Date().toISOString() });
  } catch (error) {
    console.error('[BIWEEKLY STATUS] Error:', error);
    return res.status(500).json({ error: 'Biweekly-status failed: ' + error.message });
  }
}

async function handleBiweeklyCollect(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const parsed = parseReportsParam(req.query.reports, BW_REPORT_KEYS);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const window = {
      start: String(req.query.start || ''), end: String(req.query.end || ''),
      priorStart: String(req.query.priorStart || ''), priorEnd: String(req.query.priorEnd || '')
    };
    for (const [k, v] of Object.entries(window)) {
      if (!DATE_RE.test(v)) return res.status(400).json({ error: `${k} must be YYYY-MM-DD` });
    }
    if (daySpan(window.start, window.end) !== BW_CONFIG.WINDOW_DAYS ||
        daySpan(window.priorStart, window.priorEnd) !== BW_CONFIG.WINDOW_DAYS) {
      return res.status(400).json({ error: `both windows must span exactly ${BW_CONFIG.WINDOW_DAYS} days` });
    }

    const [census, postures] = await Promise.all([loadCensus(), bwLoadPostures()]);
    if (!census.campaigns.length) {
      return res.status(409).json({
        error: 'No campaign snapshot stored. Refresh Campaign Overview first — ' +
               'the tree reads budgets, brands and portfolios from it.'
      });
    }

    const accessToken = await getAdsAccessToken();
    const rows = [];
    const notes = [];
    for (const { key, reportId } of parsed.reports) {
      try {
        const status = await withAdsRetry(() => getReportStatus(accessToken, reportId));
        const url = status.url || status.location;
        if (!url) { notes.push({ key, note: `report not ready (${status.status || 'unknown'})` }); continue; }
        const raw = await withAdsRetry(() => downloadReport(url));
        rows.push(...rfNormalizeRows(raw, key.startsWith('sp') ? 'SP' : 'SB'));
      } catch (err) {
        console.error(`[BIWEEKLY COLLECT] ${key} failed:`, err.message);
        notes.push({ key, note: 'download failed: ' + err.message });
      }
    }
    if (!rows.length) return res.status(502).json({ error: 'No report rows could be downloaded.', notes });

    const result = evaluateBiweekly({
      census, rows, window, postures,
      recentRaises: bwRecentRaises(census.changes, window)
    });

    return res.status(200).json({
      success: true, window, config: BW_CONFIG, postures,
      deviations: BW_SPEC_DEVIATIONS,
      censusSyncedAt: census.syncedAt, ...result, notes,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[BIWEEKLY COLLECT] Error:', error);
    return res.status(500).json({ error: 'Biweekly-collect failed: ' + error.message });
  }
}

// Re-runs the decision tree against inputs the browser already holds, with no
// report request. The reports are the expensive half of a run - a queue that
// has taken half an hour - while the tree is the half that keeps changing as
// thresholds and postures are tuned. Without this, every threshold change
// needed a fresh half-hour wait to see.
//
// It refreshes DECISIONS, never DATA. The window travels with the inputs and
// is echoed back so the page can say which run it is re-deciding.
async function handleBiweeklyRecompute(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const inputs = req.body && req.body.inputs;
    if (!Array.isArray(inputs) || !inputs.length) {
      return res.status(400).json({ error: 'No stored run to recompute. Run the bi-weekly first.' });
    }
    const window = (req.body && req.body.window) || {};
    for (const k of ['start', 'end', 'priorStart', 'priorEnd']) {
      if (!DATE_RE.test(String(window[k] || ''))) {
        return res.status(400).json({ error: `window.${k} must be YYYY-MM-DD` });
      }
    }

    // Postures and recent raises are read fresh rather than taken from the
    // client: the whole point is to pick up changes made since the run.
    const [postures, census] = await Promise.all([bwLoadPostures(), loadCensus()]);
    const result = bwDecideAll({
      inputs, window, postures,
      recentRaises: bwRecentRaises(census.changes, window)
    });

    return res.status(200).json({
      success: true, window, config: BW_CONFIG, postures,
      deviations: BW_SPEC_DEVIATIONS,
      censusSyncedAt: census.syncedAt,
      ...result,
      recomputedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[BIWEEKLY RECOMPUTE] Error:', error);
    return res.status(500).json({ error: 'Recompute failed: ' + error.message });
  }
}

// The monthly posture per brand. Monthly is advisory and produces these by
// judgement, not computation, so they are set here rather than derived.
async function bwLoadPostures() {
  try {
    const stored = await kv.get(BW_POSTURE_KEY);
    const out = {};
    for (const [brand, posture] of Object.entries(stored || {})) {
      if (BW_POSTURES.includes(posture)) out[brand] = posture;
    }
    return out;
  } catch (err) {
    console.error('[BIWEEKLY] posture load failed:', err.message);
    return {};
  }
}

async function handleBiweeklyPosture(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const brand = String(req.body?.brand || '');
    const posture = String(req.body?.posture || '');
    if (!brand) return res.status(400).json({ error: 'brand required' });
    if (!BW_POSTURES.includes(posture)) {
      return res.status(400).json({ error: `posture must be one of: ${BW_POSTURES.join(', ')}` });
    }

    const current = await bwLoadPostures();
    // 'hold' IS the documented default, so storing it would only freeze a brand
    // against a later change in what the default means. Record a departure.
    const next = { ...current };
    if (posture === 'hold') delete next[brand];
    else next[brand] = posture;

    await kv.set(BW_POSTURE_KEY, next);
    return res.status(200).json({ success: true, postures: next });
  } catch (error) {
    console.error('[BIWEEKLY POSTURE] Error:', error);
    return res.status(500).json({ error: 'Posture update failed: ' + error.message });
  }
}

export { evaluateWeek, rfNormalizeRows, resolveWindow, rfSegment, rfInvalidColumns,
         reportSpec, buildReportBody, daySpan, rfDuplicateReportId, rfRecommendBudget,
         rfRecommendBid, rfDecomposeSpend,
         RF_COLUMNS, RF_CONFIG, RF_SPEC_DEVIATIONS, REPORT_KEYS, MAX_REPORT_DAYS, MARGINS,
         bwDecide, bwNewBudget, evaluateBiweekly, resolveBiweeklyWindow, bwReportSpec,
         bwRecentRaises, bwBuildInputs, bwDecideAll,
         BW_CONFIG, BW_POSTURES, BW_REPORT_KEYS, BW_SPEC_DEVIATIONS };
