import { kv } from '@vercel/kv';

// ─── ROUTER ──────────────────────────────────────────────────────────────────
// Campaign Overview — Amazon ad campaign and portfolio CONFIGURATION.
//
//   GET ?action=get      — read the stored snapshot (never calls Amazon)
//   GET ?action=refresh  — fetch from Amazon, diff, store. ?dry=1 computes
//                          everything and returns it WITHOUT writing.
//   GET ?action=probe    — raw, unmapped Amazon responses for every endpoint
//
// All three are auth-gated. Nothing here is cron-driven yet.
//
// WHY THIS FILE EXISTS. The red-flag capped check asked the v3 *reporting* API
// for campaignBudgetAmount and got nothing back, three fixes running. A daily
// budget is campaign CONFIGURATION, not a performance metric — it lives on the
// campaign management endpoints, which are synchronous and return in ~300ms
// rather than the 1–5 minutes a report takes.
//
// The previous attempt (fetchCampaignBudgets in adspend.js) failed silently:
// every call was `if (res.ok) take(...)` with no else branch, so a 400/401/429
// logged nothing and returned {}. Downstream that read as "these campaigns have
// no budgets". Everything here is built to make the opposite mistake — to be
// loud about what it did not get:
//
//   * acAdsList is the ONLY place an Amazon list call happens. Non-2xx returns
//     { ok:false, status, bodyText }; it never swallows.
//   * Every mapped field records WHICH key produced it (acFieldCoverage), so
//     "resolved 3 of 142 via budget.amount" is visible on the first run.
//   * A count drop over 20% aborts the write instead of overwriting the
//     snapshot with a truncated page.
//
// KV layout:
//   adcampaigns:current     → { syncedAt, ptDate, rows: [campaign] }
//   adcampaigns:portfolios  → { syncedAt, rows: [portfolio] }
//   adcampaigns:changes     → { rows: [change] }   capped 200, human-facing
//   adcampaigns:meta        → { lastSyncAt, lastSyncOk, counts, sources,
//                               pages, coverage, warnings, lastError }
//
// Campaigns are keyed by campaignId, never by name — a rename is a diff, not a
// new campaign. (Campaign Mapping keys by name, which is why a rename silently
// orphans a mapping over there. This page does not have that failure mode.)
//
// Env: ADV_CLIENT_ID, ADV_CLIENT_SECRET, ADV_REFRESH_TOKEN, ADV_PROFILE_ID

const ADS_HOST = 'https://advertising-api.amazon.com';

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const AC_CONFIG = {
  PAGE_SIZE: 100,        // conservative; pagination covers the rest
  MAX_PAGES: 20,
  CHANGES_CAP: 200,
  COUNT_DROP_ABORT: 0.8  // abort the write below 80% of the previous count
};

// Fields compared between snapshots. Short, explicit, all scalars — no
// deep-equal helper needed or wanted.
const AC_TRACKED_FIELDS = [
  'name', 'state', 'dailyBudget', 'budgetType', 'targetingType',
  'biddingStrategy', 'portfolioId', 'startDate', 'endDate'
];

const AC_PORTFOLIO_TRACKED = ['name', 'state', 'budgetAmount', 'budgetPolicy', 'budgetEnd'];

// Candidate key paths per field, tried in order. Dotted paths walk nested
// objects. Which one actually hit is recorded and reported — that is the whole
// point, so a wrong guess shows up as a coverage number rather than an empty
// column nobody can explain.
const AC_CAMPAIGN_KEYS = {
  campaignId:      ['campaignId'],
  name:            ['name', 'campaignName'],
  state:           ['state', 'campaignStatus'],
  dailyBudget:     ['budget.budget', 'budget.amount', 'dailyBudget', 'budget'],
  budgetType:      ['budget.budgetType', 'budgetType'],
  targetingType:   ['targetingType'],
  biddingStrategy: ['dynamicBidding.strategy', 'bidding.strategy', 'biddingStrategy'],
  portfolioId:     ['portfolioId'],
  startDate:       ['startDate'],
  endDate:         ['endDate']
};

