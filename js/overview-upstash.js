    // Profitability Overview — Upstash-backed variant.
    //
    // Runs alongside the existing Sheets-backed Monthly / YTD tabs so the
    // numbers can be compared side-by-side while we verify the migration.
    // Pulls transactions from /api/transactions (SP-API Finances → Upstash
    // monthly aggregates) and products from /api/products. Ad spend,
    // shipping costs, and campaign → brand mapping are NOT yet migrated —
    // those columns show zero with a note until the rest of the pipeline
    // is in place.

    // ─── VIEW SWITCHING ─────────────────────────────────────────────────

    // Hide every top-level view under #overview-page and clear the active
    // state from every overview tab. Each show*() function calls this
    // first, then flips its own view + tab on.
    function _hideAllOverviewViews() {
      ['ytd-view', 'monthly-view', 'ytd-upstash-view', 'monthly-upstash-view']
        .forEach(id => {
          const el = document.getElementById(id);
          if (el) el.style.display = 'none';
        });
      document.querySelectorAll('#overview-page .page-header .tabs .tab')
        .forEach(t => t.classList.remove('active'));
    }

    function showMonthlyUpstash() {
      _hideAllOverviewViews();
      document.getElementById('monthly-upstash-view').style.display = 'block';
      document.getElementById('monthly-upstash-tab').classList.add('active');
      _initMonthlyUpstashDropdowns();
    }

    function showYTDUpstash() {
      _hideAllOverviewViews();
      document.getElementById('ytd-upstash-view').style.display = 'block';
      document.getElementById('ytd-upstash-tab').classList.add('active');
      _initYTDUpstashDropdown();
    }

    // ─── DROPDOWN INIT ──────────────────────────────────────────────────

    function _initMonthlyUpstashDropdowns() {
      const yearSel = document.getElementById('monthly-upstash-year-select');
      if (yearSel && yearSel.options.length === 0) {
        const currentYear = new Date().getFullYear();
        for (let y = currentYear; y >= currentYear - 5; y--) {
          const o = document.createElement('option');
          o.value = y; o.textContent = y;
          yearSel.appendChild(o);
        }
        yearSel.value = currentYear;
      }
      const monthSel = document.getElementById('monthly-upstash-month-select');
      if (monthSel && !monthSel.value) {
        // Default to last completed month.
        const now = new Date();
        const lastMonth = now.getMonth() - 1;
        monthSel.value = lastMonth >= 0 ? lastMonth : 11;
      }
    }

    function _initYTDUpstashDropdown() {
      const yearSel = document.getElementById('ytd-upstash-year-select');
      if (yearSel && yearSel.options.length === 0) {
        const currentYear = new Date().getFullYear();
        for (let y = currentYear; y >= currentYear - 5; y--) {
          const o = document.createElement('option');
          o.value = y; o.textContent = y;
          yearSel.appendChild(o);
        }
        yearSel.value = currentYear;
      }
    }

    function setMonthlyUpstashLastMonth() {
      const now = new Date();
      let month = now.getMonth() - 1;
      let year = now.getFullYear();
      if (month < 0) { month = 11; year--; }
      document.getElementById('monthly-upstash-month-select').value = month;
      const yearSel = document.getElementById('monthly-upstash-year-select');
      if (yearSel && [...yearSel.options].some(o => parseInt(o.value, 10) === year)) {
        yearSel.value = year;
      }
      generateMonthlyUpstashReport();
    }

    function setYTDUpstashYear(which) {
      const now = new Date();
      const year = which === 'thisYear' ? now.getFullYear() : now.getFullYear() - 1;
      const yearSel = document.getElementById('ytd-upstash-year-select');
      if (yearSel && [...yearSel.options].some(o => parseInt(o.value, 10) === year)) {
        yearSel.value = year;
      }
      generateYTDUpstashReport();
    }

    // ─── REPORT GENERATION ──────────────────────────────────────────────

    async function generateMonthlyUpstashReport() {
      const container = document.getElementById('monthly-upstash-content');
      if (!accessToken) {
        container.innerHTML = _placeholder('Sign in to view monthly profitability');
        return;
      }

      const month = parseInt(document.getElementById('monthly-upstash-month-select').value, 10);
      const year  = parseInt(document.getElementById('monthly-upstash-year-select').value, 10);
      if (!Number.isFinite(month) || !Number.isFinite(year)) {
        container.innerHTML = _placeholder('Pick a month and year');
        return;
      }
      const yyyyMM = `${year}-${String(month + 1).padStart(2, '0')}`;

      container.innerHTML = _placeholder('Loading...');

      try {
        const { aggregates, products, lastSynced } = await _fetchMonthData(yyyyMM);
        if (aggregates.length === 0) {
          container.innerHTML = _noDataForMonth(yyyyMM);
          return;
        }
        const metrics = _computeMetrics(aggregates, products);
        container.innerHTML = _renderReport(yyyyMM, metrics, lastSynced);
      } catch (err) {
        console.error('Monthly Upstash report failed:', err);
        container.innerHTML = `<div style="padding: 2rem; color: var(--error);">Error: ${err.message}</div>`;
      }
    }

    async function generateYTDUpstashReport() {
      const container = document.getElementById('ytd-upstash-content');
      if (!accessToken) {
        container.innerHTML = _placeholder('Sign in to view YTD profitability');
        return;
      }

      const year = parseInt(document.getElementById('ytd-upstash-year-select').value, 10);
      if (!Number.isFinite(year)) {
        container.innerHTML = _placeholder('Pick a year');
        return;
      }

      container.innerHTML = _placeholder('Loading...');

      try {
        const { aggregates, products } = await _fetchRangeData(`${year}-01`, `${year}-12`);
        if (aggregates.length === 0) {
          container.innerHTML = _noDataForYear(year);
          return;
        }
        const metrics = _computeMetrics(aggregates, products);
        container.innerHTML = _renderReport(`${year} YTD`, metrics, null);
      } catch (err) {
        console.error('YTD Upstash report failed:', err);
        container.innerHTML = `<div style="padding: 2rem; color: var(--error);">Error: ${err.message}</div>`;
      }
    }

    // ─── DATA FETCH ─────────────────────────────────────────────────────

    async function _fetchMonthData(yyyyMM) {
      const headers = { Authorization: `Bearer ${accessToken}` };
      const [txRes, prodRes] = await Promise.all([
        fetch(`/api/transactions?action=get&month=${yyyyMM}`, { headers }),
        fetch('/api/products?action=get', { headers })
      ]);
      if (!txRes.ok)   throw new Error(`Transactions fetch failed (${txRes.status})`);
      if (!prodRes.ok) throw new Error(`Products fetch failed (${prodRes.status})`);
      const txData   = await txRes.json();
      const prodData = await prodRes.json();
      return {
        aggregates: txData.aggregates || [],
        products:   prodData.products || [],
        lastSynced: txData.lastSynced || null
      };
    }

    async function _fetchRangeData(startMonth, endMonth) {
      const headers = { Authorization: `Bearer ${accessToken}` };
      const [txRes, prodRes] = await Promise.all([
        fetch(`/api/transactions?action=get-range&startMonth=${startMonth}&endMonth=${endMonth}`, { headers }),
        fetch('/api/products?action=get', { headers })
      ]);
      if (!txRes.ok)   throw new Error(`Transactions fetch failed (${txRes.status})`);
      if (!prodRes.ok) throw new Error(`Products fetch failed (${prodRes.status})`);
      const txData   = await txRes.json();
      const prodData = await prodRes.json();
      return {
        aggregates: txData.aggregates || [],
        products:   prodData.products || []
      };
    }

    // ─── COMPUTATION ────────────────────────────────────────────────────

    // Fold aggregates + products into { fbm, fba, total } metrics. Matches
    // the shape ZERO_METRICS uses in brand-product.js so downstream code
    // can consume either pipeline interchangeably later.
    //
    // Sign conventions from api/transactions.js:
    //   - productSales, shippingCredits, giftWrapCredits  → positive
    //   - sellingFees, fbaFees, promotionalRebates, other → already negative
    // So we sum opex directly (it stays negative) and add it when computing
    // profit. Product cost is positive (multiplied by abs(quantity) to
    // handle the negative quantity that shows up on refund aggregates).
    function _computeMetrics(aggregates, products) {
      const bySku = {};
      for (const p of (products || [])) if (p?.sku) bySku[p.sku] = p;

      const empty = () => ({ income: 0, opex: 0, productCosts: 0, adSpend: 0, profit: 0, margin: 0 });
      const m = { fbm: empty(), fba: empty(), total: empty() };

      for (const a of aggregates) {
        const bucket = a.fulfillment === 'AFN' ? m.fba : m.fbm;
        const income = (a.productSales || 0) + (a.shippingCredits || 0) + (a.giftWrapCredits || 0);
        const opex   = (a.promotionalRebates || 0) + (a.sellingFees || 0) + (a.fbaFees || 0) + (a.other || 0);
        const unitCost = bySku[a.sku] ? (parseFloat(bySku[a.sku].cost) || 0) : 0;
        const productCost = unitCost * Math.abs(a.quantity || 0);

        bucket.income       += income;
        bucket.opex         += opex;           // stays negative
        bucket.productCosts += productCost;
      }

      for (const ch of ['fbm', 'fba']) {
        const b = m[ch];
        b.profit = b.income + b.opex - b.productCosts - b.adSpend;
        b.margin = b.income > 0 ? (b.profit / b.income) * 100 : 0;
      }
      m.total.income       = m.fbm.income       + m.fba.income;
      m.total.opex         = m.fbm.opex         + m.fba.opex;
      m.total.productCosts = m.fbm.productCosts + m.fba.productCosts;
      m.total.adSpend      = m.fbm.adSpend      + m.fba.adSpend;
      m.total.profit       = m.total.income + m.total.opex - m.total.productCosts - m.total.adSpend;
      m.total.margin       = m.total.income > 0 ? (m.total.profit / m.total.income) * 100 : 0;
      return m;
    }

    // ─── RENDER ─────────────────────────────────────────────────────────

    function _renderReport(label, m, lastSynced) {
      const fmt$   = (n) => '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const signed = (n) => (n < 0 ? '-' + fmt$(n) : fmt$(n));
      const pct    = (n) => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';

      const thLeft   = 'text-align: left;  padding: 0.75rem; background: var(--bg-secondary); font-weight: 600; font-size: 0.875rem;';
      const thRight  = 'text-align: right; padding: 0.75rem; background: var(--bg-secondary); font-weight: 600; font-size: 0.875rem;';
      const tdLabel  = 'padding: 0.75rem; border-bottom: 1px solid var(--border);';
      const tdNum    = `${tdLabel} text-align: right; font-family: 'Roboto Mono', monospace;`;

      const row = (rowLabel, key) => `
        <tr>
          <td style="${tdLabel}">${rowLabel}</td>
          <td style="${tdNum}">${fmt$(m.fbm[key])}</td>
          <td style="${tdNum}">${fmt$(m.fba[key])}</td>
          <td style="${tdNum}">${fmt$(m.total[key])}</td>
        </tr>`;

      const profitRow = `
        <tr style="font-weight: 700; background: var(--bg-secondary);">
          <td style="padding: 0.75rem;">Profit</td>
          <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; color: ${m.fbm.profit   >= 0 ? 'var(--success)' : 'var(--error)'};">${signed(m.fbm.profit)}</td>
          <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; color: ${m.fba.profit   >= 0 ? 'var(--success)' : 'var(--error)'};">${signed(m.fba.profit)}</td>
          <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; color: ${m.total.profit >= 0 ? 'var(--success)' : 'var(--error)'};">${signed(m.total.profit)}</td>
        </tr>`;

      const marginRow = `
        <tr>
          <td style="${tdLabel}">Margin</td>
          <td style="${tdNum}">${pct(m.fbm.margin)}</td>
          <td style="${tdNum}">${pct(m.fba.margin)}</td>
          <td style="${tdNum}">${pct(m.total.margin)}</td>
        </tr>`;

      const lastSyncedLine = lastSynced
        ? `<div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.5rem;">Last synced: ${_formatSyncTime(lastSynced)}</div>`
        : '';

      return `
        <div style="font-size: 1rem; font-weight: 600; margin-bottom: 0.75rem;">${label}</div>
        ${lastSyncedLine}

        <table style="width: 100%; border-collapse: collapse; margin-bottom: 1.5rem;">
          <thead>
            <tr>
              <th style="${thLeft}">Metric</th>
              <th style="${thRight}">FBM</th>
              <th style="${thRight}">FBA</th>
              <th style="${thRight}">Total</th>
            </tr>
          </thead>
          <tbody>
            ${row('Income', 'income')}
            ${row('OpEx (fees)', 'opex')}
            ${row('Product Costs', 'productCosts')}
            ${row('Ad Spend', 'adSpend')}
            ${profitRow}
            ${marginRow}
          </tbody>
        </table>

        <div style="padding: 0.75rem 1rem; background: var(--bg-secondary); border: 1px solid var(--warning); border-radius: 6px; font-size: 0.85rem; color: var(--text-secondary); line-height: 1.5;">
          <strong style="color: var(--text-primary);">Heads up:</strong>
          Ad Spend is $0 here because <code>/api/adspend</code> isn't built yet.
          Shipping costs (what we pay to ship) also aren't included — they're still in the ShippingCosts Sheet and not migrated.
          Income and fee totals should match the Sheets-based Monthly Profitability tab for the same month;
          Profit and Margin will differ until Ad Spend and Shipping are migrated.
        </div>
      `;
    }

    function _placeholder(text) {
      return `
        <div style="padding: 4rem; text-align: center; color: var(--text-secondary);">
          <div style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.3;">📊</div>
          <div style="font-size: 1.125rem;">${text}</div>
        </div>`;
    }

    function _noDataForMonth(yyyyMM) {
      return `
        <div style="padding: 3rem; text-align: center; color: var(--text-secondary);">
          <div style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.3;">📭</div>
          <div style="font-size: 1.125rem; margin-bottom: 0.5rem;">No transactions synced for ${yyyyMM}</div>
          <div style="font-size: 0.9rem;">Trigger a sync: <code>/api/transactions?action=sync&month=${yyyyMM}</code></div>
        </div>`;
    }

    function _noDataForYear(year) {
      return `
        <div style="padding: 3rem; text-align: center; color: var(--text-secondary);">
          <div style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.3;">📭</div>
          <div style="font-size: 1.125rem;">No transactions synced for any month in ${year}</div>
        </div>`;
    }

    function _formatSyncTime(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString(undefined, {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
    }
