    // Product Catalog — reads from /api/products (Upstash KV).
    // Rendered with the same table style as the Profitability Overview pages:
    // bg-secondary header rows, border-bottom row separators, Roboto Mono for
    // identifier / numeric columns.

    // Module state: the full catalog + current filter selections. Kept outside
    // of any render function so filter changes don't need to refetch.
    let catalogAllProducts = [];
    let catalogFilters = { brand: '', fulfillment: '', status: '', type: '' };
    let catalogOnlyActive = false;

    // Column order shown in the table and used for CSV export.
    const CATALOG_COLUMNS = [
      { field: 'brand',       label: 'Brand',       filter: true },
      { field: 'name',        label: 'Name',        filter: false },
      { field: 'sku',         label: 'SKU',         filter: false, mono: true },
      { field: 'asin',        label: 'ASIN',        filter: false, mono: true },
      { field: 'fulfillment', label: 'Fulfillment', filter: true },
      { field: 'cost',        label: 'Cost',        filter: false, align: 'right', mono: true },
      { field: 'type',        label: 'Type',        filter: true },
      { field: 'status',      label: 'Status',      filter: true }
    ];

    // Sort order applied on load: brand → status → sku → fulfillment, all A-Z.
    const CATALOG_SORT_FIELDS = ['brand', 'status', 'sku', 'fulfillment'];

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
        catalogAllProducts = sortCatalog(Array.isArray(data.products) ? data.products : []);

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

    // Sort by brand, then status, then sku, then fulfillment — all A-Z.
    // Empty strings sort before any populated value so "blank" products
    // cluster at the top of their group.
    function sortCatalog(products) {
      return [...products].sort((a, b) => {
        for (const field of CATALOG_SORT_FIELDS) {
          const cmp = String(a[field] || '').localeCompare(String(b[field] || ''));
          if (cmp !== 0) return cmp;
        }
        return 0;
      });
    }

    // Build the full catalog markup: toolbar, two-row <thead> (filters on top,
    // labels right above the data), and an empty <tbody> that
    // applyCatalogFilters() populates. Called once per load; filter changes
    // don't re-run this, only the tbody update.
    function renderCatalogLayout() {
      const container = document.getElementById('catalog-content');

      const thBase = 'padding: 0.5rem 0.75rem; background: var(--bg-secondary); font-weight: 600; font-size: 0.875rem;';
      const thLabelBase = 'padding: 0.75rem; background: var(--bg-secondary); font-weight: 600; font-size: 0.875rem;';

      // Row 1: filter dropdowns (or blank cells) aligned above each column.
      const filterCells = CATALOG_COLUMNS.map(col => {
        const align = col.align === 'right' ? 'text-align: right;' : 'text-align: left;';
        if (!col.filter) return `<th style="${align} ${thBase}"></th>`;
        return `<th style="${align} ${thBase}">${filterDropdown(col.field)}</th>`;
      }).join('');

      // Row 2: column labels, aligned right above the data cells.
      const labelCells = CATALOG_COLUMNS.map(col => {
        const align = col.align === 'right' ? 'text-align: right;' : 'text-align: left;';
        return `<th style="${align} ${thLabelBase}">${col.label}</th>`;
      }).join('');

      container.innerHTML = `
        <div class="catalog-toolbar">
          <label class="catalog-active-toggle">
            <input type="checkbox" id="catalog-only-active"> Only show active
          </label>
          <button class="btn btn-secondary" id="catalog-export-btn" type="button">Export CSV</button>
        </div>

        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr>${filterCells}</tr>
            <tr>${labelCells}</tr>
          </thead>
          <tbody id="catalog-tbody"></tbody>
        </table>
      `;

      document.getElementById('catalog-only-active').addEventListener('change', (e) => {
        catalogOnlyActive = e.target.checked;
        applyCatalogFilters();
      });

      document.getElementById('catalog-export-btn').addEventListener('click', exportCatalogCSV);

      for (const col of CATALOG_COLUMNS) {
        if (!col.filter) continue;
        const sel = document.getElementById(`catalog-filter-${col.field}`);
        if (!sel) continue;
        sel.addEventListener('change', (e) => {
          catalogFilters[col.field] = e.target.value;
          applyCatalogFilters();
        });
      }
    }

    // Compact <select> populated from the distinct values in the current
    // dataset. Lives above its column's label in the <thead>.
    function filterDropdown(field) {
      const values = [...new Set(
        catalogAllProducts.map(p => p[field]).filter(v => v != null && v !== '')
      )].sort((a, b) => String(a).localeCompare(String(b)));

      const options = values
        .map(v => `<option value="${escapeHtml(String(v))}">${escapeHtml(String(v))}</option>`)
        .join('');

      return `
        <select
          id="catalog-filter-${field}"
          class="catalog-filter-select"
          style="width: auto; padding: 0.25rem 0.5rem; font-size: 0.75rem; font-weight: 400;"
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
        for (const col of CATALOG_COLUMNS) {
          if (!col.filter) continue;
          const selected = catalogFilters[col.field];
          if (selected && p[col.field] !== selected) return false;
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
      const cells = CATALOG_COLUMNS.map(col => {
        const align = col.align === 'right' ? 'text-align: right;' : '';
        const mono  = col.mono ? "font-family: 'Roboto Mono', monospace;" : '';
        const style = `padding: 0.75rem; border-bottom: 1px solid var(--border); ${align} ${mono}`;
        const raw   = p[col.field];
        const value = col.field === 'cost' ? formatCost(raw) : escapeHtml(raw);
        return `<td style="${style}">${value}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }

    // Export the currently filtered list as a CSV. Column order matches the
    // on-screen table so the file round-trips cleanly through upload.
    function exportCatalogCSV() {
      const rows = getFilteredCatalog();
      const fields = CATALOG_COLUMNS.map(c => c.field);
      const lines = [fields.join(',')];
      for (const p of rows) {
        lines.push(fields.map(f => csvEscape(p[f] ?? '')).join(','));
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
