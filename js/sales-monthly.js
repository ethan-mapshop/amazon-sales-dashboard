    // Helper function to set date range presets
    
    // Tab switching functions. There are four Overview tabs total — these
    // two Sheets-backed ones plus the Upstash variants in overview-upstash.js
    // — so we hide every view first to handle switching in both directions.
    function showYTD() {
      ['monthly-view', 'ytd-upstash-view', 'monthly-upstash-view'].forEach(id => {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
      });
      document.querySelectorAll('#overview-page .page-header .tabs .tab').forEach(t => t.classList.remove('active'));
      document.getElementById('ytd-view').style.display = 'block';
      document.getElementById('ytd-tab').classList.add('active');
      initializeYearDropdown();
    }

    function showMonthly() {
      ['ytd-view', 'ytd-upstash-view', 'monthly-upstash-view'].forEach(id => {
        const el = document.getElementById(id); if (el) el.style.display = 'none';
      });
      document.querySelectorAll('#overview-page .page-header .tabs .tab').forEach(t => t.classList.remove('active'));
      document.getElementById('monthly-view').style.display = 'block';
      document.getElementById('monthly-tab').classList.add('active');
      initializeMonthlyDropdowns();
    }
    
    // Initialize year dropdown for YTD view
    function initializeYearDropdown() {
      const select = document.getElementById('ytd-year-select');
      if (select.options.length === 0) {
        const currentYear = new Date().getFullYear();
        for (let year = currentYear; year >= currentYear - 5; year--) {
          const option = document.createElement('option');
          option.value = year;
          option.text = year;
          if (year === currentYear) {
            option.selected = true;
          }
          select.appendChild(option);
        }
      }
    }
    
    // Initialize month and year dropdowns for Monthly view
    function initializeMonthlyDropdowns() {
      const yearSelect = document.getElementById('monthly-year-select');
      if (yearSelect.options.length === 0) {
        const currentYear = new Date().getFullYear();
        for (let year = currentYear; year >= currentYear - 5; year--) {
          const option = document.createElement('option');
          option.value = year;
          option.text = year;
          if (year === currentYear) {
            option.selected = true;
          }
          yearSelect.appendChild(option);
        }
      }
      
      // Set to last month
      const now = new Date();
      const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      document.getElementById('monthly-month-select').value = lastMonth.getMonth();
      document.getElementById('monthly-year-select').value = lastMonth.getFullYear();
    }
    
    // YTD preset buttons
    // YTD preset buttons.
    //   thisYear  → current calendar year (absolute)
    //   lastYear  → previous calendar year (absolute)
    //   prevYear  → currently-selected year minus one (relative)
    //   nextYear  → currently-selected year plus one  (relative)
    function setYTDYear(preset) {
      const today = new Date();
      const select = document.getElementById('ytd-year-select');
      const current = parseInt(select.value, 10);

      if (preset === 'lastYear') {
        select.value = today.getFullYear() - 1;
      } else if (preset === 'thisYear') {
        select.value = today.getFullYear();
      } else if (preset === 'prevYear' && Number.isFinite(current)) {
        _setSelectByValue(select, current - 1);
      } else if (preset === 'nextYear' && Number.isFinite(current)) {
        _setSelectByValue(select, current + 1);
      }

      generateYTDReport();
    }

    // Monthly preset buttons.
    //   thisMonth → current calendar month (absolute)
    //   lastMonth → previous calendar month (absolute)
    //   prevMonth → selected month − 1, rolling the year back across Jan
    //   nextMonth → selected month + 1, rolling the year forward across Dec
    function setMonthlyDate(preset) {
      const today = new Date();
      const monthSelect = document.getElementById('monthly-month-select');
      const yearSelect  = document.getElementById('monthly-year-select');
      const curMonth = parseInt(monthSelect.value, 10);
      const curYear  = parseInt(yearSelect.value, 10);

      if (preset === 'lastMonth') {
        const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        monthSelect.value = d.getMonth();
        yearSelect.value  = d.getFullYear();
      } else if (preset === 'thisMonth') {
        monthSelect.value = today.getMonth();
        yearSelect.value  = today.getFullYear();
      } else if (preset === 'prevMonth' && Number.isFinite(curMonth) && Number.isFinite(curYear)) {
        const d = new Date(curYear, curMonth - 1, 1);
        monthSelect.value = d.getMonth();
        _setSelectByValue(yearSelect, d.getFullYear());
      } else if (preset === 'nextMonth' && Number.isFinite(curMonth) && Number.isFinite(curYear)) {
        const d = new Date(curYear, curMonth + 1, 1);
        monthSelect.value = d.getMonth();
        _setSelectByValue(yearSelect, d.getFullYear());
      }

      generateMonthlyReport();
    }

    // Set a <select>'s value to `v`, adding a matching option at the right
    // position if the dropdown doesn't already contain it. Lets prev/next
    // scroll past the pre-seeded year range without silently stalling.
    function _setSelectByValue(select, v) {
      const str = String(v);
      if ([...select.options].some(o => o.value === str)) {
        select.value = str;
        return;
      }
      const opt = document.createElement('option');
      opt.value = str;
      opt.textContent = str;
      // Insert in sorted order (years descending is the existing convention).
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
    
    // Generate YTD report
    async function generateYTDReport() {
      const year = document.getElementById('ytd-year-select').value;
      if (!year) {
        console.error('No year selected');
        return;
      }
      
      const container = document.getElementById('ytd-content');
      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading data...</div>';
      
      try {
        // Calculate YTD date range
        const today = new Date();
        const selectedYear = parseInt(year);
        const isCurrentYear = selectedYear === today.getFullYear();
        
        // For current year: Jan 1 to end of last complete month
        // For past years: Jan 1 to Dec 31
        const startDate = `${year}-01-01`;
        let endDate;
        
        if (isCurrentYear) {
          // Get last complete month (if today is Feb 5, use Jan 31)
          const lastCompleteMonth = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
          const lastCompleteMonthYear = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();
          const endOfLastMonth = new Date(lastCompleteMonthYear, lastCompleteMonth + 1, 0);
          endDate = endOfLastMonth.toISOString().split('T')[0];
        } else {
          endDate = `${year}-12-31`;
        }
        
        // Previous year comparison - same month range
        const prevYear = selectedYear - 1;
        const prevStartDate = `${prevYear}-01-01`;
        let prevEndDate;
        
        if (isCurrentYear) {
          // Same last complete month in previous year
          const lastCompleteMonth = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
          const prevLastCompleteMonthYear = today.getMonth() === 0 ? prevYear - 1 : prevYear;
          const prevEndOfLastMonth = new Date(prevLastCompleteMonthYear, lastCompleteMonth + 1, 0);
          prevEndDate = prevEndOfLastMonth.toISOString().split('T')[0];
        } else {
          prevEndDate = `${prevYear}-12-31`;
        }
        
        // Load both periods
        const [currentData, prevData] = await Promise.all([
          loadOverviewData(startDate, endDate, 'ytd-content', true),
          loadOverviewData(prevStartDate, prevEndDate, 'ytd-content', true)
        ]);
        
        // Calculate YoY comparisons
        const comparisons = calculateYTDComparisons(currentData, prevData);
        
        // Now load current data again but render it with comparisons
        await loadOverviewData(startDate, endDate, 'ytd-content', false, comparisons);
        
      } catch (error) {
        console.error('Error generating YTD report:', error);
        container.innerHTML = `<div style="padding: 4rem; text-align: center; color: var(--error);">Error: ${error.message}</div>`;
      }
    }
    
    // Calculate YTD YoY comparisons
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
    
    // Generate Monthly report
    async function generateMonthlyReport() {
      const month = parseInt(document.getElementById('monthly-month-select').value);
      const year = parseInt(document.getElementById('monthly-year-select').value);
      
      if (isNaN(month) || isNaN(year)) {
        console.error('Invalid month or year');
        return;
      }
      
      const container = document.getElementById('monthly-content');
      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading data...</div>';
      
      try {
        // Current month
        const currentStart = new Date(year, month, 1);
        const currentEnd = new Date(year, month + 1, 0);
        const currentStartStr = currentStart.toISOString().split('T')[0];
        const currentEndStr = currentEnd.toISOString().split('T')[0];
        
        // Previous month (for MoM)
        const prevMonth = month === 0 ? 11 : month - 1;
        const prevYear = month === 0 ? year - 1 : year;
        const prevStart = new Date(prevYear, prevMonth, 1);
        const prevEnd = new Date(prevYear, prevMonth + 1, 0);
        const prevStartStr = prevStart.toISOString().split('T')[0];
        const prevEndStr = prevEnd.toISOString().split('T')[0];
        
        // Same month last year (for YoY)
        const yoyYear = year - 1;
        const yoyStart = new Date(yoyYear, month, 1);
        const yoyEnd = new Date(yoyYear, month + 1, 0);
        const yoyStartStr = yoyStart.toISOString().split('T')[0];
        const yoyEndStr = yoyEnd.toISOString().split('T')[0];
        
        // Load all three periods
        const [currentData, prevData, yoyData] = await Promise.all([
          loadOverviewData(currentStartStr, currentEndStr, 'monthly-content', true),
          loadOverviewData(prevStartStr, prevEndStr, 'monthly-content', true),
          loadOverviewData(yoyStartStr, yoyEndStr, 'monthly-content', true)
        ]);
        
        // Calculate comparisons
        const comparisons = calculateComparisons(currentData, prevData, yoyData);
        
        // Now load current month data again but this time render it with comparisons
        await loadOverviewData(currentStartStr, currentEndStr, 'monthly-content', false, comparisons);
        
      } catch (error) {
        console.error('Error generating monthly report:', error);
        container.innerHTML = `<div style="padding: 4rem; text-align: center; color: var(--error);">Error: ${error.message}</div>`;
      }
    }
    
    // Calculate comparison percentages
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
    
    // HELPER FUNCTIONS FOR FETCHING FROM VERCEL KV API
    
    // Fetch data from Vercel KV via /api/data endpoint
    async function fetchFromKV(type, startDate = null, endDate = null) {
      let url = `/api/data?type=${type}`;
      if (startDate && endDate) {
        url += `&startDate=${startDate}&endDate=${endDate}`;
      }
      
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch ${type} from KV`);
      }
      
      return await response.json();
    }
    
    // Convert KV format (headers + rows arrays) to Google Sheets API format
    function kvToSheetsFormat(kvData) {
      if (!kvData || !kvData.headers || !kvData.rows) {
        return { values: [] };
      }
      return {
        values: [kvData.headers, ...kvData.rows]
      };
    }
    
    // Helper: Find header index case-insensitively
    function findHeaderIndex(headers, searchTerm) {
      const lowerSearch = searchTerm.toLowerCase();
      return headers.findIndex(h => h && h.toLowerCase() === lowerSearch);
    }
    
