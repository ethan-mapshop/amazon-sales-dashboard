// The bi-weekly decision tree, checked against Amazon_Ad_Management_BiWeekly.docx.
// Every threshold here is quoted from that doc. This cadence WRITES, so a wrong
// branch moves real money — Tier 1 cuts a live campaign to $1.
import { loadAdspend } from './harness.mjs';

// Pure decision functions only, so no kv stub is handed in.
const { M, cleanup } = await loadAdspend('bw');

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };

// A campaign as the tree sees it. Defaults clear the significance floor.
const c = (o = {}) => ({
  spend: o.spend === undefined ? 100 : o.spend,
  orders: o.orders === undefined ? 10 : o.orders,
  retention: o.retention === undefined ? 0.60 : o.retention,
  capped: o.capped || false,
  trendingDown: o.trendingDown || false,
  // The prior fortnight. Tier 1 pulls back harder when the same problem was
  // already present, so by default the prior half is healthy and unconfirming.
  priorRetention: o.priorRetention === undefined ? 0.60 : o.priorRetention,
  priorOrders: o.priorOrders === undefined ? 10 : o.priorOrders,
  priorSpend: o.priorSpend === undefined ? 100 : o.priorSpend
});
const d = (o, posture) => M.bwDecide(c(o), posture);

console.log('\nSTATISTICAL SIGNIFICANCE FLOOR  — applied before the tiers');
// "No increase or decrease if 14-day spend is under $10 AND orders are under 3."
ok(d({ spend: 9, orders: 2, retention: 0.9, capped: true }).action === 'hold',
   'under $10 AND under 3 orders holds, even capped at 90% retention',
   '"too little data to act on"');
ok(d({ spend: 9, orders: 2, retention: 0.9, capped: true }).tier === 'floor',
   'and is tagged as the floor, not as a Tier 4 judgement',
   'the difference between "no change needed" and "not enough to judge"');
ok(d({ spend: 9, orders: 3, retention: 0.9, capped: true }).action === 'increase',
   'three orders clears it — the doc says AND, not OR');
ok(d({ spend: 10, orders: 2, retention: 0.9, capped: true }).action === 'increase',
   '$10 of spend clears it too');
// The floor must not shield a bleeding campaign... but the doc puts it first,
// and a sub-$10 campaign cannot trip Tier 1's $15/$20 bars anyway.
ok(d({ spend: 9, orders: 0, retention: -1 }).action === 'hold',
   'a tiny loss-maker still holds', 'below both Tier 1 spend bars regardless');

console.log('\nTIER 1  — hard stops  [staged, not floored: documented deviation]');
// The doc cuts straight to $1. That is 94% on one fortnight of evidence, and a
// floored campaign generates too little data to ever prove a recovery. Staged
// instead: -40% for a bad fortnight, -70% when the prior one was bad too.
ok(d({ spend: 21, retention: -0.01 }).pct === -0.40,
   'one bad fortnight pulls back 40%, not to the floor',
   'the campaign can still spend enough to prove itself next time');
ok(d({ spend: 21, retention: -0.01, priorRetention: -0.05 }).pct === -0.70,
   'below break-even two fortnights running pulls back 70%', 'a bad month, not a bad fortnight');
ok(d({ spend: 21, retention: -0.01, priorRetention: null }).pct === -0.40,
   'an absent prior fortnight is never confirmation',
   'a campaign that was not running then has proved nothing');
ok(d({ spend: 16, orders: 0, retention: null, priorOrders: 0, priorSpend: 100 }).pct === -0.70,
   'no orders for a month pulls back 70%');
ok(d({ spend: 16, orders: 0, retention: null, priorOrders: 0, priorSpend: 2 }).pct === -0.40,
   'zero prior orders on no prior spend is not confirmation',
   'there, "no orders" only means "not running"');
