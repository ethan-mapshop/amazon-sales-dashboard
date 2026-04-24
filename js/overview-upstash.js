    // Profitability Overview — Upstash-backed variant.
    //
    // Storage model: /api/transactions stores the RAW SP-API FinancialEvents
    // pages only. All mapping/categorization happens here on the client, so
    // iterating on the schema requires no re-sync — just a reload.
    //
    // Scope of what's wired right now:
    //   ShipmentEventList (type='Order') and RefundEventList (type='Refund')
    //   — both mapped per the same schema:
    //     sale             ← ChargeType: Principal
    //                          Orders  → FBM/FBA Sales
    //                          Refunds → FBM/FBA Returns
    //     other charges    ← ChargeType: GiftWrap, Shipping, ShippingCharge,
    //                                    ReturnShipping (Refunds), and any
    //                                    non-tax ChargeType as fallback
    //     fba fees         ← FeeType: FBAPerOrderFulfillmentFee,
    //                                 FBAPerUnitFulfillmentFee,
    //                                 FBAWeightBasedFee, or anything
    //                                 starting with "FBA"
    //     transaction fees ← FeeType: Commission, FixedClosingFee,
    //                                 VariableClosingFee, GiftwrapChargeback,
    //                                 ShippingChargeback, DigitalServicesFee,
    //                                 RefundCommission, and any unknown
    //                                 non-FBA FeeType
    //     promotions       ← PromotionList / PromotionAdjustmentList
    //                        PromotionAmount entries
    //   Refund items live under ShipmentItemAdjustmentList with
    //   ItemChargeAdjustmentList / ItemFeeAdjustmentList /
    //   PromotionAdjustmentList — same shapes as their Order equivalents.
    //   Refund quantity is negated so negative qty = unit returning.
    //   Fulfillment (Amazon/Seller) comes from the Products catalog lookup.
    //
    //   ServiceFeeEventList — one derived row per FeeList entry with
    //   type='ServiceFee' and {feeType, feeAmount}. FeeType routes via
    //   SERVICE_FEE_LINE_MAP:
    //     FBADisposalFee, CustomerReturnHRRUnitFee     → FBA Returns Fees
    //     FBAInboundConvenienceFee                     → FBA Inbound Placement Fees
    //     FBAInboundTransportationFee                  → FBA Inbound Shipping Costs
    //     FBAStorageFee, FBALongTermStorageFee         → FBA Inventory Storage Fees
    //     Subscription                                 → Other Expenses
    //   Unknown FeeTypes fall back to Other Expenses and get listed in a
    //   yellow warning block above the report for the user to triage.
    //
    //   AdjustmentEventList — one derived row per AdjustmentItemList entry
    //   with type='Adjustment' and {adjustmentType, adjustmentAmount}.
    //   AdjustmentType routes via _adjustmentLine:
    //     WAREHOUSE_LOST, COMPENSATED_CLAWBACK,
    //     MISSING_FROM_INBOUND, MISSING_FROM_INBOUND_CLAWBACK  → FBA Inventory Adjustment
    //     ReturnPostageBilling_* (Tracking/Postage/
    //     TransactionFee/FuelSurcharge/OversizeSurcharge/
    //     DeliveryAreaSurcharge), PostageBilling_PostageAdjustment
    //                                                         → FBA Returns Fees
    //     Other                                               → Other Expenses
    //     anything else with a SKU                            → FBA Inventory Adjustment
    //     anything else without a SKU                         → Other Expenses
    //
    //   ChargebackEventList, GuaranteeClaimEventList, RetrochargeEventList
    //   — these are rare enough that per user direction, we emit per-item
    //   rows (so the derived CSV stays granular) but the statement
    //   categorizer collapses each row's entire net amount into
    //   Other Expenses. type is 'Chargeback' / 'GuaranteeClaim' /
    //   'Retrocharge' so they filter out cleanly in CSV review.
    //
    // Every SP-API FinancialEvent list we've seen populated in real data
    // is now wired. Ad spend + shipping still read from the Sheets tabs
    // until the Advertising API migration and ShippingCosts migration
    // ship separately.

    // ─── VIEW SWITCHING ─────────────────────────────────────────────────
    //
    // First-view auto-load flags: when the user clicks into either Upstash
    // tab the very first time in a page session, we default the dropdowns
    // to Last Month / This Year and run a report so they're not staring at
    // an empty placeholder. On subsequent visits in the same session we
    // leave the dropdowns (and the already-rendered content) alone so the
    // user's recent selection sticks.
    let _monthlyUpstashAutoLoaded = false;
    let _ytdUpstashAutoLoaded = false;

    // Months-with-data set, populated lazily from /api/transactions?action=
    // get-months. Used to disable the Prev/Next buttons when the target
    // period has no synced data. Null until the first fetch resolves;
    // callers treat null as "unknown, leave buttons enabled".
    let _upstashMonthsSet = null;
    let _upstashMonthsPromise = null;

    async function _ensureUpstashMonths() {
      if (_upstashMonthsSet) return _upstashMonthsSet;
      if (_upstashMonthsPromise) return _upstashMonthsPromise;
      if (!accessToken) return null;
      _upstashMonthsPromise = (async () => {
        try {
          const res = await fetch('/api/transactions?action=get-months', {
            headers: { Authorization: `Bearer ${accessToken}` }
          });
          if (!res.ok) return null;
          const data = await res.json();
          _upstashMonthsSet = new Set(Array.isArray(data.months) ? data.months : []);
          return _upstashMonthsSet;
        } catch {
          return null;
        } finally {
          _upstashMonthsPromise = null;
        }
      })();
      return _upstashMonthsPromise;
    }

    function _upstashHasMonth(year, month) {
      if (!_upstashMonthsSet) return true; // unknown → don't block
      const ym = `${year}-${String(month + 1).padStart(2, '0')}`;
      return _upstashMonthsSet.has(ym);
    }

    function _upstashHasYear(year) {
      if (!_upstashMonthsSet) return true; // unknown → don't block
      const prefix = `${year}-`;
      for (const ym of _upstashMonthsSet) {
        if (ym.startsWith(prefix)) return true;
      }
      return false;
    }

    // Disable the Prev/Next buttons on both Upstash tabs when the target
    // period has no synced data. Called after any dropdown change and after
    // the months set first loads. Safe to call even if the set isn't loaded
    // yet — buttons stay enabled until we know otherwise.
    function _refreshUpstashNavButtons() {
      // Monthly Upstash: target = currently-selected (month, year) ± 1,
      // rolling year across Jan/Dec.
      const mSel = document.getElementById('monthly-upstash-month-select');
      const ySel = document.getElementById('monthly-upstash-year-select');
      const mPrev = document.getElementById('monthly-upstash-prev-btn');
      const mNext = document.getElementById('monthly-upstash-next-btn');
      if (mSel && ySel && mPrev && mNext) {
        const m = parseInt(mSel.value, 10);
        const y = parseInt(ySel.value, 10);
        if (Number.isFinite(m) && Number.isFinite(y)) {
          const prev = new Date(y, m - 1, 1);
          const next = new Date(y, m + 1, 1);
          mPrev.disabled = !_upstashHasMonth(prev.getFullYear(), prev.getMonth());
          mNext.disabled = !_upstashHasMonth(next.getFullYear(), next.getMonth());
        } else {
          mPrev.disabled = false;
          mNext.disabled = false;
        }
      }

      // YTD Upstash: target = selected year ± 1, enabled if ANY month of
      // that year has data (a year with partial data is still worth viewing).
      const yySel = document.getElementById('ytd-upstash-year-select');
      const yPrev = document.getElementById('ytd-upstash-prev-btn');
      const yNext = document.getElementById('ytd-upstash-next-btn');
      if (yySel && yPrev && yNext) {
        const y = parseInt(yySel.value, 10);
        if (Number.isFinite(y)) {
          yPrev.disabled = !_upstashHasYear(y - 1);
          yNext.disabled = !_upstashHasYear(y + 1);
        } else {
          yPrev.disabled = false;
          yNext.disabled = false;
        }
      }
    }

    function _hideAllOverviewViews() {
      ['ytd-view', 'monthly-view', 'ytd-upstash-view', 'monthly-upstash-view']
        .forEach(id => {
          const el = document.getElementById(id);
          if (el) el.style.display = 'none';
        });
      document.querySelectorAll('#overview-page .page-header .tabs .tab')
        .forEach(t => t.classList.remove('active'));
    }

    function showMonthlyUpstash() {
      _hideAllOverviewViews();
      document.getElementById('monthly-upstash-view').style.display = 'block';
      document.getElementById('monthly-upstash-tab').classList.add('active');
      _initMonthlyUpstashDropdowns();
      // Only claim the auto-load slot if we have a token — a pre-sign-in
      // attempt would render nothing and burn the flag.
      if (!_monthlyUpstashAutoLoaded && accessToken) {
        _monthlyUpstashAutoLoaded = true;
        setMonthlyUpstashDate('lastMonth');
      }
      // Kick off the months-list fetch (if not already cached) and refresh
      // the Prev/Next disabled state once it resolves. Runs in the background
      // so the user isn't blocked.
      _ensureUpstashMonths().then(() => _refreshUpstashNavButtons());
      _refreshUpstashNavButtons();
    }

    function showYTDUpstash() {
      _hideAllOverviewViews();
      document.getElementById('ytd-upstash-view').style.display = 'block';
      document.getElementById('ytd-upstash-tab').classList.add('active');
      _initYTDUpstashDropdown();
      if (!_ytdUpstashAutoLoaded && accessToken) {
        _ytdUpstashAutoLoaded = true;
        setYTDUpstashYear('thisYear');
      }
      _ensureUpstashMonths().then(() => _refreshUpstashNavButtons());
      _refreshUpstashNavButtons();
    }

    function _initMonthlyUpstashDropdowns() {
      const yearSel = document.getElementById('monthly-upstash-year-select');
      if (yearSel && yearSel.options.length === 0) {
        const currentYear = new Date().getFullYear();
        for (let y = currentYear; y >= currentYear - 5; y--) {
          const o = document.createElement('option');
          o.value = y; o.textContent = y;
          yearSel.appendChild(o);
        }
        yearSel.value = currentYear;
      }
      const monthSel = document.getElementById('monthly-upstash-month-select');
      if (monthSel && !monthSel.value) {
        const now = new Date();
        const lastMonth = now.getMonth() - 1;
        monthSel.value = lastMonth >= 0 ? lastMonth : 11;
      }
    }

    function _initYTDUpstashDropdown() {
      const yearSel = document.getElementById('ytd-upstash-year-select');
      if (yearSel && yearSel.options.length === 0) {
        const currentYear = new Date().getFullYear();
        for (let y = currentYear; y >= currentYear - 5; y--) {
          const o = document.createElement('option');
          o.value = y; o.textContent = y;
          yearSel.appendChild(o);
        }
        yearSel.value = currentYear;
      }
    }

    // Monthly Upstash preset buttons. Mirrors setMonthlyDate's semantics:
    //   thisMonth → current calendar month (absolute)
    //   lastMonth → previous calendar month (absolute)
    //   prevMonth → currently-selected month − 1, rolling year backward
    //   nextMonth → currently-selected month + 1, rolling year forward
    function setMonthlyUpstashDate(preset) {
      const today = new Date();
      const monthSel = document.getElementById('monthly-upstash-month-select');
      const yearSel  = document.getElementById('monthly-upstash-year-select');
      const curMonth = parseInt(monthSel.value, 10);
      const curYear  = parseInt(yearSel.value, 10);

      if (preset === 'lastMonth') {
        const d = new Date(today.getFullYear(), today.getMonth() - 1, 1);
        monthSel.value = d.getMonth();
        _setSelectByValueUpstash(yearSel, d.getFullYear());
      } else if (preset === 'thisMonth') {
        monthSel.value = today.getMonth();
        _setSelectByValueUpstash(yearSel, today.getFullYear());
      } else if (preset === 'prevMonth' && Number.isFinite(curMonth) && Number.isFinite(curYear)) {
        const d = new Date(curYear, curMonth - 1, 1);
        monthSel.value = d.getMonth();
        _setSelectByValueUpstash(yearSel, d.getFullYear());
      } else if (preset === 'nextMonth' && Number.isFinite(curMonth) && Number.isFinite(curYear)) {
        const d = new Date(curYear, curMonth + 1, 1);
        monthSel.value = d.getMonth();
        _setSelectByValueUpstash(yearSel, d.getFullYear());
      }

      _refreshUpstashNavButtons();
      generateMonthlyUpstashReport();
    }

    // YTD Upstash preset buttons.
    //   thisYear → current calendar year (absolute)
    //   lastYear → previous calendar year (absolute)
    //   prevYear → selected year − 1 (relative)
    //   nextYear → selected year + 1 (relative)
    function setYTDUpstashYear(preset) {
      const today = new Date();
      const sel = document.getElementById('ytd-upstash-year-select');
      const cur = parseInt(sel.value, 10);

      if (preset === 'thisYear') {
        _setSelectByValueUpstash(sel, today.getFullYear());
      } else if (preset === 'lastYear') {
        _setSelectByValueUpstash(sel, today.getFullYear() - 1);
      } else if (preset === 'prevYear' && Number.isFinite(cur)) {
        _setSelectByValueUpstash(sel, cur - 1);
      } else if (preset === 'nextYear' && Number.isFinite(cur)) {
        _setSelectByValueUpstash(sel, cur + 1);
      }

      _refreshUpstashNavButtons();
      generateYTDUpstashReport();
    }

    // Same "insert option if missing" helper as the Sheets-side version.
    // Prev/Next let the user scroll past the pre-seeded 5-year window
    // without the dropdown silently failing to update.
    function _setSelectByValueUpstash(select, v) {
      if (!select) return;
      const str = String(v);
      if ([...select.options].some(o => o.value === str)) {
        select.value = str;
        return;
      }
      const opt = document.createElement('option');
      opt.value = str;
      opt.textContent = str;
      let inserted = false;
      for (let i = 0; i < select.options.length; i++) {
        if (parseInt(select.options[i].value, 10) < v) {
          select.insertBefore(opt, select.options[i]);
          inserted = true;
          break;
        }
      }
      if (!inserted) select.appendChild(opt);
      select.value = str;
    }

    // ─── REPORT GENERATION ──────────────────────────────────────────────

    async function generateMonthlyUpstashReport() {
      const month = parseInt(document.getElementById('monthly-upstash-month-select').value, 10);
      const year  = parseInt(document.getElementById('monthly-upstash-year-select').value, 10);
      if (isNaN(month) || isNaN(year)) return;

      // Catches the case where the user picks a new period from the dropdown
      // directly (not via a preset button) — keep Prev/Next state in sync.
      _refreshUpstashNavButtons();

      const container = document.getElementById('monthly-upstash-content');
      if (!container) return;
      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Please sign in</div>';
        return;
      }

      // Per-session cache: swap the rendered HTML in if we've already built
      // this (year, month) report, skipping the 3-period fetch fan-out.
      const cacheKey = `monthly-upstash|${year}|${month}`;
      const cached = window._overviewReportCache && window._overviewReportCache.get(cacheKey);
      if (cached) {
        container.innerHTML = cached;
        return;
      }

      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading data...</div>';

      try {
        // Mirrors the Sheets-side Monthly pipeline: current month + previous
        // month (MoM) + same month last year (YoY) fetched in parallel, then
        // comparisons computed on the metrics and passed to the renderer.
        const startDate = _ymd(new Date(year, month, 1));
        const endDate   = _ymd(new Date(year, month + 1, 0));
        const prevStart = _ymd(new Date(year, month - 1, 1));
        const prevEnd   = _ymd(new Date(year, month, 0));
        const yoyStart  = _ymd(new Date(year - 1, month, 1));
        const yoyEnd    = _ymd(new Date(year - 1, month + 1, 0));

        const [current, prev, yoy] = await Promise.all([
          _computeUpstashPeriod(startDate, endDate),
          _computeUpstashPeriod(prevStart, prevEnd),
          _computeUpstashPeriod(yoyStart, yoyEnd)
        ]);

        const comparisons = calculateComparisons(current.metrics, prev.metrics, yoy.metrics);
        _renderUpstashStatement(container, {
          statement: current.statement,
          missingSkus: current.missingSkus,
          unmappedFees: current.unmappedFees,
          rows: current.rows,
          lastSynced: current.lastSynced,
          startDate, endDate,
          adSpend: current.adSpend,
          shippingCosts: current.shippingCosts,
          comparisons
        });

        if (window._overviewReportCache) window._overviewReportCache.set(cacheKey, container.innerHTML);
      } catch (err) {
        console.error('Upstash monthly overview failed:', err);
        container.innerHTML = `<div style="padding: 2rem; color: var(--error);">Error: ${err.message}</div>`;
      }
    }

    async function generateYTDUpstashReport() {
      const year = document.getElementById('ytd-upstash-year-select').value;
      if (!year) return;

      // Catches direct dropdown changes — keep Prev/Next state in sync.
      _refreshUpstashNavButtons();

      const container = document.getElementById('ytd-upstash-content');
      if (!container) return;
      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Please sign in</div>';
        return;
      }

      // Per-session cache: swap the rendered HTML in if we've already built
      // this year's report, skipping the 2-period fetch fan-out.
      const cacheKey = `ytd-upstash|${year}`;
      const cached = window._overviewReportCache && window._overviewReportCache.get(cacheKey);
      if (cached) {
        container.innerHTML = cached;
        return;
      }

      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading data...</div>';

      try {
        const today = new Date();
        const selectedYear = parseInt(year, 10);
        const isCurrentYear = selectedYear === today.getFullYear();

        // Current year range: Jan 1 → end of last complete month (if current
        // year) or Dec 31 (past year).
        const startDate = `${year}-01-01`;
        let endDate;
        if (isCurrentYear) {
          const lastCompleteMonth = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
          const lastCompleteMonthYear = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();
          endDate = _ymd(new Date(lastCompleteMonthYear, lastCompleteMonth + 1, 0));
        } else {
          endDate = `${year}-12-31`;
        }

        // Previous year range — apples-to-apples with the current range
        // (same last-complete-month cutoff so the YoY % is meaningful).
        const prevYear = selectedYear - 1;
        const prevStart = `${prevYear}-01-01`;
        let prevEnd;
        if (isCurrentYear) {
          const lastCompleteMonth = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
          const prevLastCompleteMonthYear = today.getMonth() === 0 ? prevYear - 1 : prevYear;
          prevEnd = _ymd(new Date(prevLastCompleteMonthYear, lastCompleteMonth + 1, 0));
        } else {
          prevEnd = `${prevYear}-12-31`;
        }

        const [current, prev] = await Promise.all([
          _computeUpstashPeriod(startDate, endDate),
          _computeUpstashPeriod(prevStart, prevEnd)
        ]);

        const comparisons = calculateYTDComparisons(current.metrics, prev.metrics);
        _renderUpstashStatement(container, {
          statement: current.statement,
          missingSkus: current.missingSkus,
          unmappedFees: current.unmappedFees,
          rows: current.rows,
          lastSynced: current.lastSynced,
          startDate, endDate,
          adSpend: current.adSpend,
          shippingCosts: current.shippingCosts,
          comparisons
        });

        if (window._overviewReportCache) window._overviewReportCache.set(cacheKey, container.innerHTML);
      } catch (err) {
        console.error('Upstash YTD overview failed:', err);
        container.innerHTML = `<div style="padding: 2rem; color: var(--error);">Error: ${err.message}</div>`;
      }
    }

    // Fetch + derive + build statement for a single period. Returns both the
    // rendered-ready bundle AND the extracted profitability metrics so the
    // caller can fan out several periods in parallel and compute MoM / YoY
    // comparisons before rendering the current period.
    async function _computeUpstashPeriod(startDate, endDate) {
      const inputs = await _fetchUpstashInputs(startDate, endDate);
      const rows = _deriveTransactionRows(inputs.pages, startDate, endDate);

      // Per-SKU sales-by-channel from derived Order rows. Used by the ad
      // allocator for historical SP rows and SB rows where we need a
      // proportional split across a campaign's / brand's SKUs.
      const skuSales = _buildSkuSales(rows, inputs.products);

      const adSpend = _allocateAdSpend({
        spAdRows: inputs.spAdRows,
        sbAdRows: inputs.sbAdRows,
        products: inputs.products,
        brandToSkus: inputs.brandToSkus,
        productCampaignToSkus: inputs.productCampaignToSkus,
        brandCampaignToBrand: inputs.brandCampaignToBrand,
        skuSales,
        startDate,
        endDate
      });

      // Shipping costs are 100% FBM (seller fulfills), so no allocation
      // needed — just sum the rows in the date window and hand the total
      // to the statement builder.
      const shippingCosts = _sumShippingInRange(inputs.shippingRows, startDate, endDate);

      const { statement, missingSkus, unmappedFees } = _buildStatement(rows, inputs.products, adSpend, shippingCosts);
      const metrics = extractProfitabilityMetrics(statement);

      return {
        statement, missingSkus, unmappedFees, rows,
        lastSynced: inputs.lastSynced,
        adSpend, shippingCosts, metrics
      };
    }

    // ─── INPUT FETCHING ─────────────────────────────────────────────────

    async function _fetchUpstashInputs(startDate, endDate) {
      const authHeader = { Authorization: `Bearer ${accessToken}` };
      const startMonth = startDate.slice(0, 7);
      const endMonth   = endDate.slice(0, 7);

      const [txRes, prodRes, spAdRes, sbAdRes, prodMapRes, brandMapRes, shipRes] = await Promise.all([
        fetch(`/api/transactions?action=get-range&startMonth=${startMonth}&endMonth=${endMonth}`, { headers: authHeader }),
        fetch('/api/products?action=get', { headers: authHeader }),
        fetch(`/api/adspend?action=get-range&type=sp&startMonth=${startMonth}&endMonth=${endMonth}`, { headers: authHeader }),
        fetch(`/api/adspend?action=get-range&type=sb&startMonth=${startMonth}&endMonth=${endMonth}`, { headers: authHeader }),
        fetch('/api/mappings?action=get&type=product', { headers: authHeader }),
        fetch('/api/mappings?action=get&type=brand',   { headers: authHeader }),
        fetch(`/api/shipping?action=get-range&startMonth=${startMonth}&endMonth=${endMonth}`, { headers: authHeader })
      ]);
      if (!txRes.ok)   throw new Error(`Transactions fetch failed (${txRes.status})`);
      if (!prodRes.ok) throw new Error(`Products fetch failed (${prodRes.status})`);

      const tx         = await txRes.json();
      const prod       = await prodRes.json();
      const spAd       = spAdRes.ok     ? await spAdRes.json()    : { rows: [] };
      const sbAd       = sbAdRes.ok     ? await sbAdRes.json()    : { rows: [] };
      const prodMap    = prodMapRes.ok  ? await prodMapRes.json() : { mappings: {} };
      const brandMap   = brandMapRes.ok ? await brandMapRes.json() : { mappings: {} };
      const shipping   = shipRes.ok     ? await shipRes.json()    : { rows: [] };

      // Products keyed by SKU for O(1) lookup during derivation. We also
      // build a brand → [skus] index since Sponsored Brands allocation needs
      // to know which SKUs roll up under a given brand.
      const products = {};
      const brandToSkus = {};
      for (const p of (prod.products || [])) {
        if (!p?.sku) continue;
        products[p.sku] = p;
        const brand = (p.brand || '').trim();
        if (brand) {
          if (!brandToSkus[brand]) brandToSkus[brand] = [];
          brandToSkus[brand].push(p.sku);
        }
      }

      // Campaign → SKU[] from /api/mappings (product) and campaign → brand
      // (brand). These only matter for historical SP rows without an
      // advertisedSku (Sheets-backfilled) and for SB rows (which are
      // always campaign-level).
      const productCampaignToSkus = {};
      for (const [campaign, data] of Object.entries(prodMap.mappings || {})) {
        if (Array.isArray(data?.skus) && data.skus.length > 0) {
          productCampaignToSkus[campaign] = data.skus.slice();
        }
      }
      const brandCampaignToBrand = {};
      for (const [campaign, brand] of Object.entries(brandMap.mappings || {})) {
        if (brand) brandCampaignToBrand[campaign] = brand;
      }

      // Grab the latest-synced timestamp across the months we're reading,
      // for the blurb at the top of the rendered statement.
      let lastSynced = null;
      try {
        const months = Array.isArray(tx.months) ? tx.months : [];
        if (months.length > 0) {
          const latest = months[months.length - 1];
          const lsRes = await fetch(`/api/transactions?action=get&month=${latest}`, { headers: authHeader });
          if (lsRes.ok) lastSynced = (await lsRes.json()).lastSynced || null;
        }
      } catch { /* non-fatal */ }

      return {
        pages: tx.pages || [],
        products,
        brandToSkus,
        spAdRows: spAd.rows || [],
        sbAdRows: sbAd.rows || [],
        shippingRows: shipping.rows || [],
        productCampaignToSkus,
        brandCampaignToBrand,
        lastSynced
      };
    }

    // ─── TRANSACTION DERIVE ─────────────────────────────────────────────
    // Walk both ShipmentEventList (type='Order') and RefundEventList
    // (type='Refund') and emit one row per item per the schema. Refund
    // items live in ShipmentItemAdjustmentList with charge/fee/promotion
    // lists named *AdjustmentList* — the sum helpers accept either form.
    // Refund quantity is negated so it reads like the Amazon Transaction
    // report convention (negative qty = unit coming back in).

    function _deriveTransactionRows(pages, startDate, endDate) {
      const rows = [];
      for (const page of pages) {
        for (const ev of (page.ShipmentEventList || [])) {
          _pushEventItemRows(rows, ev, 'Order', ev.ShipmentItemList, +1, startDate, endDate);
        }
        for (const ev of (page.RefundEventList || [])) {
          _pushEventItemRows(rows, ev, 'Refund', ev.ShipmentItemAdjustmentList, -1, startDate, endDate);
        }
        for (const ev of (page.ServiceFeeEventList || [])) {
          _pushServiceFeeRows(rows, ev, startDate, endDate);
        }
        for (const ev of (page.AdjustmentEventList || [])) {
          _pushAdjustmentRows(rows, ev, startDate, endDate);
        }
        // Chargeback / GuaranteeClaim / Retrocharge events are uncommon
        // enough that per the user's call, we drop the entire event
        // amount into Other Expenses without further breakdown. Still
        // emit per-item rows so the derived CSV remains granular, just
        // all columns collapse to Other Expenses in the statement.
        for (const ev of (page.ChargebackEventList || [])) {
          _pushEventItemRows(rows, ev, 'Chargeback',     ev.ShipmentItemAdjustmentList, -1, startDate, endDate);
        }
        for (const ev of (page.GuaranteeClaimEventList || [])) {
          _pushEventItemRows(rows, ev, 'GuaranteeClaim', ev.ShipmentItemAdjustmentList, -1, startDate, endDate);
        }
        for (const ev of (page.RetrochargeEventList || [])) {
          _pushEventItemRows(rows, ev, 'Retrocharge',    ev.ShipmentItemAdjustmentList, +1, startDate, endDate);
        }
      }
      return rows;
    }

    // AdjustmentEvent has an event-level AdjustmentType plus an
    // AdjustmentItemList with per-SKU detail (TotalAmount per item). Emit
    // one row per item so SKU-specific amounts are visible in the derived
    // CSV; if the event has no items, emit one event-level row using
    // ev.AdjustmentAmount as the total.
    function _pushAdjustmentRows(rows, ev, startDate, endDate) {
      const date = (ev.PostedDate || '').substring(0, 10);
      if (date && (date < startDate || date > endDate)) return;

      const adjustmentType = ev.AdjustmentType || '';
      const items = ev.AdjustmentItemList || [];
      const base = {
        type: 'Adjustment',
        orderId: '',
        date,
        qty: 0,
        sale: 0, otherCharges: 0, fbaFees: 0, transactionFees: 0, promotions: 0,
        feeType: '', feeAmount: 0
      };

      if (items.length === 0) {
        rows.push({
          ...base,
          sku: '',
          adjustmentType,
          adjustmentAmount: _amount(ev.AdjustmentAmount)
        });
        return;
      }

      for (const item of items) {
        const amt = _amount(item.TotalAmount) ||
                    (_amount(item.PerUnitAmount) * (parseInt(item.Quantity, 10) || 0));
        rows.push({
          ...base,
          sku: _normalizeSku(item.SellerSKU),
          qty: parseInt(item.Quantity, 10) || 0,
          adjustmentType,
          adjustmentAmount: amt
        });
      }
    }

    // Route an Adjustment row to the right Expense line. Checks the four
    // explicit sets first, then the "Other" special case, then falls back
    // to the "has SKU?" rule.
    function _adjustmentLine(r) {
      if (ADJUSTMENT_INVENTORY_TYPES.has(r.adjustmentType))   return 'FBA Inventory Adjustment';
      if (ADJUSTMENT_RETURNS_FEE_TYPES.has(r.adjustmentType)) return 'FBA Returns Fees';
      if (r.adjustmentType === 'Other')                       return 'Other Expenses';
      return r.sku ? 'FBA Inventory Adjustment' : 'Other Expenses';
    }

    // ServiceFeeEvent has no items — just a FeeList at the event level.
    // Emit one row per FeeList entry, carrying FeeType and FeeAmount
    // through verbatim. Routing to the Expense line happens in
    // _buildStatement using the SERVICE_FEE_LINE_MAP.
    function _pushServiceFeeRows(rows, ev, startDate, endDate) {
      const date = (ev.PostedDate || '').substring(0, 10);
      // ServiceFeeEvents frequently ship without a PostedDate. The sync
      // already scoped them to the requested month via PostedAfter /
      // PostedBefore, and KV stores them under transactions:raw:YYYY-MM —
      // so an empty date doesn't mean "out of range," it means "Amazon
      // didn't include the field." Only filter when we actually have one.
      if (date && (date < startDate || date > endDate)) return;
      const base = {
        type: 'ServiceFee',
        orderId: ev.AmazonOrderId || '',
        date,
        sku: _normalizeSku(ev.SellerSKU),
        qty: 0,
        sale: 0, otherCharges: 0, fbaFees: 0, transactionFees: 0, promotions: 0
      };
      const feeList = ev.FeeList || [];
      if (feeList.length === 0) {
        // Still emit a placeholder row so the derived CSV reflects every
        // event — otherwise empty-FeeList events vanish from the audit view.
        rows.push({ ...base, feeType: ev.FeeReason || '', feeAmount: 0 });
        return;
      }
      for (const f of feeList) {
        rows.push({
          ...base,
          feeType: f.FeeType || '',
          feeAmount: _amount(f.FeeAmount)
        });
      }
    }

    function _pushEventItemRows(rows, ev, type, items, qtySign, startDate, endDate) {
      const date = (ev.PostedDate || '').substring(0, 10);
      // Only filter out events that have a date and fall outside the
      // window. Events with no PostedDate came from a KV bucket already
      // scoped to the requested month(s) — trust that scope rather than
      // dropping them because one field was missing.
      if (date && (date < startDate || date > endDate)) return;
      const orderId = ev.AmazonOrderId || '';

      for (const item of (items || [])) {
        rows.push({
          type,
          orderId,
          date,
          // SP-API sometimes returns SellerSKU with HTML-entity-encoded
          // ampersands ("&amp;") where the real SKU has a literal "&".
          // Decode at the edge so every downstream consumer (lookup,
          // missing-SKU warning, CSV export) sees the real SKU string.
          sku: _normalizeSku(item.SellerSKU),
          qty: (parseInt(item.QuantityShipped, 10) || 0) * qtySign,
          sale:            _sumCharges(item, ['Principal']),
          otherCharges:    _sumOtherCharges(item),
          fbaFees:         _sumFees(item, _isFbaFee),
          transactionFees: _sumFees(item, _isTransactionFee),
          promotions:      _sumPromotions(item)
        });
      }
    }

    // Charge lists live under `ItemChargeList` on Orders and
    // `ItemChargeAdjustmentList` on Refunds. Same shape, different name.
    function _chargeList(item) {
      return item.ItemChargeList || item.ItemChargeAdjustmentList || [];
    }

    // Fee lists live under `ItemFeeList` on Orders and
    // `ItemFeeAdjustmentList` on Refunds. Same shape, different name.
    function _feeList(item) {
      return item.ItemFeeList || item.ItemFeeAdjustmentList || [];
    }

    function _sumCharges(item, types) {
      let total = 0;
      for (const c of _chargeList(item)) {
        if (types.includes(c.ChargeType)) total += _amount(c.ChargeAmount);
      }
      return total;
    }

    // "Other charges" = every non-Principal, non-tax ChargeType — so
    // GiftWrap, Shipping/ShippingCharge, ReturnShipping (RefundEvent-only),
    // and any future ChargeType Amazon ships all land here per the user's
    // catch-all rule. Tax types are dropped (seller net-zero).
    function _sumOtherCharges(item) {
      const TAX_TYPES = new Set([
        'Tax', 'GiftWrapTax', 'ShippingTax',
        'MarketplaceFacilitatorTax-Principal',
        'MarketplaceFacilitatorTax-Shipping',
        'MarketplaceFacilitatorTax-Other',
        'MarketplaceFacilitatorVAT-Principal',
        'MarketplaceFacilitatorVAT-Shipping',
        'MarketplaceFacilitatorVAT-Other',
        'RenewedProgramFee'
      ]);
      let total = 0;
      for (const c of _chargeList(item)) {
        const t = c.ChargeType;
        if (!t) continue;
        if (t === 'Principal') continue;
        if (TAX_TYPES.has(t)) continue;
        total += _amount(c.ChargeAmount);
      }
      return total;
    }

    function _sumFees(item, predicate) {
      let total = 0;
      for (const f of _feeList(item)) {
        if (predicate(f.FeeType)) total += _amount(f.FeeAmount);
      }
      return total;
    }

    // Rule: any FeeType that starts with "FBA" goes to fba fees.
    function _isFbaFee(feeType) {
      return typeof feeType === 'string' && feeType.startsWith('FBA');
    }

    // Rule: everything non-FBA on ItemFeeList goes to transaction fees.
    function _isTransactionFee(feeType) {
      return typeof feeType === 'string' && !feeType.startsWith('FBA');
    }

    function _sumPromotions(item) {
      // Promotions on Orders → PromotionList. On Refunds the equivalent
      // is PromotionAdjustmentList with the same PromotionAmount shape.
      const list = item.PromotionList || item.PromotionAdjustmentList || [];
      let total = 0;
      for (const p of list) {
        total += _amount(p.PromotionAmount);
      }
      return total;
    }

    function _amount(money) {
      if (!money) return 0;
      const n = parseFloat(money.CurrencyAmount ?? money.Amount ?? 0);
      return Number.isFinite(n) ? n : 0;
    }

    // ─── STATEMENT BUILDER ──────────────────────────────────────────────
    // Each derived row's columns flow into statement buckets based on
    // fulfillment (from the Products catalog). Positives → credit,
    // negatives → debit.

    const STATEMENT_INCOME_LINES = [
      'FBM Sales', 'FBM Returns', 'FBM Other',
      'FBA Sales', 'FBA Returns', 'FBA Other'
    ];
    const STATEMENT_EXPENSE_LINES = [
      'FBM Product Costs', 'FBM Transaction Fees', 'FBM Shipping Costs', 'FBM Ad Spend',
      'FBA Product Costs', 'FBA Transaction Fees', 'FBA Fees',
      'FBA Returns Fees',
      'FBA Inbound Placement Fees', 'FBA Inbound Shipping Costs',
      'FBA Inventory Storage Fees', 'FBA Inventory Adjustment', 'FBA Ad Spend',
      'Other Expenses', 'Unallocated Ad Spend'
    ];

    // ServiceFeeEvent FeeType → Expense line item.
    // Anything not in this map falls into "Other Expenses" so nothing is
    // silently lost; unmapped types surface in a warning block.
    const SERVICE_FEE_LINE_MAP = {
      FBADisposalFee:               'FBA Returns Fees',
      CustomerReturnHRRUnitFee:     'FBA Returns Fees',
      FBAInboundConvenienceFee:     'FBA Inbound Placement Fees',
      FBAInboundTransportationFee:  'FBA Inbound Shipping Costs',
      FBAStorageFee:                'FBA Inventory Storage Fees',
      FBALongTermStorageFee:        'FBA Inventory Storage Fees',
      Subscription:                 'Other Expenses'
    };

    // AdjustmentEvent AdjustmentType → Expense line item. Unlike service
    // fees, adjustments have a fallback that depends on whether the row
    // carries a SKU: SKU-bearing adjustments land in FBA Inventory
    // Adjustment, SKU-less ones in Other Expenses. See _adjustmentLine.
    const ADJUSTMENT_INVENTORY_TYPES = new Set([
      'WAREHOUSE_LOST',
      'COMPENSATED_CLAWBACK',
      'MISSING_FROM_INBOUND',
      'MISSING_FROM_INBOUND_CLAWBACK'
    ]);
    const ADJUSTMENT_RETURNS_FEE_TYPES = new Set([
      'PostageBilling_PostageAdjustment',
      'ReturnPostageBilling_Tracking',
      'ReturnPostageBilling_Postage',
      'ReturnPostageBilling_TransactionFee',
      'ReturnPostageBilling_FuelSurcharge',
      'ReturnPostageBilling_OversizeSurcharge',
      'ReturnPostageBilling_DeliveryAreaSurcharge'
    ]);

    // Decode HTML-entity-encoded ampersands that SP-API sometimes returns
    // in SellerSKU strings ("&amp;" → "&"). The Products catalog stores
    // the real character, so normalizing the incoming value at the edge
    // lets all downstream code do plain string lookups against the catalog.
    function _normalizeSku(sku) {
      return String(sku || '').replace(/&amp;/g, '&');
    }

    // Sum the `cost` field of shipping rows whose shipDate falls inside
    // [startDate, endDate]. Handles both API rows (sku-bearing, cost
    // already allocated per SKU) and Sheets-backfilled rows (sku-less,
    // cost is the shipment total) — both contribute to the period total.
    function _sumShippingInRange(shippingRows, startDate, endDate) {
      let total = 0;
      for (const r of (shippingRows || [])) {
        const d = r.shipDate || '';
        if (d && (d < startDate || d > endDate)) continue;
        total += Number(r.cost) || 0;
      }
      return total;
    }

    // Is this SKU's fulfillment field one of the "Amazon/FBA" spellings?
    // Seen in the wild: "Amazon", "AFN", "FBA", various casings/whitespace.
    function _isFbaProduct(product) {
      const f = String(product?.fulfillment || '').trim().toLowerCase();
      return f === 'amazon' || f === 'afn' || f === 'fba';
    }

    // Walk the derived Order rows and sum Principal revenue per SKU, split
    // by the channel each SKU is actually sold through. Used by the ad
    // allocator to proportionally split campaign-level spend across a
    // campaign's / brand's SKUs by actual sales contribution.
    function _buildSkuSales(rows, products) {
      const skuSales = {}; // { sku: { fba, fbm } }
      for (const r of rows) {
        if (r.type !== 'Order') continue;
        if (!r.sku) continue;
        const prod = products[r.sku];
        if (!prod) continue;
        if (!skuSales[r.sku]) skuSales[r.sku] = { fba: 0, fbm: 0 };
        const amount = r.sale || 0;
        if (amount <= 0) continue; // ignore zero/negative principal on orders
        if (_isFbaProduct(prod)) skuSales[r.sku].fba += amount;
        else                      skuSales[r.sku].fbm += amount;
      }
      return skuSales;
    }

    // Allocate Sponsored Products + Sponsored Brands spend to FBA / FBM /
    // Unallocated. Three paths:
    //   1. SP row with sku (API-sourced)  → direct lookup: product.fulfillment
    //   2. SP row without sku (historical) → campaign → SKUs via product
    //                                         mapping; split by sales ratio
    //                                         across that campaign's SKUs.
    //   3. SB row (always sku-less)       → campaign → brand via brand
    //                                         mapping; split by sales ratio
    //                                         across that brand's SKUs (from
    //                                         the Products catalog by brand).
    // In all cases, anything we can't attribute lands in Unallocated so no
    // spend disappears silently.
    function _allocateAdSpend({ spAdRows, sbAdRows, products, brandToSkus, productCampaignToSkus, brandCampaignToBrand, skuSales, startDate, endDate }) {
      let fba = 0, fbm = 0, unallocated = 0;
      const unallocatedProductCampaigns = {};
      const unallocatedBrandCampaigns = {};

      const bumpUnallocatedProduct = (campaign, amount) => {
        const key = campaign || '(blank)';
        unallocatedProductCampaigns[key] = (unallocatedProductCampaigns[key] || 0) + amount;
      };
      const bumpUnallocatedBrand = (campaign, amount) => {
        const key = campaign || '(blank)';
        unallocatedBrandCampaigns[key] = (unallocatedBrandCampaigns[key] || 0) + amount;
      };

      const splitBySales = (skus, spend) => {
        let totalFba = 0, totalFbm = 0;
        for (const sku of skus) {
          const s = skuSales[sku];
          if (!s) continue;
          totalFba += s.fba;
          totalFbm += s.fbm;
        }
        const total = totalFba + totalFbm;
        if (total === 0) return null; // caller sends to unallocated
        return { fba: spend * (totalFba / total), fbm: spend * (totalFbm / total) };
      };

      // ── Sponsored Products ───────────────────────────────────────────
      for (const row of (spAdRows || [])) {
        const d = row.date || '';
        if (d && (d < startDate || d > endDate)) continue;
        const spend = Number(row.cost) || 0;
        if (spend <= 0) continue;

        if (row.sku) {
          // Direct SKU attribution — no mapping needed.
          const sku = _normalizeSku(row.sku);
          const prod = products[sku];
          if (!prod) {
            unallocated += spend;
            bumpUnallocatedProduct(row.campaign, spend);
            continue;
          }
          if (_isFbaProduct(prod)) fba += spend;
          else                      fbm += spend;
          continue;
        }

        // Historical SP (no sku) — fall back to campaign → SKUs mapping.
        const mapped = productCampaignToSkus[row.campaign] || [];
        if (mapped.length === 0) {
          unallocated += spend;
          bumpUnallocatedProduct(row.campaign, spend);
          continue;
        }
        const split = splitBySales(mapped, spend);
        if (!split) {
          unallocated += spend;
          bumpUnallocatedProduct(row.campaign, spend);
        } else {
          fba += split.fba;
          fbm += split.fbm;
        }
      }

      // ── Sponsored Brands ─────────────────────────────────────────────
      for (const row of (sbAdRows || [])) {
        const d = row.date || '';
        if (d && (d < startDate || d > endDate)) continue;
        const spend = Number(row.cost) || 0;
        if (spend <= 0) continue;

        const brand = brandCampaignToBrand[row.campaign];
        if (!brand) {
          unallocated += spend;
          bumpUnallocatedBrand(row.campaign, spend);
          continue;
        }
        const brandSkus = brandToSkus[brand] || [];
        if (brandSkus.length === 0) {
          unallocated += spend;
          bumpUnallocatedBrand(row.campaign, spend);
          continue;
        }
        const split = splitBySales(brandSkus, spend);
        if (!split) {
          unallocated += spend;
          bumpUnallocatedBrand(row.campaign, spend);
        } else {
          fba += split.fba;
          fbm += split.fbm;
        }
      }

      return { fba, fbm, unallocated, unallocatedProductCampaigns, unallocatedBrandCampaigns };
    }

    function _buildStatement(rows, products, adSpend = null, shippingCosts = 0) {
      const statement = {
        income: Object.fromEntries(STATEMENT_INCOME_LINES.map(k => [k, { debit: 0, credit: 0 }])),
        expenses: Object.fromEntries(STATEMENT_EXPENSE_LINES.map(k => [k, { debit: 0, credit: 0 }]))
      };

      // Ad spend is computed outside this function (it needs both the ad
      // data and the sku-sales derived here-ish). If provided, drop it
      // straight onto the debit side of the three Ad Spend lines; ad spend
      // is always money out, so signs are simple.
      if (adSpend) {
        if (adSpend.fba > 0)          statement.expenses['FBA Ad Spend'].debit += adSpend.fba;
        if (adSpend.fbm > 0)          statement.expenses['FBM Ad Spend'].debit += adSpend.fbm;
        if (adSpend.unallocated > 0)  statement.expenses['Unallocated Ad Spend'].debit += adSpend.unallocated;
      }

      // Shipping costs are always FBM — seller-fulfilled shipments have
      // costs we paid out-of-pocket. FBA shipping is wrapped into Amazon's
      // FBA Fees on the SP-API side and doesn't flow through here.
      if (shippingCosts > 0) {
        statement.expenses['FBM Shipping Costs'].debit += shippingCosts;
      }

      const missing = new Map(); // sku → Set of orderIds using it

      const add = (line, section, amount) => {
        if (amount > 0) statement[section][line].credit += amount;
        else if (amount < 0) statement[section][line].debit += Math.abs(amount);
      };

      const unmappedServiceFeeTypes = new Map(); // feeType → running total

      for (const r of rows) {
        // ServiceFee rows route by FeeType → Expense line. They don't
        // depend on fulfillment or the Products catalog.
        if (r.type === 'ServiceFee') {
          const line = SERVICE_FEE_LINE_MAP[r.feeType];
          if (!line) {
            // Unknown FeeType: bucket into Other Expenses so the money
            // isn't lost, but keep a running tally for a warning block.
            add('Other Expenses', 'expenses', r.feeAmount);
            unmappedServiceFeeTypes.set(
              r.feeType || '(empty)',
              (unmappedServiceFeeTypes.get(r.feeType || '(empty)') || 0) + r.feeAmount
            );
          } else {
            add(line, 'expenses', r.feeAmount);
          }
          continue;
        }

        // Adjustment rows route by AdjustmentType via _adjustmentLine,
        // with a "has SKU?" fallback for types not in the explicit maps.
        // No Products-catalog lookup needed.
        if (r.type === 'Adjustment') {
          add(_adjustmentLine(r), 'expenses', r.adjustmentAmount);
          continue;
        }

        // Chargeback / GuaranteeClaim / Retrocharge rows dump their entire
        // net amount into Other Expenses. Per-item detail is preserved in
        // the CSV but collapses here since these event types are rare
        // enough not to warrant a dedicated statement line.
        if (r.type === 'Chargeback' || r.type === 'GuaranteeClaim' || r.type === 'Retrocharge') {
          const net = (r.sale || 0) + (r.otherCharges || 0) +
                      (r.fbaFees || 0) + (r.transactionFees || 0) +
                      (r.promotions || 0);
          add('Other Expenses', 'expenses', net);
          continue;
        }

        const prod = products[r.sku];
        if (!prod) {
          if (!missing.has(r.sku)) missing.set(r.sku, new Set());
          missing.get(r.sku).add(r.orderId);
          continue; // Can't categorize without knowing fulfillment.
        }
        // Accept common spellings of the fulfillment value rather than
        // relying on one exact string. Seen in the wild: "Amazon", "AFN",
        // "FBA", sometimes lower/title-cased, sometimes with whitespace.
        const f = String(prod.fulfillment || '').trim().toLowerCase();
        const isFba = f === 'amazon' || f === 'afn' || f === 'fba';
        const prefix = isFba ? 'FBA' : 'FBM';

        // Sale routing depends on event type: Orders go to Sales,
        // Refunds go to Returns. Everything else routes the same way
        // regardless of type — positives credit, negatives debit.
        const saleLine = r.type === 'Refund' ? 'Returns' : 'Sales';
        add(`${prefix} ${saleLine}`, 'income', r.sale);
        add(`${prefix} Other`, 'income', r.otherCharges);
        add(`${prefix} Other`, 'income', r.promotions);
        add(`${prefix} Transaction Fees`, 'expenses', r.transactionFees);
        add('FBA Fees', 'expenses', r.fbaFees);

        // Product cost = quantity × unit cost. Positive qty on a shipment
        // is a sold unit — debit to the channel's Product Costs line.
        const unitCost = parseFloat(prod.cost) || 0;
        if (unitCost > 0 && r.qty !== 0) {
          const cost = unitCost * r.qty;
          if (cost > 0) statement.expenses[`${prefix} Product Costs`].debit += cost;
          else if (cost < 0) statement.expenses[`${prefix} Product Costs`].credit += Math.abs(cost);
        }
      }

      const missingSkus = [...missing.entries()].map(([sku, orders]) => ({
        sku,
        orderCount: orders.size,
        sampleOrderIds: [...orders].slice(0, 3)
      }));
      const unmappedFees = [...unmappedServiceFeeTypes.entries()]
        .map(([feeType, total]) => ({ feeType, total }))
        .sort((a, b) => Math.abs(b.total) - Math.abs(a.total));
      return { statement, missingSkus, unmappedFees };
    }

    // ─── RENDER ─────────────────────────────────────────────────────────

    function _renderUpstashStatement(container, { statement, missingSkus, unmappedFees, rows, lastSynced, startDate, endDate, comparisons }) {
      // Delegate to the existing full renderer — it draws both the
      // traditional Income/Expenses tables AND the FBM/FBA/Total
      // Profitability Breakdown panels on the right. Passing `comparisons`
      // unlocks the MoM / YoY arrows in the breakdown panels.
      renderFinancialStatement(statement, startDate, endDate, container, comparisons || null);

      // Prepend Upstash-specific context: row count, last-synced, and any
      // warnings (missing SKUs, unmapped ServiceFee FeeTypes) above the
      // standard Income / Expenses / Breakdown tables.
      const syncLine = lastSynced
        ? `<div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.5rem;">Last synced: ${_formatSyncTime(lastSynced)}</div>`
        : '';
      const countLine = `
        <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;">
          ${rows.length.toLocaleString()} transaction row${rows.length === 1 ? '' : 's'} derived from raw SP-API payload (Orders + Refunds + Service Fees + Adjustments + Chargebacks/Guarantees/Retrocharges)
        </div>
      `;
      const missingWarning  = missingSkus.length  > 0 ? _renderMissingSkuWarning(missingSkus)   : '';
      const feeWarning      = unmappedFees && unmappedFees.length > 0 ? _renderUnmappedFeeWarning(unmappedFees) : '';
      container.innerHTML = syncLine + countLine + missingWarning + feeWarning + container.innerHTML;
    }

    // ServiceFee FeeTypes we don't have a rule for get bucketed into
    // "Other Expenses" and listed here so the user can decide where they
    // should go and extend SERVICE_FEE_LINE_MAP. Sorted by absolute value
    // descending so the financially-loudest ones surface first.
    function _renderUnmappedFeeWarning(unmapped) {
      const fmt = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const rows = unmapped.map(u => `
        <tr>
          <td style="padding: 0.5rem 0.75rem; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${_escape(u.feeType)}</td>
          <td style="padding: 0.5rem 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${fmt(u.total)}</td>
        </tr>
      `).join('');
      return `
        <div style="background: var(--bg-secondary); border: 1px solid var(--warning); border-radius: 6px; padding: 1rem; margin-bottom: 1.5rem;">
          <div style="font-weight: 600; color: var(--warning); margin-bottom: 0.5rem;">
            ⚠ ${unmapped.length} unmapped ServiceFee FeeType${unmapped.length === 1 ? '' : 's'} — routed to Other Expenses
          </div>
          <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.75rem;">
            These FeeTypes aren't in the SERVICE_FEE_LINE_MAP yet. Their amounts are summed into the Other Expenses line so nothing's lost; tell me where each one should route and I'll update the map.
          </div>
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr>
                <th style="text-align: left;  padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">FeeType</th>
                <th style="text-align: right; padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">Amount</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    function _renderMissingSkuWarning(missing) {
      const rows = missing.map(m => `
        <tr>
          <td style="padding: 0.5rem 0.75rem; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${_escape(m.sku || '(empty)')}</td>
          <td style="padding: 0.5rem 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${m.orderCount}</td>
          <td style="padding: 0.5rem 0.75rem; font-family: 'Roboto Mono', monospace; font-size: 0.8rem; color: var(--text-secondary);">${m.sampleOrderIds.map(_escape).join(', ')}${m.orderCount > m.sampleOrderIds.length ? ', …' : ''}</td>
        </tr>
      `).join('');
      return `
        <div style="background: var(--bg-secondary); border: 1px solid var(--warning); border-radius: 6px; padding: 1rem; margin-bottom: 1.5rem;">
          <div style="font-weight: 600; color: var(--warning); margin-bottom: 0.5rem;">
            ⚠ ${missing.length} SKU${missing.length === 1 ? '' : 's'} not found in the Product Catalog
          </div>
          <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 0.75rem;">
            These rows were skipped — add them to the catalog (with a fulfillment and cost) and reload to include them in the statement.
          </div>
          <table style="width: 100%; border-collapse: collapse;">
            <thead>
              <tr>
                <th style="text-align: left; padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">SKU</th>
                <th style="text-align: right; padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">Order Count</th>
                <th style="text-align: left; padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;">Sample Order IDs</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      `;
    }

    // ─── SHEETS-VS-UPSTASH SKU DIFF (DIAGNOSTIC) ────────────────────────
    // Fetches the Sheets Transactions tab + the Upstash derived rows for the
    // currently-selected Monthly Upstash period, aggregates per-SKU Order /
    // Refund product-sales on both sides, and renders a comparison table
    // sorted by |diff| descending. Also includes each SKU's recorded-at-
    // order-time fulfillment (from Sheets) vs current-catalog fulfillment so
    // classification shifts surface immediately.
    async function showMonthlyUpstashSkuDiff() {
      const month = parseInt(document.getElementById('monthly-upstash-month-select').value, 10);
      const year  = parseInt(document.getElementById('monthly-upstash-year-select').value, 10);
      if (isNaN(month) || isNaN(year)) return;

      const container = document.getElementById('monthly-upstash-content');
      if (!container) return;
      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Sign in to run the Sheets-vs-Upstash comparison</div>';
        return;
      }

      const startDate = _ymd(new Date(year, month, 1));
      const endDate   = _ymd(new Date(year, month + 1, 0));
      container.innerHTML = `<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Comparing Sheets vs Upstash for ${startDate} → ${endDate}…</div>`;

      try {
        const [sheetsInputs, upstashInputs] = await Promise.all([
          _fetchOverviewInputsFromSheets(),
          _fetchUpstashInputs(startDate, endDate)
        ]);

        // ── Aggregate Sheets side: sku → { order, refund, fulfillment } ──
        const sheetsRows = sheetsInputs.transactionsData.values || [];
        const headers = sheetsRows[0] || [];
        const idx = (needle) => headers.findIndex(h => String(h || '').toLowerCase() === needle);
        const dateIdx        = headers.findIndex(h => String(h || '').toLowerCase().includes('date'));
        const typeIdx        = idx('type');
        const skuIdx         = idx('sku');
        const fulfillmentIdx = idx('fulfillment');
        const salesIdx       = idx('product sales');

        const sheetsPerSku = Object.create(null);
        for (let i = 1; i < sheetsRows.length; i++) {
          const row = sheetsRows[i] || [];
          const dateStr = String(row[dateIdx] || '').substring(0, 10);
          if (!dateStr || dateStr < startDate || dateStr > endDate) continue;
          const type = String(row[typeIdx] || '').trim();
          const sku = _normalizeSku(row[skuIdx]);
          if (!sku) continue;
          const fulfillment = String(row[fulfillmentIdx] || '').trim();
          const amount = parseFloat(row[salesIdx]) || 0;
          let bucket = sheetsPerSku[sku];
          if (!bucket) bucket = sheetsPerSku[sku] = { order: 0, refund: 0, fulfillment: '' };
          if (type === 'Order')       bucket.order  += amount;
          else if (type === 'Refund') bucket.refund += amount;
          if (fulfillment && !bucket.fulfillment) bucket.fulfillment = fulfillment;
        }

        // ── Aggregate Upstash side: sku → { order, refund } ──────────────
        // Fulfillment is resolved from the catalog at merge time (not here)
        // so SKUs that exist in Sheets but have zero Upstash rows still
        // report their current catalog classification instead of falsely
        // looking "not in catalog."
        const rows = _deriveTransactionRows(upstashInputs.pages, startDate, endDate);
        const upstashPerSku = Object.create(null);
        for (const r of rows) {
          if (!r.sku || (r.type !== 'Order' && r.type !== 'Refund')) continue;
          let bucket = upstashPerSku[r.sku];
          if (!bucket) bucket = upstashPerSku[r.sku] = { order: 0, refund: 0 };
          if (r.type === 'Order')  bucket.order  += r.sale;
          else                      bucket.refund += r.sale;
        }

        // ── Merge + sort by |order diff| desc ─────────────────────────────
        // Catalog lookup is done unconditionally for every SKU in the union,
        // regardless of whether that SKU appeared in Upstash derived rows,
        // so the "Catalog Fulfillment" column is always trustworthy.
        const skus = new Set([...Object.keys(sheetsPerSku), ...Object.keys(upstashPerSku)]);
        const diffs = [];
        let sheetsTotal = 0, upstashTotal = 0;
        for (const sku of skus) {
          const s = sheetsPerSku[sku]  || { order: 0, refund: 0, fulfillment: '' };
          const u = upstashPerSku[sku] || { order: 0, refund: 0 };
          const prod = upstashInputs.products[sku];
          let catalogFulfillment;
          if (!prod) catalogFulfillment = '(not in catalog)';
          else if (!String(prod.fulfillment || '').trim()) catalogFulfillment = '(blank)';
          else catalogFulfillment = String(prod.fulfillment).trim();

          sheetsTotal  += s.order;
          upstashTotal += u.order;
          diffs.push({
            sku,
            sheetsOrder:  s.order,
            upstashOrder: u.order,
            orderDiff:    u.order - s.order,
            sheetsRefund:  s.refund,
            upstashRefund: u.refund,
            sheetsFulfillment: s.fulfillment,
            catalogFulfillment
          });
        }
        diffs.sort((a, b) => Math.abs(b.orderDiff) - Math.abs(a.orderDiff));

        _renderSkuDiff(container, {
          startDate, endDate,
          sheetsTotal, upstashTotal,
          totalDiff: upstashTotal - sheetsTotal,
          diffs
        });
      } catch (err) {
        console.error('SKU diff failed:', err);
        container.innerHTML = `<div style="padding: 2rem; color: var(--error);">Error: ${err.message}</div>`;
      }
    }

    function _renderSkuDiff(container, { startDate, endDate, sheetsTotal, upstashTotal, totalDiff, diffs }) {
      const fmt = (n) => {
        const abs = Math.abs(n);
        const s = '$' + abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return n < 0 ? `(${s})` : s;
      };
      const diffColor = (n) => n > 0.005 ? 'var(--success, #1f9d55)' : (n < -0.005 ? 'var(--error)' : 'var(--text-secondary)');

      // Synthetic markers shouldn't participate in the classification-shift
      // comparison — "(not in catalog)" and "(blank)" mean "we don't have
      // a catalog value to compare against," not "the classification flipped."
      const isRealFulfillment = (v) => v && v !== '(not in catalog)' && v !== '(blank)';
      const fulfillmentShifted = (d) =>
        isRealFulfillment(d.sheetsFulfillment) &&
        isRealFulfillment(d.catalogFulfillment) &&
        d.sheetsFulfillment.toLowerCase() !== d.catalogFulfillment.toLowerCase();

      // Only list SKUs with a meaningful order diff (≥ $0.01) OR with a
      // real fulfillment-classification mismatch. Everything else is noise.
      const filtered = diffs.filter(d =>
        Math.abs(d.orderDiff) >= 0.01 || fulfillmentShifted(d)
      );

      const rowsHtml = filtered.map(d => {
        const shifted = fulfillmentShifted(d);
        return `
          <tr>
            <td style="padding: 0.5rem 0.75rem; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${_escape(d.sku || '(empty)')}</td>
            <td style="padding: 0.5rem 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${fmt(d.sheetsOrder)}</td>
            <td style="padding: 0.5rem 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${fmt(d.upstashOrder)}</td>
            <td style="padding: 0.5rem 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; font-size: 0.85rem; color: ${diffColor(d.orderDiff)};">${fmt(d.orderDiff)}</td>
            <td style="padding: 0.5rem 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${fmt(d.sheetsRefund)}</td>
            <td style="padding: 0.5rem 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;">${fmt(d.upstashRefund)}</td>
            <td style="padding: 0.5rem 0.75rem; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;${shifted ? ' color: var(--warning);' : ''}">${_escape(d.sheetsFulfillment || '—')}</td>
            <td style="padding: 0.5rem 0.75rem; font-family: 'Roboto Mono', monospace; font-size: 0.85rem;${shifted ? ' color: var(--warning);' : ''}">${_escape(d.catalogFulfillment || '—')}</td>
          </tr>
        `;
      }).join('');

      const thStyle = 'text-align: left; padding: 0.5rem 0.75rem; background: var(--bg-primary); font-weight: 600; font-size: 0.8rem;';
      const thRight = thStyle.replace('text-align: left', 'text-align: right');

      container.innerHTML = `
        <div style="margin-bottom: 1rem;">
          <button class="btn btn-secondary" onclick="generateMonthlyUpstashReport()" style="padding: 0.5rem 1rem;">← Back to report</button>
        </div>
        <div style="margin-bottom: 1rem; font-weight: 600;">
          Per-SKU Sheets vs Upstash comparison · ${startDate} → ${endDate}
        </div>
        <div style="display: flex; gap: 2rem; margin-bottom: 1rem; font-family: 'Roboto Mono', monospace; font-size: 0.9rem;">
          <div><span style="color: var(--text-secondary);">Sheets Orders total:</span> ${fmt(sheetsTotal)}</div>
          <div><span style="color: var(--text-secondary);">Upstash Orders total:</span> ${fmt(upstashTotal)}</div>
          <div><span style="color: var(--text-secondary);">Diff (Upstash − Sheets):</span> <span style="color: ${diffColor(totalDiff)};">${fmt(totalDiff)}</span></div>
        </div>
        <div style="color: var(--text-secondary); font-size: 0.85rem; margin-bottom: 0.75rem;">
          Showing ${filtered.length} of ${diffs.length} SKUs that have a non-zero order diff (≥ $0.01) or a fulfillment mismatch. Rows with amber fulfillment cells had a different fulfillment recorded on March orders than the current Products catalog.
        </div>
        <table style="width: 100%; border-collapse: collapse;">
          <thead>
            <tr>
              <th style="${thStyle}">SKU</th>
              <th style="${thRight}">Sheets Orders</th>
              <th style="${thRight}">Upstash Orders</th>
              <th style="${thRight}">Diff</th>
              <th style="${thRight}">Sheets Refunds</th>
              <th style="${thRight}">Upstash Refunds</th>
              <th style="${thStyle}">Sheets Fulfillment</th>
              <th style="${thStyle}">Catalog Fulfillment</th>
            </tr>
          </thead>
          <tbody>${rowsHtml || '<tr><td colspan="8" style="padding: 1rem; text-align: center; color: var(--text-secondary);">No meaningful diffs found.</td></tr>'}</tbody>
        </table>
      `;
    }

    // ─── CSV EXPORT ─────────────────────────────────────────────────────
    // Exports the derived transaction rows (Orders + Refunds, 10 columns) —
    // what ends up fed into the statement builder. Lets the user spot-check
    // the mapping per row without having to scroll the raw payload.

    async function exportMonthlyUpstashCSV() {
      const month = parseInt(document.getElementById('monthly-upstash-month-select').value, 10);
      const year  = parseInt(document.getElementById('monthly-upstash-year-select').value, 10);
      if (isNaN(month) || isNaN(year)) return;
      const startDate = _ymd(new Date(year, month, 1));
      const endDate   = _ymd(new Date(year, month + 1, 0));
      await _downloadDerivedCSV(startDate, endDate, `transactions-derived-${year}-${String(month + 1).padStart(2, '0')}.csv`);
    }

    async function exportYTDUpstashCSV() {
      const year = document.getElementById('ytd-upstash-year-select').value;
      if (!year) return;
      await _downloadDerivedCSV(`${year}-01-01`, `${year}-12-31`, `transactions-derived-${year}-YTD.csv`);
    }

    async function _downloadDerivedCSV(startDate, endDate, filename) {
      if (!accessToken) { alert('Please sign in first'); return; }
      try {
        const { pages } = await _fetchUpstashInputs(startDate, endDate);
        const rows = _deriveTransactionRows(pages, startDate, endDate);
        if (rows.length === 0) {
          alert('No transaction rows in range — has this period been synced?');
          return;
        }
        const headers = [
          'type', 'order id', 'date', 'sku', 'qty',
          'sale', 'other charges', 'fba fees', 'transaction fees', 'promotions',
          'fee type', 'fee amount',
          'adjustment type', 'adjustment amount'
        ];
        const lines = [headers.map(_csvCell).join(',')];
        for (const r of rows) {
          lines.push([
            r.type, r.orderId, r.date, r.sku, r.qty,
            _round2(r.sale), _round2(r.otherCharges),
            _round2(r.fbaFees), _round2(r.transactionFees), _round2(r.promotions),
            r.feeType || '',
            r.feeAmount != null ? _round2(r.feeAmount) : '',
            r.adjustmentType || '',
            r.adjustmentAmount != null ? _round2(r.adjustmentAmount) : ''
          ].map(_csvCell).join(','));
        }
        _download(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' }), filename);
      } catch (err) {
        console.error('CSV export failed:', err);
        alert(`Export failed: ${err.message}`);
      }
    }

    async function exportMonthlyUpstashDetailCSV() {
      const month = parseInt(document.getElementById('monthly-upstash-month-select').value, 10);
      const year  = parseInt(document.getElementById('monthly-upstash-year-select').value, 10);
      if (isNaN(month) || isNaN(year)) return;
      const yyyyMM = `${year}-${String(month + 1).padStart(2, '0')}`;

      if (!accessToken) { alert('Please sign in first'); return; }
      try {
        const res = await fetch(`/api/transactions?action=get&month=${yyyyMM}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        if (!res.ok) throw new Error(`Fetch failed (${res.status})`);
        const data = await res.json();
        const rows = _flattenRawPages(data.pages || []);
        if (rows.length === 0) {
          alert('No raw events found — has this month been synced?');
          return;
        }
        const HEADERS = [
          'event_type', 'posted_date', 'amazon_order_id', 'seller_sku',
          'reason', 'description', 'quantity',
          'charge_type', 'charge_amount', 'fee_type', 'fee_amount',
          'currency'
        ];
        const lines = [HEADERS.map(_csvCell).join(',')];
        for (const r of rows) lines.push(HEADERS.map(h => _csvCell(r[h] ?? '')).join(','));
        _download(new Blob([lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' }), `transactions-detail-${yyyyMM}.csv`);
      } catch (err) {
        console.error('Detail CSV export failed:', err);
        alert(`Export failed: ${err.message}`);
      }
    }

    function _download(blob, filename) {
      const href = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = href;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(href);
    }

    // Flatten raw pages → one row per atomic charge/fee for the Detail CSV.
    function _flattenRawPages(pages) {
      const rows = [];
      for (const page of pages) {
        for (const ev of (page.ShipmentEventList || []))      _emitItemEventRows(rows, ev, 'ShipmentEvent',      ev.ShipmentItemList);
        for (const ev of (page.RefundEventList || []))        _emitItemEventRows(rows, ev, 'RefundEvent',        ev.ShipmentItemAdjustmentList);
        for (const ev of (page.GuaranteeClaimEventList || [])) _emitItemEventRows(rows, ev, 'GuaranteeClaimEvent', ev.ShipmentItemAdjustmentList);
        for (const ev of (page.ChargebackEventList || []))    _emitItemEventRows(rows, ev, 'ChargebackEvent',    ev.ShipmentItemAdjustmentList);
        for (const ev of (page.RetrochargeEventList || []))   _emitItemEventRows(rows, ev, 'RetrochargeEvent',   ev.ShipmentItemAdjustmentList);
        for (const ev of (page.ServiceFeeEventList || []))    _emitServiceFeeRows(rows, ev);
        for (const ev of (page.AdjustmentEventList || []))    _emitAdjustmentRows(rows, ev);
      }
      return rows;
    }

    function _emitItemEventRows(rows, ev, eventType, items) {
      const base = {
        event_type: eventType,
        posted_date: (ev.PostedDate || '').substring(0, 10),
        amazon_order_id: ev.AmazonOrderId || '',
        reason: '', description: ''
      };
      const itemList = items || [];
      if (itemList.length === 0) {
        rows.push({ ...base, seller_sku: '', quantity: '', charge_type: '', charge_amount: '', fee_type: '', fee_amount: '', currency: '' });
        return;
      }
      for (const item of itemList) {
        const itemBase = {
          ...base,
          seller_sku: _normalizeSku(item.SellerSKU),
          quantity: item.QuantityShipped ?? '',
          description: item.ProductDescription || ''
        };
        const charges = item.ItemChargeList || item.ItemChargeAdjustmentList || [];
        const fees    = item.ItemFeeList    || item.ItemFeeAdjustmentList    || [];
        const proms   = item.PromotionList || [];
        if (charges.length === 0 && fees.length === 0 && proms.length === 0) {
          rows.push({ ...itemBase, charge_type: '', charge_amount: '', fee_type: '', fee_amount: '', currency: '' });
          continue;
        }
        for (const c of charges) {
          rows.push({ ...itemBase, charge_type: c.ChargeType || '', charge_amount: _amount(c.ChargeAmount), fee_type: '', fee_amount: '', currency: c.ChargeAmount?.CurrencyCode || '' });
        }
        for (const f of fees) {
          rows.push({ ...itemBase, charge_type: '', charge_amount: '', fee_type: f.FeeType || '', fee_amount: _amount(f.FeeAmount), currency: f.FeeAmount?.CurrencyCode || '' });
        }
        for (const p of proms) {
          rows.push({ ...itemBase, charge_type: 'Promotion', charge_amount: _amount(p.PromotionAmount), fee_type: '', fee_amount: '', currency: p.PromotionAmount?.CurrencyCode || '', reason: p.PromotionType || '', description: p.PromotionId || '' });
        }
      }
    }

    function _emitServiceFeeRows(rows, ev) {
      const base = {
        event_type: 'ServiceFeeEvent',
        posted_date: (ev.PostedDate || '').substring(0, 10),
        amazon_order_id: ev.AmazonOrderId || '',
        seller_sku: _normalizeSku(ev.SellerSKU),
        reason: ev.FeeReason || '',
        description: ev.FeeDescription || '',
        quantity: '',
        charge_type: '', charge_amount: ''
      };
      const feeList = ev.FeeList || [];
      if (feeList.length === 0) {
        rows.push({ ...base, fee_type: '', fee_amount: '', currency: '' });
        return;
      }
      for (const f of feeList) {
        rows.push({ ...base, fee_type: f.FeeType || '', fee_amount: _amount(f.FeeAmount), currency: f.FeeAmount?.CurrencyCode || '' });
      }
    }

    function _emitAdjustmentRows(rows, ev) {
      const base = {
        event_type: 'AdjustmentEvent',
        posted_date: (ev.PostedDate || '').substring(0, 10),
        amazon_order_id: '',
        reason: ev.AdjustmentType || '',
        description: '',
        charge_type: '', charge_amount: ''
      };
      const items = ev.AdjustmentItemList || [];
      if (items.length === 0) {
        rows.push({ ...base, seller_sku: '', quantity: '', fee_type: 'Adjustment', fee_amount: _amount(ev.AdjustmentAmount), currency: ev.AdjustmentAmount?.CurrencyCode || '' });
        return;
      }
      for (const item of items) {
        rows.push({
          ...base,
          seller_sku: _normalizeSku(item.SellerSKU),
          description: item.ProductDescription || '',
          quantity: item.Quantity ?? '',
          fee_type: 'Adjustment',
          fee_amount: _amount(item.TotalAmount || item.PerUnitAmount),
          currency: (item.TotalAmount || item.PerUnitAmount)?.CurrencyCode || ''
        });
      }
    }

    // ─── SMALL UTILITIES ────────────────────────────────────────────────

    function _csvCell(v) {
      const s = v == null ? '' : String(v);
      return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    }

    function _round2(n) {
      return Math.round((Number(n) || 0) * 100) / 100;
    }

    function _ymd(d) {
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    function _formatSyncTime(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return iso;
      return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    }

    function _escape(s) {
      if (s == null) return '';
      return String(s)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#39;');
    }
