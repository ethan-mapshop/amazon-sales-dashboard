import { kv } from '@vercel/kv';
import { gunzip } from 'zlib';
import { promisify } from 'util';

const gunzipAsync = promisify(gunzip);

// ─── ROUTER ──────────────────────────────────────────────────────────────────
// Weekly "Red Flag Monitor" cadence, ported from a manual spreadsheet workflow.
// Four fixed threshold checks over one formula — profit retention — run against
// the Amazon Advertising API v3 reporting endpoints.
//
//   GET ?action=weekly-request   — resolve the window, POST 4 report requests
//   GET ?action=weekly-status    — poll those report IDs
//   GET ?action=weekly-collect   — download, compute the checks, return flags
//   GET ?action=probe-columns    — fire 1-day throwaway reports to validate the
//                                  column sets against the live account
//
// All four are user-facing and auth-gated. Nothing here is cron-driven, so
// unlike adspend.js's sync-* actions none of them skip verifyGoogleToken.
//
// NO PERSISTENCE. Nothing is written to KV — the browser holds the report IDs
// across the async wait, and the only KV access is two reads of the existing
// campaign→brand mappings. Everything needed sits inside Amazon's report
// lookback, so there is no history to keep.
//
// Windows (Pacific — Vercel runs UTC and Ads report dates are marketplace-local):
//   week     = most recent COMPLETE Monday–Sunday
//   baseline = the 28 days immediately before that week (exclusive)
// The manual cadence pulled a closed Mon–Sun week two days after it closed;
// matching that also sidesteps attribution maturation, since a settled week
// isn't being compared against a fully-matured baseline.
//
// v3 caps a single report at a 31-day range, so the 35-day span needs two
// reports per ad product rather than one.
//
// KNOWN LIMITATION — the capped signal is a proxy. Amazon exposes historical
// "time in budget" only through the console Budget Report, not the API (the
// Budget Usage API is real-time only). So "capped" here means the campaign
// spent >= CAPPED_RATIO of its daily budget on >= CAPPED_DAYS_MIN days of the
// week. Amazon's estimated-missed-sales range is likewise console-only and is
// not reported. Do not "fix" this by reaching for a time-in-budget field.
//
// Env: ADV_CLIENT_ID, ADV_CLIENT_SECRET, ADV_REFRESH_TOKEN, ADV_PROFILE_ID

