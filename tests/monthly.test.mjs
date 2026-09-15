// The monthly review: window arithmetic, brand aggregation, and the posture
// recommendation.
//
// Monthly writes one thing, the brand posture, and the bi-weekly reads it to
// decide how hard to push every campaign in that brand. So a wrong posture here
// moves real budgets a fortnight later, at one remove from anything visible.
import { loadAdspend, memoryKv } from './harness.mjs';

// The decision functions are pure, so the default load needs no kv stub.
// The orders join does read storage, and seeds its own below.
const { M, cleanup } = await loadAdspend('mo');

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };

console.log('\nresolveMonthlyWindow  \u2014 whole calendar months, settled');

// A month's last day keeps crediting Sponsored Brands sales for 14 days, so the
// previous month is complete on the 15th of the next one. That arithmetic lands
// on the 15th whatever the month's length, which is why the rule is a day of
// the month rather than a rolling lag.
const at = (iso) => M.resolveMonthlyWindow(new Date(iso + 'T18:00:00Z'));

{
  const w = at('2026-02-15');
  ok(w.month === '2026-01' && w.start === '2026-01-01' && w.end === '2026-01-31',
     'on the 15th the previous month is the target, end to end');
  ok(w.priorMonth === '2025-12' && w.priorStart === '2025-12-01' && w.priorEnd === '2025-12-31',
     'and the comparison is the month before it, across a year boundary');
}

{
  const w = at('2026-02-14');
  ok(w.month === '2025-12',
     'a day early falls back two months rather than reading a month still settling',
     'January is not complete until February 15');
}

ok(at('2026-03-01').month === '2026-01' && at('2026-03-14').month === '2026-01',
   'and stays there for the whole first half of the next month');
ok(at('2026-03-15').month === '2026-02', 'rolling forward on the 15th');

{
  const w = at('2026-03-15');
  ok(w.end === '2026-02-28', 'February ends on the 28th');
  ok(M.resolveMonthlyWindow(new Date('2028-03-15T18:00:00Z')).end === '2028-02-29',
     'and on the 29th in a leap year',
     'the bounds are computed, never assumed');
}

{
  const w = at('2026-01-15');
  ok(w.month === '2025-12' && w.priorMonth === '2025-11',
     'January reaches back into the previous year');
}

{
  for (const d of ['2026-02-15', '2026-03-15', '2026-05-15', '2027-03-15']) {
    const w = at(d);
    if (M.daySpan(w.start, w.end) > M.MAX_REPORT_DAYS ||
        M.daySpan(w.priorStart, w.priorEnd) > M.MAX_REPORT_DAYS) {
      ok(false, `a window from ${d} exceeds the report cap`);
    }
  }
  ok(true, 'every month fits inside Amazon\u2019s 31-day report cap',
     'a 31-day month is exactly at it, which is why the halves stay separate');
}

console.log('\nmoIsWholeMonth  \u2014 the collect handler cannot count days any more');

ok(M.moIsWholeMonth('2026-01-01', '2026-01-31') === true, 'a 31-day month');
ok(M.moIsWholeMonth('2026-02-01', '2026-02-28') === true, 'a 28-day month');
ok(M.moIsWholeMonth('2028-02-01', '2028-02-29') === true, 'a leap February');
ok(M.moIsWholeMonth('2026-02-01', '2026-02-27') === false, 'one day short is not a month');
ok(M.moIsWholeMonth('2026-01-02', '2026-01-31') === false, 'nor is one starting on the 2nd');
ok(M.moIsWholeMonth('2026-01-01', '2026-02-28') === false, 'nor a span across two months',
   'counting days would have accepted this at 59, and at 30 for a rolling window');

ok(M.moShiftMonth('2026-01', -1) === '2025-12' && M.moShiftMonth('2025-12', 1) === '2026-01',
   'month arithmetic crosses a year in both directions');

console.log('\nmoReportSpec  — three reports, and only SB names its own columns');

