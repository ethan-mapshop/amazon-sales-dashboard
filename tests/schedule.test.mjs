// The Tuesday cron's judgements: whether today is a run day, whether fresh data
// should be adopted or merely offered, and what the Slack message says.
//
// Both write. Getting the run day wrong burns Amazon report quota on six extra
// days a week; adopting too eagerly replaces every recommendation on screen
// mid-fortnight, which is the thing the import button exists to prevent.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { loadAdspend, memoryKv } from './harness.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const kv = memoryKv();
const { M, cleanup } = await loadAdspend('sched', kv);

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };

console.log('\nadsCronIsRunDay  — Pacific, because every window in this file is');

// The schedule fires at 10:00, 11:00 and 12:00 UTC. In August that is 03:00,
// 04:00 and 05:00 Pacific, so the calendar day is the same on both clocks and
// the only thing being tested is the weekday.
ok(M.adsCronIsRunDay(new Date('2026-09-08T10:00:00Z')) === true,
   'Tuesday is a run day');
ok(M.adsCronIsRunDay(new Date('2026-09-07T10:00:00Z')) === false, 'Monday is not');
ok(M.adsCronIsRunDay(new Date('2026-09-09T10:00:00Z')) === false, 'Wednesday is not');
ok([9, 10, 11, 12, 13].every(d => M.adsCronIsRunDay(new Date(`2026-09-${d}T11:00:00Z`)) === false),
   'and neither is any of the other five days');

// 2026-09-09 is a Wednesday. At 03:00 UTC it is still Tuesday evening Pacific,
// and a UTC-naive check would call it Wednesday and skip the run.
ok(M.adsCronIsRunDay(new Date('2026-09-09T03:00:00Z')) === true,
   'Tuesday evening Pacific is still Tuesday',
   'a UTC reading of the same instant says Wednesday');
// The mirror: Tuesday 09-08 at 01:00 UTC is Monday evening Pacific.
ok(M.adsCronIsRunDay(new Date('2026-09-08T01:00:00Z')) === false,
   'and Monday evening Pacific is still Monday',
   'the case a UTC-naive check would fire a day early on');

console.log('\nbwAdoptIfDue  — a fortnight of evidence, or ask first');

const inputs = [{ campaignId: '1', spend: 100, orders: 10 }];
const win = { start: '2026-08-25', end: '2026-09-07' };
const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

const reset = (avail, run) => {
  kv.store.clear();
  if (avail) kv.store.set('biweekly:available', avail);
  if (run) kv.store.set('biweekly:lastrun', run);
};

{
  reset(null, null);
  ok(await M.bwAdoptIfDue() === false, 'nothing fetched, nothing to adopt');
}

{
  reset({ window: win, inputs, fetchedAt: daysAgo(0) }, null);
  const adopted = await M.bwAdoptIfDue();
  ok(adopted === true, 'the first fetch is adopted outright',
     'there is nothing on screen for it to overwrite');
  ok((await kv.get('biweekly:lastrun')).inputs.length === 1, 'and is what the page now decides from');
}

{
  reset({ window: win, inputs, fetchedAt: daysAgo(0) },
        { window: win, inputs, collectedAt: daysAgo(7), adoptedAt: daysAgo(7) });
  ok(await M.bwAdoptIfDue() === false,
     'a week into the fortnight it is offered, not taken',
     'this is the week the import button covers');
}

{
  reset({ window: win, inputs, fetchedAt: daysAgo(0) },
        { window: win, inputs, collectedAt: daysAgo(14), adoptedAt: daysAgo(14) });
  ok(await M.bwAdoptIfDue() === true, 'a fortnight later it is adopted on schedule');
}

{
  // 13 days, not 14: the cron runs weekly, so a fortnight lands on day 14 only
  // if the clock never drifts. A 13-day bar makes the every-other-Tuesday
  // rhythm hold instead of slipping a week each time.
  reset({ window: win, inputs, fetchedAt: daysAgo(0) },
        { window: win, inputs, collectedAt: daysAgo(13.2), adoptedAt: daysAgo(13.2) });
  ok(await M.bwAdoptIfDue() === true,
     'thirteen days is enough, so the rhythm does not slip a week',
     'a 14-day bar would push every other run to the following fortnight');
}

{
  // A missed cron: nothing was adopted last fortnight, and the gap is now long.
  reset({ window: win, inputs, fetchedAt: daysAgo(0) },
        { window: win, inputs, collectedAt: daysAgo(30), adoptedAt: daysAgo(30) });
  ok(await M.bwAdoptIfDue() === true,
     'a missed run is picked up the following week rather than skipped');
}

