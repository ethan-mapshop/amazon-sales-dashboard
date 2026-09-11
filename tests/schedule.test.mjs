// The Tuesday cron's two judgements: whether today is a run day, and whether
// fresh data should be adopted or merely offered.
//
// Both write. Getting the run day wrong burns Amazon report quota on six extra
// days a week; adopting too eagerly replaces every recommendation on screen
// mid-fortnight, which is the thing the import button exists to prevent.
import { loadAdspend, memoryKv } from './harness.mjs';

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

cleanup();
console.log(fails === 0 ? '\nschedule: all assertions pass\n' : `\nschedule: ${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
