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
// weekly-status / weekly-collect / probe-columns) at the bottom. It shares the
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
    if (action === 'probe-columns')       return handleProbeColumns(req, res);
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
// Four fixed threshold checks over the most recent COMPLETE Monday-Sunday week,
// keyed on profit retention = (gross margin % - ACoS %) / gross margin %.
// Ported from a manual spreadsheet cadence.
//
//   weekly-request  - resolve the window, POST 4 report requests
//   weekly-status   - poll those report IDs
//   weekly-collect  - download, compute the checks, return flags
//   probe-columns   - throwaway 1-day reports to validate the column sets
//
// Lives in this file rather than its own because Vercel's Hobby plan caps a
// deployment at 12 serverless functions. It shares this file's Advertising API
// client (getAdsAccessToken / requestReport / getReportStatus / downloadReport)
// but nothing else - it does not read or write any adspend:* KV key, and it
// persists nothing at all. The browser holds report IDs across the async wait.
//
// Windows are Pacific: Vercel runs UTC and Ads report dates are marketplace
// local, so a UTC-naive window sits a day ahead between 00:00 and 08:00 UTC.
//
// KNOWN LIMITATION - the capped signal is a proxy. Amazon exposes historical
// "time in budget" only through the console Budget Report, not the API (the
// Budget Usage API is real-time only). "Capped" here means the campaign spent
// >= CAPPED_RATIO of its daily budget on >= CAPPED_DAYS_MIN days of the week.
// Validated against the April 2026 console export: agrees with Amazon's
// time-in-budget on 8 of 9 capped campaigns. Amazon's estimated-missed-sales
// range is likewise console-only. Do not "fix" this by reaching for a
// time-in-budget field - there isn't one.

// ─── RF_CONFIG ──────────────────────────────────────────────────────────────────
// Thresholds are fixed by the cadence spec and applied exactly — no adjusting
// for feel or context. Returned in every response so the UI can render the
// thresholds in effect and a run can be diffed against the spec without
// reading this file.
const RF_CONFIG = {
  MIN_WEEKLY_SPEND:     5,      // campaigns under $5/wk are not evaluated at all
  RUNAWAY_MIN_SPEND:    50,     // floor so $15 → $35 doesn't trip check 2
  RUNAWAY_MULTIPLE:     2,      // 7-day spend > 2x trailing weekly average
  RETENTION_GOOD:       0.50,   // check 1 — worth feeding
  RETENTION_BAD:        0.25,   // check 2 — not worth defending
  STALLED_MIN_CLICKS:   15,     // check 3 — PORTFOLIO level, not campaign
  PACING_DEVIATION:     0.30,   // check 4 — brand spend vs baseline, either way
  CAPPED_RATIO:         0.95,   // day counts as capped at >= 95% of daily budget
  CAPPED_DAYS_MIN:      3,      // ... on at least this many days of the week
  BRAND_BASELINE_FLOOR: 50,     // below this weekly baseline, brand pacing is noise
  BASELINE_MIN_DAYS:    14      // need this many active days to trust a baseline
};

// Longest-first so "BW PACK" wins over "BW". Sorted at module load rather than
// trusted to authoring order — and an array, because object key order is not a
// contract. Brand strings MUST match the app's canonical labels (js/core.js
// PRODUCT_BRAND_SHORT) or nothing joins to the rest of the dashboard.
const BRAND_PREFIXES = [
  { prefix: 'MAP PACKS', brand: 'BrightWay Educational', segment: 'BW_PACKS' },
  { prefix: 'BW PACK',   brand: 'BrightWay Educational', segment: 'BW_PACKS' },
  { prefix: 'BW SET',    brand: 'BrightWay Educational', segment: 'BW_SETS'  },
  { prefix: 'BW',        brand: 'BrightWay Educational', segment: null       },
  { prefix: 'SOK',       brand: 'South of Kings',        segment: 'SOK'      },
  { prefix: 'RR',        brand: 'Hubbard Scientific',    segment: 'HUBBARD'  },
  { prefix: 'STATE',     brand: 'MapShop State Maps',    segment: 'MAPSHOP'  }
].sort((a, b) => b.prefix.length - a.prefix.length);

// Gross margin per MARGIN SEGMENT, which is a separate axis from brand.
// BrightWay Packs and Sets have materially different economics and their
// campaign names distinguish them, so per-segment margin beats the blended
// 45% figure. BW_BLENDED is the fallback for BrightWay campaigns whose name
// says neither Pack nor Set.
const MARGINS = {
  BW_PACKS:   0.38,
  BW_SETS:    0.51,
  BW_BLENDED: 0.45,
  HUBBARD:    0.52,
  MAPSHOP:    0.44,
  SOK:        0.39
};

const BRAND_DEFAULT_SEGMENT = {
  'BrightWay Educational': 'BW_BLENDED',
  'Hubbard Scientific':    'HUBBARD',
  'MapShop State Maps':    'MAPSHOP',
  'South of Kings':        'SOK'
};

