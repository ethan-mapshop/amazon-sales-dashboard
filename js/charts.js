    async function loadChartsData() {
      if (!accessToken) {
        alert('Please sign in to view charts');
        return;
      }
      
      try {
        // Calculate 12-month date range ending at last complete month
        const today = new Date();
        const lastCompleteMonth = new Date(today.getFullYear(), today.getMonth() - 1, 1); // First day of last month
        const startDate = new Date(lastCompleteMonth);
        startDate.setMonth(startDate.getMonth() - 11); // Go back 11 more months (12 total)
        
        // Generate monthly data for the past 12 months
        const months = [];
        const currentDate = new Date(startDate);
        
        while (currentDate <= lastCompleteMonth) {
          months.push({
            label: currentDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }),
            year: currentDate.getFullYear(),
            month: currentDate.getMonth()
          });
          currentDate.setMonth(currentDate.getMonth() + 1);
        }
        
        console.log('Loading charts for months:', months.map(m => m.label).join(', '));
        
        // CACHE: Fetch all sheets ONCE at the beginning
        console.log('Fetching all sheet data (one-time load)...');
        const headers = { 'Authorization': `Bearer ${accessToken}` };
        
        // Fetch transaction data from KV, config from Google Sheets
        const [transactionsKV, shippingKV, productAdsKV, brandAdsKV, productsRes, productMappingRes, brandMappingRes] = await Promise.all([
          fetchFromKV('transactions'),
          fetchFromKV('shipping'),
          fetchFromKV('productads'),
          fetchFromKV('brandads'),
          fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Products`, { headers }),
          fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ProductAdMapping`, { headers }),
          fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/BrandAdMapping`, { headers })
        ]);
        
        // Convert KV format to Sheets format
        const transactionsData = kvToSheetsFormat(transactionsKV);
        const shippingData = kvToSheetsFormat(shippingKV);
        const productAdsData = kvToSheetsFormat(productAdsKV);
        const brandAdsData = kvToSheetsFormat(brandAdsKV);
        
        if (!productsRes.ok) throw new Error('Failed to load products');
        
        const [productsData, productMappingData, brandMappingData] = await Promise.all([
          productsRes.json(),
          productMappingRes.json(),
          brandMappingRes.json()
        ]);
        
        console.log('All sheets loaded, processing 12 months...');
        
        // Parse once
        const allTransactions = parseTransactions(transactionsData);
        const products = parseProducts(productsData);
        const productAds = parseProductAds(productAdsData);
        const brandAds = parseBrandAds(brandAdsData);
        const shippingCosts = parseShippingCosts(shippingData);
        
        // Parse mappings once
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
              if (!productCampaignToSkus[campaign]) productCampaignToSkus[campaign] = [];
              productCampaignToSkus[campaign].push(sku);
            }
          }
        }
        
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
        
        // Process each month using the cached data
        const monthlyData = [];
        for (let i = 0; i < months.length; i++) {
          const m = months[i];
          const monthStart = `${m.year}-${String(m.month + 1).padStart(2, '0')}-01`;
          const monthEnd = new Date(m.year, m.month + 1, 0);
          const monthEndStr = `${monthEnd.getFullYear()}-${String(monthEnd.getMonth() + 1).padStart(2, '0')}-${String(monthEnd.getDate()).padStart(2, '0')}`;
          
          console.log(`Processing ${m.label} (${i + 1}/${months.length})...`);
          
          const result = processMonthData(
            monthStart, 
            monthEndStr, 
            allTransactions, 
            products, 
            productAds, 
            brandAds, 
            shippingCosts,
            productCampaignToSkus,
            brandCampaignToBrand
          );
          
          monthlyData.push({ ...m, ...result });
        }
        
        // Cache monthly data for brand filtering
        cachedMonthlyData = monthlyData;
        
        // Render all charts
        renderCharts(monthlyData);
        
      } catch (error) {
        console.error('Error loading charts data:', error);
        alert('Error loading chart data. Please try again.');
      }
    }
    
    function renderCharts(monthlyData) {
      const labels = monthlyData.map(m => m.label);
      
      // Destroy existing charts
      Object.values(chartsInstances).forEach(chart => chart.destroy());
      chartsInstances = {};
      
      // Overall Revenue Trend
      const revenueData = monthlyData.map(m => m.data ? (m.data.fbm.income + m.data.fba.income) : 0);
      chartsInstances.revenue = new Chart(document.getElementById('revenueChart'), {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Revenue',
            data: revenueData,
            borderColor: '#10b981',
            backgroundColor: 'rgba(16, 185, 129, 0.1)',
            tension: 0.4,
            fill: true
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: {
            legend: { display: false }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                callback: function(value) {
                  return '$' + value.toLocaleString();
                }
              }
            }
          }
        }
      });
      
      // Overall Profitability Trend
      const profitData = monthlyData.map(m => m.data ? (m.data.fbm.profit + m.data.fba.profit) : 0);
      chartsInstances.profit = new Chart(document.getElementById('profitChart'), {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: 'Profit',
            data: profitData,
            borderColor: '#3b82f6',
            backgroundColor: 'rgba(59, 130, 246, 0.1)',
            tension: 0.4,
            fill: true
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: {
            legend: { display: false }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                callback: function(value) {
                  return '$' + value.toLocaleString();
                }
              }
            }
          }
        }
      });
      
      // Revenue by Channel
      const fbmRevenueData = monthlyData.map(m => m.data ? m.data.fbm.income : 0);
      const fbaRevenueData = monthlyData.map(m => m.data ? m.data.fba.income : 0);
      chartsInstances.revenueChannel = new Chart(document.getElementById('revenueChannelChart'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'FBM',
              data: fbmRevenueData,
              borderColor: '#60a5fa',
              backgroundColor: 'rgba(96, 165, 250, 0.1)',
              tension: 0.4
            },
            {
              label: 'FBA',
              data: fbaRevenueData,
              borderColor: '#f97316',
              backgroundColor: 'rgba(249, 115, 22, 0.1)',
              tension: 0.4
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                callback: function(value) {
                  return '$' + value.toLocaleString();
                }
              }
            }
          }
        }
      });
      
      // Profit by Channel
      const fbmProfitData = monthlyData.map(m => m.data ? m.data.fbm.profit : 0);
      const fbaProfitData = monthlyData.map(m => m.data ? m.data.fba.profit : 0);
      chartsInstances.profitChannel = new Chart(document.getElementById('profitChannelChart'), {
        type: 'line',
        data: {
          labels,
          datasets: [
            {
              label: 'FBM',
              data: fbmProfitData,
              borderColor: '#60a5fa',
              backgroundColor: 'rgba(96, 165, 250, 0.1)',
              tension: 0.4
            },
            {
              label: 'FBA',
              data: fbaProfitData,
              borderColor: '#f97316',
              backgroundColor: 'rgba(249, 115, 22, 0.1)',
              tension: 0.4
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                callback: function(value) {
                  return '$' + value.toLocaleString();
                }
              }
            }
          }
        }
      });
      
      // Revenue by Brand
      const targetBrands = ['BrightWay Educational', 'Hubbard Scientific', 'South of Kings', 'MapShop State Maps'];
      const brandColors = ['#10b981', '#3b82f6', '#f59e0b', '#ec4899'];
      
      const brandRevenueDatasets = targetBrands.map((brandName, idx) => ({
        label: brandName,
        data: monthlyData.map(m => {
          const brand = m.brands?.find(b => b.brandName === brandName);
          return brand ? brand.total.income : 0;
        }),
        borderColor: brandColors[idx],
        tension: 0.4
      }));
      
      chartsInstances.revenueBrand = new Chart(document.getElementById('revenueBrandChart'), {
        type: 'line',
        data: {
          labels,
          datasets: brandRevenueDatasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: {
            legend: {
              display: true,
              position: 'top',
              labels: {
                boxWidth: 12,
                padding: 15,
                font: {
                  size: 11
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                callback: function(value) {
                  return '$' + value.toLocaleString();
                }
              }
            }
          }
        }
      });
      
      // Profit by Brand
      const brandProfitDatasets = targetBrands.map((brandName, idx) => ({
        label: brandName,
        data: monthlyData.map(m => {
          const brand = m.brands?.find(b => b.brandName === brandName);
          return brand ? brand.total.profit : 0;
        }),
        borderColor: brandColors[idx],
        tension: 0.4
      }));
      
      chartsInstances.profitBrand = new Chart(document.getElementById('profitBrandChart'), {
        type: 'line',
        data: {
          labels,
          datasets: brandProfitDatasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: {
            legend: {
              display: true,
              position: 'top',
              labels: {
                boxWidth: 12,
                padding: 15,
                font: {
                  size: 11
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                callback: function(value) {
                  return '$' + value.toLocaleString();
                }
              }
            }
          }
        }
      });
      
      console.log('Charts rendered successfully');
    }
    
    // Update brand charts based on filter selection
    function updateBrandCharts() {
      const filter = document.getElementById('brand-chart-filter').value;
      
      if (!cachedMonthlyData || cachedMonthlyData.length === 0) {
        console.warn('No cached data available');
        return;
      }
      
      const labels = cachedMonthlyData.map(m => m.label);
      const targetBrands = filter === 'all' 
        ? ['BrightWay Educational', 'Hubbard Scientific', 'South of Kings', 'MapShop State Maps']
        : [filter];
      const brandColors = ['#10b981', '#3b82f6', '#f59e0b', '#ec4899'];
      
      // Destroy existing brand charts
      if (chartsInstances.revenueBrand) chartsInstances.revenueBrand.destroy();
      if (chartsInstances.profitBrand) chartsInstances.profitBrand.destroy();
      
      // Revenue by Brand
      const brandRevenueDatasets = targetBrands.map((brandName, idx) => ({
        label: brandName,
        data: cachedMonthlyData.map(m => {
          const brand = m.brands?.find(b => b.brandName === brandName);
          return brand ? brand.total.income : 0;
        }),
        borderColor: brandColors[idx],
        tension: 0.4
      }));
      
      chartsInstances.revenueBrand = new Chart(document.getElementById('revenueBrandChart'), {
        type: 'line',
        data: {
          labels,
          datasets: brandRevenueDatasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: {
            legend: {
              display: targetBrands.length > 1, // Only show legend if multiple brands
              position: 'top',
              labels: {
                boxWidth: 12,
                padding: 15,
                font: {
                  size: 11
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                callback: function(value) {
                  return '$' + value.toLocaleString();
                }
              }
            }
          }
        }
      });
      
      // Profit by Brand
      const brandProfitDatasets = targetBrands.map((brandName, idx) => ({
        label: brandName,
        data: cachedMonthlyData.map(m => {
          const brand = m.brands?.find(b => b.brandName === brandName);
          return brand ? brand.total.profit : 0;
        }),
        borderColor: brandColors[idx],
        tension: 0.4
      }));
      
      chartsInstances.profitBrand = new Chart(document.getElementById('profitBrandChart'), {
        type: 'line',
        data: {
          labels,
          datasets: brandProfitDatasets
        },
        options: {
          responsive: true,
          maintainAspectRatio: true,
          plugins: {
            legend: {
              display: targetBrands.length > 1, // Only show legend if multiple brands
              position: 'top',
              labels: {
                boxWidth: 12,
                padding: 15,
                font: {
                  size: 11
                }
              }
            }
          },
          scales: {
            y: {
              beginAtZero: true,
              ticks: {
                callback: function(value) {
                  return '$' + value.toLocaleString();
                }
              }
            }
          }
        }
      });
      
      console.log('Brand charts updated for filter:', filter);
    }
    
