// The Monthly Review posture controls.
//
// Postures are staged and saved together on Confirm. They used to save on every
// dropdown change, so a decision was already live for the next bi-weekly before
// the other brands had been looked at. This suite pins the one guarantee that
// matters: choosing is not saving.
//
// js/ad-monthly.js is a bare script sharing one global scope, so it is wrapped
// here with the globals it expects and driven directly.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, '..', 'js', 'ad-monthly.js'), 'utf8');

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };

// ─── HARNESS ─────────────────────────────────────────────────────────────────

function boot({ saved = {}, failFor = [], sbRows = [], updateReply = null } = {}) {
  const state = { postures: { ...saved } };
  const posts = [];
  const updates = [];

  const rowsFrom = () => ['Hubbard Scientific', 'South of Kings', 'MapShop State Maps'].map(brand => ({
    brand,
    posture: state.postures[brand] || 'hold',
    recommended: brand === 'South of Kings' ? 'constrain' : 'scale'
  }));

  const fetchStub = async (url, opts = {}) => {
    const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
    if (String(url).includes('action=biweekly-posture')) {
      const body = JSON.parse(opts.body || '{}');
      posts.push(body);
      if (failFor.includes(body.brand)) return reply(500, { error: 'KV write failed' });
      state.postures[body.brand] = body.posture;
      return reply(200, { success: true });
    }
    if (String(url).includes('action=monthly-get')) {
      return reply(200, { success: true, rows: rowsFrom(), sbRows, window: {}, config: {} });
    }
    if (String(url).includes('/api/adcampaigns?action=update')) {
      const body = JSON.parse(opts.body || '{}');
      updates.push(body);
      return updateReply ? updateReply(body, reply) : reply(200, {
        success: true, applied: { dailyBudget: { from: body.expected.dailyBudget, to: body.amazon.dailyBudget } }
      });
    }
    return reply(404, { error: 'unexpected ' + url });
  };

  // The page binds its handlers to this element, so events can be fired through
  // the same wiring a real click goes through.
  const listeners = {};
  const container = {
    innerHTML: '',
    addEventListener(type, fn) { (listeners[type] ||= []).push(fn); }
  };
  // Fires an event whose target answers closest() for the given selectors.
  // Returns whatever the handlers return, so async ones can be awaited.
  const fire = async (type, matches) => {
    const target = { closest: (sel) => matches[sel] || null };
    const results = (listeners[type] || []).map(fn => fn({ target }));
    await Promise.all(results);
  };

  const epilogue = `
    return {
      moStage, moConfirmPostures, moFetch, moSbSetStage, moSbApplyBudget, moSbActionCell,
      get sbApply() { return moSbApply; },
      get pending() { return moPending; },
      get errors() { return moConfirmErrors; },
      get data() { return moData; }
    };
  `;
  const factory = new Function(
    'document', 'fetch', 'localStorage', 'accessToken', 'escapeHtml', 'formatNumber',
    '_svTimeAgo', 'CSS', 'setTimeout', 'clearTimeout', 'console', 'adTip',
    `${src}\n${epilogue}`
  );
  const api = factory(
    { getElementById: (id) => (id === 'admonthly-content' ? container : null),
      querySelector: () => null, querySelectorAll: () => [] },
    fetchStub,
    { getItem: () => null, setItem() {}, removeItem() {} },
    'test-token',
    (x) => String(x), (x) => String(x), () => 'just now',
    { escape: (x) => String(x) },
    (fn, ms) => globalThis.setTimeout(fn, ms), (t) => globalThis.clearTimeout(t),
    { ...console, error: () => {} },
    // From ad-glossary.js. The icons are not under test here.
    () => ''
  );
  return { api, posts, updates, state, fire };
}

// ─── STAGING ─────────────────────────────────────────────────────────────────

console.log('\nSTAGING  — choosing a posture saves nothing');

{
  const w = boot();
  await w.api.moFetch();
  w.api.moStage('Hubbard Scientific', 'scale');
  ok(w.api.pending['Hubbard Scientific'] === 'scale', 'changing a posture stages it');
  ok(w.posts.length === 0,
     'and sends nothing to the server',
     'the whole point: it used to save the moment the dropdown changed');
}

