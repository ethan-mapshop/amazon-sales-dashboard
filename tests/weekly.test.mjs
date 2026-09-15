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

console.log('\nPORTFOLIO CHECKS  — silent, spend collapse and CTR collapse ask whether the PRODUCT moved');

// A portfolio is one product. Its causes, stock, Buy Box, suppression, price,
// image, reviews, competition, reach every campaign at once. One campaign moving
// on its own is its bids or targets, which Badger manages and the page cannot
// see, so it is deliberately not listed.

// A derived campaign as rfPortfolioFlags sees it. Defaults are steady: this
// week runs at exactly its usual weekly rate, so nothing should flag.
const member = (o = {}) => {
  const m = {
    brand: o.brand === undefined ? 'MapShop State Maps' : o.brand,
    dailyBudget: o.dailyBudget === undefined ? 10 : o.dailyBudget,
    endDate: o.endDate || null,
    impressions7: o.impressions7 === undefined ? 1000 : o.impressions7,
    clicks7: o.clicks7 === undefined ? 10 : o.clicks7,
    spend7: o.spend7 === undefined ? 20 : o.spend7,
    // The four weeks before, as totals.
    impressions28: o.impressions28 === undefined ? 4000 : o.impressions28,
    clicks28: o.clicks28 === undefined ? 40 : o.clicks28,
    spend28: o.spend28 === undefined ? 80 : o.spend28
  };
  m.ctr28 = m.impressions28 > 0 ? m.clicks28 / m.impressions28 : null;
  return m;
};
const four = (o) => [member(o), member(o), member(o), member(o)];
const pf = (members) => M.rfPortfolioFlags({
  members, portfolioId: 'pf-fl', portfolio: 'STATE Florida', window: W
});
const dark = { impressions7: 0, clicks7: 0, spend7: 0 };

{
  const f = pf(four());
  ok(!f.silent && !f.spendCollapse && !f.ctrCollapse, 'a steady portfolio flags nothing');
}

console.log('\n  2 · Silent');

{
  const f = pf(four(dark));
  ok(!!f.silent, 'every campaign in the portfolio at zero is silent');
  ok(f.silent && f.silent.portfolio === 'STATE Florida' && f.silent.campaigns === 4,
     'reported once, as the portfolio, naming how many campaigns it covers');
}

{
  // This week's STATE Florida (ASIN): one of four quiet, the others serving.
  const f = pf([member(dark), member(), member(), member()]);
  ok(!f.silent,
     'one campaign at zero while the other three serve is not silent',
     'stock, suppression and Buy Box would have stopped all four');
}

{
  // 50 impressions a week across the whole portfolio, under the 100 floor.
  const f = pf(four({ ...dark, impressions28: 50 }));
  ok(!f.silent,
     'a portfolio that was barely advertising is not flagged for stopping',
     'one stray impression in a month used to be enough to count as running');
}

{
  const f = pf(four({ ...dark, dailyBudget: 0 }));
  ok(!f.silent, 'a portfolio with no funded campaign is not silent, it is unfunded');
}

{
  const f = pf([member({ ...dark, endDate: '2026-08-20' }),
                member({ ...dark, endDate: '2026-08-28' }),
                member({ ...dark, endDate: '2026-08-15' }),
                member({ ...dark, endDate: '2026-08-02' })]);
  ok(f.silent && f.silent.endedBefore === '2026-08-28',
     'when every campaign has ended, the latest end date is the whole answer');
}

{
  const f = pf([member({ ...dark, endDate: '2026-08-20' }), member(dark), member(dark), member(dark)]);
  ok(f.silent && f.silent.endedBefore === null,
     'but one campaign ending explains nothing about the other three');
}

{
  const f = pf(four(dark));
  ok(f.silent && !f.spendCollapse && !f.ctrCollapse,
     'a silent portfolio is not also listed as a spend or CTR collapse',
     'the same product three times, saying the same thing less precisely');
}

console.log('\n  3 · Spend collapse');

{
  // Every campaign serving a quarter as often. Spend falls to 25% of normal
  // and impressions are the factor that fell.
  const f = pf(four({ impressions7: 250, clicks7: 3, spend7: 5 }));
  ok(!!f.spendCollapse, 'the whole product spending a quarter of normal is a spend collapse');
  ok(f.spendCollapse && f.spendCollapse.cause && f.spendCollapse.cause.driver === 'impressions',
     'and names impressions as what fell');
}

