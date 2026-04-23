    // Product Catalog — reads from /api/products (Upstash KV).
    // Rendered with the same table style as the Profitability Overview pages:
    // bg-secondary header row, border-bottom row separators, Roboto Mono for
    // numeric columns.

    async function loadProductCatalog() {
      if (!accessToken) {
        const container = document.getElementById('catalog-content');
        if (container) {
          container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Sign in to view the product catalog</div>';
        }
        return;
      }

      const container = document.getElementById('catalog-content');
      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading catalog...</div>';

      try {
        const res = await fetch('/api/products?action=get', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (!res.ok) throw new Error(`Failed to load products (${res.status})`);
        const data = await res.json();
        const products = Array.isArray(data.products) ? data.products : [];

        // Header blurb
        const countEl = document.getElementById('catalog-count');
        const updEl   = document.getElementById('catalog-updated');
        if (countEl) countEl.textContent = products.length.toLocaleString();
        if (updEl)   updEl.textContent = data.updatedAt ? data.updatedAt.slice(0, 10) : '—';

        if (products.length === 0) {
          container.innerHTML = `
            <div style="padding: 4rem; text-align: center; color: var(--text-secondary);">
              <div style="font-size: 3rem; margin-bottom: 1rem; opacity: 0.3;">📦</div>
              <div style="font-size: 1.125rem;">No products in the catalog yet. Upload via the Data Upload page.</div>
            </div>`;
          return;
        }

        container.innerHTML = renderCatalogTable(products);
      } catch (err) {
        console.error('Failed to load product catalog:', err);
        container.innerHTML = `<div style="padding: 4rem; text-align: center; color: var(--error);">Error: ${err.message}</div>`;
      }
    }

    function renderCatalogTable(products) {
      const thStyle = 'text-align: left; padding: 0.75rem; background: var(--bg-secondary); font-weight: 600; font-size: 0.875rem;';
      const thRight = 'text-align: right; padding: 0.75rem; background: var(--bg-secondary); font-weight: 600; font-size: 0.875rem;';
      const tdStyle = 'padding: 0.75rem; border-bottom: 1px solid var(--border);';
      const tdMono = 'padding: 0.75rem; border-bottom: 1px solid var(--border); font-family: \'Roboto Mono\', monospace;';
      const tdMonoRight = tdMono + ' text-align: right;';

      const rows = products.map(p => `
        <tr>
          <td style="${tdMono}">${escapeHtml(p.sku)}</td>
          <td style="${tdStyle}">${escapeHtml(p.name)}</td>
          <td style="${tdStyle}">${escapeHtml(p.brand)}</td>
          <td style="${tdStyle}">${escapeHtml(p.fulfillment)}</td>
          <td style="${tdMonoRight}">${formatCost(p.cost)}</td>
          <td style="${tdMono}">${escapeHtml(p.asin)}</td>
          <td style="${tdStyle}">${escapeHtml(p.type)}</td>
        </tr>
      `).join('');

      return `
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr>
              <th style="${thStyle}">SKU</th>
              <th style="${thStyle}">Name</th>
              <th style="${thStyle}">Brand</th>
              <th style="${thStyle}">Fulfillment</th>
              <th style="${thRight}">Cost</th>
              <th style="${thStyle}">ASIN</th>
              <th style="${thStyle}">Type</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;
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