const AC_PORTFOLIO_KEYS = {
  portfolioId:  ['portfolioId'],
  name:         ['name'],
  state:        ['state'],
  budgetAmount: ['budget.amount', 'budget.budget', 'budgetAmount'],
  budgetPolicy: ['budget.policy', 'budgetPolicy', 'policy'],
  budgetStart:  ['budget.startDate', 'budgetStart'],
  budgetEnd:    ['budget.endDate', 'budgetEnd'],
  inBudget:     ['inBudget']
};

// Coverage is a wrong-key detector, not an absence detector. Without these
// rules it reports legitimately-empty fields as failures and buries the one
// case it exists to catch.
//
//   optional      - absent is normal (an open-ended campaign has no end date)
//   informational - absence is a fact about the account, not a mapping error
//   appliesTo     - the field only exists for that ad product, so measuring it
//                   against the whole account understates it by design
const AC_FIELD_RULES = {
  endDate:         { optional: true },
  portfolioId:     { informational: true },
  targetingType:   { appliesTo: 'SP' },
  biddingStrategy: { appliesTo: 'SP' }
};

const AC_PORTFOLIO_RULES = {
  budgetAmount: { informational: true },
  budgetPolicy: { informational: true },
  budgetStart:  { optional: true },
  budgetEnd:    { optional: true },
  inBudget:     { optional: true }
};

// Brand prefixes, longest first. MUST stay in step with PRODUCT_BRAND_SHORT in
// js/core.js — these strings are how this data would ever join to anything else
// in the dashboard. This is the third copy of this table in the repo (the
// others are in adspend.js and js/core.js); the house convention is duplication
// over a shared lib, so it needs checking when brands change.
const AC_BRAND_PREFIXES = [
  { prefix: 'MAP PACKS', brand: 'BrightWay Educational' },
  { prefix: 'BW PACK',   brand: 'BrightWay Educational' },
  { prefix: 'BW SET',    brand: 'BrightWay Educational' },
  { prefix: 'BW',        brand: 'BrightWay Educational' },
  { prefix: 'SOK',       brand: 'South of Kings' },
  { prefix: 'RR',        brand: 'Hubbard Scientific' },
  { prefix: 'STATE',     brand: 'MapShop State Maps' }
].sort((a, b) => b.prefix.length - a.prefix.length);

// ─── ENDPOINT SPECS ──────────────────────────────────────────────────────────
// v3 first, v2 as fallback. Both are probed so the fallback is not the untested
// branch discovered during an outage.

const AC_ENDPOINTS = {
  spV3: {
    label: 'sp-campaigns-v3', adProduct: 'SP', version: 'v3',
    url: `${ADS_HOST}/sp/campaigns/list`, method: 'POST',
    contentType: 'application/vnd.spCampaign.v3+json',
    accept: 'application/vnd.spCampaign.v3+json',
    listField: 'campaigns', paging: 'token'
  },
  spV2: {
    label: 'sp-campaigns-v2', adProduct: 'SP', version: 'v2',
    url: `${ADS_HOST}/v2/sp/campaigns`, method: 'GET',
    listField: null, paging: 'index'
  },
  sbV4: {
    label: 'sb-campaigns-v4', adProduct: 'SB', version: 'v4',
    url: `${ADS_HOST}/sb/v4/campaigns/list`, method: 'POST',
    contentType: 'application/vnd.sbcampaignresource.v4+json',
    accept: 'application/vnd.sbcampaignresource.v4+json',
    listField: 'campaigns', paging: 'token'
  },
  pfV3: {
    label: 'portfolios-v3', version: 'v3',
    url: `${ADS_HOST}/portfolios/list`, method: 'POST',
    contentType: 'application/vnd.portfolio.v3+json',
    accept: 'application/vnd.portfolio.v3+json',
    listField: 'portfolios', paging: 'token'
  },
  pfV2: {
    label: 'portfolios-v2', version: 'v2',
    url: `${ADS_HOST}/v2/portfolios`, method: 'GET',
    listField: null, paging: 'none'
  }
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
    if (action === 'get')     return handleGet(req, res);
    if (action === 'refresh') return handleRefresh(req, res);
    if (action === 'probe')   return handleProbe(req, res);
  }

  return res.status(405).json({ error: 'Method not allowed' });
}