{
  // One large campaign collapses and drags the portfolio total to 27% of
  // normal on its own. The other three are running exactly as usual.
  const big = member({ spend28: 800, spend7: 10, impressions28: 40000, impressions7: 500,
                       clicks28: 400, clicks7: 5 });
  const f = pf([big, member(), member(), member()]);
  ok(!f.spendCollapse,
     'one large campaign collapsing does not flag the product',
     'take it out and the rest are normal, so the cause is that campaign');
}

{
  // Same impressions and clicks as usual, bought for 40% of the money.
  const f = pf(four({ spend7: 8 }));
  ok(!f.spendCollapse,
     'spend falling because clicks got cheaper is not flagged',
     'that is bids, not the product, and bids are Badger\'s');
}

{
  const f = pf([member({ impressions7: 250, clicks7: 3, spend7: 5 })]);
  ok(!f.spendCollapse,
     'a one-campaign portfolio is never flagged for spend collapse',
     'with nothing to remove, product and targeting cannot be told apart');
}

console.log('\n  4 · CTR collapse');

{
  // Four campaigns, each clicking at 0.4% against a usual 1%.
  const f = pf(four({ impressions7: 1000, clicks7: 4 }));
  ok(!!f.ctrCollapse, 'click-through below half across the product flags');
  ok(f.ctrCollapse && f.ctrCollapse.impressions7 === 4000 && f.ctrCollapse.clicks7 === 16,
     'reported on the portfolio totals');
}

{
  // One high-volume campaign's click-through collapses; the other three hold.
  const big = member({ impressions7: 6000, clicks7: 3, impressions28: 24000, clicks28: 240 });
  const f = pf([big, member(), member(), member()]);
  ok(!f.ctrCollapse,
     'one campaign\'s click-through collapsing does not flag the product',
     'a listing problem would show in every campaign, so this is targeting drift');
}

{
  // A broad drop, but after removing the biggest contributor the remainder has
  // too few impressions to read a click-through rate from.
  const f = pf([member({ impressions7: 1500, clicks7: 3 }),
                member({ impressions7: 900, clicks7: 2 })]);
  ok(!f.ctrCollapse,
     'a drop that cannot be shown to be broad is not flagged',
     'the remainder has to clear the same 2,000-impression floor the whole portfolio did');
}

{
  const f = pf(four());
  ok(!f.ctrCollapse, 'an unchanged click-through rate does not flag');
}

console.log('\n  through rfDecideAll');

