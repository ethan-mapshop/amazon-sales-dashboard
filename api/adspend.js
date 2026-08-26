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
  }
  if (req.method === 'POST') {
    if (action === 'migrate-from-sheets')     return handleMigrateFromSheets(req, res);
    if (action === 'dedupe-sheets-vs-api')    return handleDedupeSheetsVsApi(req, res);
    if (action === 'delete-sheets-rows')      return handleDeleteSheetsRows(req, res);
    if (action === 'upload-yearly-csv')       return handleUploadYearlyCsv(req, res);
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
  'weekly spend. The reports are pulled in full either way.'
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
  sp: ['date', 'campaignId', 'cost', 'clicks', 'impressions', 'purchases7d', 'sales7d'],
  sb: ['date', 'campaignId', 'cost', 'clicks', 'impressions', 'purchases', 'sales']
};

// Amazon's v3 reporting API rejects a request whose date range exceeds this.
// It is the entire reason the week and the baseline cannot be one report: they
// are contiguous and total 35 days.
const MAX_REPORT_DAYS = 31;

// Two windows x two ad products. Rows from all four are pooled and binned by
// their own `date`, so the split is a transport detail rather than something
// the evaluation has to know about.
const REPORT_KEYS = ['spWeek', 'spBase', 'sbWeek', 'sbBase'];

function reportSpec(key, window) {
  const product = key.startsWith('sp') ? 'sp' : 'sb';
  return key.endsWith('Week')
    ? { product, start: window.weekStart, end: window.weekEnd }
    : { product, start: window.baseStart, end: window.baseEnd };
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

// ─── CONFIG CHANGE ANNOTATION ────────────────────────────────────────
// Which configuration fields could plausibly explain which flag. Deliberately
// narrow: a budget change does not explain a CTR collapse, and listing it would
// train you to ignore the annotation.
const RF_CHANGE_FIELDS = {
  budgetCap:     ['dailyBudget', 'state'],
  silent:        ['state', 'endDate', 'budgetType'],
  spendCollapse: ['dailyBudget', 'defaultBid', 'biddingStrategy', 'state'],
  ctrCollapse:   ['placementsSummary', 'targetingType', 'defaultBid'],
  cpcSpike:      ['defaultBid', 'biddingStrategy', 'placementsSummary']
  // brandPacing is deliberately absent: it is an aggregate over 30-40 campaigns,
  // and a per-campaign change belongs on that campaign's row.
};

// Two is enough to explain a row. More turns an annotation into a changelog.
const RF_CHANGES_PER_ROW = 2;

// A change during the BASELINE is as relevant as one during the week: it is
// what makes the week differ from the average it is compared against. So the
// search window is the whole 35 days, not the 7.
function rfChangesFor(changes, campaignId, check, window) {
  const fields = RF_CHANGE_FIELDS[check];
  if (!fields || !Array.isArray(changes)) return [];
  const id = String(campaignId);
  return changes
    .filter(r => r && String(r.campaignId) === id && fields.includes(r.field) &&
                 String(r.ptDate || '') >= window.baseStart)
    .sort((a, b) => String(b.ptDate).localeCompare(String(a.ptDate)))
    .slice(0, RF_CHANGES_PER_ROW)
    .map(r => ({ field: r.field, from: r.from ?? null, to: r.to ?? null, ptDate: r.ptDate }));
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

  const changeLog = census.changes || [];
  const base = (c, check) => ({
    campaignId: c.campaignId, campaign: c.name,
    adProduct: c.adProduct, brand: c.brand,
    changes: rfChangesFor(changeLog, c.campaignId, check, window)
  });

  for (const c of campaigns.values()) {

    // ── 1 · Budget cap emergencies ──
    // Current trigger, standing filter: the campaign is pressed against its
    // ceiling THIS week, and is a kind of campaign worth feeding.
    if (c.cappedDays !== null && c.cappedDays >= RF_CONFIG.CAP_DAYS_MIN &&
        c.retention28 !== null && c.retention28 >= RF_CONFIG.CAP_RETENTION_MIN) {
      flags.budgetCap.push({
        ...base(c, 'budgetCap'),
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
        ...base(c, 'silent'),
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
        ...base(c, 'spendCollapse'),
        spend7: r2(c.spend7),
        baselineWeekly: c.baselineWeekly,
        change: r4((c.spend7 - c.baselineWeekly) / c.baselineWeekly)
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
        ...base(c, 'ctrCollapse'),
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
        ...base(c, 'cpcSpike'),
        clicks7: Math.round(c.clicks7),
        spend7: r2(c.spend7),
        cpc7: c.cpc7, cpc28: c.cpc28,
        change: r4((c.cpc7 - c.cpc28) / c.cpc28)
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
    if (!b) { b = { brand: c.brand, spend7: 0, spend28: 0 }; brands.set(c.brand, b); }
    b.spend7 += c.spend7;
    b.spend28 += c.spend28;
  }
  for (const b of brands.values()) {
    const baselineWeekly = r2(b.spend28 / 4);
    // No baseline means no deviation to measure — a brand that spent nothing
    // for 28 days and something this week is a launch, not a pacing problem.
    if (baselineWeekly <= 0) continue;
    const deviation = r4((b.spend7 - baselineWeekly) / baselineWeekly);
    if (Math.abs(deviation) > RF_CONFIG.PACING_DEVIATION) {
      flags.brandPacing.push({
        brand: b.brand, spend7: r2(b.spend7), baselineWeekly, deviation
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
function parseReportsParam(raw) {
  if (!raw) return { error: 'reports parameter required (key:reportId,...)' };
  const parts = String(raw).split(',').map(s => s.trim()).filter(Boolean);
  if (!parts.length) return { error: 'reports parameter is empty' };
  if (parts.length > REPORT_KEYS.length) return { error: 'too many report IDs' };

  const reports = [];
  const seen = new Set();
  for (const part of parts) {
    const idx = part.indexOf(':');
    if (idx < 1) return { error: `malformed report entry: ${part}` };
    const key = part.slice(0, idx);
    const reportId = part.slice(idx + 1);
    if (!REPORT_KEYS.includes(key)) return { error: `unknown report key: ${key}` };
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
export { evaluateWeek, rfNormalizeRows, resolveWindow, rfSegment, rfInvalidColumns,
         reportSpec, buildReportBody, daySpan, rfDuplicateReportId, rfRecommendBudget,
         rfChangesFor, RF_CHANGE_FIELDS, RF_CHANGES_PER_ROW,
         RF_COLUMNS, RF_CONFIG, RF_SPEC_DEVIATIONS, REPORT_KEYS, MAX_REPORT_DAYS, MARGINS };
