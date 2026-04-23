    // Profitability Overview — Upstash-backed variant.
    //
    // Delegates to the shared loadOverviewData in js/brand-product.js with
    // inputs pre-fetched from our KV-backed APIs instead of Google Sheets.
    // Every downstream step (parsing, categorization, rendering) runs
    // through the exact same code path as the Sheets-backed tab, so any
    // delta between the two tabs reflects a data-source difference, not a
    // logic difference.
    //
    // What comes from where:
    //   transactions → /api/transactions (already Sheets-shape)
    //   products     → /api/products      (converted to Sheets-shape)
    //   mappings     → /api/mappings      (converted to Sheets-shape)
    //   ad spend     → Google Sheets      (not migrated yet)
    //   shipping     → Google Sheets      (not migrated yet)

    // ─── VIEW SWITCHING ─────────────────────────────────────────────────

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
    // Mirror the Sheets-backed generateMonthlyReport / generateYTDReport
    // flow step for step — same three-period load, same comparisons helper,
    // same second pass to render with comparisons attached. Only difference:
    // we call loadOverviewDataFromUpstash instead of loadOverviewData.

    async function generateMonthlyUpstashReport() {
      const month = parseInt(document.getElementById('monthly-upstash-month-select').value, 10);
      const year  = parseInt(document.getElementById('monthly-upstash-year-select').value, 10);
      if (isNaN(month) || isNaN(year)) return;

      const container = document.getElementById('monthly-upstash-content');
      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading data...</div>';

      try {
        const currentStart = new Date(year, month, 1);
        const currentEnd   = new Date(year, month + 1, 0);
        const currentStartStr = currentStart.toISOString().split('T')[0];
        const currentEndStr   = currentEnd.toISOString().split('T')[0];

        const prevMonth = month === 0 ? 11 : month - 1;
        const prevYear  = month === 0 ? year - 1 : year;
        const prevStart = new Date(prevYear, prevMonth, 1);
        const prevEnd   = new Date(prevYear, prevMonth + 1, 0);
        const prevStartStr = prevStart.toISOString().split('T')[0];
        const prevEndStr   = prevEnd.toISOString().split('T')[0];

        const yoyYear  = year - 1;
        const yoyStart = new Date(yoyYear, month, 1);
        const yoyEnd   = new Date(yoyYear, month + 1, 0);
        const yoyStartStr = yoyStart.toISOString().split('T')[0];
        const yoyEndStr   = yoyEnd.toISOString().split('T')[0];

        const [currentData, prevData, yoyData] = await Promise.all([
          loadOverviewDataFromUpstash(currentStartStr, currentEndStr, 'monthly-upstash-content', true),
          loadOverviewDataFromUpstash(prevStartStr,   prevEndStr,    'monthly-upstash-content', true),
          loadOverviewDataFromUpstash(yoyStartStr,    yoyEndStr,     'monthly-upstash-content', true)
        ]);

        const comparisons = calculateComparisons(currentData, prevData, yoyData);
        await loadOverviewDataFromUpstash(currentStartStr, currentEndStr, 'monthly-upstash-content', false, comparisons);
      } catch (error) {
        console.error('Error generating Monthly Upstash report:', error);
        container.innerHTML = `<div style="padding: 4rem; text-align: center; color: var(--error);">Error: ${error.message}</div>`;
      }
    }

    async function generateYTDUpstashReport() {
      const year = document.getElementById('ytd-upstash-year-select').value;
      if (!year) return;

      const container = document.getElementById('ytd-upstash-content');
      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading data...</div>';

      try {
        const today = new Date();
        const selectedYear = parseInt(year, 10);
        const isCurrentYear = selectedYear === today.getFullYear();

        const startDate = `${year}-01-01`;
        let endDate;
        if (isCurrentYear) {
          const lastCompleteMonth = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
          const lastCompleteMonthYear = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();
          endDate = new Date(lastCompleteMonthYear, lastCompleteMonth + 1, 0).toISOString().split('T')[0];
        } else {
          endDate = `${year}-12-31`;
        }

        const prevYear = selectedYear - 1;
        const prevStartDate = `${prevYear}-01-01`;
        let prevEndDate;
        if (isCurrentYear) {
          const lastCompleteMonth = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
          const prevLastCompleteMonthYear = today.getMonth() === 0 ? prevYear - 1 : prevYear;
          prevEndDate = new Date(prevLastCompleteMonthYear, lastCompleteMonth + 1, 0).toISOString().split('T')[0];
        } else {
          prevEndDate = `${prevYear}-12-31`;
        }

        const [currentData, prevData] = await Promise.all([
          loadOverviewDataFromUpstash(startDate, endDate, 'ytd-upstash-content', true),
          loadOverviewDataFromUpstash(prevStartDate, prevEndDate, 'ytd-upstash-content', true)
        ]);

        const comparisons = calculateYTDComparisons(currentData, prevData);
        await loadOverviewDataFromUpstash(startDate, endDate, 'ytd-upstash-content', false, comparisons);
      } catch (error) {
        console.error('Error generating YTD Upstash report:', error);
        container.innerHTML = `<div style="padding: 4rem; text-align: center; color: var(--error);">Error: ${error.message}</div>`;
      }
    }

    // ─── DELEGATE TO THE SHARED RENDERER ─────────────────────────────────
    // Thin wrapper around the Sheets-backed loadOverviewData. Pre-fetches
    // inputs from our KV APIs (plus Sheets for the not-yet-migrated
    // pieces), packages them in the same bundle shape Sheets would return,
    // and hands them to loadOverviewData via its providedInputs param.

    async function loadOverviewDataFromUpstash(startDate, endDate, containerId, returnData = false, comparisons = null) {
      if (!accessToken) {
        alert('Please sign in first');
        return;
      }

      try {
        const inputs = await _fetchOverviewInputsFromUpstash(startDate, endDate);
        return await loadOverviewData(startDate, endDate, containerId, returnData, comparisons, inputs);
      } catch (err) {
        console.error('Upstash overview fetch failed:', err);
        if (returnData) return ZERO_METRICS;
        const container = document.getElementById(containerId);
        if (container) {
          container.innerHTML = `<div style="padding: 4rem; text-align: center; color: var(--error);">Error: ${err.message}</div>`;
        }
      }
    }

    // ─── INPUT BUNDLE ────────────────────────────────────────────────────
    // Produces the same { transactionsData, productsData, productAdsData,
    // brandAdsData, shippingData, productMappingData, brandMappingData }
    // shape that _fetchOverviewInputsFromSheets returns, but sourced from
    // /api/* endpoints wherever migration has happened. Ad spend and
    // shipping still pull from Sheets until those migrations ship.

    async function _fetchOverviewInputsFromUpstash(startDate, endDate) {
      const authHeader = { Authorization: `Bearer ${accessToken}` };
      const startMonth = startDate.slice(0, 7);
      const endMonth   = endDate.slice(0, 7);

      const sheet = (name) => fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${name}`,
        { headers: authHeader }
      );

      const [
        txRes, prodRes, prodMapRes, brandMapRes,
        productAdsRes, brandAdsRes, shippingRes
      ] = await Promise.all([
        fetch(`/api/transactions?action=get-range&startMonth=${startMonth}&endMonth=${endMonth}`, { headers: authHeader }),
        fetch('/api/products?action=get', { headers: authHeader }),
        fetch('/api/mappings?action=get&type=product', { headers: authHeader }),
        fetch('/api/mappings?action=get&type=brand', { headers: authHeader }),
        sheet('ProductAdSpend'),
        sheet('BrandAdSpend'),
        sheet('ShippingCosts')
      ]);

      if (!txRes.ok)   throw new Error('Failed to load Transactions from Upstash');
      if (!prodRes.ok) throw new Error('Failed to load Products from Upstash');

      const txJson       = await txRes.json();
      const prodJson     = await prodRes.json();
      const prodMapJson  = prodMapRes.ok  ? await prodMapRes.json()  : { mappings: {} };
      const brandMapJson = brandMapRes.ok ? await brandMapRes.json() : { mappings: {} };
      const productAdsData = productAdsRes.ok ? await productAdsRes.json() : { values: [] };
      const brandAdsData   = brandAdsRes.ok   ? await brandAdsRes.json()   : { values: [] };
      const shippingData   = shippingRes.ok   ? await shippingRes.json()   : { values: [] };

      return {
        // Transactions come from /api/transactions already in { values: [...] }
        // shape — same as the Sheets API response.
        transactionsData: { values: txJson.values || [] },
        productsData:     _productsToSheetsShape(prodJson.products || []),
        productAdsData,
        brandAdsData,
        shippingData,
        productMappingData: _productMappingsToSheetsShape(prodMapJson.mappings || {}),
        brandMappingData:   _brandMappingsToSheetsShape(brandMapJson.mappings || {})
      };
    }

    // ─── KV → SHEETS-SHAPE CONVERTERS ────────────────────────────────────
    // Each takes a KV-backed dict/array and returns { values: [header, ...rows] }
    // that matches the layout the Sheets-backed parser in brand-product.js
    // expects. Keeps the downstream code path identical for both sources.

    function _productsToSheetsShape(products) {
      // parseProducts/loadOverviewData look up 'sku', 'cost', 'brand'
      // via case-insensitive findHeaderIndex — lowercase headers work.
      const headers = ['sku', 'name', 'brand', 'fulfillment', 'cost', 'asin', 'type', 'status'];
      const rows = products.map(p => headers.map(h => (p?.[h] ?? '')));
      return { values: [headers, ...rows] };
    }

    function _productMappingsToSheetsShape(mappings) {
      // ProductAdMapping tab has one row per (campaign, sku). A campaign
      // with a brand but no SKUs gets a single row with empty SKU so the
      // campaign → brand relation isn't lost.
      const headers = ['Campaign Name', 'Brand', 'SKU'];
      const rows = [];
      for (const [campaign, data] of Object.entries(mappings)) {
        const brand = data?.brand || '';
        const skus  = Array.isArray(data?.skus) ? data.skus : [];
        if (skus.length === 0) {
          rows.push([campaign, brand, '']);
        } else {
          for (const sku of skus) rows.push([campaign, brand, sku]);
        }
      }
      return { values: [headers, ...rows] };
    }

    function _brandMappingsToSheetsShape(mappings) {
      const headers = ['Campaign Name', 'Brand'];
      const rows = Object.entries(mappings).map(([campaign, brand]) => [campaign, brand]);
      return { values: [headers, ...rows] };
    }

    // ─── CSV EXPORT ──────────────────────────────────────────────────────
    // Dumps whatever the /api/transactions endpoint returns for the
    // currently-selected period as a CSV file — same columns as the
    // Sheets Transactions tab. Lets you eyeball what SP-API produced and
    // diff against the Sheets version to guide mapping corrections.

    async function exportMonthlyUpstashCSV() {
      const month = parseInt(document.getElementById('monthly-upstash-month-select').value, 10);
      const year  = parseInt(document.getElementById('monthly-upstash-year-select').value, 10);
      if (isNaN(month) || isNaN(year)) return;
      const yyyyMM = `${year}-${String(month + 1).padStart(2, '0')}`;
      await _downloadTransactionsCSV(`/api/transactions?action=get&month=${yyyyMM}`, `transactions-${yyyyMM}.csv`);
    }

    async function exportYTDUpstashCSV() {
      const year = document.getElementById('ytd-upstash-year-select').value;
      if (!year) return;
      const url = `/api/transactions?action=get-range&startMonth=${year}-01&endMonth=${year}-12`;
      await _downloadTransactionsCSV(url, `transactions-${year}-YTD.csv`);
    }

    async function _downloadTransactionsCSV(url, filename) {
      if (!accessToken) { alert('Please sign in first'); return; }
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
        if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
        const data = await res.json();
        const values = data.values || [];
        if (values.length <= 1) {
          alert('No transactions to export — has this period been synced?');
          return;
        }
        const csv = values.map(row => row.map(_csvCell).join(',')).join('\r\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
        const href = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = href;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(href);
      } catch (err) {
        console.error('CSV export failed:', err);
        alert(`Export failed: ${err.message}`);
      }
    }

    function _csvCell(v) {
      const s = v == null ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    }
