    // ==================== SESSION & CVR ====================
    
    let sessionData = [];
    let sessionReportId = null;
    let sessionPollingInterval = null;
    let sessionsChart = null;
    let cvrChart = null;
    let pageviewsChart = null;
    
    async function fetchSessionData() {
      const fetchDate = document.getElementById('session-fetch-date').value;
      const feedback = document.getElementById('session-fetch-feedback');
      
      if (!fetchDate) {
        showFeedback(feedback, 'error', '⚠ Please select a date to fetch');
        return;
      }
      
      try {
        showFeedback(feedback, 'info', 'Requesting report from Amazon...');
        
        const response = await fetch('/api/sessions?action=request', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            startDate: fetchDate,
            endDate: fetchDate
          })
        });
        
        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error);
        }
        
        const result = await response.json();
        sessionReportId = result.reportId;
        
        showFeedback(feedback, 'info', `Report requested (ID: ${sessionReportId}). Checking status...`);
        
        // Start polling for report completion
        sessionPollingInterval = setInterval(() => pollSessionReport(feedback), 10000); // Check every 10 seconds
        
      } catch (error) {
        console.error('Error fetching session data:', error);
        showFeedback(feedback, 'error', '⚠ Error: ' + error.message);
      }
    }
    
    async function pollSessionReport(feedback) {
      try {
        const response = await fetch('/api/sessions?action=download', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            reportId: sessionReportId
          })
        });
        
        if (!response.ok) {
          throw new Error('Failed to check report status');
        }
        
        const result = await response.json();
        
        if (result.status === 'DONE') {
          clearInterval(sessionPollingInterval);
          showFeedback(feedback, 'success', `✓ Successfully fetched ${result.recordCount} records!`);
          
          // Load data and show charts
          await loadSessionData();
          
        } else {
          showFeedback(feedback, 'info', `Report status: ${result.status}. Still processing...`);
        }
        
      } catch (error) {
        clearInterval(sessionPollingInterval);
        console.error('Error polling report:', error);
        showFeedback(feedback, 'error', '⚠ Error checking report: ' + error.message);
      }
    }
    
    async function loadSessionData() {
      try {
        const response = await fetch('/api/sessions?action=get', {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });
        
        if (!response.ok) {
          throw new Error('Failed to load session data');
        }
        
        const result = await response.json();
        sessionData = result.data;
        
        // Display latest date in database
        if (sessionData.length > 0) {
          const dates = sessionData.map(d => d.date).filter(Boolean);
          const latestDate = dates.sort().reverse()[0];
          document.getElementById('latest-session-date').textContent = latestDate || 'No data';
        } else {
          document.getElementById('latest-session-date').textContent = 'No data';
        }
        
        // Load products from Google Sheets to populate dropdowns
        const productsResponse = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Products!A2:G`, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        
        const productsData = await productsResponse.json();
        
        if (productsData.values && productsData.values.length > 0) {
          // Store products - A=sku, B=name, C=brand, F=asin, G=productType
          // For Listing Optimization: only show Parent and Non-Variable products
          // Filter out discontinued products (ASIN = N/A) and Child products
          allProducts = productsData.values
            .filter(row => {
              const asin = row[5];
              const productType = row[6] || '';
              return asin && 
                     asin.toUpperCase() !== 'N/A' && 
                     (productType === 'Parent' || productType === 'Non-Variable');
            })
            .map(row => ({
              sku: row[0],
              name: row[1] || row[0],
              brand: row[2] || 'Unknown',
              asin: row[5],
              productType: row[6] || ''
            }));
          
          // Get unique brands
          const brands = [...new Set(allProducts.map(p => p.brand))].sort();
          
          // Populate brand dropdown
          const brandSelect = document.getElementById('session-brand-filter');
          brandSelect.innerHTML = '<option value="">All Brands</option>';
          brands.forEach(brand => {
            brandSelect.innerHTML += `<option value="${brand}">${brand}</option>`;
          });
          
          // Populate export brand checkboxes
          const exportBrandCheckboxes = document.getElementById('export-brand-checkboxes');
          exportBrandCheckboxes.innerHTML = '';
          brands.forEach(brand => {
            exportBrandCheckboxes.innerHTML += `
              <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer;">
                <input type="checkbox" class="export-brand-checkbox" value="${brand}" checked onchange="updateBrandDropdownLabel()" style="cursor: pointer;">
                <span style="font-size: 0.875rem;">${brand}</span>
              </label>
            `;
          });
          
          // Populate products (all initially)
          filterSessionProducts();
        }
        
        // Show charts section
        document.getElementById('session-charts').style.display = 'block';
        
      } catch (error) {
        console.error('Error loading session data:', error);
      }
    }
    
    function filterSessionProducts() {
      const selectedBrand = document.getElementById('session-brand-filter').value;
      const productSelect = document.getElementById('session-product-filter');
      
      // Filter products by brand
      let filteredProducts = selectedBrand 
        ? allProducts.filter(p => p.brand === selectedBrand)
        : allProducts;
      
      // Deduplicate by ASIN (keep first occurrence)
      const seenAsins = new Set();
      filteredProducts = filteredProducts.filter(product => {
        if (seenAsins.has(product.asin)) {
          return false;
        }
        seenAsins.add(product.asin);
        return true;
      });
      
      // Sort alphabetically by name
      filteredProducts.sort((a, b) => a.name.localeCompare(b.name));
      
      // Populate product dropdown
      productSelect.innerHTML = '<option value="">Select Product...</option>';
      filteredProducts.forEach(product => {
        productSelect.innerHTML += `<option value="${product.asin}" data-name="${product.name}">${product.name} (${product.asin})</option>`;
      });
    }
    
    async function filterSessionChanges() {
      const selectedASIN = document.getElementById('session-product-filter').value;
      const changeSelect = document.getElementById('session-change-filter');
      
      if (!selectedASIN) {
        changeSelect.innerHTML = '<option value="">Select Change...</option>';
        return;
      }
      
      try {
        // Fetch Change Log from the Upstash-backed API. ASIN match is
        // case-insensitive — change-log entries are stored uppercase
        // server-side, so uppercase the selected ASIN before comparing.
        const response = await fetch('/api/changelog?action=get', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const data = await response.json();
        const entries = Array.isArray(data.entries) ? data.entries : [];
        const targetAsin = String(selectedASIN || '').toUpperCase();

        const changes = entries
          .filter(e => (e.asin || '').toUpperCase() === targetAsin)
          .map(e => ({
            date: e.date,
            product: e.productName,
            asin: e.asin,
            changes: e.changes,
            notes: e.notes
          }))
          .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

        // Populate change dropdown
        changeSelect.innerHTML = '<option value="">Select Change...</option>';
        changes.forEach((change, index) => {
          changeSelect.innerHTML += `<option value="${index}" data-date="${change.date}">${change.date} - ${change.changes}</option>`;
        });

        window.sessionChanges = changes;
      } catch (error) {
        console.error('Error loading changes:', error);
      }
    }
    
    async function renderSessionCharts() {
      const selectedASIN = document.getElementById('session-product-filter').value;
      const changeIndex = document.getElementById('session-change-filter').value;
      
      if (!selectedASIN || changeIndex === '') {
        return;
      }
      
      // Get selected change
      const change = window.sessionChanges[changeIndex];
      const changeDate = new Date(change.date);
      
      // Filter data for selected ASIN
      const asinData = sessionData.filter(d => d.asin === selectedASIN);
      
      // Sort by date
      asinData.sort((a, b) => new Date(a.date) - new Date(b.date));
      
      // Calculate 30 days before change
      const thirtyDaysBefore = new Date(changeDate);
      thirtyDaysBefore.setDate(thirtyDaysBefore.getDate() - 30);
      
      // Split data into before and after
      const beforeData = asinData.filter(d => {
        const date = new Date(d.date);
        return date >= thirtyDaysBefore && date < changeDate;
      });
      
      const afterData = asinData.filter(d => {
        const date = new Date(d.date);
        return date >= changeDate;
      });
      
      // Calculate metrics
      const avgSessionsBefore = beforeData.length > 0 
        ? beforeData.reduce((sum, d) => sum + d.sessions, 0) / beforeData.length 
        : 0;
      const avgSessionsAfter = afterData.length > 0 
        ? afterData.reduce((sum, d) => sum + d.sessions, 0) / afterData.length 
        : 0;
      const sessionsChange = avgSessionsBefore > 0 
        ? ((avgSessionsAfter - avgSessionsBefore) / avgSessionsBefore) * 100 
        : 0;
      
      const avgCVRBefore = beforeData.length > 0 
        ? beforeData.reduce((sum, d) => sum + d.unitSessionPercentage, 0) / beforeData.length 
        : 0;
      const avgCVRAfter = afterData.length > 0 
        ? afterData.reduce((sum, d) => sum + d.unitSessionPercentage, 0) / afterData.length 
        : 0;
      const cvrChange = avgCVRBefore > 0 
        ? ((avgCVRAfter - avgCVRBefore) / avgCVRBefore) * 100 
        : 0;
      
      const avgPageViewsBefore = beforeData.length > 0 
        ? beforeData.reduce((sum, d) => sum + d.pageViews, 0) / beforeData.length 
        : 0;
      const avgPageViewsAfter = afterData.length > 0 
        ? afterData.reduce((sum, d) => sum + d.pageViews, 0) / afterData.length 
        : 0;
      const pageViewsChange = avgPageViewsBefore > 0 
        ? ((avgPageViewsAfter - avgPageViewsBefore) / avgPageViewsBefore) * 100 
        : 0;
      
      // Calculate days since change
      const today = new Date();
      const daysSince = Math.floor((today - changeDate) / (1000 * 60 * 60 * 24));
      
      // Update summary cards
      document.getElementById('summary-sessions-before').textContent = avgSessionsBefore.toFixed(1);
      document.getElementById('summary-sessions-after').textContent = avgSessionsAfter.toFixed(1);
      document.getElementById('summary-sessions-change').textContent = (sessionsChange >= 0 ? '+' : '') + sessionsChange.toFixed(1) + '%';
      document.getElementById('summary-sessions-change').style.color = sessionsChange >= 0 ? 'var(--success)' : 'var(--error)';
      
      document.getElementById('summary-cvr-before').textContent = avgCVRBefore.toFixed(2) + '%';
      document.getElementById('summary-cvr-after').textContent = avgCVRAfter.toFixed(2) + '%';
      document.getElementById('summary-cvr-change').textContent = (cvrChange >= 0 ? '+' : '') + cvrChange.toFixed(1) + '%';
      document.getElementById('summary-cvr-change').style.color = cvrChange >= 0 ? 'var(--success)' : 'var(--error)';
      
      document.getElementById('summary-pageviews-before').textContent = avgPageViewsBefore.toFixed(1);
      document.getElementById('summary-pageviews-after').textContent = avgPageViewsAfter.toFixed(1);
      document.getElementById('summary-pageviews-change').textContent = (pageViewsChange >= 0 ? '+' : '') + pageViewsChange.toFixed(1) + '%';
      document.getElementById('summary-pageviews-change').style.color = pageViewsChange >= 0 ? 'var(--success)' : 'var(--error)';
      
      document.getElementById('summary-days-since').textContent = daysSince;
      document.getElementById('summary-change-date').textContent = `Change: ${change.date} - ${change.changes}`;
      
      // Prepare chart data (show 30 days before change and all data after)
      const chartData = asinData.filter(d => {
        const date = new Date(d.date);
        return date >= thirtyDaysBefore; // Only show from 30 days before change onwards
      });
      
      const dates = chartData.map(d => d.date);
      const sessions = chartData.map(d => d.sessions);
      const cvr = chartData.map(d => d.unitSessionPercentage);
      const pageViews = chartData.map(d => d.pageViews);
      
      // Create annotation for change date
      const annotations = {
        changeLine: {
          type: 'line',
          xMin: change.date,
          xMax: change.date,
          borderColor: 'rgba(255, 99, 132, 0.8)',
          borderWidth: 2,
          borderDash: [5, 5]
        }
      };
      
      // Destroy existing charts
      if (sessionsChart) sessionsChart.destroy();
      if (cvrChart) cvrChart.destroy();
      if (pageviewsChart) pageviewsChart.destroy();
      
      // Create Sessions chart
      const sessionsCtx = document.getElementById('sessions-chart').getContext('2d');
      sessionsChart = new Chart(sessionsCtx, {
        type: 'line',
        data: {
          labels: dates,
          datasets: [{
            label: 'Sessions',
            data: sessions,
            borderColor: 'rgb(255, 159, 64)',
            backgroundColor: 'rgba(255, 159, 64, 0.1)',
            tension: 0.4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: {
            legend: {
              display: false
            },
            annotation: {
              annotations
            }
          },
          scales: {
            y: {
              beginAtZero: true
            }
          }
        }
      });
      
      // Create CVR chart
      const cvrCtx = document.getElementById('cvr-chart').getContext('2d');
      cvrChart = new Chart(cvrCtx, {
        type: 'line',
        data: {
          labels: dates,
          datasets: [{
            label: 'CVR (%)',
            data: cvr,
            borderColor: 'rgb(59, 130, 246)',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            tension: 0.4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: {
            legend: {
              display: false
            },
            annotation: {
              annotations
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                callback: function(value) {
                  return value + '%';
                }
              }
            }
          }
        }
      });
      
      // Create Page Views chart
      const pageviewsCtx = document.getElementById('pageviews-chart').getContext('2d');
      pageviewsChart = new Chart(pageviewsCtx, {
        type: 'line',
        data: {
          labels: dates,
          datasets: [{
            label: 'Page Views',
            data: pageViews,
            borderColor: 'rgb(34, 197, 94)',
            backgroundColor: 'rgba(34, 197, 94, 0.1)',
            tension: 0.4
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: {
            legend: {
              display: false
            },
            annotation: {
              annotations
            }
          },
          scales: {
            y: {
              beginAtZero: true
            }
          }
        }
      });
    }
    
    async function getChangeLogDates(asin) {
      try {
        const response = await fetch('/api/changelog?action=get', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!response.ok) return [];
        const data = await response.json();
        const entries = Array.isArray(data.entries) ? data.entries : [];
        const targetAsin = String(asin || '').toUpperCase();
        return entries
          .filter(e => (e.asin || '').toUpperCase() === targetAsin)
          .map(e => e.date);
      } catch (error) {
        console.error('Error loading change log dates:', error);
        return [];
      }
    }
    
    async function backfillSessions() {
      const startDate = document.getElementById('backfill-start-date').value;
      const endDate = document.getElementById('backfill-end-date').value;
      const progressDiv = document.getElementById('backfill-progress');
      const feedback = document.getElementById('session-fetch-feedback');
      
      if (!startDate || !endDate) {
        showFeedback(feedback, 'error', '⚠ Please select both start and end dates for backfill');
        return;
      }
      
      progressDiv.style.display = 'block';
      progressDiv.innerHTML = `Starting backfill from ${startDate} to ${endDate}...\n`;
      feedback.style.display = 'none';
      
      try {
        const response = await fetch('/api/sessions?action=backfill', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ startDate, endDate })
        });
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');
          
          lines.forEach(line => {
            if (line.startsWith('data: ')) {
              const message = line.substring(6);
              progressDiv.innerHTML += message + '\n';
              progressDiv.scrollTop = progressDiv.scrollHeight;
            }
          });
        }
        
        // Reload data
        await loadSessionData();
        
        showFeedback(feedback, 'success', '✓ Backfill complete! Data loaded.');
        
      } catch (error) {
        console.error('Backfill error:', error);
        showFeedback(feedback, 'error', '⚠ Backfill failed: ' + error.message);
      }
    }
    
    
    function selectAllBrands() {
      document.querySelectorAll('.export-brand-checkbox').forEach(cb => cb.checked = true);
      updateBrandDropdownLabel();
    }
    
    function selectNoBrands() {
      document.querySelectorAll('.export-brand-checkbox').forEach(cb => cb.checked = false);
      updateBrandDropdownLabel();
    }
    
    function toggleBrandDropdown(event) {
      event.stopPropagation();
      const menu = document.getElementById('brand-dropdown-menu');
      menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    }
    
    function updateBrandDropdownLabel() {
      const checkboxes = document.querySelectorAll('.export-brand-checkbox');
      const checkedCount = Array.from(checkboxes).filter(cb => cb.checked).length;
      const totalCount = checkboxes.length;
      const label = document.getElementById('brand-dropdown-label');
      
      if (checkedCount === 0) {
        label.textContent = 'No brands selected';
      } else if (checkedCount === totalCount) {
        label.textContent = 'All brands selected';
      } else {
        label.textContent = `${checkedCount} brand${checkedCount > 1 ? 's' : ''} selected`;
      }
    }
    
    // Close dropdown when clicking outside
    document.addEventListener('click', function(event) {
      const menu = document.getElementById('brand-dropdown-menu');
      const btn = document.getElementById('brand-dropdown-btn');
      if (menu && btn && !menu.contains(event.target) && !btn.contains(event.target)) {
        menu.style.display = 'none';
      }
    });
    
    async function exportChangeAnalysis() {
      const feedback = document.getElementById('export-feedback');
      const startDate = document.getElementById('export-start-date').value;
      const endDate = document.getElementById('export-end-date').value;
      
      if (!startDate || !endDate) {
        showFeedback(feedback, 'error', '⚠ Please select both start and end dates');
        return;
      }
      
      // Get selected brands
      const selectedBrands = Array.from(document.querySelectorAll('.export-brand-checkbox:checked'))
        .map(cb => cb.value);
      
      if (selectedBrands.length === 0) {
        showFeedback(feedback, 'error', '⚠ Please select at least one brand');
        return;
      }
      
      showFeedback(feedback, 'info', 'Generating export...');
      
      try {
        // Fetch change log data from the Upstash-backed API.
        const changeLogResponse = await fetch('/api/changelog?action=get', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!changeLogResponse.ok) {
          throw new Error(`Change log fetch failed (${changeLogResponse.status})`);
        }
        const changeLogData = await changeLogResponse.json();
        const entries = Array.isArray(changeLogData.entries) ? changeLogData.entries : [];

        if (entries.length === 0) {
          throw new Error('No change log data found');
        }

        // Filter changes by date range and brand. ASIN match against
        // allProducts is case-insensitive since the catalog and the
        // change log can each have their own casing conventions.
        const changes = entries
          .map(e => ({
            date: e.date,
            product: e.productName,
            asin: e.asin,
            changes: e.changes,
            notes: e.notes
          }))
          .filter(change => {
            if (change.date < startDate || change.date > endDate) return false;
            const target = (change.asin || '').toUpperCase();
            const product = allProducts.find(p => (p.asin || '').toUpperCase() === target);
            return product && selectedBrands.includes(product.brand);
          });
        
        if (changes.length === 0) {
          showFeedback(feedback, 'error', '⚠ No changes found for selected criteria');
          return;
        }
        
        // Calculate metrics for each change
        const exportData = [];
        
        for (const change of changes) {
          const product = allProducts.find(p => p.asin === change.asin);
          if (!product) continue;
          
          const changeDate = new Date(change.date);
          const thirtyDaysBefore = new Date(changeDate);
          thirtyDaysBefore.setDate(thirtyDaysBefore.getDate() - 30);
          
          // Get ASIN data
          const asinData = sessionData.filter(d => d.asin === change.asin);
          
          const beforeData = asinData.filter(d => {
            const date = new Date(d.date);
            return date >= thirtyDaysBefore && date < changeDate;
          });
          
          const afterData = asinData.filter(d => {
            const date = new Date(d.date);
            return date >= changeDate;
          });
          
          // Calculate metrics
          const avgSessionsBefore = beforeData.length > 0 
            ? beforeData.reduce((sum, d) => sum + d.sessions, 0) / beforeData.length 
            : 0;
          const avgSessionsAfter = afterData.length > 0 
            ? afterData.reduce((sum, d) => sum + d.sessions, 0) / afterData.length 
            : 0;
          const sessionsChange = avgSessionsBefore > 0 
            ? ((avgSessionsAfter - avgSessionsBefore) / avgSessionsBefore) * 100 
            : 0;
          
          const avgCVRBefore = beforeData.length > 0 
            ? beforeData.reduce((sum, d) => sum + d.unitSessionPercentage, 0) / beforeData.length 
            : 0;
          const avgCVRAfter = afterData.length > 0 
            ? afterData.reduce((sum, d) => sum + d.unitSessionPercentage, 0) / afterData.length 
            : 0;
          const cvrChange = avgCVRBefore > 0 
            ? ((avgCVRAfter - avgCVRBefore) / avgCVRBefore) * 100 
            : 0;
          
          const avgPageViewsBefore = beforeData.length > 0 
            ? beforeData.reduce((sum, d) => sum + d.pageViews, 0) / beforeData.length 
            : 0;
          const avgPageViewsAfter = afterData.length > 0 
            ? afterData.reduce((sum, d) => sum + d.pageViews, 0) / afterData.length 
            : 0;
          const pageViewsChange = avgPageViewsBefore > 0 
            ? ((avgPageViewsAfter - avgPageViewsBefore) / avgPageViewsBefore) * 100 
            : 0;
          
          exportData.push({
            Date: change.date,
            Brand: product.brand,
            Product: change.product,
            ASIN: change.asin,
            Changes: change.changes,
            'Sessions per day Before (30d)': avgSessionsBefore.toFixed(2),
            'Sessions per day After': avgSessionsAfter.toFixed(2),
            'Sessions per day Change (%)': sessionsChange.toFixed(2),
            'CVR Before (30d) (%)': avgCVRBefore.toFixed(2),
            'CVR After (%)': avgCVRAfter.toFixed(2),
            'CVR Change (%)': cvrChange.toFixed(2),
            'Page Views per day Before (30d)': avgPageViewsBefore.toFixed(2),
            'Page Views per day After': avgPageViewsAfter.toFixed(2),
            'Page Views per day Change (%)': pageViewsChange.toFixed(2)
          });
        }
        
        // Convert to CSV
        const headers = Object.keys(exportData[0]);
        const csvRows = [headers.join(',')];
        
        exportData.forEach(row => {
          const values = headers.map(header => {
            const value = row[header];
            // Escape values with commas
            return typeof value === 'string' && value.includes(',') 
              ? `"${value}"` 
              : value;
          });
          csvRows.push(values.join(','));
        });
        
        const csv = csvRows.join('\n');
        
        // Download CSV
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `change-analysis-${startDate}-to-${endDate}.csv`;
        a.click();
        window.URL.revokeObjectURL(url);
        
        showFeedback(feedback, 'success', `✓ Exported ${exportData.length} changes to CSV`);
        
      } catch (error) {
        console.error('Export error:', error);
        showFeedback(feedback, 'error', '⚠ Export failed: ' + error.message);
      }
    }
    