// ─── GET ─────────────────────────────────────────────────────────────────────
// Pure KV read. The page calls this on every load and it never touches Amazon.
async function handleGet(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const [current, portfolios, changes, meta] = await Promise.all([
      kv.get('adcampaigns:current'),
      kv.get('adcampaigns:portfolios'),
      kv.get('adcampaigns:changes'),
      kv.get('adcampaigns:meta')
    ]);

    return res.status(200).json({
      success: true,
      syncedAt:   current?.syncedAt || null,
      campaigns:  current?.rows || [],
      portfolios: portfolios?.rows || [],
      changes:    changes?.rows || [],
      meta:       meta || null
    });
  } catch (error) {
    console.error('[ADCAMPAIGNS GET] Error:', error);
    return res.status(500).json({ error: 'Get failed: ' + error.message });
  }
}

// ─── REFRESH ─────────────────────────────────────────────────────────────────
async function handleRefresh(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const missing = missingAdsCredentials();
    if (missing.length) {
      return res.status(500).json({ error: `Missing Advertising API credentials: ${missing.join(', ')}` });
    }

    const result = await acRunSync({
      dry: req.query.dry === '1',
      force: req.query.force === '1'
    });
    return res.status(200).json(result);
  } catch (error) {
    console.error('[ADCAMPAIGNS REFRESH] Error:', error);
    return res.status(500).json({ error: 'Refresh failed: ' + error.message });
  }
}

// ─── PROBE ───────────────────────────────────────────────────────────────────
// Raw, unmapped, un-guessed. Every field name in this file was assumed until
// this action answered — read its output before trusting a mapped column.
async function handleProbe(req, res) {
  try {
    const auth = await verifyGoogleToken(req);
    if (!auth.ok) return res.status(401).json({ error: auth.error });

    const missing = missingAdsCredentials();
    if (missing.length) {
      return res.status(500).json({ error: `Missing Advertising API credentials: ${missing.join(', ')}` });
    }

    const accessToken = await getAdsAccessToken();
    const results = [];

    for (const spec of [AC_ENDPOINTS.spV3, AC_ENDPOINTS.spV2, AC_ENDPOINTS.sbV4,
                        AC_ENDPOINTS.pfV3, AC_ENDPOINTS.pfV2]) {
      const out = await acAdsList(accessToken, spec, { probeOnly: true });
      const items = out.items || [];
      const keyUnion = new Set();
      for (const it of items.slice(0, 50)) {
        for (const k of Object.keys(it || {})) keyUnion.add(k);
      }
      results.push({
        endpoint: spec.label,
        requestUrl: spec.url,
        requestMethod: spec.method,
        ok: out.ok,
        status: out.status,
        itemCount: items.length,
        nextTokenPresent: !!out.nextTokenPresent,
        keyUnion: [...keyUnion].sort(),
        stateBreakdown: acTally(items.map(i => i && (i.state || i.campaignStatus))),
        sample: items.slice(0, 3),
        responseBodyHead: out.bodyText ? String(out.bodyText).slice(0, 2000) : null
      });
      await sleep(200);
    }

    return res.status(200).json({ success: true, probedAt: new Date().toISOString(), results });
  } catch (error) {
    console.error('[ADCAMPAIGNS PROBE] Error:', error);
    return res.status(500).json({ error: 'Probe failed: ' + error.message });
  }
}

