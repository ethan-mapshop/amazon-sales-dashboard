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
        if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);

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
    }

    function arfSections(data) {
      const f = data.flags || {};
      return [
        arfSection('1 · Budget cap emergencies', f.budgetCap, arfBudgetCapLine,
          'Profitable campaigns losing sales to their daily cap.'),
        arfSection('2 · Runaway spenders', f.runaway, arfRunawayLine,
          'Spend well above trailing average with poor profit retention.'),
        arfSection('3 · Stalled', f.stalled, arfStalledLine,
          'Clicks without orders &mdash; usually a listing problem, not an ad problem.'),
        arfSection('4 · Brand pacing', f.brandPacing, arfPacingLine,
          'Account-level sanity check against each brand&rsquo;s trailing average.')
      ].join('');
    }

    // "with 'No flags' written for any check that did not trigger"
    function arfSection(title, rows, lineFn, blurb) {
      const list = rows || [];
      return `
        <section class="arf-section">
          <h4>${title}</h4>
          ${list.length
            ? `<p class="arf-blurb">${blurb}</p><ul class="arf-list">${list.map(lineFn).join('')}</ul>`
            : `<p class="arf-none">No flags this week.</p>`}
        </section>`;
    }

    // Doc's report format: campaign name, current daily budget, 7-day spend vs
    // implied cap, ACoS, profit retention. Amazon's estimated missed-sales
    // range is console-only and has no API field, so it cannot appear here.
    function arfBudgetCapLine(r) {
      return `<li>
        <span class="arf-subject">${escapeHtml(r.campaign)}</span>${arfTag(r)}
        spent <strong>${arfMoney(r.spend7)}</strong> against an implied weekly cap of
        ${arfMoney(r.impliedWeeklyCap)} (${arfMoney(r.dailyBudget)}/day) &mdash;
        <strong>${arfPct(r.capRatio)}</strong> of cap, at ${arfPct(r.acos)} ACoS
        and <strong>${arfPct(r.retention)}</strong> profit retention.
      </li>`;
    }

    // Doc's report format: campaign name, 7-day spend, trailing average,
    // multiplier, current profit retention.
    function arfRunawayLine(r) {
      return `<li>
        <span class="arf-subject">${escapeHtml(r.campaign)}</span>${arfTag(r)}
        spent <strong>${arfMoney(r.spend7)}</strong> against a trailing weekly average of
        ${arfMoney(r.baselineWeekly)} &mdash; <strong>${r.spendMultiple}&times;</strong>,
        at ${arfPct(r.acos)} ACoS and <strong>${arfPct(r.retention)}</strong> profit retention.
      </li>`;
    }

    // Doc's report format: campaign name, 7-day clicks, spend, associated
    // SKU(s), and a suggested first area to check. SKUs are not in the
    // campaign report; the portfolio is one-per-SKU in this account, so the
    // portfolio name identifies the product.
    function arfStalledLine(r) {
      const names = r.campaigns.map(c => c.campaign).join(', ');
      return `<li>
        <span class="arf-subject">${escapeHtml(r.portfolio)}</span>
        ${r.brand ? `<span class="arf-tag">${escapeHtml(r.brand)}</span>` : ''}
        took <strong>${r.clicks7} clicks</strong> and <strong>${arfMoney(r.spend7)}</strong>
        with <strong>zero orders</strong>, across ${r.campaignCount}
        campaign${r.campaignCount === 1 ? '' : 's'}.
        <div class="arf-detail">Check inventory, Buy Box, reviews and pricing before touching the ads.</div>
        <div class="arf-detail arf-muted">${escapeHtml(names)}</div>
      </li>`;
    }

    // Doc's report format: brand name, 7-day spend, trailing average, %
    // change, and a brief likely-cause hypothesis. The hypothesis is a
    // judgement call, so the direction is stated and the reading is left to
    // you rather than invented here.
    function arfPacingLine(r) {
      const up = r.deviation > 0;
      return `<li>
        <span class="arf-subject">${escapeHtml(r.brand)}</span>
        spent <strong>${arfMoney(r.spend7)}</strong> against a trailing weekly average of
        ${arfMoney(r.baselineWeekly)} &mdash;
        <strong class="${up ? 'arf-up' : 'arf-down'}">${up ? '+' : ''}${arfPct(r.deviation)}</strong>.
        <div class="arf-detail">${up
          ? 'Look for a bid or budget increase, a portfolio cap lifting, or seasonal demand.'
          : 'Look for a portfolio budget cap, a paused campaign, or lost impression share.'}</div>
      </li>`;
    }

    function arfTag(r) {
      const bits = [];
      if (r.brand) bits.push(r.brand);
      if (r.adProduct === 'SB') bits.push('SB');
      return bits.length ? `<span class="arf-tag">${escapeHtml(bits.join(' · '))}</span>` : '';
    }

    // The run's own receipt — one line, so a run that covered half the account
    // cannot look identical to a clean week. Not a report of healthy campaigns.
    function arfFooter(data) {
      const c = data.coverage || {};
      const bits = [
        `${c.evaluated} of ${c.enabled} enabled campaigns evaluated`,
        c.belowFloor ? `${c.belowFloor} below the $${(data.config || {}).MIN_WEEKLY_SPEND} weekly spend floor` : null,
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
        warn.push(`Not evaluated for budget cap (no daily budget in the snapshot): ${
          c.noBudget.map(x => escapeHtml(x.campaign)).join(', ')}`);
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
