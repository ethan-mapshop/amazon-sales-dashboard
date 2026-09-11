// The weekly Red Flag Monitor, split into what the reports said (rfBuildInputs)
// and what to do about it (rfDecideAll). The split is the point: a stored run
// holds METRICS ONLY, so a budget or bid changed after the fetch is picked up on
// the next read instead of being frozen into a stale recommendation.
import { loadAdspend } from './harness.mjs';

// Pure decision functions only, so no kv stub is handed in.
const { M, cleanup } = await loadAdspend('rf');

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };

// A week and the four-week baseline before it, in the shape resolveWindow emits.
const W = { weekStart: '2026-08-31', weekEnd: '2026-09-06',
            baseStart: '2026-08-03', baseEnd: '2026-08-30' };

// A census row. 'Hubbard Scientific' is a real entry in BRAND_SEGMENT with a
// known gross margin, so retention is computable and the checks that gate on it
// are exercised rather than skipped.
const cam = (o = {}) => ({
  campaignId: String(o.campaignId || 1),
  name: o.name || 'HS Anatomy Charts (Exact)',
  adProduct: o.adProduct || 'SP',
  state: o.state || 'ENABLED',
  brand: o.brand === undefined ? 'Hubbard Scientific' : o.brand,
  dailyBudget: o.dailyBudget === undefined ? 20 : o.dailyBudget,
  budgetType: o.budgetType || 'DAILY',
  defaultBid: o.defaultBid === undefined ? 0.75 : o.defaultBid,
  adGroupId: o.adGroupId || 'ag1',
  endDate: o.endDate || null,
  portfolioId: o.portfolioId || null
});
const census = (rows) => ({ campaigns: rows, portfolioNames: {}, changes: [], syncedAt: null });

// A report row, in the shape rfNormalizeRows produces.
const row = (o) => ({
  date: o.date, campaignId: String(o.campaignId || 1),
  cost: o.cost === undefined ? 0 : o.cost,
  clicks: o.clicks === undefined ? 0 : o.clicks,
  impressions: o.impressions === undefined ? 0 : o.impressions,
  sales: o.sales === undefined ? 0 : o.sales,
  purchases: o.purchases === undefined ? 0 : o.purchases
});

// Seven days of the week at a fixed daily spend.
const week = (perDay, over = {}) => ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03',
                                     '2026-09-04', '2026-09-05', '2026-09-06']
  .map(date => row({ date, cost: perDay, ...over }));

// The baseline, as one lump on a single in-window day. Only the totals matter.
const base = (o) => [row({ date: '2026-08-10', ...o })];

console.log('\nrfBuildInputs  — METRICS ONLY, no configuration and no judgement');

{
  const { inputs } = M.rfBuildInputs({
    census: census([cam({ campaignId: 1, dailyBudget: 20 })]),
    rows: [...week(3), ...base({ cost: 84, sales: 400, clicks: 200, impressions: 9000 })],
    window: W
  });
  const i = inputs[0];
  const keys = Object.keys(i).sort().join(',');
  ok(keys === 'campaignId,clicks28,clicks7,daily7,impressions28,impressions7,sales28,spend28,spend7',
     'a stored input carries only what the reports measured', keys);
  ok(!('dailyBudget' in i) && !('brand' in i) && !('name' in i),
     'no budget, brand or name is written down',
     'those come from the census on every read — this is the stale-cache fix');
  ok(!('action' in i) && !('recommendedBudget' in i) && !('flags' in i),
     'and no decision of any kind is stored');
  ok(i.spend7 === 21 && i.spend28 === 84, 'week and baseline spend are kept apart');
  ok(i.daily7.length === 7 && i.daily7.every(d => d === 3),
     'each day of the week survives as its own number',
     'a week total cannot say how many days hit the cap');
}

{
  // Two report rows for the same campaign and day - Amazon returns one row per
  // (campaign, date), but a merged two-report download can repeat a date.
  const { inputs } = M.rfBuildInputs({
    census: census([cam({ campaignId: 1 })]),
    rows: [row({ date: '2026-08-31', cost: 4 }), row({ date: '2026-08-31', cost: 6 })],
    window: W
  });
  ok(inputs[0].daily7.length === 1 && inputs[0].daily7[0] === 10,
     'two rows on one date become one day worth $10, not two days',
     'otherwise a duplicate download doubles the days-at-cap count');
}