// ─── SYNC CORE ───────────────────────────────────────────────────────────────
// Build the whole snapshot in memory, validate it, THEN write. A timeout
// mid-build costs nothing; a timeout mid-write would leave a corrupt source of
// truth.
async function acRunSync({ dry = false, force = false } = {}) {
  const startedAt = Date.now();
  const accessToken = await getAdsAccessToken();
  const warnings = [];
  const errors = [];

  const [sp, sb, pf] = [
    await acFetchWithFallback(accessToken, AC_ENDPOINTS.spV3, AC_ENDPOINTS.spV2, warnings, errors),
    await acFetchWithFallback(accessToken, AC_ENDPOINTS.sbV4, null, warnings, errors),
    await acFetchWithFallback(accessToken, AC_ENDPOINTS.pfV3, AC_ENDPOINTS.pfV2, warnings, errors)
  ];

  // Map, recording which key produced each field.
  const hits = {};
  const campaigns = [
    ...sp.items.map(r => acMapCampaign(r, 'SP', hits)),
    ...sb.items.map(r => acMapCampaign(r, 'SB', hits))
  ].filter(c => c.campaignId);

  const pfHits = {};
  const portfolios = pf.items.map(r => acMapPortfolio(r, pfHits)).filter(p => p.portfolioId);

  const coverage = {
    campaigns:  acFieldCoverage(campaigns, AC_CAMPAIGN_KEYS, hits),
    portfolios: acFieldCoverage(portfolios, AC_PORTFOLIO_KEYS, pfHits, AC_PORTFOLIO_RULES)
  };

  for (const [field, c] of Object.entries(coverage.campaigns.fields)) {
    if (acCoverageLooksWrong(c)) {
      const keys = Object.keys(c.viaKey || {}).length;
      warnings.push(`campaigns.${field}: resolved ${c.resolved} of ${c.applicable} enabled` +
                    (keys > 1 ? ` via ${keys} different keys` : ''));
    }
  }

  const [prevCurrent, prevPortfolios, prevChanges] = await Promise.all([
    kv.get('adcampaigns:current'),
    kv.get('adcampaigns:portfolios'),
    kv.get('adcampaigns:changes')
  ]);
  const prevRows = prevCurrent?.rows || [];
  const isBaseline = prevRows.length === 0;

  // A truncated page must never overwrite the snapshot. Without this, one bad
  // fetch silently redefines what "the account" is.
  const aborted = !force && prevRows.length > 0 &&
                  campaigns.length < prevRows.length * AC_CONFIG.COUNT_DROP_ABORT;

  const now = new Date().toISOString();
  const ptDate = _ptDate(new Date());

  const merged = acMergePresence(prevRows, campaigns, now);
  const mergedPortfolios = acMergePresence(prevPortfolios?.rows || [], portfolios, now, 'portfolioId');

  // First run emits no per-field records. Diffing 142 new campaigns field by
  // field would write ~1,100 entries and evict the entire capped log on run one.
  const changeRecords = isBaseline
    ? []
    : acDiffSnapshot(prevRows, merged, ptDate, now);

  const result = {
    success: !aborted,
    aborted,
    dry,
    baseline: isBaseline,
    syncedAt: now,
    ptDate,
    counts: {
      sp: campaigns.filter(c => c.adProduct === 'SP').length,
      sb: campaigns.filter(c => c.adProduct === 'SB').length,
      portfolios: portfolios.length,
      previous: prevRows.length,
      states: acTally(campaigns.map(c => c.state))
    },
    sources: { sp: sp.source, sb: sb.source, portfolios: pf.source },
    pages:   { sp: sp.pages, sb: sb.pages, portfolios: pf.pages },
    coverage,
    warnings,
    errors,
    changes: changeRecords,
    durationMs: Date.now() - startedAt
  };

  if (aborted) {
    result.error = `Campaign count dropped ${prevRows.length} → ${campaigns.length}; ` +
                   `refusing to overwrite. Re-run with force=1 if this is real.`;
    await kv.set('adcampaigns:meta', {
      lastSyncAt: now, lastSyncOk: false, lastError: result.error,
      counts: result.counts, sources: result.sources, pages: result.pages,
      coverage, warnings
    });
    return result;
  }

  if (dry) {
    result.wouldWrite = { campaigns: merged.length, portfolios: mergedPortfolios.length,
                          changes: changeRecords.length };
    return result;
  }

  const changesOut = acAppendChanges(prevChanges?.rows || [], changeRecords);

  await Promise.all([
    kv.set('adcampaigns:current',    { syncedAt: now, ptDate, rows: merged }),
    kv.set('adcampaigns:portfolios', { syncedAt: now, rows: mergedPortfolios }),
    kv.set('adcampaigns:changes',    { rows: changesOut }),
    kv.set('adcampaigns:meta', {
      lastSyncAt: now, lastSyncOk: true, lastSyncDurationMs: result.durationMs,
      counts: result.counts, sources: result.sources, pages: result.pages,
      coverage, warnings, lastError: null
    })
  ]);

  return result;
}

