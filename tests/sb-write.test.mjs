// The Sponsored Brands daily budget write.
//
// This is a new write to Amazon, and the one part of the monthly change that
// can move real money the wrong way. Amazon's API is stubbed here at the fetch
// level, so these tests pin what is actually SENT: which URL, which content
// type, and the body shape. SB v4 takes a flat budget where SP v3 nests it, and
// getting that wrong is the likeliest way this breaks.
import { loadAdcampaigns } from './harness.mjs';

const { M, cleanup } = await loadAdcampaigns('sbw');

let fails = 0;
const ok = (c, l, d = '') => { if (!c) fails++; console.log(`  ${c ? 'OK  ' : 'FAIL'} ${l}${d ? '  ' + d : ''}`); };

// ─── A FAKE AMAZON ───────────────────────────────────────────────────────────

const ID = '555000111';

function amazon({ budget = 20, budgetType = 'DAILY', putResponse, ignoreWrite = false,
                  listFails = false } = {}) {
  const server = { budget, budgetType, name: 'SB Kings Maps', state: 'ENABLED' };
  const calls = [];
  const reply = (status, body) => ({
    ok: status >= 200 && status < 300, status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => body
  });

  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ url: u, method: init.method || 'GET', headers: init.headers || {}, body: init.body });

    if (u.includes('/auth/o2/token')) return reply(200, { access_token: 'tok' });

    if (u.endsWith('/sb/v4/campaigns/list')) {
      if (listFails) return reply(500, { message: 'down' });
      return reply(200, { campaigns: [
        // SB v4 returns the budget FLAT, with budgetType beside it.
        { campaignId: ID, name: server.name, state: server.state,
          budget: server.budget, budgetType: server.budgetType },
        { campaignId: '999', name: 'SB Other', state: 'ENABLED', budget: 5, budgetType: 'DAILY' }
      ] });
    }

    if (u.endsWith('/sb/v4/campaigns') && init.method === 'PUT') {
      if (putResponse) return putResponse();
      const body = JSON.parse(init.body);
      if (!ignoreWrite) server.budget = body.campaigns[0].budget;
      return reply(207, { campaigns: { success: [{ campaignId: ID }], error: [] } });
    }

    return reply(404, { message: 'unexpected ' + u });
  };
  return { server, calls, reply };
}

const puts = (calls) => calls.filter(c => c.method === 'PUT');

// ─── WHAT IS SENT ────────────────────────────────────────────────────────────

console.log('\nTHE REQUEST  — what actually goes to Amazon');

{
  const a = amazon({ budget: 20 });
  const r = await M.acWriteSbBudget({ campaignId: ID, amazon: { dailyBudget: 25 }, expected: { dailyBudget: 20 } });
  const put = puts(a.calls)[0];

  ok(r.ok === true, 'a clean budget change succeeds');
  ok(!!put && put.url.endsWith('/sb/v4/campaigns'),
     'the write goes to the SB v4 campaigns URL',
     'not the /list URL: PUTting to that fails as a misleading Authorization error');
  ok(put && put.headers['Content-Type'] === 'application/vnd.sbcampaignresource.v4+json',
     'with the SB v4 content type');

  const body = put ? JSON.parse(put.body) : {};
  const item = (body.campaigns || [])[0] || {};
  ok(item.campaignId === ID && item.budget === 25 && item.budgetType === 'DAILY',
     'the body carries the id, a flat budget, and the budget type',
     JSON.stringify(item));
  ok(typeof item.budget === 'number',
     'the budget is a plain number, not the nested object SP uses',
     'SB v4 would reject { budget: { budget, budgetType } }');
  ok(Object.keys(item).sort().join(',') === 'budget,budgetType,campaignId',
     'and nothing else rides along to overwrite',
     Object.keys(item).join(','));
}

// ─── VERIFY ──────────────────────────────────────────────────────────────────

console.log('\nVERIFY  — success means Amazon reported the new value back');

{
  const a = amazon({ budget: 20 });
  const r = await M.acWriteSbBudget({ campaignId: ID, amazon: { dailyBudget: 25 }, expected: { dailyBudget: 20 } });
  ok(r.applied && r.applied.dailyBudget && r.applied.dailyBudget.from === 20 && r.applied.dailyBudget.to === 25,
     'the result reports the budget as it was and as Amazon now has it');
  ok(r.notApplied.length === 0 && r.collateral.length === 0, 'with nothing unapplied and nothing else moved');
}