// ─── CONFIG ──────────────────────────────────────────────────────────────────
// Thresholds are fixed by the cadence spec and applied exactly — no adjusting
// for feel or context. Returned in every response so the UI can render the
// thresholds in effect and a run can be diffed against the spec without
// reading this file.
const CONFIG = {
  MIN_WEEKLY_SPEND:     5,      // campaigns under $5/wk are not evaluated at all
  RUNAWAY_MIN_SPEND:    50,     // floor so $15 → $35 doesn't trip check 2
  RUNAWAY_MULTIPLE:     2,      // 7-day spend > 2x trailing weekly average
  RETENTION_GOOD:       0.50,   // check 1 — worth feeding
  RETENTION_BAD:        0.25,   // check 2 — not worth defending
  STALLED_MIN_CLICKS:   10,     // check 3
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
    ['date', 'campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount', 'campaignBudgetType',
     'cost', 'clicks', 'impressions', 'purchases7d', 'sales7d'],
    ['date', 'campaignId', 'campaignName', 'campaignBudgetAmount', 'campaignBudgetType',
     'cost', 'clicks', 'impressions', 'purchases7d', 'sales7d'],
    ['date', 'campaignId', 'campaignName', 'cost', 'clicks', 'impressions', 'purchases7d', 'sales7d']
  ],
  sb: [
    ['date', 'campaignId', 'campaignName', 'campaignStatus', 'campaignBudgetAmount', 'campaignBudgetType',
     'cost', 'clicks', 'impressions', 'purchases', 'sales'],
    ['date', 'campaignId', 'campaignName', 'campaignBudgetAmount', 'campaignBudgetType',
     'cost', 'clicks', 'impressions', 'purchases', 'sales'],
    ['date', 'campaignId', 'campaignName', 'cost', 'clicks', 'impressions', 'purchases', 'sales'],
    ['date', 'campaignId', 'campaignName', 'cost', 'clicks', 'impressions']
  ]
};

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
    if (action === 'weekly-request') return handleWeeklyRequest(req, res);
    if (action === 'weekly-status')  return handleWeeklyStatus(req, res);
    if (action === 'weekly-collect') return handleWeeklyCollect(req, res);
    if (action === 'probe-columns')  return handleProbeColumns(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

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
      config: CONFIG,
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
        byKey[key] = normalizeRows(raw, key.startsWith('sp') ? 'SP' : 'SB');
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

    const mappings = await loadMappings();

    const result = computeRedFlags({
      weekRows:     [...(byKey.spWeek || []), ...(byKey.sbWeek || [])],
      baselineRows: [...(byKey.spBase || []), ...(byKey.sbBase || [])],
      window,
      mappings
    });

    return res.status(200).json({
      success: true,
      window,
      config: CONFIG,
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
function computeRedFlags({ weekRows, baselineRows, window, mappings }) {
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
        campaignStatus: r.campaignStatus || '',
        spend7: 0, clicks7: 0, impressions7: 0, orders7: 0, sales7: 0,
        spend28: 0, days28: new Set(),
        budgetByDate: new Map(), spendByDate: new Map(),
        budgetType: r.budgetType || ''
      };
      camps.set(key, c);
    }
    if (r.campaignName) c.campaignName = r.campaignName;
    if (r.campaignStatus) c.campaignStatus = r.campaignStatus;
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

  // Stage 3 — attribution.
  const mappingConflicts = [];
  for (const c of camps.values()) {
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

  // Stage 6 — per-campaign metrics.
  for (const c of camps.values()) {
    // ACoS is NULL, never 0, when there are no sales. The naive
    // `sales ? cost/sales : 0` makes retention compute to 1.0 and a dead
    // campaign look perfect — that bug shipped in the manual version.
    c.acos = c.sales7 > 0 ? c.spend7 / c.sales7 : null;
    c.retention = (c.acos === null || !(c.grossMargin > 0))
      ? null
      : r4((c.grossMargin - c.acos) / c.grossMargin);

    c.budgetDays = c.budgetByDate.size;
    c.dailyBudget = c.budgetDays ? Math.max(...c.budgetByDate.values()) : null;
    c.budgetTotal = 0;
    for (const v of c.budgetByDate.values()) c.budgetTotal += v;
    c.lifetimeBudget = !!c.budgetType && String(c.budgetType).toUpperCase() !== 'DAILY';
    c.cappedEvaluable = c.budgetDays > 0 && !c.lifetimeBudget;

    // Count of days the campaign actually ran out of budget. A weekly
    // spend-to-budget ratio would miss the campaign that maxes out Mon–Wed
    // and goes quiet — which is exactly the one this check exists to find.
    c.cappedDays = 0;
    if (c.cappedEvaluable) {
      for (const [date, budget] of c.budgetByDate) {
        if (budget > 0 && (c.spendByDate.get(date) || 0) >= CONFIG.CAPPED_RATIO * budget) c.cappedDays++;
      }
    }
    c.weeklyCapRatio = c.budgetTotal > 0 ? r4(c.spend7 / c.budgetTotal) : null;
    c.capped = c.cappedEvaluable && c.cappedDays >= CONFIG.CAPPED_DAYS_MIN;

    c.baselineWeekly = c.spend28 / 4;
    c.baselineUsable = c.days28.size >= CONFIG.BASELINE_MIN_DAYS;
    c.spendMultiple = (c.baselineUsable && c.baselineWeekly > 0)
      ? r4(c.spend7 / c.baselineWeekly) : null;
  }

  // Stage 5 + 7 — eligibility, then the checks in spec order.
  const flags = { budgetCap: [], runaway: [], stalled: [], brandPacing: [] };
  const coverage = {
    campaignsSeen: camps.size, evaluated: 0,
    totalSpend7: 0, evaluatedSpend7: 0,
    excludedUnderMin: [], unmapped: [], notEvaluable: [], cappedNoSales: [],
    cappedLowRetention: [], newNoBaseline: [], mappingConflicts
  };

  for (const c of camps.values()) {
    coverage.totalSpend7 += c.spend7;

    if (c.spend7 < CONFIG.MIN_WEEKLY_SPEND) {
      // Spec: campaigns under $5/week carry too little signal to interpret.
      if (c.spend7 > 0) coverage.excludedUnderMin.push(row(c));
      continue;
    }
    coverage.evaluated++;
    coverage.evaluatedSpend7 += c.spend7;

    if (!c.brand) coverage.unmapped.push(row(c));
    if (c.lifetimeBudget) coverage.notEvaluable.push({ ...row(c), reason: 'lifetime-budget' });
    else if (!c.budgetDays) coverage.notEvaluable.push({ ...row(c), reason: 'no-budget-data' });
    if (!c.baselineUsable) coverage.newNoBaseline.push(row(c));

    // 1 — Budget cap emergency. retention === null CANNOT satisfy this; a
    // capped campaign with no sales is the opposite of an opportunity, so it
    // goes to cappedNoSales instead of being flagged as one to feed.
    if (c.capped && c.retention !== null && c.retention >= CONFIG.RETENTION_GOOD) {
      flags.budgetCap.push(row(c));
    } else if (c.capped && c.retention === null) {
      coverage.cappedNoSales.push(row(c));
    } else if (c.capped) {
      // Capped, but retention is below the bar. Not flagged — pushing budget
      // at a campaign that can't convert it into profit is the mistake check 1
      // exists to avoid. Surfaced anyway so "Amazon says this is capped, why
      // isn't it here?" has a visible answer.
      coverage.cappedLowRetention.push(row(c));
    }

    // 2 — Runaway spender. Here retention === null DOES satisfy "< 25%":
    // zero sales is retention below any threshold, and excluding the worst
    // case would gut the check. The asymmetry with check 1 is deliberate —
    // do not "fix" it into consistency.
    if (c.spend7 > CONFIG.RUNAWAY_MIN_SPEND &&
        c.baselineUsable && c.baselineWeekly > 0 &&
        c.spend7 > CONFIG.RUNAWAY_MULTIPLE * c.baselineWeekly &&
        (c.retention === null || c.retention < CONFIG.RETENTION_BAD)) {
      flags.runaway.push(row(c));
    }

    // 3 — Stalled. Needs no margin, so unmapped campaigns are still
    // evaluated. Gates on orders, not sales.
    if (c.clicks7 >= CONFIG.STALLED_MIN_CLICKS && c.orders7 === 0) {
      flags.stalled.push(row(c));
    }
  }

  // 4 — Brand pacing.
  for (const b of brands.values()) {
    const baselineWeekly = b.spend28 / 4;
    const usable = b.days28.size >= CONFIG.BASELINE_MIN_DAYS &&
                   baselineWeekly >= CONFIG.BRAND_BASELINE_FLOOR;
    if (!usable) continue;
    const deviation = r4((b.spend7 - baselineWeekly) / baselineWeekly);
    if (Math.abs(deviation) > CONFIG.PACING_DEVIATION) {
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
function row(c) {
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
function normalizeRows(rawRows, adProduct) {
  if (!Array.isArray(rawRows)) return [];
  return rawRows.map(r => ({
    date:           String(pick(r, ['date', 'startDate']) || '').substring(0, 10),
    adProduct,
    campaignId:     String(pick(r, ['campaignId']) || ''),
    campaignName:   String(pick(r, ['campaignName']) || ''),
    campaignStatus: String(pick(r, ['campaignStatus', 'status']) || ''),
    budgetAmount:   num(pick(r, ['campaignBudgetAmount', 'budgetAmount', 'budget'])),
    budgetType:     String(pick(r, ['campaignBudgetType', 'budgetType']) || ''),
    cost:           num(pick(r, ['cost', 'spend'])),
    clicks:         num(pick(r, ['clicks'])),
    impressions:    num(pick(r, ['impressions'])),
    orders:         num(pick(r, adProduct === 'SP'
                       ? ['purchases7d', 'orders7d', 'purchases']
                       : ['purchases', 'purchases14d', 'orders14d'])),
    sales:          num(pick(r, adProduct === 'SP'
                       ? ['sales7d', 'attributedSales7d', 'sales']
                       : ['sales', 'sales14d', 'attributedSales14d']))
  })).filter(r => r.date && (r.campaignId || r.campaignName));
}

function pick(obj, keys) {
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
        hasBudgetColumns: columns.includes('campaignBudgetAmount'),
        degraded: i > 0
      };
    } catch (err) {
      lastErr = err;
      // 425 is "already running", not a bad column set — retrying with fewer
      // columns would just earn a second duplicate rejection.
      if (/\(425\)/.test(err.message)) throw err;
      if (!/\(4\d\d\)/.test(err.message)) throw err;
      console.error(`[ADREPORTS] ${spec.key} column set ${i} rejected:`, err.message);
      await sleep(300);
    }
  }
  throw lastErr;
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
  // The download URL is pre-signed — no auth headers. It is also short-lived,
  // which is why the client caches the computed result rather than the IDs.
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const text = (await gunzipAsync(buffer)).toString('utf-8');
  // V3 reports return a JSON array. Some tenants return NDJSON; handle either.
  try {
    return JSON.parse(text);
  } catch {
    return text.split('\n').map(l => l.trim()).filter(Boolean).map(l => JSON.parse(l));
  }
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

async function verifyGoogleToken(req) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return { ok: false, error: 'No access token provided' };
  const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verify.ok) return { ok: false, error: 'Invalid access token' };
  return { ok: true };
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

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// Derived ratios are rounded before comparison — otherwise a deviation that
// should be exactly 0.30 lands at 0.30000000000000004 and trips a ">30%" rule.
function r4(n) { return Math.round(n * 10000) / 10000; }
function r2(n) { return Math.round(n * 100) / 100; }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Exported for the offline test harness (scripts are not part of the deploy).
export { computeRedFlags, normalizeRows, resolveWindow, brandFromPrefix, CONFIG, MARGINS };
