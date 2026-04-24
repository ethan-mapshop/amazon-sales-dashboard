    // Google Auth
    function initializeGoogleAuth() {
      if (!config.clientId) return;
      
      // Show sign-in button immediately
      const signInBtn = document.getElementById('signInBtn');
      if (signInBtn) signInBtn.style.display = 'inline-flex';
      
      // Check for saved token
      const savedToken = localStorage.getItem('googleAccessToken');
      const tokenExpiry = localStorage.getItem('tokenExpiry');
      
      if (savedToken && tokenExpiry && Date.now() < parseInt(tokenExpiry)) {
        accessToken = savedToken;
        displayUserInfo(null);
        enableUpload();
        return; // Already signed in
      }
      
      // Only initialize token client if google.accounts is available
      if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
        tokenClient = google.accounts.oauth2.initTokenClient({
          client_id: config.clientId,
          scope: 'https://www.googleapis.com/auth/spreadsheets',
          callback: (response) => {
            if (response.access_token) {
              accessToken = response.access_token;
              // Save token (expires in 1 hour)
              localStorage.setItem('googleAccessToken', accessToken);
              localStorage.setItem('tokenExpiry', Date.now() + 3600000); // 1 hour
              // Show signed in state
              displayUserInfo(null);
              enableUpload();
              // Kick off the data fetch for whichever overview tab is active
              // so the user lands on a populated report instead of having to
              // click a tab/button to trigger the first load.
              triggerCurrentOverviewLoad();
            } else {
              showAuthError('Failed to get access token');
            }
          },
        });
      }
    }
    
    // Try to initialize on DOMContentLoaded
    document.addEventListener('DOMContentLoaded', () => {
      initializeGoogleAuth();
      
      // Restore saved page and tab
      const savedPage = localStorage.getItem('currentPage');
      const savedListingTab = localStorage.getItem('currentListingTab');
      
      if (savedPage && document.getElementById(`${savedPage}-page`)) {
        showPage(savedPage);
        
        // If it's the listing page, restore the sub-tab
        if (savedPage === 'listing' && savedListingTab) {
          setTimeout(() => {
            const tabButton = Array.from(document.querySelectorAll('#listing-page .tab'))
              .find(btn => btn.getAttribute('onclick')?.includes(`'${savedListingTab}'`));
            if (tabButton) {
              tabButton.click();
            }
          }, 100);
        }
      } else {
        // Default to Overview Monthly
        showMonthly();
        setTimeout(() => {
          if (accessToken) {
            generateMonthlyReport();
          }
        }, 100);
      }
    });
    
    // Also try on window load as backup
    window.addEventListener('load', () => {
      // Wait a bit for Google API to be ready
      setTimeout(() => {
        if (!tokenClient && config.clientId) {
          initializeGoogleAuth();
        }
      }, 200);
    });
    
    function updateAuthUI() {
      if (config.clientId && !tokenClient) initializeGoogleAuth();
    }

    // Called from the OAuth callback after a successful sign-in. Only fires
    // a load if the user is currently looking at the Overview page — we don't
    // want to yank them to a different page or kick off fetches for pages
    // they aren't viewing. Which generate function runs depends on the
    // currently-active Overview tab.
    function triggerCurrentOverviewLoad() {
      const overviewPage = document.getElementById('overview-page');
      if (!overviewPage || !overviewPage.classList.contains('active')) return;
      const activeTab = document.querySelector('#overview-page .page-header .tabs .tab.active');
      if (!activeTab) return;
      const tabId = activeTab.id;
      if (tabId === 'monthly-tab' && typeof showMonthly === 'function') showMonthly();
      else if (tabId === 'ytd-tab' && typeof showYTD === 'function') showYTD();
      else if (tabId === 'monthly-upstash-tab' && typeof showMonthlyUpstash === 'function') showMonthlyUpstash();
      else if (tabId === 'ytd-upstash-tab' && typeof showYTDUpstash === 'function') showYTDUpstash();
    }
    
    document.addEventListener('DOMContentLoaded', () => {
      const signInBtn = document.getElementById('signInBtn');
      if (signInBtn) {
        signInBtn.addEventListener('click', () => {
          if (tokenClient) tokenClient.requestAccessToken();
        });
      }
    });
    
    function displayUserInfo(userInfo) {
      document.getElementById('authSection').innerHTML = `
        <button class="signed-in-btn" onclick="signOut()" title="Click to sign out">
          <span class="signed-in-label">
            <span class="signed-in-check">✓</span>
            <span class="signed-in-text">Signed In</span>
          </span>
          <span class="sign-out-label">Sign Out</span>
        </button>
      `;
    }
    
    function signOut() {
      accessToken = null;
      localStorage.removeItem('googleAccessToken');
      localStorage.removeItem('tokenExpiry');
      location.reload();
    }
    
    function showAuthError(message) {
      // Just show the sign in button on error
      document.getElementById('authSection').innerHTML = `
        <div class="auth-section" style="padding: 1rem;">
          <button class="btn btn-google" id="signInBtn" style="padding: 0.625rem 1.25rem; font-size: 0.875rem;">
            <svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Sign In
          </button>
        </div>
      `;
      
      // Re-attach click handler
      const newBtn = document.getElementById('signInBtn');
      if (newBtn) {
        newBtn.addEventListener('click', () => {
          if (tokenClient) tokenClient.requestAccessToken();
        });
      }
    }
    