{
  const w = M.resolveMonthlyWindow(new Date('2026-09-11T12:00:00Z'));
  const specs = M.MO_REPORT_KEYS.map(k => M.moReportSpec(k, w));
  ok(M.MO_REPORT_KEYS.length === 3, 'three report keys');
  ok(specs.filter(s => s.product === 'sp').length === 2 &&
     specs.filter(s => s.product === 'sb').length === 1,
     'two Sponsored Products windows and one Sponsored Brands');
  const sb = specs.find(s => s.product === 'sb');
  ok(Array.isArray(sb.columns) && sb.columns.includes('newToBrandPurchases'),
     'the SB request asks for new-to-brand',
     'the reason to run Sponsored Brands at all');
  ok(Array.isArray(sb.fallbackColumns) && !sb.fallbackColumns.includes('newToBrandPurchases'),
     'with a fallback set that drops it',
     'a guessed column name must not cost the whole report');
  ok(specs.find(s => s.start === w.priorStart).end === w.priorEnd,
     'the prior month is its own request');
}

// ─── FIXTURES ────────────────────────────────────────────────────────────────

const W = { month: '2026-08', priorMonth: '2026-07',
            start: '2026-08-01', end: '2026-08-31',
            priorStart: '2026-07-01', priorEnd: '2026-07-31' };

const cam = (o = {}) => ({
  campaignId: String(o.campaignId),
  name: o.name || 'RR World Ranger (Exact)',
  adProduct: o.adProduct || 'SP',
  state: o.state || 'ENABLED',
  brand: o.brand === undefined ? 'Hubbard Scientific' : o.brand,
  dailyBudget: o.dailyBudget === undefined ? 20 : o.dailyBudget,
  budgetType: 'DAILY'
});
const census = (rows) => ({ campaigns: rows, portfolioNames: {}, changes: [], syncedAt: null });

const row = (o) => ({
  date: o.date, adProduct: o.adProduct || 'SP', campaignId: String(o.campaignId || 1),
  cost: o.cost || 0, clicks: o.clicks || 0, impressions: o.impressions || 0,
  orders: o.orders || 0, sales: o.sales || 0,
  ntbOrders: o.ntbOrders === undefined ? null : o.ntbOrders,
  ntbSales: o.ntbSales === undefined ? null : o.ntbSales
});

// A campaign input straight to the decider, skipping the report shape.
const input = (o = {}) => ({
  campaignId: String(o.campaignId || 1),
  spend: o.spend === undefined ? 100 : o.spend,
  clicks: o.clicks || 50, impressions: o.impressions || 5000,
  orders: o.orders === undefined ? 20 : o.orders,
  sales: o.sales === undefined ? 500 : o.sales,
  priorSpend: o.priorSpend === undefined ? 100 : o.priorSpend,
  priorClicks: 50, priorImpressions: 5000,
  priorOrders: o.priorOrders === undefined ? 20 : o.priorOrders,
  priorSales: o.priorSales === undefined ? 500 : o.priorSales
});

console.log('\nmoBuildInputs  — METRICS ONLY, binned into the two halves');

{
  const { inputs } = M.moBuildInputs({
    census: census([cam({ campaignId: 1 })]),
    rows: [row({ date: '2026-08-15', cost: 10, sales: 60, orders: 2 }),
           row({ date: '2026-07-15', cost: 7, sales: 40, orders: 1 })],
    window: W
  });
  const i = inputs.sp[0];
  ok(i.spend === 10 && i.priorSpend === 7, 'this month and last month are kept apart');
  ok(i.sales === 60 && i.priorSales === 40, 'for sales as well as spend');
  ok(!('brand' in i) && !('posture' in i) && !('retention' in i),
     'no brand, no margin, no judgement is written down',
     'all of that is joined at decide time, so a remap needs no re-run');
}

{
  const { inputs } = M.moBuildInputs({
    census: census([cam({ campaignId: 1 })]),
    rows: [row({ date: '2026-06-30', cost: 999 }), row({ date: '2026-09-01', cost: 999 })],
    window: W
  });
  ok(inputs.sp[0].spend === 0 && inputs.sp[0].priorSpend === 0,
     'a date outside both halves lands in neither',
     'the gap before the prior window and the attribution tail after');
}