// "14-day spend > $20 AND profit retention < 0 → Cut to $1 floor"
ok(d({ spend: 21, retention: -0.01 }).action === 'cut', 'over $20 and below break-even cuts');
ok(d({ spend: 20, retention: -0.5 }).action !== 'cut', 'exactly $20 does not — the doc says MORE than $20');
ok(d({ spend: 100, retention: 0 }).action !== 'cut', 'retention exactly 0 is not below 0');
// "14-day spend > $15 AND zero orders → Cut to $1 floor"
ok(d({ spend: 16, orders: 0, retention: null }).action === 'cut', 'over $15 with zero orders cuts');
ok(d({ spend: 15, orders: 0, retention: null }).action !== 'cut', 'exactly $15 does not');
ok(d({ spend: 100, orders: 1, retention: 0.6 }).action !== 'cut', 'one order is not zero orders');
// First match wins: a Tier 1 campaign is never also scaled.
ok(d({ spend: 100, retention: -0.2, capped: true }).action === 'cut',
   'a capped loss-maker is cut, not scaled', 'first match wins');

console.log('\nTIER 2  — scale up, capped campaigns only');
// ">= 75% → +50%, 50-74% → +30%, 25-49% → +15%, < 25% → Hold"
ok(d({ retention: 0.75, capped: true }).pct === 0.50, '75% retention capped → +50%');
ok(d({ retention: 0.50, capped: true }).pct === 0.30, '50% → +30%');
ok(d({ retention: 0.25, capped: true }).pct === 0.15, '25% → +15%');
ok(d({ retention: 0.74, capped: true }).pct === 0.30, '74% is still the middle band');
// AMBIGUOUS IN THE DOC, and the two readings move money in opposite directions:
//   Tier 2's table says  "< 25% retention | Hold | Not worth feeding even when capped"
//   Tier 3's header says "(not capped OR RETENTION TOO LOW TO SCALE)"
// Strict first-match wins - which the doc states explicitly at the top of the
// section - puts a capped 15% campaign in Tier 2 and holds it. Tier 3's scope
// line and Tier 2's own rationale ("ad dollars work harder elsewhere") both
// argue for falling through to a decrease instead. Implemented as written -
// hold - because that is the conservative reading and never cuts a budget on
// an interpretation.
ok(d({ retention: 0.24, capped: true, trendingDown: true }).action === 'hold',
   'under 25% capped holds, per strict first-match',
   'see the note above - this one is worth a decision');
// Not capped means Tier 2 never applies, however good the retention.
ok(d({ retention: 0.95, capped: false }).action === 'hold',
   'a 95% retention campaign that is NOT capped holds',
   'there is no evidence more budget would be spent');

console.log('\nTIER 3  — scale down');
// "0-10% → -40%, 10-25% → -25%, 25-50% AND trending down → -15%"
ok(d({ retention: 0.05 }).pct === -0.40, '5% retention → -40%');
ok(d({ retention: 0.15 }).pct === -0.25, '15% → -25%');
ok(d({ retention: 0.35, trendingDown: true }).pct === -0.15, '35% AND trending down → -15%');
ok(d({ retention: 0.35, trendingDown: false }).action === 'hold',
   '35% and NOT trending down holds', 'the doc gates that band on the trend');
ok(d({ retention: 0.60 }).action === 'hold', 'healthy retention, uncapped, holds');
// Below break-even but under Tier 1's spend bar still belongs in Tier 3.
ok(d({ spend: 12, orders: 5, retention: -0.3 }).pct === -0.40,
   'a small loss-maker gets the most aggressive decrease, not a free pass',
   'under the $20 Tier 1 bar but still losing money');

console.log('\nMONTHLY POSTURE  — the bias from the monthly cadence');
// "Scale brands get one tier of additional scaling (a 25-49% campaign that
// would normally get +15% gets +30%)" — the doc's own worked example.
ok(d({ retention: 0.30, capped: true }, 'scale').pct === 0.30,
   "a scale brand's 25-49% campaign gets +30% instead of +15%  [doc's example]");
