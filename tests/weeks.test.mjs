// The weekly history series.
//
// Two feeds write into one store: daily rows from the monthly ad spend buckets,
// and the weekly run's 28-day baseline. Both have to land on the same
// Monday-to-Sunday grid, and neither may write a week that is short of days or
// short of attribution. A week written early is understated forever, because
// nothing goes back to revise it.
import { loadAdspend } from './harness.mjs';

const { M, cleanup } = await loadAdspend('wk');

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };

console.log('\nwhMonday  — the same grid the weekly cadence uses');

ok(M.whMonday('2026-09-07') === '2026-09-07', 'a Monday is its own week start');
ok(M.whMonday('2026-09-13') === '2026-09-07', 'and Sunday belongs to the week that began six days earlier',
   'the off-by-one that would split every week in two');
ok(M.whMonday('2026-09-11') === '2026-09-07', 'a Friday lands in the same week');
ok(M.whMonday('2026-01-01') === '2025-12-29',
   'a week crossing new year keeps its Monday in the old one',
   'which is why the store is keyed by week start, not by year alone');

console.log('\nwhSettledThrough  — a week is written once, when it is final');

{
  // Sponsored Products credits sales to a click date for seven more days.
  const fri = M.whSettledThrough(new Date('2026-09-11T18:00:00Z'));
  ok(fri === '2026-08-24',
     'on Friday the 11th the newest settled week began 24 August',
     'the week of 31 August ends 6 September, only five days back');
  const tue = M.whSettledThrough(new Date('2026-09-15T18:00:00Z'));
  ok(tue === '2026-08-31',
     'four days later the next week has settled and becomes available');
  ok(tue > fri, 'the frontier only ever moves forward');
}

// ─── BINNING ─────────────────────────────────────────────────────────────────

const day = (date, campaign, o = {}) => ({
  date, campaign,
  cost: o.cost === undefined ? 10 : o.cost,
  impressions: o.impressions === undefined ? 1000 : o.impressions,
  clicks: o.clicks === undefined ? 20 : o.clicks,
  purchases7d: o.orders === undefined ? 2 : o.orders,
  sales7d: o.sales === undefined ? 50 : o.sales
});

// A full Monday-to-Sunday week of identical days.
const week = (monday, campaign, o) => {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + i);
    out.push(day(d.toISOString().slice(0, 10), campaign, o));
  }
  return out;
};

const SETTLED = '2026-12-31';   // far future: settlement is tested on its own

console.log('\nwhBinWeeks  — daily rows to weekly totals');

{
  const out = M.whBinWeeks(week('2026-03-02', 'SOK Blank US (Auto)'),
                           '2026-03-01', '2026-03-31', SETTLED);
  ok(out.length === 1, 'seven days of one campaign make one weekly row');
  const r = out[0];
  ok(r.week === '2026-03-02' && r.spend === 70 && r.clicks === 140 && r.orders === 14,
     'and every metric is the sum of its days',
     `spend ${r.spend}, clicks ${r.clicks}, orders ${r.orders}`);
}

{
  // The monthly buckets are per SKU, so one campaign has several rows a day.
  const rows = [...week('2026-03-02', 'SOK Blank US (Auto)'),
                ...week('2026-03-02', 'SOK Blank US (Auto)')];
  const out = M.whBinWeeks(rows, '2026-03-01', '2026-03-31', SETTLED);
  ok(out.length === 1 && out[0].spend === 140,
     'several rows for one campaign on one day sum rather than split',
     'the stored months are per SKU, so this is the normal case');
}

{
  const rows = [...week('2026-03-02', 'SOK Blank US (Auto)'),
                ...week('2026-03-02', 'RR World Ranger (Exact)')];
  const out = M.whBinWeeks(rows, '2026-03-01', '2026-03-31', SETTLED);
  ok(out.length === 2, 'two campaigns stay two rows in the same week',
     'brand is joined on read, so the store keeps them apart');
}

{
  // 2026-03-01 is a Sunday, so its week began in February.
  const out = M.whBinWeeks([day('2026-03-01', 'SOK Blank US (Auto)')],
                           '2026-03-01', '2026-03-31', SETTLED);
  ok(out.length === 0,
     'a week that starts before the covered span is dropped, not written short',
     '1 March 2026 is a Sunday, and its Monday is back in February');
}

{
  const rows = [...week('2026-03-23', 'SOK Blank US (Auto)'),
                ...week('2026-03-30', 'SOK Blank US (Auto)')];
  const out = M.whBinWeeks(rows, '2026-03-01', '2026-03-31', SETTLED);
  ok(out.length === 1 && out[0].week === '2026-03-23',
     'and so is a week running off the end of it',
     'the week of 30 March reaches into April, which this bucket does not cover');
}

{
  const rows = [...week('2026-03-23', 'SOK Blank US (Auto)'),
                ...week('2026-03-30', 'SOK Blank US (Auto)')];
  const out = M.whBinWeeks(rows, '2026-03-01', '2026-04-30', SETTLED);
  ok(out.length === 2,
     'with both months covered, the straddling week is written',
     'which is why contiguous months are binned together rather than one at a time');
}

{
  const rows = week('2026-09-07', 'SOK Blank US (Auto)');
  const early = M.whBinWeeks(rows, '2026-09-01', '2026-09-30', '2026-08-31');
  const later = M.whBinWeeks(rows, '2026-09-01', '2026-09-30', '2026-09-07');
  ok(early.length === 0,
     'a week newer than the settled frontier is not written at all',
     'it would be understated, and nothing here ever revises a week');
  ok(later.length === 1, 'and is written once the frontier reaches it');
}