// v3 first; fall back to v2 only when v3 genuinely failed or returned nothing.
// The previous implementation fell back only on TOTAL failure, so a truncated
// page counted as success forever.
async function acFetchWithFallback(accessToken, primary, fallback, warnings, errors) {
  const first = await acAdsList(accessToken, primary);
  if (first.ok && first.items.length) {
    if (first.truncated) warnings.push(`${primary.label}: hit the page cap, results may be incomplete`);
    return { items: first.items, source: primary.version, pages: first.pages, truncated: first.truncated };
  }

  if (!first.ok) {
    errors.push({ endpoint: primary.label, status: first.status, body: String(first.bodyText || '').slice(0, 400) });
  } else {
    warnings.push(`${primary.label}: returned 0 items`);
  }

  if (!fallback) return { items: first.items || [], source: primary.version, pages: first.pages, truncated: false };

  const second = await acAdsList(accessToken, fallback);
  if (!second.ok) {
    errors.push({ endpoint: fallback.label, status: second.status, body: String(second.bodyText || '').slice(0, 400) });
    return { items: [], source: null, pages: 0, truncated: false };
  }
  warnings.push(`${primary.label} unusable; fell back to ${fallback.label}`);
  return { items: second.items, source: fallback.version, pages: second.pages, truncated: second.truncated };
}

// ─── THE ONE PLACE AMAZON LIST CALLS HAPPEN ──────────────────────────────────
// Non-2xx returns { ok:false, status, bodyText } — it never swallows, and it
// never converts an HTTP failure into an empty result set. That conversion is
// exactly what made the previous three attempts undiagnosable.
async function acAdsList(accessToken, spec, { probeOnly = false } = {}) {
  const items = [];
  let pages = 0;
  let nextToken = null;
  let truncated = false;
  let nextTokenPresent = false;
  const maxPages = probeOnly ? 1 : AC_CONFIG.MAX_PAGES;

  try {
    do {
      const { url, init } = acBuildRequest(accessToken, spec, nextToken, items.length);
      const res = await withAdsRetry(() => fetch(url, init));
      const text = await res.text();

      if (!res.ok) {
        return { ok: false, status: res.status, bodyText: text, items, pages };
      }

      let body;
      try { body = text ? JSON.parse(text) : {}; }
      catch { return { ok: false, status: res.status, bodyText: 'non-JSON body: ' + text.slice(0, 400), items, pages }; }

      const page = spec.listField ? (body[spec.listField] || []) : (Array.isArray(body) ? body : []);
      items.push(...page);
      pages++;

      nextToken = spec.paging === 'token' ? (body.nextToken || null) : null;
      if (nextToken) nextTokenPresent = true;

      if (spec.paging === 'index') {
        // v2 pages by startIndex/count — stop on a short page.
        nextToken = page.length === AC_CONFIG.PAGE_SIZE ? 'more' : null;
      }
      if (spec.paging === 'none') nextToken = null;

      if (pages >= maxPages && nextToken) { truncated = true; break; }
    } while (nextToken && !probeOnly);

    return { ok: true, status: 200, items, pages, truncated, nextTokenPresent, bodyText: null };
  } catch (err) {
    return { ok: false, status: 0, bodyText: 'fetch threw: ' + err.message, items, pages };
  }
}

function acBuildRequest(accessToken, spec, nextToken, offset) {
  const headers = adsAuthHeaders(accessToken, {});
  if (spec.accept) headers['Accept'] = spec.accept;

  if (spec.method === 'POST') {
    headers['Content-Type'] = spec.contentType;
    const body = { maxResults: AC_CONFIG.PAGE_SIZE };
    if (nextToken && nextToken !== 'more') body.nextToken = nextToken;
    return { url: spec.url, init: { method: 'POST', headers, body: JSON.stringify(body) } };
  }

  let url = spec.url;
  if (spec.paging === 'index') {
    // stateFilter is explicit: without it some accounts omit PAUSED/ARCHIVED,
    // and a campaign missing from a response is indistinguishable from one
    // that was deleted.
    url += `?stateFilter=enabled,paused,archived&count=${AC_CONFIG.PAGE_SIZE}&startIndex=${offset}`;
  }
  return { url, init: { method: 'GET', headers } };
}

// ─── MAPPING ─────────────────────────────────────────────────────────────────

