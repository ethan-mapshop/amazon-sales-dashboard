// The polynomial trendlines on Weekly Trends.
//
// The spreadsheet drew these with Excel's own fit. This computes it instead of
// pulling in a charting plugin, which means the arithmetic is ours to get wrong:
// a least-squares fit is easy to write in a way that looks plausible on screen
// and is quietly wrong, and a trend drawn over real money should not be.
//
// js/ad-weekly.js is a bare script sharing one global scope, so the fit is
// lifted out of it and driven directly.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'ad-weekly.js'), 'utf8');

// The file only touches the DOM inside functions, so it evaluates with nothing
// stubbed. Returning the fit is all this suite needs from it.
const wkPolyFit = new Function(`${src}\n; return wkPolyFit;`)();

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };
const close = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;
const allClose = (got, want, tol = 1e-6) =>
  got && got.length === want.length && got.every((v, i) => close(v, want[i], tol));

console.log('\nEXACT FITS  — a curve of the right degree must be reproduced');

{
  // A straight line is a degree-2 polynomial with a zero quadratic term.
  const n = 20;
  const want = [];
  for (let i = 0; i < n; i++) want.push(3 * i + 5);
  ok(allClose(wkPolyFit(want, 2), want, 1e-6),
     'degree 2 reproduces a straight line exactly',
     'the quadratic term has to come out at zero rather than at rounding noise');
}

{
  const n = 20;
  const want = [];
  for (let i = 0; i < n; i++) want.push(2 * i * i - 7 * i + 11);
  ok(allClose(wkPolyFit(want, 2), want, 1e-6),
     'and a quadratic exactly');
}

{
  // The Conversion group's degree, over a year of weeks. This is the case that
  // fails outright without normalising x: the normal equations reach x^8.
  const n = 52;
  const f = (i) => 1e-4 * Math.pow(i, 4) - 0.01 * Math.pow(i, 3) + 0.5 * i * i - 3 * i + 20;
  const want = [];
  for (let i = 0; i < n; i++) want.push(f(i));
  const got = wkPolyFit(want, 4);
  ok(allClose(got, want, 1e-6),
     'degree 4 reproduces a quartic across 52 weeks',
     'left unnormalised, x^8 at week 51 is about 4.6e13 and the fit loses its precision');
}

{
  // Degree 4 must not be beaten by degree 2 on data that is genuinely quartic.
  const n = 40;
  const want = [];
  for (let i = 0; i < n; i++) want.push(Math.pow(i - 20, 4) / 1000 - i);
  const err = (deg) => {
    const got = wkPolyFit(want, deg);
    return got.reduce((s, v, i) => s + Math.pow(v - want[i], 2), 0);
  };
  ok(err(4) < err(2),
     'a higher degree fits a curve with more turns more closely',
     'which is why every chart runs at 4 rather than the sheet\'s mix of 4 and 2');
}

console.log('\nSHAPE  — a fit is a trend, not a redrawing of the data');

{
  const n = 30;
  const noisy = [];
  for (let i = 0; i < n; i++) noisy.push(10 + i * 0.5 + (i % 2 ? 6 : -6));
  const got = wkPolyFit(noisy, 2);
  const swings = got.filter((v, i) => i && Math.sign(v - got[i - 1]) !== Math.sign(got[i] - got[i - 1]));
  ok(swings.length === 0, 'the curve does not chase alternating noise');
  ok(got[0] < got[n - 1], 'while still following the underlying rise');
  ok(got.every(v => v > 0 && v < 60), 'and stays in the neighbourhood of the data',
     `range ${Math.min(...got).toFixed(1)} to ${Math.max(...got).toFixed(1)}`);
}

console.log('\nREFUSALS  — no curve beats a fabricated one');

ok(wkPolyFit([1, 2, 3], 2) === null,
   'three points refuse a degree-2 fit',
   'a degree-d curve through d+1 points is interpolation wearing a trend’s clothes');
ok(wkPolyFit([1, 2, 3, 4], 2) !== null, 'four points are enough for degree 2');
ok(wkPolyFit(new Array(5).fill(1), 4) === null, 'five points refuse a degree-4 fit');
ok(wkPolyFit(new Array(6).fill(0).map((_, i) => i), 4) !== null, 'six are enough');
ok(wkPolyFit([], 2) === null, 'nothing at all refuses');
ok(wkPolyFit([5], 2) === null, 'and so does a single week');

console.log('\nGAPS  — an absent week is not a week of zero');

{
  // A rate is null when there were no clicks. Counting it as zero would drag
  // the whole curve to the floor.
  const n = 20;
  const base = [];
  for (let i = 0; i < n; i++) base.push(100 + i);
  const holed = base.slice();
  holed[7] = null;
  holed[12] = undefined;

  const fitted = wkPolyFit(holed, 2);
  ok(fitted && fitted.length === n,
     'the curve still spans every week, including the ones with no value',
     'otherwise the line would break where the bars do');
  ok(fitted && close(fitted[7], base[7], 0.5) && close(fitted[12], base[12], 0.5),
     'and passes through where those weeks would have been');
  ok(fitted && fitted.every(v => v > 90),
     'never dragged toward zero by the gaps',
     `lowest fitted value ${Math.min(...fitted).toFixed(1)}`);
}

{
  const vals = [1, 2, null, 4, NaN, 6, 7, 8];
  const got = wkPolyFit(vals, 2);
  ok(got && got.every(v => isFinite(v)),
     'a NaN in the data does not become a NaN in the curve');
}

console.log('\nDEGENERATE INPUT');

{
  const flat = new Array(30).fill(4.2);
  const got = wkPolyFit(flat, 2);
  ok(got && got.every(v => close(v, 4.2, 1e-6)),
     'a flat series fits a flat line rather than failing');
}

{
  // Real weekly spend: large numbers, degree 2, plenty of points.
  const spend = [1826, 1814, 1696, 1686, 1550, 1361, 1410, 1692, 1431, 1251,
                 1289, 1344, 1193, 1224, 1092, 973, 1083, 1224, 1894, 3336,
                 1981, 1372, 1079, 794, 957, 1072, 1093, 1388, 1237, 1212];
  const got = wkPolyFit(spend, 2);
  ok(got && got.every(v => isFinite(v) && v > -5000 && v < 10000),
     'a real spend series fits without blowing up',
     `range ${Math.min(...got).toFixed(0)} to ${Math.max(...got).toFixed(0)}`);
}

console.log(fails === 0 ? '\ntrendline: all assertions pass\n' : `\ntrendline: ${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
