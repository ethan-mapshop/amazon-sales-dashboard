    // Product Catalog — reads from /api/products (Upstash KV).
    // Rendered with the same table style as the Profitability Overview pages:
    // bg-secondary header row, border-bottom row separators, Roboto Mono for
    // identifier / numeric columns.

    // Module state: the full catalog + current filter selections. Kept outside
    // of any render function so filter changes don't need to refetch.
    let catalogAllProducts = [];
    let catalogFilters = { brand: '', fulfillment: '', status: '', type: '' };
    let catalogOnlyActive = false;

    // Columns that get a filter dropdown in their header.
    const CATALOG_FILTERABLE = ['brand', 'fulfillment', 'status', 'type'];

    async function loadProductCatalog() {
      const container = document.getElementById('catalog-content');
      if (!accessToken) {
        if (container) {
          container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Sign in to view the product catalog</div>';
        }
        return;
      }

      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading catalog...</div>';

      try {
        const res = await fetch('/api/products?action=get', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (!res.ok) throw new Error(`Failed to load products (${res.status})`);
        const data = await res.json();
        catalogAllProducts = Array.isArray(data.products) ? data.products : [];

        const updEl = document.getElementById('catalog-updated');
        if (updEl) updEl.textContent = data.updatedAt ? data.updatedAt.slice(0, 10) : '—';

        if (catalogAllProducts.length === 0) {
          container.innerHTML = `
            <div style="padding: 4rem; text-align: center; color: var(--text-secondary);">
              <div style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.3;">📦</div>
              <div style="font-size: 1.125rem;">No products in the catalog yet. Upload via the Data Upload page.</div>
            </div>`;
          const countEl = document.getElementById('catalog-count');
          if (countEl) countEl.textContent = '0';
          return;
        }

        renderCatalogLayout();
        applyCatalogFilters();
      } catch (err) {
        console.error('Failed to load product catalog:', err);
        container.innerHTML = `<div style="padding: 4rem; text-align: center; color: var(--error);">Error: ${err.message}</div>`;
      }
    }

    // Build the full catalog markup: toolbar, table with filter-enabled headers,
    // and an empty <tbody> that applyCatalogFilters() populates. Called once
    // per load; filter changes don't re-run this, only the tbody update.
    function renderCatalogLayout() {
      const container = document.getElementById('catalog-content');
      const thBase   = 'padding: 0.75rem; background: var(--bg-secondary); font-weight: 600; font-size: 0.875rem; vertical-align: top;';
      const thLeft   = `text-align: left; ${thBase}`;
      const thRight  = `text-align: right; ${thBase}`;

      container.innerHTML = `
        <div class="catalog-toolbar">
          <label class="catalog-active-toggle">
            <input type="checkbox" id="catalog-only-active"> Only show active
          </label>
          <button class="btn btn-secondary" id="catalog-export-btn" type="button">Export CSV</button>
        </div>

        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr>
              <th style="${thLeft}">SKU</th>
              <th style="${thLeft}">Name</th>
              <th style="${thLeft}">${filterHeader('Brand', 'brand')}</th>
              <th style="${thLeft}">${filterHeader('Fulfillment', 'fulfillment')}</th>
              <th style="${thLeft}">${filterHeader('Status', 'status')}</th>
              <th style="${thRight}">Cost</th>
              <th style="${thLeft}">ASIN</th>
              <th style="${thLeft}">${filterHeader('Type', 'type')}</th>
            </tr>
          </thead>
          <tbody id="catalog-tbody"></tbody>
        </table>
      `;

      // Wire up events after the nodes exist.
      document.getElementById('catalog-only-active').addEventListener('change', (e) => {
        catalogOnlyActive = e.target.checked;
        applyCatalogFilters();
      });

      document.getElementById('catalog-export-btn').addEventListener('click', exportCatalogCSV);

      for (const field of CATALOG_FILTERABLE) {
        const sel = document.getElementById(`catalog-filter-${field}`);
        if (!sel) continue;
        sel.addEventListener('change', (e) => {
          catalogFilters[field] = e.target.value;
          applyCatalogFilters();
        });
      }
    }

    // Header cell markup: label stacked over a compact dropdown populated from
    // the distinct values in the current dataset.
    function filterHeader(label, field) {
      const values = [...new Set(
        catalogAllProducts.map(p => p[field]).filter(v => v != null && v !== '')
      )].sort((a, b) => String(a).localeCompare(String(b)));

      const options = values
        .map(v => `<option value="${escapeHtml(String(v))}">${escapeHtml(String(v))}</option>`)
        .join('');

      return `
        <div>${label}</div>
        <select
          id="catalog-filter-${field}"
          class="catalog-filter-select"
          style="width: auto; padding: 0.25rem 0.5rem; margin-top: 0.375rem; font-size: 0.75rem; font-weight: 400;"
        >
          <option value="">All</option>
          ${options}
        </select>
      `;
    }

    // Compute the filtered product list given the current state. Extracted so
    // both the tbody renderer and the CSV exporter operate on the same rules.
    function getFilteredCatalog() {
      return catalogAllProducts.filter(p => {
        if (catalogOnlyActive && p.status !== 'Active') return false;
        for (const field of CATALOG_FILTERABLE) {
          const selected = catalogFilters[field];
          if (selected && p[field] !== selected) return false;
        }
        return true;
      });
    }

    function applyCatalogFilters() {
      const filtered = getFilteredCatalog();
      const tbody = document.getElementById('catalog-tbody');
      if (tbody) tbody.innerHTML = filtered.map(renderCatalogRow).join('');

      // Header blurb reflects filtered count vs. total.
      const countEl = document.getElementById('catalog-count');
      if (countEl) {
        countEl.textContent = filtered.length === catalogAllProducts.length
          ? catalogAllProducts.length.toLocaleString()
          : `${filtered.length.toLocaleString()} of ${catalogAllProducts.length.toLocaleString()}`;
      }
    }

    function renderCatalogRow(p) {
      const tdBase = 'padding: 0.75rem; border-bottom: 1px solid var(--border);';
      const tdMono = `${tdBase} font-family: 'Roboto Mono', monospace;`;
      const tdMonoRight = `${tdMono} text-align: right;`;
      return `
        <tr>
          <td style="${tdMono}">${escapeHtml(p.sku)}</td>
          <td style="${tdBase}">${escapeHtml(p.name)}</td>
          <td style="${tdBase}">${escapeHtml(p.brand)}</td>
          <td style="${tdBase}">${escapeHtml(p.fulfillment)}</td>
          <td style="${tdBase}">${escapeHtml(p.status)}</td>
          <td style="${tdMonoRight}">${formatCost(p.cost)}</td>
          <td style="${tdMono}">${escapeHtml(p.asin)}</td>
          <td style="${tdBase}">${escapeHtml(p.type)}</td>
        </tr>
      `;
    }

    // Export the currently filtered list as a CSV. Uses the same column order
    // as the Sheet's Products tab so the file round-trips cleanly.
    function exportCatalogCSV() {
      const rows = getFilteredCatalog();
      const headers = ['sku', 'name', 'brand', 'fulfillment', 'cost', 'asin', 'type', 'status'];
      const lines = [headers.join(',')];
      for (const p of rows) {
        lines.push(headers.map(h => csvEscape(p[h] ?? '')).join(','));
      }
      const csv = lines.join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `product-catalog-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    function csvEscape(v) {
      const s = v == null ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    }

    function formatCost(n) {
      const num = parseFloat(n);
      if (!Number.isFinite(num)) return '';
      return '$' + num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function escapeHtml(s) {
      if (s == null) return '';
      return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }
