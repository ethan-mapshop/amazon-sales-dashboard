    // ==================== KEYWORD TRACKER ====================
    
    let keywordData = {}; // Store loaded keyword data by quarter
    let currentKeywordQuarter = null;
    
    function showKeywordView(viewName) {
      // Hide all views
      document.querySelectorAll('.keyword-view').forEach(view => {
        view.classList.remove('active');
        view.style.display = 'none';
      });
      
      // Remove active from all tab buttons
      document.querySelectorAll('#keywords-tab .tabs .tab').forEach(btn => {
        btn.classList.remove('active');
      });
      
      // Show selected view
      const viewMap = {
        'top': 'keyword-top-view',
        'by-asin': 'keyword-by-asin-view',
        'opportunity': 'keyword-opportunity-view'
      };
      
      const viewId = viewMap[viewName];
      document.getElementById(viewId).classList.add('active');
      document.getElementById(viewId).style.display = 'block';
      
      // Set active tab button
      event.target.classList.add('active');
    }
    
    async function uploadKeywordData() {
      const fileInput = document.getElementById('keyword-file');
      const quarter = document.getElementById('keyword-quarter').value;
      const feedback = document.getElementById('keyword-upload-feedback');
      
      if (!fileInput.files || fileInput.files.length === 0) {
        showFeedback(feedback, 'error', '⚠ Please select a CSV file');
        return;
      }
      
      if (!quarter) {
        showFeedback(feedback, 'error', '⚠ Please select a quarter');
        return;
      }
      
      const file = fileInput.files[0];
      
      if (!file.name.endsWith('.csv')) {
        showFeedback(feedback, 'error', '⚠ File must be a CSV');
        return;
      }
      
      try {
        showFeedback(feedback, 'info', 'Processing CSV...');
        
        const text = await file.text();
        const lines = text.split('\n').filter(line => line.trim());
        
        if (lines.length < 2) {
          showFeedback(feedback, 'error', '⚠ CSV must have at least a header row and one data row');
          return;
        }
        
        // Parse header to find column indices
        const header = parseCSVLine(lines[0]);
        const columnIndices = findKeywordColumns(header);
        
        if (!columnIndices) {
          showFeedback(feedback, 'error', '⚠ Could not find required columns. Make sure your CSV includes: Search Query, Click Share, Conversion Share, and ASIN columns');
          return;
        }
        
        // Parse data rows
        const keywords = [];
        for (let i = 1; i < lines.length; i++) {
          const cols = parseCSVLine(lines[i]);
          
          if (cols.length < 3) continue; // Skip invalid rows
          
          const keyword = {
            query: cols[columnIndices.query] || '',
            rank: parseInt(cols[columnIndices.rank]) || 0,
            clickShare: parseFloat(cols[columnIndices.clickShare]) || 0,
            conversionShare: parseFloat(cols[columnIndices.conversionShare]) || 0,
            asins: {}
          };
          
          // Parse ASIN-specific data
          columnIndices.asinCols.forEach(asinCol => {
            const asin = asinCol.asin;
            keyword.asins[asin] = {
              clicks: parseInt(cols[asinCol.clicksIdx]) || 0,
              conversions: parseInt(cols[asinCol.conversionsIdx]) || 0
            };
          });
          
          keywords.push(keyword);
        }
        
        // Save to Upstash
        showFeedback(feedback, 'info', `Uploading ${keywords.length} keywords...`);
        
        const response = await fetch('/api/keywords?action=save', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            quarter,
            keywords
          })
        });
        
        if (response.ok) {
          const result = await response.json();
          showFeedback(feedback, 'success', `✓ Successfully uploaded ${result.keywordCount} keywords for ${quarter}!`);
          
          // Load and display data
          currentKeywordQuarter = quarter;
          keywordData[quarter] = keywords;
          
          document.getElementById('keyword-views').style.display = 'block';
          renderTopKeywords();
          populateASINFilter();
          renderOpportunityGap();
          
        } else {
          const error = await response.json();
          showFeedback(feedback, 'error', '⚠ Upload failed: ' + error.error);
        }
        
      } catch (error) {
        console.error('Error uploading keyword data:', error);
        showFeedback(feedback, 'error', '⚠ Error processing file: ' + error.message);
      }
    }
    
    function parseCSVLine(line) {
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
    }
    
    function findKeywordColumns(header) {
      const indices = {
        query: -1,
        rank: -1,
        clickShare: -1,
        conversionShare: -1,
        asinCols: []
      };
      
      // Find standard columns
      header.forEach((col, idx) => {
        const lower = col.toLowerCase();
        if (lower.includes('search query') || lower.includes('query')) {
          indices.query = idx;
        } else if (lower.includes('rank') || lower.includes('frequency')) {
          indices.rank = idx;
        } else if (lower.includes('click share')) {
          indices.clickShare = idx;
        } else if (lower.includes('conversion share') || lower.includes('purchase share')) {
          indices.conversionShare = idx;
        }
      });
      
      // Find ASIN columns (format: "#{ASIN} - Clicked ASIN", "#{ASIN} - Conversions")
      const asinMap = {};
      header.forEach((col, idx) => {
        const match = col.match(/#(\d+)\s*-\s*(.+)/);
        if (match) {
          const asin = match[1];
          const type = match[2].toLowerCase();
          
          if (!asinMap[asin]) {
            asinMap[asin] = { asin };
          }
          
          if (type.includes('click')) {
            asinMap[asin].clicksIdx = idx;
          } else if (type.includes('conver') || type.includes('purchase')) {
            asinMap[asin].conversionsIdx = idx;
          }
        }
      });
      
      indices.asinCols = Object.values(asinMap);
      
      // Validate required columns
      if (indices.query === -1 || indices.asinCols.length === 0) {
        return null;
      }
      
      return indices;
    }
    
    function renderTopKeywords() {
      const keywords = keywordData[currentKeywordQuarter] || [];
      
      // Filter to keywords where our ASINs have clicks
      const filtered = keywords.filter(kw => {
        return Object.values(kw.asins).some(asinData => asinData.clicks > 0);
      });
      
      // Sort by rank (lower is better)
      filtered.sort((a, b) => a.rank - b.rank);
      
      const tableDiv = document.getElementById('keyword-top-table');
      
      if (filtered.length === 0) {
        tableDiv.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">No keywords found with clicks.</div>';
        return;
      }
      
      let html = '<table style="border-collapse: collapse;">';
      html += '<thead><tr style="border-bottom: 2px solid var(--border);">';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Rank</th>';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Search Query</th>';
      html += '<th style="text-align: right; padding: 0.75rem; font-weight: 600;">Click Share</th>';
      html += '<th style="text-align: right; padding: 0.75rem; font-weight: 600;">Conversion Share</th>';
      html += '<th style="text-align: right; padding: 0.75rem; font-weight: 600;">Our Clicks</th>';
      html += '<th style="text-align: right; padding: 0.75rem; font-weight: 600;">Our Conversions</th>';
      html += '</tr></thead><tbody>';
      
      filtered.slice(0, 100).forEach(kw => {
        const totalClicks = Object.values(kw.asins).reduce((sum, asin) => sum + asin.clicks, 0);
        const totalConversions = Object.values(kw.asins).reduce((sum, asin) => sum + asin.conversions, 0);
        
        html += '<tr style="border-bottom: 1px solid var(--border);">';
        html += `<td style="padding: 0.75rem;">${kw.rank}</td>`;
        html += `<td style="padding: 0.75rem;">${kw.query}</td>`;
        html += `<td style="padding: 0.75rem; text-align: right;">${kw.clickShare.toFixed(2)}%</td>`;
        html += `<td style="padding: 0.75rem; text-align: right;">${kw.conversionShare.toFixed(2)}%</td>`;
        html += `<td style="padding: 0.75rem; text-align: right;">${totalClicks}</td>`;
        html += `<td style="padding: 0.75rem; text-align: right;">${totalConversions}</td>`;
        html += '</tr>';
      });
      
      html += '</tbody></table>';
      tableDiv.innerHTML = html;
    }
    
    function populateASINFilter() {
      const keywords = keywordData[currentKeywordQuarter] || [];
      const asins = new Set();
      
      keywords.forEach(kw => {
        Object.keys(kw.asins).forEach(asin => asins.add(asin));
      });
      
      const select = document.getElementById('keyword-asin-filter');
      select.innerHTML = '<option value="">Select ASIN...</option>';
      
      Array.from(asins).sort().forEach(asin => {
        select.innerHTML += `<option value="${asin}">${asin}</option>`;
      });
    }
    
    function filterKeywordsByASIN() {
      const selectedASIN = document.getElementById('keyword-asin-filter').value;
      const keywords = keywordData[currentKeywordQuarter] || [];
      
      if (!selectedASIN) {
        document.getElementById('keyword-by-asin-table').innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">Select an ASIN to view keywords.</div>';
        return;
      }
      
      // Filter keywords where this ASIN has activity
      const filtered = keywords.filter(kw => {
        const asinData = kw.asins[selectedASIN];
        return asinData && (asinData.clicks > 0 || asinData.conversions > 0);
      });
      
      // Sort by ASIN clicks descending
      filtered.sort((a, b) => b.asins[selectedASIN].clicks - a.asins[selectedASIN].clicks);
      
      const tableDiv = document.getElementById('keyword-by-asin-table');
      
      if (filtered.length === 0) {
        tableDiv.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">No keywords found for this ASIN.</div>';
        return;
      }
      
      let html = '<table style="border-collapse: collapse;">';
      html += '<thead><tr style="border-bottom: 2px solid var(--border);">';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Rank</th>';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Search Query</th>';
      html += '<th style="text-align: right; padding: 0.75rem; font-weight: 600;">Clicks</th>';
      html += '<th style="text-align: right; padding: 0.75rem; font-weight: 600;">Conversions</th>';
      html += '<th style="text-align: right; padding: 0.75rem; font-weight: 600;">CVR</th>';
      html += '</tr></thead><tbody>';
      
      filtered.forEach(kw => {
        const asinData = kw.asins[selectedASIN];
        const cvr = asinData.clicks > 0 ? (asinData.conversions / asinData.clicks * 100) : 0;
        
        html += '<tr style="border-bottom: 1px solid var(--border);">';
        html += `<td style="padding: 0.75rem;">${kw.rank}</td>`;
        html += `<td style="padding: 0.75rem;">${kw.query}</td>`;
        html += `<td style="padding: 0.75rem; text-align: right;">${asinData.clicks}</td>`;
        html += `<td style="padding: 0.75rem; text-align: right;">${asinData.conversions}</td>`;
        html += `<td style="padding: 0.75rem; text-align: right;">${cvr.toFixed(1)}%</td>`;
        html += '</tr>';
      });
      
      html += '</tbody></table>';
      tableDiv.innerHTML = html;
    }
    
    function renderOpportunityGap() {
      const keywords = keywordData[currentKeywordQuarter] || [];
      
      // Filter: rank < 100,000 (volume >100) and 0 conversions from our ASINs
      const filtered = keywords.filter(kw => {
        const totalConversions = Object.values(kw.asins).reduce((sum, asin) => sum + asin.conversions, 0);
        return kw.rank < 100000 && totalConversions === 0;
      });
      
      // Sort by rank (lower rank = higher volume)
      filtered.sort((a, b) => a.rank - b.rank);
      
      const tableDiv = document.getElementById('keyword-opportunity-table');
      
      if (filtered.length === 0) {
        tableDiv.innerHTML = '<div style="padding: 2rem; text-align: center; color: var(--text-secondary);">No opportunity gaps found.</div>';
        return;
      }
      
      let html = '<table style="border-collapse: collapse;">';
      html += '<thead><tr style="border-bottom: 2px solid var(--border);">';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Rank</th>';
      html += '<th style="text-align: left; padding: 0.75rem; font-weight: 600;">Search Query</th>';
      html += '<th style="text-align: right; padding: 0.75rem; font-weight: 600;">Click Share</th>';
      html += '<th style="text-align: right; padding: 0.75rem; font-weight: 600;">Conversion Share</th>';
      html += '<th style="text-align: right; padding: 0.75rem; font-weight: 600;">Our Clicks</th>';
      html += '</tr></thead><tbody>';
      
      filtered.slice(0, 100).forEach(kw => {
        const totalClicks = Object.values(kw.asins).reduce((sum, asin) => sum + asin.clicks, 0);
        
        html += '<tr style="border-bottom: 1px solid var(--border);">';
        html += `<td style="padding: 0.75rem;">${kw.rank}</td>`;
        html += `<td style="padding: 0.75rem;">${kw.query}</td>`;
        html += `<td style="padding: 0.75rem; text-align: right;">${kw.clickShare.toFixed(2)}%</td>`;
        html += `<td style="padding: 0.75rem; text-align: right;">${kw.conversionShare.toFixed(2)}%</td>`;
        html += `<td style="padding: 0.75rem; text-align: right;">${totalClicks}</td>`;
        html += '</tr>';
      });
      
      html += '</tbody></table>';
      tableDiv.innerHTML = html;
    }
    
    function showFeedback(element, type, message) {
      element.style.display = 'block';
      element.style.padding = '1rem';
      element.style.borderRadius = '6px';
      element.textContent = message;
      
      if (type === 'success') {
        element.style.background = 'rgba(6, 214, 160, 0.1)';
        element.style.border = '1px solid var(--success)';
        element.style.color = 'var(--success)';
      } else if (type === 'error') {
        element.style.background = 'rgba(239, 68, 68, 0.1)';
        element.style.border = '1px solid var(--error)';
        element.style.color = 'var(--error)';
      } else {
        element.style.background = 'rgba(59, 130, 246, 0.1)';
        element.style.border = '1px solid var(--accent-blue)';
        element.style.color = 'var(--accent-blue)';
      }
    }
    
