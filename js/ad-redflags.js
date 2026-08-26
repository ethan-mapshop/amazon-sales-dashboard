    // ─── AD RED FLAGS ────────────────────────────────────────────────────────
    // Weekly Red Flag Monitor. Four fixed threshold checks over the most
    // recent complete Mon–Sun week, computed server-side by the red-flag
    // section of /api/adspend (it lives there because Vercel's Hobby plan
    // caps a deployment at 12 serverless functions).
    //
    // Amazon's report generation is asynchronous and takes minutes, so this
    // module drives the request → poll → collect cycle from the browser and
    // keeps the in-flight report IDs (and the last computed result) in
    // localStorage. Nothing is persisted server-side.
    //
    // loadAdRedFlags() NEVER starts a run — it renders the cache and waits for
    // the user. showPage() and triggerCurrentPageLoad() both fire on restore
    // and after sign-in, and auto-running there would burn Amazon report quota
    // and earn a 425 duplicate rejection on the next real run.

    const ARF_RUN_KEY = 'arfRunState';
    const ARF_RESULT_KEY = 'arfLastResult';
    const ARF_POLL_MS = 20000;
    const ARF_POLL_SLOW_MS = 30000;
    const ARF_MAX_WAIT_MS = 45 * 60 * 1000;

    let arfPollTimer = null;
    let arfBusy = false;

    function loadAdRedFlags() {
      const container = document.getElementById('adredflags-content');
      if (!container) return;

      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Sign in to view ad red flags.</div>';
        return;
      }

      const cached = arfCacheLoad();
      if (cached) arfRender(cached);
      else arfRenderIdle();

      // Resume a run that was in flight when the tab closed.
      const state = arfRunLoad();
      if (state && !arfPollTimer) {
        arfSetStatus('Resuming report run started ' + _svTimeAgo(state.startedAt) + '…');
        arfSchedulePoll(0);
      }
    }

    // The run button is a dispatcher. While a run is in flight it resumes
    // polling instead of requesting again — Amazon rejects an identical report
    // while the prior one is still generating (425), so re-requesting kills the
    // reports you are waiting on and silently restarts the clock on whatever
    // slipped through.
    function arfButtonClick() {
      if (arfRunLoad()) arfResume();
      else arfRun();
    }

    function arfResume() {
      const state = arfRunLoad();
      if (!state) return arfRun();
      state.pollUntil = Date.now() + ARF_MAX_WAIT_MS;
      arfRunSave(state);
      arfSetBusy(true);
      arfSetStatus('Checking report status…');
      arfSchedulePoll(0);
    }

    // Abandons the in-flight report IDs and requests a fresh set. Only correct
    // once Amazon has finished (or failed) the previous ones — otherwise the
    // new requests are duplicates.
    function arfStartOver() {
      arfRunClear();
      arfSetStatus('');
      arfSetBusy(false);
      arfRun();
    }

    async function arfRun() {
      if (arfBusy) return;
      if (!accessToken) return;
      if (arfRunLoad()) return arfResume();
      arfBusy = true;
      arfSetBusy(true);

      try {
        // Step 0 — freshen the campaign configuration snapshot. The checks read
        // daily budget, brand and portfolio from it, and it decides WHICH
        // campaigns get evaluated at all, so a stale census silently shrinks
        // the run. It is a config call, not a report: a second or two.
        arfSetStatus('Refreshing campaign configuration…');
        const sync = await fetch('/api/adcampaigns?action=refresh', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const syncData = await sync.json().catch(() => ({}));
        if (!sync.ok) {
          throw new Error('Could not refresh campaign configuration: ' +
                          (syncData.error || `HTTP ${sync.status}`));
        }

        arfSetStatus('Requesting reports from Amazon…');
        const res = await fetch('/api/adspend?action=weekly-request', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) {
          // The reason Amazon gave is in `failures`; throwing only `error`
          // reduces a specific answer to a generic sentence.
          const detail = (data.failures || [])
            .map(f => `${f.key}${f.window ? ` (${f.window})` : ''}: ${f.error}`).join(' | ');
          throw new Error(detail || data.error || `Request failed (${res.status})`);
        }

        const good = (data.reports || []).filter(r => r.reportId);
        if (!good.length) {
          const first = (data.failures || [])[0];
          if (first && (first.invalidColumns || []).length) {
            throw new Error(`Amazon refused the column ${first.invalidColumns.join(', ')}. ${first.error}`);
          }
          throw new Error((first && first.error) || 'No reports were accepted.');
        }

        const state = {
          window: data.window,
          reports: good.map(r => ({ key: r.key, reportId: r.reportId })),
          // Reported so a partial run is never mistaken for a complete one.
          failures: data.failures || [],
          startedAt: new Date().toISOString(),
          pollUntil: Date.now() + ARF_MAX_WAIT_MS
        };
        arfRunSave(state);
        arfSetStatus(`Amazon is generating ${good.length} report${good.length === 1 ? '' : 's'}. This usually takes 2–5 minutes.`);
        arfSchedulePoll(ARF_POLL_MS);
      } catch (err) {
        console.error('[ARF] run failed:', err);
        arfSetStatus('', err.message);
        arfSetBusy(false);
      } finally {
        arfBusy = false;
      }
    }

    function arfSchedulePoll(delay) {
      clearTimeout(arfPollTimer);
      arfPollTimer = setTimeout(arfPoll, delay);
    }

    async function arfPoll() {
      const state = arfRunLoad();
      if (!state) { arfSetBusy(false); return; }
      if (!accessToken) return;

      const elapsed = Date.now() - new Date(state.startedAt).getTime();
      if (Date.now() > (state.pollUntil || 0)) {
        arfSetStatus('',
          `Still waiting after ${Math.round(elapsed / 60000)} minutes. Amazon is generating these ` +
          `— press Check again to keep waiting. Do not start over until they finish or fail, ` +
          `or the new requests come back as duplicates.`,
          state.lastStatuses);
        arfSetBusy(false, 'Check again');
        return;
      }

      try {
        const res = await fetch(`/api/adspend?action=weekly-status&reports=${encodeURIComponent(arfReportsParam(state))}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Status check failed (${res.status})`);

        const ready = (data.statuses || []).filter(s => s.done).length;
        const total = (data.statuses || []).length;

        if (data.allDone) {
          arfSetStatus('Reports ready — computing checks…');
          await arfCollect(state);
          return;
        }

        state.lastStatuses = data.statuses || [];
        arfRunSave(state);
        arfSetStatus(`${ready} of ${total} reports ready — ${Math.round(elapsed / 60000)} min elapsed…`,
                     null, state.lastStatuses);
        arfSchedulePoll(elapsed > 4 * 60 * 1000 ? ARF_POLL_SLOW_MS : ARF_POLL_MS);
      } catch (err) {
        console.error('[ARF] poll failed:', err);
        // Transient failures shouldn't kill a run that Amazon is still
        // working on — keep polling and let the elapsed cap end it.
        arfSetStatus(`Status check failed (${err.message}) — retrying…`);
        arfSchedulePoll(ARF_POLL_SLOW_MS);
      }
    }

    async function arfCollect(state) {
      try {
        const w = state.window;
        const qs = `reports=${encodeURIComponent(arfReportsParam(state))}` +
                   `&weekStart=${w.weekStart}&weekEnd=${w.weekEnd}` +
                   `&baseStart=${w.baseStart}&baseEnd=${w.baseEnd}`;
        const res = await fetch(`/api/adspend?action=weekly-collect&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Collect failed (${res.status})`);

        // A report that never got requested is a hole in the run, and only the
        // request step knows about it.
        data.notes = [...(data.notes || []),
          ...(state.failures || []).map(f => ({ key: f.key, note: 'report not requested: ' + f.error }))];
        arfCacheSave(data);
        arfRunClear();
        arfSetStatus('');
        arfSetBusy(false);
        arfRender(data);
      } catch (err) {
        console.error('[ARF] collect failed:', err);
        // The download URLs are short-lived, so a failed collect usually means
        // the run has to start over rather than be retried.
        arfRunClear();
        arfSetStatus('', err.message);
        arfSetBusy(false);
      }
    }

    function arfReportsParam(state) {
      return state.reports.map(r => `${r.key}:${r.reportId}`).join(',');
    }

    // ─── RENDER ──────────────────────────────────────────────────────────────
    // The cadence doc specifies the output precisely: "A single short note
    // identifying any triggered red flags. No spreadsheets, no tables of
    // healthy campaigns... organized as four sections — one per red flag check
    // — with 'No flags' written for any check that did not trigger. A clean
    // week produces a note one paragraph long."
    //
    // So this renders prose, not a dashboard. Each flagged item gets exactly
    // the fields the doc's "Report format" line names for its check, and
    // nothing else.

    function arfRenderIdle() {
      const container = document.getElementById('adredflags-content');
      if (!container) return;
      container.innerHTML = `
        <div class="card card-flat" style="text-align: center; padding: 4rem 2rem;">
          <div style="font-size: 2.5rem; opacity: 0.35; margin-bottom: 1rem;">🚩</div>
          <div style="color: var(--text-secondary); max-width: 44rem; margin: 0 auto; line-height: 1.6;">
            Four checks over the most recent complete Monday&ndash;Sunday week:
            budget cap emergencies, runaway spenders, stalled campaigns, and brand pacing.
            Observational only &mdash; adjustments belong to the bi-weekly cadence.
            Amazon generates the reports on request, which takes a few minutes.
          </div>
        </div>`;
    }

    function arfRender(data) {
      const container = document.getElementById('adredflags-content');
      if (!container) return;

      const w = data.window || {};
      arfSetBlurb(`Week of ${w.weekStart} to ${w.weekEnd} · generated ${
        data.generatedAt ? _svTimeAgo(data.generatedAt) : 'just now'}`);

      // "If no check triggers anywhere, write a single sentence."
      const body = data.clean
        ? `<p class="arf-clean">No flags this week &mdash; all brands and campaigns within normal range.</p>`
        : arfSections(data);

      container.innerHTML = `
        <div class="card arf-note">
          <div class="arf-note-head">
            <h3>Red Flag Monitor</h3>
            <div class="arf-note-window">
              Week of ${escapeHtml(w.weekStart)} &ndash; ${escapeHtml(w.weekEnd)}
              · baseline ${escapeHtml(w.baseStart)} &ndash; ${escapeHtml(w.baseEnd)}
            </div>
          </div>
          ${body}
          ${arfFooter(data)}
        </div>`;

      arfBindActions();
    }

    // Each check is a table. Anything identical on every row — what to do
    // about the flag, where to look first — belongs in the section header, not
    // repeated down a column.
    function arfSections(data) {
      const f = data.flags || {};
      return [
        arfSection('1 · Budget cap emergencies', f.budgetCap,
          'Profitable campaigns whose daily budget is routinely the binding constraint. ' +
          'A day counts as at cap when spend reaches 95% of the daily budget — including ' +
          'days over it, since Amazon averages across the month and an overshoot means ' +
          'demand exceeded the budget. The suggested raise is a step — 25% at four days at cap, ' +
          'rising to 50% at seven, never below the best single day it already managed — because ' +
          'real demand for a capped campaign cannot be measured. Applying it writes to Amazon.',
          [C('Campaign'), C('Ad'), C('Brand'), R('Budget/day'), R('7-day spend'),
           R('At cap'), R('ACoS'), R('Retention'), R('Raise to')],
          arfBudgetCapRow),

        arfSection('2 · Runaway spenders', f.runaway,
          'Spend well above the trailing average with poor profit retention. Look for bid ' +
          'automation overreactions, keyword spikes, or search term explosions.',
          [C('Campaign'), C('Ad'), C('Brand'), R('7-day spend'), R('Trailing avg'),
           R('Multiple'), R('ACoS'), R('Retention')],
          arfRunawayRow),

        arfSection('3 · Stalled', f.stalled,
          'Clicks without orders — usually a listing problem rather than an ad problem. ' +
          'Check inventory, Buy Box, reviews and pricing before touching the ads.',
          [C('Portfolio'), C('Brand'), R('Clicks'), R('7-day spend'), R('Campaigns')],
          arfStalledRow),

        arfSection('4 · Brand pacing', f.brandPacing,
          'Brand spend against its trailing weekly average. Above baseline, look for a bid or ' +
          'budget increase, a portfolio cap lifting, or seasonal demand; below, look for a ' +
          'portfolio budget cap, a paused campaign, or lost impression share.',
          [C('Brand'), R('7-day spend'), R('Trailing avg'), R('Change')],
          arfPacingRow)
      ].join('');
    }

    // Column definitions. Numbers right-align so they can be compared down the
    // column, which is the only reason to use a table here at all.
    function C(label) { return { label, align: 'left' }; }
    function R(label) { return { label, align: 'right' }; }

    // "with 'No flags' written for any check that did not trigger"
    function arfSection(title, rows, guidance, cols, rowFn) {
      const list = rows || [];
      if (!list.length) {
        return `<section class="arf-section">
          <h4>${title}</h4>
          <p class="arf-none">No flags this week.</p>
        </section>`;
      }
      return `<section class="arf-section">
        <h4>${title}</h4>
        <p class="arf-blurb">${guidance}</p>
        <div class="arf-table-wrap">
          <table class="table-fill arf-table">
            <thead><tr>${cols.map(c =>
              `<th${c.align === 'right' ? ' class="arf-r"' : ''}>${c.label}</th>`).join('')}</tr></thead>
            <tbody>${list.map(rowFn).join('')}</tbody>
          </table>
        </div>
      </section>`;
    }

    // Doc's report format: campaign name, current daily budget, 7-day spend,
    // ACoS, profit retention. Amazon's estimated missed-sales range is
    // console-only and has no API field, so it cannot appear here.
    //
    // "5 of 7" rather than a percentage: the column counts days, and a
    // percentage here would read as time-in-budget, which this is not.
    function arfBudgetCapRow(r) {
      return `<tr>
        <td class="arf-name">${escapeHtml(r.campaign)}</td>
        <td>${escapeHtml(r.adProduct || '')}</td>
        <td>${escapeHtml(r.brand || '—')}</td>
        <td class="arf-r">${arfMoney(r.dailyBudget)}</td>
        <td class="arf-r">${arfMoney(r.spend7)}</td>
        <td class="arf-r arf-em">${r.cappedDays} of ${r.weekDays}</td>
        <td class="arf-r">${arfPct(r.acos)}</td>
        <td class="arf-r arf-em">${arfPct(r.retention)}</td>
        <td class="arf-r arf-action">${arfRecommendCell(r)}</td>
      </tr>`;
    }

    // Doc's report format: campaign name, 7-day spend, trailing average,
    // multiplier, current profit retention.
    function arfRunawayRow(r) {
      return `<tr>
        <td class="arf-name">${escapeHtml(r.campaign)}</td>
        <td>${escapeHtml(r.adProduct || '')}</td>
        <td>${escapeHtml(r.brand || '—')}</td>
        <td class="arf-r">${arfMoney(r.spend7)}</td>
        <td class="arf-r">${arfMoney(r.baselineWeekly)}</td>
        <td class="arf-r arf-em">${r.spendMultiple}&times;</td>
        <td class="arf-r">${arfPct(r.acos)}</td>
        <td class="arf-r arf-em">${arfPct(r.retention)}</td>
      </tr>`;
    }

    // Doc's report format: campaign name, 7-day clicks, spend, associated
    // SKU(s), and a suggested first area to check. SKUs are not in the campaign
    // report; portfolio is one-per-SKU in this account, so the portfolio name
    // identifies the product. The campaign names sit under it rather than in
    // their own column — they are the evidence for the row, not a value to
    // compare down a column.
    function arfStalledRow(r) {
      const names = (r.campaigns || []).map(c => c.campaign).join(', ');
      return `<tr>
        <td class="arf-name">
          ${escapeHtml(r.portfolio)}
          <div class="arf-sub">${escapeHtml(names)}</div>
        </td>
        <td>${escapeHtml(r.brand || '—')}</td>
        <td class="arf-r arf-em">${r.clicks7}</td>
        <td class="arf-r">${arfMoney(r.spend7)}</td>
        <td class="arf-r">${r.campaignCount}</td>
      </tr>`;
    }

    // Doc's report format: brand name, 7-day spend, trailing average, %
    // change, and a brief likely-cause hypothesis. The hypothesis is the same
    // two possibilities every time, so it lives in the section header and the
    // row states the direction.
    function arfPacingRow(r) {
      const up = r.deviation > 0;
      return `<tr>
        <td class="arf-name">${escapeHtml(r.brand)}</td>
        <td class="arf-r">${arfMoney(r.spend7)}</td>
        <td class="arf-r">${arfMoney(r.baselineWeekly)}</td>
        <td class="arf-r arf-em ${up ? 'arf-up' : 'arf-down'}">${up ? '+' : ''}${arfPct(r.deviation)}</td>
      </tr>`;
    }

    // The run's own receipt — one line, so a run that covered half the account
    // cannot look identical to a clean week. Not a report of healthy campaigns.
    function arfFooter(data) {
      const c = data.coverage || {};
      const bits = [
        `all ${c.enabled} enabled campaigns evaluated`,
        typeof c.withSpend === 'number' ? `${c.withSpend} spent anything this week` : null,
        c.unmapped && c.unmapped.length ? `${c.unmapped.length} unmapped to a brand` : null,
        c.noBudget && c.noBudget.length ? `${c.noBudget.length} with no daily budget` : null,
        c.orphanRows ? `${c.orphanRows} report rows for campaigns not in the snapshot` : null
      ].filter(Boolean);

      const warn = [];
      // An unmapped campaign has no margin, so it has no profit retention and
      // silently cannot trip checks 1 or 2. Saying so is the difference between
      // "nothing wrong" and "not looked at".
      if (c.unmapped && c.unmapped.length) {
        warn.push(`Not evaluated for retention (no brand, so no margin): ${
          c.unmapped.map(x => `${escapeHtml(x.campaign)} (${arfMoney(x.spend7)})`).join(', ')}`);
      }
      if (c.noBudget && c.noBudget.length) {
        // The server distinguishes a missing budget from a lifetime one; they
        // are different facts and lumping them loses the reason.
        warn.push(`Not evaluated for budget cap: ${c.noBudget
          .map(x => `${escapeHtml(x.campaign)} (${escapeHtml(x.reason || 'no daily budget')})`)
          .join(', ')}`);
      }
      if (c.orphanRows) {
        warn.push('Some report rows belong to campaigns missing from the snapshot — refresh Campaign Overview.');
      }

      return `
        <div class="arf-footer">
          <div>${escapeHtml(bits.join(' · '))}</div>
          ${warn.map(w => `<div class="arf-warn">${w}</div>`).join('')}
          ${(data.notes || []).map(n =>
            `<div class="arf-warn">${escapeHtml(n.key)}: ${escapeHtml(n.note)}</div>`).join('')}
          ${(data.deviations || []).map(d =>
            `<div class="arf-muted">Deviation from the cadence doc: ${escapeHtml(d)}</div>`).join('')}
          ${data.censusSyncedAt
            ? `<div class="arf-muted">Campaign configuration synced ${escapeHtml(_svTimeAgo(data.censusSyncedAt))}</div>`
            : ''}
        </div>`;
    }

    // ─── APPLY A RECOMMENDATION ──────────────────────────────────────────────
    // The cadence is observational and stays that way — nothing here changes
    // unless you press the button. It is a deliberate exception, not a drift
    // into acting: one campaign, one field, one confirmation.
    //
    // State lives here rather than in the DOM because arfRender replaces the
    // container wholesale; a confirm prompt or a result would otherwise vanish
    // on the next render.
    let arfApply = {};      // { [campaignId]: { stage, message, applied } }
    let arfBound = false;

    // The recommended budget and its button share a cell: the number is the
    // thing you are agreeing to, so putting it anywhere else invites agreeing
    // to something you did not read.
    function arfRecommendCell(r) {
      const st = arfApply[r.campaignId] || {};
      const id = escapeHtml(r.campaignId);

      // Before the no-recommendation guard: applying CLEARS the recommendation,
      // so checking that first would report a successful raise as a dash.
      if (st.stage === 'done') {
        return `<span class="arf-applied">&#10003; now $${escapeHtml(String(st.applied))}/day</span>`;
      }
      if (!r.recommendedBudget) return '<span class="arf-muted">—</span>';
      if (st.stage === 'busy') {
        return `<span class="loading"></span>`;
      }
      if (st.stage === 'confirm') {
        return `<span class="arf-confirm">
          <span>$${r.recommendedBudget}/day?</span>
          <button class="arf-btn arf-btn-go" data-arf-confirm="${id}">Confirm</button>
          <button class="arf-btn" data-arf-cancel="${id}">Cancel</button>
        </span>`;
      }
      return `<button class="arf-btn" data-arf-apply="${id}"
                title="Raise this campaign's daily budget on Amazon to $${r.recommendedBudget}"
              >$${r.recommendedBudget}/day</button>${
        st.stage === 'error' ? `<div class="arf-warn">${escapeHtml(st.message)}</div>` : ''}`;
    }

    function arfBindActions() {
      // The container element persists across renders — only its innerHTML is
      // replaced — so binding on every render would stack duplicate handlers.
      if (arfBound) return;
      const c = document.getElementById('adredflags-content');
      if (!c) return;
      c.addEventListener('click', e => {
        const btn = e.target.closest('[data-arf-apply], [data-arf-confirm], [data-arf-cancel]');
        if (!btn) return;
        const d = btn.dataset;
        if (d.arfApply)        arfSetApplyStage(d.arfApply, 'confirm');
        else if (d.arfCancel)  arfSetApplyStage(d.arfCancel, null);
        else if (d.arfConfirm) arfApplyBudget(d.arfConfirm);
      });
      arfBound = true;
    }

    function arfSetApplyStage(campaignId, stage, extra) {
      if (!stage) delete arfApply[campaignId];
      else arfApply[campaignId] = { stage, ...(extra || {}) };
      const cached = arfCacheLoad();
      if (cached) arfRender(cached);
    }

    async function arfApplyBudget(campaignId) {
      const cached = arfCacheLoad();
      const row = ((cached && cached.flags && cached.flags.budgetCap) || [])
        .find(r => String(r.campaignId) === String(campaignId));
      if (!row || !accessToken) return;

      arfSetApplyStage(campaignId, 'busy');
      try {
        // The Campaign Overview write path, unchanged: it re-reads the campaign
        // from Amazon, refuses if the budget has moved since this page loaded,
        // and verifies the change by reading it back.
        const res = await fetch('/api/adcampaigns?action=update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            campaignId: row.campaignId,
            adProduct: row.adProduct,
            local: {},
            amazon: { dailyBudget: row.recommendedBudget },
            // What this page displayed. Reports take minutes to generate, so
            // the budget really can move between the run and the button.
            expected: { dailyBudget: row.dailyBudget }
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          if (data.conflicts && data.conflicts.length) {
            const c0 = data.conflicts[0];
            throw new Error(`Amazon now has ${c0.field} = ${c0.amazonHasNow ?? '—'} ` +
                            `(this page saw ${c0.youSaw ?? '—'}). Re-run the check.`);
          }
          throw new Error(data.error || `Failed (${res.status})`);
        }

        // Keep the cached run truthful: the budget on screen is now stale, and
        // this row's own recommendation no longer applies to it.
        row.dailyBudget = row.recommendedBudget;
        row.recommendedBudget = null;
        arfCacheSave(cached);
        arfApply[campaignId] = { stage: 'done', applied: row.dailyBudget };
        arfRender(cached);
      } catch (err) {
        console.error('[ARF] budget raise failed:', err);
        arfSetApplyStage(campaignId, 'error', { message: err.message });
      }
    }

    function arfMoney(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return '$' + formatNumber(Math.round(n * 100) / 100);
    }

    // Ratios arrive as fractions; retention and deviation can both be negative.
    function arfPct(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return Math.round(n * 100) + '%';
    }

    function arfSetStatus(message, error, details) {
      const el = document.getElementById('arf-status');
      if (!el) return;
      const parts = [];
      if (error) parts.push(`<div style="color: var(--error);">${escapeHtml(error)}</div>`);
      else if (message) parts.push(`<div>${escapeHtml(message)}</div>`);

      if (details && details.length) {
        parts.push('<div style="margin-top: 0.4rem; font-family: monospace; font-size: 0.75rem;">' +
          details.map(d => `${escapeHtml(d.key)}: ${escapeHtml(d.status || '—')}`).join('  ·  ') +
          '</div>');
      }
      // Only offered while a run is stored — starting over mid-generation is
      // what produces the duplicate rejections.
      if (arfRunLoad()) {
        parts.push('<div style="margin-top: 0.4rem;">' +
          '<a onclick="arfStartOver()" style="cursor: pointer; text-decoration: underline;">' +
          'Abandon these and request fresh reports</a></div>');
      }
      el.innerHTML = parts.join('');
      el.style.display = parts.length ? 'block' : 'none';
    }

    function arfSetBlurb(text) {
      const el = document.getElementById('adredflags-blurb');
      if (el) el.textContent = text;
    }

    function arfSetBusy(busy, label) {
      const btn = document.getElementById('arf-run-btn');
      if (!btn) return;
      btn.disabled = !!busy;
      btn.textContent = busy ? 'Running…' : (label || 'Run weekly check');
    }

    // ─── LOCAL CACHE ─────────────────────────────────────────────────────────
    // Report download URLs expire, so the computed result is what gets cached —
    // a page refresh then costs nothing instead of forcing a fresh run.

    function arfCacheSave(data) {
      try { localStorage.setItem(ARF_RESULT_KEY, JSON.stringify(data)); } catch { /* quota */ }
    }

    function arfCacheLoad() {
      try {
        const raw = localStorage.getItem(ARF_RESULT_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    }

    function arfRunSave(state) {
      try { localStorage.setItem(ARF_RUN_KEY, JSON.stringify(state)); } catch { /* quota */ }
    }

    function arfRunLoad() {
      try {
        const raw = localStorage.getItem(ARF_RUN_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    }

    function arfRunClear() {
      clearTimeout(arfPollTimer);
      arfPollTimer = null;
      try { localStorage.removeItem(ARF_RUN_KEY); } catch { /* ignore */ }
    }
