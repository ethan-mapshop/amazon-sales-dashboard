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
      arfSetStatus('Requesting reports from Amazon…');

      try {
        const res = await fetch('/api/adspend?action=weekly-request', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

        const good = (data.reports || []).filter(r => r.reportId);
        const duplicates = (data.reports || []).filter(r => r.duplicate);

        if (!good.length) {
          if (duplicates.length) {
            // Amazon rejects an identical report while the prior one is still
            // running, and does not hand back the in-flight id — so there is
            // nothing to poll. Waiting is the only correct move.
            throw new Error('Amazon reports these are already being generated. Wait a few minutes and run again.');
          }
          throw new Error((data.reports || []).map(r => r.error).filter(Boolean)[0] || 'No reports were accepted.');
        }

        const state = {
          window: data.window,
          reports: good.map(r => ({ key: r.key, reportId: r.reportId })),
          degraded: good.some(r => r.degraded),
          hasBudgetColumns: good.some(r => r.hasBudgetColumns),
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

        data.degraded = state.degraded;
        data.hasBudgetColumns = state.hasBudgetColumns;
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

    function arfRenderIdle() {
      const container = document.getElementById('adredflags-content');
      if (!container) return;
      container.innerHTML = `
        <div class="card card-flat" style="text-align: center; padding: 4rem 2rem;">
          <div style="font-size: 2.5rem; opacity: 0.35; margin-bottom: 1rem;">🚩</div>
          <div style="color: var(--text-secondary); max-width: 44rem; margin: 0 auto; line-height: 1.6;">
            Runs four checks over the most recent complete Monday&ndash;Sunday week:
            budget cap emergencies, runaway spenders, stalled campaigns, and brand pacing.
            Amazon generates the reports on request, which takes a few minutes.
          </div>
        </div>`;
    }

    function arfRender(data) {
      const container = document.getElementById('adredflags-content');
      if (!container) return;

      const w = data.window || {};
      arfSetBlurb(`Week of ${_formatMDY(w.weekStart)}–${_formatMDY(w.weekEnd)} · computed ${_svTimeAgo(data.generatedAt)}`);

      const cov = data.coverage || {};
      const stats = `
        <div class="stats-bar" style="margin-bottom: 1.5rem;">
          <div class="stat-item"><span class="stat-label">Flags</span>
            <span class="stat-value" style="color: ${data.flagCount ? 'var(--error)' : 'var(--success)'};">${data.flagCount}</span></div>
          <div class="stat-item"><span class="stat-label">Evaluated</span>
            <span class="stat-value">${cov.evaluated} / ${cov.campaignsSeen}</span></div>
          <div class="stat-item"><span class="stat-label">Spend covered</span>
            <span class="stat-value">$${formatNumber(cov.evaluatedSpend7 || 0)} of $${formatNumber(cov.totalSpend7 || 0)}</span></div>
          ${cov.unmapped && cov.unmapped.length
            ? `<div class="stat-item"><span class="stat-label">Unmapped</span><span class="stat-value warning">${cov.unmapped.length}</span></div>`
            : ''}
        </div>`;

      if (data.clean) {
        container.innerHTML = stats + `
          <div class="card" style="border-left: 3px solid var(--success);">
            <div style="padding: 0.5rem 0; font-size: 1rem;">
              No flags this week — all brands and campaigns within normal range.
            </div>
          </div>` + arfRenderNotEvaluated(data);
        return;
      }

      const f = data.flags || {};
      container.innerHTML = stats +
        arfSection('1 · Budget cap emergencies', f.budgetCap, arfCampaignTable, {
          blurb: 'Profitable campaigns hitting their daily budget. Fix is fast; the cost of waiting is measurable.',
          cols: ['Campaign', 'Brand', 'Spend', 'Budget/day', 'Capped days', 'ACoS', 'Retention'],
          // "No flags" would be a lie if no campaign had usable budget data.
          emptyMessage: cov.cappedEvaluableCount === 0
            ? 'Could not be evaluated — Amazon returned no usable daily-budget data for any campaign in this run. See "Not evaluated" below.'
            : null
        }) +
        arfSection('2 · Runaway spenders', f.runaway, arfCampaignTable, {
          blurb: 'Spend more than doubled against the 4-week baseline while retention is poor.',
          cols: ['Campaign', 'Brand', 'Spend', 'Baseline/wk', 'Multiple', 'ACoS', 'Retention']
        }) +
        arfSection('3 · Stalled products', f.stalled, arfPortfolioTable, {
          blurb: 'Fifteen or more clicks and zero orders across the whole portfolio. Usually a listing problem — inventory, Buy Box, reviews, pricing — rather than an ads problem. Expand a row for the campaign breakdown.',
          cols: ['Portfolio', 'Brand', 'Clicks', 'Spend', 'Campaigns']
        }) +
        arfSection('4 · Brand pacing', f.brandPacing, arfBrandTable, {
          blurb: 'Brand-level spend more than 30% off its 4-week weekly average, in either direction.',
          cols: ['Brand', 'Spend', 'Baseline/wk', 'Change']
        }) +
        arfRenderNotEvaluated(data);
    }

    function arfSection(title, rows, renderer, opts) {
      const list = rows || [];
      const body = list.length
        ? renderer(list, opts.cols, title)
        : `<div style="color: ${opts.emptyMessage ? 'var(--warning)' : 'var(--text-secondary)'}; padding: 0.5rem 0;">` +
          `${escapeHtml(opts.emptyMessage || 'No flags this week.')}</div>`;
      return `
        <div class="card" style="margin-bottom: 1.5rem; ${list.length ? 'border-left: 3px solid var(--error);' : ''}">
          <h3 class="section-title" style="margin-bottom: 0.5rem;">${escapeHtml(title)}</h3>
          <div style="color: var(--text-secondary); font-size: 0.8125rem; margin-bottom: 1rem;">${escapeHtml(opts.blurb)}</div>
          ${body}
        </div>`;
    }

    function arfCampaignTable(rows, cols, title) {
      const isCap = title.startsWith('1');
      const isRun = title.startsWith('2');
      const cells = (r) => {
        if (isCap) return [
          arfName(r), arfBrand(r), arfMoney(r.spend7), arfMoney(r.dailyBudget),
          `${r.cappedDays} of 7`, arfPct(r.acos), arfRetention(r.retention)
        ];
        if (isRun) return [
          arfName(r), arfBrand(r), arfMoney(r.spend7), arfMoney(r.baselineWeekly),
          r.spendMultiple ? `${r.spendMultiple.toFixed(1)}×` : '—',
          arfPct(r.acos), arfRetention(r.retention)
        ];
        return [arfName(r), arfBrand(r), arfMoney(r.spend7)];
      };
      return arfTable(cols, rows.map(cells));
    }

    // Stalled rows are portfolios, not campaigns. The per-campaign breakdown is
    // kept as expandable detail: when a product's campaigns disagree — some
    // still converting, some not — that points at targeting rather than the
    // listing, and it's the case worth looking at closely.
    function arfPortfolioTable(rows, cols) {
      const detail = (r) => r.campaigns.map(c =>
        `${escapeHtml(c.campaign)} — ${c.clicks7} clicks, $${formatNumber(c.spend7)}`
      ).join('<br>');
      return `
        <div style="overflow-x: auto;">
          <table>
            <thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(r => `
              <tr>
                <td>
                  <details>
                    <summary style="cursor: pointer;">${escapeHtml(r.portfolio || '—')}</summary>
                    <div style="margin-top: 0.5rem; font-size: 0.75rem; color: var(--text-secondary); line-height: 1.6;">
                      ${detail(r)}
                    </div>
                  </details>
                </td>
                <td>${arfBrand(r)}</td>
                <td>${r.clicks7}</td>
                <td>${arfMoney(r.spend7)}</td>
                <td>${r.campaignCount}</td>
              </tr>`).join('')}
            </tbody>
          </table>
        </div>`;
    }

    function arfBrandTable(rows, cols) {
      return arfTable(cols, rows.map(r => [
        escapeHtml(r.brand),
        arfMoney(r.spend7),
        arfMoney(r.baselineWeekly),
        `<span style="color: ${r.direction === 'up' ? 'var(--warning)' : 'var(--accent-orange)'};">${r.deviation > 0 ? '+' : ''}${(r.deviation * 100).toFixed(0)}%</span>`
      ]));
    }

    function arfTable(cols, rows) {
      return `
        <div style="overflow-x: auto;">
          <table>
            <thead><tr>${cols.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead>
            <tbody>${rows.map(cells => `<tr>${cells.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody>
          </table>
        </div>`;
    }

    // Everything the checks deliberately did not evaluate. Kept visible so an
    // incomplete run never reads as a clean one.
    function arfRenderNotEvaluated(data) {
      const cov = data.coverage || {};
      const groups = [
        ['Capped but not converting', cov.cappedNoSales, 'Hitting their budget with no sales at all. Not a scale-up opportunity — the opposite.'],
        ['Capped, retention too low', cov.cappedLowRetention, 'Hitting their budget, but keeping too little profit to be worth feeding.'],
        ['Unmapped campaigns', cov.unmapped, 'No brand could be resolved, so margin-based checks could not run. Map these on the Campaign Mapping page.'],
        ['Under $5 for the week', cov.excludedUnderMin, 'Excluded by the cadence — too little signal to interpret.'],
        ['No usable baseline', cov.newNoBaseline, 'Too few active days in the prior 4 weeks to compare against.'],
        ['Budget not evaluable', cov.notEvaluable,
         'Lifetime budgets or missing budget data — the capped check cannot run.',
         'Reason', r => escapeHtml(r.reason || '—')]
      ].filter(g => g[1] && g[1].length);

      const conflicts = cov.mappingConflicts || [];
      const notes = data.notes || [];
      if (!groups.length && !conflicts.length && !notes.length && !data.degraded) return '';

      const sections = groups.map(([label, rows, blurb, extraLabel, extraFn]) => `
        <div style="margin-bottom: 1.25rem;">
          <div style="font-weight: 600; margin-bottom: 0.25rem;">${escapeHtml(label)} (${rows.length})</div>
          <div style="color: var(--text-secondary); font-size: 0.8125rem; margin-bottom: 0.5rem;">${escapeHtml(blurb)}</div>
          ${arfTable(['Campaign', 'Brand', 'Spend', 'Clicks', 'Orders'].concat(extraLabel ? [extraLabel] : []),
            rows.slice(0, 25).map(r => [arfName(r), arfBrand(r), arfMoney(r.spend7),
              String(Math.round(r.clicks7)), String(Math.round(r.orders7))]
              .concat(extraFn ? [extraFn(r)] : [])))}
          ${rows.length > 25 ? `<div style="color: var(--text-secondary); font-size: 0.8125rem; margin-top: 0.5rem;">…and ${rows.length - 25} more.</div>` : ''}
        </div>`).join('');

      const conflictBlock = conflicts.length ? `
        <div style="margin-bottom: 1.25rem;">
          <div style="font-weight: 600; margin-bottom: 0.25rem; color: var(--warning);">Mapping disagreements (${conflicts.length})</div>
          <div style="color: var(--text-secondary); font-size: 0.8125rem; margin-bottom: 0.5rem;">
            The Campaign Mapping page and the campaign name disagree about the brand. The saved mapping was used. Usually means a stale mapping.
          </div>
          ${arfTable(['Campaign', 'Mapped to', 'Name suggests'],
            conflicts.map(c => [escapeHtml(c.campaign), escapeHtml(c.mapped), escapeHtml(c.byPrefix)]))}
        </div>` : '';

      const bt = cov.budgetTypesSeen || {};
      const btBlock = Object.keys(bt).length ? `
        <div style="margin-bottom: 1.25rem; color: var(--text-secondary); font-size: 0.8125rem;">
          <span style="font-weight: 600;">Budget types Amazon returned:</span>
          ${Object.entries(bt).map(([k, v]) => `${escapeHtml(k)} × ${v}`).join(' · ')}
        </div>` : '';

      const noteBlock = (notes.length || data.degraded) ? `
        <div style="color: var(--text-secondary); font-size: 0.8125rem;">
          ${data.degraded ? '<div>Amazon rejected some report columns, so this run used a reduced column set.</div>' : ''}
          ${notes.map(n => `<div>${escapeHtml(n.key)}: ${escapeHtml(n.note)}</div>`).join('')}
        </div>` : '';

      return `
        <div class="card card-flat" style="margin-top: 0.5rem;">
          <details>
            <summary style="cursor: pointer; font-weight: 600;">Not evaluated / for reference</summary>
            <div style="margin-top: 1.25rem;">${sections}${btBlock}${conflictBlock}${noteBlock}</div>
          </details>
        </div>`;
    }

    // ─── SMALL RENDER HELPERS ────────────────────────────────────────────────

    function arfName(r) {
      const tag = r.adProduct === 'SB'
        ? ' <span style="color: var(--text-secondary); font-size: 0.75rem;">SB</span>' : '';
      return escapeHtml(r.campaign || '') + tag;
    }

    function arfBrand(r) {
      if (!r.brand) return '<span style="color: var(--warning);">unmapped</span>';
      return escapeHtml(r.brand);
    }

    function arfMoney(n) {
      return (n === null || n === undefined) ? '—' : '$' + formatNumber(n);
    }

    function arfPct(n) {
      // null means no sales — ACoS is undefined, not zero. Rendering "0%"
      // here is what made dead campaigns look perfect in the manual version.
      return (n === null || n === undefined) ? 'no sales' : `${(n * 100).toFixed(1)}%`;
    }

    function arfRetention(n) {
      if (n === null || n === undefined) return '<span style="color: var(--error);">no sales</span>';
      const color = n >= 0.5 ? 'var(--success)' : n >= 0.25 ? 'var(--warning)' : 'var(--error)';
      return `<span style="color: ${color};">${(n * 100).toFixed(0)}%</span>`;
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
