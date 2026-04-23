    // Load Overview Data — pulls from Google Sheets directly.
    // TODO: migrate to /api/* endpoints once server-side aggregation is in place.
    const ZERO_METRICS = Object.freeze({
      fbm:   { income: 0, opex: 0, productCosts: 0, adSpend: 0, profit: 0, margin: 0 },
      fba:   { income: 0, opex: 0, productCosts: 0, adSpend: 0, profit: 0, margin: 0 },
      total: { income: 0, opex: 0, productCosts: 0, adSpend: 0, profit: 0, margin: 0 }
    });

    // Normalize the various date formats that appear in the sheets
    // (ISO string, "Dec 1, 2025 12:07 AM PST" text, Excel serial number)
    // down to a YYYY-MM-DD string so they can be max-compared lexically.
    function toIsoDate(raw) {
      if (raw == null || raw === '') return null;
      if (typeof raw === 'number') {
        const adjustedDays = Math.floor(raw) > 59 ? Math.floor(raw) - 1 : Math.floor(raw);
        const d = new Date(Date.UTC(1899, 11, 30) + adjustedDays * 86400000);
        return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
      }
      const s = String(raw);
      if (s.match(/^\d{4}-\d{2}-\d{2}/)) return s.substring(0, 10);
      const textMatch = s.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
      if (textMatch) {
        const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06', jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
        const m = months[textMatch[1].toLowerCase().substring(0, 3)];
        if (m) return `${textMatch[3]}-${m}-${textMatch[2].padStart(2, '0')}`;
      }
      return null;
    }

    function findLatestSheetDate(values, dateHeaderName) {
      if (!values || values.length < 2) return null;
      const headers = values[0].map(h => String(h).toLowerCase());
      const idx = headers.indexOf(dateHeaderName.toLowerCase());
      if (idx === -1) return null;
      let max = '';
      for (let i = 1; i < values.length; i++) {
        const iso = toIsoDate(values[i][idx]);
        if (iso && iso > max) max = iso;
      }
      return max || null;
    }

    function updateOverviewDataBlurb(transactionsData, productAdsData) {
      const txEl = document.getElementById('overview-latest-transaction');
      const adEl = document.getElementById('overview-latest-adspend');
      if (txEl) txEl.textContent = findLatestSheetDate(transactionsData?.values, 'date/time') || '—';
      if (adEl) adEl.textContent = findLatestSheetDate(productAdsData?.values, 'date') || '—';
    }

    // Fetches every Sheets tab the Profitability Overview consumes and returns
    // a bundle in the same shape the Google Sheets API produces
    // ({ values: [[header], ...rows] }). Extracted so the Upstash variant in
    // overview-upstash.js can substitute its own fetcher that produces the
    // same bundle shape from KV-backed endpoints — keeping the downstream
    // parsing + categorization + render code path identical between the two.
    async function _fetchOverviewInputsFromSheets() {
      const sheet = (name) => fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${name}`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );

      const [transactionsRes, productsRes, productAdsRes, brandAdsRes, shippingRes, productMappingRes, brandMappingRes] = await Promise.all([
        sheet('Transactions'),
        sheet('Products'),
        sheet('ProductAdSpend'),
        sheet('BrandAdSpend'),
        sheet('ShippingCosts'),
        sheet('ProductAdMapping'),
        sheet('BrandAdMapping')
      ]);

      if (!transactionsRes.ok) throw new Error('Failed to load Transactions');
      if (!productsRes.ok) throw new Error('Failed to load Products');

      const transactionsData   = await transactionsRes.json();
      const productsData       = await productsRes.json();
      const productAdsData     = productAdsRes.ok     ? await productAdsRes.json()     : { values: [] };
      const brandAdsData       = brandAdsRes.ok       ? await brandAdsRes.json()       : { values: [] };
      const shippingData       = shippingRes.ok       ? await shippingRes.json()       : { values: [] };
      const productMappingData = productMappingRes.ok ? await productMappingRes.json() : { values: [] };
      const brandMappingData   = brandMappingRes.ok   ? await brandMappingRes.json()   : { values: [] };

      return {
        transactionsData, productsData, productAdsData, brandAdsData,
        shippingData, productMappingData, brandMappingData
      };
    }

    async function loadOverviewData(startDate, endDate, containerId = 'overview-content', returnData = false, comparisons = null, providedInputs = null) {
      if (!accessToken) {
        alert('Please sign in first');
        return;
      }

      if (!startDate || !endDate) {
        alert('Please select a date range');
        return;
      }

      console.log('Loading data for container:', containerId);
      const container = document.getElementById(containerId);
      if (!container) {
        console.error('Container not found:', containerId);
        alert('Error: Container not found. Please refresh the page.');
        return;
      }

      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading data...</div>';

      try {
        // providedInputs lets overview-upstash.js reuse this function with
        // inputs it fetched from /api/* endpoints instead of Sheets. When
        // called directly (no providedInputs), pull from Sheets as before.
        const inputs = providedInputs || await _fetchOverviewInputsFromSheets();
        const { transactionsData, productsData, productAdsData, brandAdsData, shippingData, productMappingData, brandMappingData } = inputs;

        updateOverviewDataBlurb(transactionsData, productAdsData);
        
        const transactionsRows = transactionsData.values || [];
        
        if (transactionsRows.length <= 1) {
          if (returnData) return ZERO_METRICS;
          container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">No transaction data available</div>';
          return;
        }
        
        // Parse transactions
        const transactionsHeaders = transactionsRows[0];
        const transactions = [];
        
        for (let i = 1; i < transactionsRows.length; i++) {
          const transaction = {};
          transactionsHeaders.forEach((header, index) => {
            transaction[header] = transactionsRows[i][index] || '';
          });
          transactions.push(transaction);
        }
        
        // Parse products (for costs and brand mappings)
        const productCosts = {};
        const skuToBrand = {};
        const brandToSkus = {};
        
        // productsData already parsed above at line 3571
        const productsRows = productsData.values || [];
        if (productsRows.length > 1) {
          const productsHeaders = productsRows[0];
          const skuIndex = findHeaderIndex(productsHeaders, 'sku');
          const costIndex = findHeaderIndex(productsHeaders, 'cost');
          const brandIndex = findHeaderIndex(productsHeaders, 'brand');
            
            for (let i = 1; i < productsRows.length; i++) {
              const sku = productsRows[i][skuIndex];
              const cost = parseFloat(productsRows[i][costIndex]) || 0;
              const brand = productsRows[i][brandIndex];
              
              // Store cost
              if (sku) productCosts[sku] = cost;
              
              // Store brand mappings
              if (sku && brand) {
                skuToBrand[sku] = brand;
                
                if (!brandToSkus[brand]) {
                  brandToSkus[brand] = [];
                }
                brandToSkus[brand].push(sku);
              }
            }
          }
        
        // Mappings are now part of the inputs bundle (either pre-fetched from
        // Sheets or supplied by the Upstash loader). Parse them out of the
        // bundle in the same shape the downstream ad-spend allocator expects.
        const productCampaignToSkus = {};
        const productMappingRows = productMappingData.values || [];
        if (productMappingRows.length > 1) {
          const headers = productMappingRows[0];
          const campaignIndex = headers.indexOf('Campaign Name');
          const skuIndex = headers.indexOf('SKU');
          for (let i = 1; i < productMappingRows.length; i++) {
            const campaign = productMappingRows[i][campaignIndex];
            const sku = productMappingRows[i][skuIndex];
            if (campaign && sku) {
              if (!productCampaignToSkus[campaign]) productCampaignToSkus[campaign] = [];
              productCampaignToSkus[campaign].push(sku);
            }
          }
        }

        const brandCampaignToBrand = {};
        const brandMappingRows = brandMappingData.values || [];
        if (brandMappingRows.length > 1) {
          const headers = brandMappingRows[0];
          const campaignIndex = headers.indexOf('Campaign Name');
          const brandIndex = headers.indexOf('Brand');
          for (let i = 1; i < brandMappingRows.length; i++) {
            const campaign = brandMappingRows[i][campaignIndex];
            const brand = brandMappingRows[i][brandIndex];
            if (campaign && brand) brandCampaignToBrand[campaign] = brand;
          }
        }
        
        // Calculate FBA/FBM sales by SKU from filtered transactions
        const skuSales = {}; // { sku: { fba: amount, fbm: amount } }
        
        const reportStart = new Date(startDate);
        const reportEnd = new Date(endDate);
        
        transactions.forEach(t => {
          const transDate = new Date(t[transactionsHeaders.find(h => h.includes('date'))]);
          if (transDate >= reportStart && transDate <= reportEnd) {
            const type = (t.type || '').trim();
            const sku = t.sku || '';
            const fulfillment = (t.fulfillment || '').trim();
            const productSales = parseFloat(t['product sales'] || 0);
            
            if (type === 'Order' && sku && productSales > 0) {
              if (!skuSales[sku]) {
                skuSales[sku] = { fba: 0, fbm: 0 };
              }
              
              if (fulfillment === 'Amazon') {
                skuSales[sku].fba += productSales;
              } else if (fulfillment === 'Seller') {
                skuSales[sku].fbm += productSales;
              }
            }
          }
        });
        
        // Parse ad spend data with FBA/FBM allocation
        let fbaAdSpend = 0;
        let fbmAdSpend = 0;
        let unallocatedAdSpend = 0;
        const unallocatedProductCampaigns = {}; // Track which campaigns are unallocated
        const unallocatedBrandCampaigns = {}; // Track which campaigns are unallocated
        
        // Product ads (already loaded from KV)
        const productAdsRows = productAdsData.values || [];
        if (productAdsRows.length > 1) {
          const adsHeaders = productAdsRows[0];
          const dateIndex = findHeaderIndex(adsHeaders, 'Date');
          const campaignIndex = findHeaderIndex(adsHeaders, 'Campaign Name');
          const spendIndex = findHeaderIndex(adsHeaders, 'Spend');
            
            for (let i = 1; i < productAdsRows.length; i++) {
              const adDate = new Date(productAdsRows[i][dateIndex]);
              const campaign = productAdsRows[i][campaignIndex];
              const spend = parseFloat(productAdsRows[i][spendIndex]) || 0;
              
              if (adDate >= reportStart && adDate <= reportEnd && spend > 0) {
                // Get SKUs for this campaign
                const campaignSkus = productCampaignToSkus[campaign] || [];
                
                if (campaignSkus.length === 0) {
                  // No mapping - unallocated
                  unallocatedAdSpend += spend;
                  if (!unallocatedProductCampaigns[campaign || '(blank)']) {
                    unallocatedProductCampaigns[campaign || '(blank)'] = 0;
                  }
                  unallocatedProductCampaigns[campaign || '(blank)'] += spend;
                } else {
                  // Calculate FBA/FBM split based on sales
                  let totalFba = 0;
                  let totalFbm = 0;
                  
                  campaignSkus.forEach(sku => {
                    if (skuSales[sku]) {
                      totalFba += skuSales[sku].fba;
                      totalFbm += skuSales[sku].fbm;
                    }
                  });
                  
                  const totalSales = totalFba + totalFbm;
                  
                  if (totalSales === 0) {
                    // Campaign has mapping but no sales - unallocated
                    unallocatedAdSpend += spend;
                    if (!unallocatedProductCampaigns[campaign || '(blank)']) {
                      unallocatedProductCampaigns[campaign || '(blank)'] = 0;
                    }
                    unallocatedProductCampaigns[campaign || '(blank)'] += spend;
                  } else {
                    // Allocate proportionally
                    const fbaPercent = totalFba / totalSales;
                    const fbmPercent = totalFbm / totalSales;
                    
                    fbaAdSpend += spend * fbaPercent;
                    fbmAdSpend += spend * fbmPercent;
                  }
                }
              }
            }
        } // End productAds parsing
        
        // Brand ads (already loaded from KV)
        const brandAdsRows = brandAdsData.values || [];
        if (brandAdsRows.length > 1) {
          const adsHeaders = brandAdsRows[0];
          const dateIndex = findHeaderIndex(adsHeaders, 'Date');
          const campaignIndex = findHeaderIndex(adsHeaders, 'Campaign Name');
          const spendIndex = findHeaderIndex(adsHeaders, 'Spend');
            
            for (let i = 1; i < brandAdsRows.length; i++) {
              const adDate = new Date(brandAdsRows[i][dateIndex]);
              const campaign = brandAdsRows[i][campaignIndex];
              const spend = parseFloat(brandAdsRows[i][spendIndex]) || 0;
              
              if (adDate >= reportStart && adDate <= reportEnd && spend > 0) {
                // Get brand for this campaign
                const brand = brandCampaignToBrand[campaign];
                
                if (!brand) {
                  // No mapping - unallocated
                  unallocatedAdSpend += spend;
                  if (!unallocatedBrandCampaigns[campaign || '(blank)']) {
                    unallocatedBrandCampaigns[campaign || '(blank)'] = 0;
                  }
                  unallocatedBrandCampaigns[campaign || '(blank)'] += spend;
                } else {
                  // Get all SKUs for this brand
                  const brandSkus = brandToSkus[brand] || [];
                  
                  if (brandSkus.length === 0) {
                    // Brand has no SKUs - unallocated
                    unallocatedAdSpend += spend;
                    if (!unallocatedBrandCampaigns[campaign || '(blank)']) {
                      unallocatedBrandCampaigns[campaign || '(blank)'] = 0;
                    }
                    unallocatedBrandCampaigns[campaign || '(blank)'] += spend;
                  } else {
                    // Calculate FBA/FBM split based on sales across all brand SKUs
                    let totalFba = 0;
                    let totalFbm = 0;
                    
                    brandSkus.forEach(sku => {
                      if (skuSales[sku]) {
                        totalFba += skuSales[sku].fba;
                        totalFbm += skuSales[sku].fbm;
                      }
                    });
                    
                    const totalSales = totalFba + totalFbm;
                    
                    if (totalSales === 0) {
                      // Brand has SKUs but no sales - unallocated
                      unallocatedAdSpend += spend;
                      if (!unallocatedBrandCampaigns[campaign || '(blank)']) {
                        unallocatedBrandCampaigns[campaign || '(blank)'] = 0;
                      }
                      unallocatedBrandCampaigns[campaign || '(blank)'] += spend;
                    } else {
                      // Allocate proportionally
                      const fbaPercent = totalFba / totalSales;
                      const fbmPercent = totalFbm / totalSales;
                      
                      fbaAdSpend += spend * fbaPercent;
                      fbmAdSpend += spend * fbmPercent;
                    }
                  }
                }
              }
            }
        }
        
        console.log('Ad Spend Allocation:', {
          FBA: fbaAdSpend.toFixed(2),
          FBM: fbmAdSpend.toFixed(2),
          Unallocated: unallocatedAdSpend.toFixed(2),
          Total: (fbaAdSpend + fbmAdSpend + unallocatedAdSpend).toFixed(2)
        });
        
        // Log detailed breakdown of unallocated campaigns
        if (unallocatedAdSpend > 0) {
          console.log('\n=== UNALLOCATED AD SPEND BREAKDOWN ===');
          
          const productCampaignCount = Object.keys(unallocatedProductCampaigns).length;
          const brandCampaignCount = Object.keys(unallocatedBrandCampaigns).length;
          
          if (productCampaignCount > 0) {
            console.log('\nProduct Campaigns (no mapping or no sales):');
            Object.entries(unallocatedProductCampaigns)
              .sort((a, b) => b[1] - a[1]) // Sort by spend descending
              .forEach(([campaign, spend]) => {
                console.log(`  - ${campaign}: $${spend.toFixed(2)}`);
              });
          }
          
          if (brandCampaignCount > 0) {
            console.log('\nBrand Campaigns (no mapping or no sales):');
            Object.entries(unallocatedBrandCampaigns)
              .sort((a, b) => b[1] - a[1]) // Sort by spend descending
              .forEach(([campaign, spend]) => {
                console.log(`  - ${campaign}: $${spend.toFixed(2)}`);
              });
          }
          
          console.log(`\nTotal Unallocated: $${unallocatedAdSpend.toFixed(2)}`);
          console.log('=====================================\n');
        }
        
        // Parse shipping costs data
        let totalShippingCosts = 0;
        
        // Shipping costs (already loaded from KV)
        const shippingRows = shippingData.values || [];
        if (shippingRows.length > 1) {
          const shippingHeaders = shippingRows[0];
          const shipDateIndex = findHeaderIndex(shippingHeaders, 'Ship Date');
          const shippingCostIndex = findHeaderIndex(shippingHeaders, 'Shipping Cost');
            
            for (let i = 1; i < shippingRows.length; i++) {
              const shipDate = new Date(shippingRows[i][shipDateIndex]);
              const shippingCost = parseFloat(shippingRows[i][shippingCostIndex]) || 0;
              
              // Check if ship date is within report period
              const reportStart = new Date(startDate);
              const reportEnd = new Date(endDate);
              
              if (shipDate >= reportStart && shipDate <= reportEnd) {
                totalShippingCosts += shippingCost;
              }
            }
          }
        
        // Filter transactions by date range
        const dateColumn = transactionsHeaders.find(h => h.includes('date')) || transactionsHeaders[0];
        
        const filtered = transactions.filter(t => {
          const transDate = t[dateColumn];
          if (!transDate) return false;
          
          // Dates are now in ISO format (YYYY-MM-DD), can compare as strings
          // But to be safe, convert to Date objects for proper comparison
          const tDate = new Date(transDate + 'T00:00:00');
          if (isNaN(tDate.getTime())) return false;
          
          const sDate = new Date(startDate + 'T00:00:00');
          const eDate = new Date(endDate + 'T23:59:59');
          
          return tDate >= sDate && tDate <= eDate;
        });
        
        // Calculate financial statement with product costs, ad spend, and shipping costs
        const statement = calculateFinancialStatement(filtered, productCosts, fbaAdSpend, fbmAdSpend, unallocatedAdSpend, totalShippingCosts);
        
        // If returnData is true, return profitability metrics instead of rendering
        if (returnData) {
          return extractProfitabilityMetrics(statement);
        }
        
        // Render the report
        renderFinancialStatement(statement, startDate, endDate, container, comparisons);
        
      } catch (error) {
        console.error('Error loading overview:', error);
        if (returnData) return ZERO_METRICS;
        container.innerHTML = `<div style="padding: 4rem; text-align: center; color: var(--error);">Error: ${error.message}</div>`;
      }
    }
    
    
    // ============================================
    // BRAND & PRODUCT PROFITABILITY FUNCTIONS
    // ============================================
    
    // Tab switching for Brand & Product page
    function showBPYTD() {
      document.getElementById('bp-ytd-view').style.display = 'block';
      document.getElementById('bp-monthly-view').style.display = 'none';
      document.getElementById('bp-ytd-tab').classList.add('active');
      document.getElementById('bp-monthly-tab').classList.remove('active');
      
      initializeBPYTDDropdowns();
    }
    
    function showBPMonthly() {
      document.getElementById('bp-ytd-view').style.display = 'none';
      document.getElementById('bp-monthly-view').style.display = 'block';
      document.getElementById('bp-ytd-tab').classList.remove('active');
      document.getElementById('bp-monthly-tab').classList.add('active');
      
      initializeBPMonthlyDropdowns();
    }
    
    // Initialize dropdowns for BP YTD
    async function initializeBPYTDDropdowns() {
      // Initialize year dropdown
      const yearSelect = document.getElementById('bp-ytd-year-select');
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
      
      // Initialize brand dropdown
      await initializeBrandDropdown('bp-ytd-brand-select');
    }
    
    // Initialize dropdowns for BP Monthly
    async function initializeBPMonthlyDropdowns() {
      // Initialize year dropdown
      const yearSelect = document.getElementById('bp-monthly-year-select');
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
      document.getElementById('bp-monthly-month-select').value = lastMonth.getMonth();
      document.getElementById('bp-monthly-year-select').value = lastMonth.getFullYear();
      
      // Initialize brand dropdown
      await initializeBrandDropdown('bp-monthly-brand-select');
    }
    
    // Initialize brand dropdown from Products sheet
    async function initializeBrandDropdown(selectId) {
      if (!accessToken) return;
      
      const select = document.getElementById(selectId);
      if (select.options.length > 1) return; // Already initialized
      
      try {
        const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Products`, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        
        if (!response.ok) return;
        
        const data = await response.json();
        const rows = data.values || [];
        if (rows.length < 2) return;
        
        const headers = rows[0];
        const brandIdx = headers.findIndex(h => h.toLowerCase() === 'brand');
        
        if (brandIdx === -1) return;
        
        // Get unique brands
        const brands = new Set();
        for (let i = 1; i < rows.length; i++) {
          const brand = rows[i][brandIdx];
          if (brand && brand.trim()) {
            brands.add(brand.trim());
          }
        }
        
        // Add brand options
        const sortedBrands = Array.from(brands).sort();
        sortedBrands.forEach(brand => {
          const option = document.createElement('option');
          option.value = brand;
          option.text = brand;
          select.appendChild(option);
        });
      } catch (error) {
        console.error('Error loading brands:', error);
      }
    }
    
    // Quick date setters for BP YTD
    function setBPYTDYear(preset) {
      const yearSelect = document.getElementById('bp-ytd-year-select');
      const currentYear = new Date().getFullYear();
      
      if (preset === 'thisYear') {
        yearSelect.value = currentYear;
      } else if (preset === 'lastYear') {
        yearSelect.value = currentYear - 1;
      }
      
      generateBPYTDReport();
    }
    
    // Quick date setters for BP Monthly
    function setBPMonthlyDate(preset) {
      const monthSelect = document.getElementById('bp-monthly-month-select');
      const yearSelect = document.getElementById('bp-monthly-year-select');
      const now = new Date();
      
      if (preset === 'thisMonth') {
        monthSelect.value = now.getMonth();
        yearSelect.value = now.getFullYear();
      } else if (preset === 'lastMonth') {
        const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        monthSelect.value = lastMonth.getMonth();
        yearSelect.value = lastMonth.getFullYear();
      }
      
      generateBPMonthlyReport();
    }
    
    // Generate BP YTD Report
    async function generateBPYTDReport() {
      const year = parseInt(document.getElementById('bp-ytd-year-select').value);
      const brandFilter = document.getElementById('bp-ytd-brand-select').value;
      
      if (isNaN(year)) {
        console.error('Invalid year');
        return;
      }
      
      const container = document.getElementById('bp-ytd-content');
      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading data...</div>';
      
      try {
        const today = new Date();
        const currentYear = today.getFullYear();
        const isCurrentYear = year === currentYear;
        
        let startDate = `${year}-01-01`;
        let endDate;
        
        if (isCurrentYear) {
          // End at last complete month
          const lastCompleteMonth = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
          const lastCompleteMonthYear = today.getMonth() === 0 ? year - 1 : year;
          const endOfLastMonth = new Date(lastCompleteMonthYear, lastCompleteMonth + 1, 0);
          endDate = endOfLastMonth.toISOString().split('T')[0];
        } else {
          endDate = `${year}-12-31`;
        }
        
        // Load brand/product data
        const brandProductData = await loadBrandProductData(startDate, endDate, brandFilter);
        
        // Render the table
        renderBrandProductTable(brandProductData, 'bp-ytd-content');
        
      } catch (error) {
        console.error('Error generating BP YTD report:', error);
        container.innerHTML = `<div style="padding: 4rem; text-align: center; color: var(--error);">Error: ${error.message}</div>`;
      }
    }
    
    // Generate BP Monthly Report
    async function generateBPMonthlyReport() {
      const month = parseInt(document.getElementById('bp-monthly-month-select').value);
      const year = parseInt(document.getElementById('bp-monthly-year-select').value);
      const brandFilter = document.getElementById('bp-monthly-brand-select').value;
      
      if (isNaN(month) || isNaN(year)) {
        console.error('Invalid month or year');
        return;
      }
      
      const container = document.getElementById('bp-monthly-content');
      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading data...</div>';
      
      try {
        const startDate = new Date(year, month, 1).toISOString().split('T')[0];
        const endDate = new Date(year, month + 1, 0).toISOString().split('T')[0];
        
        // Load brand/product data
        const brandProductData = await loadBrandProductData(startDate, endDate, brandFilter);
        
        // Render the table
        renderBrandProductTable(brandProductData, 'bp-monthly-content');
        
      } catch (error) {
        console.error('Error generating BP monthly report:', error);
        container.innerHTML = `<div style="padding: 4rem; text-align: center; color: var(--error);">Error: ${error.message}</div>`;
      }
    }
    
    // ============================================
    // PARSE HELPER FUNCTIONS (shared utilities)
    // ============================================
    
    function parseProducts(productsData) {
      const products = [];
      const rows = productsData.values || [];
      
      if (rows.length < 2) return products;
      
      const headers = rows[0].map(h => h.toLowerCase());
      const skuIdx = headers.indexOf('sku');
      const nameIdx = headers.indexOf('name');
      const brandIdx = headers.indexOf('brand');
      const costIdx = headers.indexOf('cost');
      const fulfillmentIdx = headers.indexOf('fulfillment');
      
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row[skuIdx]) continue;
        
        products.push({
          sku: row[skuIdx],
          name: row[nameIdx] || '',
          brand: row[brandIdx] || '',
          cost: parseFloat(row[costIdx]) || 0,
          fulfillmentType: row[fulfillmentIdx] || 'FBM'
        });
      }
      
      return products;
    }
    
    function parseTransactions(transactionsData) {
      const transactions = [];
      const rows = transactionsData.values || [];
      
      if (rows.length < 2) return transactions;
      
      const headers = rows[0].map(h => h.toLowerCase());
      const dateIdx = headers.indexOf('date/time');
      const typeIdx = headers.indexOf('type');
      const orderIdIdx = headers.indexOf('order id');
      const skuIdx = headers.indexOf('sku');
      const descriptionIdx = headers.indexOf('description');
      const quantityIdx = headers.indexOf('quantity');
      const fulfillmentIdx = headers.indexOf('fulfillment');
      const productSalesIdx = headers.indexOf('product sales');
      const shippingCreditsIdx = headers.indexOf('shipping credits');
      const giftWrapIdx = headers.indexOf('gift wrap credits');
      const promoIdx = headers.indexOf('promotional rebates');
      const sellingFeesIdx = headers.indexOf('selling fees');
      const fbaFeesIdx = headers.indexOf('fba fees');
      const otherIdx = headers.indexOf('other');
      const totalIdx = headers.indexOf('total');
      
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const dateStr = row[dateIdx];
        
        if (!dateStr) continue;
        
        // Parse date - handle multiple formats
        let date = null;
        
        // Format 1: YYYY-MM-DD (already ISO format)
        if (dateStr.match(/^\d{4}-\d{2}-\d{2}/)) {
          date = dateStr.substring(0, 10); // Take first 10 chars (YYYY-MM-DD)
        }
        // Format 2: "Dec 1, 2025 12:07:15 AM PST"
        else {
          const textMatch = dateStr.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
          if (textMatch) {
            const monthStr = textMatch[1];
            const day = textMatch[2].padStart(2, '0');
            const year = textMatch[3];
            
            const months = {
              'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
              'may': '05', 'jun': '06', 'jul': '07', 'aug': '08',
              'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12'
            };
            
            const month = months[monthStr.toLowerCase().substring(0, 3)];
            if (month) {
              date = `${year}-${month}-${day}`;
            }
          }
        }
        
        if (!date) continue;
        
        transactions.push({
          date: date,
          type: row[typeIdx] || '',
          orderId: row[orderIdIdx] || '',
          sku: row[skuIdx] || '',
          description: row[descriptionIdx] || '',
          quantity: parseFloat(row[quantityIdx]) || 1,
          fulfillment: row[fulfillmentIdx] || '',
          'product sales': parseFloat(row[productSalesIdx]) || 0,
          'shipping credits': parseFloat(row[shippingCreditsIdx]) || 0,
          'gift wrap credits': parseFloat(row[giftWrapIdx]) || 0,
          'promotional rebates': parseFloat(row[promoIdx]) || 0,
          'selling fees': parseFloat(row[sellingFeesIdx]) || 0,
          'fba fees': parseFloat(row[fbaFeesIdx]) || 0,
          other: parseFloat(row[otherIdx]) || 0,
          amount: parseFloat(row[totalIdx]) || 0
        });
      }
      
      return transactions;
    }
    
    function parseProductAds(productAdsData) {
      const ads = [];
      const rows = productAdsData.values || [];
      
      if (rows.length < 2) return ads;
      
      const headers = rows[0].map(h => h.toLowerCase());
      const dateIdx = headers.indexOf('date');
      const campaignIdx = headers.indexOf('campaign name');
      const spendIdx = headers.indexOf('spend');
      
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const dateStr = row[dateIdx];
        
        if (!dateStr || !row[campaignIdx]) continue; // Need campaign name for mapping
        
        // Parse date (handle Excel serial or ISO format)
        let date = null;
        if (typeof dateStr === 'number') {
          // Excel serial date — epoch is Dec 31, 1899 (serial 1 = 1900-01-01).
          // Subtract one for serials past 59 to skip Excel's phantom Feb 29, 1900.
          const days = Math.floor(dateStr);
          const adjustedDays = days > 59 ? days - 1 : days;
          const epochDate = Date.UTC(1899, 11, 31);
          const millisecondsPerDay = 24 * 60 * 60 * 1000;
          const targetTime = epochDate + (adjustedDays * millisecondsPerDay);
          const d = new Date(targetTime);
          const year = d.getUTCFullYear();
          const month = String(d.getUTCMonth() + 1).padStart(2, '0');
          const day = String(d.getUTCDate()).padStart(2, '0');
          date = `${year}-${month}-${day}`;
        } else {
          date = dateStr.split('T')[0]; // ISO format
        }
        
        if (!date) continue;
        
        ads.push({
          date: date,
          campaign: row[campaignIdx] || '',
          spend: parseFloat(row[spendIdx]) || 0
        });
      }
      
      return ads;
    }
    
    function parseBrandAds(brandAdsData) {
      const ads = [];
      const rows = brandAdsData.values || [];
      
      if (rows.length < 2) return ads;
      
      const headers = rows[0].map(h => h.toLowerCase());
      const dateIdx = headers.indexOf('date');
      const campaignIdx = headers.indexOf('campaign name');
      const spendIdx = headers.indexOf('spend');
      
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const dateStr = row[dateIdx];
        
        if (!dateStr || !row[campaignIdx]) continue; // Need campaign name for mapping
        
        // Parse date (handle Excel serial or ISO format)
        let date = null;
        if (typeof dateStr === 'number') {
          // Excel serial date — epoch is Dec 31, 1899 (serial 1 = 1900-01-01).
          // Subtract one for serials past 59 to skip Excel's phantom Feb 29, 1900.
          const days = Math.floor(dateStr);
          const adjustedDays = days > 59 ? days - 1 : days;
          const epochDate = Date.UTC(1899, 11, 31);
          const millisecondsPerDay = 24 * 60 * 60 * 1000;
          const targetTime = epochDate + (adjustedDays * millisecondsPerDay);
          const d = new Date(targetTime);
          const year = d.getUTCFullYear();
          const month = String(d.getUTCMonth() + 1).padStart(2, '0');
          const day = String(d.getUTCDate()).padStart(2, '0');
          date = `${year}-${month}-${day}`;
        } else {
          date = dateStr.split('T')[0]; // ISO format
        }
        
        if (!date) continue;
        
        ads.push({
          date: date,
          campaign: row[campaignIdx] || '',
          spend: parseFloat(row[spendIdx]) || 0
        });
      }
      
      return ads;
    }
    
    function parseShippingCosts(shippingData) {
      const costs = [];
      const rows = shippingData.values || [];
      
      if (rows.length < 2) return costs;
      
      const headers = rows[0].map(h => h.toLowerCase());
      const dateIdx = headers.indexOf('date');
      const skuIdx = headers.indexOf('sku');
      const costIdx = headers.indexOf('cost');
      
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        const dateStr = row[dateIdx];
        
        if (!dateStr || !row[skuIdx]) continue;
        
        // Parse date (handle Excel serial or ISO format)
        let date = null;
        if (typeof dateStr === 'number') {
          // Excel serial date — epoch is Dec 31, 1899 (serial 1 = 1900-01-01).
          // Subtract one for serials past 59 to skip Excel's phantom Feb 29, 1900.
          const days = Math.floor(dateStr);
          const adjustedDays = days > 59 ? days - 1 : days;
          const epochDate = Date.UTC(1899, 11, 31);
          const millisecondsPerDay = 24 * 60 * 60 * 1000;
          const targetTime = epochDate + (adjustedDays * millisecondsPerDay);
          const d = new Date(targetTime);
          const year = d.getUTCFullYear();
          const month = String(d.getUTCMonth() + 1).padStart(2, '0');
          const day = String(d.getUTCDate()).padStart(2, '0');
          date = `${year}-${month}-${day}`;
        } else {
          date = dateStr.split('T')[0]; // ISO format
        }
        
        if (!date) continue;
        
        costs.push({
          date: date,
          sku: row[skuIdx],
          cost: parseFloat(row[costIdx]) || 0
        });
      }
      
      return costs;
    }
    
    // Load and calculate brand/product data
    async function loadBrandProductData(startDate, endDate, brandFilter) {
      if (!accessToken) {
        throw new Error('Please sign in first');
      }
      
      const sheet = (name) => fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/${name}`,
        { headers: { 'Authorization': `Bearer ${accessToken}` } }
      );

      const [transactionsRes, shippingRes, productAdsRes, brandAdsRes, productsRes, productMappingRes, brandMappingRes] = await Promise.all([
        sheet('Transactions'),
        sheet('ShippingCosts'),
        sheet('ProductAdSpend'),
        sheet('BrandAdSpend'),
        sheet('Products'),
        sheet('ProductAdMapping'),
        sheet('BrandAdMapping')
      ]);

      if (!transactionsRes.ok) throw new Error('Failed to load Transactions');
      if (!productsRes.ok) throw new Error('Failed to load Products');

      const transactionsData = await transactionsRes.json();
      const productsData     = await productsRes.json();
      const shippingData     = shippingRes.ok       ? await shippingRes.json()       : { values: [] };
      const productAdsData   = productAdsRes.ok     ? await productAdsRes.json()     : { values: [] };
      const brandAdsData     = brandAdsRes.ok       ? await brandAdsRes.json()       : { values: [] };
      const productMappingData = productMappingRes.ok ? await productMappingRes.json() : { values: [] };
      const brandMappingData   = brandMappingRes.ok   ? await brandMappingRes.json()   : { values: [] };
      
      // Parse product ad mapping (Campaign Name -> SKUs)
      const productCampaignToSkus = {};
      if (productMappingData.values && productMappingData.values.length > 1) {
        const headers = productMappingData.values[0].map(h => h.toLowerCase());
        const campaignIdx = headers.indexOf('campaign name');
        const skuIdx = headers.indexOf('sku');
        
        for (let i = 1; i < productMappingData.values.length; i++) {
          const row = productMappingData.values[i];
          const campaign = row[campaignIdx];
          const sku = row[skuIdx];
          
          if (campaign && sku) {
            if (!productCampaignToSkus[campaign]) {
              productCampaignToSkus[campaign] = [];
            }
            productCampaignToSkus[campaign].push(sku);
          }
        }
      }
      
      // Parse brand ad mapping (Campaign Name -> Brand)
      const brandCampaignToBrand = {};
      if (brandMappingData.values && brandMappingData.values.length > 1) {
        const headers = brandMappingData.values[0].map(h => h.toLowerCase());
        const campaignIdx = headers.indexOf('campaign name');
        const brandIdx = headers.indexOf('brand');
        
        for (let i = 1; i < brandMappingData.values.length; i++) {
          const row = brandMappingData.values[i];
          const campaign = row[campaignIdx];
          const brand = row[brandIdx];
          
          if (campaign && brand) {
            brandCampaignToBrand[campaign] = brand;
          }
        }
      }
      
      console.log('BP: Product campaign mappings:', Object.keys(productCampaignToSkus).length);
      console.log('BP: Brand campaign mappings:', Object.keys(brandCampaignToBrand).length);
      
      // Debug: Show raw transaction data
      if (transactionsData.values && transactionsData.values.length > 1) {
        console.log('BP: Raw transaction sample:', transactionsData.values[1]);
      }
      
      // Parse products
      const products = parseProducts(productsData);
      console.log('BP: Parsed products:', products.length);
      if (products.length > 0) console.log('BP: Sample product:', products[0]);
      
      // Parse transactions and filter by date
      const allTransactions = parseTransactions(transactionsData);
      console.log('BP: Total transactions parsed:', allTransactions.length);
      if (allTransactions.length > 0) {
        const dates = allTransactions.map(t => t.date).filter(d => d).sort();
        console.log('BP: Transaction date range:', dates[0], 'to', dates[dates.length - 1]);
      }
      
      const transactions = allTransactions.filter(t => 
        t.date >= startDate && t.date <= endDate
      );
      console.log('BP: Filtered transactions:', transactions.length, 'between', startDate, 'and', endDate);
      if (transactions.length > 0) console.log('BP: Sample transaction:', transactions[0]);
      // Parse ad spend
      const productAds = parseProductAds(productAdsData).filter(a => 
        a.date >= startDate && a.date <= endDate
      );
      const brandAds = parseBrandAds(brandAdsData).filter(a => 
        a.date >= startDate && a.date <= endDate
      );
      
      // Parse shipping costs
      const shippingCosts = parseShippingCosts(shippingData).filter(s => 
        s.date >= startDate && s.date <= endDate
      );
      
      // Build brand/product structure
      const brandData = {};
      
      // Group products by brand
      products.forEach(product => {
        if (brandFilter !== 'all' && product.brand !== brandFilter) return;
        
        if (!brandData[product.brand]) {
          brandData[product.brand] = {
            brandName: product.brand,
            products: []
          };
        }
        
        // Find existing product (by name, since FBA/FBM versions have same name)
        let existingProduct = brandData[product.brand].products.find(p => p.productName === product.name);
        
        if (!existingProduct) {
          existingProduct = {
            productName: product.name,
            skus: [],
            fbm: { income: 0, opex: 0, productCosts: 0, adSpend: 0, profit: 0, margin: 0 },
            fba: { income: 0, opex: 0, productCosts: 0, adSpend: 0, profit: 0, margin: 0 },
            total: { income: 0, opex: 0, productCosts: 0, adSpend: 0, profit: 0, margin: 0 }
          };
          brandData[product.brand].products.push(existingProduct);
        }
        
        existingProduct.skus.push({
          sku: product.sku,
          fulfillmentType: product.fulfillmentType,
          cost: product.cost
        });
      });
      
      // Calculate metrics for each product
      Object.values(brandData).forEach(brand => {
        brand.fbm = { income: 0, opex: 0, productCosts: 0, adSpend: 0, profit: 0, margin: 0 };
        brand.fba = { income: 0, opex: 0, productCosts: 0, adSpend: 0, profit: 0, margin: 0 };
        brand.total = { income: 0, opex: 0, productCosts: 0, adSpend: 0, profit: 0, margin: 0 };
        
        brand.products.forEach(product => {
          const fbmSkus = product.skus.filter(s => s.fulfillmentType === 'FBM').map(s => s.sku);
          const fbaSkus = product.skus.filter(s => s.fulfillmentType === 'FBA').map(s => s.sku);
          
          console.log(`BP: Product "${product.productName}" - FBM SKUs:`, fbmSkus, 'FBA SKUs:', fbaSkus);
          
          // Calculate FBM metrics
          if (fbmSkus.length > 0) {
            const fbmTransactions = transactions.filter(t => fbmSkus.includes(t.sku));
            const fbmShipping = shippingCosts.filter(s => fbmSkus.includes(s.sku));
            
            console.log(`BP: Product "${product.productName}" FBM - Found ${fbmTransactions.length} transactions`);
            if (fbmTransactions.length > 0) console.log('BP: Sample FBM transaction:', fbmTransactions[0]);
            
            // Income (using transaction columns like Overview does)
            product.fbm.income = fbmTransactions.reduce((sum, t) => {
              if (t.type === 'Order' && t.fulfillment === 'Seller') {
                sum += t['product sales'] || 0;
                sum += t['shipping credits'] || 0;
                sum += t['gift wrap credits'] || 0;
                sum += t['promotional rebates'] || 0;
              }
              if (t.type === 'Refund' && t.fulfillment === 'Seller') {
                sum += t['product sales'] || 0; // Refunds are negative
                sum += t['shipping credits'] || 0;
                sum += t['gift wrap credits'] || 0;
                sum += t['promotional rebates'] || 0;
              }
              return sum;
            }, 0);
            
            // OpEx (fees from transaction columns)
            product.fbm.opex = fbmTransactions.reduce((sum, t) => {
              if (t.type === 'Order' && t.fulfillment === 'Seller') {
                sum += Math.abs(t['selling fees'] || 0);
              }
              if (t.type === 'Refund' && t.fulfillment === 'Seller') {
                sum += Math.abs(t['selling fees'] || 0);
              }
              return sum;
            }, 0);
            
            // Add shipping costs to opex
            product.fbm.opex += fbmShipping.reduce((sum, s) => sum + s.cost, 0);
            
            // Product costs (COGS)
            const fbmCostMap = {};
            product.skus.filter(s => s.fulfillmentType === 'FBM').forEach(s => {
              fbmCostMap[s.sku] = s.cost;
            });
            
            product.fbm.productCosts = fbmTransactions.reduce((sum, t) => {
              if (t.type === 'Order' && t.fulfillment === 'Seller' && fbmCostMap[t.sku]) {
                return sum + (fbmCostMap[t.sku] * Math.abs(t.quantity || 1));
              }
              return sum;
            }, 0);
            
            
            // Profit & margin (will recalculate after ad spend is allocated)
            product.fbm.profit = product.fbm.income - product.fbm.opex - product.fbm.productCosts - product.fbm.adSpend;
            product.fbm.margin = product.fbm.income > 0 ? (product.fbm.profit / product.fbm.income) * 100 : 0;
          }
          
          // Calculate FBA metrics
          if (fbaSkus.length > 0) {
            const fbaTransactions = transactions.filter(t => fbaSkus.includes(t.sku));
            
            // Income (using transaction columns like Overview does)
            product.fba.income = fbaTransactions.reduce((sum, t) => {
              if (t.type === 'Order' && t.fulfillment === 'Amazon') {
                sum += t['product sales'] || 0;
                sum += t['shipping credits'] || 0;
                sum += t['gift wrap credits'] || 0;
                sum += t['promotional rebates'] || 0;
              }
              if (t.type === 'Refund' && t.fulfillment === 'Amazon') {
                sum += t['product sales'] || 0; // Refunds are negative
                sum += t['shipping credits'] || 0;
                sum += t['gift wrap credits'] || 0;
                sum += t['promotional rebates'] || 0;
              }
              return sum;
            }, 0);
            
            // OpEx (fees from transaction columns, excluding unallocable per requirements)
            product.fba.opex = fbaTransactions.reduce((sum, t) => {
              if (t.type === 'Order' && t.fulfillment === 'Amazon') {
                sum += Math.abs(t['selling fees'] || 0);
                sum += Math.abs(t['fba fees'] || 0);
              }
              if (t.type === 'Refund' && t.fulfillment === 'Amazon') {
                sum += Math.abs(t['selling fees'] || 0);
                sum += Math.abs(t['fba fees'] || 0);
              }
              return sum;
            }, 0);
            
            // Product costs (COGS)
            const fbaCostMap = {};
            product.skus.filter(s => s.fulfillmentType === 'FBA').forEach(s => {
              fbaCostMap[s.sku] = s.cost;
            });
            
            product.fba.productCosts = fbaTransactions.reduce((sum, t) => {
              if (t.type === 'Order' && t.fulfillment === 'Amazon' && fbaCostMap[t.sku]) {
                return sum + (fbaCostMap[t.sku] * Math.abs(t.quantity || 1));
              }
              return sum;
            }, 0);
            
            // Profit & margin (will recalculate after ad spend is allocated)
            product.fba.profit = product.fba.income - product.fba.opex - product.fba.productCosts - product.fba.adSpend;
            product.fba.margin = product.fba.income > 0 ? (product.fba.profit / product.fba.income) * 100 : 0;
          }
          
          // Calculate product ad spend AFTER both FBM and FBA income are known
          // This prevents double-counting when campaigns are mapped to both FBM and FBA SKUs
          const productAdSpendByChannel = { fbm: 0, fba: 0 };
          
          productAds.forEach(ad => {
            const mappedSkus = productCampaignToSkus[ad.campaign] || [];
            const hasFbm = mappedSkus.some(sku => fbmSkus.includes(sku));
            const hasFba = mappedSkus.some(sku => fbaSkus.includes(sku));
            
            if (hasFbm && hasFba) {
              // Campaign mapped to both FBM and FBA SKUs - split proportionally by income
              const fbmIncome = product.fbm.income || 0;
              const fbaIncome = product.fba.income || 0;
              const totalIncome = fbmIncome + fbaIncome;
              
              if (totalIncome > 0) {
                productAdSpendByChannel.fbm += ad.spend * (fbmIncome / totalIncome);
                productAdSpendByChannel.fba += ad.spend * (fbaIncome / totalIncome);
              } else {
                // No income - split 50/50
                productAdSpendByChannel.fbm += ad.spend * 0.5;
                productAdSpendByChannel.fba += ad.spend * 0.5;
              }
            } else if (hasFbm) {
              // Only FBM
              productAdSpendByChannel.fbm += ad.spend;
            } else if (hasFba) {
              // Only FBA
              productAdSpendByChannel.fba += ad.spend;
            }
          });
          
          product.fbm.adSpend = productAdSpendByChannel.fbm;
          product.fba.adSpend = productAdSpendByChannel.fba;
          
          // Recalculate profit and margin with correct ad spend
          product.fbm.profit = product.fbm.income - product.fbm.opex - product.fbm.productCosts - product.fbm.adSpend;
          product.fbm.margin = product.fbm.income > 0 ? (product.fbm.profit / product.fbm.income) * 100 : 0;
          
          product.fba.profit = product.fba.income - product.fba.opex - product.fba.productCosts - product.fba.adSpend;
          product.fba.margin = product.fba.income > 0 ? (product.fba.profit / product.fba.income) * 100 : 0;
          
          // Calculate total metrics
          product.total.income = product.fbm.income + product.fba.income;
          product.total.opex = product.fbm.opex + product.fba.opex;
          product.total.productCosts = product.fbm.productCosts + product.fba.productCosts;
          product.total.adSpend = product.fbm.adSpend + product.fba.adSpend;
          product.total.profit = product.total.income - product.total.opex - product.total.productCosts - product.total.adSpend;
          product.total.margin = product.total.income > 0 ? (product.total.profit / product.total.income) * 100 : 0;
          
          // Aggregate to brand
          brand.fbm.income += product.fbm.income;
          brand.fbm.opex += product.fbm.opex;
          brand.fbm.productCosts += product.fbm.productCosts;
          brand.fbm.adSpend += product.fbm.adSpend;
          
          brand.fba.income += product.fba.income;
          brand.fba.opex += product.fba.opex;
          brand.fba.productCosts += product.fba.productCosts;
          brand.fba.adSpend += product.fba.adSpend;
          
          brand.total.income += product.total.income;
          brand.total.opex += product.total.opex;
          brand.total.productCosts += product.total.productCosts;
          brand.total.adSpend += product.total.adSpend;
        });
        
        // Calculate brand profit and margins
        brand.fbm.profit = brand.fbm.income - brand.fbm.opex - brand.fbm.productCosts - brand.fbm.adSpend;
        brand.fbm.margin = brand.fbm.income > 0 ? (brand.fbm.profit / brand.fbm.income) * 100 : 0;
        
        brand.fba.profit = brand.fba.income - brand.fba.opex - brand.fba.productCosts - brand.fba.adSpend;
        brand.fba.margin = brand.fba.income > 0 ? (brand.fba.profit / brand.fba.income) * 100 : 0;
        
        brand.total.profit = brand.total.income - brand.total.opex - brand.total.productCosts - brand.total.adSpend;
        brand.total.margin = brand.total.income > 0 ? (brand.total.profit / brand.total.income) * 100 : 0;
        
        // Add brand ad spend (using brand campaign mapping)
        const brandAdSpend = brandAds.reduce((sum, ad) => {
          const mappedBrand = brandCampaignToBrand[ad.campaign];
          if (mappedBrand === brand.brandName) {
            return sum + ad.spend;
          }
          return sum;
        }, 0);
        
        if (brandAdSpend > 0) {
          // Allocate brand ad spend proportionally across FBM/FBA based on income
          const totalIncome = brand.total.income;
          if (totalIncome > 0) {
            const fbmRatio = brand.fbm.income / totalIncome;
            const fbaRatio = brand.fba.income / totalIncome;
            
            brand.fbm.adSpend += brandAdSpend * fbmRatio;
            brand.fba.adSpend += brandAdSpend * fbaRatio;
            brand.total.adSpend += brandAdSpend;
            
            // Recalculate profit and margin with brand ad spend
            brand.fbm.profit = brand.fbm.income - brand.fbm.opex - brand.fbm.productCosts - brand.fbm.adSpend;
            brand.fbm.margin = brand.fbm.income > 0 ? (brand.fbm.profit / brand.fbm.income) * 100 : 0;
            
            brand.fba.profit = brand.fba.income - brand.fba.opex - brand.fba.productCosts - brand.fba.adSpend;
            brand.fba.margin = brand.fba.income > 0 ? (brand.fba.profit / brand.fba.income) * 100 : 0;
            
            brand.total.profit = brand.total.income - brand.total.opex - brand.total.productCosts - brand.total.adSpend;
            brand.total.margin = brand.total.income > 0 ? (brand.total.profit / brand.total.income) * 100 : 0;
          }
        }
      });
      
      return Object.values(brandData).sort((a, b) => a.brandName.localeCompare(b.brandName));
    }
    
    // Render the brand/product table
    function renderBrandProductTable(brandData, containerId) {
      const container = document.getElementById(containerId);
      
      if (!brandData || brandData.length === 0) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">No data available for this period</div>';
        return;
      }
      
      let html = `
        <div class="bp-table-wrapper">
          <table class="bp-table">
            <thead>
              <tr>
                <th rowspan="2">Brand / Product</th>
                <th colspan="6" class="header-group fbm">FBM</th>
                <th colspan="6" class="header-group fba">FBA</th>
                <th colspan="6" class="header-group total">Total</th>
              </tr>
              <tr>
                <th>Income</th>
                <th>OpEx</th>
                <th>Costs</th>
                <th>Ads</th>
                <th>Profit</th>
                <th>Margin</th>
                <th>Income</th>
                <th>OpEx</th>
                <th>Costs</th>
                <th>Ads</th>
                <th>Profit</th>
                <th>Margin</th>
                <th>Income</th>
                <th>OpEx</th>
                <th>Costs</th>
                <th>Ads</th>
                <th>Profit</th>
                <th>Margin</th>
              </tr>
            </thead>
            <tbody>
      `;
      
      brandData.forEach(brand => {
        const brandId = brand.brandName.replace(/\s+/g, '-');
        
        // Brand row
        html += `
          <tr class="brand-row" onclick="toggleBrand('${brandId}')">
            <td>
              <div class="brand-name">
                <span class="expand-icon">▶</span>
                <strong>${brand.brandName}</strong>
              </div>
            </td>
            ${renderMetricsCells(brand.fbm)}
            ${renderMetricsCells(brand.fba)}
            ${renderMetricsCells(brand.total)}
          </tr>
        `;
        
        // Product rows (initially hidden)
        brand.products.forEach(product => {
          html += `
            <tr class="product-row" data-brand="${brandId}" style="display: none;">
              <td>${product.productName}</td>
              ${renderMetricsCells(product.fbm, product.skus.some(s => s.fulfillmentType === 'FBM'))}
              ${renderMetricsCells(product.fba, product.skus.some(s => s.fulfillmentType === 'FBA'))}
              ${renderMetricsCells(product.total)}
            </tr>
          `;
        });
      });
      
      html += `
            </tbody>
          </table>
        </div>
      `;
      
      container.innerHTML = html;
    }
    
    // Helper to render metrics cells
    function renderMetricsCells(metrics, hasData = true) {
      if (!hasData) {
        return '<td class="neutral">--</td><td class="neutral">--</td><td class="neutral">--</td><td class="neutral">--</td><td class="neutral">--</td><td class="neutral">--</td>';
      }
      
      const formatMoney = (val) => {
        if (val === 0) return '$0.00';
        return val >= 0 ? `$${val.toFixed(2)}` : `-$${Math.abs(val).toFixed(2)}`;
      };
      
      const profitClass = metrics.profit >= 0 ? 'positive' : 'negative';
      const marginClass = metrics.margin >= 0 ? 'positive' : 'negative';
      
      return `
        <td>${formatMoney(metrics.income)}</td>
        <td>${formatMoney(metrics.opex)}</td>
        <td>${formatMoney(metrics.productCosts)}</td>
        <td>${formatMoney(metrics.adSpend)}</td>
        <td class="${profitClass}">${formatMoney(metrics.profit)}</td>
        <td class="${marginClass}">${metrics.margin.toFixed(1)}%</td>
      `;
    }
    
    // Toggle brand expansion
    function toggleBrand(brandId) {
      const brandRow = event.currentTarget;
      const isExpanded = brandRow.classList.contains('expanded');
      const productRows = document.querySelectorAll(`tr.product-row[data-brand="${brandId}"]`);
      
      if (isExpanded) {
        brandRow.classList.remove('expanded');
        productRows.forEach(row => row.style.display = 'none');
      } else {
        brandRow.classList.add('expanded');
        productRows.forEach(row => row.style.display = 'table-row');
      }
    }
    
    
    // Extract profitability metrics from a financial statement
    function extractProfitabilityMetrics(statement) {
      // Calculate FBM totals
      const fbmIncome = (statement.income['FBM Sales']?.credit || 0) - (statement.income['FBM Sales']?.debit || 0) +
                        (statement.income['FBM Returns']?.credit || 0) - (statement.income['FBM Returns']?.debit || 0) +
                        (statement.income['FBM Other']?.credit || 0) - (statement.income['FBM Other']?.debit || 0);
      
      const fbmOpEx = (statement.expenses['FBM Shipping Costs']?.debit || 0) - (statement.expenses['FBM Shipping Costs']?.credit || 0) +
                      (statement.expenses['FBM Transaction Fees']?.debit || 0) - (statement.expenses['FBM Transaction Fees']?.credit || 0);
      
      const fbmProductCosts = (statement.expenses['FBM Product Costs']?.debit || 0) - (statement.expenses['FBM Product Costs']?.credit || 0);
      const fbmAdSpend = (statement.expenses['FBM Ad Spend']?.debit || 0) - (statement.expenses['FBM Ad Spend']?.credit || 0);
      const fbmProfit = fbmIncome - fbmOpEx - fbmProductCosts - fbmAdSpend;
      const fbmMargin = fbmIncome > 0 ? (fbmProfit / fbmIncome * 100) : 0;
      
      // Calculate FBA totals
      const fbaIncome = (statement.income['FBA Sales']?.credit || 0) - (statement.income['FBA Sales']?.debit || 0) +
                        (statement.income['FBA Returns']?.credit || 0) - (statement.income['FBA Returns']?.debit || 0) +
                        (statement.income['FBA Other']?.credit || 0) - (statement.income['FBA Other']?.debit || 0);
      
      const fbaOpEx = (statement.expenses['FBA Fees']?.debit || 0) - (statement.expenses['FBA Fees']?.credit || 0);
      
      const fbaProductCosts = (statement.expenses['FBA Product Costs']?.debit || 0) - (statement.expenses['FBA Product Costs']?.credit || 0);
      const fbaAdSpend = (statement.expenses['FBA Ad Spend']?.debit || 0) - (statement.expenses['FBA Ad Spend']?.credit || 0);
      const fbaProfit = fbaIncome - fbaOpEx - fbaProductCosts - fbaAdSpend;
      const fbaMargin = fbaIncome > 0 ? (fbaProfit / fbaIncome * 100) : 0;
      
      // Calculate Total
      const totalIncome = fbmIncome + fbaIncome;
      const totalOpEx = fbmOpEx + fbaOpEx;
      const totalProductCosts = fbmProductCosts + fbaProductCosts;
      const totalAdSpend = fbmAdSpend + fbaAdSpend;
      const totalProfit = fbmProfit + fbaProfit;
      const totalMargin = totalIncome > 0 ? (totalProfit / totalIncome * 100) : 0;
      
      return {
        fbm: {
          income: fbmIncome,
          opex: fbmOpEx,
          productCosts: fbmProductCosts,
          adSpend: fbmAdSpend,
          profit: fbmProfit,
          margin: fbmMargin
        },
        fba: {
          income: fbaIncome,
          opex: fbaOpEx,
          productCosts: fbaProductCosts,
          adSpend: fbaAdSpend,
          profit: fbaProfit,
          margin: fbaMargin
        },
        total: {
          income: totalIncome,
          opex: totalOpEx,
          productCosts: totalProductCosts,
          adSpend: totalAdSpend,
          profit: totalProfit,
          margin: totalMargin
        }
      };
    }
    
    function calculateFinancialStatement(transactions, productCosts, fbaAdSpend, fbmAdSpend, unallocatedAdSpend, totalShippingCosts) {
      // Initialize statement structure based on mapping
      const statement = {
        income: {
          'FBM Sales': { debit: 0, credit: 0 },
          'FBM Returns': { debit: 0, credit: 0 },
          'FBM Other': { debit: 0, credit: 0 },
          'FBA Sales': { debit: 0, credit: 0 },
          'FBA Returns': { debit: 0, credit: 0 },
          'FBA Other': { debit: 0, credit: 0 }
        },
        expenses: {
          'FBM Product Costs': { debit: 0, credit: 0 },
          'FBM Transaction Fees': { debit: 0, credit: 0 },
          'FBM Shipping Costs': { debit: 0, credit: 0 },
          'FBM Ad Spend': { debit: 0, credit: 0 },
          'FBA Product Costs': { debit: 0, credit: 0 },
          'FBA Transaction Fees': { debit: 0, credit: 0 },
          'FBA Fees': { debit: 0, credit: 0 },
          'FBA Inbound Placement Fees': { debit: 0, credit: 0 },
          'FBA Inbound Shipping Costs': { debit: 0, credit: 0 },
          'FBA Inventory Storage Fees': { debit: 0, credit: 0 },
          'FBA Inventory Reimbursement': { debit: 0, credit: 0 },
          'FBA Ad Spend': { debit: 0, credit: 0 },
          'Other Expenses': { debit: 0, credit: 0 },
          'Unallocated Ad Spend': { debit: 0, credit: 0 }
        }
      };
      
      transactions.forEach(t => {
        const type = (t.type || '').trim();
        const fulfillment = (t.fulfillment || '').trim();
        const description = (t.description || '').trim();
        const sku = t.sku || '';
        const quantity = parseInt(t.quantity || 0);
        
        // Get column values
        const productSales = parseFloat(t['product sales'] || 0);
        const shippingCredits = parseFloat(t['shipping credits'] || 0);
        const giftWrapCredits = parseFloat(t['gift wrap credits'] || 0);
        const promoRebates = parseFloat(t['promotional rebates'] || 0);
        const sellingFees = parseFloat(t['selling fees'] || 0);
        const fbaFees = parseFloat(t['fba fees'] || 0);
        const other = parseFloat(t['other'] || 0);
        
        // Helper function to add to debit/credit
        const addAmount = (category, section, amount) => {
          if (amount > 0) {
            statement[section][category].credit += amount;
          } else if (amount < 0) {
            statement[section][category].debit += Math.abs(amount);
          }
        };
        
        // INCOME CALCULATIONS
        
        // FBM Sales: type = Order and fulfillment = Seller, sum of product sales
        if (type === 'Order' && fulfillment === 'Seller') {
          addAmount('FBM Sales', 'income', productSales);
        }
        
        // FBM Returns: type = Refund and fulfillment = Seller, sum of product sales
        if (type === 'Refund' && fulfillment === 'Seller') {
          addAmount('FBM Returns', 'income', productSales);
        }
        
        // FBM Other: fulfillment = Seller and type = Order or Refund
        // Sum of shipping credits, gift wrap credits, and promotional rebates
        if (fulfillment === 'Seller' && (type === 'Order' || type === 'Refund')) {
          addAmount('FBM Other', 'income', shippingCredits);
          addAmount('FBM Other', 'income', giftWrapCredits);
          addAmount('FBM Other', 'income', promoRebates);
        }
        
        // FBA Sales: type = Order and fulfillment = Amazon, sum of product sales
        if (type === 'Order' && fulfillment === 'Amazon') {
          addAmount('FBA Sales', 'income', productSales);
        }
        
        // FBA Returns: type = Refund and fulfillment = Amazon, sum of product sales
        if (type === 'Refund' && fulfillment === 'Amazon') {
          addAmount('FBA Returns', 'income', productSales);
        }
        
        // FBA Other: fulfillment = Amazon and type = Order or Refund
        // Sum of shipping credits, gift wrap credits, and promotional rebates
        if (fulfillment === 'Amazon' && (type === 'Order' || type === 'Refund')) {
          addAmount('FBA Other', 'income', shippingCredits);
          addAmount('FBA Other', 'income', giftWrapCredits);
          addAmount('FBA Other', 'income', promoRebates);
        }
        
        // FBA Inventory Reimbursement: description starts with "FBA Inventory Reimbursement"
        if (description.startsWith('FBA Inventory Reimbursement')) {
          addAmount('FBA Inventory Reimbursement', 'expenses', other);
        }
        
        // EXPENSE CALCULATIONS
        
        // Product Costs (quantity * cost from Products sheet)
        if (sku && quantity && productCosts[sku]) {
          const productCost = quantity * productCosts[sku];
          
          if (type === 'Order' && quantity > 0) {
            if (fulfillment === 'Seller') {
              statement.expenses['FBM Product Costs'].debit += productCost;
            } else if (fulfillment === 'Amazon') {
              statement.expenses['FBA Product Costs'].debit += productCost;
            }
          }
          
          // Handle refunds (credit back the cost)
          if (type === 'Refund' && quantity < 0) {
            if (fulfillment === 'Seller') {
              statement.expenses['FBM Product Costs'].credit += Math.abs(productCost);
            } else if (fulfillment === 'Amazon') {
              statement.expenses['FBA Product Costs'].credit += Math.abs(productCost);
            }
          }
        }
        
        // FBM Transaction Fees: type = Order and fulfillment = Seller, sum of selling fees
        if (type === 'Order' && fulfillment === 'Seller') {
          addAmount('FBM Transaction Fees', 'expenses', sellingFees);
        }
        
        // FBA Transaction Fees: type = Order and fulfillment = Amazon, sum of selling fees
        if (type === 'Order' && fulfillment === 'Amazon') {
          addAmount('FBA Transaction Fees', 'expenses', sellingFees);
        }
        
        // FBA Fees: type = Fee Adjustment and fba fees > 0 OR type = Order and fulfillment = Amazon
        // Sum of fba fees
        if ((type === 'Fee Adjustment' && fbaFees > 0) || (type === 'Order' && fulfillment === 'Amazon')) {
          addAmount('FBA Fees', 'expenses', fbaFees);
        }
        
        // FBA Inbound Placement Fees: description = FBA Inbound Placement Service Fee
        if (description === 'FBA Inbound Placement Service Fee') {
          addAmount('FBA Inbound Placement Fees', 'expenses', other);
        }
        
        // FBA Inbound Shipping: type = FBA Inventory Fee and description = FBA Amazon-Partnered Carrier Shipment Fee
        if (type === 'FBA Inventory Fee' && description === 'FBA Amazon-Partnered Carrier Shipment Fee') {
          addAmount('FBA Inbound Shipping Costs', 'expenses', other);
        }
        
        // FBA Inventory Storage Fees: type = FBA Inventory Fee and description =/= FBA Amazon-Partnered Carrier Shipment Fee
        if (type === 'FBA Inventory Fee' && description !== 'FBA Amazon-Partnered Carrier Shipment Fee') {
          addAmount('FBA Inventory Storage Fees', 'expenses', other);
        }
        
        // Other Expenses: type = Chargeback Refund or Order_Retrocharge or description = Subscription
        if (type === 'Chargeback Refund' || type === 'Order_Retrocharge' || description === 'Subscription') {
          addAmount('Other Expenses', 'expenses', other);
        }
        
        // Note: type = Transfer is ignored
      });
      
      // Add shipping costs
      if (totalShippingCosts > 0) {
        statement.expenses['FBM Shipping Costs'].debit = totalShippingCosts;
      }
      
      // Add ad spend by channel
      if (fbmAdSpend > 0) {
        statement.expenses['FBM Ad Spend'].debit = fbmAdSpend;
      }
      
      if (fbaAdSpend > 0) {
        statement.expenses['FBA Ad Spend'].debit = fbaAdSpend;
      }
      
      if (unallocatedAdSpend > 0) {
        statement.expenses['Unallocated Ad Spend'].debit = unallocatedAdSpend;
      }
      
      return statement;
    }
    
    
    // Format comparison percentage with color indicator
    function formatComparison(value, inverted = false) {
      if (value === null || value === undefined) return 'N/A';
      
      const isPositive = value >= 0;
      // For income/profit: green when up, red when down
      // For expenses: red when up, green when down (inverted)
      const isGood = inverted ? !isPositive : isPositive;
      const color = isGood ? 'var(--success)' : 'var(--error)';
      const arrow = isPositive ? '↑' : '↓';
      
      return `<span style="color: ${color};">${arrow} ${Math.abs(value).toFixed(1)}%</span>`;
    }
    
    function renderFinancialStatement(statement, startDate, endDate, container, comparisons = null) {
      
      // Calculate FBM totals
      const fbmIncome = (statement.income['FBM Sales']?.credit || 0) - (statement.income['FBM Sales']?.debit || 0) +
                        (statement.income['FBM Returns']?.credit || 0) - (statement.income['FBM Returns']?.debit || 0) +
                        (statement.income['FBM Other']?.credit || 0) - (statement.income['FBM Other']?.debit || 0);
      
      const fbmExpensesExcludingCostAndAd = 
        (statement.expenses['FBM Shipping Costs']?.debit || 0) - (statement.expenses['FBM Shipping Costs']?.credit || 0) +
        (statement.expenses['FBM Transaction Fees']?.debit || 0) - (statement.expenses['FBM Transaction Fees']?.credit || 0);
      
      const fbmProductCosts = (statement.expenses['FBM Product Costs']?.debit || 0) - (statement.expenses['FBM Product Costs']?.credit || 0);
      const fbmAdSpend = statement.expenses['FBM Ad Spend']?.debit || 0;
      const fbmProfit = fbmIncome - fbmExpensesExcludingCostAndAd - fbmProductCosts - fbmAdSpend;
      const fbmMargin = fbmIncome > 0 ? (fbmProfit / fbmIncome * 100) : 0;
      
      // Calculate FBA totals
      const fbaIncome = (statement.income['FBA Sales']?.credit || 0) - (statement.income['FBA Sales']?.debit || 0) +
                        (statement.income['FBA Returns']?.credit || 0) - (statement.income['FBA Returns']?.debit || 0) +
                        (statement.income['FBA Other']?.credit || 0) - (statement.income['FBA Other']?.debit || 0);
      
      const fbaExpensesExcludingCostAndAd = 
        (statement.expenses['FBA Transaction Fees']?.debit || 0) - (statement.expenses['FBA Transaction Fees']?.credit || 0) +
        (statement.expenses['FBA Fees']?.debit || 0) - (statement.expenses['FBA Fees']?.credit || 0) +
        (statement.expenses['FBA Inbound Placement Fees']?.debit || 0) - (statement.expenses['FBA Inbound Placement Fees']?.credit || 0) +
        (statement.expenses['FBA Inbound Shipping Costs']?.debit || 0) - (statement.expenses['FBA Inbound Shipping Costs']?.credit || 0) +
        (statement.expenses['FBA Inventory Storage Fees']?.debit || 0) - (statement.expenses['FBA Inventory Storage Fees']?.credit || 0) +
        (statement.expenses['FBA Inventory Reimbursement']?.debit || 0) - (statement.expenses['FBA Inventory Reimbursement']?.credit || 0);
      
      const fbaProductCosts = (statement.expenses['FBA Product Costs']?.debit || 0) - (statement.expenses['FBA Product Costs']?.credit || 0);
      const fbaAdSpend = statement.expenses['FBA Ad Spend']?.debit || 0;
      const fbaProfit = fbaIncome - fbaExpensesExcludingCostAndAd - fbaProductCosts - fbaAdSpend;
      const fbaMargin = fbaIncome > 0 ? (fbaProfit / fbaIncome * 100) : 0;
      
      // Calculate combined totals
      const otherExpenses = (statement.expenses['Other Expenses']?.debit || 0) - (statement.expenses['Other Expenses']?.credit || 0);
      const unallocatedAdSpend = statement.expenses['Unallocated Ad Spend']?.debit || 0;
      
      const totalIncome = fbmIncome + fbaIncome;
      const totalExpensesExcludingCostAndAd = fbmExpensesExcludingCostAndAd + fbaExpensesExcludingCostAndAd + otherExpenses;
      const totalProductCosts = fbmProductCosts + fbaProductCosts;
      const totalAdSpend = fbmAdSpend + fbaAdSpend + unallocatedAdSpend;
      const totalProfit = totalIncome - totalExpensesExcludingCostAndAd - totalProductCosts - totalAdSpend;
      const totalMargin = totalIncome > 0 ? (totalProfit / totalIncome * 100) : 0;
      
      // Calculate overall totals for traditional view
      let incomeTotalDebit = 0, incomeTotalCredit = 0;
      Object.values(statement.income).forEach(item => {
        incomeTotalDebit += item.debit;
        incomeTotalCredit += item.credit;
      });
      
      let expenseTotalDebit = 0, expenseTotalCredit = 0;
      Object.values(statement.expenses).forEach(item => {
        expenseTotalDebit += item.debit;
        expenseTotalCredit += item.credit;
      });
      
      let html = `
        <div style="margin-bottom: 2rem;">
          <div style="font-size: 0.875rem; color: var(--text-secondary); margin-bottom: 0.5rem;">
            Report Period: ${startDate} - ${endDate}
          </div>
        </div>
        
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 2rem;">
          <!-- LEFT SIDE: Traditional Statement -->
          <div>
            <!-- Income Section -->
            <div style="margin-bottom: 2rem;">
              <h3 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; color: var(--success);">Income</h3>
              <table style="width: 100%;">
                <thead>
                  <tr>
                    <th style="text-align: left; padding: 0.75rem; background: var(--bg-secondary); width: 50%;">Category</th>
                    <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 25%; min-width: 140px;">Debit</th>
                    <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 25%; min-width: 140px;">Credit</th>
                  </tr>
                </thead>
                <tbody>
      `;
      
      Object.entries(statement.income).forEach(([category, amounts]) => {
        html += `
          <tr>
            <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">${category}</td>
            <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">
              ${amounts.debit > 0 ? '$' + formatNumber(amounts.debit) : '$0.00'}
            </td>
            <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">
              ${amounts.credit > 0 ? '$' + formatNumber(amounts.credit) : '$0.00'}
            </td>
          </tr>
        `;
      });
      
      html += `
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.75rem;">Totals</td>
                    <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">$${formatNumber(incomeTotalDebit)}</td>
                    <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">$${formatNumber(incomeTotalCredit)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            
            <!-- Expenses Section -->
            <div>
              <h3 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; color: var(--error);">Expenses</h3>
              <table style="width: 100%;">
                <thead>
                  <tr>
                    <th style="text-align: left; padding: 0.75rem; background: var(--bg-secondary); width: 50%;">Category</th>
                    <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 25%; min-width: 140px;">Debit</th>
                    <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 25%; min-width: 140px;">Credit</th>
                  </tr>
                </thead>
                <tbody>
      `;
      
      Object.entries(statement.expenses).forEach(([category, amounts]) => {
        html += `
          <tr>
            <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">${category}</td>
            <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">
              ${amounts.debit > 0 ? '$' + formatNumber(amounts.debit) : '$0.00'}
            </td>
            <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">
              ${amounts.credit > 0 ? '$' + formatNumber(amounts.credit) : '$0.00'}
            </td>
          </tr>
        `;
      });
      
      html += `
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.75rem;">Totals</td>
                    <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">$${formatNumber(expenseTotalDebit)}</td>
                    <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">$${formatNumber(expenseTotalCredit)}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          
          <!-- RIGHT SIDE: Profitability Analysis -->
          <div style="display: flex; flex-direction: column; gap: 1.5rem;">
            <!-- FBM Profitability -->
            <div style="margin-bottom: 2rem;">
              <h3 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem;">FBM Profitability</h3>
              <table style="width: 100%;">
                <thead>
                  <tr>
                    <th style="text-align: left; padding: 0.75rem; background: var(--bg-secondary); ${comparisons ? (comparisons.fbm.income.mom !== undefined ? 'width: 46%;' : 'width: 50%;') : 'width: 50%;'}">Category</th>
                    <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); ${comparisons ? (comparisons.fbm.income.mom !== undefined ? 'width: 27%;' : 'width: 35%;') : 'width: 50%;'} min-width: 140px;">Total</th>
                    ${comparisons ? '<th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); ' + (comparisons.fbm.income.mom !== undefined ? 'width: 13.5%;' : 'width: 15%;') + ' min-width: 80px;">YoY</th>' : ''}
                    ${comparisons && comparisons.fbm.income.mom !== undefined ? '<th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 13.5%; min-width: 80px;">MoM</th>' : ''}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Income</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${fbmIncome >= 0 ? '$' + formatNumber(fbmIncome) : '-$' + formatNumber(Math.abs(fbmIncome))}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.income.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.fbm.income.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.income.mom, false)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Operating Expenses</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(fbmExpensesExcludingCostAndAd)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.opex.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.fbm.opex.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.opex.mom, true)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Product Costs</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(fbmProductCosts)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.productCosts.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.fbm.productCosts.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.productCosts.mom, true)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Ad Spend</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(fbmAdSpend)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.adSpend.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.fbm.adSpend.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.adSpend.mom, true)}</td>` : ''}
                  </tr>
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.75rem;">Profit</td>
                    <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; color: ${fbmProfit >= 0 ? 'var(--success)' : 'var(--error)'};">${fbmProfit >= 0 ? '$' : '-$'}${formatNumber(Math.abs(fbmProfit))}</td>
                    ${comparisons ? `<td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.profit.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.fbm.profit.mom !== undefined ? `<td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.profit.mom, false)}</td>` : ''}
                  </tr>
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Margin</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace; color: ${fbmMargin >= 0 ? 'var(--success)' : 'var(--error)'};">${fbmMargin.toFixed(1)}%</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.margin.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.fbm.margin.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fbm.margin.mom, false)}</td>` : ''}
                  </tr>
                </tbody>
              </table>
            </div>
            
            <!-- FBA Profitability -->
            <div style="margin-bottom: 2rem;">
              <h3 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem;">FBA Profitability</h3>
              <table style="width: 100%;">
                <thead>
                  <tr>
                    <th style="text-align: left; padding: 0.75rem; background: var(--bg-secondary); ${comparisons ? (comparisons.fbm.income.mom !== undefined ? 'width: 46%;' : 'width: 50%;') : 'width: 50%;'}">Category</th>
                    <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); ${comparisons ? (comparisons.fbm.income.mom !== undefined ? 'width: 27%;' : 'width: 35%;') : 'width: 50%;'} min-width: 140px;">Total</th>
                    ${comparisons ? '<th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); ' + (comparisons.fbm.income.mom !== undefined ? 'width: 13.5%;' : 'width: 15%;') + ' min-width: 80px;">YoY</th>' : ''}
                    ${comparisons && comparisons.fbm.income.mom !== undefined ? '<th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 13.5%; min-width: 80px;">MoM</th>' : ''}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Income</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${fbaIncome >= 0 ? '$' + formatNumber(fbaIncome) : '-$' + formatNumber(Math.abs(fbaIncome))}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.income.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.fba.income.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.income.mom, false)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Operating Expenses</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(fbaExpensesExcludingCostAndAd)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.opex.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.fba.opex.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.opex.mom, true)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Product Costs</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(fbaProductCosts)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.productCosts.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.fba.productCosts.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.productCosts.mom, true)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Ad Spend</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(fbaAdSpend)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.adSpend.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.fba.adSpend.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.adSpend.mom, true)}</td>` : ''}
                  </tr>
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.75rem;">Profit</td>
                    <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; color: ${fbaProfit >= 0 ? 'var(--success)' : 'var(--error)'};">${fbaProfit >= 0 ? '$' : '-$'}${formatNumber(Math.abs(fbaProfit))}</td>
                    ${comparisons ? `<td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.profit.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.fba.profit.mom !== undefined ? `<td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.profit.mom, false)}</td>` : ''}
                  </tr>
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Margin</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace; color: ${fbaMargin >= 0 ? 'var(--success)' : 'var(--error)'};">${fbaMargin.toFixed(1)}%</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.margin.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.fba.margin.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.fba.margin.mom, false)}</td>` : ''}
                  </tr>
                </tbody>
              </table>
            </div>
            
            <!-- Total Profitability -->
            <div>
              <h3 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem;">Total Profitability</h3>
              <table style="width: 100%;">
                <thead>
                  <tr>
                    <th style="text-align: left; padding: 0.75rem; background: var(--bg-secondary); ${comparisons ? (comparisons.fbm.income.mom !== undefined ? 'width: 46%;' : 'width: 50%;') : 'width: 50%;'}">Category</th>
                    <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); ${comparisons ? (comparisons.fbm.income.mom !== undefined ? 'width: 27%;' : 'width: 35%;') : 'width: 50%;'} min-width: 140px;">Total</th>
                    ${comparisons ? '<th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); ' + (comparisons.fbm.income.mom !== undefined ? 'width: 13.5%;' : 'width: 15%;') + ' min-width: 80px;">YoY</th>' : ''}
                    ${comparisons && comparisons.fbm.income.mom !== undefined ? '<th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 13.5%; min-width: 80px;">MoM</th>' : ''}
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Income</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${totalIncome >= 0 ? '$' + formatNumber(totalIncome) : '-$' + formatNumber(Math.abs(totalIncome))}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.income.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.total.income.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.income.mom, false)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Operating Expenses</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(totalExpensesExcludingCostAndAd)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.opex.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.total.opex.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.opex.mom, true)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Product Costs</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(totalProductCosts)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.productCosts.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.total.productCosts.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.productCosts.mom, true)}</td>` : ''}
                  </tr>
                  <tr>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Ad Spend</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">-$${formatNumber(totalAdSpend)}</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.adSpend.yoy, true)}</td>` : ''}
                    ${comparisons && comparisons.total.adSpend.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.adSpend.mom, true)}</td>` : ''}
                  </tr>
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.75rem;">Profit</td>
                    <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; color: ${totalProfit >= 0 ? 'var(--success)' : 'var(--error)'};">${totalProfit >= 0 ? '$' : '-$'}${formatNumber(Math.abs(totalProfit))}</td>
                    ${comparisons ? `<td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.profit.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.total.profit.mom !== undefined ? `<td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.profit.mom, false)}</td>` : ''}
                  </tr>
                  <tr style="font-weight: 700; background: var(--bg-secondary);">
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">Margin</td>
                    <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace; color: ${totalMargin >= 0 ? 'var(--success)' : 'var(--error)'};">${totalMargin.toFixed(1)}%</td>
                    ${comparisons ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.margin.yoy, false)}</td>` : ''}
                    ${comparisons && comparisons.total.margin.mom !== undefined ? `<td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${formatComparison(comparisons.total.margin.mom, false)}</td>` : ''}
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `;
      
      container.innerHTML = html;
    }
    
    // CHARTS PAGE
    let chartsInstances = {}; // Store chart instances for cleanup
    let cachedMonthlyData = []; // Store monthly data for brand filtering
    
    // Process cached data for a specific month (no API calls)
    function processMonthData(startDate, endDate, transactions, products, productAds, brandAds, shippingCosts, productCampaignToSkus, brandCampaignToBrand) {
      try {
        // Filter by date
        const filteredTransactions = transactions.filter(t => t.date >= startDate && t.date <= endDate);
        const filteredProductAds = productAds.filter(a => a.date >= startDate && a.date <= endDate);
        const filteredBrandAds = brandAds.filter(a => a.date >= startDate && a.date <= endDate);
        const filteredShipping = shippingCosts.filter(s => s.date >= startDate && s.date <= endDate);
        
        // Calculate overall FBM/FBA metrics
        let fbmIncome = 0, fbmOpEx = 0, fbmProductCosts = 0, fbmAdSpend = 0;
        let fbaIncome = 0, fbaOpEx = 0, fbaProductCosts = 0, fbaAdSpend = 0;
        
        // Group by SKU for cost lookup
        const productCostMap = {};
        products.forEach(p => {
          productCostMap[p.sku] = p.cost;
        });
        
        // Process transactions
        filteredTransactions.forEach(t => {
          const isFBM = t.fulfillment === 'Seller';
          const isFBA = t.fulfillment === 'Amazon';
          
          if (t.type === 'Order' || t.type === 'Refund') {
            const income = (t['product sales'] || 0) + (t['shipping credits'] || 0) + (t['gift wrap credits'] || 0) + (t['promotional rebates'] || 0);
            const fees = Math.abs(t['selling fees'] || 0) + Math.abs(t['fba fees'] || 0);
            const cost = (productCostMap[t.sku] || 0) * Math.abs(t.quantity || 1);
            
            if (isFBM && t.type === 'Order') {
              fbmIncome += income;
              fbmOpEx += fees;
              fbmProductCosts += cost;
            } else if (isFBA && t.type === 'Order') {
              fbaIncome += income;
              fbaOpEx += fees;
              fbaProductCosts += cost;
            } else if (isFBM && t.type === 'Refund') {
              fbmIncome += income; // Refunds are negative
              fbmOpEx += fees;
            } else if (isFBA && t.type === 'Refund') {
              fbaIncome += income; // Refunds are negative
              fbaOpEx += fees;
            }
          }
        });
        
        // Add shipping costs to FBM OpEx
        fbmOpEx += filteredShipping.reduce((sum, s) => sum + s.cost, 0);
        
        // Calculate ad spend (simplified - allocate product ads by SKU sales, brand ads proportionally)
        const skuSales = {};
        filteredTransactions.forEach(t => {
          if (t.type === 'Order' && t.sku) {
            if (!skuSales[t.sku]) skuSales[t.sku] = { fbm: 0, fba: 0 };
            const sales = t['product sales'] || 0;
            if (t.fulfillment === 'Seller') skuSales[t.sku].fbm += sales;
            if (t.fulfillment === 'Amazon') skuSales[t.sku].fba += sales;
          }
        });
        
        // Allocate product ad spend
        filteredProductAds.forEach(ad => {
          const skus = productCampaignToSkus[ad.campaign] || [];
          let totalFbm = 0, totalFba = 0;
          skus.forEach(sku => {
            if (skuSales[sku]) {
              totalFbm += skuSales[sku].fbm;
              totalFba += skuSales[sku].fba;
            }
          });
          const total = totalFbm + totalFba;
          if (total > 0) {
            fbmAdSpend += ad.spend * (totalFbm / total);
            fbaAdSpend += ad.spend * (totalFba / total);
          }
        });
        
        // Allocate brand ad spend proportionally
        const totalIncome = fbmIncome + fbaIncome;
        if (totalIncome > 0) {
          const brandAdTotal = filteredBrandAds.reduce((sum, ad) => sum + ad.spend, 0);
          fbmAdSpend += brandAdTotal * (fbmIncome / totalIncome);
          fbaAdSpend += brandAdTotal * (fbaIncome / totalIncome);
        }
        
        // Calculate profits
        const fbmProfit = fbmIncome - fbmOpEx - fbmProductCosts - fbmAdSpend;
        const fbaProfit = fbaIncome - fbaOpEx - fbaProductCosts - fbaAdSpend;
        
        console.log(`Chart data for ${startDate} to ${endDate}:`, {
          fbm: { income: fbmIncome, profit: fbmProfit },
          fba: { income: fbaIncome, profit: fbaProfit }
        });
        
        console.log(`Chart data for ${startDate} to ${endDate}:`, {
          fbm: { income: fbmIncome, profit: fbmProfit },
          fba: { income: fbaIncome, profit: fbaProfit }
        });
        
        // Calculate brand-level data
        const brandData = {};
        const targetBrands = ['BrightWay Educational', 'Hubbard Scientific', 'South of Kings', 'MapShop State Maps'];
        
        targetBrands.forEach(brandName => {
          const brandProducts = products.filter(p => p.brand === brandName);
          const brandSkus = brandProducts.map(p => p.sku);
          
          let income = 0, opex = 0, costs = 0, adSpend = 0;
          
          filteredTransactions.forEach(t => {
            if (brandSkus.includes(t.sku) && (t.type === 'Order' || t.type === 'Refund')) {
              income += (t['product sales'] || 0) + (t['shipping credits'] || 0) + (t['gift wrap credits'] || 0) + (t['promotional rebates'] || 0);
              opex += Math.abs(t['selling fees'] || 0) + Math.abs(t['fba fees'] || 0);
              costs += (productCostMap[t.sku] || 0) * Math.abs(t.quantity || 1);
            }
          });
          
          // Add brand's share of shipping
          const brandFbmSkus = brandProducts.filter(p => p.fulfillmentType === 'FBM').map(p => p.sku);
          opex += filteredShipping.filter(s => brandFbmSkus.includes(s.sku)).reduce((sum, s) => sum + s.cost, 0);
          
          // Allocate ad spend for this brand
          filteredProductAds.forEach(ad => {
            const skus = productCampaignToSkus[ad.campaign] || [];
            const overlap = skus.filter(s => brandSkus.includes(s));
            if (overlap.length > 0) {
              adSpend += ad.spend * (overlap.length / skus.length); // Simple split
            }
          });
          
          filteredBrandAds.forEach(ad => {
            if (brandCampaignToBrand[ad.campaign] === brandName) {
              adSpend += ad.spend;
            }
          });
          
          brandData[brandName] = {
            income,
            profit: income - opex - costs - adSpend
          };
        });
        
        return {
          data: {
            fbm: { income: fbmIncome, profit: fbmProfit },
            fba: { income: fbaIncome, profit: fbaProfit }
          },
          brands: targetBrands.map(name => ({
            brandName: name,
            total: brandData[name]
          }))
        };
        
      } catch (error) {
        console.error('Error processing month data:', error);
        return {
          data: {
            fbm: { income: 0, profit: 0 },
            fba: { income: 0, profit: 0 }
          },
          brands: []
        };
      }
    }
    