{
  const { inputs, orphanRows } = M.moBuildInputs({
    census: census([cam({ campaignId: 1 }), cam({ campaignId: 2, state: 'PAUSED' })]),
    rows: [row({ date: '2026-08-01', campaignId: 2, cost: 50 }),
           row({ date: '2026-08-01', campaignId: 99, cost: 50 })],
    window: W
  });
  ok(orphanRows === 2, 'rows for paused and unknown campaigns are counted as orphans');
  ok(inputs.sp.length === 1 && inputs.sp[0].spend === 0,
     'and never leak into an enabled campaign');
}

{
  const { inputs } = M.moBuildInputs({
    census: census([cam({ campaignId: 1 }), cam({ campaignId: 9, adProduct: 'SB' })]),
    rows: [row({ date: '2026-08-01', campaignId: 9, adProduct: 'SB',
                 cost: 40, sales: 200, orders: 8, ntbOrders: 3, ntbSales: 90 })],
    window: W
  });
  ok(inputs.sb.length === 1 && inputs.sb[0].ntbOrders === 3,
     'Sponsored Brands is built separately and carries new-to-brand');
  ok(inputs.sp.length === 1, 'without contaminating the Sponsored Products spine');
}

{
  // The fallback fired, so Amazon returned no new-to-brand columns at all.
  const { inputs } = M.moBuildInputs({
    census: census([cam({ campaignId: 9, adProduct: 'SB' })]),
    rows: [row({ date: '2026-08-01', campaignId: 9, adProduct: 'SB', cost: 40, sales: 200, orders: 8 })],
    window: W
  });
  ok(inputs.sb[0].ntbOrders === null && inputs.sb[0].ntbSales === null,
     'new-to-brand reads as unknown, never as zero',
     'zero would say the campaign reached nobody new, which is a different claim');
}

console.log('\nmoDecideAll  — brands aggregated, configuration joined live');

const decide = (campaigns, inputs, extra = {}) => M.moDecideAll({
  inputs, census: census(campaigns), window: W, ...extra
});

{
  // Hubbard: 52% margin. $100 spend against $500 sales is 20% ACoS, so
  // retention is (0.52 - 0.20) / 0.52, about 62%.
  const r = decide([cam({ campaignId: 1 })], { sp: [input()], sb: [] });
  const b = r.rows[0];
  ok(b.brand === 'Hubbard Scientific' && b.campaigns === 1, 'one brand, one campaign');
  ok(b.acos === 0.2, 'ACoS is spend over sales');
  ok(Math.abs(b.retention - 0.6154) < 0.001,
     'retention is the share of gross margin left after ad spend',
     `got ${b.retention}`);
  ok(b.grossMargin === 0.52, 'and the margin it was computed against is shown');
  ok(b.targetAcos === 0.10 && Math.abs(b.gapVsTarget - 0.10) < 0.0001,
     'with the gap against target ACoS beside it');
}

{
  // BrightWay splits by campaign name: Packs at 38% margin, Sets at 51%.
  // A brand-level margin constant could not express this, so gross profit is
  // accumulated per campaign instead.
  const campaigns = [
    cam({ campaignId: 1, brand: 'BrightWay Educational', name: 'BW Pack Rivers (Exact)' }),
    cam({ campaignId: 2, brand: 'BrightWay Educational', name: 'BW Set Continents (Exact)' })
  ];
  const inputs = { sp: [input({ campaignId: 1, sales: 1000, spend: 100 }),
                        input({ campaignId: 2, sales: 1000, spend: 100 })], sb: [] };
  const b = decide(campaigns, inputs).rows[0];
  // (1000*0.38 + 1000*0.51) / 2000
  ok(Math.abs(b.grossMargin - 0.445) < 0.0001,
     'a brand spanning two segments blends its margin by actual sales',
     `got ${b.grossMargin}`);
  ok(Math.abs(b.targetAcos - 0.10) < 0.0001,
     'and blends its target ACoS the same way',
     'Packs 15% and Sets 5%, half the sales each');
}