{
  const w = boot();
  await w.api.moFetch();
  w.api.moStage('Hubbard Scientific', 'scale');
  w.api.moStage('South of Kings', 'constrain');
  w.api.moStage('MapShop State Maps', 'scale');
  ok(Object.keys(w.api.pending).length === 3 && w.posts.length === 0,
     'several brands can be decided before anything is saved');
}

{
  const w = boot();
  await w.api.moFetch();
  w.api.moStage('Hubbard Scientific', 'scale');
  w.api.moStage('Hubbard Scientific', 'hold');
  ok(!('Hubbard Scientific' in w.api.pending),
     'choosing the posture a brand already has un-stages it',
     'so the confirm bar only ever lists real changes');
}

{
  const w = boot();
  await w.api.moFetch();
  w.api.moStage('No Such Brand', 'scale');
  ok(Object.keys(w.api.pending).length === 0, 'a brand not on the page cannot be staged');
}

// ─── CONFIRMING ──────────────────────────────────────────────────────────────

console.log('\nCONFIRM  — saves every staged change, one brand at a time');

{
  const w = boot();
  await w.api.moFetch();
  w.api.moStage('Hubbard Scientific', 'scale');
  w.api.moStage('South of Kings', 'constrain');
  await w.api.moConfirmPostures();
  ok(w.posts.length === 2, 'Confirm sends one save per staged brand');
  ok(w.state.postures['Hubbard Scientific'] === 'scale' &&
     w.state.postures['South of Kings'] === 'constrain',
     'and both land in storage');
  ok(Object.keys(w.api.pending).length === 0, 'with nothing left staged afterwards');
}

{
  const w = boot({ failFor: ['South of Kings'] });
  await w.api.moFetch();
  w.api.moStage('Hubbard Scientific', 'scale');
  w.api.moStage('South of Kings', 'constrain');
  await w.api.moConfirmPostures();
  ok(w.state.postures['Hubbard Scientific'] === 'scale',
     'a brand that saves is kept when another fails',
     'the ones that went through are not rolled back');
  ok(w.api.pending['South of Kings'] === 'constrain',
     'the brand that failed stays staged',
     'so pressing Confirm again retries exactly what did not save');
  ok(/Not saved/.test(w.api.errors['South of Kings'] || ''),
     'with its error beside it, rather than a single message for the batch');
}

{
  const w = boot();
  await w.api.moFetch();
  await w.api.moConfirmPostures();
  ok(w.posts.length === 0, 'Confirm with nothing staged sends nothing');
}

{
  // Saved elsewhere, say from the bi-weekly page, while it sat staged here.
  const w = boot();
  await w.api.moFetch();
  w.api.moStage('Hubbard Scientific', 'scale');
  w.state.postures['Hubbard Scientific'] = 'scale';
  await w.api.moFetch();
  ok(!('Hubbard Scientific' in w.api.pending),
     'a staged choice that now matches what is saved is dropped on the next read');
}

// ─── THROUGH THE PAGE'S OWN HANDLERS ─────────────────────────────────────────

console.log('\nWIRING  — the dropdown and buttons, as a click actually reaches them');

// The staging tests above call the functions directly. These fire events at the
// handlers the page binds, which is what would catch the dropdown being wired
// back to an immediate save.

{
  const w = boot();
  await w.api.moFetch();
  await w.fire('change', { '[data-mo-posture]': { dataset: { moPosture: 'Hubbard Scientific' }, value: 'scale' } });
  ok(w.api.pending['Hubbard Scientific'] === 'scale', 'changing the dropdown stages the posture');
  ok(w.posts.length === 0,
     'and changing the dropdown sends nothing',
     'this is the regression the change exists to prevent');
}

{
  const w = boot();
  await w.api.moFetch();
  await w.fire('click', { '[data-mo-adopt]': { dataset: { moAdopt: 'South of Kings' } } });
  ok(w.api.pending['South of Kings'] === 'constrain' && w.posts.length === 0,
     'pressing "Use" stages the recommendation without saving it');
}

{
  const w = boot();
  await w.api.moFetch();
  await w.fire('change', { '[data-mo-posture]': { dataset: { moPosture: 'Hubbard Scientific' }, value: 'scale' } });
  await w.fire('click', { '[data-mo-confirm]': {} });
  ok(w.posts.length === 1 && w.state.postures['Hubbard Scientific'] === 'scale',
     'pressing Confirm is what saves');
}

