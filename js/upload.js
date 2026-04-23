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
      // Convert Excel serial number to ISO date (YYYY-MM-DD)
      // Avoiding timezone issues by calculating directly
      if (!serial || isNaN(serial)) return null;
      
      // Excel's epoch is December 30, 1899 (serial 0)
      // Calculate days since epoch
      const days = Math.floor(serial);
      
      // Excel bug: treats 1900 as a leap year (it wasn't)
      // So dates after Feb 28, 1900 need adjustment
      const adjustedDays = days > 59 ? days - 1 : days;
      
      // Calculate from epoch using UTC to avoid timezone shifts
      const epochDate = Date.UTC(1899, 11, 30); // Dec 30, 1899
      const millisecondsPerDay = 24 * 60 * 60 * 1000;
      const targetTime = epochDate + (adjustedDays * millisecondsPerDay);
      const date = new Date(targetTime);
      
      // Use UTC methods to extract date parts (no timezone conversion)
      const year = date.getUTCFullYear();
      const month = String(date.getUTCMonth() + 1).padStart(2, '0');
      const day = String(date.getUTCDate()).padStart(2, '0');
      return `${year}-${month}-${day}`;
    }
    
    function detectAndSkipMetadata(jsonData) {
      // Check if first row contains Amazon metadata
      if (jsonData.length === 0) return { data: jsonData, skipped: 0 };
      
      const firstRow = jsonData[0];
      const firstValue = Object.values(firstRow)[0];
      
      // If first value contains metadata text, this file has the 7-row header
      if (firstValue && typeof firstValue === 'string' && 
          firstValue.includes('Includes Amazon Marketplace')) {
        // Skip first 7 rows and re-read
        return { needsReparse: true, skipRows: 7 };
      }
      
      return { data: jsonData, skipped: 0 };
    }
    
    function handleFile(file, type) {
      const reader = new FileReader();
      const sheetConfig = SHEET_CONFIGS[type];
      
      reader.onload = (e) => {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });
          const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
          
          let jsonData;
          let skipRows = sheetConfig.skipRows;
          
          // First pass - check for metadata
          let initialData = XLSX.utils.sheet_to_json(firstSheet);
          const metadataCheck = detectAndSkipMetadata(initialData);
          
          if (metadataCheck.needsReparse) {
            // File has metadata, skip those rows
            skipRows = metadataCheck.skipRows;
          }
          
          // Parse with correct skip
          if (skipRows > 0) {
            const range = XLSX.utils.decode_range(firstSheet['!ref']);
            range.s.r = skipRows;
            const newRange = XLSX.utils.encode_range(range);
            jsonData = XLSX.utils.sheet_to_json(firstSheet, { range: newRange });
          } else {
            jsonData = initialData;
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
      const sheetConfig = SHEET_CONFIGS[type];

      if (!data || !accessToken) return;
      // Products now lives in Upstash (not the Sheet), so it doesn't need
      // SPREADSHEET_ID — every other type still does.
      if (type !== 'products' && !SPREADSHEET_ID) return;

      const btn = document.querySelector(`.process-btn[data-type="${type}"]`);
      btn.disabled = true;
      btn.innerHTML = 'Processing<span class="loading"></span>';
      hideStatus(type);

      // Products bypass the Sheets path entirely and upsert into Upstash via
      // /api/products. Same update-or-add-by-SKU semantics as before.
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

      try {
        const spreadsheetId = SPREADSHEET_ID;
        const sheetName = sheetConfig.sheetName;
        
        // Get existing data
        const getUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${sheetName}`;
        const getResponse = await fetch(getUrl, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        
        if (!getResponse.ok) throw new Error(`Failed to read ${sheetName} sheet`);
        
        const existingSheet = await getResponse.json();
        const existingRows = existingSheet.values || [];
        
        if (existingRows.length === 0) throw new Error(`${sheetName} sheet appears empty`);
        
        const headers = existingRows[0];
        
        let addedCount = 0;
        let updatedCount = 0;
        let skippedCount = 0;
        
        if (sheetConfig.allowUpdates && sheetConfig.uniqueKey) {
          // Products: update or add
          const keyIndex = headers.indexOf(sheetConfig.uniqueKey);
          if (keyIndex === -1) throw new Error(`${sheetConfig.uniqueKey} column not found`);
          
          const keyToRowIndex = {};
          for (let i = 1; i < existingRows.length; i++) {
            const key = existingRows[i][keyIndex];
            if (key) keyToRowIndex[key] = i;
          }
          
          const updates = [];
          const newRows = [];
          
          data.forEach(item => {
            const key = item[sheetConfig.uniqueKey];
            const rowData = headers.map(h => item[h] || '');
            
            if (keyToRowIndex[key] !== undefined) {
              const rowIndex = keyToRowIndex[key];
              updates.push({
                range: `${sheetName}!A${rowIndex + 1}:${String.fromCharCode(65 + headers.length - 1)}${rowIndex + 1}`,
                values: [rowData]
              });
              updatedCount++;
            } else {
              newRows.push(rowData);
              addedCount++;
            }
          });
          
          if (updates.length > 0) {
            const updateUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values:batchUpdate`;
            await fetch(updateUrl, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({
                valueInputOption: 'RAW',
                data: updates
              })
            });
          }
          
          if (newRows.length > 0) {
            const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${sheetName}:append?valueInputOption=RAW`;
            await fetch(appendUrl, {
              method: 'POST',
              headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
              },
              body: JSON.stringify({ values: newRows })
            });
          }
          
          showStatus(type, 'success', 
            `✓ Success! Added ${addedCount}, updated ${updatedCount} (${data.length} total)`
          );
          
        } else if (sheetConfig.uniqueKey) {
          // Transactions/Shipping: check duplicates, append new
          const keyIndex = headers.findIndex(h => h.includes(sheetConfig.uniqueKey));
          if (keyIndex === -1) throw new Error(`${sheetConfig.uniqueKey} column not found`);
          
          const existingKeys = new Set();
          for (let i = 1; i < existingRows.length; i++) {
            const key = existingRows[i][keyIndex];
            if (key) existingKeys.add(key);
          }
          
          const newData = data.filter(item => {
            const key = item[sheetConfig.uniqueKey];
            if (existingKeys.has(key)) {
              skippedCount++;
              return false;
            }
            return true;
          });
          
          if (newData.length === 0) {
            showStatus(type, 'error', `All ${data.length} items already exist`);
            return;
          }
          
          const newRows = newData.map(item => headers.map(h => item[h] || ''));
          
          const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${sheetName}:append?valueInputOption=RAW`;
          await fetch(appendUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values: newRows })
          });
          
          const msg = skippedCount > 0
            ? `✓ Success! Added ${newData.length} (skipped ${skippedCount} duplicates)`
            : `✓ Success! Added ${newData.length} items`;
          
          showStatus(type, 'success', msg);
          
        } else {
          // Ad spend & mappings: just append everything
          const newRows = data.map(item => headers.map(h => item[h] || ''));
          
          const appendUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${sheetName}:append?valueInputOption=RAW`;
          await fetch(appendUrl, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({ values: newRows })
          });
          
          showStatus(type, 'success', `✓ Success! Added ${data.length} items`);
        }
        
        // Reload mapping data if we're on mapping page and uploaded mapping data
        if ((type === 'productadmapping' || type === 'brandadmapping') && 
            document.getElementById('mapping-page').classList.contains('active')) {
          setTimeout(() => loadMappingData(), 1000);
        }
        
      } catch (error) {
        showStatus(type, 'error', `Error: ${error.message}`);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Process & Upload';
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
