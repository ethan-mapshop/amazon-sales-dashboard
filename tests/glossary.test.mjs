// The definitions behind the "i" icons on the Ad Admin pages.
//
// A definition that quotes a threshold is a second copy of that threshold, and
// the page gives no sign when the two disagree. So every number the glossary
// states is checked here against the config the server actually decides with.
// Also checked: every icon a page draws has a definition behind it, and a click
// on an icon stays on the icon rather than folding a section or opening a
// dropdown underneath it.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { loadAdspend } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };

// ─── LOAD THE GLOSSARY ───────────────────────────────────────────────────────
// Run as the browser runs it, in one scope, with just enough of a document to
// register listeners and place the bubble.

const listeners = [];
const warns = [];
const element = () => ({
  style: {}, className: '', textContent: '',
  setAttribute() {},
  getBoundingClientRect: () => ({ left: 0, top: 0, right: 300, bottom: 80, width: 300, height: 80 })
});
const ctx = {
  console: { ...console, warn: (...a) => warns.push(a.join(' ')) },
  document: {
    addEventListener: (type, fn, capture) => listeners.push({ on: 'document', type, fn, capture: capture === true }),
    createElement: element,
    body: { appendChild() {} }
  },
  window: {
    innerWidth: 1200, innerHeight: 800,
    addEventListener: (type, fn, capture) => listeners.push({ on: 'window', type, fn, capture: capture === true })
  },
  // catalog.js's, which the page calls.
  escapeHtml: (s) => (s == null ? '' : String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;'))
};
vm.createContext(ctx);
vm.runInContext(read('js/ad-glossary.js') +
  '\n;globalThis.__g = { AD_TERMS, adTip, get bubble() { return adgEl; }, get showing() { return adgFor; } };', ctx);
const G = ctx.__g;
const T = G.AD_TERMS;

const { M, cleanup } = await loadAdspend('adg');

const pct = (n) => `${Math.round(n * 100)}%`;
const pts = (n) => `${Math.round(n * 100)} points`;
const has = (key, needles, label) => {
  const text = T[key] || '';
  const missing = needles.filter(n => !text.includes(n));
  ok(missing.length === 0, label, missing.length ? `${key} lacks: ${missing.join(' | ')}` : '');
};

// ─── EVERY ICON HAS A DEFINITION ─────────────────────────────────────────────

console.log('\nCOVERAGE  — every icon a page draws has a definition behind it');

const PAGES = ['js/ad-redflags.js', 'js/ad-biweekly.js', 'js/ad-monthly.js',
               'js/ad-weekly.js', 'js/ad-campaigns.js'];
const used = new Map();
for (const rel of PAGES) {
  const src = read(rel);
  const keys = [
    ...[...src.matchAll(/adTip\('([^']+)'\)/g)].map(m => m[1]),
    ...[...src.matchAll(/\btip: '([^']+)'/g)].map(m => m[1]),
    ...[...src.matchAll(/\b[CR]\('[^']*', '([^']+)'\)/g)].map(m => m[1])
  ];
  for (const k of keys) used.set(k, [...(used.get(k) || []), rel]);
  ok(keys.length > 0, `${rel} draws icons`, `${keys.length}`);
}

const undefinedKeys = [...used.keys()].filter(k => !T[k]);
ok(undefinedKeys.length === 0, 'every key a page uses is defined',
   undefinedKeys.map(k => `${k} in ${used.get(k).join(', ')}`).join('; '));

const unused = Object.keys(T).filter(k => !used.has(k));
ok(unused.length === 0, 'and every definition is used somewhere', unused.join(', '));

ok(read('index.html').indexOf('js/ad-glossary.js') < read('index.html').indexOf('js/ad-redflags.js'),
   'the glossary loads before the pages that call it');

// ─── THE ICON ────────────────────────────────────────────────────────────────

console.log('\nTHE ICON');

{
  const html = G.adTip('rf.bid');
  ok(/data-adg="rf\.bid"/.test(html) && /tabindex="0"/.test(html),
     'carries its key, and can be reached with the keyboard');
  ok(html.startsWith('&#8288;<span'),
     'is joined to the word before it',
     'without the word joiner a narrow column drops the icon onto a line of its own');
  const label = (html.match(/aria-label="([^"]*)"/) || [])[1] || '';
  ok(label.includes('&#39;') && !label.includes("'"),
     'the definition in aria-label is escaped', 'rf.bid contains an apostrophe');
}

{
  warns.length = 0;
  ok(G.adTip('no.such.term') === '' && warns.length === 1,
     'an unknown key draws nothing, and says so in the console',
     'an icon with no definition behind it is worse than no icon');
}

// ─── THE BUBBLE ──────────────────────────────────────────────────────────────

console.log('\nTHE BUBBLE  — a click stays on the icon');

const clickHandler = listeners.find(l => l.on === 'document' && l.type === 'click');
ok(!!clickHandler && clickHandler.capture,
   'clicks are handled in the capture phase',
   'so the icon is dealt with before a <summary> or <label> around it sees the click');

const icon = (key, rect) => ({
  dataset: { adg: key },
  contains: () => false,
  getBoundingClientRect: () => rect || { left: 500, top: 100, right: 512, bottom: 112, width: 12, height: 12 }
});
const click = (target) => {
  const e = {
    target: { closest: (sel) => (sel === '.adg-tip' ? target : null) },
    prevented: false, stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; }
  };
  clickHandler.fn(e);
  return e;
};

{
  const i = icon('acos');
  const e = click(i);
  ok(e.prevented && e.stopped, 'clicking an icon goes no further than the icon');
  ok(G.bubble && G.bubble.style.display === 'block' && G.bubble.textContent === T.acos,
     'and shows its definition', 'on a touch screen, a click is the only way to see it');

  click(i);
  ok(G.bubble.style.display === 'none' && !G.showing, 'clicking it again hides it');

  click(i);
  const away = click(null);
  ok(G.bubble.style.display === 'none' && !away.prevented && !away.stopped,
     'a click anywhere else hides it, and carries on as normal');
}

{
  // Near the right edge: pulled back inside the window.
  click(icon('acos', { left: 1190, top: 100, right: 1200, bottom: 110, width: 10, height: 10 }));
  ok(parseInt(G.bubble.style.left, 10) === 1200 - 300 - 8,
     'kept inside the window at the right edge', G.bubble.style.left);
  click(null);

  // Near the bottom: above the icon rather than off the screen.
  click(icon('acos', { left: 500, top: 780, right: 510, bottom: 790, width: 10, height: 10 }));
  ok(parseInt(G.bubble.style.top, 10) === 780 - 8 - 80,
     'shown above the icon when there is no room below', G.bubble.style.top);
  click(null);
}

// ─── THE NUMBERS MATCH THE RULES ─────────────────────────────────────────────

console.log('\nWEEKLY RED FLAGS  — the numbers in the definitions are the weekly\'s own');

{
  const RF = M.RF_CONFIG;
  has('rf.atCap', [pct(RF.CAP_DAY_RATIO), `${RF.CAP_DAYS_MIN} or more days`,
                   `retention of ${pct(RF.CAP_RETENTION_MIN)}`],
      'At cap: the 95% line, the day count and the retention bar');
  has('rf.raiseTo', [`${pct(RF.RAISE_MIN)} more at ${RF.CAP_DAYS_MIN} days`, `${pct(RF.RAISE_MAX)} more at 7`],
      'Raise to: the smallest and largest raise');
  has('rf.lowerTo', [`${pct(RF.CUT_MIN)} lower at ${RF.CPC_SPIKE_MULTIPLE}×`,
                     `${pct(RF.CUT_MAX)} lower at ${RF.CPC_SPIKE_MULTIPLE * 2}×`],
      'Lower to: the smallest and largest cut, and where each applies');

  // A Tuesday run.
  const w = M.resolveWindow(new Date('2026-09-15T18:00:00Z'));
  ok(new Date(w.weekStart + 'T00:00:00Z').getUTCDay() === 1 && M.daySpan(w.weekStart, w.weekEnd) === 7,
     'the week really is Monday to Sunday');
  has('rf.spend7', ['Monday to Sunday'], 'and 7-day spend says so');
  ok(M.daySpan(w.baseStart, w.baseEnd) === 28 && w.baseEnd < w.weekStart,
     'the comparison really is the 28 days before the week');
  has('rf.typicalSpend', ['28 days before this week', 'divided by 4'], 'and typical spend says so');
}

console.log('\nBI-WEEKLY  — the numbers in the definitions are the bi-weekly\'s own');

{
  const BW = M.BW_CONFIG, UP = M.BW_INCREASES, DOWN = M.BW_DECREASES;
  const w = M.resolveBiweeklyWindow(new Date('2026-09-15T18:00:00Z'));
  ok(M.daySpan(w.end, w.asOf) - 1 === BW.LAG_DAYS && M.daySpan(w.start, w.end) === BW.WINDOW_DAYS,
     'the window really ends 8 days back and runs 14 days');
  has('bw.window', [`${BW.WINDOW_DAYS} days`, `end ${BW.LAG_DAYS} days before today`],
      'Window: its length and its lag');
  has('bw.atCap', [pct(BW.CAP_DAY_RATIO), `out of the ${BW.WINDOW_DAYS}`, `needs ${BW.CAP_DAYS_MIN} or more`],
      'At cap: the 95% line and the day count a raise needs');
  has('bw.action', [
    `under $${BW.MIN_SPEND} of spend and under ${BW.MIN_ORDERS} orders`,
    `over $${BW.T1_LOSS_SPEND} of spend`, `no orders on over $${BW.T1_NOORDER_SPEND}`,
    `−${pct(-BW.T1_SINGLE)}, or −${pct(-BW.T1_CONFIRMED)}`,
    `at cap on ${BW.CAP_DAYS_MIN} or more days`,
    `+${pct(UP[0])} at ${pct(BW.T2_LOW)} retention, +${pct(UP[1])} at ${pct(BW.T2_MID)}, ` +
      `+${pct(UP[2])} at ${pct(BW.T2_HIGH)}`,
    `under ${pct(BW.T2_LOW)} holds`,
    `under ${pct(BW.T3_BARELY)} (−${pct(DOWN[2])}), under ${pct(BW.T3_WEAK)} (−${pct(DOWN[1])}), ` +
      `or under ${pct(BW.T3_MEDIOCRE)}`,
    `more than ${Math.round(BW.TRENDING_DOWN * 100)} points on the prior 14 days (−${pct(DOWN[0])})`
  ], 'Action: every threshold and step in the tree');
  has('bw.new', [`Never below $${BW.FLOOR}`], 'New: the floor');

  // The definition gives an order. The tree has to agree with it.
  const base = { spend: 100, orders: 10, priorSpend: 100, priorOrders: 10, trendingDown: false };
  ok(M.bwDecide({ ...base, retention: 0.05, priorRetention: 0.05, capped: true }).action === 'hold',
     'at cap but under 25% retention holds, as the definition says',
     'rather than falling through to a decrease');
  ok(M.bwDecide({ ...base, spend: 5, orders: 0, retention: -1, priorRetention: -1, capped: false }).action === 'hold',
     'too little data holds before anything else is checked');
}

console.log('\nMONTHLY  — the numbers in the definitions are the monthly\'s own');

{
  const MO = M.MO_CONFIG, RF = M.RF_CONFIG, BW = M.BW_CONFIG, DOWN = M.BW_DECREASES;
  has('mo.vsLastMonth', [`${pts(MO.TREND_MATERIAL)} or more`, `retention under ${pct(MO.SCALE_RETENTION)}`],
      'vs last month: the fall that recommends Constrain');
  has('mo.share', [`more than ${pts(MO.SHARE_GAP)} above`, `retention under ${pct(MO.SCALE_RETENTION)}`],
      'Spend / sales share: the gap that recommends Constrain');
  has('mo.adShare', [`At ${pct(MO.AD_DEPENDENT)} or more`], 'Ad share: the line where a brand is flagged');
  has('mo.sbDaysAtCap', [pct(RF.CAP_DAY_RATIO), `${RF.CAP_DAYS_MIN} of every 7 days`,
                         `${Math.ceil(30 * RF.CAP_DAYS_MIN / 7)} in a 30- or 31-day month`],
      'Days at cap: the 95% line and the days a raise needs');
  ok(Math.ceil(30 * RF.CAP_DAYS_MIN / 7) === Math.ceil(31 * RF.CAP_DAYS_MIN / 7),
     'which is the same number of days in a 30- and a 31-day month');
  has('mo.sbRecommended', [
    `retention under ${pct(MO.CONSTRAIN_RETENTION)} (−${pct(DOWN[1])})`,
    `under ${pct(BW.T3_BARELY)} (−${pct(DOWN[2])})`,
    `retention ${pct(MO.SCALE_RETENTION)} or better`,
    `at cap on ${RF.CAP_DAYS_MIN} of every 7 days`
  ], 'Sponsored Brands Recommended: the lines and the steps');
}

console.log('\nWEEKLY TRENDS');

{
  const src = read('js/ad-weekly.js');
  const degrees = [...new Set([...src.matchAll(/degree: (\d+)/g)].map(m => Number(m[1])))];
  ok(degrees.length === 1, 'every chart uses one degree', degrees.join(', '));
  const d = degrees[0];
  ok(/pts\.length < degree \+ 2/.test(src), 'a fit needs degree + 2 weeks');
  has('wk.trend', [`degree-${d}`, `at least ${d + 2} weeks`], 'Trend: the degree and the weeks it needs');
}

cleanup();
console.log(fails === 0 ? '\nglossary: all assertions pass\n' : `\nglossary: ${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