ok(d({ retention: 0.80, capped: true }, 'scale').pct === 0.50,
   'and the top band cannot go higher than +50%');
// "Constrain brands skip Tier 2 increases and accept more aggressive Tier 3 decreases"
ok(d({ retention: 0.80, capped: true }, 'constrain').action !== 'increase',
   'a constrain brand never increases, even at 80% retention capped',
   `got ${d({ retention: 0.80, capped: true }, 'constrain').action}`);
ok(d({ retention: 0.15 }, 'constrain').pct === -0.40,
   'and its decreases move one band harder', '-25% becomes -40%');
ok(d({ retention: 0.60 }, 'hold').action === 'hold' &&
   d({ retention: 0.60 }).action === 'hold',
   'hold steady is the default and means the standard tree',
   'so a run with no monthly priorities is correct, not approximate');
ok(d({ retention: 0.30, capped: true }, 'nonsense').pct === 0.15,
   'an unrecognised posture falls back to the standard tree');

console.log('\nRETENTION UNKNOWN  — never treated as zero');
ok(d({ retention: null, orders: 5, spend: 100 }).action === 'hold',
   'no retention holds rather than landing in the -40% band',
   'an unmapped brand has no margin; treating that as 0% would gut it');
ok(d({ retention: null, orders: 0, spend: 100 }).action === 'cut',
   'but zero orders still cuts — that rule needs no retention');

console.log('\nNEW BUDGET  — the step to the cent, never below the $1 floor');
const nb = (cur, dec) => M.bwNewBudget(cur, dec);
ok(nb(10, { action: 'increase', pct: 0.30 }) === 13, '$10 at +30% is $13');
ok(nb(10, { action: 'decrease', pct: -0.40 }) === 6, '$10 at -40% is $6');
ok(nb(10, { action: 'cut', pct: -0.70 }) === 3, 'a 70% cut on $10 is $3');
// The budgets in this account are not whole dollars, and rounding to one
// moved the step: -15% on $9 landed at -22%, and the smaller the budget the
// worse it got.
ok(nb(9, { action: 'decrease', pct: -0.15 }) === 7.65,
   '$9 at -15% is $7.65, which is -15%', 'rounding to the nearest dollar made it $8, or -11%');
ok(nb(17.6, { action: 'decrease', pct: -0.40 }) === 10.56,
   'a budget already in cents keeps them', '$17.60 is a real budget in this account');
ok(nb(9.99, { action: 'decrease', pct: -0.15 }) === 8.49,
   'and a third decimal rounds to the cent, not up', '9.99 x 0.85 = 8.4915');
// Repeated, it converges on the floor without ever jumping there.
ok(nb(17, { action: 'cut', pct: -0.70 }) === 5.1 &&
   nb(5.1, { action: 'cut', pct: -0.70 }) === 1.53 &&
   nb(1.53, { action: 'cut', pct: -0.70 }) === 1,
   '$17 reaches the floor in three fortnights', '17 to 5.10 to 1.53 to 1');
ok(nb(1.2, { action: 'decrease', pct: -0.40 }) === 1,
   'the floor still catches what the step would put under it', '0.72 would be below $1');
ok(nb(10, { action: 'hold', pct: 0 }) === 10, 'a hold does not move the budget');
ok(nb(null, { action: 'increase', pct: 0.5 }) === null, 'no current budget, no new one');

console.log('\nADJUSTED  \u2014 a budget already changed since these days ended');

// The window being judged. A change dated after WIN.end means every day in the
// run predates it.
const AWIN = { start: '2026-09-01', end: '2026-09-14',
               priorStart: '2026-08-18', priorEnd: '2026-08-31' };

const chg = (o = {}) => ({
  campaignId: o.campaignId || '1', field: o.field || 'dailyBudget',
  from: o.from === undefined ? 17.6 : o.from,
  to: o.to === undefined ? 10.56 : o.to,
  ptDate: o.ptDate || '2026-09-22'
});

