    // Upload-page configs. Transactions / shipping / ad-spend types
    // were removed once those data sources moved to API-driven syncs
    // (SP-API + ShipStation + Amazon Ads API on the monthly cron).
    // The remaining three types still flow through the upload page
    // because they're user-edited rather than pulled from an API.
    const SHEET_CONFIGS = {
      products: {
        sheetName: 'Products',
        uniqueKey: 'sku',
        requiredColumns: ['sku'],
        skipRows: 0,
        allowUpdates: true
      },
      productadmapping: {
        sheetName: 'ProductAdMapping',
        uniqueKey: null,
        requiredColumns: ['Campaign Name'],
        skipRows: 0,
        allowUpdates: false
      },
      brandadmapping: {
        sheetName: 'BrandAdMapping',
        uniqueKey: null,
        requiredColumns: ['Campaign Name'],
        skipRows: 0,
        allowUpdates: false
      }
    };

    let uploadedData = {};
    let accessToken = null;
    let tokenClient = null;
    let lastUpdatedAt = ''; // For Phase 3 - timestamp of last data refresh
    
    // PHASE 1 STUB FUNCTIONS
    function triggerRefresh() {
      // Phase 3: Will call /api/refresh endpoint
      console.log('Refresh triggered - will be implemented in Phase 3');
      alert('Manual refresh will be available in Phase 3');
    }
    
    function toggleChat() {
      // Phase 5: Will toggle chat panel
      console.log('Chat toggle - will be implemented in Phase 5');
    }
    
    // Hardcoded configuration
    const SPREADSHEET_ID = '10EDxzRhOdmu2ldvYHpoVSI0iuJoucy7OZFjM8sfgs80';
    const DEFAULT_CLIENT_ID = '617399879817-55qv09jv9h3qqkthr7ic6m3beiirvp8u.apps.googleusercontent.com';
    
    let config = {
      clientId: localStorage.getItem('customClientId') || DEFAULT_CLIENT_ID,
      spreadsheetId: SPREADSHEET_ID
    };

    // Mapping data
    let campaigns = { product: [], brand: [] };
    let mappings = { product: {}, brand: {} };
    let products = [];
    let brands = [];
    let currentFilter = { product: 'all', brand: 'all' };
    let selectedCampaign = { product: null, brand: null };

    // ── SHARED PRODUCT-LABEL DISAMBIGUATION ──────────────────────────────────
    // Used by the Sales & Volume product dropdown, the Listing
    // Optimization Change Log dropdown, and the Session & CVR dropdown.
    // Two-pass labeler:
    //   1. If a product's name appears under more than one brand in
    //      the visible set, append " - <brand-short>" so the user
    //      can tell them apart.
    //   2. If a product's name + brand combination appears more than
    //      once (i.e. FBA + FBM versions of the same product), append
    //      " (FBA)" or " (FBM)" — after the brand suffix if both apply.
    // Brand shortener falls back to "Oth" for anything not in the map.
    const PRODUCT_BRAND_SHORT = {
      'South of Kings':       'SoK',
      'Hubbard Scientific':   'RR',
      'BrightWay Educational': 'BW',
      'MapShop State Maps':   'TMS'
    };
    function productBrandShort(brand) {
      return PRODUCT_BRAND_SHORT[brand] || 'Oth';
    }
    function isFbaProductRecord(p) {
      const f = String(p?.fulfillment || '').trim().toLowerCase();
      return f === 'amazon' || f === 'afn' || f === 'fba';
    }
    // Returns Map<keyValue, label> keyed by `p[keyField]`. Defaults to
    // 'sku' for backwards-compat with the Sales & Volume callsite;
    // Listing Optimization passes 'asin' since that's its dropdown
    // value.
    function buildDisambiguatedProductLabels(products, keyField = 'sku') {
      const byName = {};
      for (const p of products) {
        if (!byName[p.name]) byName[p.name] = [];
        byName[p.name].push(p);
      }
      const labels = new Map();
      for (const p of products) {
        const sameName       = byName[p.name];
        const crossBrand     = sameName.length > 1 && sameName.some(x => x.brand !== p.brand);
        const sameNameBrand  = sameName.filter(x => x.brand === p.brand);
        const dupFulfillment = sameNameBrand.length > 1;
        let label = p.name;
        if (crossBrand)     label += ` - ${productBrandShort(p.brand)}`;
        if (dupFulfillment) label += ` (${isFbaProductRecord(p) ? 'FBA' : 'FBM'})`;
        labels.set(p[keyField], label);
      }
      return labels;
    }

    // Page navigation
    function showPage(pageName) {
      // Hide all pages
      document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      
      // Remove active from all sidebar nav items
      document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
      
      // Show the requested page
      document.getElementById(`${pageName}-page`).classList.add('active');
      
      // Set active sidebar item by onclick attribute
      document.querySelectorAll('.nav-item').forEach(item => {
        const onclick = item.getAttribute('onclick');
        if (onclick && onclick.includes(`'${pageName}'`)) {
          item.classList.add('active');
        }
      });
      
      // Save current page to localStorage
      localStorage.setItem('currentPage', pageName);
      
      // Page-specific initialization
      if (pageName === 'mapping' && accessToken) {
        loadMappingData();
      }
      
      if (pageName === 'overview') {
        // showMonthlyV2024() handles its own auto-load via the first-view
        // flag. The Sheets/Upstash tabs were retired — Monthly Profitability
        // is the v2024-backed tab, default-active for the Overview page.
        showMonthlyV2024();
      }

      if (pageName === 'catalog' && accessToken) {
        loadProductCatalog();
      }
      
if (pageName === 'salesvolume' && accessToken) {
        loadSalesVolumeData();
      }
      
      if (pageName === 'integrations' && accessToken) {
        loadCredentialStatus(); // Load credential status
      }
      
      if (pageName === 'listing' && accessToken) {
        loadChangeLogASINs(); // Load ASINs for dropdown
        loadChangeLog(); // Load change log table
      }
    }
    
    // Client ID management
    function showClientIdChange() {
      document.getElementById('clientIdChange').style.display = 'block';
      const customId = localStorage.getItem('customClientId');
      if (customId && customId !== DEFAULT_CLIENT_ID) {
        document.getElementById('customClientId').value = customId;
      }
    }
    
    function cancelClientIdChange() {
      document.getElementById('clientIdChange').style.display = 'none';
      document.getElementById('customClientId').value = '';
    }
    
    function saveCustomClientId() {
      const newClientId = document.getElementById('customClientId').value.trim();
      if (!newClientId) {
        alert('Please enter a valid Client ID');
        return;
      }
      localStorage.setItem('customClientId', newClientId);
      config.clientId = newClientId;
      document.getElementById('clientIdDisplay').innerHTML = `
        <span>Custom client configured ✓</span>
        <button class="btn btn-secondary" onclick="showClientIdChange()" style="padding: 0.5rem 1rem; font-size: 0.8rem;">Change</button>
      `;
      cancelClientIdChange();
      tokenClient = null;
      initializeGoogleAuth();
      alert('Client ID updated! Please sign in again.');
    }
    
    function resetClientId() {
      localStorage.removeItem('customClientId');
      config.clientId = DEFAULT_CLIENT_ID;
      document.getElementById('clientIdDisplay').innerHTML = `
        <span>Default client configured ✓</span>
        <button class="btn btn-secondary" onclick="showClientIdChange()" style="padding: 0.5rem 1rem; font-size: 0.8rem;">Change</button>
      `;
      cancelClientIdChange();
      tokenClient = null;
      initializeGoogleAuth();
      alert('Reset to default Client ID! Please sign in again.');
    }
    
    // Tab switching (Upload "data-tab" + Campaign Mapping "data-mapping-tab")
    // via event delegation on document, so it doesn't matter what order the
    // JS files load or how the DOM is structured. Each handler scopes its
    // sibling-tab lookup to the nearest .page ancestor — that's the common
    // container whether or not the tab row is wrapped in a .card.
    document.addEventListener('click', (e) => {
      const dataTab = e.target.closest('.tab[data-tab]');
      if (dataTab) {
        const scope = dataTab.closest('.page');
        if (!scope) return;
        scope.querySelectorAll('.tab[data-tab]').forEach(t => t.classList.remove('active'));
        scope.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        dataTab.classList.add('active');
        scope.querySelector(`#${dataTab.dataset.tab}-content`)?.classList.add('active');
        return;
      }

      const mappingTab = e.target.closest('.tab[data-mapping-tab]');
      if (mappingTab) {
        const scope = mappingTab.closest('.page');
        if (!scope) return;
        scope.querySelectorAll('.tab[data-mapping-tab]').forEach(t => t.classList.remove('active'));
        scope.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
        mappingTab.classList.add('active');
        scope.querySelector(`#${mappingTab.dataset.mappingTab}-mapping`)?.classList.add('active');
      }
    });
    