const REPORT_KEYS = ['spWeek', 'spBase', 'sbWeek', 'sbBase'];
const REPORT_ID_RE = /^[A-Za-z0-9._-]{8,80}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Column sets, most-complete first. If Amazon 400s an invalid column the whole
// request fails, so each report falls back to a narrower set and reports which
// one it landed on. The narrowest SP/SB sets are the ones already proven in
// production by adspend.js. Run ?action=probe-columns against the live account
// to confirm the full sets rather than assuming them.
const COLUMN_SETS = {
  sp: [
    ['date', 'portfolioId', 'campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount', 'campaignBudgetType',
     'cost', 'clicks', 'impressions', 'purchases7d', 'sales7d'],
    ['date', 'campaignId', 'campaignName', 'campaignBudgetAmount', 'campaignBudgetType',
     'cost', 'clicks', 'impressions', 'purchases7d', 'sales7d'],
    ['date', 'campaignId', 'campaignName', 'cost', 'clicks', 'impressions', 'purchases7d', 'sales7d']
  ],
  sb: [
    ['date', 'portfolioId', 'campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount', 'campaignBudgetType',
     'cost', 'clicks', 'impressions', 'purchases', 'sales'],
    ['date', 'campaignId', 'campaignName', 'campaignBudgetAmount', 'campaignBudgetType',
     'cost', 'clicks', 'impressions', 'purchases', 'sales'],
    ['date', 'campaignId', 'campaignName', 'cost', 'clicks', 'impressions', 'purchases', 'sales'],
    ['date', 'campaignId', 'campaignName', 'cost', 'clicks', 'impressions']
  ]
};

// ─── WEEKLY REQUEST ──────────────────────────────────────────────────────────
// Resolves the window and fires the four report requests SEQUENTIALLY with a
// small delay. v3 returns 425 for a duplicate createReport while an identical
// one is still running, and has been reported to false-positive when similar
// reports are fired in the same tick — so no Promise.all here.
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

    const specs = [
      { key: 'spWeek', product: 'sp', start: window.weekStart, end: window.weekEnd },
      { key: 'spBase', product: 'sp', start: window.baseStart, end: window.baseEnd },
      { key: 'sbWeek', product: 'sb', start: window.weekStart, end: window.weekEnd },
      { key: 'sbBase', product: 'sb', start: window.baseStart, end: window.baseEnd }
    ];

    const reports = [];
    for (const spec of specs) {
      try {
        const out = await requestCampaignReport(accessToken, spec);
        reports.push({ key: spec.key, ...out });
      } catch (err) {
        // 425 means an identical report is already running. That is not a
        // failure — but without the in-flight reportId there is nothing to
        // poll, so surface it distinctly and let the client tell the user to
        // wait rather than hammering the endpoint.
        const duplicate = /\(425\)/.test(err.message);
        console.error(`[ADREPORTS REQUEST] ${spec.key} failed:`, err.message);
        reports.push({ key: spec.key, error: err.message, duplicate });
      }
      await sleep(400);
    }

    return res.status(200).json({
      success: true,
      window,
      reports,
      config: RF_CONFIG,
      requestedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[ADREPORTS REQUEST] Error:', error);
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
          key,
          reportId,
          status: norm,
          done: norm === 'COMPLETED' || norm === 'SUCCESS',
          failed: norm === 'FAILURE' || norm === 'FAILED' || norm === 'CANCELLED'
        });
      } catch (err) {
        console.error(`[ADREPORTS STATUS] ${key} failed:`, err.message);
        statuses.push({ key, reportId, status: 'ERROR', done: false, failed: false, error: err.message });
      }
    }

    return res.status(200).json({
      success: true,
      statuses,
      allDone: statuses.every(s => s.done || s.failed),
      checkedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[ADREPORTS STATUS] Error:', error);
    return res.status(500).json({ error: 'Weekly-status failed: ' + error.message });
  }
}

// ─── WEEKLY COLLECT ──────────────────────────────────────────────────────────
// Downloads the completed reports and runs the checks. The window is ECHOED
// BACK by the client and validated here rather than recomputed — a run that
// straddles midnight Pacific would otherwise compute a different divisor than
// the reports were built for.
async function handleWeeklyCollect(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const parsed = parseReportsParam(req.query.reports);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const window = parseWindowParam(req.query);
    if (window.error) return res.status(400).json({ error: window.error });

    const accessToken = await getAdsAccessToken();

    const byKey = {};
    const downloadNotes = [];
    for (const { key, reportId } of parsed.reports) {
      try {
        const status = await withAdsRetry(() => getReportStatus(accessToken, reportId));
        const norm = (status.status || '').toUpperCase();
        if (norm !== 'COMPLETED' && norm !== 'SUCCESS') {
          downloadNotes.push({ key, note: `not ready (${norm || 'unknown'})` });
          continue;
        }
        const url = status.url || status.location;
        if (!url) {
          downloadNotes.push({ key, note: 'completed but no download URL' });
          continue;
        }
        const raw = await withAdsRetry(() => downloadReport(url));
        byKey[key] = arfNormalizeRows(raw, key.startsWith('sp') ? 'SP' : 'SB');
      } catch (err) {
        console.error(`[ADREPORTS COLLECT] ${key} failed:`, err.message);
        downloadNotes.push({ key, note: 'download failed: ' + err.message });
      }
    }

    if (!byKey.spWeek && !byKey.sbWeek) {
      return res.status(502).json({
        error: 'No week-window report could be downloaded — nothing to evaluate.',
        notes: downloadNotes
      });
    }

    const weekRows = [...(byKey.spWeek || []), ...(byKey.sbWeek || [])];
    const reportHasBudgets = weekRows.some(r => r.budgetAmount > 0);

    const [mappings, portfolioNames, budgetFallback] = await Promise.all([
      loadMappings(),
      fetchPortfolios(accessToken),
      reportHasBudgets ? Promise.resolve(null) : fetchCampaignBudgets(accessToken)
    ]);

    const result = computeRedFlags({
      weekRows,
      baselineRows: [...(byKey.spBase || []), ...(byKey.sbBase || [])],
      window,
      mappings,
      portfolioNames,
      budgetFallback
    });

    return res.status(200).json({
      success: true,
      window,
      config: RF_CONFIG,
      ...result,
      notes: downloadNotes,
      generatedAt: new Date().toISOString()
    });
  } catch (error) {
    console.error('[ADREPORTS COLLECT] Error:', error);
    return res.status(500).json({ error: 'Weekly-collect failed: ' + error.message });
  }
}