{
  const a = M.bwAdjustedAfter([chg()], AWIN.end);
  ok(a['1'] && a['1'].from === 17.6 && a['1'].to === 10.56 && a['1'].ptDate === '2026-09-22',
     'a budget change after the window is found, with what it moved from and to');
}

{
  ok(!M.bwAdjustedAfter([chg({ ptDate: '2026-09-14' })], AWIN.end)['1'],
     'a change on the last day judged is inside the window, not after it',
     'those days already reflect it, so it is evidence rather than an action');
  ok(!M.bwAdjustedAfter([chg({ ptDate: '2026-09-08' })], AWIN.end)['1'],
     'and one from the middle of the window is not an adjustment either');
}

{
  const a = M.bwAdjustedAfter([chg({ ptDate: '2026-09-16' }), chg({ ptDate: '2026-09-22', to: 8 }),
                               chg({ ptDate: '2026-09-19', to: 9 })], AWIN.end);
  ok(a['1'].ptDate === '2026-09-22' && a['1'].to === 8,
     'the most recent change is the one that counts');
}

{
  ok(!M.bwAdjustedAfter([chg({ field: 'state', to: 'PAUSED' })], AWIN.end)['1'],
     'a change to something other than the budget is not a budget adjustment');
  ok(!M.bwAdjustedAfter([chg({ from: 10, to: 10 })], AWIN.end)['1'],
     'and a change that moved nothing is not one either');
  ok(Object.keys(M.bwAdjustedAfter(undefined, AWIN.end)).length === 0 &&
     Object.keys(M.bwAdjustedAfter([chg()], null)).length === 0,
     'no change log, or no window, yields nothing');
}

console.log('\n  through bwDecideAll  \u2014 its own status, and the row is locked');

// A campaign the tree cuts: $108 spent against $40 of sales is far below
// break-even. The prior fortnight was healthy, so this is a single bad
// fortnight and the cut is -40% rather than the confirmed -70%.
const bleeding = {
  campaignId: '1', spend: 108.59, sales: 39.96, orders: 4, clicks: 60, impressions: 4000,
  priorSpend: 30, priorSales: 300, priorOrders: 20, daily: []
};
const aCensus = (budget) => ({ campaigns: [{
  campaignId: '1', name: 'SOK World Peters (Broad)', adProduct: 'SP', state: 'ENABLED',
  dailyBudget: budget, budgetType: 'DAILY', brand: 'South of Kings', portfolioId: 'pf1'
}] });

{
  const plain = M.bwDecideAll({ inputs: [bleeding], census: aCensus(17.6), window: AWIN });
  ok(plain.rows[0].action === 'cut' && plain.rows[0].newBudget === 10.56,
     'without a change it is a cut, $17.60 to $10.56', String(plain.rows[0].newBudget));

  const r = M.bwDecideAll({ inputs: [bleeding], census: aCensus(10.56), window: AWIN,
                            adjusted: M.bwAdjustedAfter([chg()], AWIN.end) });
  const row = r.rows[0];
  ok(row.action === 'adjusted',
     'once it has been changed the status is Adjusted, not Hold',
     'a hold says the numbers argue for leaving it alone; this says the numbers predate you');
  ok(row.newBudget === null,
     'with no budget offered, so the same evidence cannot be applied twice');
  ok(row.adjusted && row.adjusted.to === 10.56, 'the row carries the change it is reporting');
  ok(/17\.6/.test(row.reason) && /10\.56/.test(row.reason) && /2026-09-22/.test(row.reason),
     'and the reason names both budgets and the date', row.reason);
  ok(r.counts.adjusted === 1 && r.counts.cut === 0,
     'it is counted as adjusted rather than as work still to do');
}

