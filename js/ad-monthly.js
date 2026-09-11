    // ─── MONTHLY REVIEW ──────────────────────────────────────────────────────
    // Brand posture, with the evidence for it. The posture is the only thing
    // monthly feeds into another cadence: the bi-weekly reads it to decide how
    // hard to push each brand. Until now it was set by hand with nothing in
    // front of you, which is the problem this page exists to fix.
    //
    // Underneath, the two Sponsored Brands campaigns. They were pulled from the
    // weekly and the bi-weekly because they gated both runs, so this is the
    // only place they get looked at.
    //
    // Whole calendar months, the most recent one that is fully attributed. A
    // month's last day keeps crediting Sponsored Brands sales for 14 days, so
    // the previous month settles on the 15th, every month. A cron loads it
    // then, and because a settled month never changes again there is nothing
    // to refresh: which day you read it on is entirely up to you.
    //
    // Everything is prefixed `mo`. These files share one global scope, so
    // escapeHtml / formatNumber / _svTimeAgo are CALLED, never redefined.
    //
    // loadAdMonthly() NEVER starts a run: showPage() and triggerCurrentPageLoad()
    // both fire on restore and after sign-in, and a run costs report quota.

    // Report IDs only. THE RESULT IS NEVER CACHED: the server stores what the
    // reports said and decides afresh on every read, so a posture just saved or
    // a brand remapped in Campaign Overview shows up on the next load.
    const MO_RUN_KEY = 'moRunState';
    const MO_POLL_MS = 20000;
    const MO_MAX_WAIT_MS = 45 * 60 * 1000;

    let moPollTimer = null;
    let moBusy = false;
    let moBound = false;
    let moSaving = {};   // { [brand]: true } while a posture write is in flight
    // In memory for the life of the page, never written to storage.
    let moData = null;

    function loadAdMonthly() {
      const container = document.getElementById('admonthly-content');
      if (!container) return;
      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Sign in to view the monthly review.</div>';
        return;
      }
      moFetch();

      const state = moRunLoad();
      if (state && !moPollTimer) {
        moSetStatus(moStatusLine(state.lastStatuses, state.startedAt));
        moSchedulePoll(0);
      }
    }

    // Decisions are made server-side on every read, so this is the only way the
    // page gets a result. There is nothing to invalidate.
    async function moFetch(after) {
      try {
        const res = await fetch('/api/adspend?action=monthly-get', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
        if (data.empty) { moData = null; return moRenderIdle(); }
        moData = data;
        moRender(data);
        if (after) moSetStatus(after);
      } catch (err) {
        console.error('[MO] load failed:', err);
        moSetStatus('', err.message);
      }
    }

    // While a run is in flight the button resumes rather than re-requesting:
    // Amazon rejects an identical report while the prior one is generating.
    function moButtonClick() {
      if (moRunLoad()) moResume(); else moRun();
    }

    function moResume() {
      const state = moRunLoad();
      if (!state) return moRun();
      state.pollUntil = Date.now() + MO_MAX_WAIT_MS;
      state.pollErrors = 0;
      moRunSave(state);
      moSetBusy(true);
      moSetStatus(moStatusLine(state.lastStatuses, state.startedAt));
      moSchedulePoll(0);
    }

    async function moRun() {
      if (moBusy || !accessToken) return;
      if (moRunLoad()) return moResume();
      moBusy = true;
      moSetBusy(true);
      try {
        // Brands and margins are read from the census, and it decides which
        // campaigns are evaluated at all, so a stale one shrinks the run.
        moSetStatus('Refreshing campaign configuration…');
        const sync = await fetch('/api/adcampaigns?action=refresh', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const syncData = await sync.json().catch(() => ({}));
        if (!sync.ok) throw new Error('Could not refresh campaign configuration: ' +
                                      (syncData.error || `HTTP ${sync.status}`));

        moSetStatus('Requesting reports from Amazon…');
        const res = await fetch('/api/adspend?action=monthly-request', {
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

        moRunSave({
          window: data.window,
          reports: good.map(r => ({ key: r.key, reportId: r.reportId })),
          failures: data.failures || [],
          requestNotes: data.notes || [],
          startedAt: new Date().toISOString(),
          pollUntil: Date.now() + MO_MAX_WAIT_MS
        });
        moSetStatus(`Amazon is generating ${good.length} report${good.length === 1 ? '' : 's'}. ` +
                    'Three reports, one of them Sponsored Brands, so this is the slowest of the three cadences.');
        moSchedulePoll(MO_POLL_MS);
      } catch (err) {
        console.error('[MO] run failed:', err);
        moSetStatus('', err.message);
        moSetBusy(false);
      } finally {
        moBusy = false;
      }
    }

    function moSchedulePoll(delay) {
      clearTimeout(moPollTimer);
      moPollTimer = setTimeout(moPoll, delay);
    }

    async function moPoll() {
      const state = moRunLoad();
      if (!state) return;
      if (Date.now() > state.pollUntil) {
        moSetStatus('', 'Gave up waiting after 45 minutes. ' +
          moStatusLine(state.lastStatuses, state.startedAt) +
          ' Press Check again to keep waiting — the reports are still queued at Amazon.');
        moSetBusy(false);
        return;
      }
      try {
        const qs = `reports=${encodeURIComponent(state.reports.map(r => `${r.key}:${r.reportId}`).join(','))}`;
        const res = await fetch(`/api/adspend?action=monthly-status&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Status failed (${res.status})`);

        if (data.allDone) return moCollect(state);
        state.lastStatuses = data.statuses || [];
        state.pollErrors = 0;
        moRunSave(state);
        moSetStatus(moStatusLine(state.lastStatuses, state.startedAt));
        moSchedulePoll(MO_POLL_MS);
      } catch (err) {
        console.error('[MO] poll failed:', err);
        state.pollErrors = (state.pollErrors || 0) + 1;
        moRunSave(state);
        if (state.pollErrors >= 5) {
          moSetStatus('', `Could not reach the status endpoint after 5 tries: ${err.message}. ` +
                          'Press Check again when your connection is back.');
          moSetBusy(false);
          return;
        }
        moSetStatus(`Status check failed (attempt ${state.pollErrors} of 5), retrying…`);
        moSchedulePoll(MO_POLL_MS * state.pollErrors);
      }
    }

    // What Amazon is actually doing, rather than a count of what is finished.
    // PENDING means queued and not yet started; PROCESSING means generating.
    function moStatusLine(statuses, startedAt) {
      const mins = Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 60000));
      const list = statuses || [];
      if (!list.length) return `Waiting on Amazon — ${mins} min elapsed.`;
      const byState = {};
      for (const s of list) byState[s.status || 'UNKNOWN'] = (byState[s.status || 'UNKNOWN'] || 0) + 1;
      const parts = Object.entries(byState).map(([k, n]) => `${n} ${k.toLowerCase()}`);
      let line = `${parts.join(' · ')} — ${mins} min elapsed.`;
      if (list.every(s => s.status === 'PENDING') && mins >= 10) {
        line += ' Amazon has not started these yet; its report queue is backed up.';
      }
      return line;
    }

    async function moCollect(state) {
      try {
        const w = state.window;
        const qs = `reports=${encodeURIComponent(state.reports.map(r => `${r.key}:${r.reportId}`).join(','))}` +
                   `&start=${w.start}&end=${w.end}&priorStart=${w.priorStart}&priorEnd=${w.priorEnd}`;
        const res = await fetch(`/api/adspend?action=monthly-collect&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Collect failed (${res.status})`);

        // A report that was never requested, or that fell back to fewer
        // columns, is a hole in the run only the request step knows about.
        data.notes = [...(data.notes || []),
          ...(state.requestNotes || []),
          ...(state.failures || []).map(f => ({ key: f.key, note: 'report not requested: ' + f.error }))];
        moData = data;
        moRunClear();
        moSetStatus('');
        moSetBusy(false);
        moRender(data);
      } catch (err) {
        console.error('[MO] collect failed:', err);
        // Download URLs are short-lived, so a failed collect means starting over.
        moRunClear();
        moSetStatus('', err.message);
        moSetBusy(false);
      }
    }

    // ─── RENDER ──────────────────────────────────────────────────────────────

    function moRenderIdle() {
      const container = document.getElementById('admonthly-content');
      if (!container) return;
      container.innerHTML = `
        <div class="card card-flat" style="text-align: center; padding: 4rem 2rem;">
          <div style="font-size: 2.5rem; opacity: 0.35; margin-bottom: 1rem;">📅</div>
          <div style="color: var(--text-secondary); max-width: 44rem; margin: 0 auto; line-height: 1.6;">
            The most recent complete calendar month per brand, against the month before it.
            A month settles on the 15th of the next one, once Sponsored Brands has finished
            crediting its last day. Each brand gets a recommended posture &mdash; Scale, Hold
            Steady or Constrain &mdash; which is what the bi-weekly reads to decide how hard to
            push that brand. The two Sponsored Brands campaigns are shown underneath, since
            neither faster cadence covers them.
          </div>
        </div>`;
    }

    function moRender(data) {
      const container = document.getElementById('admonthly-content');
      if (!container) return;
      const w = data.window || {};
      moSetBlurb(`${moMonthLabel(w.month)} · collected ${
        data.collectedAt ? _svTimeAgo(data.collectedAt) : 'just now'}`);

      container.innerHTML =
        moCounts(data) + moBrandTable(data) + moSbTable(data) + moFooter(data);
      moBindActions();
    }

    function moCounts(data) {
      const c = data.counts || {};
      const w = data.window || {};
      const pill = (n, label, cls) =>
        `<span class="bw-pill ${cls}">${n} ${label}</span>`;
      return `
        <div class="bw-head">
          <div class="bw-pills">
            ${pill(c.scale || 0, 'scale', 'bw-up')}
            ${pill(c.hold || 0, 'hold steady', 'bw-hold')}
            ${pill(c.constrain || 0, 'constrain', 'bw-down')}
            ${c.changed ? pill(c.changed, 'differ from current', 'bw-tag') : ''}
          </div>
          <div class="bw-window">
            ${escapeHtml(moMonthLabel(w.month))}
            <span class="bw-muted">against ${escapeHtml(moMonthLabel(w.priorMonth))}</span>
          </div>
        </div>`;
    }

    // One table, because brand performance, budget share and next-month
    // priorities are one decision. The posture control is the action; every
    // other column is the evidence for it.
    function moBrandTable(data) {
      const rows = data.rows || [];
      if (!rows.length) {
        return '<div class="card arf-section"><p class="arf-none">' +
               'No brand had an enabled Sponsored Products campaign in this window.</p></div>';
      }
      return `
        <div class="card arf-section">
          <h4>Brand posture</h4>
          <p class="arf-blurb">
            Sponsored Products, one calendar month against the one before. Profit retention
            is the decision metric; ACoS against target is shown because it is what you think
            in. Every column that drives a posture is a ratio, so unequal month lengths
            cancel &mdash; only the spend and sales dollars read as "that month". Ad share
            counts Sponsored Brands too, and comes from orders rather than the ad reports.
          </p>
          <div class="arf-table-wrap">
            <table class="table-fill arf-table">
              <thead>
                <tr>
                  <th>Brand</th>
                  <th>Spend</th>
                  <th>Ad sales</th>
                  <th>ACoS</th>
                  <th>vs target</th>
                  <th>Retention</th>
                  <th>vs last month</th>
                  <th>Spend / sales share</th>
                  <th>Ad share</th>
                  <th>Recommended</th>
                  <th>Posture</th>
                </tr>
              </thead>
              <tbody>${rows.map(moBrandRow).join('')}</tbody>
            </table>
          </div>
        </div>`;
    }

    function moBrandRow(r) {
      const delta = r.retentionDelta;
      const deltaCell = delta === null || delta === undefined
        ? '<span class="arf-muted">—</span>'
        : `<span class="${delta >= 0 ? 'bw-up' : 'bw-down'}">${
             delta >= 0 ? '+' : ''}${moPct(delta)}</span>`;
      const gap = r.gapVsTarget;
      const gapCell = gap === null || gap === undefined
        ? '<span class="arf-muted">—</span>'
        : `<span class="${gap <= 0 ? 'bw-up' : 'bw-down'}">${gap >= 0 ? '+' : ''}${moPct(gap)}</span>`;
      return `
        <tr>
          <td class="arf-name">${escapeHtml(r.brand)}
            <div class="arf-sub">${escapeHtml(r.reason || '')}${
              r.adDependent
                ? ' <span class="bw-warn">· ads carry this brand, so a constrain has no organic floor under it</span>'
                : ''}</div>
          </td>
          <td>${moMoney(r.spend)}</td>
          <td>${moMoney(r.sales)}</td>
          <td>${moPct(r.acos)}</td>
          <td>${gapCell}</td>
          <td>${moPct(r.retention)}</td>
          <td>${deltaCell}</td>
          <td>${moPct(r.spendShare)} / ${moPct(r.salesShare)}</td>
          <td>${r.adShare === null ? '<span class="arf-muted">—</span>' : moPct(r.adShare)}</td>
          <td><span class="bw-pill ${moPostureClass(r.recommended)}">${escapeHtml(moPostureLabel(r.recommended))}</span></td>
          <td>${moPostureSelect(r)}</td>
        </tr>`;
    }

    // Writes through the bi-weekly's posture endpoint on purpose: it is the
    // same stored object, read by the same decision tree. A second endpoint
    // would be a second place for them to disagree.
    function moPostureSelect(r) {
      const brand = escapeHtml(r.brand);
      const busy = moSaving[r.brand];
      const opts = [['scale', 'Scale'], ['hold', 'Hold Steady'], ['constrain', 'Constrain']]
        .map(([v, label]) => `<option value="${v}"${r.posture === v ? ' selected' : ''}>${label}</option>`)
        .join('');
      return `<select data-mo-posture="${brand}"${busy ? ' disabled' : ''}>${opts}</select>${
        r.changed && !busy
          ? `<button class="arf-btn" data-mo-adopt="${brand}" title="Set ${brand} to ${
              escapeHtml(moPostureLabel(r.recommended))}">Use ${
              escapeHtml(moPostureLabel(r.recommended))}</button>`
          : ''}`;
    }

    const MO_POSTURE_LABELS = { scale: 'Scale', hold: 'Hold Steady', constrain: 'Constrain' };
    function moPostureLabel(p) { return MO_POSTURE_LABELS[p] || p || '—'; }
    function moPostureClass(p) {
      return p === 'scale' ? 'bw-up' : (p === 'constrain' ? 'bw-down' : 'bw-hold');
    }

    // Two rows. No purpose labels and no diagnostic framework: the doc reads
    // those from a catalog field that does not exist, and two campaigns do not
    // justify building one. New-to-brand is the case for running SB at all, so
    // it is the column that matters here.
    function moSbTable(data) {
      const rows = data.sbRows || [];
      if (!rows.length) {
        return `
          <div class="card arf-section">
            <h4>Sponsored Brands</h4>
            <p class="arf-none">No enabled Sponsored Brands campaign reported in this window.</p>
          </div>`;
      }
      const noNtb = rows.every(r => r.ntbOrders === null);
      return `
        <div class="card arf-section">
          <h4>Sponsored Brands</h4>
          <p class="arf-blurb">
            Neither faster cadence covers these, so this is the only place they are looked
            at. New-to-brand is the reason to run Sponsored Brands at all: a low share means
            the campaign is mostly catching people who already know you.${
              noNtb ? ' <span class="bw-warn">Amazon did not return new-to-brand for this run.</span>' : ''}
          </p>
          <div class="arf-table-wrap">
            <table class="table-fill arf-table">
              <thead>
                <tr>
                  <th>Campaign</th>
                  <th>Brand</th>
                  <th>Budget</th>
                  <th>Spend</th>
                  <th>Sales</th>
                  <th>Orders</th>
                  <th>ACoS</th>
                  <th>Retention</th>
                  <th>New to brand</th>
                </tr>
              </thead>
              <tbody>${rows.map(r => `
                <tr>
                  <td class="arf-name">${escapeHtml(r.campaign)}</td>
                  <td>${escapeHtml(r.brand || '—')}</td>
                  <td>${moMoney(r.dailyBudget)}</td>
                  <td>${moMoney(r.spend)}</td>
                  <td>${moMoney(r.sales)}</td>
                  <td>${formatNumber(r.orders)}</td>
                  <td>${moPct(r.acos)}</td>
                  <td>${moPct(r.retention)}</td>
                  <td>${r.ntbOrderShare === null
                        ? '<span class="arf-muted">—</span>'
                        : `${moPct(r.ntbOrderShare)} of orders<div class="arf-sub">${
                            moPct(r.ntbSalesShare)} of sales</div>`}</td>
                </tr>`).join('')}</tbody>
            </table>
          </div>
        </div>`;
    }

    function moFooter(data) {
      const cov = data.coverage || {};
      const orders = data.orders || {};
      const bits = [];
      if (cov.evaluated) bits.push(`${cov.evaluated} campaigns evaluated`);
      if (cov.orphanRows) bits.push(`${cov.orphanRows} report rows had no enabled campaign behind them`);
      if ((cov.unmapped || []).length) {
        bits.push(`${cov.unmapped.length} campaigns spent without a brand mapping`);
      }
      if (!orders.available) {
        bits.push('Ad share is unavailable: no order data covers this window');
      } else if (orders.unmappedSkus) {
        bits.push(`${orders.unmappedSkus} SKUs have no brand in the catalog, ` +
                  `so ${moMoney(orders.unmappedSales)} of sales is missing from ad share`);
      }
      return `
        <div class="card card-flat arf-footer">
          ${bits.length ? `<div>${escapeHtml(bits.join(' · '))}</div>` : ''}
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

    function moBindActions() {
      // The container persists across renders — only innerHTML is replaced —
      // so binding per render would stack duplicate handlers.
      if (moBound) return;
      const el = document.getElementById('admonthly-content');
      if (!el) return;
      el.addEventListener('click', e => {
        const btn = e.target.closest('[data-mo-adopt]');
        if (btn) {
          const brand = btn.dataset.moAdopt;
          const row = (moData?.rows || []).find(r => r.brand === brand);
          if (row) moSavePosture(brand, row.recommended);
        }
      });
      el.addEventListener('change', e => {
        const sel = e.target.closest('[data-mo-posture]');
        if (sel) moSavePosture(sel.dataset.moPosture, sel.value);
      });
      moBound = true;
    }

    async function moSavePosture(brand, posture) {
      if (!brand || !posture || moSaving[brand] || !accessToken) return;
      moSaving[brand] = true;
      if (moData) moRender(moData);
      try {
        const res = await fetch('/api/adspend?action=biweekly-posture', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ brand, posture })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Failed (${res.status})`);
        delete moSaving[brand];
        // Re-read rather than patching locally: the server decides from the
        // stored postures, so this picks up exactly what it just saved.
        await moFetch(`${brand} is now ${moPostureLabel(posture)}. The bi-weekly reads this on its next load.`);
      } catch (err) {
        console.error('[MO] posture save failed:', err);
        delete moSaving[brand];
        moSetStatus('', err.message);
        if (moData) moRender(moData);
      }
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────────

    function moMoney(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      const v = Math.round(n * 100) / 100;
      return (v < 0 ? '-$' : '$') + formatNumber(Math.abs(v));
    }

    const MO_MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
                            'July', 'August', 'September', 'October', 'November', 'December'];

    function moMonthLabel(ym) {
      if (!/^\d{4}-\d{2}$/.test(String(ym || ''))) return String(ym || '');
      const [y, m] = ym.split('-').map(Number);
      return `${MO_MONTH_NAMES[m - 1] || ym} ${y}`;
    }

    function moPct(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return Math.round(n * 100) + '%';
    }

    function moSetStatus(message, error) {
      const el = document.getElementById('mo-status');
      if (!el) return;
      if (!message && !error) { el.style.display = 'none'; el.innerHTML = ''; return; }
      el.style.display = 'block';
      el.innerHTML = error
        ? `<span style="color: var(--error);">${escapeHtml(error)}</span>`
        : escapeHtml(message);
    }

    function moSetBlurb(text) {
      const el = document.getElementById('admonthly-blurb');
      if (el) el.textContent = text;
    }

    function moSetBusy(busy) {
      const btn = document.getElementById('mo-run-btn');
      if (!btn) return;
      btn.disabled = busy;
      btn.innerHTML = busy ? 'Running<span class="loading"></span>'
                           : (moRunLoad() ? 'Check again' : 'Run monthly');
    }

    function moRunSave(state) {
      try { localStorage.setItem(MO_RUN_KEY, JSON.stringify(state)); } catch (e) { /* quota */ }
    }

    function moRunLoad() {
      try {
        const raw = localStorage.getItem(MO_RUN_KEY);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    }

    function moRunClear() {
      try { localStorage.removeItem(MO_RUN_KEY); } catch (e) { /* ignore */ }
    }