// ─── PROBE COLUMNS ───────────────────────────────────────────────────────────
// Amazon's docs are a JS SPA and can't be read programmatically, so the
// reliable way to validate a column set is to ask Amazon: fire a throwaway
// 1-day report with the full candidate set and read the 400 body, which names
// the invalid columns. Cheap, definitive, and worth re-running whenever
// Amazon revs the report schema.
async function handleProbeColumns(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const missing = missingAdsCredentials();
    if (missing.length) {
      return res.status(500).json({ error: `Missing Advertising API credentials: ${missing.join(', ')}` });
    }

    const day = _addDays(_ptDate(new Date()), -3);
    const accessToken = await getAdsAccessToken();
    const results = [];

    for (const product of ['sp', 'sb']) {
      for (let i = 0; i < COLUMN_SETS[product].length; i++) {
        const columns = COLUMN_SETS[product][i];
        try {
          const reportId = await requestReport(accessToken, buildReportBody(product, day, day, columns));
          results.push({ product, setIndex: i, ok: true, reportId, columns });
          break; // first set Amazon accepts is the one a real run would use
        } catch (err) {
          results.push({ product, setIndex: i, ok: false, error: err.message, columns });
        }
        await sleep(400);
      }
    }

    return res.status(200).json({ success: true, probedDate: day, results });
  } catch (error) {
    console.error('[ADREPORTS PROBE] Error:', error);
    return res.status(500).json({ error: 'Probe failed: ' + error.message });
  }
}

// ─── WINDOW ──────────────────────────────────────────────────────────────────

// Most recent COMPLETE Monday–Sunday week in Pacific time, plus the 28 days
// immediately before it. "Complete" means strictly before today, so a run on
// Sunday evaluates the week that ended the previous Sunday, not the one still
// in progress.
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