{
  const rows = [day('2026-03-02', '', { cost: 99 }), day('not-a-date', 'SOK X', { cost: 99 })];
  const out = M.whBinWeeks(rows, '2026-03-01', '2026-03-31', SETTLED);
  ok(out.length === 0, 'rows with no campaign or no usable date are skipped');
}

{
  // The weekly report normalizer emits orders/sales; the month buckets emit
  // purchases7d/sales7d. One binner has to read both.
  const fromReport = [{ date: '2026-03-02', campaign: 'SOK X',
                        cost: 5, impressions: 100, clicks: 10, orders: 3, sales: 25 }];
  const out = M.whBinWeeks(fromReport, '2026-03-02', '2026-03-08', SETTLED);
  ok(out.length === 1 && out[0].orders === 3 && out[0].sales === 25,
     'the weekly report shape and the stored month shape both bin',
     'one feed calls them orders and sales, the other purchases7d and sales7d');
}

// ─── READ ────────────────────────────────────────────────────────────────────

console.log('\nwhSeries  — brand joined on read, ratios computed there too');

const stored = (week, campaign, o = {}) => ({
  week, campaign,
  impressions: o.impressions === undefined ? 10000 : o.impressions,
  clicks: o.clicks === undefined ? 200 : o.clicks,
  orders: o.orders === undefined ? 10 : o.orders,
  spend: o.spend === undefined ? 100 : o.spend,
  sales: o.sales === undefined ? 400 : o.sales
});
const census = (rows) => ({ campaigns: rows, portfolioNames: {}, changes: [], syncedAt: null });
const cam = (name, brand) => ({ campaignId: String(Math.random()).slice(2, 8), name, brand,
                                adProduct: 'SP', state: 'ENABLED' });

{
  const rows = [stored('2026-03-02', 'SOK Blank US (Auto)'),
                stored('2026-03-09', 'SOK Blank US (Auto)', { spend: 50, sales: 500 })];
  const r = M.whSeries({ rows, census: census([cam('SOK Blank US (Auto)', 'South of Kings')]), brand: 'all' });
  ok(r.series.length === 2, 'one entry per week');
  ok(r.series[0].week < r.series[1].week, 'in date order');
  const w = r.series[0];
  ok(w.acos === 0.25 && w.roas === 4 && w.cpc === 0.5 && w.ctr === 0.02 && w.cvr === 0.05,
     'all five ratios are derived, never stored',
     `acos ${w.acos} roas ${w.roas} cpc ${w.cpc} ctr ${w.ctr} cvr ${w.cvr}`);
}

{
  const rows = [stored('2026-03-02', 'SOK A'), stored('2026-03-02', 'RR B')];
  const c = census([cam('SOK A', 'South of Kings'), cam('RR B', 'Hubbard Scientific')]);
  const all = M.whSeries({ rows, census: c, brand: 'all' });
  const sok = M.whSeries({ rows, census: c, brand: 'South of Kings' });
  ok(all.series[0].spend === 200 && sok.series[0].spend === 100,
     'the brand filter narrows the totals');
  ok(sok.brands.length === 2,
     'while the brand list still names every brand in range',
     'otherwise filtering to one brand would empty the filter');
}

{
  // A campaign the census no longer carries, renamed or archived. The prefix
  // is the only thing left to go on.
  const rows = [stored('2026-03-02', 'SOK Retired Campaign (Auto)')];
  const r = M.whSeries({ rows, census: census([]), brand: 'all' });
  ok(r.brands.includes('South of Kings'),
     'a campaign gone from the census still resolves by name prefix',
     'history would otherwise shrink every time a campaign was archived');
  ok(r.coverage.unmappedCampaigns === 0, 'and is not counted as unmapped');
}

{
  const rows = [stored('2026-03-02', 'Kappa - SR Adv Combo (Auto)', { spend: 42 })];
  const r = M.whSeries({ rows, census: census([]), brand: 'all' });
  ok(r.coverage.unmappedCampaigns === 1 && r.coverage.unmappedSpend === 42,
     'a name matching no prefix is reported rather than absorbed',
     'the 2024 naming convention, which nothing maps today');
}

{
  // The census wins over the prefix, because it carries manual overrides.
  const rows = [stored('2026-03-02', 'SOK Mislabelled (Auto)')];
  const r = M.whSeries({ rows, census: census([cam('SOK Mislabelled (Auto)', 'Hubbard Scientific')]),
                         brand: 'all' });
  ok(r.brands.includes('Hubbard Scientific') && !r.brands.includes('South of Kings'),
     'a brand override in the census beats what the name implies',
     'which is the point of joining on read instead of freezing it at write time');
}

{
  const rows = [stored('2026-03-02', 'SOK A', { clicks: 0, orders: 0, sales: 0, impressions: 0 })];
  const r = M.whSeries({ rows, census: census([cam('SOK A', 'South of Kings')]), brand: 'all' });
  const w = r.series[0];
  ok(w.acos === null && w.cpc === null && w.ctr === null && w.cvr === null,
     'a week with no clicks has no rates, rather than zeros',
     'zero would draw at the axis and read as free traffic');
}

{
  const rows = [stored('2026-03-02', 'SOK A', { spend: 100, sales: 400 }),
                stored('2026-03-09', 'SOK A', { spend: 300, sales: 400 })];
  const r = M.whSeries({ rows, census: census([cam('SOK A', 'South of Kings')]), brand: 'all' });
  ok(r.totals.spend === 400 && r.totals.sales === 800 && r.totals.acos === 0.5,
     'the totals are computed from the summed metrics, not averaged from the weeks',
     'averaging two ACoS figures would give 62.5% here, which is wrong');
}

cleanup();
console.log(fails === 0 ? '\nweeks: all assertions pass\n' : `\nweeks: ${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
