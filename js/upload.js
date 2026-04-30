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
      // Three remaining upload types — all Upstash-backed. Transactions,
      // shipping, and ad spend used to flow through here too but moved
      // to API-driven syncs (SP-API, ShipStation, Amazon Ads) running
      // on the monthly cron.
      if (!['products', 'productadmapping', 'brandadmapping'].includes(type)) return;

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