{
  // Run again a week later, which is the point of the lock: the window has
  // moved by 7 days but still ends before the change.
  const nextWeek = { start: '2026-09-08', end: '2026-09-21',
                     priorStart: '2026-08-25', priorEnd: '2026-09-07' };
  const r = M.bwDecideAll({ inputs: [bleeding], census: aCensus(10.56), window: nextWeek,
                            adjusted: M.bwAdjustedAfter([chg()], nextWeek.end) });
  ok(r.rows[0].action === 'adjusted' && r.rows[0].newBudget === null,
     'a weekly run a week later still shows it as adjusted',
     'this is what makes running every week safe on a fortnightly cadence');
}

{
  // The fortnight after: the window now covers days at the new budget.
  const later = { start: '2026-09-15', end: '2026-09-28',
                  priorStart: '2026-09-01', priorEnd: '2026-09-14' };
  const r = M.bwDecideAll({ inputs: [bleeding], census: aCensus(10.56), window: later,
                            adjusted: M.bwAdjustedAfter([chg()], later.end) });
  ok(r.rows[0].action === 'cut', 'when the window catches up the campaign is actionable again');
  ok(r.rows[0].newBudget === 6.34,
     'and the next cut is measured from the budget it has now',
     '$10.56, not the $17.60 it started at');
}

console.log('\nWINDOW  — lagged past attribution, both halves in one pull');
const w = M.resolveBiweeklyWindow(new Date('2026-09-10T12:00:00Z'));
ok(w.end === '2026-09-02', 'the window ends 8 days back, so every day is settled', w.end);
ok(w.start === '2026-08-20', 'and spans 14 days', `${w.start}..${w.end}`);
ok(w.priorEnd === '2026-08-19' && w.priorStart === '2026-08-06',
   'the prior 14 days abut it, for the trend', `${w.priorStart}..${w.priorEnd}`);
const span = (Date.parse(w.end) - Date.parse(w.priorStart)) / 86400000 + 1;
ok(span === 28, 'so one report per ad product covers both halves', `${span} days`);
ok(span <= M.MAX_REPORT_DAYS, "and stays inside Amazon's report cap");
// Sponsored Brands is reviewed monthly, not here: two campaigns out of ~142,
// its report was the slow one gating every run, and its 14-day attribution
// window does not settle inside this cadence's 8-day lag - which matters
// because Tier 1 cuts to $1 on understated orders.
ok(M.BW_REPORT_KEYS.length === 1 && M.BW_REPORT_KEYS[0] === 'spBw',
   'one report, Sponsored Products only', M.BW_REPORT_KEYS.join(', '));
const specs = M.BW_REPORT_KEYS.map(k => M.bwReportSpec(k, w));
ok(specs.every(sp => sp.product === 'sp'), 'and it asks for SP');
ok(specs.every(sp => sp.start === w.priorStart && sp.end === w.end),
   'covering the full 28 days');

console.log('\nCONFIG IS JOINED AT DECIDE TIME, NEVER STORED');
// The stored run holds METRICS only. Budget, brand, name and margin come from
// the census on every read, so a budget applied since the reports were pulled,
// a brand override, or a margin change all take effect with no new report -
// and there is no saved decision that can disagree with the current rules.
const metrics = (id, o = {}) => ({
  campaignId: id,
  spend: o.spend === undefined ? 100 : o.spend,
  orders: o.orders === undefined ? 10 : o.orders,
  sales: o.sales === undefined ? 500 : o.sales,
  clicks: 50, impressions: 9000,
  priorSpend: 100, priorOrders: 10, priorSales: 500,
  daily: o.daily || []
});
const cfgRow = (id, name, brand, budget) => ({
  campaignId: id, name, adProduct: 'SP', state: 'ENABLED',
  dailyBudget: budget, budgetType: 'DAILY', brand, portfolioId: 'pf1'
});
const decide = (inputs, campaigns, postures) =>
  M.bwDecideAll({ inputs, census: { campaigns }, window: w, postures });

