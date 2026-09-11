    // ─── WEEKLY TRENDS ───────────────────────────────────────────────────────
    // The continuous series, replacing the spreadsheet that was kept by hand:
    // ten metrics against Monday-to-Sunday weeks, with the same chart groupings.
    //
    // Every number here is read, not decided. The five measured metrics come
    // from storage and the five ratios are computed server-side on each load,
    // so a brand re-mapped in Campaign Overview moves its own history.
    //
    // A week appears only once its attribution window has closed, which is why
    // the most recent complete week is not the most recent week shown. The
    // sheet had no such rule, and its recent weeks were understated for it.
    //
    // Everything is prefixed `wk`. These files share one global scope, so
    // escapeHtml / formatNumber / _svTimeAgo are CALLED, never redefined.

    const WK_RANGES = [
      { weeks: 13, label: '13 weeks' },
      { weeks: 26, label: '26 weeks' },
      { weeks: 52, label: '52 weeks' },
      { weeks: 260, label: 'Everything' }
    ];

    // Row order and formatting, matching the sheet it replaces.
    const WK_METRICS = [
      { key: 'impressions', label: 'Impressions', fmt: 'int' },
      { key: 'clicks', label: 'Clicks', fmt: 'int' },
      { key: 'orders', label: 'Orders', fmt: 'int' },
      { key: 'spend', label: 'Spend', fmt: 'money' },
      { key: 'sales', label: 'Sales', fmt: 'money' },
      { key: 'acos', label: 'ACoS', fmt: 'pct' },
      { key: 'roas', label: 'ROAS', fmt: 'x' },
      { key: 'cpc', label: 'CPC', fmt: 'money2' },
      { key: 'ctr', label: 'CTR', fmt: 'pct2' },
      { key: 'cvr', label: 'CVR', fmt: 'pct2' }
    ];

    // The sheet's three chart tabs, kept as three groups on one page. The sheet
    // ran Conversion at degree 4 and the rest at 2; everything is 4 here, so a
    // curve that turns more than twice across the year is followed rather than
    // flattened. The cost is that a fit now needs six weeks rather than four.
    const WK_CHART_GROUPS = [
      { title: 'Sales & Spend', degree: 4, keys: ['sales', 'orders', 'spend', 'cpc'] },
      { title: 'ROAS & ACoS', degree: 4, keys: ['roas', 'acos'] },
      { title: 'Conversion', degree: 4, keys: ['impressions', 'clicks', 'ctr', 'cvr'] }
    ];

    let wkData = null;
    let wkBrand = 'all';
    let wkWeeks = 26;
    let wkBound = false;
    let wkBusy = false;
    let wkCharts = [];

    function loadAdWeekly() {
      const container = document.getElementById('adweekly-content');
      if (!container) return;
      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Sign in to view weekly trends.</div>';
        return;
      }
      wkFetch();
    }

    async function wkFetch(after) {
      try {
        const qs = `weeks=${wkWeeks}&brand=${encodeURIComponent(wkBrand)}`;
        const res = await fetch(`/api/adspend?action=weeks-get&${qs}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Load failed (${res.status})`);
        if (data.empty) { wkData = null; return wkRenderIdle(); }
        wkData = data;
        wkRender(data);
        if (after) wkSetStatus(after);
      } catch (err) {
        console.error('[WK] load failed:', err);
        wkSetStatus('', err.message);
      }
    }

    // One-time, and safe to repeat: every week it writes has already settled,
    // so a second run produces identical numbers.
    async function wkRebuild() {
      if (wkBusy || !accessToken) return;
      wkBusy = true;
      wkSetBusy(true);
      wkSetStatus('Rebuilding weeks from stored monthly data…');
      try {
        const res = await fetch('/api/adspend?action=weeks-rebuild', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Rebuild failed (${res.status})`);
        const skipped = (data.skipped || []).length;
        await wkFetch(`Rebuilt ${data.weeks} weeks from ${(data.months || []).length} months` +
                      (skipped ? `. ${skipped} months held spend only and were left out.` : '.'));
      } catch (err) {
        console.error('[WK] rebuild failed:', err);
        wkSetStatus('', err.message);
      } finally {
        wkBusy = false;
        wkSetBusy(false);
      }
    }

    // ─── RENDER ──────────────────────────────────────────────────────────────

    function wkRenderIdle() {
      const container = document.getElementById('adweekly-content');
      if (!container) return;
      wkDestroyCharts();
      container.innerHTML = `
        <div class="card card-flat" style="text-align: center; padding: 4rem 2rem;">
          <div style="font-size: 2.5rem; opacity: 0.35; margin-bottom: 1rem;">📈</div>
          <div style="color: var(--text-secondary); max-width: 44rem; margin: 0 auto; line-height: 1.6;">
            Ten metrics against Monday-to-Sunday weeks, the continuous series the
            weekly, bi-weekly and monthly pages never kept. Nothing has been built yet.
            <div style="margin-top: 1rem;">
              Build it from the monthly ad spend data already stored. Those months carry
              daily rows, so they re-bin into weeks. Months holding spend and nothing else
              are left out rather than drawn as a week with no clicks in it.
            </div>
          </div>
          <button class="btn btn-primary" style="margin-top: 1.5rem;" data-wk-rebuild>Build the series</button>
        </div>`;
      wkBindActions();
    }

    function wkRender(data) {
      const container = document.getElementById('adweekly-content');
      if (!container) return;
      wkDestroyCharts();

      const s = data.series || [];
      wkSetBlurb(s.length
        ? `${s.length} weeks · ${s[0].week} to ${s[s.length - 1].weekEnd}`
        : 'no weeks in range');

      // Charts first: the shape of the year is what the page is for, and the
      // table is what you drop to when a curve raises a question.
      container.innerHTML =
        wkControls(data) + wkSummary(data) + wkChartFrames() + wkTable(data) + wkFooter(data);
      wkBindActions();
      wkDrawCharts(data);
    }

    function wkControls(data) {
      const brands = data.brands || [];
      return `
        <div class="card card-flat wk-controls">
          <label class="wk-field">
            <span>Brand</span>
            <select data-wk-brand>
              <option value="all"${wkBrand === 'all' ? ' selected' : ''}>All brands</option>
              ${brands.map(b => `<option value="${escapeHtml(b)}"${
                wkBrand === b ? ' selected' : ''}>${escapeHtml(b)}</option>`).join('')}
            </select>
          </label>
          <label class="wk-field">
            <span>Range</span>
            <select data-wk-weeks>
              ${WK_RANGES.map(r => `<option value="${r.weeks}"${
                wkWeeks === r.weeks ? ' selected' : ''}>${r.label}</option>`).join('')}
            </select>
          </label>
          <span class="wk-spacer"></span>
          <button class="arf-btn" data-wk-rebuild
                  title="Re-bin the stored monthly data into weeks. Safe to repeat.">Rebuild from months</button>
        </div>`;
    }

    function wkSummary(data) {
      const t = data.totals || {};
      const cell = (label, value) =>
        `<div class="wk-stat"><span class="wk-stat-label">${label}</span>
           <span class="wk-stat-value">${value}</span></div>`;
      return `
        <div class="card card-flat wk-stats">
          ${cell('Spend', wkMoney(t.spend))}
          ${cell('Sales', wkMoney(t.sales))}
          ${cell('Orders', formatNumber(t.orders || 0))}
          ${cell('ACoS', wkPct(t.acos))}
          ${cell('ROAS', t.roas === null || t.roas === undefined ? '—' : t.roas.toFixed(2))}
          ${cell('CPC', wkMoney2(t.cpc))}
        </div>`;
    }

    // Metrics down the side, weeks across the top, exactly as the sheet had it.
    // The label column is sticky because 52 weeks is a long way to scroll back.
    function wkTable(data) {
      const s = data.series || [];
      if (!s.length) return '<div class="card arf-section"><p class="arf-none">No weeks in this range.</p></div>';
      return `
        <div class="card arf-section">
          <h4>Weekly detail</h4>
          <div class="arf-table-wrap">
            <table class="table-fill arf-table wk-table">
              <thead>
                <tr>
                  <th class="wk-sticky">Metric</th>
                  ${s.map(w => `<th title="${escapeHtml(w.week)} to ${escapeHtml(w.weekEnd)}">${
                    escapeHtml(wkWeekLabel(w))}</th>`).join('')}
                </tr>
              </thead>
              <tbody>
                ${WK_METRICS.map(m => `
                  <tr>
                    <td class="wk-sticky arf-name">${m.label}</td>
                    ${s.map(w => `<td>${wkFormat(w[m.key], m.fmt)}</td>`).join('')}
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>`;
    }

    function wkChartFrames() {
      return WK_CHART_GROUPS.map(g => `
        <div class="card arf-section">
          <h4>${g.title} <span class="arf-muted wk-degree">polynomial trend, degree ${
            g.degree}</span></h4>
          <div class="wk-charts">
            ${g.keys.map(k => `
              <div class="wk-chart">
                <div class="wk-chart-title">${
                  (WK_METRICS.find(m => m.key === k) || {}).label || k}</div>
                <canvas id="wk-chart-${k}"></canvas>
              </div>`).join('')}
          </div>
        </div>`).join('');
    }

    function wkFooter(data) {
      const cov = data.coverage || {};
      const bits = [];
      if (data.settledThrough) {
        bits.push(`Weeks are written once attribution closes, so the series ends ` +
                  `${data.settledThrough}`);
      }
      if (cov.unmappedCampaigns) {
        bits.push(`${cov.unmappedCampaigns} campaigns carry no brand, holding ` +
                  `${wkMoney(cov.unmappedSpend)} of spend`);
      }
      return `
        <div class="card card-flat arf-footer">
          ${bits.length ? `<div>${escapeHtml(bits.join(' · '))}</div>` : ''}
          <div class="arf-muted">Sponsored Products only. Sponsored Brands has no stored
            conversion history, so including it would change what the ratios mean.</div>
          ${data.censusSyncedAt
            ? `<div class="arf-muted">Brand mapping read from a campaign snapshot synced ${
                escapeHtml(_svTimeAgo(data.censusSyncedAt))}</div>`
            : ''}
        </div>`;
    }

    // ─── CHARTS ──────────────────────────────────────────────────────────────

    // Least-squares polynomial fit, which is what the spreadsheet drew over each
    // of these charts. Returns a fitted value per point, or null when a fit
    // would be dishonest.
    //
    // x is normalised to [-1, 1] before fitting. Left as a week index, a
    // degree-4 fit over 52 weeks builds normal equations reaching x^8, around
    // 4.6e13, and the smallest and largest entries differ by enough orders of
    // magnitude to lose most of the available precision.
    function wkPolyFit(values, degree) {
      const n = values.length;
      const xOf = (i) => (n === 1 ? 0 : (2 * i) / (n - 1) - 1);

      // Weeks with no value are left out of the fit rather than read as zero.
      // A rate is absent when there were no clicks, which is not the same as a
      // rate of nothing, and would drag the curve to the floor.
      const pts = [];
      for (let i = 0; i < n; i++) {
        const y = values[i];
        if (y === null || y === undefined || typeof y !== 'number' || !isFinite(y)) continue;
        pts.push([xOf(i), y]);
      }
      // A degree-d curve laid through d+1 points passes exactly through all of
      // them. That is interpolation wearing a trend's clothes, so it is refused.
      if (pts.length < degree + 2) return null;

      const m = degree + 1;
      // Normal equations, built straight from power sums: (XᵀX)c = Xᵀy.
      const A = [];
      for (let r = 0; r < m; r++) {
        const row = new Array(m + 1).fill(0);
        for (let c = 0; c < m; c++) {
          let sum = 0;
          for (const [x] of pts) sum += Math.pow(x, r + c);
          row[c] = sum;
        }
        let sum = 0;
        for (const [x, y] of pts) sum += y * Math.pow(x, r);
        row[m] = sum;
        A.push(row);
      }

      // Gauss-Jordan with partial pivoting.
      for (let col = 0; col < m; col++) {
        let piv = col;
        for (let r = col + 1; r < m; r++) {
          if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
        }
        // Singular: every x identical, or a degree the data cannot support.
        // No curve is better than a fabricated one.
        if (Math.abs(A[piv][col]) < 1e-12) return null;
        const t = A[col]; A[col] = A[piv]; A[piv] = t;
        for (let r = 0; r < m; r++) {
          if (r === col) continue;
          const f = A[r][col] / A[col][col];
          for (let c = col; c <= m; c++) A[r][c] -= f * A[col][c];
        }
      }

      const coef = A.map((row, i) => row[m] / row[i]);
      if (coef.some(c => !isFinite(c))) return null;

      const out = [];
      for (let i = 0; i < n; i++) {
        const x = xOf(i);
        let y = 0;
        for (let k = 0; k < m; k++) y += coef[k] * Math.pow(x, k);
        out.push(y);
      }
      return out;
    }

    function wkDestroyCharts() {
      for (const c of wkCharts) { try { c.destroy(); } catch (e) { /* already gone */ } }
      wkCharts = [];
    }

    function wkDrawCharts(data) {
      if (typeof Chart === 'undefined') return;
      const s = data.series || [];
      if (!s.length) return;
      const labels = s.map(wkWeekLabel);

      for (const g of WK_CHART_GROUPS) {
        for (const key of g.keys) {
          const el = document.getElementById(`wk-chart-${key}`);
          if (!el) continue;
          const meta = WK_METRICS.find(m => m.key === key) || { fmt: 'int' };
          const pct = meta.fmt === 'pct' || meta.fmt === 'pct2';
          // null stays a gap rather than a zero: a week with no clicks has no
          // CPC, and drawing it at the axis would read as free.
          const values = s.map(w => (w[key] === null || w[key] === undefined)
            ? null : (pct ? w[key] * 100 : w[key]));

          const datasets = [{
            label: meta.label || key,
            data: values,
            backgroundColor: 'rgba(59, 130, 246, 0.55)',
            borderColor: 'rgb(59, 130, 246)',
            borderWidth: 1,
            // Higher order draws first, so the bars sit behind the curve.
            order: 1
          }];

          const trend = wkPolyFit(values, g.degree);
          if (trend) {
            datasets.push({
              type: 'line',
              label: `Trend (degree ${g.degree})`,
              data: trend,
              borderColor: 'rgb(249, 115, 22)',
              borderWidth: 2,
              pointRadius: 0,
              pointHitRadius: 0,
              fill: false,
              tension: 0.3,
              order: 0
            });
          }

          wkCharts.push(new Chart(el.getContext('2d'), {
            type: 'bar',
            data: { labels, datasets },
            options: {
              responsive: true,
              maintainAspectRatio: false,
              plugins: { legend: { display: false } },
              scales: {
                x: { ticks: { maxRotation: 90, minRotation: 45, autoSkip: true, maxTicksLimit: 14 } },
                y: { beginAtZero: true }
              }
            }
          }));
        }
      }
    }

    // ─── ACTIONS ─────────────────────────────────────────────────────────────

    function wkBindActions() {
      if (wkBound) return;
      const el = document.getElementById('adweekly-content');
      if (!el) return;
      el.addEventListener('click', e => {
        if (e.target.closest('[data-wk-rebuild]')) wkRebuild();
      });
      el.addEventListener('change', e => {
        const b = e.target.closest('[data-wk-brand]');
        if (b) { wkBrand = b.value; return wkFetch(); }
        const w = e.target.closest('[data-wk-weeks]');
        if (w) { wkWeeks = Number(w.value) || 26; return wkFetch(); }
      });
      wkBound = true;
    }

    // ─── HELPERS ─────────────────────────────────────────────────────────────

    // '2026-03-02' with a Sunday of '2026-03-08' reads as '3/2-3/8', which is
    // how the sheet labelled its columns.
    function wkWeekLabel(w) {
      const short = (iso) => {
        const [, m, d] = iso.split('-');
        return `${Number(m)}/${Number(d)}`;
      };
      return `${short(w.week)}-${short(w.weekEnd)}`;
    }

    function wkFormat(v, fmt) {
      if (v === null || v === undefined || (typeof v === 'number' && !isFinite(v))) return '—';
      if (fmt === 'int') return formatNumber(Math.round(v));
      if (fmt === 'money') return wkMoney(v);
      if (fmt === 'money2') return wkMoney2(v);
      if (fmt === 'pct') return wkPct(v);
      if (fmt === 'pct2') return (v * 100).toFixed(2) + '%';
      if (fmt === 'x') return v.toFixed(2);
      return String(v);
    }

    function wkMoney(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      const v = Math.round(n);
      return (v < 0 ? '-$' : '$') + formatNumber(Math.abs(v));
    }

    function wkMoney2(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
    }

    function wkPct(n) {
      if (typeof n !== 'number' || !isFinite(n)) return '—';
      return Math.round(n * 100) + '%';
    }

    function wkSetStatus(message, error) {
      const el = document.getElementById('wk-status');
      if (!el) return;
      if (!message && !error) { el.style.display = 'none'; el.innerHTML = ''; return; }
      el.style.display = 'block';
      el.innerHTML = error
        ? `<span style="color: var(--error);">${escapeHtml(error)}</span>`
        : escapeHtml(message);
    }

    function wkSetBlurb(text) {
      const el = document.getElementById('adweekly-blurb');
      if (el) el.textContent = text;
    }

    function wkSetBusy(busy) {
      for (const btn of document.querySelectorAll('[data-wk-rebuild]')) {
        btn.disabled = busy;
        btn.textContent = busy ? 'Rebuilding…' : 'Rebuild from months';
      }
    }