{
  const { inputs, orphanRows } = M.rfBuildInputs({
    census: census([cam({ campaignId: 1 })]),
    rows: [row({ date: '2026-08-31', campaignId: 99, cost: 50 })],
    window: W
  });
  ok(orphanRows === 1, 'a row for a campaign not in the census is counted as an orphan');
  ok(inputs.length === 1 && inputs[0].spend7 === 0,
     'and does not leak into any campaign’s totals');
}

{
  const { inputs } = M.rfBuildInputs({
    census: census([cam({ campaignId: 1 }), cam({ campaignId: 2 })]),
    rows: week(3),
    window: W
  });
  ok(inputs.length === 2,
     'a campaign the report never mentioned still gets a row',
     'spending nothing is a fact about the week, and it is what silent looks for');
  ok(inputs.find(i => i.campaignId === '2').spend7 === 0, 'at zero spend');
}

{
  const { inputs } = M.rfBuildInputs({
    census: census([cam({ campaignId: 1, state: 'PAUSED' }),
                    cam({ campaignId: 2, adProduct: 'SB' }),
                    cam({ campaignId: 3 })]),
    rows: [],
    window: W
  });
  ok(inputs.length === 1 && inputs[0].campaignId === '3',
     'paused campaigns and Sponsored Brands are not in the spine',
     'SB is a monthly assessment; no SP report covers it, so it would look silent');
}

console.log('\nrfDecideAll  — reads configuration LIVE from the census');

const decide = (campaigns, rows) => {
  const { inputs } = M.rfBuildInputs({ census: census(campaigns), rows, window: W });
  return M.rfDecideAll({ inputs, census: census(campaigns), window: W });
};

// Retention has to clear CAP_RETENTION_MIN for a cap flag to fire at all, so a
// healthy baseline is used throughout: $84 against $400 of sales is 21% ACoS,
// which on Hubbard's 52% margin retains 60% of the margin.
const HEALTHY = base({ cost: 84, sales: 400, clicks: 200, impressions: 9000 });

{
  // $20 budget, $19.50 a day: 97.5% of the cap, over the 95% ratio, all 7 days.
  const r = decide([cam({ campaignId: 1, dailyBudget: 20 })], [...week(19.5), ...HEALTHY]);
  ok(r.flags.budgetCap.length === 1, 'seven days pressed against the ceiling flags');
  ok(r.flags.budgetCap[0].cappedDays === 7, 'and reports how many days, not a spend ratio');
  ok(r.flags.budgetCap[0].recommendedBudget > 20,
     'with a budget to raise it to', 'the weekly is observational, but the lever is offered');
}

{
  const rows = [...week(19.5), ...HEALTHY];
  const cheap = decide([cam({ campaignId: 1, dailyBudget: 20 })], rows);
  const rich = decide([cam({ campaignId: 1, dailyBudget: 60 })], rows);
  ok(cheap.flags.budgetCap.length === 1 && rich.flags.budgetCap.length === 0,
     'THE SAME STORED METRICS decide differently after the budget is raised',
     'this is the whole reason the split exists');
}

{
  const r = decide([cam({ campaignId: 1, dailyBudget: 20, budgetType: 'LIFETIME' })],
                   [...week(19.5), ...HEALTHY]);
  ok(r.flags.budgetCap.length === 0,
     'a lifetime budget is skipped rather than measured wrong',
     'it has no daily ceiling to be at');
}

{
  const r = decide([cam({ campaignId: 1, dailyBudget: 20 })],
                   [...week(19.5), ...base({ cost: 84, sales: 0, clicks: 200, impressions: 9000 })]);
  ok(r.flags.budgetCap.length === 0,
     'no sales in the baseline means no retention, and an unknown is not fed',
     'null retention must never read as zero');
}

{
  // Three days at cap out of seven is under CAP_DAYS_MIN of 4.
  const rows = [row({ date: '2026-08-31', cost: 19.5 }), row({ date: '2026-09-01', cost: 19.5 }),
                row({ date: '2026-09-02', cost: 19.5 }), ...HEALTHY];
  const r = decide([cam({ campaignId: 1, dailyBudget: 20 })], rows);
  ok(r.flags.budgetCap.length === 0, 'three days at cap is under the four-day bar');
}