// ─── COMPUTE ─────────────────────────────────────────────────────────────────
// Pure function over normalized rows — no I/O — so it can be exercised
// offline against saved console exports.
//
// Stage order matters: brand aggregates (stage 4) are computed BEFORE the
// $5 eligibility filter (stage 5), or sub-$5 campaigns would silently drop out
// of brand pacing totals.
function computeRedFlags({ weekRows, baselineRows, window, mappings, portfolioNames, budgetFallback }) {
  // Stage 2 — aggregate per campaign. Keyed by id, not name: a campaign
  // renamed mid-window would otherwise split into two identities.
  const camps = new Map();
  const campKey = (r) => `${r.adProduct}:${r.campaignId || r.campaignName}`;
  const touch = (r) => {
    const key = campKey(r);
    let c = camps.get(key);
    if (!c) {
      c = {
        key, adProduct: r.adProduct, campaignId: r.campaignId, campaignName: r.campaignName,
        campaignStatus: r.campaignStatus || '', portfolioId: r.portfolioId || '',
        spend7: 0, clicks7: 0, impressions7: 0, orders7: 0, sales7: 0,
        spend28: 0, days28: new Set(),
        budgetByDate: new Map(), spendByDate: new Map(),
        budgetType: r.budgetType || ''
      };
      camps.set(key, c);
    }
    if (r.campaignName) c.campaignName = r.campaignName;
    if (r.campaignStatus) c.campaignStatus = r.campaignStatus;
    if (r.portfolioId) c.portfolioId = r.portfolioId;
    if (r.budgetType) c.budgetType = r.budgetType;
    return c;
  };

  for (const r of weekRows) {
    const c = touch(r);
    c.spend7 += r.cost;
    c.clicks7 += r.clicks;
    c.impressions7 += r.impressions;
    c.orders7 += r.orders;
    c.sales7 += r.sales;
    c.spendByDate.set(r.date, (c.spendByDate.get(r.date) || 0) + r.cost);
    if (r.budgetAmount > 0) c.budgetByDate.set(r.date, r.budgetAmount);
  }
  for (const r of baselineRows) {
    const c = touch(r);
    c.spend28 += r.cost;
    if (r.cost > 0) c.days28.add(r.date);
  }

  // Stage 3 — attribution (brand for margin, portfolio for grouping).
  const pfNames = portfolioNames || {};
  const mappingConflicts = [];
  for (const c of camps.values()) {
    const pf = resolvePortfolio(c, pfNames);
    c.portfolio = pf.name;
    c.portfolioSource = pf.source;
    const resolved = resolveBrand(c.campaignName, c.adProduct, mappings);
    c.brand = resolved.brand;
    c.brandSource = resolved.source;
    c.marginSegment = resolved.segment;
    c.grossMargin = resolved.segment ? MARGINS[resolved.segment] : null;
    if (resolved.conflict) {
      mappingConflicts.push({
        campaign: c.campaignName, adProduct: c.adProduct,
        mapped: resolved.conflict.mapped, byPrefix: resolved.conflict.byPrefix
      });
    }
  }

  // Stage 4 — brand aggregates, over ALL campaigns including sub-$5 ones.
  const brands = new Map();
  for (const c of camps.values()) {
    if (!c.brand) continue;
    let b = brands.get(c.brand);
    if (!b) { b = { brand: c.brand, spend7: 0, spend28: 0, days28: new Set() }; brands.set(c.brand, b); }
    b.spend7 += c.spend7;
    b.spend28 += c.spend28;
    for (const d of c.days28) b.days28.add(d);
  }

  // Stage 4b — portfolio aggregates for check 3. Deliberately spans every
  // campaign regardless of the per-campaign spend floor: the products this
  // check exists to find are ones where four campaigns each sit under the bar
  // while the product as a whole clearly stopped converting.
  const portfolios = new Map();
  for (const c of camps.values()) {
    let p = portfolios.get(c.portfolio);
    if (!p) {
      p = {
        portfolio: c.portfolio, portfolioSource: c.portfolioSource, brand: c.brand || null,
        clicks7: 0, orders7: 0, spend7: 0, sales7: 0, impressions7: 0, campaigns: []
      };
      portfolios.set(c.portfolio, p);
    }
    p.clicks7 += c.clicks7;
    p.orders7 += c.orders7;
    p.spend7 += c.spend7;
    p.sales7 += c.sales7;
    p.impressions7 += c.impressions7;
    if (!p.brand && c.brand) p.brand = c.brand;
    p.campaigns.push({
      campaign: c.campaignName, adProduct: c.adProduct,
      clicks7: Math.round(c.clicks7), orders7: Math.round(c.orders7),
      spend7: r2(c.spend7), status: c.campaignStatus || null
    });
  }

  // Stage 6 — per-campaign metrics.
  for (const c of camps.values()) {
    // ACoS is NULL, never 0, when there are no sales. The naive
    // `sales ? cost/sales : 0` makes retention compute to 1.0 and a dead
    // campaign look perfect — that bug shipped in the manual version.
    c.acos = c.sales7 > 0 ? c.spend7 / c.sales7 : null;
    c.retention = (c.acos === null || !(c.grossMargin > 0))
      ? null
      : r4((c.grossMargin - c.acos) / c.grossMargin);

    // Report budgets win when present; otherwise apply the campaign object's
    // current budget to every day of the week.
    if (!c.budgetByDate.size && budgetFallback) {
      const fb = budgetFallback[String(c.campaignId || '')];
      if (fb && fb.amount > 0) {
        for (const d of c.spendByDate.keys()) c.budgetByDate.set(d, fb.amount);
        c.budgetSource = 'campaigns-api';
        if (fb.type) c.budgetType = fb.type;
      }
    } else if (c.budgetByDate.size) {
      c.budgetSource = 'report';
    }

    c.budgetDays = c.budgetByDate.size;
    c.dailyBudget = c.budgetDays ? Math.max(...c.budgetByDate.values()) : null;
    c.budgetTotal = 0;
    for (const v of c.budgetByDate.values()) c.budgetTotal += v;
    c.lifetimeBudget = /LIFETIME/i.test(String(c.budgetType || ''));
    c.cappedEvaluable = c.budgetDays > 0 && !c.lifetimeBudget;

    // Count of days the campaign actually ran out of budget. A weekly
    // spend-to-budget ratio would miss the campaign that maxes out Mon–Wed
    // and goes quiet — which is exactly the one this check exists to find.
    c.cappedDays = 0;
    if (c.cappedEvaluable) {
      for (const [date, budget] of c.budgetByDate) {
        if (budget > 0 && (c.spendByDate.get(date) || 0) >= RF_CONFIG.CAPPED_RATIO * budget) c.cappedDays++;
      }
    }
    c.weeklyCapRatio = c.budgetTotal > 0 ? r4(c.spend7 / c.budgetTotal) : null;
    c.capped = c.cappedEvaluable && c.cappedDays >= RF_CONFIG.CAPPED_DAYS_MIN;

    c.baselineWeekly = c.spend28 / 4;
    c.baselineUsable = c.days28.size >= RF_CONFIG.BASELINE_MIN_DAYS;
    c.spendMultiple = (c.baselineUsable && c.baselineWeekly > 0)
      ? r4(c.spend7 / c.baselineWeekly) : null;
  }

  // Stage 5 + 7 — eligibility, then the checks in spec order.
  const flags = { budgetCap: [], runaway: [], stalled: [], brandPacing: [] };
  const coverage = {
    campaignsSeen: camps.size, evaluated: 0,
    totalSpend7: 0, evaluatedSpend7: 0,
    excludedUnderMin: [], unmapped: [], notEvaluable: [], cappedNoSales: [],
    cappedLowRetention: [], newNoBaseline: [], mappingConflicts,
    cappedEvaluableCount: 0, budgetTypesSeen: {}, budgetSource: null
  };

  for (const c of camps.values()) {
    coverage.totalSpend7 += c.spend7;

    if (c.spend7 < RF_CONFIG.MIN_WEEKLY_SPEND) {
      // Spec: campaigns under $5/week carry too little signal to interpret.
      if (c.spend7 > 0) coverage.excludedUnderMin.push(arfRow(c));
      continue;
    }
    coverage.evaluated++;
    coverage.evaluatedSpend7 += c.spend7;
    if (c.cappedEvaluable) {
      coverage.cappedEvaluableCount++;
      if (!coverage.budgetSource) coverage.budgetSource = c.budgetSource || null;
    }
    // Raw budget-type values as Amazon returned them. If the capped check goes
    // quiet again, this says why without another round trip.
    const bt = c.budgetType || '(none)';
    coverage.budgetTypesSeen[bt] = (coverage.budgetTypesSeen[bt] || 0) + 1;

    if (!c.brand) coverage.unmapped.push(arfRow(c));
    if (c.lifetimeBudget) coverage.notEvaluable.push({ ...arfRow(c), reason: 'lifetime-budget' });
    else if (!c.budgetDays) coverage.notEvaluable.push({ ...arfRow(c), reason: 'no-budget-data' });
    if (!c.baselineUsable) coverage.newNoBaseline.push(arfRow(c));

    // 1 — Budget cap emergency. retention === null CANNOT satisfy this; a
    // capped campaign with no sales is the opposite of an opportunity, so it
    // goes to cappedNoSales instead of being flagged as one to feed.
    if (c.capped && c.retention !== null && c.retention >= RF_CONFIG.RETENTION_GOOD) {
      flags.budgetCap.push(arfRow(c));
    } else if (c.capped && c.retention === null) {
      coverage.cappedNoSales.push(arfRow(c));
    } else if (c.capped) {
      // Capped, but retention is below the bar. Not flagged — pushing budget
      // at a campaign that can't convert it into profit is the mistake check 1
      // exists to avoid. Surfaced anyway so "Amazon says this is capped, why
      // isn't it here?" has a visible answer.
      coverage.cappedLowRetention.push(arfRow(c));
    }

    // 2 — Runaway spender. Here retention === null DOES satisfy "< 25%":
    // zero sales is retention below any threshold, and excluding the worst
    // case would gut the check. The asymmetry with check 1 is deliberate —
    // do not "fix" it into consistency.
    if (c.spend7 > RF_CONFIG.RUNAWAY_MIN_SPEND &&
        c.baselineUsable && c.baselineWeekly > 0 &&
        c.spend7 > RF_CONFIG.RUNAWAY_MULTIPLE * c.baselineWeekly &&
        (c.retention === null || c.retention < RF_CONFIG.RETENTION_BAD)) {
      flags.runaway.push(arfRow(c));
    }

  }

  // 3 — Stalled, at PORTFOLIO level. A stalled product is a listing problem —
  // inventory, Buy Box, reviews, pricing — and those stop every campaign for
  // the product at once, so reporting per campaign reported one fact four
  // times while missing products whose campaigns were each under the old bar.
  // Needs no margin, so unmapped portfolios are still evaluated.
  for (const p of portfolios.values()) {
    if (p.spend7 < RF_CONFIG.MIN_WEEKLY_SPEND) continue;
    // Clicks and orders are integers per day, so the sums are exact — but round
    // before comparing anyway, for the same reason the ratio checks do. A
    // portfolio sitting exactly on the threshold shouldn't turn on float dust.
    const pClicks = Math.round(p.clicks7);
    if (pClicks >= RF_CONFIG.STALLED_MIN_CLICKS && Math.round(p.orders7) === 0) {
      flags.stalled.push({
        portfolio: p.portfolio,
        portfolioSource: p.portfolioSource,
        brand: p.brand,
        clicks7: pClicks,
        impressions7: Math.round(p.impressions7),
        spend7: r2(p.spend7),
        campaignCount: p.campaigns.length,
        campaigns: p.campaigns.sort((a, b) => b.spend7 - a.spend7)
      });
    }
  }

  // 4 — Brand pacing.
  for (const b of brands.values()) {
    const baselineWeekly = b.spend28 / 4;
    const usable = b.days28.size >= RF_CONFIG.BASELINE_MIN_DAYS &&
                   baselineWeekly >= RF_CONFIG.BRAND_BASELINE_FLOOR;
    if (!usable) continue;
    const deviation = r4((b.spend7 - baselineWeekly) / baselineWeekly);
    if (Math.abs(deviation) > RF_CONFIG.PACING_DEVIATION) {
      flags.brandPacing.push({
        brand: b.brand,
        spend7: r2(b.spend7),
        baselineWeekly: r2(baselineWeekly),
        deviation,
        direction: deviation > 0 ? 'up' : 'down'
      });
    }
  }

  // Biggest exposure first in each list.
  flags.budgetCap.sort((a, b) => b.spend7 - a.spend7);
  flags.runaway.sort((a, b) => b.spend7 - a.spend7);
  flags.stalled.sort((a, b) => b.spend7 - a.spend7);
  flags.brandPacing.sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation));
  coverage.unmapped.sort((a, b) => b.spend7 - a.spend7);
  coverage.excludedUnderMin.sort((a, b) => b.spend7 - a.spend7);
  coverage.cappedNoSales.sort((a, b) => b.spend7 - a.spend7);
  coverage.cappedLowRetention.sort((a, b) => b.spend7 - a.spend7);

  coverage.totalSpend7 = r2(coverage.totalSpend7);
  coverage.evaluatedSpend7 = r2(coverage.evaluatedSpend7);

  const flagCount = flags.budgetCap.length + flags.runaway.length +
                    flags.stalled.length + flags.brandPacing.length;

  return { flags, coverage, flagCount, clean: flagCount === 0 };
}