function acMapCampaign(raw, adProduct, hits) {
  // State is read first because it decides which bucket the key-hits land in.
  // Coverage counts enabled campaigns only, so the viaKey tally has to be
  // measured over that same population or the two numbers disagree.
  const stateHits = {};
  const state = acStr(acPick(raw, AC_CAMPAIGN_KEYS.state, stateHits, 'state')).toUpperCase() || null;
  const bucket = state === 'ENABLED' ? 'enabled' : 'other';
  const scope = hits[bucket] = hits[bucket] || {};
  acMergeHits(scope, stateHits);

  const name = acStr(acPick(raw, AC_CAMPAIGN_KEYS.name, scope, 'name'));
  // Read once and reused. Picking it twice - once here, once for the field -
  // double-counted every hit and made the tally disagree with the resolved
  // count, which is the fastest way to make a diagnostic untrustworthy.
  const targeting = acStr(acPick(raw, AC_CAMPAIGN_KEYS.targetingType, scope, 'targetingType'));
  const type = acCampaignType(name, targeting);

  return {
    campaignId:      acStr(acPick(raw, AC_CAMPAIGN_KEYS.campaignId, scope, 'campaignId')),
    adProduct,
    name,
    state,
    // null means UNKNOWN, never 0 — a zero budget is a real and different fact.
    dailyBudget:     acNum(acPick(raw, AC_CAMPAIGN_KEYS.dailyBudget, scope, 'dailyBudget')),
    budgetType:      acStr(acPick(raw, AC_CAMPAIGN_KEYS.budgetType, scope, 'budgetType')) || null,
    targetingType:   targeting || null,
    biddingStrategy: acStr(acPick(raw, AC_CAMPAIGN_KEYS.biddingStrategy, scope, 'biddingStrategy')) || null,
    portfolioId:     acStr(acPick(raw, AC_CAMPAIGN_KEYS.portfolioId, scope, 'portfolioId')) || null,
    startDate:       acDate(acPick(raw, AC_CAMPAIGN_KEYS.startDate, scope, 'startDate')),
    endDate:         acDate(acPick(raw, AC_CAMPAIGN_KEYS.endDate, scope, 'endDate')),
    brand:           acBrandFromPrefix(name),
    brandSource:     acBrandFromPrefix(name) ? 'prefix' : 'none',
    campaignType:    type.type,
    typeSource:      type.source
  };
}

function acMapPortfolio(raw, hits) {
  const stateHits = {};
  const state = acStr(acPick(raw, AC_PORTFOLIO_KEYS.state, stateHits, 'state'));
  const bucket = (String(state).toUpperCase() === 'ENABLED' || state === '') ? 'enabled' : 'other';
  const scope = hits[bucket] = hits[bucket] || {};
  acMergeHits(scope, stateHits);
  return {
    portfolioId:  acStr(acPick(raw, AC_PORTFOLIO_KEYS.portfolioId, scope, 'portfolioId')),
    name:         acStr(acPick(raw, AC_PORTFOLIO_KEYS.name, scope, 'name')),
    state:        state || null,
    budgetAmount: acNum(acPick(raw, AC_PORTFOLIO_KEYS.budgetAmount, scope, 'budgetAmount')),
    // Policy is load-bearing: a portfolio budget is a PERIOD TOTAL, not a daily
    // cap. Dropping it invites comparing it against a sum of daily budgets,
    // which are different units.
    budgetPolicy: acStr(acPick(raw, AC_PORTFOLIO_KEYS.budgetPolicy, scope, 'budgetPolicy')) || null,
    budgetStart:  acDate(acPick(raw, AC_PORTFOLIO_KEYS.budgetStart, scope, 'budgetStart')),
    budgetEnd:    acDate(acPick(raw, AC_PORTFOLIO_KEYS.budgetEnd, scope, 'budgetEnd')),
    inBudget:     acPick(raw, AC_PORTFOLIO_KEYS.inBudget, scope, 'inBudget') ?? null
  };
}

// Type comes from the name suffix, cross-checked against the API's own
// targetingType. A campaign named "(Auto)" reporting MANUAL is a real finding,
// not something to silently resolve in either direction.
function acCampaignType(name, targetingType) {
  const m = String(name || '').match(/\(([^)]+)\)\s*$/);
  const fromName = m ? m[1].trim() : '';
  const norm = fromName.toLowerCase();
  // Explicit labels rather than title-casing — ASIN is an acronym and
  // "Asin" would look like a typo everywhere it rendered.
  const TYPE_LABELS = {
    auto: 'Auto', broad: 'Broad', exact: 'Exact', phrase: 'Phrase',
    asin: 'ASIN', 'product targeting': 'ASIN', pt: 'ASIN'
  };
  const named = TYPE_LABELS[norm] || null;

  const tt = String(targetingType || '').toUpperCase();
  if (!named) return { type: tt ? (tt === 'AUTO' ? 'Auto' : 'Manual') : null, source: tt ? 'targeting' : 'none' };
  if (tt === 'AUTO' && named !== 'Auto') return { type: named, source: 'conflict' };
  if (tt === 'MANUAL' && named === 'Auto') return { type: named, source: 'conflict' };
  return { type: named, source: 'name' };
}

