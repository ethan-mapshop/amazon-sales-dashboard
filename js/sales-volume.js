    // SALES & VOLUME PAGE
    let svAllProducts = [];
    let svOrdersData = [];
    let svSalesChart = null;
    let svVolumeChart = null;
    
    async function loadSalesVolumeData() {
      if (!accessToken) return;
      
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
        
        // Load products (Child + Non-Variable only)
        const productsResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Products!A2:G`, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        
        const productsData = await productsResponse.json();
        
        if (productsData.values && productsData.values.length > 0) {
          svAllProducts = productsData.values
            .filter(row => {
              const asin = row[5];
              const productType = row[6] || '';
              return asin && 
                     asin.toUpperCase() !== 'N/A' && 
                     (productType === 'Child' || productType === 'Non-Variable');
            })
            .map(row => ({
              sku: row[0],
              name: row[1] || row[0],
              brand: row[2] || 'Unknown',
              asin: row[5],
              productType: row[6] || ''
            }));
          
          // Populate brand dropdown
          const brands = [...new Set(svAllProducts.map(p => p.brand))].sort();
          const brandSelect = document.getElementById('sv-brand-filter');
          brandSelect.innerHTML = '<option value="">All Brands</option>';
          brands.forEach(brand => {
            brandSelect.innerHTML += `<option value="${brand}">${brand}</option>`;
          });
          
          // Populate products
          filterSVProducts();
        }
        
        // Render data
        renderSalesVolumeData();

        // Populate export brand list now that svAllProducts is loaded
        populatePCIExportBrands();

        // Pre-load PCI data in background so it's ready when tab is clicked
        initPCI();
        
      } catch (error) {
        console.error('Error loading sales & volume data:', error);
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

    function parsePriceChanges(data) {
      if (!data.values || data.values.length < 2) return [];
      const headers = data.values[0].map(h => h.toLowerCase());
      const dateIdx     = headers.indexOf('date');
      const skuIdx      = headers.indexOf('sku');
      const oldPriceIdx = headers.indexOf('old price');
      const newPriceIdx = headers.indexOf('new price');
      const changes = [];
      for (let i = 1; i < data.values.length; i++) {
        const row = data.values[i];
        changes.push({
          date:     row[dateIdx],
          sku:      row[skuIdx],
          oldPrice: parseFloat(row[oldPriceIdx]) || 0,
          newPrice: parseFloat(row[newPriceIdx]) || 0
        });
      }
      return changes.sort((a, b) => new Date(b.date) - new Date(a.date));
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
    let pciPriceChanges = []; // parsed from Sheets
    let pciSkuMap = {};       // sku -> { brand, productName }

    async function initPCI() {
      if (!accessToken) return;
      if (pciPriceChanges.length > 0) {
        // Already loaded — just re-render table
        renderPCIFilters();
        loadPCITable();
        return;
      }

      try {
        const [priceChangesRes, productsRes] = await Promise.all([
          fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/PriceChanges`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
          }),
          fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Products`, {
            headers: { 'Authorization': `Bearer ${accessToken}` }
          })
        ]);

        if (!priceChangesRes.ok) {
          document.getElementById('pci-table-content').innerHTML =
            '<div style="padding:4rem;text-align:center;color:var(--error);">PriceChanges sheet not found.</div>';
          return;
        }

        const [pcData, prodData] = await Promise.all([priceChangesRes.json(), productsRes.json()]);
        pciPriceChanges = parsePriceChanges(pcData); // reuse existing parser

        // Build sku map from products sheet
        const products = parseProducts(prodData);
        pciSkuMap = {};
        products.forEach(p => { pciSkuMap[p.sku] = { brand: p.brand, productName: p.name }; });

        renderPCIFilters();
        loadPCITable();

      } catch (err) {
        console.error('PCI init error:', err);
        document.getElementById('pci-table-content').innerHTML =
          `<div style="padding:4rem;text-align:center;color:var(--error);">Error: ${err.message}</div>`;
      }
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
          <table class="data-table" style="width:100%; font-family:'Roboto Mono',monospace; font-size:0.85rem;">
            <thead>
              <tr>
                <th colspan="6" style="text-align:center;padding:0.75rem;border-right:2px solid var(--border);">Price Change</th>
                <th colspan="2" style="text-align:center;padding:0.75rem;border-right:2px solid var(--border);">Before (${windowDays}d)</th>
                <th colspan="2" style="text-align:center;padding:0.75rem;border-right:2px solid var(--border);">After (since change)</th>
                <th colspan="2" style="text-align:center;padding:0.75rem;">Impact</th>
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
      if (r.nextChange) {
        document.getElementById('pci-summary-days').closest('.card').querySelector('div:first-child').textContent = 'Days to Next Change';
        document.getElementById('pci-summary-change-date').textContent = `${r.date} → ${r.nextChange}`;
      } else {
        document.getElementById('pci-summary-days').closest('.card').querySelector('div:first-child').textContent = 'Days Since Change';
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
