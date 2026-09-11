    // ─── BI-WEEKLY BUDGETS ───────────────────────────────────────────────────
    // Tactical budget management. Unlike the weekly, this cadence ACTS: every
    // enabled campaign gets Increase, Decrease, Hold or Cut, and each row can
    // be written to Amazon.
    //
    // The window is lagged 8 days on purpose — see the server section. Amazon
    // leaves conversions incomplete for a week, always understating them, and
    // Tier 1 cuts a campaign to $1 on "zero orders". A fresh window would floor
    // healthy campaigns whose sales had not landed.
    //
    // Everything is prefixed `bw`. These files share one global scope, so
    // escapeHtml / formatNumber / _svTimeAgo are CALLED, never redefined.
    //
    // loadAdBiweekly() NEVER starts a run. showPage() and triggerCurrentPageLoad()
    // both fire on restore and after sign-in.

    const BW_RUN_KEY = 'bwRunState';
    const BW_RESULT_KEY = 'bwLastResult';
    const BW_POLL_MS = 20000;
    const BW_MAX_WAIT_MS = 45 * 60 * 1000;

    let bwPollTimer = null;
    let bwBusy = false;
    let bwApply = {};        // { [campaignId]: { stage, message, applied } }
    let bwBound = false;
    let bwFilter = 'moves';  // 'moves' | 'all'
    let bwBrand = 'all';     // 'all' | a brand name | '(unmapped)'
    // Campaign ids ticked for a bulk write. Held as a Set rather than read off
    // the DOM because the table is re-rendered on every filter change and after
    // every apply, and a selection that vanished on re-render would be worse
    // than no selection at all.
    let bwSelected = new Set();
    let bwBulkBusy = false;
    let bwBulkConfirm = false;
    let bwBulkProgress = '';
    let bwRecomputing = false;

    function loadAdBiweekly() {
      const container = document.getElementById('adbiweekly-content');
      if (!container) return;
      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Sign in to view bi-weekly budgets.</div>';
        return;
      }
      const cached = bwCacheLoad();
      if (cached) bwRender(cached); else bwRenderIdle();

      const state = bwRunLoad();
      if (state && !bwPollTimer) {
        bwSetStatus(bwStatusLine(state.lastStatuses, state.startedAt));
        bwSchedulePoll(0);
      }
    }

    // While a run is in flight the button resumes rather than re-requesting:
    // Amazon rejects an identical report while the prior one is generating.
    function bwButtonClick() {
      if (bwRunLoad()) bwResume(); else bwRun();
    }

    function bwResume() {
      const state = bwRunLoad();
      if (!state) return bwRun();
      state.pollUntil = Date.now() + BW_MAX_WAIT_MS;
      state.pollErrors = 0;
      bwRunSave(state);
      bwSetBusy(true);
      bwSetStatus(bwStatusLine(state.lastStatuses, state.startedAt));
      bwSchedulePoll(0);
    }

    async function bwRun() {
      if (bwBusy || !accessToken) return;
      if (bwRunLoad()) return bwResume();
      bwBusy = true;
      bwSetBusy(true);
      try {
        // The tree reads budgets, brands and portfolios from the census, and it
        // decides WHICH campaigns are evaluated, so a stale one silently
        // shrinks the run.
        bwSetStatus('Refreshing campaign configuration…');
        const sync = await fetch('/api/adcampaigns?action=refresh', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const syncData = await sync.json().catch(() => ({}));
        if (!sync.ok) throw new Error('Could not refresh campaign configuration: ' +
                                      (syncData.error || `HTTP ${sync.status}`));

        bwSetStatus('Requesting reports from Amazon…');
        const res = await fetch('/api/adspend?action=biweekly-request', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) {
          const detail = (data.failures || [])
            .map(f => `${f.key}${f.window ? ` (${f.window})` : ''}: ${f.error}`).join(' | ');
          throw new Error(detail || data.error || `Request failed (${res.status})`);
        }
        const good = (data.reports || []).filter(r => r.reportId);
        if (!good.length) throw new Error((data.failures || [])[0]?.error || 'No reports were accepted.');

        bwRunSave({
          window: data.window,
          reports: good.map(r => ({ key: r.key, reportId: r.reportId })),
          failures: data.failures || [],
          startedAt: new Date().toISOString(),
          pollUntil: Date.now() + BW_MAX_WAIT_MS
        });
        bwSetStatus(`Amazon is generating ${good.length} report${good.length === 1 ? '' : 's'}. This usually takes 2–5 minutes.`);
        bwSchedulePoll(BW_POLL_MS);
      } catch (err) {
        console.error('[BW] run failed:', err);
        bwSetStatus('', err.message);
        bwSetBusy(false);
      } finally {
        bwBusy = false;
      }
    }

    function bwSchedulePoll(delay) {
      clearTimeout(bwPollTimer);
      bwPollTimer = setTimeout(bwPoll, delay);
    }

    async function bwPoll() {
      const state = bwRunLoad();
      if (!state) return;
      if (Date.now() > state.pollUntil) {
        bwSetStatus('', 'Gave up waiting after 45 minutes. ' +
          bwStatusLine(state.lastStatuses, state.startedAt) +
          ' Press Check again to keep waiting — the reports are still queued at Amazon.');
        bwSetBusy(false);
        return;
      }
      try {
        const qs = `reports=${encodeURIComponent(state.reports.map(r => `${r.key}:${r.reportId}`).join(','))}`;
        const res = await fetch(`/api/adspend?action=biweekly-status&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Status failed (${res.status})`);

        if (data.allDone) return bwCollect(state);
        // Remembered so the give-up message can say what Amazon was doing, and
        // so a resume shows something truer than "0 of 2 ready".
        state.lastStatuses = data.statuses || [];
        state.pollErrors = 0;
        bwRunSave(state);
        bwSetStatus(bwStatusLine(state.lastStatuses, state.startedAt));
        bwSchedulePoll(BW_POLL_MS);
      } catch (err) {
        // A dropped request is not a dead run. Stopping here made one blip look
        // identical to Amazon being slow, with nothing on screen saying polling
        // had stopped.
        console.error('[BW] poll failed:', err);
        state.pollErrors = (state.pollErrors || 0) + 1;
        bwRunSave(state);
        if (state.pollErrors >= 5) {
          bwSetStatus('', `Could not reach the status endpoint after 5 tries: ${err.message}. ` +
                          'Press Check again when your connection is back.');
          bwSetBusy(false);
          return;
        }
        bwSetStatus(`Status check failed (attempt ${state.pollErrors} of 5), retrying…`);
        bwSchedulePoll(BW_POLL_MS * state.pollErrors);
      }
    }

    // What Amazon is actually doing, rather than a count of what is finished.
    // PENDING means queued and not yet started; PROCESSING means generating.
    // The difference decides whether waiting is reasonable, and it was only
    // visible from the browser console before.
    function bwStatusLine(statuses, startedAt) {
      const mins = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 60000));
      const list = statuses || [];
      if (!list.length) return `Waiting on Amazon — ${mins} min elapsed.`;

      const byState = {};
      for (const s of list) byState[s.status || 'UNKNOWN'] = (byState[s.status || 'UNKNOWN'] || 0) + 1;
      const parts = Object.entries(byState).map(([k, n]) => `${n} ${k.toLowerCase()}`);
      let line = `${parts.join(' · ')} — ${mins} min elapsed.`;

      // Queued for a long time is a fact about Amazon's queue, not about us,
      // and saying so is the difference between waiting and debugging.
      if (list.every(s => s.status === 'PENDING') && mins >= 10) {
        line += ' Amazon has not started these yet; its report queue is backed up.';
      }
      return line;
    }

    async function bwCollect(state) {
      try {
        const w = state.window;
        const qs = `reports=${encodeURIComponent(state.reports.map(r => `${r.key}:${r.reportId}`).join(','))}` +
                   `&start=${w.start}&end=${w.end}&priorStart=${w.priorStart}&priorEnd=${w.priorEnd}`;
        const res = await fetch(`/api/adspend?action=biweekly-collect&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Collect failed (${res.status})`);

        data.notes = [...(data.notes || []),
          ...(state.failures || []).map(f => ({ key: f.key, note: 'report not requested: ' + f.error }))];
        bwApply = {};
        bwSelected.clear();
        bwBulkConfirm = false;
        bwCacheSave(data);
        bwRunClear();
        bwSetStatus('');
        bwSetBusy(false);
        bwRender(data);
      } catch (err) {
        console.error('[BW] collect failed:', err);
        // Download URLs are short-lived, so a failed collect means starting over.
        bwRunClear();
        bwSetStatus('', err.message);
        bwSetBusy(false);
      }
    }

    // ─── RENDER ──────────────────────────────────────────────────────────────

    function bwRenderIdle() {
      const container = document.getElementById('adbiweekly-content');
      if (!container) return;
      container.innerHTML = `
        <div class="card card-flat" style="text-align: center; padding: 4rem 2rem;">
          <div style="font-size: 2.5rem; opacity: 0.35; margin-bottom: 1rem;">💰</div>
          <div style="color: var(--text-secondary); max-width: 44rem; margin: 0 auto; line-height: 1.6;">
            Every enabled Sponsored Products campaign gets one of Increase, Decrease, Hold or Cut,
            from a four-tier decision tree keyed on profit retention. The 14-day window
            ends eight days ago so every conversion has landed &mdash; this cadence writes
            budgets, and a fresh window would cut healthy campaigns whose sales had not
            yet been attributed.
          </div>
        </div>`;
    }

    function bwRender(data) {
      const container = document.getElementById('adbiweekly-content');
      if (!container) return;
      const w = data.window || {};
      bwSetBlurb(`${w.start} to ${w.end} · generated ${
        data.generatedAt ? _svTimeAgo(data.generatedAt) : 'just now'}`);

      const rows = bwVisibleRows(data);
      container.innerHTML =
        bwCounts(data) + bwPostureBar(data) + bwBrandSummary(data) +
        bwTable(rows, data) + bwSelectionBar(data, rows) + bwFooter(data);
      bwBindActions();
    }

    // Brand narrows first, then the changes/all toggle. Select-all reads this,
    // so a header tick can never reach a row the filters are hiding.
    //
    // Sorting happens HERE rather than on the server. Order is presentation,
    // and a server-side sort gets frozen into every stored run — so a result
    // saved before the rule changed keeps the old order forever, which is
    // exactly what happened when this moved from magnitude to alphabetical.
    function bwVisibleRows(data) {
      let all = (data.rows || []).slice()
        .sort((a, b) => String(a.campaign || '').localeCompare(String(b.campaign || ''),
                                                               'en', { numeric: true }));
      if (bwBrand !== 'all') all = all.filter(r => bwBrandOf(r) === bwBrand);
      if (bwFilter === 'all') return all;
      // A row applied this session becomes a hold, which would drop it from
      // this filter and make a successful write look like a row that vanished.
      // After a batch you need to see what landed, not infer it from absence.
      return all.filter(r => r.action !== 'hold' ||
                             (bwApply[r.campaignId] || {}).stage === 'done');
    }

    // Unmapped campaigns are a group worth filtering to: with no brand they
    // have no margin, so no retention, so the tree can only ever hold them.
    function bwBrandOf(r) { return r.brand || '(unmapped)'; }

    // Holds and already-applied rows have nothing to write.
    function bwApplicable(r) {
      const st = bwApply[r.campaignId] || {};
      return r.action !== 'hold' && r.newBudget !== null &&
             r.newBudget !== r.dailyBudget && st.stage !== 'done';
    }

    function bwCounts(data) {
      const c = data.counts || {};
      const w = data.window || {};
      const pill = (n, label, cls) =>
        `<div class="bw-pill ${cls}"><strong>${n || 0}</strong> ${label}</div>`;
      return `
        <div class="bw-head">
          <div class="bw-pills">
            ${pill(c.increase, 'increase', 'bw-up')}
            ${pill(c.decrease, 'decrease', 'bw-down')}
            ${pill(c.cut, 'cut', 'bw-cut')}
            ${pill(c.hold, 'hold', 'bw-hold')}
          </div>
          <div class="bw-window">
            14 days to ${escapeHtml(w.end)} · prior ${escapeHtml(w.priorStart)}&ndash;${escapeHtml(w.priorEnd)}
            <span class="bw-muted">lagged 8 days so conversions have landed</span>
          </div>
        </div>`;
    }

    // Monthly's Scale / Hold Steady / Constrain, per brand. Hold Steady IS the
    // documented default and means the standard tree, so a run with no monthly
    // priorities is correct rather than approximate.
    function bwPostureBar(data) {
      const brands = (data.brandSummary || []).map(b => b.brand);
      if (!brands.length) return '';
      const postures = data.postures || {};
      return `
        <div class="card card-flat bw-posture">
          <div class="bw-posture-label">
            Monthly posture
            <span class="bw-muted">Scale leans into increases · Constrain skips them and cuts harder</span>
          </div>
          <div class="bw-posture-row">
            ${brands.map(b => `
              <label class="bw-posture-brand">
                <span>${escapeHtml(b)}</span>
                <select data-bw-posture="${escapeHtml(b)}">
                  ${['hold', 'scale', 'constrain'].map(p => `
                    <option value="${p}"${(postures[b] || 'hold') === p ? ' selected' : ''}>${
                      p === 'hold' ? 'Hold steady' : p === 'scale' ? 'Scale' : 'Constrain'}</option>`).join('')}
                </select>
              </label>`).join('')}
          </div>
        </div>`;
    }

    function bwBrandSummary(data) {
      const brands = data.brandSummary || [];
      if (!brands.length) return '';
      return `
        <details class="card card-flat bw-brands">
          <summary>Brand summary</summary>
          <div class="arf-table-wrap">
            <table class="table-fill arf-table">
              <thead><tr>
                <th>Brand</th><th>Posture</th>
                <th class="arf-r">Spend</th><th class="arf-r">Sales</th>
                <th class="arf-r">Orders</th><th class="arf-r">ACoS</th><th class="arf-r">Retention</th>
              </tr></thead>
              <tbody>${brands.map(b => `
                <tr>
                  <td class="arf-name">${escapeHtml(b.brand)}</td>
                  <td>${escapeHtml(b.posture === 'hold' ? '—' : b.posture)}</td>
                  <td class="arf-r">${bwMoney(b.spend)}</td>
                  <td class="arf-r">${bwMoney(b.sales)}</td>
                  <td class="arf-r">${b.orders}</td>
                  <td class="arf-r">${bwPct(b.acos)}</td>
                  <td class="arf-r arf-em">${bwPct(b.retention)}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </details>`;
    }

    function bwTable(rows, data) {
      // The count follows the brand filter, so "All 34" while narrowed to one
      // brand does not read as a promise of the whole account.
      const brands = [...new Set((data.rows || []).map(bwBrandOf))].sort();
      const total = bwBrand === 'all'
        ? (data.rows || []).length
        : (data.rows || []).filter(r => bwBrandOf(r) === bwBrand).length;
      // Recompute re-runs the decision tree against the data this run already
      // fetched. It refreshes DECISIONS, not DATA - the reports are what take
      // half an hour, and they are unchanged.
      const canRecompute = Array.isArray(data.inputs) && data.inputs.length > 0;
      const toggle = `
        <div class="bw-filter">
          <select data-bw-brand title="Narrow to one brand">
            <option value="all"${bwBrand === 'all' ? ' selected' : ''}>All brands</option>
            ${brands.map(b => `<option value="${escapeHtml(b)}"${
              bwBrand === b ? ' selected' : ''}>${escapeHtml(b)}</option>`).join('')}
          </select>
          <button class="arf-btn${bwFilter === 'moves' ? ' arf-btn-go' : ''}" data-bw-filter="moves">Changes only</button>
          <button class="arf-btn${bwFilter === 'all' ? ' arf-btn-go' : ''}" data-bw-filter="all">All ${total}</button>
          <span class="bw-spacer"></span>
          ${canRecompute
            ? `<button class="arf-btn" data-bw-recompute${bwRecomputing ? ' disabled' : ''}
                  title="Re-run the decision tree on this run's data. Picks up posture and threshold changes without a new report."
               >${bwRecomputing ? 'Recomputing' : 'Refresh recommendations'}</button>`
            // A run collected before recompute existed has no stored inputs, so
            // there is nothing to re-decide. Say so rather than rendering
            // nothing and leaving the control to be hunted for.
            : `<button class="arf-btn" disabled
                  title="This run was collected before recommendations could be refreshed. The next run will store what is needed."
               >Refresh recommendations</button>
               <span class="arf-muted">needs a run from after this update</span>`}
          ${data.recomputedAt
            ? `<span class="arf-muted">recommendations refreshed ${escapeHtml(_svTimeAgo(data.recomputedAt))}</span>`
            : ''}
        </div>`;

      if (!rows.length) {
        return toggle + `<p class="arf-none" style="padding: 1rem 0;">No budget changes recommended this run.</p>`;
      }
      const selectable = rows.filter(bwApplicable);
      const allTicked = selectable.length > 0 && selectable.every(r => bwSelected.has(r.campaignId));
      return toggle + `
        <div class="arf-table-wrap">
          <table class="table-fill arf-table">
            <thead><tr>
              <th class="bw-tick"><input type="checkbox" data-bw-all
                    ${allTicked ? 'checked' : ''}
                    ${selectable.length ? '' : 'disabled'}
                    title="Select every changed campaign currently shown"></th>
              <th>Campaign</th><th>Brand</th>
              <th class="arf-r">Spend</th><th class="arf-r">Sales</th><th class="arf-r">Orders</th>
              <th class="arf-r">ACoS</th><th class="arf-r">Retention</th><th class="arf-r">At cap</th>
              <th>Action</th><th class="arf-r">Budget</th><th class="arf-r">New</th><th class="arf-r">Apply</th>
            </tr></thead>
            <tbody>${rows.map(bwRow).join('')}</tbody>
          </table>
        </div>`;
    }

    // Cut and Decrease are both reductions; the distinction is why. Cut means
    // losing money or not converting at all, Decrease means underperforming.
    // Neither goes straight to the floor any more.
    const BW_ACTION_LABEL = {
      increase: 'Increase', decrease: 'Decrease', hold: 'Hold', cut: 'Cut'
    };

    function bwRow(r) {
      const cls = r.action === 'increase' ? 'bw-up'
                : r.action === 'decrease' ? 'bw-down'
                : r.action === 'cut' ? 'bw-cut' : 'bw-hold';
      const pct = r.pct ? ` ${r.pct > 0 ? '+' : ''}${Math.round(r.pct * 100)}%` : '';
      return `<tr>
        <td class="bw-tick">${bwApplicable(r)
          ? `<input type="checkbox" data-bw-tick="${escapeHtml(r.campaignId)}"${
              bwSelected.has(r.campaignId) ? ' checked' : ''}>`
          : ''}</td>
        <td class="arf-name">${escapeHtml(r.campaign)}
          <div class="arf-sub">${escapeHtml(r.reason || '')}${
            r.raisedRecently
              ? ` <span class="bw-warn">· this tool already raised it to $${r.raisedRecently.to} on ${escapeHtml(r.raisedRecently.ptDate)}</span>`
              : ''}</div>
        </td>
        <td>${escapeHtml(r.brand || '—')}</td>
        <td class="arf-r">${bwMoney(r.spend)}</td>
        <td class="arf-r">${bwMoney(r.sales)}</td>
        <td class="arf-r">${r.orders}</td>
        <td class="arf-r">${bwPct(r.acos)}</td>
        <td class="arf-r arf-em">${bwPct(r.retention)}</td>
        <td class="arf-r">${r.cappedDays === null ? '—' : `${r.cappedDays} of ${r.weekDays}`}</td>
        <td><span class="bw-tag ${cls}">${BW_ACTION_LABEL[r.action]}${pct}</span></td>
        <td class="arf-r">${bwMoney(r.dailyBudget)}</td>
        <td class="arf-r arf-em">${r.action === 'hold' ? '—' : bwMoney(r.newBudget)}</td>
        <td class="arf-r arf-action">${bwApplyCell(r)}</td>
      </tr>`;
    }

    // Every write is two clicks, one row at a time. There is no bulk apply: a
    // run can recommend reductions across dozens of live campaigns, and one
    // button that moves all of them is not something worth having.
    function bwApplyCell(r) {
      const st = bwApply[r.campaignId] || {};
      const id = escapeHtml(r.campaignId);
      if (st.stage === 'done') return `<span class="arf-applied">&#10003; $${escapeHtml(String(st.applied))}</span>`;
      if (r.action === 'hold' || r.newBudget === null || r.newBudget === r.dailyBudget) {
        return '<span class="arf-muted">—</span>';
      }
      if (st.stage === 'busy') return '<span class="loading"></span>';
      if (st.stage === 'confirm') {
        return `<span class="arf-confirm">
          <span>$${r.newBudget}?</span>
          <button class="arf-btn arf-btn-go" data-bw-confirm="${id}">Confirm</button>
          <button class="arf-btn" data-bw-cancel="${id}">Cancel</button>
        </span>`;
      }
      return `<button class="arf-btn" data-bw-apply="${id}"
                title="Set this campaign's daily budget on Amazon to $${r.newBudget}"
              >$${r.newBudget}</button>${
        st.stage === 'error' ? `<div class="arf-warn">${escapeHtml(st.message)}</div>` : ''}`;
    }

    // Sticky bar for the bulk write, mirroring the one on Campaign Overview so
    // the two pages behave the same way. It reuses that bar's styles rather
    // than duplicating forty lines of identical CSS.
    //
    // It states the direction of the money before anything moves. A run can
    // recommend reductions across dozens of live campaigns, and "12 selected"
    // alone does not tell you whether you are about to spend more or less.
    function bwSelectionBar(data, visibleRows) {
      const all = data.rows || [];
      const picked = all.filter(r => bwSelected.has(r.campaignId) && bwApplicable(r));
      if (!picked.length) return '<div id="bw-save-bar" style="display: none;"></div>';

      const tally = { increase: 0, decrease: 0, cut: 0 };
      let net = 0;
      for (const r of picked) { tally[r.action] = (tally[r.action] || 0) + 1; net += (r.delta || 0); }
      const parts = [
        tally.increase ? `${tally.increase} increase` : null,
        tally.decrease ? `${tally.decrease} decrease` : null,
        tally.cut ? `${tally.cut} cut` : null
      ].filter(Boolean);

      // Selections survive a filter change, so a row can be ticked and not on
      // screen. Applying something you cannot see is exactly the hazard a bulk
      // button introduces, so it is called out rather than left implicit.
      const shown = new Set(visibleRows.map(r => r.campaignId));
      const hidden = picked.filter(r => !shown.has(r.campaignId)).length;
      const failed = picked.filter(r => (bwApply[r.campaignId] || {}).stage === 'error').length;

      return `
        <div id="bw-save-bar">
          <div class="card aco-save-bar-inner">
            <div class="aco-save-bar-summary">
              <strong>${picked.length} selected</strong>
              <span class="aco-save-bar-detail">${escapeHtml(parts.join(' \u00b7 '))} \u00b7 net ${
                net >= 0 ? '+' : ''}${bwMoney(net)}/day</span>
              ${hidden ? `<span class="aco-save-bar-warn">${hidden} not currently shown</span>` : ''}
              ${failed ? `<span class="aco-save-bar-failed">${failed} failed \u2014 still selected</span>` : ''}
            </div>
            <div class="aco-save-bar-actions">
              ${bwBulkBusy
                ? `<span class="loading"></span><span class="arf-muted">${escapeHtml(bwBulkProgress)}</span>`
                : bwBulkConfirm
                  ? `<button class="btn btn-secondary" data-bw-bulk="cancel">Cancel</button>
                     <button class="btn btn-primary" data-bw-bulk="go">Write ${picked.length} to Amazon</button>`
                  : `<button class="btn btn-secondary" data-bw-bulk="clear">Clear</button>
                     <button class="btn btn-primary" data-bw-bulk="ask">Apply selected</button>`}
            </div>
          </div>
        </div>`;
    }

    function bwFooter(data) {
      const c = data.coverage || {};
      const bits = [
        `${c.enabled} enabled campaigns evaluated`,
        c.unmapped ? `${c.unmapped} unmapped to a brand` : null,
        c.noBudget ? `${c.noBudget} with no daily budget` : null,
        c.orphanRows ? `${c.orphanRows} report rows for campaigns not in the snapshot` : null
      ].filter(Boolean);
      return `
        <div class="arf-footer">
          <div>${escapeHtml(bits.join(' · '))}</div>
          ${(data.notes || []).map(n =>
            `<div class="arf-warn">${escapeHtml(n.key)}: ${escapeHtml(n.note)}</div>`).join('')}
          ${(data.deviations || []).map(d =>
            `<div class="arf-muted">Deviation from the cadence doc: ${escapeHtml(d)}</div>`).join('')}
          ${data.censusSyncedAt
            ? `<div class="arf-muted">Campaign configuration synced ${escapeHtml(_svTimeAgo(data.censusSyncedAt))}</div>`
            : ''}
        </div>`;
    }

    // ─── ACTIONS ─────────────────────────────────────────────────────────────

    function bwBindActions() {
      // The container persists across renders — only innerHTML is replaced —
      // so binding per render would stack duplicate handlers.
      if (bwBound) return;
      const el = document.getElementById('adbiweekly-content');
      if (!el) return;
      el.addEventListener('click', e => {
        const btn = e.target.closest(
          '[data-bw-apply], [data-bw-confirm], [data-bw-cancel], [data-bw-filter], ' +
          '[data-bw-bulk], [data-bw-recompute]');
        if (!btn) return;
        const d = btn.dataset;
        if (d.bwRecompute !== undefined) return bwRecompute();
        if (d.bwFilter) { bwFilter = d.bwFilter; bwRerender(); }
        else if (d.bwApply) bwSetApplyStage(d.bwApply, 'confirm');
        else if (d.bwCancel) bwSetApplyStage(d.bwCancel, null);
        else if (d.bwConfirm) bwApplyBudget(d.bwConfirm);
        else if (d.bwBulk) bwBulkClick(d.bwBulk);
      });
      el.addEventListener('change', e => {
        const sel = e.target.closest('[data-bw-posture]');
        if (sel) return bwSavePosture(sel.dataset.bwPosture, sel.value);

        const brand = e.target.closest('[data-bw-brand]');
        if (brand) {
          bwBrand = brand.value;
          // A pending confirmation would now cover rows you can no longer see.
          bwBulkConfirm = false;
          return bwRerender();
        }

        const tick = e.target.closest('[data-bw-tick]');
        if (tick) {
          if (tick.checked) bwSelected.add(tick.dataset.bwTick);
          else bwSelected.delete(tick.dataset.bwTick);
          // A new selection invalidates a pending confirmation: you should not
          // confirm 12 and write 13.
          bwBulkConfirm = false;
          return bwRerender();
        }

        const all = e.target.closest('[data-bw-all]');
        if (all) {
          // Only what is on screen. Ticking a header box must never select
          // rows the current filter is hiding.
          const data = bwCacheLoad();
          if (!data) return;
          for (const r of bwVisibleRows(data).filter(bwApplicable)) {
            if (all.checked) bwSelected.add(r.campaignId);
            else bwSelected.delete(r.campaignId);
          }
          bwBulkConfirm = false;
          return bwRerender();
        }
      });
      bwBound = true;
    }

    function bwRerender() {
      const cached = bwCacheLoad();
      if (cached) bwRender(cached);
    }

    function bwBulkClick(what) {
      if (bwBulkBusy) return;
      if (what === 'clear') { bwSelected.clear(); bwBulkConfirm = false; return bwRerender(); }
      if (what === 'ask') { bwBulkConfirm = true; return bwRerender(); }
      if (what === 'cancel') { bwBulkConfirm = false; return bwRerender(); }
      if (what === 'go') return bwApplySelected();
    }

    // Sequential, never parallel: Amazon throttles, and a failure has to be
    // attributable to one campaign. Rows that succeed leave the selection;
    // rows that fail stay in it so a retry is one click rather than a hunt.
    async function bwApplySelected() {
      if (bwBulkBusy || !accessToken) return;
      const data = bwCacheLoad();
      if (!data) return;
      const picked = (data.rows || []).filter(r => bwSelected.has(r.campaignId) && bwApplicable(r));
      if (!picked.length) return;

      bwBulkBusy = true;
      bwBulkConfirm = false;
      let done = 0;
      for (const row of picked) {
        bwBulkProgress = `${done} of ${picked.length}`;
        bwRender(data);
        // eslint-disable-next-line no-await-in-loop
        const ok = await bwWriteBudget(row, data);
        if (ok) bwSelected.delete(row.campaignId);
        done++;
      }
      bwBulkBusy = false;
      bwBulkProgress = '';
      bwCacheSave(data);
      bwRender(data);
    }

    function bwSetApplyStage(campaignId, stage, extra) {
      if (!stage) delete bwApply[campaignId];
      else bwApply[campaignId] = { stage, ...(extra || {}) };
      const cached = bwCacheLoad();
      if (cached) bwRender(cached);
    }

    async function bwApplyBudget(campaignId) {
      const cached = bwCacheLoad();
      const row = (cached?.rows || []).find(r => String(r.campaignId) === String(campaignId));
      if (!row || !accessToken) return;

      bwSetApplyStage(campaignId, 'busy');
      await bwWriteBudget(row, cached);
      bwCacheSave(cached);
      bwRender(cached);
    }

    // The single write. Mutates `row` AND the matching stored input in place,
    // both belonging to `run`, so a bulk caller can save the cache once rather
    // than after every campaign. Returns whether it landed and never throws —
    // a batch must not stop because one row was rejected.
    //
    // `run` is not optional: reloading the cache in here would mutate a
    // different object from the one the caller is about to save, and the
    // caller's stale copy would win.
    async function bwWriteBudget(row, run) {
      const campaignId = row.campaignId;
      bwApply[campaignId] = { stage: 'busy' };
      try {
        // The Campaign Overview write path: it re-reads the campaign from
        // Amazon, refuses if the budget moved since this run, and verifies by
        // reading back.
        const res = await fetch('/api/adcampaigns?action=update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            campaignId: row.campaignId, adProduct: row.adProduct, local: {},
            amazon: { dailyBudget: row.newBudget },
            expected: { dailyBudget: row.dailyBudget }
          })
        });
        const reply = await res.json().catch(() => ({}));
        if (!res.ok || !reply.success) {
          if (reply.conflicts?.length) {
            const c0 = reply.conflicts[0];
            throw new Error(`Amazon now has ${c0.field} = ${c0.amazonHasNow ?? '—'} ` +
                            `(this run saw ${c0.youSaw ?? '—'}). Re-run.`);
          }
          throw new Error(reply.error || `Failed (${res.status})`);
        }
        // Keep the cached run truthful: the budget on screen is now stale.
        bwApply[campaignId] = { stage: 'done', applied: row.newBudget };
        row.dailyBudget = row.newBudget;
        row.action = 'hold';
        row.pct = 0;
        row.delta = 0;
        row.reason = 'Applied this run';
        // The stored input still holds the OLD budget, so a later recompute
        // would recommend the same change over again. Keep it in step.
        const input = (run?.inputs || []).find(i => String(i.campaignId) === String(campaignId));
        if (input) input.dailyBudget = row.newBudget;
        return true;
      } catch (err) {
        console.error('[BW] apply failed:', err);
        bwApply[campaignId] = { stage: 'error', message: err.message };
        return false;
      }
    }

    async function bwRecompute() {
      const cached = bwCacheLoad();
      if (bwRecomputing || !accessToken || !cached || !Array.isArray(cached.inputs)) return;
      bwRecomputing = true;
      bwSetStatus('Re-running the decision tree on this run\u2019s data\u2026');
      bwRender(cached);
      try {
        const res = await fetch('/api/adspend?action=biweekly-recompute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ inputs: cached.inputs, window: cached.window })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || `Recompute failed (${res.status})`);

        // Only the decisions change. The inputs, and the timestamp saying when
        // the DATA was fetched, are carried forward so the page never implies
        // it has fresher numbers than it does.
        const next = { ...cached, ...data, inputs: cached.inputs, generatedAt: cached.generatedAt };
        // A selection made against the old recommendations may no longer point
        // at a change, so it is dropped rather than silently re-aimed.
        bwSelected.clear();
        bwBulkConfirm = false;
        bwCacheSave(next);
        bwSetStatus('');
        // Clear the flag BEFORE rendering, or the button paints itself as
        // still running and stays that way until the next render.
        bwRecomputing = false;
        bwRender(next);
      } catch (err) {
        console.error('[BW] recompute failed:', err);
        bwSetStatus('', err.message);
        bwRecomputing = false;
        bwRender(cached);
      }
    }

    async function bwSavePosture(brand, posture) {
      try {
        const res = await fetch('/api/adspend?action=biweekly-posture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ brand, posture })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
        // The posture changes what the tree recommends, and the tree can now be
        // re-run without a report, so this applies immediately rather than
        // telling you to wait half an hour for one.
        bwSetStatus(`Posture saved \u2014 ${escapeHtml(brand)} is now ${escapeHtml(posture)}.`);
        await bwRecompute();
      } catch (err) {
        console.error('[BW] posture save failed:', err);
        bwSetStatus('', err.message);
      }
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────────

    function bwMoney(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      // The sign belongs outside the currency symbol: -$10.00, never $-10.00.
      const v = Math.round(n * 100) / 100;
      return (v < 0 ? '-$' : '$') + formatNumber(Math.abs(v));
    }

    function bwPct(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return Math.round(n * 100) + '%';
    }

    function bwSetStatus(message, error) {
      const el = document.getElementById('bw-status');
      if (!el) return;
      if (!message && !error) { el.style.display = 'none'; el.innerHTML = ''; return; }
      el.style.display = 'block';
      el.innerHTML = error
        ? `<span style="color: var(--error);">${escapeHtml(error)}</span>`
        : escapeHtml(message);
    }

    function bwSetBlurb(text) {
      const el = document.getElementById('adbiweekly-blurb');
      if (el) el.textContent = text;
    }

    function bwSetBusy(busy) {
      const btn = document.getElementById('bw-run-btn');
      if (!btn) return;
      btn.disabled = busy;
      btn.innerHTML = busy ? 'Running<span class="loading"></span>'
                           : (bwRunLoad() ? 'Check again' : 'Run bi-weekly');
    }

    function bwCacheSave(data) {
      try { localStorage.setItem(BW_RESULT_KEY, JSON.stringify(data)); } catch (e) { /* quota */ }
    }

    function bwCacheLoad() {
      try {
        const raw = localStorage.getItem(BW_RESULT_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }

    function bwRunSave(state) {
      try { localStorage.setItem(BW_RUN_KEY, JSON.stringify(state)); } catch (e) { /* quota */ }
    }

    function bwRunLoad() {
      try {
        const raw = localStorage.getItem(BW_RUN_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }

    function bwRunClear() {
      try { localStorage.removeItem(BW_RUN_KEY); } catch (e) { /* ignore */ }
    }