// Flag/coverage row — carries the raw evidence so the UI never recomputes and
// any flag can be audited against the console.
function arfRow(c) {
  return {
    campaign: c.campaignName,
    adProduct: c.adProduct,
    campaignId: c.campaignId,
    brand: c.brand || null,
    brandSource: c.brandSource,
    marginSegment: c.marginSegment || null,
    grossMargin: c.grossMargin,
    status: c.campaignStatus || null,
    spend7: r2(c.spend7),
    clicks7: c.clicks7,
    impressions7: c.impressions7,
    orders7: c.orders7,
    sales7: r2(c.sales7),
    acos: c.acos === null ? null : r4(c.acos),
    retention: c.retention,
    dailyBudget: c.dailyBudget,
    budgetType: c.budgetType || null,
    cappedDays: c.cappedEvaluable ? c.cappedDays : null,
    weeklyCapRatio: c.weeklyCapRatio,
    baselineWeekly: r2(c.baselineWeekly),
    baselineDays: c.days28.size,
    spendMultiple: c.spendMultiple
  };
}

// ─── BRAND ATTRIBUTION ───────────────────────────────────────────────────────
// The dashboard already keeps a curated campaign→brand mapping, editable on
// the Campaign Mapping page. That wins when present so this page agrees with
// Profitability Overview; the name prefixes fill gaps so new campaigns are
// covered automatically. Disagreements are reported rather than silently
// resolved — they usually mean a stale mapping.
function resolveBrand(campaignName, adProduct, mappings) {
  const name = String(campaignName || '').trim();
  const mapped = adProduct === 'SB'
    ? mappings.brand[name]
    : (mappings.product[name] && mappings.product[name].brand);
  const prefix = brandFromPrefix(name);

  let conflict = null;
  if (mapped && prefix.brand && mapped !== prefix.brand) {
    conflict = { mapped, byPrefix: prefix.brand };
  }

  if (mapped) {
    // Keep the prefix-derived segment when the two agree — it is finer
    // grained than brand (Packs vs Sets) and the mapping has no segment
    // concept of its own.
    const segment = (prefix.brand === mapped && prefix.segment)
      ? prefix.segment
      : (BRAND_DEFAULT_SEGMENT[mapped] || null);
    return { brand: mapped, segment, source: 'mapping', conflict };
  }
  if (prefix.brand) {
    return {
      brand: prefix.brand,
      segment: prefix.segment || BRAND_DEFAULT_SEGMENT[prefix.brand] || null,
      source: 'prefix',
      conflict
    };
  }
  return { brand: null, segment: null, source: 'unmapped', conflict };
}

