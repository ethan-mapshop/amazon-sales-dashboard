    
    // ==================== INTEGRATIONS PAGE ====================
    
    // Store original values for cancel functionality
    const originalValues = {};
    
    // Encryption utilities using Web Crypto API
    async function deriveKey(token) {
      // Derive encryption key from Google access token
      const encoder = new TextEncoder();
      const keyMaterial = await crypto.subtle.importKey(
        'raw',
        encoder.encode(token),
        { name: 'PBKDF2' },
        false,
        ['deriveKey']
      );
      
      return crypto.subtle.deriveKey(
        {
          name: 'PBKDF2',
          salt: encoder.encode('credential-encryption-salt'), // Static salt - okay since token is secret
          iterations: 100000,
          hash: 'SHA-256'
        },
        keyMaterial,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
    }
    
    async function encryptValue(value, token) {
      const encoder = new TextEncoder();
      const key = await deriveKey(token);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      
      const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        key,
        encoder.encode(value)
      );
      
      // Combine IV and encrypted data
      const combined = new Uint8Array(iv.length + encrypted.byteLength);
      combined.set(iv, 0);
      combined.set(new Uint8Array(encrypted), iv.length);
      
      // Return as base64
      return btoa(String.fromCharCode(...combined));
    }
    
    async function decryptValue(encryptedBase64, token) {
      const decoder = new TextDecoder();
      const key = await deriveKey(token);
      
      // Decode from base64
      const combined = Uint8Array.from(atob(encryptedBase64), c => c.charCodeAt(0));
      
      // Extract IV and encrypted data
      const iv = combined.slice(0, 12);
      const encrypted = combined.slice(12);
      
      const decrypted = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        key,
        encrypted
      );
      
      return decoder.decode(decrypted);
    }
    
    // Load credential values from Upstash (encrypted)
    async function loadCredentialStatus() {
      if (!accessToken) return;
      
      try {
        // Fetch encrypted credentials from Upstash (database)
        const dbResponse = await fetch('/api/credentials?action=get', {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });
        
        // Fetch Vercel env var status (read-only check)
        const vercelResponse = await fetch('/api/credentials?action=vercel-status', {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });
        
        let dbCredentials = {};
        let vercelCredentials = {};
        
        if (dbResponse.ok) {
          const data = await dbResponse.json();
          dbCredentials = data.credentials || {};
        }
        
        if (vercelResponse.ok) {
          const data = await vercelResponse.json();
          vercelCredentials = data.status || {};
        }
        
        // Decrypt and populate each credential from database
        const allKeys = [
          'AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET', 'AMAZON_REFRESH_TOKEN',
          'AMAZON_SELLER_ID', 'AMAZON_MARKETPLACE_ID',
          'ADV_CLIENT_ID', 'ADV_CLIENT_SECRET', 'ADV_REFRESH_TOKEN', 'ADV_PROFILE_ID',
          'SHIPSTATION_API_KEY', 'SHIPSTATION_API_SECRET',
          'ANTHROPIC_API_KEY', 'GOOGLE_CLIENT_ID'
        ];
        
        for (const key of allKeys) {
          const input = document.getElementById(key);
          const vercelIndicator = document.getElementById(`${key}-vercel`);
          
          // Load plaintext value from database (server decrypts)
          if (dbCredentials[key]) {
            if (input) {
              input.value = dbCredentials[key];
            }
          }
          
          // Update Vercel indicator
          if (vercelIndicator) {
            if (vercelCredentials[key]) {
              vercelIndicator.textContent = '●';
              vercelIndicator.style.color = 'var(--success)';
              vercelIndicator.title = 'Configured in Vercel';
            } else {
              vercelIndicator.textContent = '○';
              vercelIndicator.style.color = 'var(--text-secondary)';
              vercelIndicator.title = 'Not in Vercel';
            }
          }
        }
        
        // Update card-level status indicators
        updateIntegrationStatus('amazon', [
          dbCredentials.AMAZON_LWA_CLIENT_ID,
          dbCredentials.AMAZON_LWA_CLIENT_SECRET,
          dbCredentials.AMAZON_REFRESH_TOKEN,
          dbCredentials.AMAZON_SELLER_ID,
          dbCredentials.AMAZON_MARKETPLACE_ID
        ]);
        
        updateIntegrationStatus('adv', [
          dbCredentials.ADV_CLIENT_ID,
          dbCredentials.ADV_CLIENT_SECRET,
          dbCredentials.ADV_REFRESH_TOKEN,
          dbCredentials.ADV_PROFILE_ID
        ]);
        
        updateIntegrationStatus('shipstation', [
          dbCredentials.SHIPSTATION_API_KEY,
          dbCredentials.SHIPSTATION_API_SECRET
        ]);
        
        updateIntegrationStatus('anthropic', [
          dbCredentials.ANTHROPIC_API_KEY
        ]);
        
        updateIntegrationStatus('google', [
          dbCredentials.GOOGLE_CLIENT_ID
        ]);
      } catch (error) {
        console.error('Error loading credentials:', error);
      }
    }
    
    function updateIntegrationStatus(prefix, statuses) {
      const allConfigured = statuses.every(s => s);
      const someConfigured = statuses.some(s => s);
      
      const dot = document.getElementById(`${prefix}-status-dot`);
      const text = document.getElementById(`${prefix}-status-text`);
      
      if (dot && text) {
        if (allConfigured) {
          dot.style.background = 'var(--success)';
          text.style.color = 'var(--success)';
          text.textContent = 'Connected';
        } else if (someConfigured) {
          dot.style.background = 'var(--warning)';
          text.style.color = 'var(--warning)';
          text.textContent = 'Partially configured';
        } else {
          dot.style.background = 'var(--text-secondary)';
          text.style.color = 'var(--text-secondary)';
          text.textContent = 'Not configured';
        }
      }
    }
    
    function toggleReveal(key) {
      const input = document.getElementById(key);
      if (input.type === 'password') {
        input.type = 'text';
      } else {
        input.type = 'password';
      }
    }
    
    function copyToClipboard(key) {
      const input = document.getElementById(key);
      const value = input.value;
      
      if (!value || value.trim() === '') {
        alert('Nothing to copy');
        return;
      }
      
      navigator.clipboard.writeText(value).then(() => {
        // Visual feedback
        const btn = event.target;
        const originalText = btn.textContent;
        btn.textContent = '✓';
        btn.style.background = 'var(--success)';
        setTimeout(() => {
          btn.textContent = originalText;
          btn.style.background = '';
        }, 1500);
      }).catch(err => {
        alert('Failed to copy to clipboard');
      });
    }
    
    function enableEdit(key) {
      const input = document.getElementById(key);
      
      // Store original value if not already stored
      if (!originalValues[key]) {
        originalValues[key] = input.value;
      }
      
      input.readOnly = false;
      input.focus();
      input.select();
      
      // Replace edit button with save/cancel buttons
      const group = input.parentElement;
      const editBtn = group.querySelector('button[onclick*="enableEdit"]');
      
      if (editBtn) {
        // Determine if this field has a reveal button (password fields)
        const hasReveal = input.type === 'password' || input.type === 'text';
        const revealBtn = hasReveal ? `<button class="btn-icon" onclick="toggleReveal('${key}')" title="Reveal">🔍</button>` : '';
        
        editBtn.outerHTML = `
          <button class="btn-icon" onclick="saveCredential('${key}')" title="Save" style="background: var(--success);">💾</button>
          <button class="btn-icon" onclick="cancelEdit('${key}')" title="Cancel">❌</button>
        `;
      }
    }
    
    function cancelEdit(key) {
      const input = document.getElementById(key);
      
      // Restore original value
      if (originalValues[key]) {
        input.value = originalValues[key];
        delete originalValues[key];
      }
      
      input.readOnly = true;
      if (input.type === 'text' && key !== 'GOOGLE_CLIENT_ID' && key !== 'AMAZON_MARKETPLACE_ID') {
        input.type = 'password';
      }
      
      // Restore buttons - find the input group and remove ALL buttons
      const group = input.parentElement;
      const allButtons = group.querySelectorAll('button');
      allButtons.forEach(btn => btn.remove());
      
      // Re-add vercel indicator if missing
      const vercelIndicator = document.getElementById(`${key}-vercel`);
      if (!vercelIndicator) {
        const newIndicator = document.createElement('span');
        newIndicator.id = `${key}-vercel`;
        newIndicator.className = 'vercel-indicator';
        newIndicator.title = 'Vercel';
        newIndicator.textContent = '○';
        group.appendChild(newIndicator);
      }
      
      // Add back the original buttons
      const hasReveal = key !== 'GOOGLE_CLIENT_ID' && key !== 'AMAZON_MARKETPLACE_ID';
      
      if (hasReveal) {
        const revealBtn = document.createElement('button');
        revealBtn.className = 'btn-icon';
        revealBtn.title = 'Reveal';
        revealBtn.textContent = "🔍";
        revealBtn.onclick = () => toggleReveal(key);
        group.appendChild(revealBtn);
      }
      
      const copyBtn = document.createElement('button');
      copyBtn.className = 'btn-icon';
      copyBtn.title = 'Copy';
      copyBtn.textContent = '📋';
      copyBtn.onclick = () => copyToClipboard(key);
      group.appendChild(copyBtn);
      
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-icon';
      editBtn.title = 'Edit';
      editBtn.textContent = '✏️';
      editBtn.onclick = () => enableEdit(key);
      group.appendChild(editBtn);
    }
    
    async function saveCredential(key) {
      const input = document.getElementById(key);
      const value = input.value.trim();
      
      if (!value) {
        showCredentialFeedback(key, 'Value cannot be empty', 'error');
        return;
      }
      
      if (!accessToken) {
        showCredentialFeedback(key, 'Please sign in to save credentials', 'error');
        return;
      }
      
      try {
        // Save plaintext value to server (server handles encryption)
        const response = await fetch('/api/credentials?action=save', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
          },
          body: JSON.stringify({ key, value })
        });
        
        const data = await response.json();
        
        if (response.ok && data.success) {
          // Keep the value in the input but make it readonly
          input.readOnly = true;
          if (key !== 'GOOGLE_CLIENT_ID' && key !== 'AMAZON_MARKETPLACE_ID') {
            input.type = 'password';
          }
          
          // Restore buttons - remove ALL buttons and vercel indicator first
          const group = input.parentElement;
          const allButtons = group.querySelectorAll('button');
          allButtons.forEach(btn => btn.remove());
          
          // Re-add vercel indicator
          const vercelIndicator = document.getElementById(`${key}-vercel`);
          if (!vercelIndicator) {
            const newIndicator = document.createElement('span');
            newIndicator.id = `${key}-vercel`;
            newIndicator.className = 'vercel-indicator';
            newIndicator.title = 'Vercel';
            newIndicator.textContent = '○';
            group.appendChild(newIndicator);
          }
          
          // Add back the original buttons
          const hasReveal = key !== 'GOOGLE_CLIENT_ID' && key !== 'AMAZON_MARKETPLACE_ID';
          
          if (hasReveal) {
            const revealBtn = document.createElement('button');
            revealBtn.className = 'btn-icon';
            revealBtn.title = 'Reveal';
            revealBtn.textContent = "🔍";
            revealBtn.onclick = () => toggleReveal(key);
            group.appendChild(revealBtn);
          }
          
          const copyBtn = document.createElement('button');
          copyBtn.className = 'btn-icon';
          copyBtn.title = 'Copy';
          copyBtn.textContent = '📋';
          copyBtn.onclick = () => copyToClipboard(key);
          group.appendChild(copyBtn);
          
          const editBtn = document.createElement('button');
          editBtn.className = 'btn-icon';
          editBtn.title = 'Edit';
          editBtn.textContent = '✏️';
          editBtn.onclick = () => enableEdit(key);
          group.appendChild(editBtn);
          
          delete originalValues[key];
          
          // Show success feedback
          showCredentialFeedback(key, 'Saved to database!', 'success');
          
          // Refresh overall integration status
          setTimeout(() => loadCredentialStatus(), 500);
        } else {
          showCredentialFeedback(key, data.error || 'Failed to save', 'error');
        }
      } catch (error) {
        console.error('Error saving credential:', error);
        showCredentialFeedback(key, 'Error: ' + error.message, 'error');
      }
    }
    
    function showCredentialFeedback(key, message, type) {
      const row = document.getElementById(key).closest('.credential-row');
      
      // Remove any existing feedback
      const existingFeedback = row.querySelector('.credential-feedback');
      if (existingFeedback) existingFeedback.remove();
      
      // Create feedback element
      const feedback = document.createElement('div');
      feedback.className = 'credential-feedback';
      feedback.textContent = message;
      feedback.style.cssText = `
        margin-top: 0.5rem;
        padding: 0.5rem 0.75rem;
        border-radius: 4px;
        font-size: 0.875rem;
        font-weight: 500;
        ${type === 'success' 
          ? 'background: rgba(6, 214, 160, 0.1); color: var(--success); border: 1px solid var(--success);' 
          : 'background: rgba(239, 71, 111, 0.1); color: var(--error); border: 1px solid var(--error);'}
      `;
      
      row.appendChild(feedback);
      
      // Auto-remove after 5 seconds
      setTimeout(() => {
        if (feedback.parentElement) {
          feedback.remove();
        }
      }, 5000);
    }
    
    
