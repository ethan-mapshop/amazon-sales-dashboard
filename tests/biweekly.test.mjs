// The bi-weekly decision tree, checked against Amazon_Ad_Management_BiWeekly.docx.
// Every threshold here is quoted from that doc. This cadence WRITES, so a wrong
// branch moves real money — Tier 1 cuts a live campaign to $1.
import fs from 'fs';
import path from 'path';
import { pathToFileURL, fileURLToPath } from 'url';

// The module imports @vercel/kv, which does not resolve outside Vercel, so a
// stubbed copy is written next to this file and imported instead. The copy is
// gitignored; the test is not.
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'api', 'adspend.js'), 'utf8')
  .replace(/^import \{ kv \} from '@vercel\/kv';$/m, 'const kv = null;');
const f = path.join(here, '.bw_testable.mjs');
fs.writeFileSync(f, src);
const M = await import(pathToFileURL(f).href);

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };

// A campaign as the tree sees it. Defaults clear the significance floor.
const c = (o = {}) => ({
  spend: o.spend === undefined ? 100 : o.spend,
  orders: o.orders === undefined ? 10 : o.orders,
  retention: o.retention === undefined ? 0.60 : o.retention,
  capped: o.capped || false,
  trendingDown: o.trendingDown || false
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

console.log('\nTIER 1  — hard stops');
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

console.log('\nNEW BUDGET  — "round to the nearest dollar, never below the $1 floor"');
const nb = (cur, dec) => M.bwNewBudget(cur, dec);
ok(nb(10, { action: 'increase', pct: 0.30 }) === 13, "$10 at +30% is $13  [doc's example]");
ok(nb(10, { action: 'decrease', pct: -0.40 }) === 6, '$10 at -40% is $6');
ok(nb(10, { action: 'cut' }) === 1, 'a cut goes to the $1 floor');
ok(nb(1.2, { action: 'decrease', pct: -0.40 }) === 1, 'rounding never lands below $1');
ok(nb(10, { action: 'hold', pct: 0 }) === 10, 'a hold does not move the budget');
ok(nb(null, { action: 'increase', pct: 0.5 }) === null, 'no current budget, no new one');

console.log('\nWINDOW  — lagged past attribution, both halves in one pull');
const w = M.resolveBiweeklyWindow(new Date('2026-09-10T12:00:00Z'));
ok(w.end === '2026-09-02', 'the window ends 8 days back, so every day is settled', w.end);
ok(w.start === '2026-08-20', 'and spans 14 days', `${w.start}..${w.end}`);
ok(w.priorEnd === '2026-08-19' && w.priorStart === '2026-08-06',
   'the prior 14 days abut it, for the trend', `${w.priorStart}..${w.priorEnd}`);
const span = (Date.parse(w.end) - Date.parse(w.priorStart)) / 86400000 + 1;
ok(span === 28, 'so one report per ad product covers both halves', `${span} days`);
ok(span <= M.MAX_REPORT_DAYS, "and stays inside Amazon's report cap");
ok(M.BW_REPORT_KEYS.length === 2, 'two reports, one per ad product', M.BW_REPORT_KEYS.join(', '));
const specs = M.BW_REPORT_KEYS.map(k => M.bwReportSpec(k, w));
ok(specs.every(sp => sp.start === w.priorStart && sp.end === w.end),
   'both request the full 28 days');

console.log(`\n${fails === 0 ? 'ALL PASS' : fails + ' FAILURES'}`);
process.exit(fails === 0 ? 0 : 1);
