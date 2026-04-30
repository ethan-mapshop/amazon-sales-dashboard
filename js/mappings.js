
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
      // Pulls the products list from the Upstash catalog (same source
      // every other dashboard page uses). The Campaign Mapping page
      // shows every product regardless of `type` — variations and
      // children all need to be pickable as ad-mapping targets.
      const response = await fetch('/api/products?action=get', {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });

      if (!response.ok) throw new Error('Failed to load products');

      const data = await response.json();
      const list = Array.isArray(data.products) ? data.products : [];

      products = [];
      const brandSet = new Set();
      for (const p of list) {
        if (!p?.sku) continue;
        products.push({ sku: p.sku, brand: p.brand || '', name: p.name || '' });
        if (p.brand) brandSet.add(p.brand);
      }
      brands = Array.from(brandSet).sort();
    }

    // Walks the SP / SB ad-spend rows in Upstash and pulls out every
    // distinct campaign name ever seen. Replaces the old "read the
    // ProductAdSpend / BrandAdSpend tabs from Sheets" approach. We use
    // a deliberately wide month range (2020-01 → 2099-12) so the API's
    // index filter returns every synced month — adding new months
    // doesn't require touching this code.
    async function _loadAdSpendCampaigns(type) {
      const url = `/api/adspend?action=get-range&type=${type}&startMonth=2020-01&endMonth=2099-12`;
      const response = await fetch(url, {
        headers: { 'Authorization': `Bearer ${accessToken}` }
      });
      if (!response.ok) throw new Error(`Failed to load ${type} campaigns`);
      const data = await response.json();
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const set = new Set();
      for (const r of rows) {
        const c = (r?.campaign || '').toString().trim();
        if (c) set.add(c);
      }
      return Array.from(set).sort();
    }

    async function loadProductCampaigns() {
      campaigns.product = await _loadAdSpendCampaigns('sp');
    }

    async function loadBrandCampaigns() {
      campaigns.brand = await _loadAdSpendCampaigns('sb');
    }
    
    // Mappings now live in Upstash. The local shape (mappings.product /
    // mappings.brand dicts keyed by campaign) is unchanged; the API returns
    // the already-grouped shape directly.
    async function loadProductMappings() {
      try {
        const res = await fetch('/api/mappings?action=get&type=product', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!res.ok) { mappings.product = {}; return; }
        const data = await res.json();
        mappings.product = data.mappings || {};
      } catch (e) {
        console.error('loadProductMappings failed:', e);
        mappings.product = {};
      }
    }

    async function loadBrandMappings() {
      try {
        const res = await fetch('/api/mappings?action=get&type=brand', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!res.ok) { mappings.brand = {}; return; }
        const data = await res.json();
        mappings.brand = data.mappings || {};
      } catch (e) {
        console.error('loadBrandMappings failed:', e);
        mappings.brand = {};
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
    
    // Saves go through /api/mappings. save-one atomically replaces the
    // campaign's entry in the Upstash dict — no more delete-then-append dance.
    async function saveProductMapping(campaign) {
      const mapping = mappings.product[campaign];
      if (!mapping) return;
      try {
        const res = await fetch('/api/mappings?action=save-one&type=product', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            campaign,
            brand: mapping.brand || '',
            skus: mapping.skus || []
          })
        });
        const result = await res.json();
        if (!res.ok || !result.success) throw new Error(result.error || `Save failed (${res.status})`);

        // Saving with empty brand + empty skus deletes the entry on the API
        // side; mirror that locally so the campaign re-reads as "Unmapped".
        if (!mapping.brand && (!mapping.skus || mapping.skus.length === 0)) {
          delete mappings.product[campaign];
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
      try {
        const res = await fetch('/api/mappings?action=save-one&type=brand', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ campaign, brand: brand || '' })
        });
        const result = await res.json();
        if (!res.ok || !result.success) throw new Error(result.error || `Save failed (${res.status})`);

        if (!brand) delete mappings.brand[campaign];

        alert('Brand mapping saved!');
        renderBrandCampaigns(document.getElementById('brand-search').value);
        updateStats('brand');
      } catch (error) {
        alert('Failed to save mapping: ' + error.message);
      }
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
    
