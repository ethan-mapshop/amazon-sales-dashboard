    // Profitability Overview — backed by SP-API Finances v2024-06-19
    // listTransactions.
    //
    // Storage model: /api/transactions?action=sync-v2024 stores the raw
    // listTransactions response under transactions:v2024:raw:YYYY-MM. The
    // dedup rule (skip RELEASED transactions that carry a
    // DEFERRED_TRANSACTION_ID), the breakdown-leaf → statement-line routing
    // (V2024_LEAF_HANDLER), and the FBA/FBM split (from each item's
    // ProductContext.fulfillmentNetwork: AFN→FBA, MFN→FBM) all happen on
    // the client in _deriveV2024Rows. Iterating on the routing table
    // requires no re-sync — just reload the page.
    //
    // Two tabs in the UI:
    //   showMonthlyV2024() — Monthly Profitability for a single (year, month)
    //                        with current + prev-month + YoY comparisons
    //   showYTDV2024()     — Year-to-Date Profitability for a single year
    //                        with YoY comparisons
    //
    // Statement assembly path is shared: _computeV2024Period →
    // _fetchV2024Inputs (transactions + products + ad spend + shipping +
    // mappings) → _deriveV2024Rows → _allocateAdSpend → _buildStatement →
    // extractProfitabilityMetrics → renderFinancialStatement (in
    // brand-product.js). The Sheets-backed and v0-Upstash variants were
    // retired after v2024 validated against Sheets monthly totals; ad
    // spend and shipping costs still read from their separate KV stores.

    // ─── SHARED OVERVIEW STATE ──────────────────────────────────────────
    //
    // Per-page-session report cache shared across the Overview tabs. Keyed
    // by "{view}|{year}|{month?}". Stores final rendered innerHTML so
    // switching among tabs / back to a previously-viewed range is instant.
    // Cleared on page refresh. Attached to window so it survives module
    // boundaries; the `||` keeps it idempotent if anything else also
    // initializes it.
    window._overviewReportCache = window._overviewReportCache || new Map();

    // YoY comparison helper. Both paths (Monthly and YTD) feed metrics into
    // this; renderFinancialStatement reads `comparisons.<chan>.<line>.yoy|mom`
    // to draw the small percentage arrows next to each profitability line.
    function calculateComparisons(current, previous, yoy) {
      const calcChange = (curr, prev) => {
        if (!prev || prev === 0) return null;
        return ((curr - prev) / Math.abs(prev)) * 100;
      };
      return {
        fbm: {
          income: { yoy: calcChange(current.fbm.income, yoy.fbm.income), mom: calcChange(current.fbm.income, previous.fbm.income) },
          opex: { yoy: calcChange(current.fbm.opex, yoy.fbm.opex), mom: calcChange(current.fbm.opex, previous.fbm.opex) },
          productCosts: { yoy: calcChange(current.fbm.productCosts, yoy.fbm.productCosts), mom: calcChange(current.fbm.productCosts, previous.fbm.productCosts) },
          adSpend: { yoy: calcChange(current.fbm.adSpend, yoy.fbm.adSpend), mom: calcChange(current.fbm.adSpend, previous.fbm.adSpend) },
          profit: { yoy: calcChange(current.fbm.profit, yoy.fbm.profit), mom: calcChange(current.fbm.profit, previous.fbm.profit) },
          margin: { yoy: calcChange(current.fbm.margin, yoy.fbm.margin), mom: calcChange(current.fbm.margin, previous.fbm.margin) }
        },
        fba: {
          income: { yoy: calcChange(current.fba.income, yoy.fba.income), mom: calcChange(current.fba.income, yoy.fba.income) },
          opex: { yoy: calcChange(current.fba.opex, yoy.fba.opex), mom: calcChange(current.fba.opex, previous.fba.opex) },
          productCosts: { yoy: calcChange(current.fba.productCosts, yoy.fba.productCosts), mom: calcChange(current.fba.productCosts, previous.fba.productCosts) },
          adSpend: { yoy: calcChange(current.fba.adSpend, yoy.fba.adSpend), mom: calcChange(current.fba.adSpend, previous.fba.adSpend) },
          profit: { yoy: calcChange(current.fba.profit, yoy.fba.profit), mom: calcChange(current.fba.profit, previous.fba.profit) },
          margin: { yoy: calcChange(current.fba.margin, yoy.fba.margin), mom: calcChange(current.fba.margin, previous.fba.margin) }
        },
        total: {
          income: { yoy: calcChange(current.total.income, yoy.total.income), mom: calcChange(current.total.income, previous.total.income) },
          opex: { yoy: calcChange(current.total.opex, yoy.total.opex), mom: calcChange(current.total.opex, previous.total.opex) },
          productCosts: { yoy: calcChange(current.total.productCosts, yoy.total.productCosts), mom: calcChange(current.total.productCosts, previous.total.productCosts) },
          adSpend: { yoy: calcChange(current.total.adSpend, yoy.total.adSpend), mom: calcChange(current.total.adSpend, previous.total.adSpend) },
          profit: { yoy: calcChange(current.total.profit, yoy.total.profit), mom: calcChange(current.total.profit, previous.total.profit) },
          margin: { yoy: calcChange(current.total.margin, yoy.total.margin), mom: calcChange(current.total.margin, previous.total.margin) }
        }
      };
    }

    // YTD only computes YoY (no MoM). Same structure as calculateComparisons
    // but each line just has the .yoy field.
    function calculateYTDComparisons(current, previous) {
      const calcChange = (curr, prev) => {
        if (!prev || prev === 0) return null;
        return ((curr - prev) / Math.abs(prev)) * 100;
      };
      return {
        fbm: {
          income: { yoy: calcChange(current.fbm.income, previous.fbm.income) },
          opex: { yoy: calcChange(current.fbm.opex, previous.fbm.opex) },
          productCosts: { yoy: calcChange(current.fbm.productCosts, previous.fbm.productCosts) },
          adSpend: { yoy: calcChange(current.fbm.adSpend, previous.fbm.adSpend) },
          profit: { yoy: calcChange(current.fbm.profit, previous.fbm.profit) },
          margin: { yoy: calcChange(current.fbm.margin, previous.fbm.margin) }
        },
        fba: {
          income: { yoy: calcChange(current.fba.income, previous.fba.income) },
          opex: { yoy: calcChange(current.fba.opex, previous.fba.opex) },
          productCosts: { yoy: calcChange(current.fba.productCosts, previous.fba.productCosts) },
          adSpend: { yoy: calcChange(current.fba.adSpend, previous.fba.adSpend) },
          profit: { yoy: calcChange(current.fba.profit, previous.fba.profit) },
          margin: { yoy: calcChange(current.fba.margin, previous.fba.margin) }
        },
        total: {
          income: { yoy: calcChange(current.total.income, previous.total.income) },
          opex: { yoy: calcChange(current.total.opex, previous.total.opex) },
          productCosts: { yoy: calcChange(current.total.productCosts, previous.total.productCosts) },
          adSpend: { yoy: calcChange(current.total.adSpend, previous.total.adSpend) },
          profit: { yoy: calcChange(current.total.profit, previous.total.profit) },
          margin: { yoy: calcChange(current.total.margin, previous.total.margin) }
        }
      };
    }

    // ─── VIEW SWITCHING ─────────────────────────────────────────────────
    //
    // First-view auto-load flags: when the user clicks into a tab for the
    // first time in a page session, we default the dropdowns and run a
    // report so they're not staring at an empty placeholder. On subsequent
    // visits the dropdowns (and rendered content) stay as the user left
    // them.
    let _monthlyV2024AutoLoaded = false;
    let _ytdV2024AutoLoaded = false;

    // Same months-with-data pattern as _upstashMonthsSet but populated from
    // the v2024 sync's separate index (transactions:v2024:index). Used by
    // _refreshV2024NavButtons to disable Prev/Next when the target month
    // has no synced v2024 data yet.
    let _v2024MonthsSet = null;
    let _v2024MonthsPromise = null;


    function _hideAllOverviewViews() {
      ['monthly-v2024-view', 'ytd-v2024-view']
        .forEach(id => {
          const el = document.getElementById(id);
          if (el) el.style.display = 'none';
        });
      document.querySelectorAll('#overview-page .page-header .tabs .tab')
        .forEach(t => t.classList.remove('active'));
    }


    function showMonthlyV2024() {
      _hideAllOverviewViews();
      document.getElementById('monthly-v2024-view').style.display = 'block';
      document.getElementById('monthly-v2024-tab').classList.add('active');
      _initMonthlyV2024Dropdowns();
      if (!_monthlyV2024AutoLoaded && accessToken) {
        _monthlyV2024AutoLoaded = true;
        setMonthlyV2024Date('lastMonth');
      }
      _ensureV2024Months().then(() => _refreshV2024NavButtons());
      _refreshV2024NavButtons();
    }

    function _initMonthlyV2024Dropdowns() {
      const yearSel = document.getElementById('monthly-v2024-year-select');
      if (yearSel && yearSel.options.length === 0) {
        const currentYear = new Date().getFullYear();
        for (let y = currentYear; y >= currentYear - 5; y--) {
          const o = document.createElement('option');
          o.value = y; o.textContent = y;
          yearSel.appendChild(o);
        }
        yearSel.value = currentYear;
      }
      const monthSel = document.getElementById('monthly-v2024-month-select');
      if (monthSel && !monthSel.value) {
        const now = new Date();
        const lastMonth = now.getMonth() - 1;
        monthSel.value = lastMonth >= 0 ? lastMonth : 11;
      }
    }

    // Same semantics as setMonthlyUpstashDate.
    function setMonthlyV2024Date(preset) {
      const today = new Date();
      const monthSel = document.getElementById('monthly-v2024-month-select');
      const yearSel  = document.getElementById('monthly-v2024-year-select');
      const curMonth = parseInt(monthSel.value, 10);
      const curYear  = parseInt(yearSel.value, 10);

      if (preset === 'lastMonth') {
        const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        monthSel.value = d.getMonth();
        _setSelectByValue(yearSel, d.getFullYear());
      } else if (preset === 'thisMonth') {
        monthSel.value = today.getMonth();
        _setSelectByValue(yearSel, today.getFullYear());
      } else if (preset === 'prevMonth' && Number.isFinite(curMonth) && Number.isFinite(curYear)) {
        const d = new Date(curYear, curMonth - 1, 1);
        monthSel.value = d.getMonth();
        _setSelectByValue(yearSel, d.getFullYear());
      } else if (preset === 'nextMonth' && Number.isFinite(curMonth) && Number.isFinite(curYear)) {
        const d = new Date(curYear, curMonth + 1, 1);
        monthSel.value = d.getMonth();
        _setSelectByValue(yearSel, d.getFullYear());
      }

      _refreshV2024NavButtons();
      generateMonthlyV2024Report();
    }

    // Lazy-load the v2024 months-with-data index. Mirrors _ensureUpstashMonths
    // but hits get-months-v2024.
    async function _ensureV2024Months() {
      if (_v2024MonthsSet) return _v2024MonthsSet;
      if (_v2024MonthsPromise) return _v2024MonthsPromise;
      if (!accessToken) return null;
      _v2024MonthsPromise = (async () => {
        try {
          const res = await fetch('/api/transactions?action=get-months-v2024', {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (!res.ok) return null;
          const data = await res.json();
          _v2024MonthsSet = new Set(Array.isArray(data.months) ? data.months : []);
          return _v2024MonthsSet;
        } catch {
          return null;
        } finally {
          _v2024MonthsPromise = null;
        }
      })();
      return _v2024MonthsPromise;
    }

    function _v2024HasMonth(year, month) {
      if (!_v2024MonthsSet) return true; // unknown → don't block
      const ym = `${year}-${String(month + 1).padStart(2, '0')}`;
      return _v2024MonthsSet.has(ym);
    }

    function _v2024HasYear(year) {
      if (!_v2024MonthsSet) return true; // unknown → don't block
      const prefix = `${year}-`;
      for (const ym of _v2024MonthsSet) {
        if (ym.startsWith(prefix)) return true;
      }
      return false;
    }

    function _refreshV2024NavButtons() {
      // Monthly v2024 — Prev/Next disable when target month has no synced
      // data. Targets are "selected month ± 1," rolling year at Jan/Dec.
      const mSel = document.getElementById('monthly-v2024-month-select');
      const ySel = document.getElementById('monthly-v2024-year-select');
      const mPrev = document.getElementById('monthly-v2024-prev-btn');
      const mNext = document.getElementById('monthly-v2024-next-btn');
      if (mSel && ySel && mPrev && mNext) {
        const m = parseInt(mSel.value, 10);
        const y = parseInt(ySel.value, 10);
        if (Number.isFinite(m) && Number.isFinite(y)) {
          const prev = new Date(y, m - 1, 1);
          const next = new Date(y, m + 1, 1);
          mPrev.disabled = !_v2024HasMonth(prev.getFullYear(), prev.getMonth());
          mNext.disabled = !_v2024HasMonth(next.getFullYear(), next.getMonth());
        } else {
          mPrev.disabled = false;
          mNext.disabled = false;
        }
      }

      // YTD v2024 — Prev/Next enabled if any month of the target year has
      // data (a partial year is still worth viewing).
      const yySel = document.getElementById('ytd-v2024-year-select');
      const yPrev = document.getElementById('ytd-v2024-prev-btn');
      const yNext = document.getElementById('ytd-v2024-next-btn');
      if (yySel && yPrev && yNext) {
        const y = parseInt(yySel.value, 10);
        if (Number.isFinite(y)) {
          yPrev.disabled = !_v2024HasYear(y - 1);
          yNext.disabled = !_v2024HasYear(y + 1);
        } else {
          yPrev.disabled = false;
          yNext.disabled = false;
        }
      }
    }



    // Same "insert option if missing" helper as the Sheets-side version.
    // Prev/Next let the user scroll past the pre-seeded 5-year window
    // without the dropdown silently failing to update.
    function _setSelectByValue(select, v) {
      if (!select) return;
      const str = String(v);
      if ([...select.options].some(o => o.value === str)) {
        select.value = str;
        return;
      }
      const opt = document.createElement('option');
      opt.value = str;
      opt.textContent = str;
      let inserted = false;
      for (let i = 0; i < select.options.length; i++) {
        if (parseInt(select.options[i].value, 10) < v) {
          select.insertBefore(opt, select.options[i]);
          inserted = true;
          break;
        }
      }
      if (!inserted) select.appendChild(opt);
      select.value = str;
    }

    // ─── INPUT FETCHING ─────────────────────────────────────────────────
    //
    // Fetches the v2024-shape transactions from KV (via get-range-v2024)
    // alongside products / ad spend / shipping mappings — everything the
    // statement builder needs. Same shape as the v0 inputs bundle but the
    // transactions arrive as a flat list rather than paginated raw pages.
    async function _fetchV2024Inputs(startDate, endDate) {
      const authHeader = { Authorization: `Bearer ${accessToken}` };
      const startMonth = startDate.slice(0, 7);
      const endMonth   = endDate.slice(0, 7);

      const [txRes, prodRes, spAdRes, sbAdRes, prodMapRes, brandMapRes, feeMapRes, shipRes] = await Promise.all([
        fetch(`/api/transactions?action=get-range-v2024&startMonth=${startMonth}&endMonth=${endMonth}`, { headers: authHeader }),
        fetch('/api/products?action=get', { headers: authHeader }),
        fetch(`/api/adspend?action=get-range&type=sp&startMonth=${startMonth}&endMonth=${endMonth}`, { headers: authHeader }),
        fetch(`/api/adspend?action=get-range&type=sb&startMonth=${startMonth}&endMonth=${endMonth}`, { headers: authHeader }),
        fetch('/api/mappings?action=get&type=product', { headers: authHeader }),
        fetch('/api/mappings?action=get&type=brand',   { headers: authHeader }),
        fetch('/api/mappings?action=get&type=fee',     { headers: authHeader }),
        fetch(`/api/shipping?action=get-range&startMonth=${startMonth}&endMonth=${endMonth}`, { headers: authHeader })
      ]);
      if (!txRes.ok)   throw new Error(`v2024 transactions fetch failed (${txRes.status})`);
      if (!prodRes.ok) throw new Error(`Products fetch failed (${prodRes.status})`);

      const tx         = await txRes.json();
      const prod       = await prodRes.json();
      const spAd       = spAdRes.ok     ? await spAdRes.json()    : { rows: [] };
      const sbAd       = sbAdRes.ok     ? await sbAdRes.json()    : { rows: [] };
      const prodMap    = prodMapRes.ok  ? await prodMapRes.json() : { mappings: {} };
      const brandMap   = brandMapRes.ok ? await brandMapRes.json() : { mappings: {} };
      const feeMap     = feeMapRes.ok   ? await feeMapRes.json()  : { mappings: {} };
      const shipping   = shipRes.ok     ? await shipRes.json()    : { rows: [] };

      const products = {};
      const brandToSkus = {};
      for (const p of (prod.products || [])) {
        if (!p?.sku) continue;
        products[p.sku] = p;
        const brand = (p.brand || '').trim();
        if (brand) {
          if (!brandToSkus[brand]) brandToSkus[brand] = [];
          brandToSkus[brand].push(p.sku);
        }
      }

      const productCampaignToSkus = {};
      for (const [campaign, data] of Object.entries(prodMap.mappings || {})) {
        if (Array.isArray(data?.skus) && data.skus.length > 0) {
          productCampaignToSkus[campaign] = data.skus.slice();
        }
      }
      const brandCampaignToBrand = {};
      for (const [campaign, brand] of Object.entries(brandMap.mappings || {})) {
        if (brand) brandCampaignToBrand[campaign] = brand;
      }

      const monthsInRange = Array.isArray(tx.months) ? tx.months : [];
      const latestSyncedMonth = monthsInRange.length > 0
        ? monthsInRange[monthsInRange.length - 1]
        : null;
      let lastSynced = null;
      try {
        if (latestSyncedMonth) {
          const lsRes = await fetch(`/api/transactions?action=get-v2024&month=${latestSyncedMonth}`, { headers: authHeader });
          if (lsRes.ok) lastSynced = (await lsRes.json()).lastSynced || null;
        }
      } catch { /* non-fatal */ }

      return {
        transactions: tx.transactions || [],
        products,
        brandToSkus,
        spAdRows: spAd.rows || [],
        sbAdRows: sbAd.rows || [],
        shippingRows: shipping.rows || [],
        productCampaignToSkus,
        brandCampaignToBrand,
        feeMappings: feeMap.mappings || {},
        lastSynced,
        latestSyncedMonth,
        monthsInRange
      };
    }

    // v2024 analog of _computeUpstashPeriod. Same downstream pipeline
    // (statement build → metrics extract) — only the input fetch and the
    // derivation differ. Returns the same bundle shape so generate
    // functions / cache / renderer all work unchanged.
    async function _computeV2024Period(startDate, endDate) {
      const inputs = await _fetchV2024Inputs(startDate, endDate);
      const feeMappings = inputs.feeMappings || {};
      const { rows, unmappedBreakdowns, dedupSkipped, transferSkipped } =
        _deriveV2024Rows(inputs.transactions, startDate, endDate, feeMappings);

      const skuSales = _buildSkuSales(rows, inputs.products);
      const adSpend = _allocateAdSpend({
        spAdRows: inputs.spAdRows,
        sbAdRows: inputs.sbAdRows,
        products: inputs.products,
        brandToSkus: inputs.brandToSkus,
        productCampaignToSkus: inputs.productCampaignToSkus,
        brandCampaignToBrand: inputs.brandCampaignToBrand,
        skuSales,
        startDate,
        endDate
      });
      const shippingCosts = _sumShippingInRange(inputs.shippingRows, startDate, endDate);

      const { statement, missingSkus, unmappedFees } = _buildStatement(rows, inputs.products, adSpend, shippingCosts, feeMappings);
      const metrics = extractProfitabilityMetrics(statement);

      return {
        statement, missingSkus, unmappedFees, rows,
        lastSynced: inputs.lastSynced,
        latestSyncedMonth: inputs.latestSyncedMonth,
        adSpend, shippingCosts, metrics,
        // v2024-only diagnostics (rendered in the warning area below the
        // statement so a schema drift doesn't get swallowed silently)
        unmappedBreakdowns, dedupSkipped, transferSkipped
      };
    }

    async function generateMonthlyV2024Report() {
      const month = parseInt(document.getElementById('monthly-v2024-month-select').value, 10);
      const year  = parseInt(document.getElementById('monthly-v2024-year-select').value, 10);
      if (isNaN(month) || isNaN(year)) return;

      const container = document.getElementById('monthly-v2024-content');
      if (!container) return;
      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Please sign in</div>';
        return;
      }

      const cacheKey = `monthly-v2024|${year}|${month}`;
      const cached = window._overviewReportCache && window._overviewReportCache.get(cacheKey);
      if (cached) {
        container.innerHTML = cached;
        return;
      }

      _refreshV2024NavButtons();

      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading data...</div>';

      try {
        // Mirrors generateMonthlyUpstashReport: current + previous (MoM) +
        // YoY pulled in parallel, comparisons computed on the metrics, then
        // current period rendered with comparisons.
        const startDate = _ymd(new Date(year, month, 1));
        const endDate   = _ymd(new Date(year, month + 1, 0));
        const prevStart = _ymd(new Date(year, month - 1, 1));
        const prevEnd   = _ymd(new Date(year, month, 0));
        const yoyStart  = _ymd(new Date(year - 1, month, 1));
        const yoyEnd    = _ymd(new Date(year - 1, month + 1, 0));

        const [current, prev, yoy] = await Promise.all([
          _computeV2024Period(startDate, endDate),
          _computeV2024Period(prevStart, prevEnd),
          _computeV2024Period(yoyStart, yoyEnd)
        ]);

        const comparisons = calculateComparisons(current.metrics, prev.metrics, yoy.metrics);
        _renderV2024Statement(container, {
          statement: current.statement,
          missingSkus: current.missingSkus,
          unmappedFees: current.unmappedFees,
          unmappedBreakdowns: current.unmappedBreakdowns,
          dedupSkipped: current.dedupSkipped,
          transferSkipped: current.transferSkipped,
          rows: current.rows,
          lastSynced: current.lastSynced,
          latestSyncedMonth: current.latestSyncedMonth,
          startDate, endDate,
          adSpend: current.adSpend,
          shippingCosts: current.shippingCosts,
          comparisons
        });

        if (window._overviewReportCache) window._overviewReportCache.set(cacheKey, container.innerHTML);
      } catch (err) {
        console.error('v2024 monthly overview failed:', err);
        container.innerHTML = `<div style="padding: 2rem; color: var(--error);">Error: ${err.message}</div>`;
      }
    }

    // ─── YTD v2024 ──────────────────────────────────────────────────────
    function showYTDV2024() {
      _hideAllOverviewViews();
      document.getElementById('ytd-v2024-view').style.display = 'block';
      document.getElementById('ytd-v2024-tab').classList.add('active');
      _initYTDV2024Dropdown();
      if (!_ytdV2024AutoLoaded && accessToken) {
        _ytdV2024AutoLoaded = true;
        setYTDV2024Year('thisYear');
      }
      _ensureV2024Months().then(() => _refreshV2024NavButtons());
      _refreshV2024NavButtons();
    }

    function _initYTDV2024Dropdown() {
      const yearSel = document.getElementById('ytd-v2024-year-select');
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

    // Same semantics as setYTDUpstashYear: thisYear/lastYear are absolute
    // (relative to today), prevYear/nextYear are relative to the currently
    // selected dropdown value.
    function setYTDV2024Year(preset) {
      const today = new Date();
      const sel = document.getElementById('ytd-v2024-year-select');
      const cur = parseInt(sel.value, 10);

      if (preset === 'thisYear') {
        _setSelectByValue(sel, today.getFullYear());
      } else if (preset === 'lastYear') {
        _setSelectByValue(sel, today.getFullYear() - 1);
      } else if (preset === 'prevYear' && Number.isFinite(cur)) {
        _setSelectByValue(sel, cur - 1);
      } else if (preset === 'nextYear' && Number.isFinite(cur)) {
        _setSelectByValue(sel, cur + 1);
      }

      _refreshV2024NavButtons();
      generateYTDV2024Report();
    }

    async function generateYTDV2024Report() {
      const year = document.getElementById('ytd-v2024-year-select').value;
      if (!year) return;

      const container = document.getElementById('ytd-v2024-content');
      if (!container) return;
      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Please sign in</div>';
        return;
      }

      const cacheKey = `ytd-v2024|${year}`;
      const cached = window._overviewReportCache && window._overviewReportCache.get(cacheKey);
      if (cached) {
        container.innerHTML = cached;
        return;
      }

      _refreshV2024NavButtons();

      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading data...</div>';

      try {
        // Same date logic as generateYTDUpstashReport: current year runs
        // Jan 1 → end of last complete month; past years run Jan 1 → Dec 31.
        // Previous year matches the cutoff so YoY % comparisons are
        // apples-to-apples.
        const today = new Date();
        const selectedYear = parseInt(year, 10);
        const isCurrentYear = selectedYear === today.getFullYear();

        const startDate = `${year}-01-01`;
        let endDate;
        if (isCurrentYear) {
          const lastCompleteMonth = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
          const lastCompleteMonthYear = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();
          endDate = _ymd(new Date(lastCompleteMonthYear, lastCompleteMonth + 1, 0));
        } else {
          endDate = `${year}-12-31`;
        }

        const prevYear = selectedYear - 1;
        const prevStart = `${prevYear}-01-01`;
        let prevEnd;
        if (isCurrentYear) {
          const lastCompleteMonth = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
          const prevLastCompleteMonthYear = today.getMonth() === 0 ? prevYear - 1 : prevYear;
          prevEnd = _ymd(new Date(prevLastCompleteMonthYear, lastCompleteMonth + 1, 0));
        } else {
          prevEnd = `${prevYear}-12-31`;
        }

        const [current, prev] = await Promise.all([
          _computeV2024Period(startDate, endDate),
          _computeV2024Period(prevStart, prevEnd)
        ]);

        const comparisons = calculateYTDComparisons(current.metrics, prev.metrics);
        _renderV2024Statement(container, {
          statement: current.statement,
          missingSkus: current.missingSkus,
          unmappedFees: current.unmappedFees,
          unmappedBreakdowns: current.unmappedBreakdowns,
          dedupSkipped: current.dedupSkipped,
          transferSkipped: current.transferSkipped,
          rows: current.rows,
          lastSynced: current.lastSynced,
          latestSyncedMonth: current.latestSyncedMonth,
          startDate, endDate,
          adSpend: current.adSpend,
          shippingCosts: current.shippingCosts,
          comparisons
        });

        if (window._overviewReportCache) window._overviewReportCache.set(cacheKey, container.innerHTML);
      } catch (err) {
        console.error('v2024 YTD overview failed:', err);
        container.innerHTML = `<div style="padding: 2rem; color: var(--error);">Error: ${err.message}</div>`;
      }
    }

    // Same as _renderUpstashStatement but adds a v2024-specific diagnostic
    // strip showing dedup-skipped count, transfer-skipped count, and any
    // unmapped breakdownTypes (signals an Amazon schema change).
    function _renderV2024Statement(container, opts) {
      const { statement, missingSkus, unmappedFees, unmappedBreakdowns, dedupSkipped, transferSkipped, rows, lastSynced, latestSyncedMonth, startDate, endDate, comparisons } = opts;
      renderFinancialStatement(statement, startDate, endDate, container, comparisons || null);

      // Data status strip — always rendered, even if some fields are null,
      // so the user can tell at a glance what's loaded and how fresh it is.
      // "Data through" = the latest YYYY-MM in the queried range that has
      // synced transactions; "Last synced" = ISO timestamp of that month's
      // most recent sync. Both fall back to "—" if unknown.
      const dataThrough = latestSyncedMonth ? _formatYYYYMM(latestSyncedMonth) : '—';
      const lastSyncedDisplay = lastSynced ? _formatSyncTime(lastSynced) : '—';
      const statusStrip = `
        <div style="display: flex; flex-wrap: wrap; gap: 1.5rem; font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;">
          <span><strong style="color: var(--text-primary);">Data through:</strong> ${_escape(dataThrough)}</span>
          <span><strong style="color: var(--text-primary);">Last synced:</strong> ${_escape(lastSyncedDisplay)}</span>
          <span><strong style="color: var(--text-primary);">Derived rows:</strong> ${rows.length.toLocaleString()}</span>
          <span title="RELEASED transactions skipped because they're settlement-side duplicates of a DEFERRED_RELEASED record">Dedup-skipped: ${dedupSkipped}</span>
          <span title="Disbursement transfers (bank payouts) — not P&amp;L events">Transfers skipped: ${transferSkipped}</span>
        </div>
      `;
      const missingWarning = missingSkus.length > 0 ? _renderMissingSkuWarning(missingSkus) : '';
      const feeWarning     = unmappedFees && unmappedFees.length > 0 ? _renderUnmappedFeeWarning(unmappedFees) : '';
      const breakdownWarning = unmappedBreakdowns && Object.keys(unmappedBreakdowns).length > 0
        ? _renderUnmappedBreakdownWarning(unmappedBreakdowns)
        : '';
      container.innerHTML = statusStrip + missingWarning + feeWarning + breakdownWarning + container.innerHTML;
    }

    // YYYY-MM → "Mon YYYY" (e.g. "2025-08" → "Aug 2025"). Used in the data-
    // status strip so the user sees a friendly month label rather than the
    // numeric form.
    function _formatYYYYMM(yyyyMM) {
      if (!yyyyMM) return '—';
      const [y, m] = yyyyMM.split('-').map(Number);
      if (!Number.isFinite(y) || !Number.isFinite(m)) return yyyyMM;
      const d = new Date(Date.UTC(y, m - 1, 1));
      return d.toLocaleString(undefined, { month: 'short', year: 'numeric', timeZone: 'UTC' });
    }

    // ─── TRANSACTION DERIVE — v2024 ──────────────────────────────────────

    // Route an Adjustment row to the right Expense line. Checks the four
    // explicit sets first, then the "Other" special case, then falls back
    // to the "has SKU?" rule. Used by _buildStatement on Adjustment-type
    // rows emitted from _deriveV2024Rows.
    function _adjustmentLine(r) {
      if (ADJUSTMENT_INVENTORY_TYPES.has(r.adjustmentType))   return 'FBA Inventory Adjustment';
      if (ADJUSTMENT_RETURNS_FEE_TYPES.has(r.adjustmentType)) return 'FBA Returns Fees';
      if (r.adjustmentType === 'Other')                       return 'Other Expenses';
      return r.sku ? 'FBA Inventory Adjustment' : 'Other Expenses';
    }

    function _v2024RidValue(t, name) {
      const found = (t.relatedIdentifiers || []).find(r => r?.relatedIdentifierName === name);
      return found?.relatedIdentifierValue || '';
    }
    function _v2024HasDeferredAncestor(t) {
      return (t.relatedIdentifiers || []).some(r => r?.relatedIdentifierName === 'DEFERRED_TRANSACTION_ID');
    }
    function _v2024FindContext(item, contextType) {
      return (item?.contexts || []).find(c => c?.contextType === contextType) || null;
    }
    function _v2024NormalizeFulfillment(fn) {
      const s = String(fn || '').trim().toUpperCase();
      if (s === 'AFN') return 'FBA';
      if (s === 'MFN') return 'FBM';
      return '';
    }

    // Maps each breakdownType string Amazon emits in listTransactions to the
    // statement-line bucket it should land in. Built empirically from the
    // probe-v2024 month dump and validated against Sheets monthly totals.
    //
    // Handler kinds:
    //   item       — Order/Refund per-item bucket. Adds amount to one of
    //                {sale, otherCharges, fbaFees, transactionFees, promotions}
    //                on the Order/Refund row being built.
    //   serviceFee — emit a ServiceFee row with feeType = breakdownType,
    //                feeAmount = the leaf's currencyAmount. _buildStatement
    //                routes through SERVICE_FEE_LINE_MAP.
    //   adjustment — emit an Adjustment row with adjustmentType =
    //                breakdownType, adjustmentAmount = the leaf's amount.
    //                _buildStatement routes through _adjustmentLine.
    //   skip       — recognized but intentionally not added (taxes net to
    //                zero for the seller; aggregator nodes like 'Sales' /
    //                'Expenses' / 'AmazonFees' / 'Base' are handled by
    //                recursing through them when they have no handler).
    //
    // Anything not in this map AND not an aggregator we recurse through is
    // surfaced in unmappedBreakdowns so we don't silently lose money on a
    // future Amazon schema change.
    const V2024_LEAF_HANDLER = {
      // Item-level Order/Refund leaves
      'OurPricePrincipal':         { kind: 'item', bucket: 'sale' },
      'Shipping':                  { kind: 'item', bucket: 'otherCharges' },
      'ShippingPrincipal':         { kind: 'item', bucket: 'otherCharges' },
      'Promo':                     { kind: 'item', bucket: 'promotions' },
      'PromoRebates':              { kind: 'item', bucket: 'promotions' },
      'ShippingDiscount':          { kind: 'item', bucket: 'promotions' },
      'Commission':                { kind: 'item', bucket: 'transactionFees' },
      'VariableClosingFee':        { kind: 'item', bucket: 'transactionFees' },
      'FixedClosingFee':           { kind: 'item', bucket: 'transactionFees' },
      'RefundCommission':          { kind: 'item', bucket: 'transactionFees' },
      'FBAPerUnitFulfillmentFee':  { kind: 'item', bucket: 'fbaFees' },
      'FBAPerOrderFulfillmentFee': { kind: 'item', bucket: 'fbaFees' },
      'FBAWeightBasedFee':         { kind: 'item', bucket: 'fbaFees' },

      // ServiceFee leaves (names match SERVICE_FEE_LINE_MAP keys so emitted
      // rows route through the existing _buildStatement logic)
      'FBADisposalFee':              { kind: 'serviceFee' },
      'CustomerReturnHRRUnitFee':    { kind: 'serviceFee' },
      'HRRNonApparelRollup':         { kind: 'serviceFee' },
      'FBAStorageFee':               { kind: 'serviceFee' },
      'FBALongTermStorageFee':       { kind: 'serviceFee' },
      'LongTermStorageFee':          { kind: 'serviceFee' },
      'StorageBillingFee':           { kind: 'serviceFee' },
      'FBAInboundTransportationFee': { kind: 'serviceFee' },
      'InboundTransportationFee':    { kind: 'serviceFee' },

      // Adjustment / Reimbursement leaves — names match the adjustment maps
      // _adjustmentLine uses.
      'COMPENSATED_CLAWBACK':                   { kind: 'adjustment' },
      'FBAInventoryReimbursement':              { kind: 'adjustment' },
      'FBAReversedReimbursement':               { kind: 'adjustment' },
      'WAREHOUSE_LOST':                         { kind: 'adjustment' },
      'MISSING_FROM_INBOUND':                   { kind: 'adjustment' },
      'MISSING_FROM_INBOUND_CLAWBACK':          { kind: 'adjustment' },
      'PostageBilling_Postage':                 { kind: 'adjustment' },
      'PostageBilling_FuelSurcharge':           { kind: 'adjustment' },
      'PostageBilling_Other':                   { kind: 'adjustment' },
      'PostageBilling_PostageAdjustment':       { kind: 'adjustment' },
      'CarrierPackagingCharge':                 { kind: 'adjustment' },
      'CustomerPackagingCharge':                { kind: 'adjustment' },
      'ReturnPostageBilling_Tracking':          { kind: 'adjustment' },
      'ReturnPostageBilling_Postage':           { kind: 'adjustment' },
      'ReturnPostageBilling_TransactionFee':    { kind: 'adjustment' },
      'ReturnPostageBilling_FuelSurcharge':     { kind: 'adjustment' },
      'ReturnPostageBilling_OversizeSurcharge': { kind: 'adjustment' },
      'ReturnPostageBilling_DeliveryAreaSurcharge': { kind: 'adjustment' },
      'ShippingChargeback':                     { kind: 'adjustment' },
      'ShippingHB':                             { kind: 'adjustment' },
      'ShippingServiceChargebacks':             { kind: 'adjustment' },
      'RestockingDeductionPrincipal':           { kind: 'adjustment' },
      'ReturnShippingDeductionPrincipal':       { kind: 'adjustment' },

      // Tax types — net-zero for the seller, explicitly skipped (don't
      // recurse, don't track as unmapped).
      'OurPriceTax':                          { kind: 'skip' },
      'ShippingTax':                          { kind: 'skip' },
      'MarketplaceFacilitatorTax-Principal':  { kind: 'skip' },
      'MarketplaceFacilitatorTax-Shipping':   { kind: 'skip' },
      'MarketplaceFacilitatorTax-Other':      { kind: 'skip' },
      'MarketplaceFacilitatorVAT-Principal':  { kind: 'skip' },
      'MarketplaceFacilitatorVAT-Shipping':   { kind: 'skip' },
      'MarketplaceFacilitatorVAT-Other':      { kind: 'skip' },

      // Fallback — Amazon's catch-all "Other" bucket maps to Other Expenses
      // (via _adjustmentLine).
      'Other': { kind: 'adjustment' }
    };

    // Walk a breakdown tree, calling `handle` for each node whose
    // breakdownType is in V2024_LEAF_HANDLER OR in the user's feeMappings
    // override. User mappings take a leaf with no built-in handler and treat
    // it as kind='serviceFee' (so it emits a ServiceFee row that
    // _buildStatement routes to the user-chosen line) — or kind='skip' if
    // the user mapped to '_skip' (drop entirely). Recurses through
    // unrecognized aggregator nodes to reach handlers underneath. Tracks
    // truly-unmapped leaves (no built-in handler, no user mapping, no
    // children, non-zero amount) for the editable warning block.
    function _v2024WalkAndRoute(breakdowns, handle, unmapped, feeMappings) {
      for (const node of (breakdowns || [])) {
        const type = node?.breakdownType;
        let handler = type ? V2024_LEAF_HANDLER[type] : null;
        if (!handler && type && feeMappings && feeMappings[type]) {
          handler = feeMappings[type] === '_skip'
            ? { kind: 'skip' }
            : { kind: 'serviceFee' };
        }
        if (handler) {
          if (handler.kind !== 'skip') handle(type, node, handler);
          continue; // consume this node — don't descend further
        }
        // No handler. Recurse if there are children.
        if (Array.isArray(node?.breakdowns) && node.breakdowns.length > 0) {
          _v2024WalkAndRoute(node.breakdowns, handle, unmapped, feeMappings);
        } else if (type && unmapped) {
          const amt = node?.breakdownAmount?.currencyAmount || 0;
          if (Math.abs(amt) > 0.005) {
            unmapped[type] = (unmapped[type] || 0) + amt;
          }
        }
      }
    }

    // Empty-shaped row template so every emitted row has every field the
    // existing _buildStatement / CSV-export code expects.
    function _v2024BlankRow(extra) {
      return {
        type: '', orderId: '', date: '', sku: '', qty: 0,
        fulfillment: '',
        sale: 0, otherCharges: 0, fbaFees: 0, transactionFees: 0, promotions: 0,
        feeType: '', feeAmount: 0,
        adjustmentType: '', adjustmentAmount: 0,
        _src: 'v2024', _transactionId: '', _transactionStatus: '',
        ...(extra || {})
      };
    }

    function _deriveV2024Rows(transactions, startDate, endDate, feeMappings) {
      const rows = [];
      const unmappedBreakdowns = {}; // breakdownType → cumulative amount
      let dedupSkipped = 0;
      let transferSkipped = 0;

      for (const t of (transactions || [])) {
        // Dedup: a RELEASED transaction with a DEFERRED_TRANSACTION_ID is a
        // settlement-side duplicate of a DEFERRED_RELEASED record we'll
        // count separately. Skip it.
        if (t.transactionStatus === 'RELEASED' && _v2024HasDeferredAncestor(t)) {
          dedupSkipped++;
          continue;
        }

        // Transfers are bank disbursements — not P&L.
        if (t.transactionType === 'Transfer') {
          transferSkipped++;
          continue;
        }

        const date = (t.postedDate || '').substring(0, 10);
        if (date && (date < startDate || date > endDate)) continue;

        const orderId = _v2024RidValue(t, 'ORDER_ID');
        const tType = t.transactionType || '';
        const tStatus = t.transactionStatus || '';

        if (tType === 'Shipment' || tType === 'Refund') {
          const isRefund = tType === 'Refund';
          for (const item of (t.items || [])) {
            const ctx = _v2024FindContext(item, 'ProductContext');
            const sku = _normalizeSku(ctx?.sku);
            const qty = (parseInt(ctx?.quantityShipped, 10) || 0) * (isRefund ? -1 : +1);
            const fulfillment = _v2024NormalizeFulfillment(ctx?.fulfillmentNetwork);

            const baseRow = _v2024BlankRow({
              type: isRefund ? 'Refund' : 'Order',
              orderId, date, sku, qty, fulfillment,
              _transactionId: t.transactionId || '',
              _transactionStatus: tStatus
            });

            _v2024WalkAndRoute(item.breakdowns, (type, node, handler) => {
              const amt = node?.breakdownAmount?.currencyAmount || 0;
              if (handler.kind === 'item') {
                baseRow[handler.bucket] += amt;
              } else if (handler.kind === 'serviceFee') {
                rows.push(_v2024BlankRow({
                  type: 'ServiceFee',
                  orderId, date,
                  feeType: type, feeAmount: amt,
                  _transactionId: t.transactionId || '',
                  _transactionStatus: tStatus
                }));
              } else if (handler.kind === 'adjustment') {
                rows.push(_v2024BlankRow({
                  type: 'Adjustment',
                  orderId, date, sku, fulfillment,
                  adjustmentType: type, adjustmentAmount: amt,
                  _transactionId: t.transactionId || '',
                  _transactionStatus: tStatus
                }));
              }
            }, unmappedBreakdowns, feeMappings);

            rows.push(baseRow);
          }
        } else if (tType === 'ServiceFee') {
          // Per-item walk; if the transaction has no items (rare), fall
          // back to the top-level breakdowns so nothing is lost.
          const sources = (t.items && t.items.length > 0) ? t.items : [{ breakdowns: t.breakdowns || [] }];
          for (const item of sources) {
            _v2024WalkAndRoute(item.breakdowns, (type, node, handler) => {
              const amt = node?.breakdownAmount?.currencyAmount || 0;
              if (handler.kind === 'serviceFee' || handler.kind === 'item') {
                rows.push(_v2024BlankRow({
                  type: 'ServiceFee',
                  orderId, date,
                  feeType: type, feeAmount: amt,
                  _transactionId: t.transactionId || '',
                  _transactionStatus: tStatus
                }));
              } else if (handler.kind === 'adjustment') {
                rows.push(_v2024BlankRow({
                  type: 'Adjustment',
                  orderId, date,
                  adjustmentType: type, adjustmentAmount: amt,
                  _transactionId: t.transactionId || '',
                  _transactionStatus: tStatus
                }));
              }
            }, unmappedBreakdowns, feeMappings);
          }
        } else if (tType === 'Adjustment' || tType === 'FBAInventoryReimbursement') {
          // Item-level breakdowns when present, otherwise top-level. The
          // FBAInventoryReimbursement transactions in the Feb sample had
          // empty item.breakdowns and the actual data at the top level.
          const hasItemBreakdowns = (t.items || []).some(
            i => Array.isArray(i.breakdowns) && i.breakdowns.length > 0
          );
          const sources = hasItemBreakdowns
            ? t.items
            : [{ contexts: [], breakdowns: t.breakdowns || [] }];
          for (const item of sources) {
            const ctx = _v2024FindContext(item, 'ProductContext');
            const itemSku = _normalizeSku(ctx?.sku);
            const itemFulfillment = _v2024NormalizeFulfillment(ctx?.fulfillmentNetwork);
            _v2024WalkAndRoute(item.breakdowns, (type, node, handler) => {
              const amt = node?.breakdownAmount?.currencyAmount || 0;
              if (handler.kind === 'adjustment' || handler.kind === 'serviceFee') {
                rows.push(_v2024BlankRow({
                  type: 'Adjustment',
                  orderId, date,
                  sku: itemSku,
                  fulfillment: itemFulfillment,
                  adjustmentType: type, adjustmentAmount: amt,
                  _transactionId: t.transactionId || '',
                  _transactionStatus: tStatus
                }));
              }
            }, unmappedBreakdowns, feeMappings);
          }
        }
        // Unknown transactionType → silently skip (would surface in probe)
      }

      return { rows, unmappedBreakdowns, dedupSkipped, transferSkipped };
    }

    // ─── CONSOLE VALIDATION HELPER ──────────────────────────────────────
    // Paste `await compareV2024('2026-02')` (or any month) into the
    // browser DevTools console while signed in. Fetches v2024 raw from
    // KV, runs _deriveV2024Rows, builds a statement, and console.logs
    // total counts + per-line FBM/FBA totals so you can sanity-check
    // against the existing v0 Monthly Upstash report or the Sheets data.
    // No UI changes — pure validation utility until we wire a tab.
    async function compareV2024(month) {
      if (!accessToken) { console.error('Sign in first'); return; }
      if (!/^\d{4}-\d{2}$/.test(month)) {
        console.error('month must be YYYY-MM');
        return;
      }
      const [y, m] = month.split('-').map(Number);
      const startDate = `${month}-01`;
      const endDate = _ymd(new Date(y, m, 0));

      const res = await fetch(`/api/transactions?action=get-v2024&month=${month}`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      if (!res.ok) {
        console.error('get-v2024 failed', res.status, await res.text());
        return;
      }
      const data = await res.json();
      const transactions = data.transactions || [];
      console.log(`v2024 raw: ${transactions.length} transactions stored for ${month}`);

      const { rows, unmappedBreakdowns, dedupSkipped, transferSkipped } =
        _deriveV2024Rows(transactions, startDate, endDate);
      console.log(`v2024 derived: ${rows.length} rows · ${dedupSkipped} dedup-skipped · ${transferSkipped} transfers-skipped`);

      // Roll up totals without touching the catalog — purely from rows.
      const totals = {
        FBA: { sale: 0, returns: 0, other: 0, txFees: 0, fbaFees: 0, promotions: 0 },
        FBM: { sale: 0, returns: 0, other: 0, txFees: 0, fbaFees: 0, promotions: 0 },
        none: { sale: 0, returns: 0, other: 0, txFees: 0, fbaFees: 0, promotions: 0 },
        serviceFees: 0, adjustments: 0
      };
      for (const r of rows) {
        if (r.type === 'Order' || r.type === 'Refund') {
          const bucket = totals[r.fulfillment || 'none'];
          if (r.type === 'Order') bucket.sale    += r.sale;
          else                     bucket.returns += r.sale;
          bucket.other      += r.otherCharges;
          bucket.txFees     += r.transactionFees;
          bucket.fbaFees    += r.fbaFees;
          bucket.promotions += r.promotions;
        } else if (r.type === 'ServiceFee') {
          totals.serviceFees += r.feeAmount;
        } else if (r.type === 'Adjustment') {
          totals.adjustments += r.adjustmentAmount;
        }
      }
      console.table(totals);
      if (Object.keys(unmappedBreakdowns).length > 0) {
        console.warn('Unmapped breakdownTypes — may indicate schema drift:', unmappedBreakdowns);
      }
      return { rows, totals, unmappedBreakdowns, dedupSkipped, transferSkipped };
    }
    // Expose on window so it's callable from DevTools.
    window.compareV2024 = compareV2024;

    // ─── STATEMENT BUILDER ──────────────────────────────────────────────
    // Each derived row's columns flow into statement buckets based on
    // fulfillment (from the Products catalog). Positives → credit,
    // negatives → debit.

    const STATEMENT_INCOME_LINES = [
      'FBM Sales', 'FBM Returns', 'FBM Other',
      'FBA Sales', 'FBA Returns', 'FBA Other'
    ];
    const STATEMENT_EXPENSE_LINES = [
      'FBM Product Costs', 'FBM Transaction Fees', 'FBM Shipping Costs', 'FBM Ad Spend',
      'FBA Product Costs', 'FBA Transaction Fees', 'FBA Fees',
      'FBA Returns Fees',
      'FBA Inbound Placement Fees', 'FBA Inbound Shipping Costs',
      'FBA Inventory Storage Fees', 'FBA Inventory Adjustment', 'FBA Ad Spend',
      'Other Expenses', 'Unallocated Ad Spend'
    ];

    // ServiceFeeEvent FeeType → Expense line item.
    // Anything not in this map falls into "Other Expenses" so nothing is
    // silently lost; unmapped types surface in a warning block.
    const SERVICE_FEE_LINE_MAP = {
      FBADisposalFee:               'FBA Returns Fees',
      CustomerReturnHRRUnitFee:     'FBA Returns Fees',
      FBAInboundConvenienceFee:     'FBA Inbound Placement Fees',
      FBAInboundTransportationFee:  'FBA Inbound Shipping Costs',
      FBAStorageFee:                'FBA Inventory Storage Fees',
      FBALongTermStorageFee:        'FBA Inventory Storage Fees',
      Subscription:                 'Other Expenses'
    };

    // AdjustmentEvent AdjustmentType → Expense line item. Unlike service
    // fees, adjustments have a fallback that depends on whether the row
    // carries a SKU: SKU-bearing adjustments land in FBA Inventory
    // Adjustment, SKU-less ones in Other Expenses. See _adjustmentLine.
    const ADJUSTMENT_INVENTORY_TYPES = new Set([
      'WAREHOUSE_LOST',
      'COMPENSATED_CLAWBACK',
      'MISSING_FROM_INBOUND',
      'MISSING_FROM_INBOUND_CLAWBACK'
    ]);
    const ADJUSTMENT_RETURNS_FEE_TYPES = new Set([
      'PostageBilling_PostageAdjustment',
      'ReturnPostageBilling_Tracking',
      'ReturnPostageBilling_Postage',
      'ReturnPostageBilling_TransactionFee',
      'ReturnPostageBilling_FuelSurcharge',
      'ReturnPostageBilling_OversizeSurcharge',
      'ReturnPostageBilling_DeliveryAreaSurcharge'
    ]);

    // Decode HTML-entity-encoded ampersands that SP-API sometimes returns
    // in SellerSKU strings ("&amp;" → "&"). The Products catalog stores
    // the real character, so normalizing the incoming value at the edge
    // lets all downstream code do plain string lookups against the catalog.
    function _normalizeSku(sku) {
      return String(sku || '').replace(/&amp;/g, '&');
    }

    // Sum the `cost` field of shipping rows whose shipDate falls inside
    // [startDate, endDate]. Handles both API rows (sku-bearing, cost
    // already allocated per SKU) and Sheets-backfilled rows (sku-less,
    // cost is the shipment total) — both contribute to the period total.
    function _sumShippingInRange(shippingRows, startDate, endDate) {
      let total = 0;
      for (const r of (shippingRows || [])) {
        const d = r.shipDate || '';
        if (d && (d < startDate || d > endDate)) continue;
        total += Number(r.cost) || 0;
      }
      return total;
    }

    // Is this SKU's fulfillment field one of the "Amazon/FBA" spellings?
    // Seen in the wild: "Amazon", "AFN", "FBA", various casings/whitespace.
    function _isFbaProduct(product) {
      const f = String(product?.fulfillment || '').trim().toLowerCase();
      return f === 'amazon' || f === 'afn' || f === 'fba';
    }

    // Walk the derived Order rows and sum Principal revenue per SKU, split
    // by the channel each SKU is actually sold through. Used by the ad
    // allocator to proportionally split campaign-level spend across a
    // campaign's / brand's SKUs by actual sales contribution.
    function _buildSkuSales(rows, products) {
      const skuSales = {}; // { sku: { fba, fbm } }
      for (const r of rows) {
        if (r.type !== 'Order') continue;
        if (!r.sku) continue;
        const prod = products[r.sku];
        if (!prod) continue;
        if (!skuSales[r.sku]) skuSales[r.sku] = { fba: 0, fbm: 0 };
        const amount = r.sale || 0;
        if (amount <= 0) continue; // ignore zero/negative principal on orders
        if (_isFbaProduct(prod)) skuSales[r.sku].fba += amount;
        else                      skuSales[r.sku].fbm += amount;
      }
      return skuSales;
    }

    // Allocate Sponsored Products + Sponsored Brands spend to FBA / FBM /
    // Unallocated. Three paths:
    //   1. SP row with sku (API-sourced)  → direct lookup: product.fulfillment
    //   2. SP row without sku (historical) → campaign → SKUs via product
    //                                         mapping; split by sales ratio
    //                                         across that campaign's SKUs.
    //   3. SB row (always sku-less)       → campaign → brand via brand
    //                                         mapping; split by sales ratio
    //                                         across that brand's SKUs (from
    //                                         the Products catalog by brand).
    // In all cases, anything we can't attribute lands in Unallocated so no
    // spend disappears silently.
    function _allocateAdSpend({ spAdRows, sbAdRows, products, brandToSkus, productCampaignToSkus, brandCampaignToBrand, skuSales, startDate, endDate }) {
      let fba = 0, fbm = 0, unallocated = 0;
      const unallocatedProductCampaigns = {};
      const unallocatedBrandCampaigns = {};

      const bumpUnallocatedProduct = (campaign, amount) => {
        const key = campaign || '(blank)';
        unallocatedProductCampaigns[key] = (unallocatedProductCampaigns[key] || 0) + amount;
      };
      const bumpUnallocatedBrand = (campaign, amount) => {
        const key = campaign || '(blank)';
        unallocatedBrandCampaigns[key] = (unallocatedBrandCampaigns[key] || 0) + amount;
      };

      const splitBySales = (skus, spend) => {
        let totalFba = 0, totalFbm = 0;
        for (const sku of skus) {
          const s = skuSales[sku];
          if (!s) continue;
          totalFba += s.fba;
          totalFbm += s.fbm;
        }
        const total = totalFba + totalFbm;
        if (total === 0) return null; // caller sends to unallocated
        return { fba: spend * (totalFba / total), fbm: spend * (totalFbm / total) };
      };

      // ── Sponsored Products ───────────────────────────────────────────
      for (const row of (spAdRows || [])) {
        const d = row.date || '';
        if (d && (d < startDate || d > endDate)) continue;
        const spend = Number(row.cost) || 0;
        if (spend <= 0) continue;

        if (row.sku) {
          // Direct SKU attribution — no mapping needed.
          const sku = _normalizeSku(row.sku);
          const prod = products[sku];
          if (!prod) {
            unallocated += spend;
            bumpUnallocatedProduct(row.campaign, spend);
            continue;
          }
          if (_isFbaProduct(prod)) fba += spend;
          else                      fbm += spend;
          continue;
        }

        // Historical SP (no sku) — fall back to campaign → SKUs mapping.
        const mapped = productCampaignToSkus[row.campaign] || [];
        if (mapped.length === 0) {
          unallocated += spend;
          bumpUnallocatedProduct(row.campaign, spend);
          continue;
        }
        const split = splitBySales(mapped, spend);
        if (!split) {
          unallocated += spend;
          bumpUnallocatedProduct(row.campaign, spend);
        } else {
          fba += split.fba;
          fbm += split.fbm;
        }
      }

      // ── Sponsored Brands ─────────────────────────────────────────────
      for (const row of (sbAdRows || [])) {
        const d = row.date || '';
        if (d && (d < startDate || d > endDate)) continue;
        const spend = Number(row.cost) || 0;
        if (spend <= 0) continue;

        const brand = brandCampaignToBrand[row.campaign];
        if (!brand) {
          unallocated += spend;
          bumpUnallocatedBrand(row.campaign, spend);
          continue;
        }
        const brandSkus = brandToSkus[brand] || [];
        if (brandSkus.length === 0) {
          unallocated += spend;
          bumpUnallocatedBrand(row.campaign, spend);
          continue;
        }
        const split = splitBySales(brandSkus, spend);
        if (!split) {
          unallocated += spend;
          bumpUnallocatedBrand(row.campaign, spend);
        } else {
          fba += split.fba;
          fbm += split.fbm;
        }
      }

      return { fba, fbm, unallocated, unallocatedProductCampaigns, unallocatedBrandCampaigns };
    }

    function _buildStatement(rows, products, adSpend = null, shippingCosts = 0, feeMappings = {}) {
      const statement = {
        income: Object.fromEntries(STATEMENT_INCOME_LINES.map(k => [k, { debit: 0, credit: 0 }])),
        expenses: Object.fromEntries(STATEMENT_EXPENSE_LINES.map(k => [k, { debit: 0, credit: 0 }]))
      };

      // Ad spend is computed outside this function (it needs both the ad
      // data and the sku-sales derived here-ish). If provided, drop it
      // straight onto the debit side of the three Ad Spend lines; ad spend
      // is always money out, so signs are simple.
      if (adSpend) {
        if (adSpend.fba > 0)          statement.expenses['FBA Ad Spend'].debit += adSpend.fba;
        if (adSpend.fbm > 0)          statement.expenses['FBM Ad Spend'].debit += adSpend.fbm;
        if (adSpend.unallocated > 0)  statement.expenses['Unallocated Ad Spend'].debit += adSpend.unallocated;
      }

      // Shipping costs are always FBM — seller-fulfilled shipments have
      // costs we paid out-of-pocket. FBA shipping is wrapped into Amazon's
      // FBA Fees on the SP-API side and doesn't flow through here.
      if (shippingCosts > 0) {
        statement.expenses['FBM Shipping Costs'].debit += shippingCosts;
      }

      const missing = new Map(); // sku → Set of orderIds using it

      const add = (line, section, amount) => {
        if (amount > 0) statement[section][line].credit += amount;
        else if (amount < 0) statement[section][line].debit += Math.abs(amount);
      };

      const unmappedServiceFeeTypes = new Map(); // feeType → running total

      for (const r of rows) {
        // ServiceFee rows route by FeeType → statement line. User mappings
        // (from /api/mappings?type=fee) win over the hardcoded
        // SERVICE_FEE_LINE_MAP so the user can fix categorization in-app
        // without a code change. '_skip' drops the amount entirely (used
        // for fees the user explicitly wants excluded).
        if (r.type === 'ServiceFee') {
          const userLine = feeMappings && feeMappings[r.feeType];
          if (userLine === '_skip') continue;
          const line = userLine || SERVICE_FEE_LINE_MAP[r.feeType];
          if (!line) {
            // Unknown FeeType and no user mapping: bucket into Other
            // Expenses so the money isn't lost, but keep a running tally
            // for the editable warning block.
            add('Other Expenses', 'expenses', r.feeAmount);
            unmappedServiceFeeTypes.set(
              r.feeType || '(empty)',
              (unmappedServiceFeeTypes.get(r.feeType || '(empty)') || 0) + r.feeAmount
            );
          } else {
            // User-mapped destinations can be income or expense lines —
            // pick the right section so add() doesn't undefined-crash.
            const section = STATEMENT_INCOME_LINES.includes(line) ? 'income' : 'expenses';
            add(line, section, r.feeAmount);
          }
          continue;
        }

        // Adjustment rows route by AdjustmentType via _adjustmentLine,
        // with a "has SKU?" fallback for types not in the explicit maps.
        // No Products-catalog lookup needed.
        if (r.type === 'Adjustment') {
          add(_adjustmentLine(r), 'expenses', r.adjustmentAmount);
          continue;
        }

        // Chargeback / GuaranteeClaim / Retrocharge rows dump their entire
        // net amount into Other Expenses. Per-item detail is preserved in
        // the CSV but collapses here since these event types are rare
        // enough not to warrant a dedicated statement line.
        if (r.type === 'Chargeback' || r.type === 'GuaranteeClaim' || r.type === 'Retrocharge') {
          const net = (r.sale || 0) + (r.otherCharges || 0) +
                      (r.fbaFees || 0) + (r.transactionFees || 0) +
                      (r.promotions || 0);
          add('Other Expenses', 'expenses', net);
          continue;
        }

        const prod = products[r.sku];

        // v2024 rows arrive with `fulfillment` already set from the API's
        // ProductContext (AFN→FBA, MFN→FBM). Trust that hint when present;
        // it's authoritative per-transaction and avoids the catalog-shift
        // bug where a SKU's current fulfillment differs from its at-order
        // fulfillment. Fall back to catalog lookup for v0 rows.
        let prefix;
        if (r.fulfillment === 'FBA' || r.fulfillment === 'FBM') {
          prefix = r.fulfillment;
          // Still flag missing-from-catalog so product cost (below) can
          // surface the gap. Don't `continue` — the API knows fulfillment.
          if (!prod) {
            if (!missing.has(r.sku)) missing.set(r.sku, new Set());
            missing.get(r.sku).add(r.orderId);
          }
        } else {
          if (!prod) {
            if (!missing.has(r.sku)) missing.set(r.sku, new Set());
            missing.get(r.sku).add(r.orderId);
            continue; // Can't categorize without knowing fulfillment.
          }
          // Accept common spellings of the fulfillment value rather than
          // relying on one exact string. Seen in the wild: "Amazon", "AFN",
          // "FBA", sometimes lower/title-cased, sometimes with whitespace.
          const f = String(prod.fulfillment || '').trim().toLowerCase();
          const isFba = f === 'amazon' || f === 'afn' || f === 'fba';
          prefix = isFba ? 'FBA' : 'FBM';
        }

        // Sale routing depends on event type: Orders go to Sales,
        // Refunds go to Returns. Everything else routes the same way
        // regardless of type — positives credit, negatives debit.
        const saleLine = r.type === 'Refund' ? 'Returns' : 'Sales';
        add(`${prefix} ${saleLine}`, 'income', r.sale);
        add(`${prefix} Other`, 'income', r.otherCharges);
        add(`${prefix} Other`, 'income', r.promotions);
        add(`${prefix} Transaction Fees`, 'expenses', r.transactionFees);
        add('FBA Fees', 'expenses', r.fbaFees);

        // Product cost = quantity × unit cost. Positive qty on a shipment
        // is a sold unit — debit to the channel's Product Costs line. If
        // the SKU isn't in the catalog (v2024 path may pass through with a
        // fulfillment hint but no catalog match), skip product cost.
        if (prod) {
          const unitCost = parseFloat(prod.cost) || 0;
          if (unitCost > 0 && r.qty !== 0) {
            const cost = unitCost * r.qty;
            if (cost > 0) statement.expenses[`${prefix} Product Costs`].debit += cost;
            else if (cost < 0) statement.expenses[`${prefix} Product Costs`].credit += Math.abs(cost);
          }
        }
      }

      const missingSkus = [...missing.entries()].map(([sku, orders]) => ({
        sku,
        orderCount: orders.size,
        sampleOrderIds: [...orders].slice(0, 3)
      }));
      const unmappedFees = [...unmappedServiceFeeTypes.entries()]
        .map(([feeType, total]) => ({ feeType, total }))
        .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
      return { statement, missingSkus, unmappedFees };
    }

    // ─── RENDER ─────────────────────────────────────────────────────────


    // ServiceFee FeeTypes we don't have a rule for get bucketed into
    // "Other Expenses" and listed here as an editable warning. Each row
    // has a destination dropdown + Save button — clicking Save POSTs the
    // mapping to /api/mappings?type=fee, clears the cache, and re-runs
    // the report. Mapped fees disappear from the warning on next render.
    function _renderUnmappedFeeWarning(unmapped) {
      return _renderEditableFeeWarning(unmapped, {
        title: 'unmapped ServiceFee FeeType',
        intro: "These FeeTypes aren't recognized yet. Their amounts are bucketed into Other Expenses so nothing's lost. Pick a destination below and click Save — the mapping is stored, applied across all months, and re-applied on every report load.",
        keyHeader: 'FeeType'
      });
    }

    // Same UI as _renderUnmappedFeeWarning but for breakdown-tree leaves
    // that have no V2024_LEAF_HANDLER entry. Listed here so the user can
    // route them in-app instead of needing a code change.
    function _renderUnmappedBreakdownWarning(unmapped) {
      const entries = Object.entries(unmapped)
        .map(([feeType, total]) => ({ feeType, total }))
        .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
      return _renderEditableFeeWarning(entries, {
        title: 'unmapped breakdownType',
        intro: "These appeared in the listTransactions response but aren't in V2024_LEAF_HANDLER. Their amounts are NOT making it into the statement until you route them. Pick a destination below and click Save — the mapping persists across months.",
        keyHeader: 'breakdownType'
      });
    }

    // Shared editable warning renderer. Each row has a destination
    // <select> populated with all income + expense lines plus a "Skip
    // (net-zero)" option, and a Save button that calls saveFeeMapping.
    function _renderEditableFeeWarning(entries, { title, intro, keyHeader }) {
      const fmt = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      // Build dropdown <option> markup once and reuse per row. Income
      // lines come first since most fee categories that need rerouting
      // are expense-side, but income destinations exist (e.g. the
      // user might want to route a credit-style breakdown to FBM Other).
      const incomeOpts = STATEMENT_INCOME_LINES
        .map(line => `<option value="${_escape(line)}">${_escape(line)}</option>`).join('');
      const expenseOpts = STATEMENT_EXPENSE_LINES
        .map(line => `<option value="${_escape(line)}">${_escape(line)}</option>`).join('');
      const optionsMarkup = `
        <option value="">— pick a destination —</option>
        <optgroup label="Income lines">${incomeOpts}</optgroup>
        <optgroup label="Expense lines">${expenseOpts}</optgroup>
        <option value="_skip">Skip (don't include in statement)</option>
      `;

      const rows = entries.map(u => {
        const ft = _escape(u.feeType || '(empty)');
        const ftAttr = (u.feeType || '').replace(/"/g, '&quot;');
        return `
          <tr>
            <td style="padding: 0.5rem 0.75rem; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${ft}</td>
            <td style="padding: 0.5rem 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${fmt(u.total)}</td>
            <td style="padding: 0.5rem 0.75rem;">
              <select class="fee-mapping-select" data-fee-type="${ftAttr}" style="padding: 0.35rem 0.5rem; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-card); color: var(--text-primary); font-size: 0.85rem; min-width: 220px;">
                ${optionsMarkup}
              </select>
            </td>
            <td style="padding: 0.5rem 0.75rem;">
              <button class="btn btn-secondary" onclick="saveFeeMapping(this)" data-fee-type="${ftAttr}" style="padding: 0.35rem 0.75rem; font-size: 0.8rem;">Save</button>
            </td>
          </tr>
        `;
      }).join('');

      return `
        <div style="background: var(--bg-secondary); border: 1px solid var(--warning); border-radius: 6px; padding: 1rem; margin-bottom: 1.5rem;">
          <div style="font-weight: 600; color: var(--warning); margin-bottom: 0.5rem;">
            ⚠ ${entries.length} ${title}${entries.length === 1 ? '' : 's'} — needs routing
          </div>
          <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.75rem;">
            ${intro}
          </div>
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr>
                <th style="text-align: left;  padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">${keyHeader}</th>
                <th style="text-align: right; padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">Amount</th>
                <th style="text-align: left;  padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">Map to</th>
                <th style="background: var(--bg-primary);"></th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    // POST a single fee mapping, then clear the per-session report cache
    // (so the new mapping is applied) and re-run whichever Overview tab
    // is currently active. Called from the Save button on the editable
    // warning rows; reads the dropdown that lives in the same row.
    async function saveFeeMapping(button) {
      const feeType = button?.dataset?.feeType;
      if (!feeType) return;
      const select = button.closest('tr')?.querySelector('select.fee-mapping-select');
      if (!select) return;
      const line = select.value;
      if (!line) return; // user hit Save before picking a destination
      if (!accessToken) return;

      const original = button.textContent;
      button.disabled = true;
      button.textContent = 'Saving…';
      try {
        const res = await fetch('/api/mappings?action=save-one&type=fee', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${accessToken}`
          },
          body: JSON.stringify({ feeType, line })
        });
        if (!res.ok) throw new Error(`Save failed (${res.status})`);
        // The mapping is global, so a stale cached statement for any
        // month wouldn't reflect it. Wipe the whole Overview cache and
        // re-render whichever tab the user is on.
        if (window._overviewReportCache) window._overviewReportCache.clear();
        const activeTabId = document.querySelector('#overview-page .page-header .tabs .tab.active')?.id;
        if (activeTabId === 'ytd-v2024-tab') generateYTDV2024Report();
        else                                  generateMonthlyV2024Report();
      } catch (err) {
        console.error('Fee mapping save failed:', err);
        button.disabled = false;
        button.textContent = original;
      }
    }
    // Expose so inline onclick="saveFeeMapping(this)" can resolve it.
    window.saveFeeMapping = saveFeeMapping;

    // Manual refresh — clears every level of in-memory cache so the next
    // render fetches fresh transactions, products, mappings, ad spend, and
    // shipping. Use after editing the Products catalog, after running a
    // sync, or any time you want to force-bust the per-session report
    // cache. Resets _v2024MonthsSet too so the Prev/Next nav-button
    // gating picks up newly-synced months.
    async function refreshV2024Report() {
      if (window._overviewReportCache) window._overviewReportCache.clear();
      _v2024MonthsSet = null;
      _v2024MonthsPromise = null;
      await _ensureV2024Months();
      _refreshV2024NavButtons();
      const activeTabId = document.querySelector('#overview-page .page-header .tabs .tab.active')?.id;
      if (activeTabId === 'ytd-v2024-tab') generateYTDV2024Report();
      else                                  generateMonthlyV2024Report();
    }
    window.refreshV2024Report = refreshV2024Report;

    function _renderMissingSkuWarning(missing) {
      const rows = missing.map(m => `
        <tr>
          <td style="padding: 0.5rem 0.75rem; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${_escape(m.sku || '(empty)')}</td>
          <td style="padding: 0.5rem 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${m.orderCount}</td>
          <td style="padding: 0.5rem 0.75rem; font-family: 'Roboto Mono', monospace; font-size: 0.8rem; color: var(--text-secondary);">${m.sampleOrderIds.map(_escape).join(', ')}${m.orderCount > m.sampleOrderIds.length ? ', …' : ''}</td>
        </tr>
      `).join('');
      return `
        <div style="background: var(--bg-secondary); border: 1px solid var(--warning); border-radius: 6px; padding: 1rem; margin-bottom: 1.5rem;">
          <div style="font-weight: 600; color: var(--warning); margin-bottom: 0.5rem;">
            ⚠ ${missing.length} SKU${missing.length === 1 ? '' : 's'} not found in the Product Catalog
          </div>
          <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.75rem;">
            These rows were skipped — add them to the catalog (with a fulfillment and cost) and reload to include them in the statement.
          </div>
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr>
                <th style="text-align: left; padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">SKU</th>
                <th style="text-align: right; padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">Order Count</th>
                <th style="text-align: left; padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">Sample Order IDs</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    // ─── SMALL UTILITIES ────────────────────────────────────────────────

    function _ymd(d) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function _formatSyncTime(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function _escape(s) {
      if (s == null) return '';
      return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }
