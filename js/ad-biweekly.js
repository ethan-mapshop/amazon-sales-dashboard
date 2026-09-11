    // ─── BI-WEEKLY BUDGETS ───────────────────────────────────────────────────
    // Tactical budget management. Unlike the weekly, this cadence ACTS: every
    // enabled campaign gets Increase, Decrease, Hold or Cut to Floor, and each
    // row can be written to Amazon.
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
            Every enabled campaign gets one of Increase, Decrease, Hold or Cut to Floor,
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
        bwTable(rows, data) + bwFooter(data);
      bwBindActions();
    }

    function bwVisibleRows(data) {
      const all = data.rows || [];
      return bwFilter === 'all' ? all : all.filter(r => r.action !== 'hold');
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
            ${pill(c.cut, 'cut to floor', 'bw-cut')}
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
                <th class="arf-r">SP spend</th><th class="arf-r">SB spend</th>
                <th class="arf-r">Spend</th><th class="arf-r">Sales</th>
                <th class="arf-r">Orders</th><th class="arf-r">ACoS</th><th class="arf-r">Retention</th>
              </tr></thead>
              <tbody>${brands.map(b => `
                <tr>
                  <td class="arf-name">${escapeHtml(b.brand)}</td>
                  <td>${escapeHtml(b.posture === 'hold' ? '—' : b.posture)}</td>
                  <td class="arf-r">${bwMoney(b.sp.spend)}</td>
                  <td class="arf-r">${b.sb.spend > 0 ? bwMoney(b.sb.spend) : '—'}</td>
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
      const total = (data.rows || []).length;
      const toggle = `
        <div class="bw-filter">
          <button class="arf-btn${bwFilter === 'moves' ? ' arf-btn-go' : ''}" data-bw-filter="moves">Changes only</button>
          <button class="arf-btn${bwFilter === 'all' ? ' arf-btn-go' : ''}" data-bw-filter="all">All ${total}</button>
        </div>`;

      if (!rows.length) {
        return toggle + `<p class="arf-none" style="padding: 1rem 0;">No budget changes recommended this run.</p>`;
      }
      return toggle + `
        <div class="arf-table-wrap">
          <table class="table-fill arf-table">
            <thead><tr>
              <th>Campaign</th><th>Ad</th><th>Brand</th>
              <th class="arf-r">Spend</th><th class="arf-r">Sales</th><th class="arf-r">Orders</th>
              <th class="arf-r">ACoS</th><th class="arf-r">Retention</th><th class="arf-r">At cap</th>
              <th>Action</th><th class="arf-r">Budget</th><th class="arf-r">New</th><th class="arf-r">Apply</th>
            </tr></thead>
            <tbody>${rows.map(bwRow).join('')}</tbody>
          </table>
        </div>`;
    }

    const BW_ACTION_LABEL = {
      increase: 'Increase', decrease: 'Decrease', hold: 'Hold', cut: 'Cut to floor'
    };

    function bwRow(r) {
      const cls = r.action === 'increase' ? 'bw-up'
                : r.action === 'decrease' ? 'bw-down'
                : r.action === 'cut' ? 'bw-cut' : 'bw-hold';
      const pct = r.pct ? ` ${r.pct > 0 ? '+' : ''}${Math.round(r.pct * 100)}%` : '';
      return `<tr>
        <td class="arf-name">${escapeHtml(r.campaign)}
          <div class="arf-sub">${escapeHtml(r.reason || '')}${
            r.raisedRecently
              ? ` <span class="bw-warn">· this tool already raised it to $${r.raisedRecently.to} on ${escapeHtml(r.raisedRecently.ptDate)}</span>`
              : ''}</div>
        </td>
        <td>${escapeHtml(r.adProduct || '')}</td>
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

    // A cut to the $1 floor is a 90%-plus reduction on a live campaign, so it
    // gets the same two-step as everything else and is never swept into a
    // bulk action — there is no bulk action.
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
        const btn = e.target.closest('[data-bw-apply], [data-bw-confirm], [data-bw-cancel], [data-bw-filter]');
        if (!btn) return;
        const d = btn.dataset;
        if (d.bwFilter) { bwFilter = d.bwFilter; const c = bwCacheLoad(); if (c) bwRender(c); }
        else if (d.bwApply) bwSetApplyStage(d.bwApply, 'confirm');
        else if (d.bwCancel) bwSetApplyStage(d.bwCancel, null);
        else if (d.bwConfirm) bwApplyBudget(d.bwConfirm);
      });
      el.addEventListener('change', e => {
        const sel = e.target.closest('[data-bw-posture]');
        if (sel) bwSavePosture(sel.dataset.bwPosture, sel.value);
      });
      bwBound = true;
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
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          if (data.conflicts?.length) {
            const c0 = data.conflicts[0];
            throw new Error(`Amazon now has ${c0.field} = ${c0.amazonHasNow ?? '—'} (this run saw ${c0.youSaw ?? '—'}). Re-run.`);
          }
          throw new Error(data.error || `Failed (${res.status})`);
        }
        // Keep the cached run truthful: the budget on screen is now stale.
        row.dailyBudget = row.newBudget;
        row.action = 'hold';
        row.reason = 'Applied this run';
        bwCacheSave(cached);
        bwApply[campaignId] = { stage: 'done', applied: row.dailyBudget };
        bwRender(cached);
      } catch (err) {
        console.error('[BW] apply failed:', err);
        bwSetApplyStage(campaignId, 'error', { message: err.message });
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
        // The posture changes what the tree recommends, so the stored run is
        // now out of date. Saying so beats quietly showing stale advice.
        bwSetStatus(`Posture saved. Re-run to apply ${escapeHtml(brand)} = ${escapeHtml(posture)} to the recommendations.`);
      } catch (err) {
        console.error('[BW] posture save failed:', err);
        bwSetStatus('', err.message);
      }
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────────

    function bwMoney(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return '$' + formatNumber(Math.round(n * 100) / 100);
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
