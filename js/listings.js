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
    
    // Load brands and products from Products sheet
    async function loadChangeLogASINs() {
      if (!accessToken) return;
      
      try {
        const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/Products!A2:G`, {
          headers: { 'Authorization': `Bearer ${accessToken}` }
        });
        
        const data = await response.json();
        
        if (data.values && data.values.length > 0) {
          // Store products - A=sku, B=name, C=brand, F=asin, G=productType
          // For Listing Optimization: only show Parent and Non-Variable products
          allProducts = data.values
            .filter(row => {
              const asin = row[5];
              const productType = row[6] || '';
              return asin && 
                     asin.toUpperCase() !== 'N/A' && 
                     (productType === 'Parent' || productType === 'Non-Variable');
            })
            .map(row => ({
              sku: row[0],
              name: row[1] || row[0],
              brand: row[2] || 'Unknown',
              asin: row[5],
              productType: row[6] || ''
            }));
          
          // Get unique brands
          const brands = [...new Set(allProducts.map(p => p.brand))].sort();
          
          // Populate brand dropdown
          const brandSelect = document.getElementById('changelog-brand');
          brandSelect.innerHTML = '<option value="">All Brands</option>';
          brands.forEach(brand => {
            brandSelect.innerHTML += `<option value="${brand}">${brand}</option>`;
          });
          
          // Populate products (all initially)
          filterChangeLogProducts();
        }
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
      if (!accessToken) {
        alert('Please sign in to save changes');
        return;
      }
      
      const productSelect = document.getElementById('changelog-product');
      const asin = productSelect.value;
      const date = document.getElementById('changelog-date').value;
      const notes = document.getElementById('changelog-notes').value.trim();
      
      if (!asin) {
        alert('Please select a product');
        return;
      }
      
      if (!date) {
        alert('Please select a date');
        return;
      }
      
      // Get checked changes
      const checkboxes = document.querySelectorAll('#changelog-tab input[type="checkbox"]:checked');
      const changes = Array.from(checkboxes).map(cb => cb.value);
      
      if (changes.length === 0) {
        alert('Please select at least one change type');
        return;
      }
      
      try {
        // Get product name from selected option
        const productName = productSelect.options[productSelect.selectedIndex].getAttribute('data-name');
        
        // Append to ListingChangeLog sheet
        const response = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ListingChangeLog!A:E:append?valueInputOption=USER_ENTERED`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              values: [[
                date,
                productName,
                asin,
                changes.join(', '),
                notes
              ]]
            })
          }
        );
        
        if (response.ok) {
          // Show success message
          const feedback = document.getElementById('changelog-save-feedback');
          feedback.style.display = 'block';
          feedback.style.padding = '1rem';
          feedback.style.background = 'rgba(6, 214, 160, 0.1)';
          feedback.style.border = '1px solid var(--success)';
          feedback.style.borderRadius = '6px';
          feedback.style.color = 'var(--success)';
          feedback.textContent = '✓ Change log entry saved successfully!';
          
          setTimeout(() => {
            feedback.style.display = 'none';
          }, 5000);
          
          // Clear form
          document.getElementById('changelog-brand').value = '';
          document.getElementById('changelog-product').value = '';
          filterChangeLogProducts(); // Reset product list
          document.getElementById('changelog-date').valueAsDate = new Date();
          document.getElementById('changelog-notes').value = '';
          document.querySelectorAll('#changelog-tab input[type="checkbox"]').forEach(cb => cb.checked = false);
          document.getElementById('changelog-notes-count').textContent = '0';
          
          // Reload table
          loadChangeLog();
        } else {
          alert('Failed to save change log entry');
        }
      } catch (error) {
        console.error('Error saving change log:', error);
        alert('Error saving change log: ' + error.message);
      }
    }
    
    async function loadChangeLog() {
      if (!accessToken) return;
      
      try {
        const response = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ListingChangeLog!A2:E`,
          {
            headers: { 'Authorization': `Bearer ${accessToken}` }
          }
        );
        
        const data = await response.json();
        const tableDiv = document.getElementById('changelog-table');
        
        if (!data.values || data.values.length === 0) {
          tableDiv.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">No changes logged yet. Add your first entry above.</div>';
          return;
        }
        
        // Sort by date descending
        const rows = data.values.sort((a, b) => new Date(b[0]) - new Date(a[0]));
        
        let html = '<table style="width: 100%; border-collapse: collapse;">';
        html += '<thead><tr style="border-bottom: 2px solid var(--border);">';
        html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Date</th>';
        html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Product</th>';
        html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">ASIN</th>';
        html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Changes Made</th>';
        html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Notes</th>';
        html += '</tr></thead><tbody>';
        
        rows.forEach(row => {
          html += '<tr style="border-bottom: 1px solid var(--border);">';
          html += `<td style="padding: 0.75rem;">${row[0] || ''}</td>`;
          html += `<td style="padding: 0.75rem;">${row[1] || ''}</td>`;
          html += `<td style="padding: 0.75rem; font-family: 'Roboto Mono', monospace;">${row[2] || ''}</td>`;
          html += `<td style="padding: 0.75rem;">${row[3] || ''}</td>`;
          html += `<td style="padding: 0.75rem; color: var(--text-secondary);">${row[4] || ''}</td>`;
          html += '</tr>';
        });
        
        html += '</tbody></table>';
        tableDiv.innerHTML = html;
        
        // Setup search functionality
        setupChangeLogSearch(rows);
      } catch (error) {
        console.error('Error loading change log:', error);
        document.getElementById('changelog-table').innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--error);">Error loading change log</div>';
      }
    }
    
    // Search functionality for change log
    let changeLogData = [];
    
    function setupChangeLogSearch(rows) {
      changeLogData = rows;
      
      const searchInput = document.getElementById('changelog-search');
      if (searchInput) {
        searchInput.addEventListener('input', filterChangeLog);
      }
    }
    
    function filterChangeLog() {
      const searchTerm = document.getElementById('changelog-search').value.toLowerCase();
      const tableDiv = document.getElementById('changelog-table');
      
      if (!searchTerm) {
        // Show all if search is empty
        renderChangeLogTable(changeLogData);
        return;
      }
      
      // Filter rows
      const filtered = changeLogData.filter(row => {
        return row.some(cell => 
          cell && cell.toString().toLowerCase().includes(searchTerm)
        );
      });
      
      renderChangeLogTable(filtered);
    }
    
    function renderChangeLogTable(rows) {
      const tableDiv = document.getElementById('changelog-table');
      
      if (rows.length === 0) {
        tableDiv.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">No matching changes found.</div>';
        return;
      }
      
      let html = '<table style="width: 100%; border-collapse: collapse;">';
      html += '<thead><tr style="border-bottom: 2px solid var(--border);">';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Date</th>';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Product</th>';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">ASIN</th>';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Changes Made</th>';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Notes</th>';
      html += '</tr></thead><tbody>';
      
      rows.forEach(row => {
        html += '<tr style="border-bottom: 1px solid var(--border);">';
        html += `<td style="padding: 0.75rem;">${row[0] || ''}</td>`;
        html += `<td style="padding: 0.75rem;">${row[1] || ''}</td>`;
        html += `<td style="padding: 0.75rem; font-family: 'Roboto Mono', monospace;">${row[2] || ''}</td>`;
        html += `<td style="padding: 0.75rem;">${row[3] || ''}</td>`;
        html += `<td style="padding: 0.75rem; color: var(--text-secondary);">${row[4] || ''}</td>`;
        html += '</tr>';
      });
      
      html += '</tbody></table>';
      tableDiv.innerHTML = html;
    }
    
    // Bulk upload functions
    function openBulkUpload() {
      document.getElementById('bulk-upload-modal').style.display = 'flex';
      document.getElementById('bulk-upload-file').value = '';
      document.getElementById('bulk-upload-preview').innerHTML = '';
      document.getElementById('bulk-upload-feedback').style.display = 'none';
    }
    
    function closeBulkUpload() {
      document.getElementById('bulk-upload-modal').style.display = 'none';
    }
    
    async function processBulkUpload() {
      const fileInput = document.getElementById('bulk-upload-file');
      const feedback = document.getElementById('bulk-upload-feedback');
      
      if (!fileInput.files || fileInput.files.length === 0) {
        feedback.style.display = 'block';
        feedback.style.padding = '1rem';
        feedback.style.background = 'rgba(239, 68, 68, 0.1)';
        feedback.style.border = '1px solid var(--error)';
        feedback.style.borderRadius = '6px';
        feedback.style.color = 'var(--error)';
        feedback.textContent = '⚠ Please select a CSV file';
        return;
      }
      
      const file = fileInput.files[0];
      
      if (!file.name.endsWith('.csv')) {
        feedback.style.display = 'block';
        feedback.style.padding = '1rem';
        feedback.style.background = 'rgba(239, 68, 68, 0.1)';
        feedback.style.border = '1px solid var(--error)';
        feedback.style.borderRadius = '6px';
        feedback.style.color = 'var(--error)';
        feedback.textContent = '⚠ File must be a CSV';
        return;
      }
      
      try {
        const text = await file.text();
        const lines = text.split('\n').filter(line => line.trim());
        
        if (lines.length < 2) {
          feedback.style.display = 'block';
          feedback.style.padding = '1rem';
          feedback.style.background = 'rgba(239, 68, 68, 0.1)';
          feedback.style.border = '1px solid var(--error)';
          feedback.style.borderRadius = '6px';
          feedback.style.color = 'var(--error)';
          feedback.textContent = '⚠ CSV must have at least a header row and one data row';
          return;
        }
        
        // Parse CSV (skip header)
        const rows = lines.slice(1).map(line => {
          // Simple CSV parser (handles commas in quotes)
          const cols = [];
          let current = '';
          let inQuotes = false;
          
          for (let i = 0; i < line.length; i++) {
            const char = line[i];
            
            if (char === '"') {
              inQuotes = !inQuotes;
            } else if (char === ',' && !inQuotes) {
              cols.push(current.trim());
              current = '';
            } else {
              current += char;
            }
          }
          cols.push(current.trim());
          
          return cols;
        });
        
        // Validate structure
        const invalidRows = rows.filter(row => row.length < 3);
        if (invalidRows.length > 0) {
          feedback.style.display = 'block';
          feedback.style.padding = '1rem';
          feedback.style.background = 'rgba(239, 68, 68, 0.1)';
          feedback.style.border = '1px solid var(--error)';
          feedback.style.borderRadius = '6px';
          feedback.style.color = 'var(--error)';
          feedback.textContent = `⚠ Invalid format: All rows must have at least 3 columns (Date, ASIN, Changes). Found ${invalidRows.length} invalid row(s).`;
          return;
        }
        
        // Create ASIN to product name lookup
        const asinToName = {};
        allProducts.forEach(p => {
          if (!asinToName[p.asin]) {
            asinToName[p.asin] = p.name;
          }
        });
        
        // Prepare rows for upload
        const uploadRows = [];
        const notFoundAsins = [];
        
        rows.forEach((row, idx) => {
          const date = row[0];
          const asin = row[1];
          const changes = row[2];
          const notes = row[3] || '';
          
          // Validate date format
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            feedback.style.display = 'block';
            feedback.style.padding = '1rem';
            feedback.style.background = 'rgba(239, 68, 68, 0.1)';
            feedback.style.border = '1px solid var(--error)';
            feedback.style.borderRadius = '6px';
            feedback.style.color = 'var(--error)';
            feedback.textContent = `⚠ Row ${idx + 2}: Date must be in YYYY-MM-DD format (found: ${date})`;
            throw new Error('Invalid date format');
          }
          
          // Look up product name
          const productName = asinToName[asin];
          
          if (!productName) {
            notFoundAsins.push(asin);
            return;
          }
          
          uploadRows.push([date, productName, asin, changes, notes]);
        });
        
        if (notFoundAsins.length > 0) {
          feedback.style.display = 'block';
          feedback.style.padding = '1rem';
          feedback.style.background = 'rgba(239, 68, 68, 0.1)';
          feedback.style.border = '1px solid var(--error)';
          feedback.style.borderRadius = '6px';
          feedback.style.color = 'var(--error)';
          feedback.textContent = `⚠ ASINs not found in Products sheet: ${notFoundAsins.join(', ')}`;
          return;
        }
        
        // Upload to Google Sheets
        const response = await fetch(
          `https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}/values/ListingChangeLog!A:E:append?valueInputOption=USER_ENTERED`,
          {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${accessToken}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              values: uploadRows
            })
          }
        );
        
        if (response.ok) {
          feedback.style.display = 'block';
          feedback.style.padding = '1rem';
          feedback.style.background = 'rgba(6, 214, 160, 0.1)';
          feedback.style.border = '1px solid var(--success)';
          feedback.style.borderRadius = '6px';
          feedback.style.color = 'var(--success)';
          feedback.textContent = `✓ Successfully uploaded ${uploadRows.length} change(s)!`;
          
          // Reload table
          setTimeout(() => {
            loadChangeLog();
            closeBulkUpload();
          }, 2000);
        } else {
          throw new Error('Upload failed');
        }
        
      } catch (error) {
        console.error('Bulk upload error:', error);
        if (error.message !== 'Invalid date format') {
          feedback.style.display = 'block';
          feedback.style.padding = '1rem';
          feedback.style.background = 'rgba(239, 68, 68, 0.1)';
          feedback.style.border = '1px solid var(--error)';
          feedback.style.borderRadius = '6px';
          feedback.style.color = 'var(--error)';
          feedback.textContent = '⚠ Error processing file: ' + error.message;
        }
      }
    }
    