function acBrandFromPrefix(name) {
  const up = String(name || '').trim().toUpperCase();
  for (const e of AC_BRAND_PREFIXES) {
    if (!up.startsWith(e.prefix)) continue;
    const next = up.charAt(e.prefix.length);
    if (next === '' || !/[A-Z0-9]/.test(next)) return e.brand;
  }
  return null;
}

// ─── COVERAGE ────────────────────────────────────────────────────────────────
// "resolved 3 of 142 via budget.amount" on run one beats discovering a week
// later that a check has quietly been evaluating nothing.
function acFieldCoverage(rows, keySpec, hits, rules) {
  const ruleSet = rules || AC_FIELD_RULES;
  // Enabled only. A paused campaign with no portfolio is not a finding, and a
  // wrong key would fail across every state anyway - so enabled is a valid
  // sample and a far quieter one.
  const enabled = rows.filter(r => !r.state || String(r.state).toUpperCase() === 'ENABLED');
  const enabledHits = (hits && hits.enabled) || {};

  const fields = {};
  for (const field of Object.keys(keySpec)) {
    const rule = ruleSet[field] || {};
    const applicableRows = rule.appliesTo
      ? enabled.filter(r => r.adProduct === rule.appliesTo)
      : enabled;
    const resolved = applicableRows.filter(
      r => r[field] !== null && r[field] !== undefined && r[field] !== ''
    ).length;
    fields[field] = {
      resolved,
      applicable: applicableRows.length,
      viaKey: enabledHits[field] || {},
      optional: !!rule.optional,
      informational: !!rule.informational,
      appliesTo: rule.appliesTo || null
    };
    // Stamped here rather than recomputed in the browser, so there is one
    // definition of "this looks like a wrong key" instead of two.
    fields[field].looksWrong = acCoverageLooksWrong(fields[field]);
  }

  return { scope: { basis: 'enabled', counted: enabled.length, of: rows.length }, fields };
}

// A wrong key looks like: a required field missing on a tenth or more of the
// campaigns it applies to, or one field resolving through several different
// keys - which means the shape varies between campaigns and at least one of
// the guesses is wrong.
function acCoverageLooksWrong(c) {
  if (c.optional || c.informational) return false;
  if (Object.keys(c.viaKey || {}).length > 1) return true;
  return c.applicable > 0 && c.resolved < c.applicable * 0.9;
}

function acMergeHits(target, source) {
  for (const [field, byKey] of Object.entries(source || {})) {
    target[field] = target[field] || {};
    for (const [k, n] of Object.entries(byKey)) target[field][k] = (target[field][k] || 0) + n;
  }
}

// ─── PRESENCE ────────────────────────────────────────────────────────────────
// Absence from a response is never evidence of deletion. Amazon archives rather
// than deletes; a missing row far more often means a state filter that wasn't
// set, a page that wasn't fetched, or a 429 that got swallowed.
function acMergePresence(prevRows, nextRows, now, idField = 'campaignId') {
  const prevById = new Map(prevRows.map(r => [r[idField], r]));
  const nextById = new Map(nextRows.map(r => [r[idField], r]));
  const out = [];

  for (const row of nextRows) {
    const prev = prevById.get(row[idField]);
    out.push({
      ...row,
      firstSeenAt: prev?.firstSeenAt || now,
      lastSeenAt: now,
      missingRuns: 0,
      presumedArchived: false
    });
  }

  for (const prev of prevRows) {
    if (nextById.has(prev[idField])) continue;
    const missingRuns = (prev.missingRuns || 0) + 1;
    out.push({
      ...prev,
      missingRuns,
      presumedArchived: missingRuns >= 3
    });
  }

  return out;
}