{
  const w = boot();
  await w.api.moFetch();
  await w.fire('change', { '[data-mo-posture]': { dataset: { moPosture: 'Hubbard Scientific' }, value: 'scale' } });
  await w.fire('click', { '[data-mo-discard]': {} });
  ok(Object.keys(w.api.pending).length === 0 && w.posts.length === 0,
     'pressing Discard drops every staged change without saving any');
}

// ─── SPONSORED BRANDS APPLY ──────────────────────────────────────────────────

console.log('\nSPONSORED BRANDS APPLY  — a budget reaches Amazon only after Confirm');

const sbRow = { campaignId: 'sb1', campaign: 'SB Kings Maps', adProduct: 'SB', brand: 'South of Kings',
                dailyBudget: 20, action: 'raise', recommendedBudget: 25, reason: 'x' };

{
  const w = boot({ sbRows: [sbRow] });
  await w.api.moFetch();
  await w.fire('click', { '[data-mo-sb-apply]': { dataset: { moSbApply: 'sb1' } } });
  ok(w.api.sbApply.sb1 && w.api.sbApply.sb1.stage === 'confirm',
     'pressing the budget button asks for confirmation');
  ok(w.updates.length === 0, 'and writes nothing yet');

  await w.fire('click', { '[data-mo-sb-cancel]': { dataset: { moSbCancel: 'sb1' } } });
  ok(!w.api.sbApply.sb1 && w.updates.length === 0, 'Cancel backs out without writing');
}

{
  const w = boot({ sbRows: [sbRow] });
  await w.api.moFetch();
  await w.fire('click', { '[data-mo-sb-apply]': { dataset: { moSbApply: 'sb1' } } });
  await w.fire('click', { '[data-mo-sb-confirm]': { dataset: { moSbConfirm: 'sb1' } } });
  const u = w.updates[0] || {};
  ok(w.updates.length === 1, 'Confirm sends one write');
  ok(u.adProduct === 'SB' && u.campaignId === 'sb1', 'marked as Sponsored Brands, for that campaign');
  ok(u.amazon && u.amazon.dailyBudget === 25, 'asking for the recommended budget');
  ok(u.expected && u.expected.dailyBudget === 20,
     'and carrying the budget the page showed',
     'so the server refuses if it moved in the meantime');
  ok(w.api.sbApply.sb1 && w.api.sbApply.sb1.stage === 'done' && w.api.sbApply.sb1.applied === 25,
     'a confirmed change shows as done at the new budget');
}

{
  // Amazon answered success, but reading the campaign back shows no change.
  const w = boot({ sbRows: [sbRow],
                   updateReply: (body, reply) => reply(200, { success: true, applied: {},
                                                              notApplied: [{ field: 'dailyBudget', value: 20 }] }) });
  await w.api.moFetch();
  w.api.moSbSetStage('sb1', 'confirm');
  await w.api.moSbApplyBudget('sb1');
  ok(w.api.sbApply.sb1 && w.api.sbApply.sb1.stage === 'error',
     'a success reply with the budget unchanged is shown as a failure, not as done',
     'this is a new write path, so only a confirmed new value counts');
  ok(/unchanged/.test(w.api.sbApply.sb1.message || ''), 'saying the budget did not change');
}

{
  const w = boot({ sbRows: [sbRow],
                   updateReply: (body, reply) => reply(200, { success: false, stage: 'conflict',
                     conflicts: [{ field: 'dailyBudget', youSaw: 20, amazonHasNow: 30 }] }) });
  await w.api.moFetch();
  w.api.moSbSetStage('sb1', 'confirm');
  await w.api.moSbApplyBudget('sb1');
  const msg = (w.api.sbApply.sb1 || {}).message || '';
  ok(/\$30/.test(msg) && /\$20/.test(msg),
     'a conflict names what Amazon has now and what the page showed', msg);
}

{
  const w = boot({ sbRows: [{ ...sbRow, action: 'hold', recommendedBudget: null }] });
  await w.api.moFetch();
  const cell = w.api.moSbActionCell({ ...sbRow, action: 'hold', recommendedBudget: null });
  ok(/Hold/.test(cell) && !/data-mo-sb-apply/.test(cell),
     'a campaign on Hold has no button to press');
}

console.log(fails === 0 ? '\nmonthly-page: all assertions pass\n' : `\nmonthly-page: ${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