{
  // Imported off-cycle two days ago. The clock runs from the ADOPTION, so the
  // next automatic adoption is a fortnight from the import, not from the cron.
  reset({ window: win, inputs, fetchedAt: daysAgo(0) },
        { window: win, inputs, collectedAt: daysAgo(20), adoptedAt: daysAgo(2) });
  ok(await M.bwAdoptIfDue() === false,
     'an off-cycle import resets the clock',
     'otherwise importing during a peak would be undone by the next cron');
}

{
  // A run with no adoptedAt at all — written before the field existed.
  reset({ window: win, inputs, fetchedAt: daysAgo(0) },
        { window: win, inputs, collectedAt: daysAgo(20) });
  ok(await M.bwAdoptIfDue() === true,
     'a run predating the field falls back to when it was collected',
     'no migration needed, and no fortnight silently skipped');
}

console.log('\nbwSaveAvailable / bwLoadAvailable  — the fetch is kept apart from the run');

{
  kv.store.clear();
  await M.bwSaveAvailable(win, inputs);
  ok(await M.bwLoadRun() === null,
     'storing a fetch does not touch what the page is deciding from',
     'the separation IS the mid-fortnight guarantee');
  const a = await M.bwLoadAvailable();
  ok(!!a && !!a.fetchedAt, 'and the fetch is timestamped so the banner can date it');
}

{
  kv.store.clear();
  await M.bwSaveAvailable(win, []);
  ok(await M.bwLoadAvailable() === null,
     'an empty fetch reads back as nothing rather than as an empty result',
     'a collect that returned no rows must not be offered for import');
}

console.log('\nadsCronReport  \u2014 what the Tuesday message actually says');

const WIN = { weekStart: '2026-08-31', weekEnd: '2026-09-06',
              baseStart: '2026-08-03', baseEnd: '2026-08-30' };
const BWIN = { start: '2026-08-25', end: '2026-09-07' };

const weeklyPart = (over = {}) => ({
  window: WIN,
  flagCount: over.flagCount === undefined ? 9 : over.flagCount,
  flags: over.flags || {
    budgetCap: [1, 2], silent: [1], spendCollapse: [1, 2, 3],
    ctrCollapse: [1, 2], cpcSpike: [1], brandPacing: []
  }
});
const bwAdopted = { window: BWIN, adopted: true, evaluated: 138,
                    counts: { increase: 9, decrease: 11, cut: 3, hold: 115 } };
const bwOffered = { window: BWIN, adopted: false, daysUntilAdopt: 7 };

{
  const r = M.adsCronReport({ weekly: weeklyPart(), biweekly: bwAdopted });
  ok(r.outcome === 'ok', 'both cadences landing is a clean run');
  ok(r.text.startsWith('\u2705'), 'and leads with the verdict, not the detail');
  ok(r.text.includes('9 flags') && r.text.includes('2026-08-31 to 2026-09-06'),
     'the weekly line carries the count and the week');
  ok(r.text.includes('budget cap 2') && r.text.includes('spend collapse 3'),
     'broken down by check, so the message says where the work is');
  ok(!r.text.includes('brand pacing'),
     'an empty bucket is left out rather than printed as zero');
  ok(r.text.includes('23 changes across 138 campaigns'),
     'the bi-weekly line counts what would actually be changed',
     'increases plus decreases plus cuts, never holds');
  ok(!/Re-run/.test(r.text), 'and a clean run asks for nothing');
}

{
  const r = M.adsCronReport({ weekly: weeklyPart(), biweekly: bwOffered });
  ok(r.outcome === 'ok', 'offered rather than adopted is still a complete run');
  ok(r.text.includes('ready to import') && r.text.includes('in 7 days'),
     'and says so, with when it would be taken automatically');
  ok(!/increase \d/.test(r.text),
     'without action counts for data nothing is deciding from yet',
     'those numbers would describe a page nobody is looking at');
}

{
  const r = M.adsCronReport({ weekly: weeklyPart({ flagCount: 0, flags: {} }),
                              biweekly: bwAdopted });
  ok(r.text.includes('0 flags') && r.text.includes('nothing flagged this week'),
     'a quiet week says so plainly rather than printing an empty list');
}