{
  const campaigns = [cam({ campaignId: 1 }),
                     cam({ campaignId: 2, brand: 'South of Kings', name: 'SOK World Blank (Auto)' })];
  const inputs = { sp: [input({ campaignId: 1, spend: 100, sales: 500 }),
                        input({ campaignId: 2, spend: 300, sales: 500 })], sb: [] };
  const r = decide(campaigns, inputs);
  const sok = r.rows.find(x => x.brand === 'South of Kings');
  ok(Math.abs(sok.spendShare - 0.75) < 0.0001 && Math.abs(sok.salesShare - 0.5) < 0.0001,
     'spend and sales share are computed across the brands on screen',
     'so the two columns always total what is shown, never something unseen');
  ok(r.rows[0].spend >= r.rows[1].spend, 'rows are ordered by spend');
}

{
  const campaigns = [cam({ campaignId: 1 }), cam({ campaignId: 9, adProduct: 'SB' })];
  const inputs = { sp: [input({ sales: 500 })],
                   sb: [{ campaignId: '9', spend: 40, clicks: 10, impressions: 900,
                          orders: 8, sales: 200, ntbOrders: 3, ntbSales: 90 }] };
  const r = decide(campaigns, inputs, { brandSales: { 'Hubbard Scientific': 1400 } });
  const b = r.rows[0];
  ok(b.sales === 500 && b.adSales === 700,
     'brand performance columns are Sponsored Products only, ad sales counts both',
     'SB is 2 campaigns of ~142, but leaving it out of ad share would flatter organic');
  ok(Math.abs(b.adShare - 0.5) < 0.0001,
     'ad share is ad sales over total sales from orders',
     '$700 of $1400');
  ok(b.adDependent === false, 'and half is not ad-dependent');
}

{
  const r = decide([cam({ campaignId: 1 })], { sp: [input({ sales: 500 })], sb: [] },
                   { brandSales: { 'Hubbard Scientific': 520 } });
  ok(r.rows[0].adDependent === true,
     'a brand whose sales are almost all ad-attributed is flagged',
     'it has no organic floor under a constrain');
}

{
  const r = decide([cam({ campaignId: 1 })], { sp: [input()], sb: [] });
  ok(r.rows[0].adShare === null && r.rows[0].totalSales === null,
     'with no order data the share is unknown rather than zero');
}

{
  const campaigns = [cam({ campaignId: 1 })];
  const inputs = { sp: [input()], sb: [] };
  const before = M.moDecideAll({ inputs, census: census(campaigns), window: W, postures: {} });
  const after = M.moDecideAll({ inputs, census: census(campaigns), window: W,
                                postures: { 'Hubbard Scientific': 'scale' } });
  ok(before.rows[0].posture === 'hold' && after.rows[0].posture === 'scale',
     'THE SAME STORED METRICS reflect a posture saved since the run',
     'nothing decided is ever written down, so there is nothing to invalidate');
  ok(before.rows[0].changed !== after.rows[0].changed,
     'and the row says whether the recommendation differs from what is set');
}

{
  const campaigns = [cam({ campaignId: 1, brand: null })];
  const r = decide(campaigns, { sp: [input({ spend: 40 })], sb: [] });
  ok(r.rows.length === 0 && r.coverage.unmapped.length === 1,
     'a campaign spending without a brand mapping is reported, not guessed at');
}

console.log('\nmoRecommend  — profit retention, not ACoS against target');

const brand = (o = {}) => ({
  spend: o.spend === undefined ? 1000 : o.spend,
  orders: o.orders === undefined ? 100 : o.orders,
  retention: o.retention === undefined ? 0.60 : o.retention,
  priorRetention: o.priorRetention === undefined ? 0.60 : o.priorRetention,
  grossMargin: o.grossMargin === undefined ? 0.52 : o.grossMargin,
  spendShare: o.spendShare === undefined ? 0.25 : o.spendShare,
  salesShare: o.salesShare === undefined ? 0.25 : o.salesShare
});
const rec = (o) => M.moRecommend(brand(o));

ok(rec({ spend: 50, orders: 5, retention: 0.90 }).posture === 'hold',
   'a brand under both floors holds, however good it looks',
   'a month that small cannot move a posture on anything but noise');
