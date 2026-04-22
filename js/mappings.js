
    // MAPPING INTERFACE
    async function loadMappingData() {
      console.log('Loading mapping data...');
      
      // Show loading state
      document.getElementById('product-campaigns-list').innerHTML = 
        '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">Loading campaigns...</div>';
      document.getElementById('brand-campaigns-list').innerHTML = 
        '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">Loading campaigns...</div>';
      
      try {
        // Load products, brands, campaigns, and mappings in parallel
        await Promise.all([
          loadProducts(),
          loadProductCampaigns(),
          loadBrandCampaigns(),
          loadProductMappings(),
          loadBrandMappings()
        ]);
        
        console.log('Data loaded:', {
          products: products.length,
          brands: brands.length,
          productCampaigns: campaigns.product.length,
          brandCampaigns: campaigns.brand.length,
          productMappings: Object.keys(mappings.product).length,
          brandMappings: Object.keys(mappings.brand).length
        });
        
        renderProductCampaigns();
        renderBrandCampaigns();
        updateStats('product');
        updateStats('brand');
        
      } catch (error) {
        console.error('Error loading mapping data:', error);
        
        // Show error in the UI
        document.getElementById('product-campaigns-list').innerHTML = 
          `<div style="padding: 2rem; text-align: center; color: var(--error);">
            Error loading data: ${error.message}<br>
            <button class="btn btn-secondary" onclick="loadMappingData()" style="margin-top: 1rem;">Retry</button>
          </div>`;
        
        document.getElementById('brand-campaigns-list').innerHTML = 
          `<div style="padding: 2rem; text-align: center; color: var(--error);">
            Error loading data: ${error.message}<br>
            <button class="btn btn-secondary" onclick="loadMappingData()" style="margin-top: 1rem;">Retry</button>
          </div>`;
      }
    }
    
    async function loadProducts() {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Products`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      if (!response.ok) throw new Error('Failed to load products');
      
      const data = await response.json();
      const rows = data.values || [];
      
      if (rows.length > 1) {
        const headers = rows[0];
        const skuIndex = headers.indexOf('sku');
        const brandIndex = headers.indexOf('brand');
        const nameIndex = headers.indexOf('name');
        
        products = [];
        brands = new Set();
        
        for (let i = 1; i < rows.length; i++) {
          const sku = rows[i][skuIndex];
          const brand = rows[i][brandIndex];
          const name = rows[i][nameIndex];
          
          if (sku) {
            products.push({ sku, brand, name });
          }
          if (brand) {
            brands.add(brand);
          }
        }
        
        brands = Array.from(brands).sort();
      }
    }
    
    async function loadProductCampaigns() {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ProductAdSpend`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      if (!response.ok) throw new Error('Failed to load product campaigns');
      
      const data = await response.json();
      const rows = data.values || [];
      
      if (rows.length > 1) {
        const headers = rows[0];
        const campaignIndex = headers.indexOf('Campaign Name');
        
        const campaignSet = new Set();
        for (let i = 1; i < rows.length; i++) {
          const campaign = rows[i][campaignIndex];
          if (campaign) campaignSet.add(campaign);
        }
        
        campaigns.product = Array.from(campaignSet).sort();
      }
    }
    
    async function loadBrandCampaigns() {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/BrandAdSpend`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      if (!response.ok) throw new Error('Failed to load brand campaigns');
      
      const data = await response.json();
      const rows = data.values || [];
      
      if (rows.length > 1) {
        const headers = rows[0];
        const campaignIndex = headers.indexOf('Campaign Name');
        
        const campaignSet = new Set();
        for (let i = 1; i < rows.length; i++) {
          const campaign = rows[i][campaignIndex];
          if (campaign) campaignSet.add(campaign);
        }
        
        campaigns.brand = Array.from(campaignSet).sort();
      }
    }
    
    async function loadProductMappings() {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ProductAdMapping`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      if (!response.ok) {
        mappings.product = {};
        return;
      }
      
      const data = await response.json();
      const rows = data.values || [];
      
      mappings.product = {};
      
      if (rows.length > 1) {
        const headers = rows[0];
        const campaignIndex = headers.indexOf('Campaign Name');
        const brandIndex = headers.indexOf('Brand');
        const skuIndex = headers.indexOf('SKU');
        
        for (let i = 1; i < rows.length; i++) {
          const campaign = rows[i][campaignIndex];
          const brand = rows[i][brandIndex];
          const sku = rows[i][skuIndex];
          
          if (!campaign) continue;
          
          if (!mappings.product[campaign]) {
            mappings.product[campaign] = { brand: '', skus: [] };
          }
          
          if (brand) mappings.product[campaign].brand = brand;
          if (sku) mappings.product[campaign].skus.push(sku);
        }
      }
    }
    
    async function loadBrandMappings() {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/BrandAdMapping`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      if (!response.ok) {
        mappings.brand = {};
        return;
      }
      
      const data = await response.json();
      const rows = data.values || [];
      
      mappings.brand = {};
      
      if (rows.length > 1) {
        const headers = rows[0];
        const campaignIndex = headers.indexOf('Campaign Name');
        const brandIndex = headers.indexOf('Brand');
        
        for (let i = 1; i < rows.length; i++) {
          const campaign = rows[i][campaignIndex];
          const brand = rows[i][brandIndex];
          
          if (campaign && brand) {
            mappings.brand[campaign] = brand;
          }
        }
      }
    }
    
    function renderProductCampaigns(searchTerm = '') {
      const container = document.getElementById('product-campaigns-list');
      const filter = currentFilter.product;
      
      // Get all unique campaigns from both ad spend and mappings
      const allCampaigns = new Set([...campaigns.product, ...Object.keys(mappings.product)]);
      let filtered = Array.from(allCampaigns).sort();
      
      if (searchTerm) {
        filtered = filtered.filter(c => c.toLowerCase().includes(searchTerm.toLowerCase()));
      }
      
      if (filter === 'mapped') {
        filtered = filtered.filter(c => {
          const m = mappings.product[c];
          return m && (m.brand || m.skus.length > 0);
        });
      } else if (filter === 'unmapped') {
        filtered = filtered.filter(c => {
          const m = mappings.product[c];
          return !m || (!m.brand && m.skus.length === 0);
        });
      }
      
      if (filtered.length === 0) {
        container.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">No campaigns found</div>';
        return;
      }
      
      container.innerHTML = filtered.map(campaign => {
        const mapped = mappings.product[campaign];
        const isMapped = mapped && (mapped.brand || mapped.skus.length > 0);
        const isSelected = selectedCampaign.product === campaign;
        
        return `
          <div class="campaign-item ${isSelected ? 'selected' : ''} ${!isMapped ? 'unmapped' : ''}" 
               onclick="selectProductCampaign('${campaign.replace(/'/g, "\\'")}')">
            <div class="campaign-name">${campaign}</div>
            <div class="campaign-meta">
              ${isMapped ? `Brand: ${mapped.brand || 'None'} • ${mapped.skus.length} SKU(s)` : 'Unmapped'}
            </div>
          </div>
        `;
      }).join('');
    }
    
    function renderBrandCampaigns(searchTerm = '') {
      const container = document.getElementById('brand-campaigns-list');
      const filter = currentFilter.brand;
      
      // Get all unique campaigns from both ad spend and mappings
      const allCampaigns = new Set([...campaigns.brand, ...Object.keys(mappings.brand)]);
      let filtered = Array.from(allCampaigns).sort();
      
      if (searchTerm) {
        filtered = filtered.filter(c => c.toLowerCase().includes(searchTerm.toLowerCase()));
      }
      
      if (filter === 'mapped') {
        filtered = filtered.filter(c => mappings.brand[c]);
      } else if (filter === 'unmapped') {
        filtered = filtered.filter(c => !mappings.brand[c]);
      }
      
      if (filtered.length === 0) {
        container.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">No campaigns found</div>';
        return;
      }
      
      container.innerHTML = filtered.map(campaign => {
        const brand = mappings.brand[campaign];
        const isMapped = !!brand;
        const isSelected = selectedCampaign.brand === campaign;
        
        return `
          <div class="campaign-item ${isSelected ? 'selected' : ''} ${!isMapped ? 'unmapped' : ''}" 
               onclick="selectBrandCampaign('${campaign.replace(/'/g, "\\'")}')">
            <div class="campaign-name">${campaign}</div>
            <div class="campaign-meta">
              ${isMapped ? `Brand: ${brand}` : 'Unmapped'}
            </div>
          </div>
        `;
      }).join('');
    }
    
    function selectProductCampaign(campaign) {
      selectedCampaign.product = campaign;
      renderProductCampaigns(document.getElementById('product-search').value);
      showProductEditor(campaign);
    }
    
    function selectBrandCampaign(campaign) {
      selectedCampaign.brand = campaign;
      renderBrandCampaigns(document.getElementById('brand-search').value);
      showBrandEditor(campaign);
    }
    
    function showProductEditor(campaign) {
      const editor = document.getElementById('product-editor');
      const mapping = mappings.product[campaign] || { brand: '', skus: [] };
      
      editor.innerHTML = `
        <div class="card" style="margin: 0;">
          <h3 style="margin-bottom: 1.5rem; font-size: 1.125rem;">${campaign}</h3>
          
          <div class="config-group">
            <label>Brand</label>
            <select id="product-brand-select" onchange="updateProductBrand('${campaign.replace(/'/g, "\\'")}', this.value)">
              <option value="">-- Select Brand --</option>
              ${brands.map(b => `<option value="${b}" ${b === mapping.brand ? 'selected' : ''}>${b}</option>`).join('')}
            </select>
          </div>
          
          <div class="config-group">
            <label>Products (SKUs)</label>
            <div class="tag-input-container">
              <div class="tags" id="product-sku-tags" onclick="document.getElementById('product-sku-input').focus()">
                ${mapping.skus.map(sku => `
                  <div class="tag">
                    <span>${sku}</span>
                    <span class="tag-remove" onclick="removeProductSku('${campaign.replace(/'/g, "\\'")}', '${sku}')">✕</span>
                  </div>
                `).join('')}
                <input 
                  type="text" 
                  class="tag-input" 
                  id="product-sku-input" 
                  placeholder="Type SKU or search..."
                  onkeydown="handleProductSkuInput(event, '${campaign.replace(/'/g, "\\'")}')"
                  oninput="showProductSkuSuggestions(this.value)"
                >
              </div>
              <div class="tag-suggestions" id="product-sku-suggestions"></div>
            </div>
            <p class="hint">${mapping.skus.length} SKU(s) mapped</p>
          </div>
          
          <div class="button-group">
            <button class="btn btn-primary" onclick="saveProductMapping('${campaign.replace(/'/g, "\\'")}')">
              Save Mapping
            </button>
          </div>
        </div>
      `;
    }
    
    function showBrandEditor(campaign) {
      const editor = document.getElementById('brand-editor');
      const brand = mappings.brand[campaign] || '';
      
      editor.innerHTML = `
        <div class="card" style="margin: 0;">
          <h3 style="margin-bottom: 1.5rem; font-size: 1.125rem;">${campaign}</h3>
          
          <div class="config-group">
            <label>Brand</label>
            <select id="brand-select" onchange="updateBrandMapping('${campaign.replace(/'/g, "\\'")}', this.value)">
              <option value="">-- Select Brand --</option>
              ${brands.map(b => `<option value="${b}" ${b === brand ? 'selected' : ''}>${b}</option>`).join('')}
            </select>
          </div>
          
          <div class="button-group">
            <button class="btn btn-primary" onclick="saveBrandMapping('${campaign.replace(/'/g, "\\'")}')">
              Save Mapping
            </button>
          </div>
        </div>
      `;
    }
    
    function updateProductBrand(campaign, brand) {
      if (!mappings.product[campaign]) {
        mappings.product[campaign] = { brand: '', skus: [] };
      }
      mappings.product[campaign].brand = brand;
    }
    
    function handleProductSkuInput(event, campaign) {
      if (event.key === 'Enter') {
        event.preventDefault();
        const input = event.target;
        const sku = input.value.trim();
        if (sku) {
          addProductSku(campaign, sku);
          input.value = '';
          document.getElementById('product-sku-suggestions').classList.remove('active');
        }
      } else if (event.key === 'Escape') {
        document.getElementById('product-sku-suggestions').classList.remove('active');
      }
    }
    
    function showProductSkuSuggestions(searchTerm) {
      const container = document.getElementById('product-sku-suggestions');
      
      if (!searchTerm) {
        container.classList.remove('active');
        return;
      }
      
      const filtered = products.filter(p => 
        p.sku.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.name.toLowerCase().includes(searchTerm.toLowerCase())
      ).slice(0, 10);
      
      if (filtered.length === 0) {
        container.classList.remove('active');
        return;
      }
      
      container.innerHTML = filtered.map(p => `
        <div class="tag-suggestion" onclick="addProductSkuFromSuggestion('${p.sku}')">
          <strong>${p.sku}</strong> - ${p.name}
        </div>
      `).join('');
      
      container.classList.add('active');
    }
    
    function addProductSkuFromSuggestion(sku) {
      const campaign = selectedCampaign.product;
      if (!campaign) return;
      
      addProductSku(campaign, sku);
      document.getElementById('product-sku-input').value = '';
      document.getElementById('product-sku-suggestions').classList.remove('active');
      document.getElementById('product-sku-input').focus();
    }
    
    function addProductSku(campaign, sku) {
      if (!mappings.product[campaign]) {
        mappings.product[campaign] = { brand: '', skus: [] };
      }
      
      if (!mappings.product[campaign].skus.includes(sku)) {
        mappings.product[campaign].skus.push(sku);
        showProductEditor(campaign);
      }
    }
    
    function removeProductSku(campaign, sku) {
      if (mappings.product[campaign]) {
        mappings.product[campaign].skus = mappings.product[campaign].skus.filter(s => s !== sku);
        showProductEditor(campaign);
      }
    }
    
    function updateBrandMapping(campaign, brand) {
      mappings.brand[campaign] = brand;
    }
    
    async function saveProductMapping(campaign) {
      const mapping = mappings.product[campaign];
      if (!mapping) return;
      
      try {
        // Delete existing mappings for this campaign
        await deleteProductMappings(campaign);
        
        // Add new mappings (one row per SKU)
        if (mapping.brand || mapping.skus.length > 0) {
          const rows = mapping.skus.length > 0
            ? mapping.skus.map(sku => [campaign, mapping.brand || '', sku])
            : [[campaign, mapping.brand, '']];
          
          const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ProductAdMapping:append?valueInputOption=RAW`;
          await fetch(url, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values: rows })
          });
        }
        
        alert('Product mapping saved!');
        renderProductCampaigns(document.getElementById('product-search').value);
        updateStats('product');
        
      } catch (error) {
        alert('Failed to save mapping: ' + error.message);
      }
    }
    
    async function saveBrandMapping(campaign) {
      const brand = mappings.brand[campaign];
      if (!brand) return;
      
      try {
        // Delete existing mapping for this campaign
        await deleteBrandMappings(campaign);
        
        // Add new mapping
        const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/BrandAdMapping:append?valueInputOption=RAW`;
        await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ values: [[campaign, brand]] })
        });
        
        alert('Brand mapping saved!');
        renderBrandCampaigns(document.getElementById('brand-search').value);
        updateStats('brand');
        
      } catch (error) {
        alert('Failed to save mapping: ' + error.message);
      }
    }
    
    async function deleteProductMappings(campaign) {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ProductAdMapping`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      const data = await response.json();
      const rows = data.values || [];
      
      // If sheet is empty or only has headers, nothing to delete
      if (rows.length <= 1) {
        // Make sure headers exist
        if (rows.length === 0) {
          const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ProductAdMapping?valueInputOption=RAW`;
          await fetch(updateUrl, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values: [['Campaign Name', 'Brand', 'SKU']] })
          });
        }
        return;
      }
      
      const headers = rows[0];
      const campaignIndex = headers.findIndex(h => h.toLowerCase().includes('campaign name'));
      
      if (campaignIndex === -1) return;
      
      const filteredRows = [headers];
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][campaignIndex] !== campaign) {
          filteredRows.push(rows[i]);
        }
      }
      
      // Clear and rewrite with headers always included
      const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ProductAdMapping:clear`;
      await fetch(clearUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      // Always write back at least the headers
      const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ProductAdMapping?valueInputOption=RAW`;
      await fetch(updateUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: filteredRows })
      });
    }
    
    async function deleteBrandMappings(campaign) {
      const url = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/BrandAdMapping`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      
      const data = await response.json();
      const rows = data.values || [];
      
      // If sheet is empty or only has headers, nothing to delete
      if (rows.length <= 1) {
        // Make sure headers exist
        if (rows.length === 0) {
          const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/BrandAdMapping?valueInputOption=RAW`;
          await fetch(updateUrl, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values: [['Campaign Name', 'Brand']] })
          });
        }
        return;
      }
      
      const headers = rows[0];
      const campaignIndex = headers.findIndex(h => h.toLowerCase().includes('campaign name'));
      
      if (campaignIndex === -1) return;
      
      const filteredRows = [headers];
      for (let i = 1; i < rows.length; i++) {
        if (rows[i][campaignIndex] !== campaign) {
          filteredRows.push(rows[i]);
        }
      }
      
      // Clear and rewrite with headers always included
      const clearUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/BrandAdMapping:clear`;
      await fetch(clearUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });
      
      // Always write back at least the headers
      const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/BrandAdMapping?valueInputOption=RAW`;
      await fetch(updateUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ values: filteredRows })
      });
    }
    
    function updateStats(type) {
      // Get all unique campaigns from BOTH ad spend data and mappings
      const allCampaigns = new Set([
        ...campaigns[type],
        ...Object.keys(mappings[type])
      ]);
      
      const total = allCampaigns.size;
      
      console.log(`${type} - campaigns from ad spend:`, campaigns[type].length);
      console.log(`${type} - campaigns from mappings:`, Object.keys(mappings[type]).length);
      console.log(`${type} - total unique:`, total);
      
      // Count how many have valid mappings
      const mapped = Array.from(allCampaigns).filter(campaign => {
        if (type === 'product') {
          const m = mappings[type][campaign];
          return m && (m.brand || m.skus.length > 0);
        } else {
          return mappings[type][campaign];
        }
      }).length;
      
      const unmapped = total - mapped;
      
      console.log(`Updating ${type} stats:`, { total, mapped, unmapped });
      
      document.getElementById(`${type}-total-count`).textContent = total;
      document.getElementById(`${type}-mapped-count`).textContent = mapped;
      document.getElementById(`${type}-unmapped-count`).textContent = unmapped;
    }
    
    // Search functionality
    document.getElementById('product-search').addEventListener('input', (e) => {
      renderProductCampaigns(e.target.value);
    });
    
    document.getElementById('brand-search').addEventListener('input', (e) => {
      renderBrandCampaigns(e.target.value);
    });
    
    // Filter tabs
    document.querySelectorAll('#product-mapping .filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#product-mapping .filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentFilter.product = tab.dataset.filter;
        renderProductCampaigns(document.getElementById('product-search').value);
      });
    });
    
    document.querySelectorAll('#brand-mapping .filter-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('#brand-mapping .filter-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        currentFilter.brand = tab.dataset.filter;
        renderBrandCampaigns(document.getElementById('brand-search').value);
      });
    });
    
    // OVERVIEW PAGE
    // Helper function to format numbers with thousands separators
    function formatNumber(num) {
      return num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    