ok(decide([metrics('1')], [cfgRow('1', 'RR Test (Exact)', 'Hubbard Scientific', 10)])
     .rows[0].dailyBudget === 10,
   'the budget on a row comes from the census, not the stored run');
ok(decide([metrics('1')], [cfgRow('1', 'RR Test (Exact)', 'Hubbard Scientific', 42)])
     .rows[0].dailyBudget === 42,
   'change the census and the same stored metrics decide against the new budget',
   'which is what applying a budget then reloading relies on');
ok(decide([metrics('1')], [cfgRow('1', 'RR Test (Exact)', null, 10)]).rows[0].retention === null,
   'an unmapped brand in the census means no margin and no retention');
// A campaign that has left the census, or been paused, cannot be judged.
ok(decide([metrics('1')], []).rows.length === 0,
   'metrics with no matching census row are dropped, not guessed at');
const paused = [{ ...cfgRow('1', 'RR Test (Exact)', 'Hubbard Scientific', 10), state: 'PAUSED' }];
ok(decide([metrics('1')], paused).rows.length === 0, 'and a paused campaign is dropped too');

console.log('\nSORT');
// Server order is a sensible default; the page sorts at render time so a stored
// run cannot carry a stale order.
const sortRows = decide(
  [metrics('1'), metrics('2'), metrics('3')],
  [cfgRow('1', 'SOK World Blank (Auto)', 'South of Kings', 10),
   cfgRow('2', 'BW PACK Rivers (Exact)', 'BrightWay Educational', 10),
   cfgRow('3', 'RR California (Exact)', 'Hubbard Scientific', 10)]
).rows.map(r => r.campaign);
ok(sortRows[0].startsWith('BW') && sortRows[2].startsWith('SOK'),
   'rows come back alphabetically by campaign name', sortRows.join(' | '));

console.log('\nDECIDING IS PURE AND POSTURE-SENSITIVE');
// Same inputs, same answer - and a posture supplied at decide time changes it.
// That is what lets a posture change take effect on the next page load.
const capped = [metrics('1', { daily: [10, 10, 10, 10, 10, 10, 10, 10, 10, 10] })];
const cfg = [cfgRow('1', 'RR Test (Exact)', 'Hubbard Scientific', 10)];
ok(decide(capped, cfg).rows[0].action === decide(capped, cfg).rows[0].action,
   'deciding twice gives the same answer');
ok(decide(capped, cfg).rows[0].action === 'increase',
   'a capped, profitable campaign is an increase');
ok(decide(capped, cfg, { 'Hubbard Scientific': 'constrain' }).rows[0].action !== 'increase',
   'and a constrain posture suppresses it', 'no report needed to see the change');

console.log('\nBUILDING A RUN  - metrics only');
const built = M.bwBuildInputs({
  census: { campaigns: [cfgRow('1', 'RR Test (Exact)', 'Hubbard Scientific', 10)] },
  rows: [{ date: w.start, adProduct: 'SP', campaignId: '1', cost: 10, clicks: 5,
           impressions: 500, orders: 2, sales: 100 },
         { date: w.priorStart, adProduct: 'SP', campaignId: '1', cost: 8, clicks: 4,
           impressions: 400, orders: 2, sales: 90 }],
  window: w
});
const one = built.inputs[0];
ok(built.inputs.length === 1, 'one input per enabled campaign');
ok(one.spend === 10 && one.priorSpend === 8, 'both halves are kept separate',
   `now $${one.spend}, prior $${one.priorSpend}`);
ok(Array.isArray(one.daily) && one.daily.length === 1,
   'daily spends are kept, so the at-cap threshold can be retuned later');
ok(one.dailyBudget === undefined && one.brand === undefined && one.name === undefined,
   'and nothing configurational is stored',
   'budget, brand and name are joined from the census on every read');


console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
process.exit(fails === 0 ? 0 : 1);