ok(rec({ spend: 50, orders: 5 }).basis === 'floor',
   'and says it was the floor rather than a judgement');
ok(rec({ spend: 50, orders: 20, retention: 0.80 }).posture === 'scale',
   'clearing either bar is enough, since the floor is an AND');

ok(rec({ retention: null }).posture === 'hold' &&
   rec({ retention: null }).basis === 'unknown',
   'no computable retention holds, and is labelled unknown',
   'never treated as zero, which would read as maximally unprofitable');

ok(rec({ retention: 0.20 }).posture === 'constrain',
   'retention under 25% constrains');
ok(rec({ retention: 0.80 }).posture === 'scale',
   'retention at or over 50% scales');
ok(rec({ retention: 0.35, priorRetention: 0.35 }).posture === 'hold',
   'in between and steady, the standard tree is the right treatment');

ok(rec({ retention: 0.40, priorRetention: 0.55 }).posture === 'constrain',
   'a material fall out of the healthy band constrains');
ok(rec({ retention: 0.40, priorRetention: 0.45 }).posture === 'hold',
   'a small fall does not',
   'these campaigns are too volatile to react to every wobble');
ok(rec({ retention: 0.60, priorRetention: 0.85 }).posture === 'scale',
   'a fall that leaves the brand still healthy does not constrain either');
ok(rec({ retention: 0.40, priorRetention: null }).posture === 'hold',
   'and an absent prior month is not a decline',
   'a brand that was not running then has not fallen, it has no comparison');

ok(rec({ retention: 0.40, spendShare: 0.50, salesShare: 0.20 }).posture === 'constrain',
   'drawing far more of the budget than it returns constrains');
ok(rec({ retention: 0.70, spendShare: 0.50, salesShare: 0.20 }).posture === 'scale',
   'unless retention is healthy, where a big spend share is earned');

{
  const r = rec({ retention: 0.20 });
  ok(/20%/.test(r.reason) && /25%/.test(r.reason),
     'every branch says why in plain words, with the numbers it used',
     r.reason);
}

console.log('\nREASON WORDING  — every branch names its numbers, and none leans on jargon');

{
  // One brand for each branch of moRecommend.
  const cases = {
    floor:     brand({ spend: 50, orders: 5 }),
    noMargin:  brand({ retention: null, grossMargin: null }),
    noSales:   brand({ retention: null }),
    weak:      brand({ retention: 0.18, priorRetention: 0.18 }),
    fell:      brand({ retention: 0.40, priorRetention: 0.55 }),
    share:     brand({ retention: 0.40, priorRetention: 0.40, spendShare: 0.5, salesShare: 0.2 }),
    healthy:   brand({ retention: 0.62, priorRetention: 0.62 }),
    healthyFell: brand({ retention: 0.60, priorRetention: 0.85 }),
    between:   brand({ retention: 0.38, priorRetention: 0.38 })
  };
  const reasons = Object.fromEntries(Object.entries(cases).map(([k, b]) => [k, M.moRecommend(b).reason]));

  const jargon = Object.entries(reasons).filter(([, r]) => /band|tree|the doc/i.test(r));
  ok(jargon.length === 0,
     'no reason says "band", "tree" or "the doc"',
     jargon.length ? jargon.map(([k, r]) => `${k}: ${r}`).join(' | ') : 'the first version said "sits between the bands"');

  ok(/38%/.test(reasons.between) && /25%/.test(reasons.between) && /50%/.test(reasons.between),
     'a Hold Steady reason gives the brand\'s retention and both lines it sits between',
     reasons.between);
  ok(/normal budget rules/.test(reasons.between),
     'and says what Hold Steady does');

  ok(/15 points/.test(reasons.fell),
     'a fall is stated in points, not as a percentage',
     'a 15% fall reads as relative to last month; 55% to 40% is 15 points');

  ok(/raise/i.test(reasons.healthy) && /cut deeper/.test(reasons.weak),
     'Scale and Constrain reasons say what the posture will do');

  ok(/25 points/.test(reasons.healthyFell) && /watching/.test(reasons.healthyFell),
     'a healthy brand that fell hard still scales, but says so');
}