{
  // The real path: campaigns grouped by the portfolio id in the census.
  const types = ['(Auto)', '(Broad)', '(Exact)', '(ASIN)'];
  const pfCensus = (weekFor) => ({
    campaigns: [1, 2, 3, 4].map(i => cam({
      campaignId: i, name: `STATE Florida ${types[i - 1]}`,
      portfolioId: 'pf-fl', brand: 'MapShop State Maps'
    })),
    portfolioNames: { 'pf-fl': 'STATE Florida' }, changes: [], syncedAt: null
  });
  const baseline = [1, 2, 3, 4].map(i =>
    row({ date: '2026-08-10', campaignId: i, cost: 80, clicks: 40, impressions: 4000, sales: 300 }));

  const c1 = pfCensus();
  const allDark = M.rfDecideAll({
    inputs: M.rfBuildInputs({ census: c1, rows: baseline, window: W }).inputs,
    census: c1, window: W
  });
  ok(allDark.flags.silent.length === 1 && allDark.flags.silent[0].portfolio === 'STATE Florida',
     'a portfolio whose four campaigns all went dark produces one silent row, by name');

  const serving = [1, 2, 3].map(i =>
    row({ date: '2026-09-01', campaignId: i, cost: 20, clicks: 10, impressions: 1000 }));
  const oneDark = M.rfDecideAll({
    inputs: M.rfBuildInputs({ census: c1, rows: [...baseline, ...serving], window: W }).inputs,
    census: c1, window: W
  });
  ok(oneDark.flags.silent.length === 0,
     'and the same portfolio with three still serving produces none',
     'which is exactly this week\'s Florida, New York and Pennsylvania');
  ok(oneDark.coverage.portfolios === 1 && oneDark.coverage.noPortfolio === 0,
     'coverage reports how many portfolios were checked, and any campaign without one');
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

console.log('\nINVESTIGATION NOTES  — what you found, joined onto the flags on read');

// Keyed by portfolio and week. A note belongs to the week it was written; a
// later week shows the most recent earlier note as context, never as its own.
const WEEK = '2026-09-07';
const noteOf = (portfolioId, weekStart, text) =>
  ({ [M.rfNoteKey(portfolioId, weekStart)]: { portfolioId: String(portfolioId), weekStart, text,
                                                updatedAt: '2026-09-15T12:00:00Z' } });
const pfFlags = (over = {}) => ({
  budgetCap: [{ campaignId: 'c1', campaign: 'X' }],
  silent: [],
  spendCollapse: [{ portfolioId: 'pf-a', portfolio: 'STATE Florida', change: -0.6 }],
  ctrCollapse: [],
  cpcSpike: [{ campaignId: 'c2', campaign: 'Y' }],
  brandPacing: [{ brand: 'MapShop State Maps' }],
  ...over
});

{
  const out = M.rfAttachNotes(pfFlags(), noteOf('pf-a', WEEK, 'FBA stock-out, FBM up, no Prime badge'), WEEK);
  const r = out.spendCollapse[0];
  ok(r.note && r.note.text === 'FBA stock-out, FBM up, no Prime badge',
     'a note written for this portfolio this week is attached to its flag');
  ok(r.priorNote === null, 'with no earlier note to show');
}

{
  const out = M.rfAttachNotes(pfFlags(), noteOf('pf-a', '2026-08-31', 'FBA stock-out'), WEEK);
  const r = out.spendCollapse[0];
  ok(r.note === null,
     'a note from an earlier week is not treated as this week\'s',
     'otherwise a new cause would sit silently behind an old explanation');
  ok(r.priorNote && r.priorNote.text === 'FBA stock-out' && r.priorNote.weekStart === '2026-08-31',
     'it is offered as dated context instead, so an ongoing issue needs no retyping');
}

{
  const notes = { ...noteOf('pf-a', '2026-08-17', 'oldest'),
                  ...noteOf('pf-a', '2026-08-31', 'most recent'),
                  ...noteOf('pf-a', '2026-08-24', 'middle') };
  const r = M.rfAttachNotes(pfFlags(), notes, WEEK).spendCollapse[0];
  ok(r.priorNote && r.priorNote.text === 'most recent',
     'the context is the most recent earlier note, whatever order they were stored in');
}

{
  const r = M.rfAttachNotes(pfFlags(), noteOf('pf-a', '2026-09-14', 'from the future'), WEEK).spendCollapse[0];
  ok(r.note === null && r.priorNote === null,
     'a note on a later week is neither this week\'s nor context',
     'which only happens when an older run is read back');
}

{
  const r = M.rfAttachNotes(pfFlags(), noteOf('pf-other', WEEK, 'different product'), WEEK).spendCollapse[0];
  ok(r.note === null && r.priorNote === null, 'a note on another portfolio does not leak across');
}

{
  // The census may carry portfolio ids as numbers; notes are stored as strings.
  const flags = pfFlags({ spendCollapse: [{ portfolioId: 42, portfolio: 'STATE Ohio' }] });
  const r = M.rfAttachNotes(flags, noteOf('42', WEEK, 'numeric id'), WEEK).spendCollapse[0];
  ok(r.note && r.note.text === 'numeric id',
     'a numeric portfolio id still finds its note',
     'the ids arrive as numbers from one side and strings from the other');
}

{
  // One product flagged in two checks shares one note: the stock-out explains both.
  const flags = pfFlags({
    ctrCollapse: [{ portfolioId: 'pf-a', portfolio: 'STATE Florida', change: -0.55 }]
  });
  const out = M.rfAttachNotes(flags, noteOf('pf-a', WEEK, 'stock-out'), WEEK);
  ok(out.spendCollapse[0].note.text === 'stock-out' && out.ctrCollapse[0].note.text === 'stock-out',
     'a product appearing in two checks shows the same note in both');
}

{
  const out = M.rfAttachNotes(pfFlags(), noteOf('pf-a', WEEK, 'x'), WEEK);
  ok(!('note' in out.budgetCap[0]) && !('note' in out.cpcSpike[0]) && !('note' in out.brandPacing[0]),
     'campaign-level and brand-level flags are left untouched',
     'budget cap and CPC spike already carry their own action, an apply button');
}

{
  const out = M.rfAttachNotes(pfFlags(), {}, WEEK);
  ok(out.spendCollapse[0].note === null && out.spendCollapse[0].priorNote === null,
     'with no notes at all, every portfolio flag reads as unnoted rather than breaking');
}

{
  const out = M.rfAttachNotes(pfFlags(), { junk: null, half: { text: 'no portfolio' } }, WEEK);
  ok(out.spendCollapse[0].note === null,
     'a malformed stored entry is skipped rather than taking the page down');
}

ok(M.rfNoteKey('pf-a', WEEK) === M.rfNoteKey('pf-a', WEEK) &&
   M.rfNoteKey(42, WEEK) === M.rfNoteKey('42', WEEK),
   'the storage key is the same for a portfolio id given as a number or a string');

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
