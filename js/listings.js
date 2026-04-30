    // ==================== LISTING OPTIMIZATION PAGE ====================
    
    let allProducts = []; // Store all products for filtering
    
    function showListingTab(tabName) {
      // Hide all tabs
      document.querySelectorAll('.listing-tab').forEach(tab => {
        tab.classList.remove('active');
        tab.style.display = 'none';
      });
      
      // Remove active from all tab buttons
      document.querySelectorAll('#listing-page .tab').forEach(btn => {
        btn.classList.remove('active');
      });
      
      // Show selected tab
      document.getElementById(`${tabName}-tab`).classList.add('active');
      document.getElementById(`${tabName}-tab`).style.display = 'block';
      
      // Set active tab button
      event.target.classList.add('active');
      
      // Save current listing sub-tab to localStorage
      localStorage.setItem('currentListingTab', tabName);
      
      // Load data for specific tabs
      if (tabName === 'changelog' && accessToken) {
        loadChangeLog();
      } else if (tabName === 'sessions' && accessToken) {
        // Set default date to 2 days ago (48-hour delay)
        const twoDaysAgo = new Date();
        twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
        document.getElementById('session-fetch-date').valueAsDate = twoDaysAgo;
        
        // Load existing data if available
        loadSessionData();
      }
    }
    
    // Load brands and products from the Upstash catalog (`/api/products
    // ?action=get`). Mirrors the field shape the Listing Optimization
    // page expects ({ sku, name, brand, asin, productType }) — the
    // Upstash catalog stores `type` for Parent/Non-Variable, so we
    // re-key it to `productType` here for consistency with the rest of
    // this module. Filter is intentionally permissive: any product
    // with a non-empty, non-"N/A" ASIN is eligible regardless of type
    // (variations, children, etc. all show up). The change log tracks
    // listing edits and the user knows which ASIN they're editing —
    // no reason to second-guess the catalog.
    async function loadChangeLogASINs() {
      if (!accessToken) return;

      try {
        const res = await fetch('/api/products?action=get', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!res.ok) {
          console.error('Failed to load products from Upstash:', res.status);
          return;
        }
        const data = await res.json();
        const products = Array.isArray(data.products) ? data.products : [];

        allProducts = products
          .filter(p => {
            const asin = (p.asin || '').toString().trim();
            return asin && asin.toUpperCase() !== 'N/A';
          })
          .map(p => ({
            sku: p.sku,
            name: p.name || p.sku,
            brand: p.brand || 'Unknown',
            asin: (p.asin || '').toString().trim(),
            productType: p.type || ''
          }));

        // Populate brand dropdown
        const brands = [...new Set(allProducts.map(p => p.brand))].sort();
        const brandSelect = document.getElementById('changelog-brand');
        brandSelect.innerHTML = '<option value="">All Brands</option>';
        brands.forEach(brand => {
          brandSelect.innerHTML += `<option value="${brand}">${brand}</option>`;
        });

        // Populate products (all initially)
        filterChangeLogProducts();
      } catch (error) {
        console.error('Error loading products:', error);
      }
    }
    
    // Filter products based on selected brand
    function filterChangeLogProducts() {
      const selectedBrand = document.getElementById('changelog-brand').value;
      const productSelect = document.getElementById('changelog-product');
      
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
    
    // Character counter for notes
    document.addEventListener('DOMContentLoaded', () => {
      const notesField = document.getElementById('changelog-notes');
      const counter = document.getElementById('changelog-notes-count');
      
      if (notesField && counter) {
        notesField.addEventListener('input', () => {
          counter.textContent = notesField.value.length;
        });
      }
      
      // Set default date to today
      const dateField = document.getElementById('changelog-date');
      if (dateField) {
        dateField.valueAsDate = new Date();
      }
    });
    
    async function saveChangeLog() {
      const formFeedback = document.getElementById('changelog-save-feedback');
      const showFormError = (msg) => {
        formFeedback.style.display = 'block';
        formFeedback.style.padding = '1rem';
        formFeedback.style.background = 'rgba(239, 68, 68, 0.1)';
        formFeedback.style.border = '1px solid var(--error)';
        formFeedback.style.borderRadius = '6px';
        formFeedback.style.color = 'var(--error)';
        formFeedback.textContent = msg;
      };

      if (!accessToken) { showFormError('⚠ Please sign in to save changes'); return; }

      const productSelect = document.getElementById('changelog-product');
      const asin = productSelect.value;
      const date = document.getElementById('changelog-date').value;
      const notes = document.getElementById('changelog-notes').value.trim();

      if (!asin) { showFormError('⚠ Please select a product'); return; }
      if (!date) { showFormError('⚠ Please select a date'); return; }

      const checkboxes = document.querySelectorAll('#changelog-tab input[type="checkbox"]:checked');
      const changes = Array.from(checkboxes).map(cb => cb.value);
      if (changes.length === 0) { showFormError('⚠ Please select at least one change type'); return; }

      try {
        const productName = productSelect.options[productSelect.selectedIndex].getAttribute('data-name');
        // POST to the Upstash-backed change-log API. Per-Sheet share
        // permissions no longer matter — anyone signed into the
        // dashboard with a valid Google token can write.
        const res = await fetch('/api/changelog?action=add', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            date,
            productName,
            asin,
            changes: changes.join(', '),
            notes
          })
        });

        if (res.ok) {
          formFeedback.style.display = 'block';
          formFeedback.style.padding = '1rem';
          formFeedback.style.background = 'rgba(6, 214, 160, 0.1)';
          formFeedback.style.border = '1px solid var(--success)';
          formFeedback.style.borderRadius = '6px';
          formFeedback.style.color = 'var(--success)';
          formFeedback.textContent = '✓ Change log entry saved successfully!';
          setTimeout(() => { formFeedback.style.display = 'none'; }, 5000);

          // Clear form
          document.getElementById('changelog-brand').value = '';
          document.getElementById('changelog-product').value = '';
          filterChangeLogProducts();
          document.getElementById('changelog-date').valueAsDate = new Date();
          document.getElementById('changelog-notes').value = '';
          document.querySelectorAll('#changelog-tab input[type="checkbox"]').forEach(cb => cb.checked = false);
          document.getElementById('changelog-notes-count').textContent = '0';

          loadChangeLog();
        } else {
          const err = await res.json().catch(() => ({}));
          showFormError('⚠ Failed to save: ' + (err.error || res.status));
        }
      } catch (error) {
        console.error('Error saving change log:', error);
        showFormError('⚠ Error saving change log: ' + error.message);
      }
    }
    
    async function loadChangeLog() {
      if (!accessToken) return;

      try {
        const res = await fetch('/api/changelog?action=get', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        const tableDiv = document.getElementById('changelog-table');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const entries = Array.isArray(data.entries) ? data.entries : [];

        if (entries.length === 0) {
          tableDiv.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">No changes logged yet. Add your first entry above.</div>';
          changeLogData = [];
          changeLogFiltered = [];
          return;
        }

        // Already sorted newest-first by the API. Wire up the search
        // input + state before rendering so the pager buttons can
        // reference `changeLogFiltered` without a race.
        setupChangeLogSearch(entries);
        renderChangeLogTable(changeLogFiltered);
      } catch (error) {
        console.error('Error loading change log:', error);
        document.getElementById('changelog-table').innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--error);">Error loading change log</div>';
      }
    }

    // Search functionality for change log
    let changeLogData = [];
    let changeLogFiltered = [];        // current filtered result set (or
                                       //   = changeLogData when no search)
    let changeLogPage = 1;
    const CHANGE_LOG_PAGE_SIZE = 25;

    function setupChangeLogSearch(entries) {
      changeLogData = entries;
      changeLogFiltered = entries;
      // Don't reset the current page here — `loadChangeLog` runs on
      // every delete too, and stranding the user on page 1 every time
      // they delete one row would be annoying. `renderChangeLogTable`
      // clamps the page if the data shrinks.
      const searchInput = document.getElementById('changelog-search');
      if (searchInput && !searchInput._changelogWired) {
        searchInput.addEventListener('input', filterChangeLog);
        searchInput._changelogWired = true;
      }
    }

    function filterChangeLog() {
      const searchTerm = document.getElementById('changelog-search').value.toLowerCase();
      changeLogFiltered = !searchTerm ? changeLogData : changeLogData.filter(e =>
        ['date', 'productName', 'asin', 'changes', 'notes']
          .some(k => (e?.[k] || '').toString().toLowerCase().includes(searchTerm))
      );
      changeLogPage = 1; // reset on each search
      renderChangeLogTable(changeLogFiltered);
    }

    function changeLogGoToPage(page) {
      const totalPages = Math.max(1, Math.ceil(changeLogFiltered.length / CHANGE_LOG_PAGE_SIZE));
      changeLogPage = Math.min(Math.max(1, page), totalPages);
      renderChangeLogTable(changeLogFiltered);
    }
    window.changeLogGoToPage = changeLogGoToPage;

    function renderChangeLogTable(entries) {
      const tableDiv = document.getElementById('changelog-table');
      if (!entries || entries.length === 0) {
        tableDiv.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">No matching changes found.</div>';
        return;
      }

      // Pagination — slice to the current page. Clamp page so a delete
      // on the last page doesn't strand the user on an empty page.
      const total = entries.length;
      const totalPages = Math.max(1, Math.ceil(total / CHANGE_LOG_PAGE_SIZE));
      if (changeLogPage > totalPages) changeLogPage = totalPages;
      const start = (changeLogPage - 1) * CHANGE_LOG_PAGE_SIZE;
      const pageEntries = entries.slice(start, start + CHANGE_LOG_PAGE_SIZE);

      // `width: auto` overrides the global `table { width: 100%; }` in
      // styles.css so columns size to their actual content. Date,
      // ASIN, and Delete cells nowrap so the short ones don't waste
      // horizontal space wrapping a 10-char string. Product / Changes
      // / Notes wrap normally — Notes especially can be long.
      const esc = (v) => (v == null ? '' : String(v))
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

      let html = '<table style="width: auto; border-collapse: collapse;">';
      html += '<thead><tr style="border-bottom: 2px solid var(--border);">';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600; white-space: nowrap;">Date</th>';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Product</th>';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600; white-space: nowrap;">ASIN</th>';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Changes Made</th>';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Notes</th>';
      html += '<th style="text-align: center; padding: 0.75rem; font-weight: 600;"></th>';
      html += '</tr></thead><tbody>';

      pageEntries.forEach(e => {
        html += '<tr style="border-bottom: 1px solid var(--border);">';
        html += `<td style="padding: 0.75rem; white-space: nowrap;">${esc(e.date)}</td>`;
        html += `<td style="padding: 0.75rem;">${esc(e.productName)}</td>`;
        html += `<td style="padding: 0.75rem; font-family: 'Roboto Mono', monospace; white-space: nowrap;">${esc(e.asin)}</td>`;
        html += `<td style="padding: 0.75rem;">${esc(e.changes)}</td>`;
        html += `<td style="padding: 0.75rem; color: var(--text-secondary);">${esc(e.notes)}</td>`;
        html += `<td style="padding: 0.75rem; text-align: center; white-space: nowrap;">`
              + `<button class="changelog-delete-btn" data-id="${esc(e.id)}" title="Delete this entry" style="background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 1.1rem; padding: 0 0.25rem;">×</button>`
              + `</td>`;
        html += '</tr>';
      });

      html += '</tbody></table>';

      // Pagination controls — Prev / "Page X of Y · N entries" / Next.
      // Hide the controls entirely if everything fits on one page.
      const showingFrom = total === 0 ? 0 : start + 1;
      const showingTo = Math.min(start + CHANGE_LOG_PAGE_SIZE, total);
      const pagerStyle = `display: flex; justify-content: space-between; align-items: center; gap: 1rem; margin-top: 1rem; font-size: 0.875rem; color: var(--text-secondary);`;
      const btnStyle = (disabled) => `padding: 0.5rem 1rem; background: ${disabled ? 'var(--bg-secondary)' : 'var(--bg-card)'}; border: 1px solid var(--border); border-radius: 6px; color: var(--text-primary); cursor: ${disabled ? 'not-allowed' : 'pointer'}; opacity: ${disabled ? '0.5' : '1'};`;

      const pager = totalPages <= 1 ? '' : `
        <div style="${pagerStyle}">
          <span>Showing ${showingFrom}–${showingTo} of ${total.toLocaleString()}</span>
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <button onclick="changeLogGoToPage(${changeLogPage - 1})" style="${btnStyle(changeLogPage <= 1)}" ${changeLogPage <= 1 ? 'disabled' : ''}>◀ Prev</button>
            <span>Page ${changeLogPage} of ${totalPages}</span>
            <button onclick="changeLogGoToPage(${changeLogPage + 1})" style="${btnStyle(changeLogPage >= totalPages)}" ${changeLogPage >= totalPages ? 'disabled' : ''}>Next ▶</button>
          </div>
        </div>
      `;

      tableDiv.innerHTML = html + pager;

      // Single delegated handler for the row delete buttons.
      tableDiv.querySelectorAll('.changelog-delete-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteChangeLogEntry(btn.getAttribute('data-id'), btn));
      });
    }

    // Soft delete UX: button shrinks to "Deleting…" so the user has
    // visual feedback even on slow networks. No popup/confirm — per
    // project preference. If the user mis-clicks, they re-add the row.
    async function deleteChangeLogEntry(id, btn) {
      if (!id || !accessToken) return;
      if (btn) {
        btn.disabled = true;
        btn.textContent = '…';
      }
      try {
        const res = await fetch('/api/changelog?action=delete', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ id })
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await loadChangeLog();
      } catch (err) {
        console.error('Delete failed:', err);
        if (btn) {
          btn.disabled = false;
          btn.textContent = '×';
        }
      }
    }
    window.deleteChangeLogEntry = deleteChangeLogEntry;

    // ──────── Bulk upload ──────────────────────────────────────────────
    //
    // Flow: user opens the modal → drops a file (or clicks the zone to
    // pick one via the hidden <input type="file">) → name shows under
    // the prompt → clicks Upload Changes. Date column is parsed
    // through `_normalizeBulkDate` so any common format (M/D/YY,
    // YYYY-MM-DD, "Apr 30, 2026", Excel serial-style) becomes the
    // canonical YYYY-MM-DD before it hits the sheet. ASINs are
    // validated against the Upstash catalog (loaded into `allProducts`
    // by loadChangeLogASINs at tab activation).
    function openBulkUpload() {
      document.getElementById('bulk-upload-modal').style.display = 'flex';
      const fileInput = document.getElementById('bulk-upload-file');
      if (fileInput) fileInput.value = '';
      const fname = document.getElementById('bulk-upload-filename');
      if (fname) fname.textContent = 'No file selected';
      document.getElementById('bulk-upload-preview').innerHTML = '';
      document.getElementById('bulk-upload-feedback').style.display = 'none';
      _initBulkUploadDropzone();
    }

    function closeBulkUpload() {
      document.getElementById('bulk-upload-modal').style.display = 'none';
    }

    // Idempotent — safe to call every time the modal opens. Wires the
    // drop zone's click-to-pick behaviour, dragenter/over/leave styling,
    // and drop-to-load. The hidden <input type="file"> remains the
    // single source of truth for the selected file (so the existing
    // processBulkUpload() reads from it without caring how the file got
    // there).
    let _bulkUploadDropzoneInited = false;
    function _initBulkUploadDropzone() {
      if (_bulkUploadDropzoneInited) return;
      _bulkUploadDropzoneInited = true;

      const dz = document.getElementById('bulk-upload-dropzone');
      const fileInput = document.getElementById('bulk-upload-file');
      const fname = document.getElementById('bulk-upload-filename');
      if (!dz || !fileInput || !fname) return;

      const setFile = (file) => {
        // Wrap the dropped File in a DataTransfer so it appears on
        // fileInput.files — keeps processBulkUpload() unchanged.
        const dt = new DataTransfer();
        dt.items.add(file);
        fileInput.files = dt.files;
        fname.textContent = file.name;
      };

      dz.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        const f = fileInput.files?.[0];
        fname.textContent = f ? f.name : 'No file selected';
      });

      const setActive = (on) => {
        dz.style.borderColor = on ? 'var(--accent-green)' : 'var(--border)';
        dz.style.background = on ? 'rgba(6, 214, 160, 0.05)' : 'transparent';
      };

      ['dragenter', 'dragover'].forEach(evt =>
        dz.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); setActive(true); })
      );
      ['dragleave', 'dragend'].forEach(evt =>
        dz.addEventListener(evt, e => { e.preventDefault(); e.stopPropagation(); setActive(false); })
      );
      dz.addEventListener('drop', (e) => {
        e.preventDefault(); e.stopPropagation(); setActive(false);
        const f = e.dataTransfer?.files?.[0];
        if (f) setFile(f);
      });
    }

    // Show an inline error/success banner inside the modal — same
    // visual treatment the original used. No popups per project pref.
    function _showBulkUploadFeedback(kind, message) {
      const feedback = document.getElementById('bulk-upload-feedback');
      if (!feedback) return;
      feedback.style.display = 'block';
      feedback.style.padding = '1rem';
      feedback.style.borderRadius = '6px';
      if (kind === 'error') {
        feedback.style.background = 'rgba(239, 68, 68, 0.1)';
        feedback.style.border = '1px solid var(--error)';
        feedback.style.color = 'var(--error)';
      } else {
        feedback.style.background = 'rgba(6, 214, 160, 0.1)';
        feedback.style.border = '1px solid var(--success)';
        feedback.style.color = 'var(--success)';
      }
      feedback.textContent = message;
    }

    // Best-effort coercion of any plausible date string to YYYY-MM-DD.
    // Recognised forms (in this order):
    //   • already YYYY-MM-DD  → kept as-is
    //   • YYYY/MM/DD          → re-stitched
    //   • M/D/YY, MM/DD/YY, M/D/YYYY, MM/DD/YYYY (US slash format)
    //   • M-D-YY, MM-DD-YYYY  (US dash format)
    //   • "Apr 30, 2026" / "April 30 2026" / "Apr 30 2026"
    //   • Excel serial number (e.g. 45773 → 2025-04-15) — guards
    //     against the "1900 leap year" off-by-one with the standard
    //     >59 adjustment.
    // Two-digit years are interpreted as 2000-2099 (the dashboard's
    // entire lifetime fits there).
    // Returns null if no rule matches — caller surfaces a clear error.
    function _normalizeBulkDate(raw) {
      if (raw == null) return null;
      const s = String(raw).trim();
      if (!s) return null;

      // ISO already
      const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

      // YYYY/MM/DD
      const slashIso = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
      if (slashIso) {
        return `${slashIso[1]}-${pad2(slashIso[2])}-${pad2(slashIso[3])}`;
      }

      // US slash or dash: M/D/YY, M/D/YYYY, M-D-YY, M-D-YYYY
      const us = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2}|\d{4})$/);
      if (us) {
        const month = pad2(us[1]);
        const day   = pad2(us[2]);
        let year    = us[3];
        if (year.length === 2) year = '20' + year;
        return `${year}-${month}-${day}`;
      }

      // "Mon DD, YYYY" / "Month DD YYYY" / "Mon DD YYYY"
      const months = { jan:'01', feb:'02', mar:'03', apr:'04', may:'05', jun:'06',
                       jul:'07', aug:'08', sep:'09', oct:'10', nov:'11', dec:'12' };
      const text = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{2,4})/);
      if (text) {
        const m = months[text[1].toLowerCase().substring(0, 3)];
        if (m) {
          let year = text[3];
          if (year.length === 2) year = '20' + year;
          return `${year}-${m}-${pad2(text[2])}`;
        }
      }

      // Excel serial (numeric, no separators). Only treat values in a
      // sane range (≥ 25569 = 1970-01-01) so we don't mistake an ASIN
      // or other digits for a date.
      if (/^\d+(\.\d+)?$/.test(s)) {
        const n = Math.floor(Number(s));
        if (n >= 25569 && n < 60000) {
          const adjusted = n > 59 ? n - 1 : n;
          const ms = Date.UTC(1899, 11, 31) + adjusted * 86400000;
          const d = new Date(ms);
          return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
        }
      }

      // Last-ditch: hand it to Date.parse. Unreliable across locales
      // but catches odd-but-parseable forms. We re-validate the
      // resulting components fall in plausible ranges.
      const t = Date.parse(s);
      if (!isNaN(t)) {
        const d = new Date(t);
        const y = d.getFullYear();
        if (y >= 2000 && y <= 2099) {
          return `${y}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
        }
      }
      return null;
    }

    function pad2(v) {
      const s = String(v);
      return s.length < 2 ? '0' + s : s;
    }

    async function processBulkUpload() {
      const fileInput = document.getElementById('bulk-upload-file');

      if (!fileInput.files || fileInput.files.length === 0) {
        _showBulkUploadFeedback('error', '⚠ Please choose or drop a CSV file');
        return;
      }
      const file = fileInput.files[0];
      if (!/\.csv$/i.test(file.name)) {
        _showBulkUploadFeedback('error', '⚠ File must be a .csv');
        return;
      }

      try {
        const text = await file.text();
        const lines = text.split(/\r?\n/).filter(line => line.trim());
        if (lines.length < 2) {
          _showBulkUploadFeedback('error', '⚠ CSV must have at least a header row and one data row');
          return;
        }

        // Skip header. Parse with a quote-aware splitter.
        const rows = lines.slice(1).map(line => {
          const cols = [];
          let cur = '', inQuotes = false;
          for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (ch === '"') inQuotes = !inQuotes;
            else if (ch === ',' && !inQuotes) { cols.push(cur.trim()); cur = ''; }
            else cur += ch;
          }
          cols.push(cur.trim());
          return cols;
        });

        const invalidRows = rows.filter(row => row.length < 3);
        if (invalidRows.length > 0) {
          _showBulkUploadFeedback('error',
            `⚠ Invalid format: every row needs at least 3 columns (Date, ASIN, Changes). Found ${invalidRows.length} bad row(s).`);
          return;
        }

        // ASIN → product name from the Upstash-loaded `allProducts`.
        // Keyed by uppercase ASIN so the lookup is case-insensitive —
        // Amazon ASINs are conventionally uppercase but a CSV exported
        // from a different tool sometimes lowercases them.
        const asinToName = {};
        allProducts.forEach(p => {
          const key = (p.asin || '').toUpperCase();
          if (key && !asinToName[key]) asinToName[key] = p.name;
        });

        const uploadRows = [];
        const notFoundAsins = [];

        for (let idx = 0; idx < rows.length; idx++) {
          const row = rows[idx];
          const rawDate = row[0];
          const asin    = (row[1] || '').trim();
          const changes = row[2];
          const notes   = row[3] || '';

          const date = _normalizeBulkDate(rawDate);
          if (!date) {
            _showBulkUploadFeedback('error',
              `⚠ Row ${idx + 2}: couldn't recognize date "${rawDate}". Try YYYY-MM-DD, M/D/YY, or "Mon DD, YYYY".`);
            return;
          }

          const asinKey = asin.toUpperCase();
          const productName = asinToName[asinKey];
          if (!productName) {
            notFoundAsins.push(asin);
            continue;
          }
          // Use the canonical (uppercase) ASIN in the appended row so
          // entries are consistent regardless of CSV casing.
          uploadRows.push([date, productName, asinKey, changes, notes]);
        }

        if (notFoundAsins.length > 0) {
          _showBulkUploadFeedback('error',
            `⚠ ASIN(s) not found in the Upstash product catalog: ${notFoundAsins.join(', ')}`);
          return;
        }

        // POST to the Upstash-backed change-log API. uploadRows is in
        // [date, productName, asin, changes, notes] tuple form from the
        // earlier processing — re-shape into the API's named-field
        // entries for the bulk-add call.
        const entries = uploadRows.map(([date, productName, asin, changes, notes]) =>
          ({ date, productName, asin, changes, notes }));

        const response = await fetch('/api/changelog?action=bulk-add', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ entries })
        });

        if (response.ok) {
          const result = await response.json().catch(() => ({}));
          const added = result.added ?? uploadRows.length;
          const rejected = result.rejectedCount || 0;
          const tail = rejected > 0 ? ` (${rejected} rejected by server)` : '';
          _showBulkUploadFeedback('success', `✓ Successfully uploaded ${added} change(s)!${tail}`);
          setTimeout(() => {
            loadChangeLog();
            closeBulkUpload();
          }, 2000);
        } else {
          const err = await response.json().catch(() => ({}));
          throw new Error(err.error || `Upload failed (${response.status})`);
        }
      } catch (error) {
        console.error('Bulk upload error:', error);
        _showBulkUploadFeedback('error', '⚠ Error processing file: ' + error.message);
      }
    }
    