{
  const r = decide([cam({ campaignId: 1, endDate: '2026-08-01' })], HEALTHY);
  const s = r.flags.silent[0];
  ok(!!s, 'a campaign that served nothing all week is silent');
  ok(s && s.endedBefore === '2026-08-01',
     'and a past end date is carried as the answer, not left as a lead',
     'an enabled campaign past its end date explains its own silence');
}

{
  // Still serving - impressions in the week - so this is a collapse and not
  // silence. The two are mutually exclusive on purpose.
  const r = decide([cam({ campaignId: 1 })],
                   [...week(0.5, { clicks: 2, impressions: 100 }),
                    ...base({ cost: 400, sales: 2000, clicks: 900, impressions: 40000 })]);
  ok(r.flags.spendCollapse.length === 1,
     '$3.50 against a $100 weekly baseline is a spend collapse');
  ok(r.flags.silent.length === 0,
     'and is not also reported as silent',
     'two rows saying the same thing, one of them less precisely');
}

{
  // Same clicks per impression in both halves: no CTR collapse, whatever the spend.
  const r = decide([cam({ campaignId: 1 })],
                   [...week(3, { clicks: 20, impressions: 1000 }),
                    ...base({ cost: 84, sales: 400, clicks: 560, impressions: 28000 })]);
  ok(r.flags.ctrCollapse.length === 0, 'an unchanged click-through rate does not flag');
}

{
  const r = decide([cam({ campaignId: 1 })],
                   [...week(3, { clicks: 5, impressions: 1000 }),
                    ...base({ cost: 84, sales: 400, clicks: 560, impressions: 28000 })]);
  ok(r.flags.ctrCollapse.length === 1,
     'click-through halving on enough impressions does',
     'conversion-free, so the attribution window cannot fake it');
}

{
  // $0.75 a click in the week against $0.30 in the baseline, on enough clicks.
  const r = decide([cam({ campaignId: 1, defaultBid: 0.5 })],
                   [...week(30, { clicks: 40, impressions: 4000 }),
                    ...base({ cost: 84, sales: 400, clicks: 280, impressions: 28000 })]);
  const s = r.flags.cpcSpike[0];
  ok(!!s, 'cost per click well above baseline flags');
  ok(s && s.defaultBid === 0.5 && s.adGroupId === 'ag1',
     'carrying the bid and the ad group it would be written to',
     'the write goes to the ad group, not the campaign');
}

{
  const r = decide([cam({ campaignId: 1, defaultBid: null, adGroupId: null })],
                   [...week(30, { clicks: 40, impressions: 4000 }),
                    ...base({ cost: 84, sales: 400, clicks: 280, impressions: 28000 })]);
  const s = r.flags.cpcSpike[0];
  ok(s && s.defaultBid === null && (s.recommendedBid === null || s.recommendedBid === undefined),
     'an unknown bid offers no recommendation rather than guessing one',
     'null means unknown, never $0');
}

{
  // An input whose campaign has since been paused in the census.
  const campaigns = [cam({ campaignId: 1 })];
  const { inputs } = M.rfBuildInputs({ census: census(campaigns), rows: week(19.5), window: W });
  const paused = [cam({ campaignId: 1, state: 'PAUSED' })];
  const r = M.rfDecideAll({ inputs, census: census(paused), window: W });
  ok(r.flags.budgetCap.length === 0 && r.flags.silent.length === 0,
     'a campaign paused since the fetch drops out of every bucket',
     'no re-run needed to stop recommending changes to it');
}

{
  const r = decide([cam({ campaignId: 1 })], [...week(3), ...HEALTHY]);
  ok(r.coverage && typeof r.coverage.evaluated === 'number',
     'the result reports how many campaigns it actually judged',
     'the 77-of-141 denominator problem is answerable now');
}

console.log('\nevaluateWeek  — still composes the two');
{
  const campaigns = [cam({ campaignId: 1, dailyBudget: 20 })];
  const rows = [...week(19.5), ...HEALTHY];
  const composed = M.evaluateWeek({ census: census(campaigns), rows, window: W });
  const split = decide(campaigns, rows);
  ok(composed.flags.budgetCap.length === split.flags.budgetCap.length,
     'the one-shot path and the split path agree',
     'a manual run and a stored read cannot disagree');
}

cleanup();
console.log(fails === 0 ? '\nweekly: all assertions pass\n' : `\nweekly: ${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
