    function enableUpload() {
      document.querySelectorAll('.upload-zone').forEach(zone => {
        zone.classList.remove('disabled');
      });
    }
    
    // File upload handling
    document.querySelectorAll('.upload-zone').forEach(zone => {
      const type = zone.dataset.type;
      const fileInput = zone.querySelector('.file-input');
      
      zone.addEventListener('click', () => {
        if (!accessToken) return;
        fileInput.click();
      });
      
      zone.addEventListener('dragover', (e) => {
        if (!accessToken) return;
        e.preventDefault();
        zone.style.borderColor = 'var(--accent-orange)';
      });
      
      zone.addEventListener('dragleave', () => {
        zone.style.borderColor = '';
      });
      
      zone.addEventListener('drop', (e) => {
        if (!accessToken) return;
        e.preventDefault();
        zone.style.borderColor = '';
        if (e.dataTransfer.files.length > 0) {
          handleFile(e.dataTransfer.files[0], type);
        }
      });
      
      fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
          handleFile(e.target.files[0], type);
        }
      });
    });
    
    document.querySelectorAll('.clear-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const type = btn.dataset.type;
        uploadedData[type] = null;
        
        const fileInput = document.querySelector(`.upload-zone[data-type="${type}"] .file-input`);
        fileInput.value = '';
        
        const fileInfo = document.querySelector(`.file-info[data-type="${type}"]`);
        fileInfo.classList.remove('active');
        fileInfo.innerHTML = '';
        
        document.querySelector(`.preview-table[data-type="${type}"]`).style.display = 'none';
        document.querySelector(`.process-btn[data-type="${type}"]`).disabled = true;
        btn.style.display = 'none';
        hideStatus(type);
      });
    });
    
    // Date conversion utilities
    function parseAmazonDate(dateStr) {
      // Parse Amazon date formats to ISO date
      // Handles: "Dec 1, 2025 12:07:15 AM PST" and "12/1/2025 12:00:00 AM"
      if (!dateStr) return null;
      
      // Try numeric format first: "12/1/2025 12:00:00 AM"
      const numericMatch = dateStr.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (numericMatch) {
        const month = numericMatch[1].padStart(2, '0');
        const day = numericMatch[2].padStart(2, '0');
        const year = numericMatch[3];
        return `${year}-${month}-${day}`;
      }
      
      // Try text format: "Dec 1, 2025 12:07:15 AM PST"
      const textMatch = dateStr.match(/^([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})/);
      if (textMatch) {
        const monthStr = textMatch[1];
        const day = textMatch[2].padStart(2, '0');
        const year = textMatch[3];
        
        // Convert month name to number
        const months = {
          'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
          'may': '05', 'jun': '06', 'jul': '07', 'aug': '08',
          'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12'
        };
        
        const month = months[monthStr.toLowerCase().substring(0, 3)];
        if (!month) return null;
        
        return `${year}-${month}-${day}`;
      }
      
      return null;
    }
    
    function excelSerialToISODate(serial) {
      // Convert Excel serial number to ISO date (YYYY-MM-DD).
      // Excel stores dates as "days since 1899-12-31" where serial 1 = 1900-01-01.
      // It also has a historical bug where it thinks 1900 was a leap year — so
      // serial 60 is a phantom "Feb 29, 1900" and every real date after that is
      // off by one. We subtract one from serials above that boundary to
      // compensate. Using UTC throughout avoids timezone shifts.
      if (!serial || isNaN(serial)) return null;

      const days = Math.floor(serial);
      const adjustedDays = days > 59 ? days - 1 : days;

      const epochDate = Date.UTC(1899, 11, 31); // Dec 31, 1899 — serial 1 = next day
      const millisecondsPerDay = 24 * 60 * 60 * 1000;
      const targetTime = epochDate + (adjustedDays * millisecondsPerDay);
      const date = new Date(targetTime);

      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    
    // Scan the first N rows of the sheet for a row containing every required
    // column (case-insensitive). Handles Amazon reports with any preamble
    // length (the old logic hard-coded 7; newer reports now use 9, and who
    // knows what future exports will do). Returns the 0-indexed row, or -1.
    function findHeaderRow(sheet, requiredColumns, maxScan = 20) {
      if (!sheet || !sheet['!ref']) return -1;
      const range = XLSX.utils.decode_range(sheet['!ref']);
      const required = requiredColumns.map(c => String(c).trim().toLowerCase());
      const lastScan = Math.min(range.e.r, range.s.r + maxScan);
      for (let r = range.s.r; r <= lastScan; r++) {
        const rowVals = [];
        for (let c = range.s.c; c <= range.e.c; c++) {
          const cell = sheet[XLSX.utils.encode_cell({ r, c })];
          if (cell && cell.v != null) rowVals.push(String(cell.v).trim().toLowerCase());
        }
        if (required.every(col => rowVals.includes(col))) return r;
      }
      return -1;
    }

    function handleFile(file, type) {
      const reader = new FileReader();
      const sheetConfig = SHEET_CONFIGS[type];

      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const firstSheet = workbook.Sheets[workbook.SheetNames[0]];

          // Auto-detect the header row by scanning for one that contains all
          // required columns. Falls back to sheetConfig.skipRows if the scan
          // doesn't find a match (e.g. required-column name changed).
          const detectedHeader = findHeaderRow(firstSheet, sheetConfig.requiredColumns);
          const skipRows = detectedHeader >= 0 ? detectedHeader : sheetConfig.skipRows;

          let jsonData;
          if (skipRows > 0) {
            const range = XLSX.utils.decode_range(firstSheet['!ref']);
            range.s.r = skipRows;
            const newRange = XLSX.utils.encode_range(range);
            jsonData = XLSX.utils.sheet_to_json(firstSheet, { range: newRange });
          } else {
            jsonData = XLSX.utils.sheet_to_json(firstSheet);
          }
          
          if (jsonData.length === 0) {
            showStatus(type, 'error', 'The file appears to be empty');
            return;
          }
          
          // Validate columns
          const fileCols = Object.keys(jsonData[0]);
          const missingCols = sheetConfig.requiredColumns.filter(col => 
            !fileCols.includes(col)
          );
          
          if (missingCols.length > 0) {
            showStatus(type, 'error', `Missing columns: ${missingCols.join(', ')}`);
            return;
          }
          
          // Normalize and convert dates
          uploadedData[type] = jsonData.map(row => {
            const normalized = {};
            Object.keys(row).forEach(key => {
              let value = row[key];

              // Convert dates based on report type
              if (type === 'transactions' && key === 'date/time') {
                value = parseAmazonDate(value) || value;
              } else if (type === 'shipping' && key === 'Ship Date') {
                value = parseAmazonDate(value) || value;
              } else if ((type === 'productads' || type === 'brandads') && key === 'Date') {
                value = excelSerialToISODate(value) || value;
              }
              // Yearly backfill types — pre-parse dates client-side so the
              // server gets ISO strings (the server falls back to its own
              // parser, but client-side parsing is cheaper for files that
              // may contain tens of thousands of rows). For the Amazon
              // Ads SP report the date often arrives as an Excel serial
              // when the file is XLSX, or as "Jan 01, 2024" when it's
              // CSV — handle both.
              else if (type === 'transactionsyearly' && key === 'date/time') {
                value = parseAmazonDate(value) || value;
              } else if (type === 'spadspendyearly' && key === 'Date') {
                value = excelSerialToISODate(value) || parseAmazonDate(value) || value;
              } else if (type === 'shippingyearly' && key === 'ShipDate') {
                value = excelSerialToISODate(value) || value;
              }
              // Amazon flat-file "All Orders" report — purchase-date is
              // ISO 8601 (e.g. "2026-05-15T14:23:07+00:00"). Slicing to
              // first 10 chars gives the YYYY-MM-DD the server expects.
              // parseAmazonDate as a defensive fallback in case Amazon
              // ever emits a different textual format.
              else if (type === 'ordersreport' && key === 'purchase-date') {
                const iso = String(value || '').slice(0, 10);
                value = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : (parseAmazonDate(value) || value);
              }

              normalized[key] = value;
            });
            return normalized;
          });
          
          // Display info
          const fileInfo = document.querySelector(`.file-info[data-type="${type}"]`);
          fileInfo.innerHTML = `
            <div class="file-name">${file.name}</div>
            <div class="file-stats">
              <span>Size: ${formatBytes(file.size)}</span>
              <span>Rows: ${uploadedData[type].length}</span>
              ${skipRows > 0 ? `<span>Skipped: ${skipRows} metadata rows</span>` : ''}
            </div>
          `;
          fileInfo.classList.add('active');
          
          document.querySelector(`.clear-btn[data-type="${type}"]`).style.display = 'inline-block';
          
          // Preview
          displayPreview(uploadedData[type].slice(0, 5), type);
          
          document.querySelector(`.process-btn[data-type="${type}"]`).disabled = !accessToken;
          hideStatus(type);
          
        } catch (error) {
          showStatus(type, 'error', `Error: ${error.message}`);
        }
      };
      
      reader.readAsArrayBuffer(file);
    }
    
    function displayPreview(rows, type) {
      const container = document.querySelector(`.preview-table[data-type="${type}"]`);
      
      if (rows.length === 0) return;
      
      const headers = Object.keys(rows[0]).slice(0, 10);
      
      let html = '<h3 style="margin-bottom: 0.75rem; font-size: 0.875rem; color: var(--text-secondary); text-transform: uppercase;">Preview (first 5 rows, 10 columns)</h3>';
      html += '<table><thead><tr>';
      headers.forEach(h => html += `<th>${h}</th>`);
      html += '</tr></thead><tbody>';
      
      rows.forEach(row => {
        html += '<tr>';
        headers.forEach(h => {
          const val = String(row[h] || '');
          const display = val.length > 30 ? val.substring(0, 30) + '...' : val;
          html += `<td>${display}</td>`;
        });
        html += '</tr>';
      });
      
      html += '</tbody></table>';
      container.innerHTML = html;
      container.style.display = 'block';
    }
    
    // Process buttons
    document.querySelectorAll('.process-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const type = btn.dataset.type;
        await processUpload(type);
      });
    });
    
    async function processUpload(type) {
      const data = uploadedData[type];

      if (!data || !accessToken) return;
      // Recognized upload types. The first three are the regular
      // user-edited datasets (products + ad-mappings). The three
      // *yearly types are one-off backfill paths for historical years
      // older than the SP-API's ~23-month listTransactions window —
      // they land in parallel KV namespaces that the Overview's read
      // path merges with live SP-API data.
      if (!['products', 'productadmapping', 'brandadmapping',
            'transactionsyearly', 'spadspendyearly', 'shippingyearly',
            'ordersreport'].includes(type)) return;

      const btn = document.querySelector(`.process-btn[data-type="${type}"]`);
      btn.disabled = true;
      btn.innerHTML = 'Processing<span class="loading"></span>';
      hideStatus(type);

      // Products → /api/products (upsert by SKU).
      if (type === 'products') {
        try {
          const res = await fetch('/api/products?action=bulk-upsert', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ products: data })
          });
          const result = await res.json();
          if (!res.ok || !result.success) {
            throw new Error(result.error || `Upsert failed (${res.status})`);
          }
          showStatus(type, 'success',
            `✓ Success! Added ${result.addedCount}, updated ${result.updatedCount} (${result.total} total in catalog)`
          );
        } catch (err) {
          console.error('Product upload failed:', err);
          showStatus(type, 'error', `✗ ${err.message}`);
        } finally {
          btn.disabled = false;
          btn.innerHTML = 'Process';
        }
        return;
      }

      // Yearly backfill uploads + Orders Report — thin per-month POSTs.
      // Each endpoint handles its own column mapping and writes to its
      // own KV namespace. We share the same processUpload flow because
      // the parsing/preview UX is identical across all these upload tabs.
      if (type === 'transactionsyearly' || type === 'spadspendyearly' || type === 'shippingyearly' || type === 'ordersreport') {
        const endpoint =
          type === 'transactionsyearly' ? '/api/transactions?action=upload-yearly-csv' :
          type === 'spadspendyearly'    ? '/api/adspend?action=upload-yearly-csv'      :
          type === 'shippingyearly'     ? '/api/shipping?action=upload-yearly-csv'     :
                                          '/api/orders?action=upload-orders-report';
        // Filter to just the columns the server cares about. Vercel
        // Hobby serverless POST bodies cap at 4.5 MB; the raw CSVs
        // (especially the Amazon Ads SP report at ~7.5 MB) would blow
        // through that as JSON if we forwarded every column. The lists
        // below mirror the keys each upload endpoint reads (see
        // handleUploadYearlyCsv in api/transactions.js, api/adspend.js,
        // api/shipping.js). Extra fields would just be ignored on the
        // server but the bandwidth waste is real.
        const COLS = {
          transactionsyearly: [
            'date/time', 'type', 'order id', 'sku', 'description', 'quantity',
            'fulfillment',
            'product sales', 'shipping credits', 'gift wrap credits',
            'Regulatory Fee', 'promotional rebates',
            'selling fees', 'fba fees', 'other transaction fees', 'other'
          ],
          spadspendyearly: ['Date', 'Campaign Name', 'Spend'],
          shippingyearly: [
            // CarrierFee = what we paid the carrier (FBM Shipping Costs).
            // ShippingPaid = what the buyer paid Amazon (Prime = $0),
            // irrelevant to seller P&L — don't ship it.
            'ShipDate', 'OrderNumber', 'CarrierFee', 'Items',
            'Carrier', 'ServiceCode'
          ],
          // Amazon flat-file "All Orders" columns. item-price is the
          // actual transacted amount (not a lookup) — that's the whole
          // reason we're switching to this data source. item-status is
          // needed so the server can drop Cancelled rows.
          ordersreport: [
            'amazon-order-id', 'purchase-date', 'sku', 'asin',
            'quantity', 'item-price', 'fulfillment-channel',
            'item-status', 'is-business-order'
          ]
        };
        const keep = COLS[type];
        const slimRows = data.map(r => {
          const out = {};
          for (const k of keep) if (r[k] !== undefined) out[k] = r[k];
          return out;
        });

        // Vercel serverless POSTs cap at 4.5 MB. A year of transactions
        // (~5000 rows × long product descriptions) blows past that even
        // after column slimming. Solution: group rows by month on the
        // client and POST one month at a time — each ~400 rows, well
        // under the cap. The server endpoint already groups by month
        // internally, so it doesn't care whether one call carries one
        // month or twelve.
        //
        // dateKey is the column we read each row's calendar date from.
        // It differs across the three uploads — see handleFile for
        // where each is normalized to YYYY-MM-DD before this runs.
        const dateKey =
          type === 'transactionsyearly' ? 'date/time'     :
          type === 'spadspendyearly'    ? 'Date'          :
          type === 'shippingyearly'     ? 'ShipDate'      :
                                          'purchase-date';
        const byMonth = {};
        let droppedNoDate = 0;
        for (const row of slimRows) {
          const date = String(row[dateKey] || '').slice(0, 10);
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { droppedNoDate++; continue; }
          const month = date.slice(0, 7);
          if (!byMonth[month]) byMonth[month] = [];
          byMonth[month].push(row);
        }
        const monthList = Object.keys(byMonth).sort();
        if (monthList.length === 0) {
          showStatus(type, 'error',
            `✗ Couldn't parse a date from any row. Check that the file's date column matches "${dateKey}".`);
          btn.disabled = false;
          btn.innerHTML = 'Process & Upload';
          return;
        }

        // Aggregate results across the per-month POSTs so the final
        // status message looks like the original single-shot version.
        let aggRows = 0;
        const aggMonths = [];
        const aggSkipped = [];
        let aggErr = null;

        try {
          for (let i = 0; i < monthList.length; i++) {
            const m = monthList[i];
            const body = type === 'spadspendyearly'
              ? { type: 'sp', rows: byMonth[m] }
              : { rows: byMonth[m] };
            // Surface per-month progress so a 12-month transactions
            // upload doesn't look frozen mid-loop.
            btn.innerHTML = `Uploading ${m} (${i + 1}/${monthList.length})<span class="loading"></span>`;

            const res = await fetch(endpoint, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify(body)
            });
            // Vercel's 413 responses are plain text ("Request Entity Too
            // Large"), not JSON. res.json() would throw a confusing
            // SyntaxError without context. Read as text first and only
            // attempt JSON parse if it looks like JSON.
            const text = await res.text();
            let result;
            try {
              result = text ? JSON.parse(text) : {};
            } catch {
              throw new Error(
                res.status === 413
                  ? `Month ${m}: payload too large (${(JSON.stringify(body).length / 1024 / 1024).toFixed(1)} MB). Try a smaller chunk.`
                  : `Month ${m}: server returned non-JSON (${res.status}): ${text.slice(0, 100)}`
              );
            }
            if (!res.ok || !result.success) {
              throw new Error(`Month ${m}: ${result.error || `failed (${res.status})`}`);
            }
            const monthsWritten = result.months || result.writtenMonths || [];
            const skipped = result.skippedMonths || [];
            for (const w of monthsWritten) if (!aggMonths.includes(w)) aggMonths.push(w);
            for (const s of skipped) if (!aggSkipped.includes(s)) aggSkipped.push(s);
            aggRows += (result.totalRows ?? result.writtenRows ?? 0);
          }
        } catch (err) {
          aggErr = err;
        }

        if (aggErr) {
          console.error(`${type} upload failed:`, aggErr);
          showStatus(type, 'error', `✗ ${aggErr.message}`);
        } else {
          const skipNote = aggSkipped.length
            ? ` (skipped ${aggSkipped.length} month${aggSkipped.length === 1 ? '' : 's'} with existing data: ${aggSkipped.join(', ')})`
            : '';
          const dateNote = droppedNoDate
            ? `, dropped ${droppedNoDate} row${droppedNoDate === 1 ? '' : 's'} without a parseable date`
            : '';
          showStatus(type, 'success',
            `✓ Uploaded ${aggRows} rows across ${aggMonths.length} months${skipNote}${dateNote}`
          );
        }
        btn.disabled = false;
        btn.innerHTML = 'Process & Upload';
        return;
      }

      // ProductAdMapping / BrandAdMapping → /api/mappings (the API
      // groups flat CSV rows by Campaign Name, merges SKUs for product
      // mappings, and upserts into the KV dict).
      if (type === 'productadmapping' || type === 'brandadmapping') {
        const mapType = type === 'productadmapping' ? 'product' : 'brand';
        try {
          const res = await fetch(`/api/mappings?action=bulk-upsert&type=${mapType}`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ rows: data })
          });
          const result = await res.json();
          if (!res.ok || !result.success) {
            throw new Error(result.error || `Upsert failed (${res.status})`);
          }
          showStatus(type, 'success',
            `✓ Success! Added ${result.addedCount}, updated ${result.updatedCount} (${result.total} total ${mapType} mappings)`
          );
          // If the user is currently looking at the Campaign Mapping
          // page, refresh its tables so the new mappings show up
          // without a manual reload.
          const mappingPage = document.getElementById('mapping-page');
          if (mappingPage && mappingPage.classList.contains('active')) {
            setTimeout(() => loadMappingData(), 1000);
          }
        } catch (err) {
          console.error('Mapping upload failed:', err);
          showStatus(type, 'error', `✗ ${err.message}`);
        } finally {
          btn.disabled = false;
          btn.innerHTML = 'Process';
        }
        return;
      }
    }
    
    function showStatus(type, statusType, message) {
      const el = document.querySelector(`.status-message[data-type="${type}"]`);
      el.className = `status-message status-${statusType} active`;
      el.textContent = message;
    }
    
    function hideStatus(type) {
      document.querySelector(`.status-message[data-type="${type}"]`).classList.remove('active');
    }
    
    function formatBytes(bytes) {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return Math.round(bytes / Math.pow(k, i) * 100) / 100 + ' ' + sizes[i];
    }

    // ── PULL-FROM-AMAZON controller (Orders Report tab, Phase 2) ─────────────
    //
    // Handles the "Pull from Amazon" section: month-checkbox picker,
    // per-month POSTs to request-flat-file-report, and 20s polling of
    // poll-flat-file-report until the server queue drains. Server-side
    // state (`orders:v2:pending-reports`) is the source of truth so
    // closing the tab mid-pull is safe — reopening picks up where we
    // left off via list-pending-reports.

    const OR_POLL_INTERVAL_MS = 20000;
    const OR_MONTH_NAMES = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let _orPollTimer = null;

    // Build the last N months as YYYY-MM strings, most recent first.
    function _orLastNMonths(n) {
      const out = [];
      const today = new Date();
      // Start at current month (yesterday's month is the last complete
      // full month, but we want the current month to appear too since
      // sometimes users will pull the in-progress month knowing it's
      // partial).
      let y = today.getUTCFullYear();
      let m = today.getUTCMonth() + 1; // 1-indexed
      for (let i = 0; i < n; i++) {
        out.push(`${y}-${String(m).padStart(2, '0')}`);
        m -= 1;
        if (m === 0) { m = 12; y -= 1; }
      }
      return out;
    }

    // Number of months in the picker. 36 gives a full 3 years back, which
    // covers a Jan-2024 backfill from a mid-2026 vantage point with margin.
    // Amazon's order reports are documented as supporting orders "less
    // than two years old," so months older than ~24 back may fail at
    // request time — that surfaces in the status panel as a per-month
    // failure, not a silent gap.
    const OR_PICKER_MONTHS = 36;

    function _orRenderMonthGrid() {
      const grid = document.getElementById('ordersreport-month-grid');
      if (!grid || grid.dataset.built === '1') return;
      const months = _orLastNMonths(OR_PICKER_MONTHS);
      grid.innerHTML = months.map(ym => {
        const [y, m] = ym.split('-').map(Number);
        const label = `${OR_MONTH_NAMES[m - 1]} ${y}`;
        return `
          <label style="display: flex; align-items: center; gap: 0.5rem; cursor: pointer; font-size: 0.85rem; padding: 0.4rem 0.6rem; background: var(--bg-secondary); border-radius: 6px;">
            <input type="checkbox" class="ordersreport-month-cb" value="${ym}" style="cursor: pointer;">
            <span>${label}</span>
          </label>
        `;
      }).join('');
      grid.dataset.built = '1';
      // Wire "enable Pull button when >=1 checked"
      grid.addEventListener('change', () => {
        const btn = document.getElementById('ordersreport-pull-btn');
        const anyChecked = grid.querySelectorAll('.ordersreport-month-cb:checked').length > 0;
        if (btn) btn.disabled = !anyChecked || !accessToken;
      });
    }

    function _orRenderStatus(pending, lastResults) {
      const pendingEl = document.getElementById('ordersreport-status-pending');
      const resultsEl = document.getElementById('ordersreport-status-results');
      if (!pendingEl || !resultsEl) return;

      // Pending list, sorted by month asc
      const sortedPending = [...(pending || [])].sort((a, b) => a.month.localeCompare(b.month));
      if (sortedPending.length === 0) {
        pendingEl.innerHTML = '';
      } else {
        const now = Date.now();
        pendingEl.innerHTML = '<div style="margin-bottom: 0.5rem; color: var(--text-secondary);"><strong>In progress:</strong></div>' +
          sortedPending.map(p => {
            const elapsedMin = p.requestedAt
              ? Math.max(0, Math.round((now - new Date(p.requestedAt).getTime()) / 60000))
              : 0;
            const statusNote = p.currentStatus ? ` — ${p.currentStatus}` : (p.lastError ? ` — retrying (${p.lastError})` : '');
            return `<div>⏳ ${p.month} (${elapsedMin} min elapsed${statusNote})</div>`;
          }).join('');
      }

      // Last results, sorted by month desc (most recent first)
      const resultMonths = Object.keys(lastResults || {}).sort((a, b) => b.localeCompare(a));
      if (resultMonths.length === 0) {
        resultsEl.innerHTML = '';
      } else {
        resultsEl.innerHTML = '<div style="margin-bottom: 0.5rem; color: var(--text-secondary);"><strong>Recent results:</strong></div>' +
          resultMonths.slice(0, 24).map(m => {
            const r = lastResults[m];
            if (r.status === 'DONE') {
              const skipNote = r.skippedCancelled ? `, ${r.skippedCancelled} cancelled skipped` : '';
              return `<div style="color: var(--success);">✓ ${m}: ${r.rowCount} rows${skipNote}</div>`;
            }
            return `<div style="color: var(--error);">✗ ${m}: ${r.error || 'failed'}</div>`;
          }).join('');
      }
    }

    async function _orFetchInitialStatus() {
      if (!accessToken) return;
      try {
        const res = await fetch('/api/orders?action=list-pending-reports', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        _orRenderStatus(data.pending, data.lastResults);
        // If there are pending reports from a previous session, resume polling.
        if ((data.pending || []).length > 0 && !_orPollTimer) {
          _orStartPolling();
        }
      } catch (err) {
        console.warn('Failed to fetch pending reports status:', err.message);
      }
    }

    async function _orDoPoll() {
      if (!accessToken) return;
      const overwrite = document.getElementById('ordersreport-overwrite')?.checked;
      try {
        const url = `/api/orders?action=poll-flat-file-report${overwrite ? '&overwrite=true' : ''}`;
        const res = await fetch(url, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (!res.ok) throw new Error(`Poll failed (${res.status})`);
        const data = await res.json();

        // Refresh full status view — merge remaining pending + updated
        // last-results from the poll response. Server already updated
        // KV; we could also re-fetch list-pending-reports but that's an
        // extra round-trip.
        const statusRes = await fetch('/api/orders?action=list-pending-reports', {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        if (statusRes.ok) {
          const status = await statusRes.json();
          _orRenderStatus(status.pending, status.lastResults);
        }

        if (data.remaining === 0) {
          _orStopPolling();
        }
      } catch (err) {
        console.error('Poll error:', err);
        // Don't stop on transient errors — Amazon or Vercel hiccup will
        // recover on the next tick. Only user-initiated stop halts.
      }
    }

    function _orStartPolling() {
      if (_orPollTimer) return;
      _orPollTimer = setInterval(_orDoPoll, OR_POLL_INTERVAL_MS);
      // Fire an immediate poll so the user sees movement without waiting
      // 20s for the first status update.
      _orDoPoll();
    }

    function _orStopPolling() {
      if (_orPollTimer) {
        clearInterval(_orPollTimer);
        _orPollTimer = null;
      }
    }

    async function _orRequestPull() {
      if (!accessToken) return;
      const grid = document.getElementById('ordersreport-month-grid');
      const btn = document.getElementById('ordersreport-pull-btn');
      const selected = Array.from(grid.querySelectorAll('.ordersreport-month-cb:checked')).map(cb => cb.value);
      if (selected.length === 0) return;

      btn.disabled = true;
      const originalLabel = btn.innerHTML;
      btn.innerHTML = `Requesting ${selected.length} report${selected.length === 1 ? '' : 's'}<span class="loading"></span>`;

      const results = { requested: [], alreadyPending: [], failed: [] };
      for (const month of selected) {
        try {
          const res = await fetch('/api/orders?action=request-flat-file-report', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ month })
          });
          const data = await res.json();
          if (!res.ok || !data.success) {
            results.failed.push({ month, error: data.error || `failed (${res.status})` });
          } else if (data.alreadyPending) {
            results.alreadyPending.push(month);
          } else {
            results.requested.push(month);
          }
        } catch (err) {
          results.failed.push({ month, error: err.message });
        }
      }

      // Uncheck the boxes we successfully queued so a follow-on click
      // doesn't accidentally re-queue them.
      const queuedMonths = new Set([...results.requested, ...results.alreadyPending]);
      grid.querySelectorAll('.ordersreport-month-cb').forEach(cb => {
        if (queuedMonths.has(cb.value)) cb.checked = false;
      });

      btn.innerHTML = originalLabel;
      btn.disabled = grid.querySelectorAll('.ordersreport-month-cb:checked').length === 0;

      if (results.failed.length > 0) {
        console.error('Some requests failed:', results.failed);
      }

      _orStartPolling();
    }

    // Wire up controls on DOMContentLoaded — module-level so it runs
    // regardless of which page is initially visible.
    document.addEventListener('DOMContentLoaded', () => {
      _orRenderMonthGrid();

      const pullBtn = document.getElementById('ordersreport-pull-btn');
      if (pullBtn) pullBtn.addEventListener('click', _orRequestPull);

      const selectLast12 = document.getElementById('ordersreport-select-last12');
      const selectAll = document.getElementById('ordersreport-select-all');
      const selectNone = document.getElementById('ordersreport-select-none');
      const applyQuickPick = (count) => {
        const cbs = document.querySelectorAll('.ordersreport-month-cb');
        cbs.forEach((cb, i) => { cb.checked = count === -1 ? false : (i < count); });
        const anyChecked = document.querySelectorAll('.ordersreport-month-cb:checked').length > 0;
        if (pullBtn) pullBtn.disabled = !anyChecked || !accessToken;
      };
      if (selectLast12) selectLast12.addEventListener('click', () => applyQuickPick(12));
      if (selectAll)    selectAll.addEventListener('click',    () => applyQuickPick(OR_PICKER_MONTHS));
      if (selectNone)   selectNone.addEventListener('click',   () => applyQuickPick(-1));

      // Fetch initial status once auth is available. If accessToken
      // isn't set yet (pre-signin), this returns silently; enableUpload
      // is called after sign-in, so we re-run there.
      _orFetchInitialStatus();
    });

    // Re-fetch status on sign-in so the panel shows any pending reports
    // that were queued in a previous session. Hooks into the existing
    // enableUpload function via a wrapper — we can't override it here
    // (it's declared with `function` at the top of this file), but we
    // can observe DOM changes via a light poll of accessToken. Cheaper:
    // just re-check on any process-btn click or file-upload event, but
    // easiest is a tiny interval that stops once accessToken is set.
    const _orAuthWatcher = setInterval(() => {
      if (accessToken) {
        clearInterval(_orAuthWatcher);
        _orFetchInitialStatus();
        // Also enable the pull button if any months were pre-checked
        const anyChecked = document.querySelectorAll('.ordersreport-month-cb:checked').length > 0;
        const pullBtn = document.getElementById('ordersreport-pull-btn');
        if (pullBtn && anyChecked) pullBtn.disabled = false;
      }
    }, 1000);