// Portfolio is the grouping unit for the stalled check, and in this account it
// is effectively the product: 140 campaigns across 42 portfolios, one per SKU.
// When the report carries no portfolioId, fall back to the product implied by
// the campaign name — "SOK World Blank (Auto)" becomes "SOK World Blank".
// Checked against the April export, the two grouped identically.
function resolvePortfolio(c, pfNames) {
  const byId = c.portfolioId && pfNames[c.portfolioId];
  if (byId) return { name: byId, source: 'portfolio' };
  const derived = String(c.campaignName || '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  return { name: derived || c.campaignName || '(unknown)', source: 'name' };
}

// Longest prefix wins, and the prefix must be followed by a non-alphanumeric
// character or end of string — otherwise "BWX Something" matches "BW".
function brandFromPrefix(campaignName) {
  const up = String(campaignName || '').trim().toUpperCase();
  for (const entry of BRAND_PREFIXES) {
    if (!up.startsWith(entry.prefix)) continue;
    const next = up.charAt(entry.prefix.length);
    if (next === '' || !/[A-Z0-9]/.test(next)) {
      return { brand: entry.brand, segment: entry.segment };
    }
  }
  return { brand: null, segment: null };
}

// Daily budgets read from the campaign objects. The v3 campaign report is
// supposed to expose campaignBudgetAmount, but it comes back empty on this
// account, which silently removed every campaign from the capped check. These
// endpoints are synchronous and authoritative, so the check no longer depends
// on that column being populated.
//
// Caveat worth keeping in mind: this is the budget as it stands NOW, not what
// it was on each day of the week being evaluated. If a budget was raised
// mid-week, the capped days for that week are computed against the new number.
// Reported as budgetSource: 'campaigns-api' so the UI can say so.
async function fetchCampaignBudgets(accessToken) {
  const out = {};

  const take = (list) => {
    for (const c of list || []) {
      const id = String(c.campaignId || '');
      if (!id) continue;
      const amount = Number(
        (c.budget && (c.budget.budget ?? c.budget.amount)) ??
        c.dailyBudget ?? (typeof c.budget === 'number' ? c.budget : undefined)
      );
      const type = String((c.budget && c.budget.budgetType) || c.budgetType || '');
      if (Number.isFinite(amount) && amount > 0) out[id] = { amount, type };
    }
  };

  // SP v3
  try {
    const res = await fetch('https://advertising-api.amazon.com/sp/campaigns/list', {
      method: 'POST',
      headers: adsAuthHeaders(accessToken, {
        'Content-Type': 'application/vnd.spCampaign.v3+json',
        'Accept': 'application/vnd.spCampaign.v3+json'
      }),
      body: JSON.stringify({ maxResults: 500 })
    });
    if (res.ok) take((await res.json().catch(() => ({}))).campaigns);
  } catch (err) {
    console.error('[ADREPORTS] sp campaigns v3 failed:', err.message);
  }

  // SP v2 — older shape, flat dailyBudget
  if (!Object.keys(out).length) {
    try {
      const res = await fetch(
        'https://advertising-api.amazon.com/v2/sp/campaigns?stateFilter=enabled,paused,archived&count=500',
        { headers: adsAuthHeaders(accessToken) });
      if (res.ok) take(await res.json().catch(() => []));
    } catch (err) {
      console.error('[ADREPORTS] sp campaigns v2 failed:', err.message);
    }
  }

  // SB — only a couple of campaigns, so a failure here is not worth retrying.
  try {
    const res = await fetch('https://advertising-api.amazon.com/sb/v4/campaigns/list', {
      method: 'POST',
      headers: adsAuthHeaders(accessToken, {
        'Content-Type': 'application/vnd.sbcampaignresource.v4+json',
        'Accept': 'application/vnd.sbcampaignresource.v4+json'
      }),
      body: JSON.stringify({ maxResults: 100 })
    });
    if (res.ok) take((await res.json().catch(() => ({}))).campaigns);
  } catch (err) {
    console.error('[ADREPORTS] sb campaigns v4 failed:', err.message);
  }

  return out;
}

// Portfolio names for the stalled check's grouping. Tries the v3 list
// endpoint, then v2. Returns {} on any failure — the caller falls back to the
// product implied by the campaign name, which grouped identically across all
// 140 campaigns when this was checked against the April export.
async function fetchPortfolios(accessToken) {
  try {
    const res = await fetch('https://advertising-api.amazon.com/portfolios/list', {
      method: 'POST',
      headers: adsAuthHeaders(accessToken, {
        'Content-Type': 'application/vnd.portfolio.v3+json',
        'Accept': 'application/vnd.portfolio.v3+json'
      }),
      body: JSON.stringify({ maxResults: 100 })
    });
    if (res.ok) {
      const body = await res.json().catch(() => ({}));
      const list = body.portfolios || [];
      if (list.length) {
        return Object.fromEntries(list.map(p => [String(p.portfolioId), p.name]));
      }
    }
  } catch (err) {
    console.error('[ADREPORTS] portfolios v3 failed:', err.message);
  }
  try {
    const res = await fetch('https://advertising-api.amazon.com/v2/portfolios', {
      headers: adsAuthHeaders(accessToken)
    });
    if (res.ok) {
      const list = await res.json().catch(() => []);
      if (Array.isArray(list) && list.length) {
        return Object.fromEntries(list.map(p => [String(p.portfolioId), p.name]));
      }
    }
  } catch (err) {
    console.error('[ADREPORTS] portfolios v2 failed:', err.message);
  }
  return {};
}

async function loadMappings() {
  const [product, brand] = await Promise.all([
    kv.get('mappings:product'),
    kv.get('mappings:brand')
  ]);
  return { product: product || {}, brand: brand || {} };
}

// ─── ROW NORMALIZATION ───────────────────────────────────────────────────────
// Column names vary by report type and Amazon has revved them before, so each
// field reads the first present candidate rather than one hardcoded key.
// SP carries 7-day attribution and SB 14-day, matching what the console
// exports show and therefore what the numbers have always been read against.
function arfNormalizeRows(rawRows, adProduct) {
  if (!Array.isArray(rawRows)) return [];
  return rawRows.map(r => ({
    date:           String(arfPick(r, ['date', 'startDate']) || '').substring(0, 10),
    adProduct,
    campaignId:     String(arfPick(r, ['campaignId']) || ''),
    portfolioId:    String(arfPick(r, ['portfolioId']) || ''),
    campaignName:   String(arfPick(r, ['campaignName']) || ''),
    campaignStatus: String(arfPick(r, ['campaignStatus', 'status']) || ''),
    budgetAmount:   num(arfPick(r, ['campaignBudgetAmount', 'budgetAmount', 'budget'])),
    budgetType:     String(arfPick(r, ['campaignBudgetType', 'budgetType']) || ''),
    cost:           num(arfPick(r, ['cost', 'spend'])),
    clicks:         num(arfPick(r, ['clicks'])),
    impressions:    num(arfPick(r, ['impressions'])),
    orders:         num(arfPick(r, adProduct === 'SP'
                       ? ['purchases7d', 'orders7d', 'purchases']
                       : ['purchases', 'purchases14d', 'orders14d'])),
    sales:          num(arfPick(r, adProduct === 'SP'
                       ? ['sales7d', 'attributedSales7d', 'sales']
                       : ['sales', 'sales14d', 'attributedSales14d']))
  })).filter(r => r.date && (r.campaignId || r.campaignName));
}

function arfPick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

// ─── ADVERTISING API CLIENT ──────────────────────────────────────────────────

function missingAdsCredentials() {
  return ['ADV_CLIENT_ID', 'ADV_CLIENT_SECRET', 'ADV_REFRESH_TOKEN', 'ADV_PROFILE_ID']
    .filter(k => !process.env[k]);
}

function buildReportBody(product, start, end, columns) {
  return {
    name: `RedFlags ${product.toUpperCase()} ${start}..${end}`,
    startDate: start,
    endDate: end,
    configuration: {
      adProduct: product === 'sp' ? 'SPONSORED_PRODUCTS' : 'SPONSORED_BRANDS',
      groupBy: ['campaign'],
      columns,
      reportTypeId: product === 'sp' ? 'spCampaigns' : 'sbCampaigns',
      timeUnit: 'DAILY',
      format: 'GZIP_JSON'
    }
  };
}

// Tries each column set in turn. An invalid column 400s the whole request, so
// falling back to a narrower set keeps the run alive at reduced fidelity
// rather than failing outright — and reports which set landed, so the UI can
// say the capped check is unavailable when the budget columns were dropped.
async function requestCampaignReport(accessToken, spec) {
  const sets = COLUMN_SETS[spec.product];
  const rejections = [];
  let lastErr;
  for (let i = 0; i < sets.length; i++) {
    const columns = sets[i];
    try {
      const reportId = await withAdsRetry(
        () => requestReport(accessToken, buildReportBody(spec.product, spec.start, spec.end, columns))
      );
      return {
        reportId,
        columnSet: i,
        columns,
        hasBudgetColumns: columns.includes('campaignBudgetAmount'),
        degraded: i > 0,
        rejections
      };
    } catch (err) {
      lastErr = err;
      // 425 is "already running", not a bad column set — retrying with fewer
      // columns would just earn a second duplicate rejection.
      if (/\(425\)/.test(err.message)) {
        // Amazon sometimes names the in-flight report in the duplicate body.
        // Adopting that id recovers a run that would otherwise be orphaned —
        // generating at Amazon with nothing left able to poll it.
        const m = err.message.match(/"reportId"\s*:\s*"([^"]+)"/);
        if (m && REPORT_ID_RE.test(m[1])) {
          return {
            reportId: m[1],
            columnSet: i,
            columns,
            hasBudgetColumns: columns.includes('campaignBudgetAmount'),
            degraded: i > 0,
            adopted: true,
            rejections
          };
        }
        throw err;
      }
      if (!/\(4\d\d\)/.test(err.message)) throw err;
      console.error(`[ADREPORTS] ${spec.key} column set ${i} rejected:`, err.message);
      // Amazon names the offending column in the body. That message is the
      // entire answer to "why are there no budgets" — return it, don't bury it
      // in a server log.
      rejections.push({ setIndex: i, columns, error: String(err.message).slice(0, 600) });
      await sleep(300);
    }
  }
  throw lastErr;
}

// Retry on throttling and transient server errors only. Never on 425
// (duplicate — retrying guarantees another rejection) or on validation 4xx.
// adspend.js has no retry handling at all; this mirrors orders.js instead.
async function withAdsRetry(fn, attempts = 3) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = err?.message || '';
      const retryable = /\(429\)/.test(msg) || /\(5\d\d\)/.test(msg) ||
                        /throttl|too many|rate.?limit/i.test(msg);
      if (!retryable || attempt === attempts - 1) throw err;
      await sleep(2000 * Math.pow(2, attempt));
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

// UTC instant → 'YYYY-MM-DD' in America/Los_Angeles. Vercel runs UTC and Ads
// report dates are marketplace-local, so a UTC-naive window would sit a day
// ahead between 00:00 and 08:00 UTC.
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

// Exported for the offline red-flag test harness. Vercel only invokes the
// default export, so these are inert in production.
export { computeRedFlags, arfNormalizeRows, resolveWindow, brandFromPrefix, RF_CONFIG, MARGINS };