console.log('\nTARGET ACOS  — display only');
{
  const segments = Object.keys(M.TARGET_ACOS);
  ok(segments.every(s => M.TARGET_ACOS[s] > 0 && M.TARGET_ACOS[s] < 1),
     `${segments.length} segments carry a target ACoS`);
  const src = M.moRecommend.toString();
  ok(!/TARGET_ACOS/.test(src),
     'and no recommendation reads one',
     'profit retention is the decision metric in every cadence');
}

console.log('\nmoLoadBrandSales  \u2014 total sales, which no ad report can give');

// The denominator of ad share. The ad reports only know sales they were
// credited for, so "is this brand carried by ads" needs the real total, which
// means orders joined to the catalog by SKU.
{
  const kv = memoryKv({
    'products': [
      { sku: 'RR-100', brand: 'Hubbard Scientific' },
      { sku: 'SOK-9',  brand: 'South of Kings' },
      { sku: 'NOBRAND', brand: '' }
    ],
    'orders:v2:index': ['2026-07', '2026-08'],
    'orders:v2:2026-07': [
      { orderDate: '2026-07-31', sku: 'RR-100', itemTotal: 999 }   // the day before
    ],
    'orders:v2:2026-08': [
      { orderDate: '2026-08-01', sku: 'RR-100', itemTotal: 100 },  // first day, inclusive
      { orderDate: '2026-08-15', sku: 'SOK-9',  itemTotal: 50 },
      { orderDate: '2026-08-15', sku: 'NOBRAND', itemTotal: 70 },
      { orderDate: '2026-08-31', sku: 'RR-100', itemTotal: 200 }   // last day, inclusive
    ]
  });
  const { M: K, cleanup: c2 } = await loadAdspend('mo_orders', kv);
  const out = await K.moLoadBrandSales(W);

  ok(out.available === true, 'the join reports itself available when both stores have data');
  ok(out.byBrand['Hubbard Scientific'] === 300,
     'both endpoints of the month are included',
     `got ${out.byBrand['Hubbard Scientific']}`);
  ok(out.byBrand['South of Kings'] === 50, 'across every brand present');
  ok(!/999/.test(JSON.stringify(out.byBrand)),
     'and the last day of the previous month is not',
     'the bucket for that month is read, then filtered by date');
  ok(out.unmappedSkus === 1 && out.unmappedSales === 70,
     'a SKU with no brand in the catalog is counted, not absorbed',
     'silently dropping it would overstate ad share');
  c2();
}

{
  // No catalog at all: the share has to read as unknown rather than as 100%.
  const kv = memoryKv({ 'orders:v2:index': ['2026-08'], 'orders:v2:2026-08': [] });
  const { M: K, cleanup: c2 } = await loadAdspend('mo_noprod', kv);
  const out = await K.moLoadBrandSales(W);
  ok(out.available === false && Object.keys(out.byBrand).length === 0,
     'with no product catalog the join reports unavailable',
     'an empty denominator would make every brand look entirely ad-driven');
  c2();
}

{
  // Orders exist but not for these months.
  const kv = memoryKv({
    'products': [{ sku: 'RR-100', brand: 'Hubbard Scientific' }],
    'orders:v2:index': ['2025-01'],
    'orders:v2:2025-01': [{ orderDate: '2025-01-05', sku: 'RR-100', itemTotal: 500 }]
  });
  const { M: K, cleanup: c2 } = await loadAdspend('mo_nomonth', kv);
  const out = await K.moLoadBrandSales(W);
  ok(out.available === false,
     'a window with no order bucket behind it is unavailable, not zero');
  c2();
}

console.log('\nRETENTION  \u2014 how far back Amazon still has anything');

// Separate from the 31-day cap on how long one request may span. These two
// numbers came from Amazon's own refusals on 2026-09-11, and they differ by ad
// product, which is what made an off-cadence run fail in two different ways.
ok(M.REPORT_RETENTION_DAYS.sp === 95 && M.REPORT_RETENTION_DAYS.sb === 60,
   'Sponsored Products keeps 95 days, Sponsored Brands 60');