// ─── DIFF ────────────────────────────────────────────────────────────────────
function acDiffSnapshot(prevRows, nextRows, ptDate, now) {
  const prevById = new Map(prevRows.map(r => [r.campaignId, r]));
  const records = [];

  for (const row of nextRows) {
    const prev = prevById.get(row.campaignId);

    if (!prev) {
      records.push(acChange(row, '_created', null, row.name, ptDate, now));
      continue;
    }
    if (row.presumedArchived && !prev.presumedArchived) {
      records.push(acChange(row, '_missing', null, `absent for ${row.missingRuns} runs`, ptDate, now));
      continue;
    }
    if (!row.presumedArchived && prev.presumedArchived) {
      records.push(acChange(row, '_returned', null, row.name, ptDate, now));
    }
    // A row that is currently missing carries forward its old values — there is
    // nothing new to compare, and diffing stale-against-stale would be noise.
    if (row.missingRuns > 0) continue;

    for (const field of AC_TRACKED_FIELDS) {
      const from = prev[field] ?? null;
      const to = row[field] ?? null;
      if (acSame(from, to)) continue;
      records.push(acChange(row, field, from, to, ptDate, now));
    }
  }

  return records;
}

function acChange(row, field, from, to, ptDate, at) {
  return {
    id: `${row.campaignId}|${field}|${ptDate}`,
    campaignId: row.campaignId,
    name: row.name,
    adProduct: row.adProduct,
    field, from, to, ptDate, at
  };
}

// Cents tolerance so 25 vs 25.0 isn't a change.
function acSame(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return Math.round(a * 100) === Math.round(b * 100);
  }
  return a === b;
}

// Capped, dedupe by stable id so a same-day re-run replaces rather than stacks.
// Eviction here is harmless: this log is human-facing only, never the substrate
// anything is reconstructed from.
function acAppendChanges(existing, incoming) {
  if (!incoming.length) return existing;
  const incomingIds = new Set(incoming.map(r => r.id));
  const kept = existing.filter(r => r && !incomingIds.has(r.id));
  const combined = [...kept, ...incoming];
  return combined.slice(-AC_CONFIG.CHANGES_CAP);
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

// Retry throttling and transient server errors only. A 4xx is a real answer and
// retrying it just wastes time.
async function withAdsRetry(fn, attempts = 3) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const res = await fn();
      if (res && (res.status === 429 || res.status >= 500) && attempt < attempts - 1) {
        await sleep(1000 * Math.pow(2, attempt));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === attempts - 1) throw err;
      await sleep(1000 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

// Walks the candidate paths in order and records which one produced a value.
function acPick(obj, paths, hits, field) {
  for (const path of paths) {
    const v = acGetPath(obj, path);
    if (v === undefined || v === null || v === '') continue;
    // A nested budget object must not satisfy a scalar lookup.
    if (typeof v === 'object') continue;
    if (hits) {
      hits[field] = hits[field] || {};
      hits[field][path] = (hits[field][path] || 0) + 1;
    }
    return v;
  }
  return undefined;
}

function acGetPath(obj, path) {
  return path.split('.').reduce((o, k) => (o === null || o === undefined ? undefined : o[k]), obj);
}

function acStr(v) {
  return v === null || v === undefined ? '' : String(v).trim();
}

function acNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// v3 gives YYYY-MM-DD, v2 gave YYYYMMDD. A silent mismatch sorts wrong.
function acDate(v) {
  const s = acStr(v);
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  return s;
}

function acTally(values) {
  const out = {};
  for (const v of values) {
    const k = v === null || v === undefined || v === '' ? '(none)' : String(v);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

async function verifyGoogleToken(req) {
  const accessToken = req.headers.authorization?.replace('Bearer ', '');
  if (!accessToken) return { ok: false, error: 'No access token provided' };
  const verify = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${accessToken}`);
  if (!verify.ok) return { ok: false, error: 'Invalid access token' };
  return { ok: true };
}

// UTC instant → 'YYYY-MM-DD' in America/Los_Angeles. Vercel runs UTC; Amazon ad
// dates are marketplace-local. Phase 2's dated history keys off this, and the
// red-flag window is Pacific, so keeping the two in step matters.
function _ptDate(instant) {
  const d = instant instanceof Date ? instant : new Date(instant);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export { acMapCampaign, acCampaignType, acDiffSnapshot, acMergePresence, acFieldCoverage,
         acCoverageLooksWrong, AC_CONFIG };