{
  // Amazon returns success but the value never changes.
  amazon({ budget: 20, ignoreWrite: true });
  const r = await M.acWriteSbBudget({ campaignId: ID, amazon: { dailyBudget: 25 }, expected: { dailyBudget: 20 } });
  ok(!r.applied.dailyBudget && r.notApplied.some(n => n.field === 'dailyBudget'),
     'a write Amazon accepts but does not apply is reported as not applied',
     'a 200 alone is not proof, and the page treats this as a failure');
}

{
  // A 207 whose only item is an error.
  const a = amazon({ budget: 20 });
  a.calls.length = 0;
  globalThis.fetch = (orig => async (url, init) => {
    if (String(url).endsWith('/sb/v4/campaigns') && init.method === 'PUT') {
      return a.reply(207, { campaigns: { success: [], error: [{ campaignId: ID, errorValue: 'budget below minimum' }] } });
    }
    return orig(url, init);
  })(globalThis.fetch);
  const r = await M.acWriteSbBudget({ campaignId: ID, amazon: { dailyBudget: 0.5 }, expected: { dailyBudget: 20 } });
  ok(r.ok === false, 'a per-campaign error inside a 207 is a failure, not a success');
}

// ─── REFUSALS ────────────────────────────────────────────────────────────────

console.log('\nREFUSALS  — nothing is written unless it is safe to write');

{
  const a = amazon({ budget: 30 });
  const r = await M.acWriteSbBudget({ campaignId: ID, amazon: { dailyBudget: 25 }, expected: { dailyBudget: 20 } });
  ok(r.ok === false && r.stage === 'conflict',
     'if the budget changed since the page loaded, it refuses',
     'the page showed $20; Amazon now has $30');
  ok(puts(a.calls).length === 0, 'and writes nothing');
  ok(r.conflicts[0].youSaw === 20 && r.conflicts[0].amazonHasNow === 30,
     'naming both values, so the page can say what moved');
}

{
  const a = amazon({ budget: 500, budgetType: 'LIFETIME' });
  const r = await M.acWriteSbBudget({ campaignId: ID, amazon: { dailyBudget: 25 }, expected: { dailyBudget: 500 } });
  ok(r.ok === false && puts(a.calls).length === 0,
     'a lifetime budget is refused rather than overwritten as a daily one');
}

{
  const a = amazon();
  const r = await M.acWriteSbBudget({ campaignId: 'not-there', amazon: { dailyBudget: 25 }, expected: {} });
  ok(r.ok === false && r.stage === 'read' && puts(a.calls).length === 0,
     'a campaign Amazon no longer returns is refused before any write');
}

{
  const a = amazon({ listFails: true });
  const r = await M.acWriteSbBudget({ campaignId: ID, amazon: { dailyBudget: 25 }, expected: {} });
  ok(r.ok === false && r.stage === 'read' && puts(a.calls).length === 0,
     'if the campaign cannot be read, nothing is written');
}

{
  const a = amazon();
  const zero = await M.acWriteSbBudget({ campaignId: ID, amazon: { dailyBudget: 0 }, expected: {} });
  ok(zero.ok === false && zero.stage === 'validate' && a.calls.length === 0,
     'a zero budget is refused before Amazon is even contacted');
}

console.log('\nROUTING  — Sponsored Brands can change its budget and nothing else');

{
  const a = amazon();
  const r = await M.acWriteAmazonFields({
    campaignId: ID, row: { adProduct: 'SB' }, amazon: { name: 'Renamed' }, expected: {}
  });
  ok(r.ok === false && r.stage === 'validate' && a.calls.length === 0,
     'a name change on a Sponsored Brands campaign is refused without calling Amazon');
}

{
  const a = amazon();
  const r = await M.acWriteAmazonFields({
    campaignId: ID, row: { adProduct: 'SB' }, amazon: { dailyBudget: 25, state: 'PAUSED' }, expected: {}
  });
  ok(r.ok === false && puts(a.calls).length === 0,
     'and so is a budget change bundled with anything else');
}

{
  amazon({ budget: 20 });
  const r = await M.acWriteAmazonFields({
    campaignId: ID, row: { adProduct: 'SB' }, amazon: { dailyBudget: 25 }, expected: { dailyBudget: 20 }
  });
  ok(r.ok === true && r.applied.dailyBudget.to === 25,
     'a budget-only change on Sponsored Brands is routed through to the SB write');
}

cleanup();
console.log(fails === 0 ? '\nsb-write: all assertions pass\n' : `\nsb-write: ${fails} FAILED\n`);
process.exit(fails === 0 ? 0 : 1);