{
  const r = M.adsCronReport({ weekly: weeklyPart(),
                              notReady: [{ key: 'spBw', status: 'PENDING' }] });
  ok(r.outcome === 'partial', 'one cadence landing is a short run, not a failure');
  ok(r.text.startsWith('\u26a0'), 'flagged as such');
  ok(r.text.includes('bi-weekly report never arrived') && r.text.includes('PENDING'),
     'naming the report and what Amazon last said about it');
  ok(/Re-run that cadence/.test(r.text), 'and what to do about it');
  ok(!/both cadences/.test(r.text),
     'asking only for the one that is missing');
}

{
  const r = M.adsCronReport({ notReady: [{ key: 'spWeek', status: 'PENDING' },
                                         { key: 'spBase', status: 'PROCESSING' },
                                         { key: 'spBw', status: 'PENDING' }] });
  ok(r.outcome === 'none' && r.text.startsWith('\ud83d\udd34'),
     'nothing landing is a failure');
  ok((r.text.match(/never arrived/g) || []).length === 3, 'and every report is named');
  ok(/Re-run both cadences/.test(r.text),
     'asking for both, since neither landed');
}

{
  const r = M.adsCronReport({
    weekly: weeklyPart(), biweekly: bwAdopted,
    censusError: 'Amazon returned 429'
  });
  ok(r.outcome === 'ok' && r.text.includes('Campaign snapshot did not refresh'),
     'a stale census is reported even when the reports themselves landed',
     'every budget, brand and bid the checks read comes from it');
}

{
  const r = M.adsCronReport({ blocked: 'Missing Advertising API credentials: ADS_CLIENT_ID' });
  ok(r.outcome === 'none' && r.text.includes('could not proceed'),
     'a run stopped before it stored anything reads differently from a slow one');
  ok(r.text.includes('ADS_CLIENT_ID'), 'and names the reason');
  ok(!/never arrived/.test(r.text), 'without listing reports it never got as far as');
}

{
  const one = M.adsCronReport({ weekly: { window: WIN, flagCount: 1, flags: { silent: [1] } },
                                biweekly: { window: BWIN, adopted: true, evaluated: 1,
                                            counts: { increase: 1, decrease: 0, cut: 0, hold: 0 } } });
  ok(one.text.includes('1 flag,') && one.text.includes('1 change across'),
     'singulars read as singulars');
}

console.log('\nTHE SCHEDULE ITSELF  \u2014 only the last attempt is allowed to complain');

// The rule the user asked for lives half in the handler and half in
// vercel.json: a collect slot reports a failure only when it carries final=1.
// Adding a slot without moving that flag would report a failure an hour before
// the last attempt, which is exactly the message that must never be sent.
const vercel = JSON.parse(fs.readFileSync(path.join(here, '..', 'vercel.json'), 'utf8'));
const adsCrons = (vercel.crons || []).filter(c => /action=cron-ads-/.test(c.path));
const minuteOfDay = (schedule) => {
  const [min, hour] = schedule.split(' ');
  return Number(hour) * 60 + Number(min);
};

const request = adsCrons.filter(c => /cron-ads-request/.test(c.path));
const collects = adsCrons.filter(c => /cron-ads-collect/.test(c.path))
  .sort((a, b) => minuteOfDay(a.schedule) - minuteOfDay(b.schedule));

ok(request.length === 1, 'exactly one request slot', 'a second would collide as a 425 duplicate');
ok(collects.length >= 2, `${collects.length} collect slots`, 'a slow queue needs more than one try');

const finals = collects.filter(c => /final=1/.test(c.path));
ok(finals.length === 1, 'exactly one collect slot is marked final');
ok(finals[0] === collects[collects.length - 1],
   'and it is the LAST one by clock time',
   'any earlier still has a retry behind it, so it must stay quiet on failure');
ok(collects.slice(0, -1).every(c => !/final=1/.test(c.path)),
   'no earlier slot can report a failure');

ok(minuteOfDay(request[0].schedule) < minuteOfDay(collects[0].schedule),
   'the request runs before the first collect');

// 11:30 UTC is 07:30 EDT, the start of the working day. The final slot may sit
// after it - it is the safety net - but a successful run has to land before.
ok(minuteOfDay(collects[0].schedule) <= 11 * 60 + 30,
   'the first collect lands by 07:30 Eastern in summer',
   `first collect at ${collects[0].schedule} UTC`);
ok(adsCrons.every(c => c.schedule.endsWith('* * *')),
   'every ad cron runs daily and checks the weekday itself',
   'day-of-week cron expressions are untested in this project');

cleanup();
console.log(fails === 0 ? '\nschedule: all assertions pass\n' : `\nschedule: ${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
