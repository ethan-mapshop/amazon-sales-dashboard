    // SALES & VOLUME PAGE
    let svAllProducts = [];
    let svOrdersData = [];
    let svSalesChart = null;
    let svVolumeChart = null;
    
    async function loadSalesVolumeData() {
      if (!accessToken) return;

      // Show the spinner from the moment the page is opened — covers
      // the entire orders + products fetch + render pipeline so the
      // user sees activity instead of an empty page during the
      // initial load. Loader/body inverse-toggle, same pattern as
      // Session & CVR.
      const svLoader = document.getElementById('sv-monthly-loader');
      const svBody   = document.getElementById('sv-monthly-body');
      if (svLoader) svLoader.style.display = 'block';
      if (svBody)   svBody.style.display = 'none';

      try {
        // Try summary cache first (fast single KV read for Monthly Overview)
        // Always load full orders too so PCI tab has individual records
        const [summaryRes, ordersRes] = await Promise.all([
          fetch('/api/orders?action=get-summary', { headers: { 'Authorization': `Bearer ${accessToken}` } }),
          fetch('/api/orders?action=get',         { headers: { 'Authorization': `Bearer ${accessToken}` } })
        ]);

        if (ordersRes.ok) {
          const data = await ordersRes.json();
          svOrdersData = data.orders || [];
          updateSVDataBlurb(svOrdersData);
        }

        // Store summary separately for Monthly Overview rendering
        if (summaryRes.ok) {
          const summaryData = await summaryRes.json();
          window._svMonthlySummary = summaryData.summary || null;
        }
        
        // Load products from the Upstash catalog. Sales & Volume needs
        // sellable units, so the Child/Non-Variable filter (parents
        // are display rollups whose own ASINs don't actually sell on
        // Amazon) is preserved exactly as before — only the data
        // source changed.
        const productsResponse = await fetch('/api/products?action=get', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!productsResponse.ok) {
          console.error('Failed to load products from Upstash:', productsResponse.status);
          return;
        }
        const productsPayload = await productsResponse.json();
        const products = Array.isArray(productsPayload.products) ? productsPayload.products : [];

        svAllProducts = products
          .filter(p => {
            const asin = (p.asin || '').toString().trim();
            const productType = (p.type || '').toString().trim();
            return asin
                && asin.toUpperCase() !== 'N/A'
                && (productType === 'Child' || productType === 'Non-Variable');
          })
          .map(p => ({
            sku: p.sku,
            name: p.name || p.sku,
            brand: p.brand || 'Unknown',
            asin: p.asin,
            productType: p.type || ''
          }));

        // Populate brand dropdown
        const brands = [...new Set(svAllProducts.map(p => p.brand))].sort();
        const brandSelect = document.getElementById('sv-brand-filter');
        brandSelect.innerHTML = '<option value="">All Brands</option>';
        brands.forEach(brand => {
          brandSelect.innerHTML += `<option value="${brand}">${brand}</option>`;
        });

        // Populate products (the body is still hidden but the DOM
        // elements exist, so getElementById works fine).
        filterSVProducts();

        // Reveal the body before rendering — Chart.js needs the
        // canvases laid out (non-zero dimensions) when it instantiates
        // them, otherwise it latches onto 0×0 forever (same bug we
        // hit on Session & CVR).
        if (svLoader) svLoader.style.display = 'none';
        if (svBody)   svBody.style.display = 'block';
        await new Promise(r => requestAnimationFrame(r));

        // Render data
        renderSalesVolumeData();

        // Populate export brand list now that svAllProducts is loaded
        populatePCIExportBrands();

        // Pre-load PCI data in background so it's ready when tab is clicked
        initPCI();

      } catch (error) {
        console.error('Error loading sales & volume data:', error);
        // Reveal the body even on failure so the user isn't stuck on
        // the spinner — the page may have stale content or empty
        // dropdowns, but that's a clearer state than a stuck loader.
        if (svLoader) svLoader.style.display = 'none';
        if (svBody)   svBody.style.display = 'block';
      }
    }
    
    function filterSVProducts() {
      const selectedBrand = document.getElementById('sv-brand-filter').value;
      const productSelect = document.getElementById('sv-product-filter');
      
      let filteredProducts = selectedBrand 
        ? svAllProducts.filter(p => p.brand === selectedBrand)
        : svAllProducts;
      
      filteredProducts.sort((a, b) => a.name.localeCompare(b.name));
      
      productSelect.innerHTML = '<option value="">All Products</option>';
      filteredProducts.forEach(product => {
        productSelect.innerHTML += `<option value="${product.sku}">${product.name}</option>`;
      });
      
      renderSalesVolumeData();
    }
    
    function renderSalesVolumeData() {
      const selectedSKU         = document.getElementById('sv-product-filter').value;
      const selectedBrand       = document.getElementById('sv-brand-filter').value;
      const selectedYear        = document.getElementById('sv-year-filter').value;
      const selectedMonth       = document.getElementById('sv-month-filter').value; // 'YYYY-MM' or ''
      const selectedFulfillment = document.getElementById('sv-fulfillment-filter').value; // 'AFN','MFN', or ''

      // Build SKU set for brand filtering (when brand selected but no specific product)
      const brandSKUs = selectedBrand && !selectedSKU
        ? new Set(svAllProducts.filter(p => p.brand === selectedBrand).map(p => p.sku))
        : null;

      // For YTD/MTD cards we need individual order records (date-level filtering)
      let orders = svOrdersData;
      if (selectedSKU)         orders = orders.filter(o => o.sku === selectedSKU);
      else if (brandSKUs)      orders = orders.filter(o => brandSKUs.has(o.sku));
      if (selectedFulfillment) orders = orders.filter(o => o.fulfillmentChannel === selectedFulfillment);

      // For monthly chart/list, use the pre-aggregated summary cache if available
      // (much faster — one KV read vs scanning thousands of records per month)
      // Summary records: { yearMonth, sku, revenue, units }
      // We normalize them to look like order records for the monthly aggregation below
      const summaryCache = window._svMonthlySummary;
      let monthlySource; // what we use for the rolling 13-month chart/list
      // Summary cache doesn't store fulfillmentChannel, so bypass it when that filter is active
      if (summaryCache && summaryCache.length > 0 && !selectedFulfillment) {
        // Filter summary by SKU or brand
        let filtered = summaryCache;
        if (selectedSKU) {
          filtered = filtered.filter(s => s.sku === selectedSKU);
        } else if (brandSKUs) {
          filtered = filtered.filter(s => brandSKUs.has(s.sku));
        }
        // Convert to a shape the monthly aggregation can use
        monthlySource = filtered.map(s => ({
          orderDate: s.yearMonth + '-01', // approximate — only month matters
          _yearMonth: s.yearMonth,
          sku: s.sku,
          itemTotal: s.revenue,
          quantity: s.units,
          _fromSummary: true
        }));
      } else {
        // Use the already-filtered orders array (includes fulfillment filter if set)
        monthlySource = orders;
      }

      // Determine the anchor: the last day of the selected month, or yesterday
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      let anchor; // always 1st of the "current" month for the rolling window
      let anchorLastDay; // last day of that month (for YTD/MTD end dates)

      if (selectedMonth) {
        // e.g. '2026-01' => anchor = Jan 1 2026, anchorLastDay = Jan 31 2026
        const [y, m] = selectedMonth.split('-').map(Number);
        anchor = new Date(y, m - 1, 1);
        anchorLastDay = new Date(y, m, 0); // day 0 of next month = last day of this month
      } else if (selectedYear) {
        // Year selected: use Dec 31 of that year (or yesterday if current year)
        const y = parseInt(selectedYear);
        const today = new Date();
        if (y === today.getFullYear()) {
          const yesterday = new Date(today);
          yesterday.setDate(yesterday.getDate() - 1);
          anchor = new Date(yesterday.getFullYear(), yesterday.getMonth(), 1);
          anchorLastDay = yesterday;
        } else {
          anchor = new Date(y, 11, 1); // Dec
          anchorLastDay = new Date(y, 11, 31);
        }
      } else {
        // Default: yesterday
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);
        anchor = new Date(yesterday.getFullYear(), yesterday.getMonth(), 1);
        anchorLastDay = yesterday;
      }

      const anchorYear = anchor.getFullYear();
      const anchorMonth = anchor.getMonth(); // 0-indexed
      const previousYear = anchorYear - 1;

      // Format a date as YYYY-MM-DD
      const fmt = d => d.toISOString().split('T')[0];

      // YTD: Jan 1 → anchorLastDay, both years
      const ytdPrevStart = `${previousYear}-01-01`;
      const ytdPrevEnd = `${previousYear}-${String(anchorLastDay.getMonth() + 1).padStart(2, '0')}-${String(anchorLastDay.getDate()).padStart(2, '0')}`;
      const ytdCurrStart = `${anchorYear}-01-01`;
      const ytdCurrEnd = fmt(anchorLastDay);

      // MTD: 1st of anchor month → anchorLastDay, both years
      const mtdMonthStr = String(anchorMonth + 1).padStart(2, '0');
      const mtdPrevStart = `${previousYear}-${mtdMonthStr}-01`;
      const mtdPrevEnd = ytdPrevEnd;
      const mtdCurrStart = `${anchorYear}-${mtdMonthStr}-01`;
      const mtdCurrEnd = ytdCurrEnd;

      // Calculate YTD
      const ytdPrevOrders = orders.filter(o => o.orderDate >= ytdPrevStart && o.orderDate <= ytdPrevEnd);
      const ytdCurrOrders = orders.filter(o => o.orderDate >= ytdCurrStart && o.orderDate <= ytdCurrEnd);

      const ytdPrevSales = ytdPrevOrders.reduce((sum, o) => sum + (o.itemTotal || 0), 0);
      const ytdCurrSales = ytdCurrOrders.reduce((sum, o) => sum + (o.itemTotal || 0), 0);
      const ytdPrevVolume = ytdPrevOrders.reduce((sum, o) => sum + (o.quantity || 0), 0);
      const ytdCurrVolume = ytdCurrOrders.reduce((sum, o) => sum + (o.quantity || 0), 0);

      const ytdSalesChange = ytdPrevSales > 0 ? ((ytdCurrSales - ytdPrevSales) / ytdPrevSales) * 100 : 0;
      const ytdVolumeChange = ytdPrevVolume > 0 ? ((ytdCurrVolume - ytdPrevVolume) / ytdPrevVolume) * 100 : 0;

      // Calculate MTD
      const mtdPrevOrders = orders.filter(o => o.orderDate >= mtdPrevStart && o.orderDate <= mtdPrevEnd);
      const mtdCurrOrders = orders.filter(o => o.orderDate >= mtdCurrStart && o.orderDate <= mtdCurrEnd);

      const mtdPrevSales = mtdPrevOrders.reduce((sum, o) => sum + (o.itemTotal || 0), 0);
      const mtdCurrSales = mtdCurrOrders.reduce((sum, o) => sum + (o.itemTotal || 0), 0);
      const mtdPrevVolume = mtdPrevOrders.reduce((sum, o) => sum + (o.quantity || 0), 0);
      const mtdCurrVolume = mtdCurrOrders.reduce((sum, o) => sum + (o.quantity || 0), 0);

      const mtdSalesChange = mtdPrevSales > 0 ? ((mtdCurrSales - mtdPrevSales) / mtdPrevSales) * 100 : 0;
      const mtdVolumeChange = mtdPrevVolume > 0 ? ((mtdCurrVolume - mtdPrevVolume) / mtdPrevVolume) * 100 : 0;

      // Update YTD cards
      document.getElementById('ytd-sales-prev-label').textContent = `${previousYear}`;
      document.getElementById('ytd-sales-curr-label').textContent = `${anchorYear}`;
      document.getElementById('ytd-sales-prev').textContent = '$' + ytdPrevSales.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      document.getElementById('ytd-sales-curr').textContent = '$' + ytdCurrSales.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      document.getElementById('ytd-sales-change').textContent = (ytdSalesChange >= 0 ? '+' : '') + ytdSalesChange.toFixed(1) + '%';
      document.getElementById('ytd-sales-change').style.color = ytdSalesChange >= 0 ? 'var(--success)' : 'var(--error)';

      document.getElementById('ytd-volume-prev').textContent = ytdPrevVolume.toLocaleString();
      document.getElementById('ytd-volume-curr').textContent = ytdCurrVolume.toLocaleString();
      document.getElementById('ytd-volume-change').textContent = (ytdVolumeChange >= 0 ? '+' : '') + ytdVolumeChange.toFixed(1) + '%';
      document.getElementById('ytd-volume-change').style.color = ytdVolumeChange >= 0 ? 'var(--success)' : 'var(--error)';

      // Update MTD cards
      const anchorMonthName = monthNames[anchorMonth];
      document.getElementById('mtd-sales-prev-label').textContent = `${anchorMonthName} ${previousYear.toString().slice(2)}`;
      document.getElementById('mtd-sales-curr-label').textContent = `${anchorMonthName} ${anchorYear.toString().slice(2)}`;
      document.getElementById('mtd-sales-prev').textContent = '$' + mtdPrevSales.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      document.getElementById('mtd-sales-curr').textContent = '$' + mtdCurrSales.toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
      document.getElementById('mtd-sales-change').textContent = (mtdSalesChange >= 0 ? '+' : '') + mtdSalesChange.toFixed(1) + '%';
      document.getElementById('mtd-sales-change').style.color = mtdSalesChange >= 0 ? 'var(--success)' : 'var(--error)';

      // mtd-volume-*-label IDs are no longer rendered in the table — the
      // label cells are shared with the sales row. Guard the updates so the
      // function stays safe if these elements are ever restored.
      const mtdVolPrev = document.getElementById('mtd-volume-prev-label');
      const mtdVolCurr = document.getElementById('mtd-volume-curr-label');
      if (mtdVolPrev) mtdVolPrev.textContent = `${anchorMonthName} ${previousYear.toString().slice(2)}`;
      if (mtdVolCurr) mtdVolCurr.textContent = `${anchorMonthName} ${anchorYear.toString().slice(2)}`;
      document.getElementById('mtd-volume-prev').textContent = mtdPrevVolume.toLocaleString();
      document.getElementById('mtd-volume-curr').textContent = mtdCurrVolume.toLocaleString();
      document.getElementById('mtd-volume-change').textContent = (mtdVolumeChange >= 0 ? '+' : '') + mtdVolumeChange.toFixed(1) + '%';
      document.getElementById('mtd-volume-change').style.color = mtdVolumeChange >= 0 ? 'var(--success)' : 'var(--error)';

      // Generate rolling 13 months ending at anchor month
      const months = [];
      for (let i = 12; i >= 0; i--) {
        const d = new Date(anchorYear, anchorMonth - i, 1);
        months.push({
          year: d.getFullYear(),
          month: d.getMonth() + 1,
          label: `${monthNames[d.getMonth()]} ${d.getFullYear().toString().slice(2)}`
        });
      }

      // Calculate monthly data — use summary cache if available, else full orders
      const monthlyData = months.map(m => {
        const ym = `${m.year}-${String(m.month).padStart(2, '0')}`;
        let sales, volume;
        if (monthlySource[0]?._fromSummary) {
          // Summary records already aggregated per SKU-month — just sum them
          const recs = monthlySource.filter(s => s._yearMonth === ym);
          sales  = recs.reduce((sum, s) => sum + s.itemTotal, 0);
          volume = recs.reduce((sum, s) => sum + s.quantity,  0);
        } else {
          const monthOrders = monthlySource.filter(o => {
            const orderMonth = parseInt(o.orderDate.split('-')[1]);
            const orderYear  = parseInt(o.orderDate.split('-')[0]);
            return orderYear === m.year && orderMonth === m.month;
          });
          sales  = monthOrders.reduce((sum, o) => sum + (o.itemTotal || 0), 0);
          volume = monthOrders.reduce((sum, o) => sum + (o.quantity  || 0), 0);
        }
        return { ...m, sales, volume };
      });

      // Render monthly breakdown as table rows (styled like Profitability Overview tables)
      const monthlyList = document.getElementById('monthly-list');
      monthlyList.innerHTML = monthlyData.map(m => `
        <tr>
          <td style="padding: 0.75rem; border-bottom: 1px solid var(--border); font-weight: 500;">${m.label}</td>
          <td style="padding: 0.75rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">$${m.sales.toLocaleString(undefined, {minimumFractionDigits: 0, maximumFractionDigits: 0})}</td>
          <td style="padding: 0.75rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace; color: var(--text-secondary);">${m.volume.toLocaleString()}</td>
        </tr>
      `).join('');

      // Render charts
      if (svSalesChart) svSalesChart.destroy();
      if (svVolumeChart) svVolumeChart.destroy();

      const salesCtx = document.getElementById('sales-chart-sv').getContext('2d');
      svSalesChart = new Chart(salesCtx, {
        type: 'line',
        data: {
          labels: monthlyData.map(m => m.label),
          datasets: [{
            label: 'Sales ($)',
            data: monthlyData.map(m => m.sales),
            borderColor: 'rgb(34, 197, 94)',
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            tension: 0.4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: { legend: { display: false } },
          scales: {
            y: {
              beginAtZero: true,
              ticks: { callback: value => '$' + value.toLocaleString() }
            }
          }
        }
      });

      const volumeCtx = document.getElementById('volume-chart-sv').getContext('2d');
      svVolumeChart = new Chart(volumeCtx, {
        type: 'line',
        data: {
          labels: monthlyData.map(m => m.label),
          datasets: [{
            label: 'Volume (Units)',
            data: monthlyData.map(m => m.volume),
            borderColor: 'rgb(59, 130, 246)',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            tension: 0.4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: { legend: { display: false } },
          scales: {
            y: {
              beginAtZero: true,
              ticks: { callback: value => value.toLocaleString() }
            }
          }
        }
      });
    }


    function shortenBrandName(brandName) {
      const brandMap = {
        'South of Kings': 'SOK',
        'BrightWay Educational': 'BrightWay',
        'Hubbard Scientific': 'Hubbard',
        'MapShop State Maps': 'State Maps',
        'Kappa': 'Kappa',
        'Other': 'Other'
      };
      return brandMap[brandName] || brandName;
    }

    // ── SALES & VOLUME SUBTABS ────────────────────────────────────────────────

    function showSVTab(tab) {
      document.querySelectorAll('.sv-subtab').forEach(el => el.style.display = 'none');
      document.querySelectorAll('#salesvolume-page .tab').forEach(btn => btn.classList.remove('active'));
      document.getElementById('sv-' + tab).style.display = 'block';
      document.getElementById('sv-tab-' + tab).classList.add('active');

      if (tab === 'priceimpact' && svAllProducts.length > 0) {
        initPCI();
      }
    }

    // ── PRICE CHANGE IMPACTS ──────────────────────────────────────────────────

    // PCI charts stored on window (pciRollingRevChart, pciRollingUnitsChart, pciCumRevChart, pciCumUnitsChart)
    let pciPriceChanges = []; // entries from /api/pricechanges
    let pciSkuMap = {};       // sku -> { brand, productName }
    let pciAllProducts = [];  // full Upstash product list for the Log
                              // form's brand/product dropdowns

    async function initPCI() {
      if (!accessToken) return;

      try {
        // Both endpoints are Upstash-backed. PriceChanges replaces the
        // legacy Sheets read; Products is the same catalog the rest
        // of the dashboard uses. Always re-fetch on init so an entry
        // added since last load shows up immediately.
        const [pcRes, productsRes] = await Promise.all([
          fetch('/api/pricechanges?action=get', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
          }),
          fetch('/api/products?action=get', {
            headers: { 'Authorization': `Bearer ${accessToken}` }
          })
        ]);

        if (!pcRes.ok) {
          document.getElementById('pci-table-content').innerHTML =
            '<div style="padding:4rem;text-align:center;color:var(--error);">Failed to load price changes.</div>';
          return;
        }

        const pcData = await pcRes.json();
        // Server returns entries already sorted newest-first with the
        // same fields the rest of the PCI code expects: date, sku,
        // oldPrice, newPrice (plus id for the delete buttons).
        pciPriceChanges = Array.isArray(pcData.entries) ? pcData.entries : [];

        const productsPayload = productsRes.ok ? await productsRes.json() : { products: [] };
        const products = Array.isArray(productsPayload.products) ? productsPayload.products : [];
        pciAllProducts = products;
        pciSkuMap = {};
        for (const p of products) {
          if (!p?.sku) continue;
          pciSkuMap[p.sku] = { brand: p.brand || 'Unknown', productName: p.name || p.sku };
        }

        // Populate the Log Price Change form's brand/product dropdowns.
        _populatePriceChangeForm();

        renderPCIFilters();
        loadPCITable();

      } catch (err) {
        console.error('PCI init error:', err);
        document.getElementById('pci-table-content').innerHTML =
          `<div style="padding:4rem;text-align:center;color:var(--error);">Error: ${err.message}</div>`;
      }
    }

    // ── LOG PRICE CHANGE FORM ─────────────────────────────────────────────────

    function _populatePriceChangeForm() {
      const brandSel = document.getElementById('pricechange-brand');
      if (!brandSel) return;
      // Brand dropdown: every distinct brand in the catalog. Default
      // option is "All Brands" (no brand filter on the product list).
      const brands = [...new Set(pciAllProducts.map(p => (p.brand || '').trim()).filter(Boolean))].sort();
      brandSel.innerHTML = '<option value="">All Brands</option>' +
        brands.map(b => `<option value="${_pcEsc(b)}">${_pcEsc(b)}</option>`).join('');
      // Trigger product list rebuild (also sets the date picker default).
      filterPriceChangeProducts();

      const dateInput = document.getElementById('pricechange-date');
      if (dateInput && !dateInput.value) {
        dateInput.valueAsDate = new Date();
      }
    }

    function filterPriceChangeProducts() {
      const brandSel = document.getElementById('pricechange-brand');
      const productSel = document.getElementById('pricechange-product');
      if (!brandSel || !productSel) return;
      const brand = brandSel.value;

      // Each option is a single SKU (price-change entries are stored
      // per-SKU). Display label is "Product Name (SKU)" so a user can
      // distinguish FBA vs FBM versions of the same product. Filter by
      // brand if one is selected.
      const filtered = pciAllProducts
        .filter(p => p?.sku && (!brand || (p.brand || '') === brand))
        .filter(p => {
          const asin = (p.asin || '').toString().trim();
          return asin && asin.toUpperCase() !== 'N/A';
        })
        .sort((a, b) => (a.name || a.sku).localeCompare(b.name || b.sku));

      productSel.innerHTML = '<option value="">Select Product...</option>' +
        filtered.map(p => {
          const label = `${p.name || p.sku} (${p.sku})`;
          return `<option value="${_pcEsc(p.sku)}">${_pcEsc(label)}</option>`;
        }).join('');
    }
    window.filterPriceChangeProducts = filterPriceChangeProducts;

    async function savePriceChange() {
      const feedback = document.getElementById('pricechange-save-feedback');
      const showError = (msg) => _pcShowFeedback(feedback, 'error', msg);
      const showSuccess = (msg) => _pcShowFeedback(feedback, 'success', msg);

      if (!accessToken) { showError('⚠ Please sign in to save changes'); return; }

      const sku       = document.getElementById('pricechange-product').value;
      const date      = document.getElementById('pricechange-date').value;
      const oldPrice  = parseFloat(document.getElementById('pricechange-old-price').value);
      const newPrice  = parseFloat(document.getElementById('pricechange-new-price').value);

      if (!sku)                     { showError('⚠ Please select a product'); return; }
      if (!date)                    { showError('⚠ Please select a date');    return; }
      if (!Number.isFinite(oldPrice)) { showError('⚠ Old Price is required'); return; }
      if (!Number.isFinite(newPrice)) { showError('⚠ New Price is required'); return; }

      try {
        const res = await fetch('/api/pricechanges?action=add', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ date, sku, oldPrice, newPrice })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showError('⚠ Failed to save: ' + (err.error || res.status));
          return;
        }
        showSuccess('✓ Price change saved');
        setTimeout(() => { feedback.style.display = 'none'; }, 4000);

        // Clear the form (keep brand/product so the user can quickly
        // log a follow-up for the same SKU). Reset prices + date.
        document.getElementById('pricechange-old-price').value = '';
        document.getElementById('pricechange-new-price').value = '';
        document.getElementById('pricechange-date').valueAsDate = new Date();

        // Reload the data + re-render the table.
        pciPriceChanges = [];
        await initPCI();
      } catch (err) {
        console.error('Save price change failed:', err);
        showError('⚠ Save failed: ' + err.message);
      }
    }
    window.savePriceChange = savePriceChange;

    async function deletePriceChange(id, btn) {
      if (!id || !accessToken) return;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '…';
      }
      try {
        const res = await fetch('/api/pricechanges?action=delete', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ id })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Reload + re-render.
        pciPriceChanges = [];
        await initPCI();
      } catch (err) {
        console.error('Delete price change failed:', err);
        if (btn) {
          btn.disabled = false;
          btn.textContent = '×';
        }
      }
    }
    window.deletePriceChange = deletePriceChange;

    // One-time backfill from the legacy PriceChanges Sheet tab. Same
    // pattern as the Listing Change Log's import button — overwrites
    // Upstash with whatever's in the Sheet.
    async function migratePriceChangesFromSheets() {
      const feedback = document.getElementById('pricechange-save-feedback');
      if (!accessToken) { _pcShowFeedback(feedback, 'error', '⚠ Please sign in first'); return; }
      if (typeof SPREADSHEET_ID === 'undefined' || !SPREADSHEET_ID) {
        _pcShowFeedback(feedback, 'error', '⚠ SPREADSHEET_ID is not set');
        return;
      }

      _pcShowFeedback(feedback, 'success', '⏳ Importing from Google Sheet…');
      try {
        const res = await fetch('/api/pricechanges?action=migrate-from-sheets', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ spreadsheetId: SPREADSHEET_ID })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          _pcShowFeedback(feedback, 'error', '⚠ Import failed: ' + (err.error || res.status));
          return;
        }
        const data = await res.json();
        _pcShowFeedback(feedback, 'success',
          `✓ Imported ${data.imported} price changes${data.skipped > 0 ? ` (${data.skipped} skipped)` : ''}.`);
        setTimeout(() => { feedback.style.display = 'none'; }, 6000);

        pciPriceChanges = [];
        await initPCI();
      } catch (err) {
        console.error('Migrate price changes failed:', err);
        _pcShowFeedback(feedback, 'error', '⚠ Import failed: ' + err.message);
      }
    }
    window.migratePriceChangesFromSheets = migratePriceChangesFromSheets;

    // ── BULK UPLOAD MODAL ────────────────────────────────────────────────────
    // Mirrors the Listing Change Log bulk-upload flow: drop-zone +
    // CSV parser + preview + post to /api/pricechanges?action=bulk-add.

    let _pcBulkRows = null;

    function openPriceChangeBulkUpload() {
      const modal = document.getElementById('pc-bulk-upload-modal');
      if (!modal) return;
      modal.style.display = 'flex';
      _pcBulkRows = null;
      document.getElementById('pc-bulk-upload-filename').textContent = 'No file selected';
      document.getElementById('pc-bulk-upload-preview').innerHTML = '';
      const fb = document.getElementById('pc-bulk-upload-feedback');
      if (fb) fb.style.display = 'none';
      const file = document.getElementById('pc-bulk-upload-file');
      if (file) file.value = '';
    }
    window.openPriceChangeBulkUpload = openPriceChangeBulkUpload;

    function closePriceChangeBulkUpload() {
      const modal = document.getElementById('pc-bulk-upload-modal');
      if (modal) modal.style.display = 'none';
    }
    window.closePriceChangeBulkUpload = closePriceChangeBulkUpload;

    // Wire up drop-zone + file picker once the page loads. The modal
    // exists in the DOM from the start (display: none); the listeners
    // attach once and don't need to be re-bound when the modal opens.
    document.addEventListener('DOMContentLoaded', () => {
      const dropzone = document.getElementById('pc-bulk-upload-dropzone');
      const fileInput = document.getElementById('pc-bulk-upload-file');
      if (!dropzone || !fileInput) return;

      dropzone.addEventListener('click', () => fileInput.click());
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = 'var(--accent-orange)';
        dropzone.style.background = 'rgba(255,255,255,0.02)';
      });
      dropzone.addEventListener('dragleave', () => {
        dropzone.style.borderColor = 'var(--border)';
        dropzone.style.background = '';
      });
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.style.borderColor = 'var(--border)';
        dropzone.style.background = '';
        if (e.dataTransfer.files.length > 0) _pcHandleBulkFile(e.dataTransfer.files[0]);
      });
      fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) _pcHandleBulkFile(e.target.files[0]);
      });
    });

    function _pcHandleBulkFile(file) {
      document.getElementById('pc-bulk-upload-filename').textContent = file.name;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const text = e.target.result;
          const rows = _pcParseCsv(text);
          if (rows.length < 2) {
            _pcShowFeedback(document.getElementById('pc-bulk-upload-feedback'),
              'error', '⚠ CSV is empty or has only a header row');
            return;
          }
          const header = rows[0].map(c => c.trim().toLowerCase());
          const dateIdx     = header.findIndex(h => h === 'date');
          const skuIdx      = header.findIndex(h => h === 'sku');
          const oldPriceIdx = header.findIndex(h => h === 'old price' || h === 'oldprice');
          const newPriceIdx = header.findIndex(h => h === 'new price' || h === 'newprice');
          if (dateIdx < 0 || skuIdx < 0 || oldPriceIdx < 0 || newPriceIdx < 0) {
            _pcShowFeedback(document.getElementById('pc-bulk-upload-feedback'),
              'error', '⚠ CSV must have columns: Date, SKU, Old Price, New Price');
            return;
          }

          const parsed = [];
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            if (!row || row.every(c => !c || !c.trim())) continue; // skip blank lines
            const date     = _pcNormalizeDate(row[dateIdx]);
            const sku      = (row[skuIdx] || '').trim();
            const oldPrice = parseFloat((row[oldPriceIdx] || '').replace(/[$,]/g, ''));
            const newPrice = parseFloat((row[newPriceIdx] || '').replace(/[$,]/g, ''));
            if (!date || !sku || !Number.isFinite(oldPrice) || !Number.isFinite(newPrice)) continue;
            parsed.push({ date, sku, oldPrice, newPrice });
          }

          _pcBulkRows = parsed;
          _pcRenderBulkPreview(parsed);
        } catch (err) {
          console.error('CSV parse failed:', err);
          _pcShowFeedback(document.getElementById('pc-bulk-upload-feedback'),
            'error', '⚠ Failed to parse CSV: ' + err.message);
        }
      };
      reader.readAsText(file);
    }

    function _pcRenderBulkPreview(rows) {
      const preview = document.getElementById('pc-bulk-upload-preview');
      if (!preview) return;
      if (rows.length === 0) {
        preview.innerHTML = '<div style="padding: 1rem; color: var(--text-secondary);">No valid rows found</div>';
        return;
      }
      const sample = rows.slice(0, 5);
      let html = `<div style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 0.5rem;">Preview (${rows.length} row${rows.length === 1 ? '' : 's'}, showing first ${sample.length}):</div>`;
      html += '<table style="border-collapse: collapse; font-size: 0.85rem;">';
      html += '<thead><tr style="border-bottom: 1px solid var(--border);"><th style="text-align: left; padding: 0.5rem;">Date</th><th style="text-align: left; padding: 0.5rem;">SKU</th><th style="text-align: right; padding: 0.5rem;">Old</th><th style="text-align: right; padding: 0.5rem;">New</th></tr></thead><tbody>';
      for (const r of sample) {
        html += `<tr style="border-bottom: 1px solid var(--border);"><td style="padding: 0.5rem;">${_pcEsc(r.date)}</td><td style="padding: 0.5rem; font-family: 'Roboto Mono', monospace;">${_pcEsc(r.sku)}</td><td style="padding: 0.5rem; text-align: right;">$${r.oldPrice.toFixed(2)}</td><td style="padding: 0.5rem; text-align: right;">$${r.newPrice.toFixed(2)}</td></tr>`;
      }
      html += '</tbody></table>';
      preview.innerHTML = html;
    }

    async function processPriceChangeBulkUpload() {
      const feedback = document.getElementById('pc-bulk-upload-feedback');
      if (!_pcBulkRows || _pcBulkRows.length === 0) {
        _pcShowFeedback(feedback, 'error', '⚠ No rows to upload');
        return;
      }
      try {
        const res = await fetch('/api/pricechanges?action=bulk-add', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ entries: _pcBulkRows })
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          _pcShowFeedback(feedback, 'error', '⚠ Upload failed: ' + (err.error || res.status));
          return;
        }
        const result = await res.json();
        const tail = result.rejectedCount > 0 ? ` (${result.rejectedCount} rejected by server)` : '';
        _pcShowFeedback(feedback, 'success', `✓ Uploaded ${result.added} price change${result.added === 1 ? '' : 's'}${tail}`);
        setTimeout(() => {
          closePriceChangeBulkUpload();
          pciPriceChanges = [];
          initPCI();
        }, 1500);
      } catch (err) {
        console.error('Bulk upload failed:', err);
        _pcShowFeedback(feedback, 'error', '⚠ Upload failed: ' + err.message);
      }
    }
    window.processPriceChangeBulkUpload = processPriceChangeBulkUpload;

    // ── Helper utilities used by the form / bulk / table render ──────────────

    function _pcShowFeedback(el, kind, msg) {
      if (!el) return;
      el.style.display = 'block';
      el.style.padding = '1rem';
      el.style.borderRadius = '6px';
      if (kind === 'error') {
        el.style.background = 'rgba(239, 68, 68, 0.1)';
        el.style.border = '1px solid var(--error)';
        el.style.color = 'var(--error)';
      } else {
        el.style.background = 'rgba(6, 214, 160, 0.1)';
        el.style.border = '1px solid var(--success)';
        el.style.color = 'var(--success)';
      }
      el.textContent = msg;
    }

    function _pcEsc(s) {
      return (s == null ? '' : String(s))
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Lightweight CSV parser — handles quoted fields with embedded
    // commas / newlines / escaped quotes. Plenty for Excel-exported
    // CSVs of price changes.
    function _pcParseCsv(text) {
      const rows = [];
      let row = [];
      let field = '';
      let inQuotes = false;
      for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
          if (c === '"') {
            if (text[i + 1] === '"') { field += '"'; i++; }
            else inQuotes = false;
          } else {
            field += c;
          }
        } else {
          if (c === '"') inQuotes = true;
          else if (c === ',') { row.push(field); field = ''; }
          else if (c === '\n' || c === '\r') {
            if (c === '\r' && text[i + 1] === '\n') i++; // CRLF
            row.push(field); field = '';
            rows.push(row); row = [];
          } else {
            field += c;
          }
        }
      }
      if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
      return rows;
    }

    // Date normalizer: accepts YYYY-MM-DD, M/D/YY, M/D/YYYY, "Apr 30 2026",
    // "Apr 30, 2026", etc. Returns YYYY-MM-DD or null. Mirrors the
    // change-log bulk uploader so the UX is consistent.
    function _pcNormalizeDate(raw) {
      const s = String(raw || '').trim();
      if (!s) return null;
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
      // M/D/YY or M/D/YYYY
      let m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
      if (m) {
        let y = parseInt(m[3], 10);
        if (y < 100) y += y < 70 ? 2000 : 1900; // 2-digit pivot
        return `${y}-${String(parseInt(m[1], 10)).padStart(2, '0')}-${String(parseInt(m[2], 10)).padStart(2, '0')}`;
      }
      // "Apr 30, 2026" or "Apr 30 2026"
      m = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
      if (m) {
        const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
        const mo = months[m[1].toLowerCase().slice(0, 3)];
        if (mo) return `${m[3]}-${mo}-${String(parseInt(m[2], 10)).padStart(2, '0')}`;
      }
      // Fallback to Date parser
      const d = new Date(s);
      if (!Number.isNaN(d.getTime())) {
        const y = d.getFullYear();
        const mo = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${y}-${mo}-${dd}`;
      }
      return null;
    }

    function renderPCIFilters() {
      const brands = [...new Set(
        pciPriceChanges.map(pc => pciSkuMap[pc.sku]?.brand).filter(Boolean)
      )].sort();

      const brandSelect = document.getElementById('pci-brand-filter');
      brandSelect.innerHTML = '<option value="all">All Brands</option>';
      brands.forEach(b => brandSelect.innerHTML += `<option value="${b}">${b}</option>`);

      filterPCIProducts();
    }

    function filterPCIProducts() {
      const selectedBrand = document.getElementById('pci-brand-filter').value;
      const productSelect = document.getElementById('pci-product-filter');

      const productNames = [...new Set(
        pciPriceChanges
          .filter(pc => selectedBrand === 'all' || pciSkuMap[pc.sku]?.brand === selectedBrand)
          .map(pc => pciSkuMap[pc.sku]?.productName)
          .filter(Boolean)
      )].sort();

      productSelect.innerHTML = '<option value="all">All Products</option>';
      productNames.forEach(n => productSelect.innerHTML += `<option value="${n}">${n}</option>`);

      filterPCIChanges();
    }

    // Populates the "Change to Analyze" dropdown filtered by current product selection
    function filterPCIChanges() {
      const productFilter = document.getElementById('pci-product-filter').value;
      const changeSelect = document.getElementById('pci-change-select');
      const windowDays = parseInt(document.getElementById('pci-window').value);

      const filtered = pciPriceChanges.filter(pc => {
        const info = pciSkuMap[pc.sku];
        if (!info) return false;
        if (productFilter !== 'all' && info.productName !== productFilter) return false;
        return true;
      });

      changeSelect.innerHTML = '<option value="">Select a price change...</option>';
      // Store filtered results on window so loadPCITable can use same set
      window._pciFilteredForSelect = filtered;
      filtered.forEach((pc, i) => {
        const name = pciSkuMap[pc.sku]?.productName || pc.sku;
        changeSelect.innerHTML += `<option value="${i}">${pc.date} — ${name} ($${pc.oldPrice.toFixed(2)} → $${pc.newPrice.toFixed(2)})</option>`;
      });

      // Default to the most recent change (index 0 — list is sorted newest first)
      if (filtered.length > 0) changeSelect.value = '0';

      loadPCITable();
    }

    function loadPCITable() {
      const windowDays = parseInt(document.getElementById('pci-window').value);
      const container = document.getElementById('pci-table-content');

      if (!svOrdersData.length) {
        container.innerHTML = '<div style="padding:4rem;text-align:center;color:var(--text-secondary);">No orders data loaded yet. Run a backfill first.</div>';
        return;
      }

      // Use the same filtered+ordered list that the dropdown was built from
      // so that dropdown index i always matches _pciResults[i]
      const changes = window._pciFilteredForSelect || [];

      // Calculate before/after metrics from orders data
      const yesterday = offsetDate(new Date().toISOString().split('T')[0], -1);

      // Build a per-SKU list of all change dates (sorted ascending) for next-change lookup
      const skuChangeDates = {};
      pciPriceChanges.forEach(pc => {
        if (!skuChangeDates[pc.sku]) skuChangeDates[pc.sku] = [];
        skuChangeDates[pc.sku].push(pc.date);
      });
      Object.values(skuChangeDates).forEach(dates => dates.sort());

      const results = changes.map(pc => {
        const changeDate = pc.date;

        // Find the next change for this SKU after this change date
        const nextChange = (skuChangeDates[pc.sku] || []).find(d => d > changeDate) || null;
        // afterEnd = day before next change, or yesterday — whichever is earlier
        const afterEnd = nextChange
          ? (offsetDate(nextChange, -1) < yesterday ? offsetDate(nextChange, -1) : yesterday)
          : yesterday;

        const beforeStart = offsetDate(changeDate, -windowDays);
        const beforeEnd   = offsetDate(changeDate, -1);
        const afterStart  = changeDate;

        const before = calcOrderMetrics(svOrdersData, pc.sku, beforeStart, beforeEnd, windowDays);
        const after  = calcOrderMetrics(svOrdersData, pc.sku, afterStart, afterEnd, windowDays);
        const daysAfter = daysBetween(changeDate, offsetDate(afterEnd, 1)); // exclusive end

        return {
          id: pc.id, // threaded through so the delete button can target it
          date: pc.date,
          sku: pc.sku,
          brand: pciSkuMap[pc.sku]?.brand || 'Unknown',
          productName: pciSkuMap[pc.sku]?.productName || pc.sku,
          oldPrice: pc.oldPrice,
          newPrice: pc.newPrice,
          changePercent: pc.oldPrice > 0 ? ((pc.newPrice - pc.oldPrice) / pc.oldPrice * 100) : 0,
          nextChange,
          afterEnd,
          daysAfter,
          before,
          after
        };
      });

      // Do NOT sort — order must stay identical to _pciFilteredForSelect so dropdown indices match
      window._pciResults = results;

      if (results.length === 0) {
        container.innerHTML = '<div style="padding:4rem;text-align:center;color:var(--text-secondary);">No price changes found for selected filters.</div>';
        return;
      }

      // Render table (Revenue + Units only, no Margin/Profit)
      let html = `
        <div style="overflow-x: auto;">
          <table class="data-table" style="font-family:'Roboto Mono',monospace; font-size:0.85rem;">
            <thead>
              <tr>
                <th colspan="6" style="text-align:center;padding:0.75rem;border-right:2px solid var(--border);">Price Change</th>
                <th colspan="2" style="text-align:center;padding:0.75rem;border-right:2px solid var(--border);">Before (${windowDays}d)</th>
                <th colspan="2" style="text-align:center;padding:0.75rem;border-right:2px solid var(--border);">After (since change)</th>
                <th colspan="2" style="text-align:center;padding:0.75rem;">Impact</th>
                <th rowspan="2"></th>
              </tr>
              <tr style="background:var(--bg-secondary);">
                <th style="text-align:left;padding:0.5rem;">Date</th>
                <th style="text-align:left;padding:0.5rem;">Brand</th>
                <th style="text-align:left;padding:0.5rem;">Product</th>
                <th style="text-align:center;padding:0.5rem;">Old $</th>
                <th style="text-align:center;padding:0.5rem;">New $</th>
                <th style="text-align:center;padding:0.5rem;border-right:2px solid var(--border);">Δ%</th>
                <th style="text-align:center;padding:0.5rem;">Revenue</th>
                <th style="text-align:center;padding:0.5rem;border-right:2px solid var(--border);">Units</th>
                <th style="text-align:center;padding:0.5rem;">Revenue</th>
                <th style="text-align:center;padding:0.5rem;border-right:2px solid var(--border);">Units</th>
                <th style="text-align:center;padding:0.5rem;">Revenue Δ</th>
                <th style="text-align:center;padding:0.5rem;">Units Δ</th>
              </tr>
            </thead>
            <tbody>`;

      results.forEach((r, i) => {
        const revChange = r.before.revenue > 0 ? ((r.after.revenue - r.before.revenue) / r.before.revenue * 100) : 0;
        const unitsChange = r.before.units > 0 ? ((r.after.units - r.before.units) / r.before.units * 100) : 0;
        const revColor = revChange > 0 ? 'var(--success)' : revChange < 0 ? 'var(--error)' : 'inherit';
        const unitsColor = unitsChange > 0 ? 'var(--success)' : unitsChange < 0 ? 'var(--error)' : 'inherit';
        const rowStyle = `cursor:pointer; transition: background 0.15s;`;

        // Per-row delete button uses event.stopPropagation so clicking
        // it doesn't fire the row's selectPCIChange handler. id is
        // threaded from the API response.
        const deleteBtn = r.id
          ? `<button class="pci-delete-btn" data-id="${_pcEsc(r.id)}" title="Delete this price change" style="background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 1.1rem; padding: 0 0.25rem;" onclick="event.stopPropagation(); deletePriceChange('${_pcEsc(r.id)}', this);">×</button>`
          : '';

        html += `
          <tr style="${rowStyle}" onclick="selectPCIChange(${i})" onmouseover="this.style.background='var(--bg-secondary)'" onmouseout="this.style.background=''">
            <td style="padding:0.75rem;white-space:nowrap;">${r.date}</td>
            <td style="padding:0.75rem;">${shortenBrandName(r.brand)}</td>
            <td style="padding:0.75rem;">${r.productName}</td>
            <td style="text-align:center;padding:0.75rem;">$${r.oldPrice.toFixed(2)}</td>
            <td style="text-align:center;padding:0.75rem;">$${r.newPrice.toFixed(2)}</td>
            <td style="text-align:center;padding:0.75rem;border-right:2px solid var(--border);">${r.changePercent > 0 ? '+' : ''}${r.changePercent.toFixed(1)}%</td>
            <td style="text-align:center;padding:0.75rem;">$${formatNumber(r.before.revenue)}</td>
            <td style="text-align:center;padding:0.75rem;border-right:2px solid var(--border);">${r.before.units}</td>
            <td style="text-align:center;padding:0.75rem;">$${formatNumber(r.after.revenue)}</td>
            <td style="text-align:center;padding:0.75rem;border-right:2px solid var(--border);">${r.after.units}</td>
            <td style="text-align:center;padding:0.75rem;color:${revColor};font-weight:500;">${revChange > 0 ? '+' : ''}${revChange.toFixed(1)}%</td>
            <td style="text-align:center;padding:0.75rem;color:${unitsColor};font-weight:500;">${unitsChange > 0 ? '+' : ''}${unitsChange.toFixed(1)}%</td>
            <td style="text-align:center;padding:0.75rem;">${deleteBtn}</td>
          </tr>`;
      });

      html += `</tbody></table></div>`;
      container.innerHTML = html;

      // If a change was already selected, re-render its charts with the new window
      const currentIdx = document.getElementById('pci-change-select').value;
      if (currentIdx !== '') renderPCICharts();
    }

    function selectPCIChange(index) {
      const changeSelect = document.getElementById('pci-change-select');
      changeSelect.value = index;
      renderPCICharts();
    }

    function renderPCICharts() {
      const index = parseInt(document.getElementById('pci-change-select').value);
      if (isNaN(index) || index === '') return;

      const r = window._pciResults[index];
      const windowDays = parseInt(document.getElementById('pci-window').value);
      if (!r) return;

      // Recalculate metrics fresh using current windowDays
      // "before" = windowDays back; "after" = change date → min(yesterday, day before next change)
      const todayStr = new Date().toISOString().split('T')[0];
      const yesterdayStr = offsetDate(todayStr, -1);
      const beforeStart = offsetDate(r.date, -windowDays);
      const beforeEnd   = offsetDate(r.date, -1);
      const afterStart  = r.date;
      // Re-derive afterEnd using the cached nextChange (window has no effect on after)
      const afterEnd = r.nextChange
        ? (offsetDate(r.nextChange, -1) < yesterdayStr ? offsetDate(r.nextChange, -1) : yesterdayStr)
        : yesterdayStr;

      const freshBefore = calcOrderMetrics(svOrdersData, r.sku, beforeStart, beforeEnd, windowDays);
      const freshAfter  = calcOrderMetrics(svOrdersData, r.sku, afterStart, afterEnd, windowDays);

      // Update summary cards
      const daysBefore = windowDays;
      const daysAfter = r.daysAfter;

      const revBefore   = daysBefore > 0 ? freshBefore.revenue / daysBefore : 0;
      const revAfter    = daysAfter  > 0 ? freshAfter.revenue  / daysAfter  : 0;
      const unitsBefore = daysBefore > 0 ? freshBefore.units   / daysBefore : 0;
      const unitsAfter  = daysAfter  > 0 ? freshAfter.units    / daysAfter  : 0;

      const revChangePct   = revBefore   > 0 ? ((revAfter   - revBefore)   / revBefore   * 100) : 0;
      const unitsChangePct = unitsBefore > 0 ? ((unitsAfter - unitsBefore) / unitsBefore * 100) : 0;

      document.getElementById('pci-summary-rev-before').textContent = '$' + revBefore.toFixed(2);
      document.getElementById('pci-summary-rev-after').textContent = '$' + revAfter.toFixed(2);
      document.getElementById('pci-summary-rev-change').textContent = (revChangePct >= 0 ? '+' : '') + revChangePct.toFixed(1) + '%';
      document.getElementById('pci-summary-rev-change').style.color = revChangePct >= 0 ? 'var(--success)' : 'var(--error)';

      document.getElementById('pci-summary-units-before').textContent = unitsBefore.toFixed(1);
      document.getElementById('pci-summary-units-after').textContent = unitsAfter.toFixed(1);
      document.getElementById('pci-summary-units-change').textContent = (unitsChangePct >= 0 ? '+' : '') + unitsChangePct.toFixed(1) + '%';
      document.getElementById('pci-summary-units-change').style.color = unitsChangePct >= 0 ? 'var(--success)' : 'var(--error)';

      document.getElementById('pci-summary-price').textContent = `$${r.oldPrice.toFixed(2)} → $${r.newPrice.toFixed(2)}`;
      document.getElementById('pci-summary-price-pct').textContent = (r.changePercent >= 0 ? '+' : '') + r.changePercent.toFixed(1) + '%';

      document.getElementById('pci-summary-days').textContent = r.daysAfter;
      // Direct id lookup on the label — the stat box no longer wraps
      // in `.card`, so the old `closest('.card').querySelector('div:first-child')`
      // returned null and threw, killing the chart render.
      const daysLabel = document.getElementById('pci-summary-days-label');
      if (r.nextChange) {
        if (daysLabel) daysLabel.textContent = 'Days to Next Change';
        document.getElementById('pci-summary-change-date').textContent = `${r.date} → ${r.nextChange}`;
      } else {
        if (daysLabel) daysLabel.textContent = 'Days Since Change';
        document.getElementById('pci-summary-change-date').textContent = `Changed ${r.date}`;
      }

      // Build daily data series: windowDays before + days until afterEnd
      const startDate = offsetDate(r.date, -windowDays);
      const endDate = afterEnd;
      const dailyLabels = [];
      const dailyRevenue = [];
      const dailyUnits = [];

      let cursor = startDate;
      while (cursor <= endDate) {
        const dayOrders = svOrdersData.filter(o => o.sku === r.sku && o.orderDate === cursor);
        dailyLabels.push(cursor.slice(5)); // MM-DD
        dailyRevenue.push(dayOrders.reduce((s, o) => s + (o.itemTotal || 0), 0));
        dailyUnits.push(dayOrders.reduce((s, o) => s + (o.quantity || 0), 0));
        cursor = offsetDate(cursor, 1);
      }

      const changeIdx = windowDays; // index of change date in the series

      // 7-day centred rolling average
      const rolling = (arr, w) => arr.map((_, i) => {
        const slice = arr.slice(Math.max(0, i - Math.floor(w / 2)), Math.min(arr.length, i + Math.floor(w / 2) + 1));
        return slice.reduce((a, b) => a + b, 0) / slice.length;
      });
      const rollingRev   = rolling(dailyRevenue, 7);
      const rollingUnits = rolling(dailyUnits, 7);


      // Annotation: subtle white dashed vertical line at change date
      const annotationLine = {
        type: 'line',
        xMin: changeIdx - 0.5,
        xMax: changeIdx - 0.5,
        borderColor: 'rgba(255, 255, 255, 0.35)',
        borderWidth: 1.5,
        borderDash: [4, 4]
      };

      const mkOpts = (isCurrency) => ({
        responsive: true,
        plugins: {
          legend: { display: false },
          annotation: { annotations: { changeDay: annotationLine } }
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { callback: v => isCurrency ? '$' + v.toLocaleString() : v.toLocaleString() }
          }
        }
      });

      const mkDatasets = (rolling, color) => ([
        { data: rolling, borderColor: color, backgroundColor: color.replace('rgb', 'rgba').replace(')', ', 0.1)'), tension: 0.4, pointRadius: 0, borderWidth: 2 }
      ]);

      // Destroy old charts
      ['pciRollingRevChart','pciRollingUnitsChart'].forEach(k => {
        if (window[k]) { window[k].destroy(); window[k] = null; }
      });

      window.pciRollingRevChart = new Chart(document.getElementById('pci-rolling-rev-chart').getContext('2d'), {
        type: 'line',
        data: { labels: dailyLabels, datasets: mkDatasets(rollingRev, 'rgb(34, 197, 94)') },
        options: mkOpts(true)
      });

      window.pciRollingUnitsChart = new Chart(document.getElementById('pci-rolling-units-chart').getContext('2d'), {
        type: 'line',
        data: { labels: dailyLabels, datasets: mkDatasets(rollingUnits, 'rgb(59, 130, 246)') },
        options: mkOpts(false)
      });
    }

    // Returns { revenue, units } for a SKU within a date range from orders data
    function calcOrderMetrics(orders, sku, startDate, endDate, windowDays) {
      const filtered = orders.filter(o => o.sku === sku && o.orderDate >= startDate && o.orderDate <= endDate);
      return {
        revenue: filtered.reduce((s, o) => s + (o.itemTotal || 0), 0),
        units: filtered.reduce((s, o) => s + (o.quantity || 0), 0)
      };
    }

    // Returns a YYYY-MM-DD string offset by N days from a YYYY-MM-DD string
    function offsetDate(dateStr, days) {
      const d = new Date(dateStr + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() + days);
      return d.toISOString().split('T')[0];
    }

    function daysBetween(dateStrA, dateStrB) {
      const a = new Date(dateStrA + 'T12:00:00Z');
      const b = new Date(dateStrB + 'T12:00:00Z');
      return Math.max(0, Math.round((b - a) / (1000 * 60 * 60 * 24)));
    }


    // ── PCI EXPORT ────────────────────────────────────────────────────────────

    function togglePCIBrandDropdown(e) {
      e.stopPropagation();
      const menu = document.getElementById('pci-export-brand-menu');
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    }

    // Close dropdown when clicking outside
    document.addEventListener('click', () => {
      const menu = document.getElementById('pci-export-brand-menu');
      if (menu) menu.style.display = 'none';
    });

    function populatePCIExportBrands() {
      const container = document.getElementById('pci-export-brand-checkboxes');
      if (!container) return;
      // Use svAllProducts (loaded on page open) so brands are available immediately
      const brands = [...new Set(svAllProducts.map(p => p.brand).filter(Boolean))].sort();
      container.innerHTML = brands.map(b => `
        <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-size: 0.875rem;">
          <input type="checkbox" class="pci-export-brand-cb" value="${b}" checked onchange="updatePCIBrandLabel()">
          ${b}
        </label>`).join('');
      updatePCIBrandLabel();
    }

    function updatePCIBrandLabel() {
      const total = document.querySelectorAll('.pci-export-brand-cb').length;
      const checked = document.querySelectorAll('.pci-export-brand-cb:checked').length;
      document.getElementById('pci-export-brand-label').textContent =
        checked === total ? 'All brands' : checked === 0 ? 'No brands' : `${checked} brand${checked > 1 ? 's' : ''}`;
    }

    function pciSelectAllBrands() {
      document.querySelectorAll('.pci-export-brand-cb').forEach(cb => cb.checked = true);
      updatePCIBrandLabel();
    }

    function pciSelectNoBrands() {
      document.querySelectorAll('.pci-export-brand-cb').forEach(cb => cb.checked = false);
      updatePCIBrandLabel();
    }

    function exportPCIAnalysis() {
      const feedback = document.getElementById('pci-export-feedback');
      feedback.style.display = 'none';

      const startDate = document.getElementById('pci-export-start').value;
      const endDate   = document.getElementById('pci-export-end').value;
      const windowDays = parseInt(document.getElementById('pci-export-window').value);

      if (!startDate || !endDate) {
        showFeedback(feedback, 'error', '⚠ Please select both a start and end date');
        return;
      }

      const selectedBrands = new Set(
        Array.from(document.querySelectorAll('.pci-export-brand-cb:checked')).map(cb => cb.value)
      );
      if (selectedBrands.size === 0) {
        showFeedback(feedback, 'error', '⚠ Please select at least one brand');
        return;
      }

      if (!pciPriceChanges.length) {
        showFeedback(feedback, 'error', '⚠ Price change data not loaded yet — open the Price Change Impacts tab first');
        return;
      }

      // Build per-SKU sorted change dates for next-change lookup
      const skuChangeDates = {};
      pciPriceChanges.forEach(pc => {
        if (!skuChangeDates[pc.sku]) skuChangeDates[pc.sku] = [];
        skuChangeDates[pc.sku].push(pc.date);
      });
      Object.values(skuChangeDates).forEach(dates => dates.sort());

      const yesterday = offsetDate(new Date().toISOString().split('T')[0], -1);

      // Filter price changes to the requested date range + brands
      const rows = pciPriceChanges
        .filter(pc => {
          const info = pciSkuMap[pc.sku];
          if (!info) return false;
          if (!selectedBrands.has(info.brand)) return false;
          if (pc.date < startDate || pc.date > endDate) return false;
          return true;
        })
        .map(pc => {
          const info = pciSkuMap[pc.sku] || {};
          const nextChange = (skuChangeDates[pc.sku] || []).find(d => d > pc.date) || null;
          const afterEnd = nextChange
            ? (offsetDate(nextChange, -1) < yesterday ? offsetDate(nextChange, -1) : yesterday)
            : yesterday;

          const beforeStart = offsetDate(pc.date, -windowDays);
          const beforeEnd   = offsetDate(pc.date, -1);

          const before = calcOrderMetrics(svOrdersData, pc.sku, beforeStart, beforeEnd, windowDays);
          const after  = calcOrderMetrics(svOrdersData, pc.sku, pc.date, afterEnd, windowDays);
          const daysAfter = daysBetween(pc.date, offsetDate(afterEnd, 1));

          const revChange   = before.revenue > 0 ? ((after.revenue   - before.revenue)   / before.revenue   * 100) : 0;
          const unitsChange = before.units   > 0 ? ((after.units     - before.units)     / before.units     * 100) : 0;
          const changePercent = pc.oldPrice > 0 ? ((pc.newPrice - pc.oldPrice) / pc.oldPrice * 100) : 0;

          return [
            pc.date,
            info.brand || '',
            info.productName || pc.sku,
            pc.sku,
            pc.oldPrice.toFixed(2),
            pc.newPrice.toFixed(2),
            changePercent.toFixed(1) + '%',
            windowDays,
            daysAfter,
            before.revenue.toFixed(2),
            before.units,
            after.revenue.toFixed(2),
            after.units,
            revChange.toFixed(1) + '%',
            unitsChange.toFixed(1) + '%',
            nextChange || ''
          ];
        });

      if (rows.length === 0) {
        showFeedback(feedback, 'error', '⚠ No price changes found for the selected criteria');
        return;
      }

      const headers = [
        'Change Date', 'Brand', 'Product', 'SKU',
        'Old Price', 'New Price', 'Price Change %',
        'Before Window (days)', 'After Window (days)',
        'Before Revenue', 'Before Units',
        'After Revenue', 'After Units',
        'Revenue Change %', 'Units Change %',
        'Next Change Date'
      ];

      const csv = [headers, ...rows]
        .map(row => row.map(v => `"${String(v).replace(/"/g, '""')}"`).join(','))
        .join('\n');

      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `price-change-analysis-${startDate}-to-${endDate}.csv`;
      a.click();
      URL.revokeObjectURL(url);

      showFeedback(feedback, 'success', `✓ Exported ${rows.length} price change${rows.length !== 1 ? 's' : ''}`);
    }


    // ── ORDERS BACKFILL + SYNC ────────────────────────────────────────────────

    // Runs day-by-day from the browser to avoid Vercel's 60s function timeout.
    async function runOrdersBackfill() {
      if (!accessToken) { alert('Please sign in first.'); return; }

      const startDate = document.getElementById('backfill-start').value;
      const endDate   = document.getElementById('backfill-end').value;

      if (!startDate || !endDate) { alert('Please select a start and end date.'); return; }
      if (startDate > endDate)    { alert('Start date must be before end date.'); return; }

      const btn = document.getElementById('backfill-btn');
      const log = document.getElementById('backfill-log');
      btn.disabled = true;
      btn.textContent = 'Running…';
      log.style.display = 'block';
      log.innerHTML = '';

      const addLine = (msg, color) => {
        const el = document.createElement('div');
        el.style.color = color || 'var(--text-primary)';
        el.textContent = msg;
        log.appendChild(el);
        log.scrollTop = log.scrollHeight;
      };

      // Build list of all dates in range
      const dates = [];
      const cursor = new Date(startDate + 'T12:00:00Z');
      const stop   = new Date(endDate   + 'T12:00:00Z');
      while (cursor <= stop) {
        dates.push(cursor.toISOString().split('T')[0]);
        cursor.setUTCDate(cursor.getUTCDate() + 1);
      }

      addLine(`Fetching ${dates.length} day(s): ${startDate} → ${endDate}`, 'var(--text-secondary)');

      let totalRecords = 0;
      let errors = 0;

      for (let i = 0; i < dates.length; i++) {
        const date = dates[i];
        try {
          const res  = await fetch(`/api/orders?action=sync&date=${date}`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
          });
          const data = await res.json();

          if (data.success) {
            totalRecords += data.newRecords;
            addLine(`✓ ${date} — ${data.newRecords} line items (${totalRecords} total, ${i + 1}/${dates.length})`, 'var(--success)');
          } else {
            errors++;
            addLine(`⚠ ${date} — ${data.error}`, 'var(--error)');
          }
        } catch (err) {
          errors++;
          addLine(`⚠ ${date} — ${err.message}`, 'var(--error)');
        }
      }

      if (errors === 0) {
        addLine(`COMPLETE — ${totalRecords} order line items stored across ${dates.length} days`, 'var(--success)');
      } else {
        addLine(`DONE with ${errors} error(s) — ${totalRecords} line items stored`, 'var(--warning)');
      }

      btn.disabled   = false;
      btn.textContent = 'Fetch Orders';

      // Rebuild cache then reload the page data
      await rebuildMonthlySummaryCache();
      await loadSalesVolumeData();
    }

    async function testOrdersSync() {
      if (!accessToken) { alert('Please sign in first.'); return; }

      const log = document.getElementById('backfill-log');
      log.style.display = 'block';
      log.innerHTML = '<div style="color:var(--text-secondary);">Syncing yesterday…</div>';

      try {
        const res  = await fetch('/api/orders?action=sync', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const data = await res.json();

        if (data.success) {
          log.innerHTML = `<div style="color:var(--success);">✓ Sync complete — ${data.newRecords} order line items stored for ${data.date}</div>`;
          await rebuildMonthlySummaryCache();
          await loadSalesVolumeData();
        } else {
          log.innerHTML = `<div style="color:var(--error);">✗ Sync failed: ${data.error}</div>`;
        }
      } catch (err) {
        log.innerHTML = `<div style="color:var(--error);">✗ Error: ${err.message}</div>`;
      }
    }

    // ── MONTHLY SUMMARY CACHE ─────────────────────────────────────────────────
    // Stores pre-aggregated { yearMonth, sku, brand, revenue, units } in Upstash
    // so Monthly Overview loads in one KV read instead of 12+.

    async function loadMonthlySummaryCache() {
      try {
        const res = await fetch('/api/orders?action=get-summary', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.summary || null;
      } catch { return null; }
    }

    async function rebuildMonthlySummaryCache() {
      try {
        await fetch('/api/orders?action=rebuild-summary', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
      } catch (err) {
        console.warn('Could not rebuild summary cache:', err.message);
      }
    }

    // Update the persistent info blurb with the most recent order date
    function updateSVDataBlurb(orders) {
      const el = document.getElementById('sv-latest-date');
      if (!el) return;
      if (!orders || orders.length === 0) { el.textContent = 'No data loaded'; return; }
      const latest = orders.reduce((max, o) => o.orderDate > max ? o.orderDate : max, '');
      el.textContent = latest || '—';
    }