{
  const now = new Date('2026-09-11T18:00:00Z');
  ok(M.reportRetentionStart('sp', now) === '2026-06-08',
     'the Sponsored Products floor matches what Amazon said',
     'its refusal named 2026-06-08 exactly');
  ok(M.reportRetentionStart('sb', now) === '2026-07-13',
     'and so does the Sponsored Brands floor');
}

{
  // The run that failed. On the 11th the target slides back two months, and
  // the comparison month is then over 100 days old.
  const now = new Date('2026-09-11T18:00:00Z');
  const a = M.moAvailability(M.resolveMonthlyWindow(now), now);
  ok(a.spMonth.available === true, 'on the 11th the target month is still there');
  ok(a.spPrior.available === false,
     'but the month before it has aged out',
     'this is the spPrior 400 from the failed run');
  ok(a.sbMonth.available === false,
     'and Sponsored Brands has too, at only 60 days',
     'the same month the Sponsored Products report could still supply');
}

{
  const now = new Date('2026-09-15T18:00:00Z');
  const a = M.moAvailability(M.resolveMonthlyWindow(now), now);
  ok(Object.values(a).every(x => x.available),
     'four days later, on the cadence, all three fit',
     'the settle day and the retention window only overlap from the 15th');
}

{
  // Every day the review can be run, for three years. The Sponsored Products
  // halves must always fit, or the cadence itself is wrong.
  let worstSp = -99, worstSb = -99, badSpDate = null, badSbDate = null;
  for (let y = 2026; y <= 2028; y++) {
    for (let m = 1; m <= 12; m++) {
      const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (let d = 15; d <= last; d++) {
        const iso = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const now = new Date(iso + 'T18:00:00Z');
        const a = M.moAvailability(M.resolveMonthlyWindow(now), now);
        const over = (k, lim) => M.daySpan(a[k].floor, a[k].start) - 1;
        if (!a.spPrior.available && over('spPrior') > worstSp) { worstSp = 1; badSpDate = iso; }
        if (!a.sbMonth.available && !badSbDate) badSbDate = iso;
      }
    }
  }
  ok(badSpDate === null,
     'both Sponsored Products months fit on every day from the 15th onward',
     'four days of margin in the worst case, which is what makes the cadence safe');
  ok(badSbDate === '2026-01-31',
     'Sponsored Brands misses only on the last day of a long month after another',
     `first such day: ${badSbDate}`);
}

{
  const now = new Date('2026-09-11T18:00:00Z');
  const why = M.moUnavailableReason(M.moAvailability(M.resolveMonthlyWindow(now), now), now);
  ok(/2026-06/.test(why) && /95-day/.test(why),
     'the refusal names the month and the limit rather than echoing a raw 400');
  ok(/runs from the 15th/.test(why) && /today is the 11th/.test(why),
     'and says when it will work instead',
     'a 400 from Amazon says none of this');
}

{
  // The local check has to refuse before a request is sent, for the same
  // reason the 31-day cap does: a doomed request still costs quota.
  let threw = '';
  try {
    M.buildReportBody('sb', '2020-01-01', '2020-01-31', ['date', 'campaignId', 'cost']);
  } catch (err) { threw = err.message; }
  ok(/retention|reaches back/i.test(threw),
     'building a report body outside retention throws locally',
     threw || '(it did not throw)');
}

{
  // The cadences that are nowhere near the limit must be untouched by it.
  const now = new Date('2026-09-11T18:00:00Z');
  const w = M.resolveWindow(now);
  const b = M.resolveBiweeklyWindow(now);
  const spFloor = M.reportRetentionStart('sp', now);
  ok(w.baseStart > spFloor && b.priorStart > spFloor,
     'the weekly baseline and the bi-weekly prior half are well inside retention',
     'neither reaches past about 36 days, so this check never fires for them');
}

cleanup();
console.log(fails === 0 ? '\nmonthly: all assertions pass\n' : `\nmonthly: ${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
