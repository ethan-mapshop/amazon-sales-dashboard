    // ── AUTH-EXPIRY BANNER ───────────────────────────────────────────────────
    // Google access tokens last 1 hour; we save tokenExpiry in
    // localStorage on sign-in. This periodic check surfaces a banner
    // (a) proactively when the token is within 5 minutes of expiring,
    // and (b) after expiry. Without it, the user has no signal that
    // their session died — they click "load some data," the spinner
    // spins forever, and they have to figure it out themselves.
    // showAuthBanner can also be called directly from a 401 handler
    // if a fetch surprises us with auth failure before the periodic
    // check has caught up.

    const AUTH_BANNER_WARN_MS = 5 * 60 * 1000; // warn 5 min before expiry

    function showAuthBanner(state) {
      // state: 'expired' | 'warn' | 'hide'
      const banner = document.getElementById('auth-expired-banner');
      const text   = document.getElementById('auth-expired-text');
      const btn    = document.getElementById('auth-expired-signin-btn');
      if (!banner || !text || !btn) return;
      if (state === 'hide') {
        banner.style.display = 'none';
        document.body.classList.remove('auth-banner-active');
        return;
      }
      banner.classList.toggle('warn', state === 'warn');
      const expiry  = parseInt(localStorage.getItem('tokenExpiry') || '0', 10);
      const minutes = Math.max(1, Math.ceil((expiry - Date.now()) / 60000));
      if (state === 'warn') {
        text.textContent = `⚠ Your Google sign-in expires in ${minutes} minute${minutes === 1 ? '' : 's'}. Click to renew.`;
        btn.textContent = 'Renew';
      } else {
        text.textContent = '⚠ Your Google sign-in has expired. Click Sign In to continue.';
        btn.textContent = 'Sign In';
      }
      banner.style.display = 'flex';
      document.body.classList.add('auth-banner-active');
    }

    function checkAuthExpiry() {
      const expiry = parseInt(localStorage.getItem('tokenExpiry') || '0', 10);
      // No saved token yet → not signed in. The initial auth UI handles
      // that case; banner stays hidden.
      if (!expiry) { showAuthBanner('hide'); return; }
      const remaining = expiry - Date.now();
      if (remaining <= 0)                       showAuthBanner('expired');
      else if (remaining <= AUTH_BANNER_WARN_MS) showAuthBanner('warn');
      else                                       showAuthBanner('hide');
    }
    // Expose so any fetch site catching a 401 can force the banner
    // immediately, before the periodic check ticks.
    window.showAuthExpiredBanner = () => showAuthBanner('expired');

    // Run an initial check on load and every 30 seconds thereafter.
    document.addEventListener('DOMContentLoaded', () => {
      checkAuthExpiry();
      setInterval(checkAuthExpiry, 30000);

      const banner = document.getElementById('auth-expired-banner');
      const btn    = document.getElementById('auth-expired-signin-btn');
      if (btn) {
        btn.addEventListener('click', () => {
          // Disable the button so the user can't double-click while
          // the OAuth popup is open.
          btn.disabled = true;
          btn.textContent = 'Opening…';
          if (tokenClient) {
            tokenClient.requestAccessToken();
          } else {
            // Token client wasn't ready (rare) — re-init and try again.
            initializeGoogleAuth();
            setTimeout(() => {
              if (tokenClient) tokenClient.requestAccessToken();
              else {
                btn.disabled = false;
                btn.textContent = 'Sign In';
              }
            }, 500);
          }
        });
      }
    });

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
              // Hide the expiry banner if it was showing, and reset its
              // button (it may have been left in a disabled "Opening…"
              // state by the click handler that triggered this re-auth).
              showAuthBanner('hide');
              const renewBtn = document.getElementById('auth-expired-signin-btn');
              if (renewBtn) {
                renewBtn.disabled = false;
                renewBtn.textContent = 'Sign In';
              }
              // Kick off the data fetch for whichever page + tab is
              // active so the user lands on a populated report instead of
              // having to click around to trigger the first load.
              triggerCurrentPageLoad();
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
        // Default to Overview Monthly Profitability. showMonthlyV2024()
        // handles the auto-load itself via the first-view flag (gated on
        // accessToken), so triggerCurrentPageLoad will fire it after
        // sign-in if the user lands here pre-auth.
        showMonthlyV2024();
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

    // Called from the OAuth callback after a successful sign-in. Loads
    // data for whichever page + tab/sub-tab the user is currently on,
    // so signing in always populates the report in front of them rather
    // than dropping them on a default page or leaving the active view
    // empty. Each page-specific block below is the same dispatch logic
    // showPage() runs when navigating into a page, but tab-aware: we
    // honor the user's active tab instead of resetting to the default.
    function triggerCurrentPageLoad() {
      if (!accessToken) return;
      const activePage = document.querySelector('.page.active');
      if (!activePage) return;
      const pageName = activePage.id.replace(/-page$/, '');

      switch (pageName) {
        case 'overview': {
          const activeTab = document.querySelector('#overview-page .page-header .tabs .tab.active');
          const tabId = activeTab ? activeTab.id : 'monthly-v2024-tab';
          if (tabId === 'ytd-v2024-tab' && typeof showYTDV2024 === 'function') showYTDV2024();
          else if (tabId === 'charts-v2024-tab' && typeof showChartsV2024 === 'function') showChartsV2024();
          else if (tabId === 'brandproduct-v2024-tab' && typeof showBrandProductV2024 === 'function') showBrandProductV2024();
          else if (typeof showMonthlyV2024 === 'function') showMonthlyV2024();
          break;
        }
        case 'salesvolume': {
          if (typeof loadSalesVolumeData !== 'function') break;
          // loadSalesVolumeData is async and populates svAllProducts,
          // which the Price Change Impacts sub-tab depends on. If the
          // user's last view was that sub-tab, kick initPCI() once
          // products are in.
          const result = loadSalesVolumeData();
          const activeSubtab = document.querySelector('#salesvolume-page .tabs .tab.active');
          if (activeSubtab && activeSubtab.id === 'sv-tab-priceimpact' && typeof initPCI === 'function') {
            Promise.resolve(result).then(() => initPCI()).catch(() => {});
          }
          break;
        }
        case 'listing': {
          const activeTab = document.querySelector('#listing-page .tab.active');
          const tabId = activeTab ? activeTab.id : 'listing-tab-changelog';
          if (tabId === 'listing-tab-sessions') {
            if (typeof loadSessionData === 'function') loadSessionData();
          } else {
            if (typeof loadChangeLogASINs === 'function') loadChangeLogASINs();
            if (typeof loadChangeLog === 'function') loadChangeLog();
          }
          break;
        }
        case 'catalog':
          if (typeof loadProductCatalog === 'function') loadProductCatalog();
          break;
        case 'mapping':
          if (typeof loadMappingData === 'function') loadMappingData();
          break;
        case 'integrations':
          if (typeof loadCredentialStatus === 'function') loadCredentialStatus();
          break;
        case 'adredflags':
          if (typeof loadAdRedFlags === 'function') loadAdRedFlags();
          break;
        // upload page has no data fetch
      }
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
      // Hide the expiry banner before reload — without this, the brief
      // moment between removing tokenExpiry and the page reload would
      // re-trigger checkAuthExpiry and flash the "expired" banner.
      showAuthBanner('hide');
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
    
