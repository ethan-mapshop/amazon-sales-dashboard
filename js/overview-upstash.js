    // Profitability Overview — Upstash-backed variant.
    //
    // Storage model: /api/transactions stores the RAW SP-API FinancialEvents
    // pages only. All mapping/categorization happens here on the client, so
    // iterating on the schema requires no re-sync — just a reload.
    //
    // Scope of what's wired right now:
    //   ShipmentEventList — mapped per the ShipmentEvent mapping schema:
    //     sale             ← ChargeType: Principal
    //     other charges    ← ChargeType: GiftWrap, Shipping, ShippingCharge,
    //                                    + any non-tax ChargeType as fallback
    //     fba fees         ← FeeType: FBAPerOrderFulfillmentFee,
    //                                 FBAPerUnitFulfillmentFee,
    //                                 FBAWeightBasedFee, or anything that
    //                                 starts with "FBA"
    //     transaction fees ← FeeType: Commission, FixedClosingFee,
    //                                 VariableClosingFee, GiftwrapChargeback,
    //                                 ShippingChargeback, DigitalServicesFee,
    //                                 plus any unknown non-FBA FeeType
    //     promotions       ← PromotionList[].PromotionAmount
    //   Fulfillment (Amazon/Seller) comes from the Products catalog
    //   lookup, NOT from fee heuristics.
    //
    // Not wired yet (waiting on user schema): RefundEventList,
    // ServiceFeeEventList, AdjustmentEventList, ChargebackEventList,
    // GuaranteeClaimEventList, RetrochargeEventList.
    // Ad spend + shipping still read from the Sheets tabs until those
    // migrations ship.

    // ─── VIEW SWITCHING ─────────────────────────────────────────────────

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
    }

    function showYTDUpstash() {
      _hideAllOverviewViews();
      document.getElementById('ytd-upstash-view').style.display = 'block';
      document.getElementById('ytd-upstash-tab').classList.add('active');
      _initYTDUpstashDropdown();
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

    function setMonthlyUpstashLastMonth() {
      const now = new Date();
      let month = now.getMonth() - 1;
      let year = now.getFullYear();
      if (month < 0) { month = 11; year--; }
      document.getElementById('monthly-upstash-month-select').value = month;
      const yearSel = document.getElementById('monthly-upstash-year-select');
      if (yearSel && [...yearSel.options].some(o => parseInt(o.value, 10) === year)) {
        yearSel.value = year;
      }
      generateMonthlyUpstashReport();
    }

    function setYTDUpstashYear(which) {
      const now = new Date();
      const year = which === 'thisYear' ? now.getFullYear() : now.getFullYear() - 1;
      const yearSel = document.getElementById('ytd-upstash-year-select');
      if (yearSel && [...yearSel.options].some(o => parseInt(o.value, 10) === year)) {
        yearSel.value = year;
      }
      generateYTDUpstashReport();
    }

    // ─── REPORT GENERATION ──────────────────────────────────────────────

    async function generateMonthlyUpstashReport() {
      const month = parseInt(document.getElementById('monthly-upstash-month-select').value, 10);
      const year  = parseInt(document.getElementById('monthly-upstash-year-select').value, 10);
      if (isNaN(month) || isNaN(year)) return;

      const startDate = _ymd(new Date(year, month, 1));
      const endDate   = _ymd(new Date(year, month + 1, 0));
      await _runUpstashOverview(startDate, endDate, 'monthly-upstash-content');
    }

    async function generateYTDUpstashReport() {
      const year = document.getElementById('ytd-upstash-year-select').value;
      if (!year) return;

      const today = new Date();
      const selectedYear = parseInt(year, 10);
      const isCurrentYear = selectedYear === today.getFullYear();

      const startDate = `${year}-01-01`;
      let endDate;
      if (isCurrentYear) {
        const lastCompleteMonth = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
        const lastCompleteMonthYear = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();
        endDate = _ymd(new Date(lastCompleteMonthYear, lastCompleteMonth + 1, 0));
      } else {
        endDate = `${year}-12-31`;
      }
      await _runUpstashOverview(startDate, endDate, 'ytd-upstash-content');
    }

    async function _runUpstashOverview(startDate, endDate, containerId) {
      const container = document.getElementById(containerId);
      if (!container) return;
      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Please sign in</div>';
        return;
      }

      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading data...</div>';

      try {
        const { pages, products, lastSynced } = await _fetchUpstashInputs(startDate, endDate);
        const rows = _deriveShipmentRows(pages, startDate, endDate);
        const { statement, missingSkus } = _buildStatement(rows, products);
        _renderUpstashStatement(container, { statement, missingSkus, rows, lastSynced, startDate, endDate });
      } catch (err) {
        console.error('Upstash overview failed:', err);
        container.innerHTML = `<div style="padding: 2rem; color: var(--error);">Error: ${err.message}</div>`;
      }
    }

    // ─── INPUT FETCHING ─────────────────────────────────────────────────

    async function _fetchUpstashInputs(startDate, endDate) {
      const authHeader = { Authorization: `Bearer ${accessToken}` };
      const startMonth = startDate.slice(0, 7);
      const endMonth   = endDate.slice(0, 7);

      const [txRes, prodRes] = await Promise.all([
        fetch(`/api/transactions?action=get-range&startMonth=${startMonth}&endMonth=${endMonth}`, { headers: authHeader }),
        fetch('/api/products?action=get', { headers: authHeader })
      ]);
      if (!txRes.ok)   throw new Error(`Transactions fetch failed (${txRes.status})`);
      if (!prodRes.ok) throw new Error(`Products fetch failed (${prodRes.status})`);

      const tx = await txRes.json();
      const prod = await prodRes.json();

      // Products keyed by SKU for O(1) lookup during derivation.
      const products = {};
      for (const p of (prod.products || [])) {
        if (p?.sku) products[p.sku] = p;
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

      return { pages: tx.pages || [], products, lastSynced };
    }

    // ─── SHIPMENTEVENT DERIVE ───────────────────────────────────────────
    // Walk every ShipmentEvent page; emit one row per ShipmentItem per the
    // schema documented at the top of this file. Filter by date so a
    // YTD-range fetch only counts items posted within the window.

    function _deriveShipmentRows(pages, startDate, endDate) {
      const rows = [];
      for (const page of pages) {
        for (const ev of (page.ShipmentEventList || [])) {
          const date = (ev.PostedDate || '').substring(0, 10);
          if (!date || date < startDate || date > endDate) continue;
          const orderId = ev.AmazonOrderId || '';

          for (const item of (ev.ShipmentItemList || [])) {
            rows.push({
              orderId,
              date,
              sku: item.SellerSKU || '',
              qty: parseInt(item.QuantityShipped, 10) || 0,
              sale:            _sumCharges(item, ['Principal']),
              otherCharges:    _sumOtherCharges(item),
              fbaFees:         _sumFees(item, _isFbaFee),
              transactionFees: _sumFees(item, _isTransactionFee),
              promotions:      _sumPromotions(item)
            });
          }
        }
      }
      return rows;
    }

    function _sumCharges(item, types) {
      let total = 0;
      for (const c of (item.ItemChargeList || [])) {
        if (types.includes(c.ChargeType)) total += _amount(c.ChargeAmount);
      }
      return total;
    }

    // "Other charges" = GiftWrap + Shipping/ShippingCharge, plus any
    // non-tax, non-Principal ChargeType as a catch-all (per the user rule
    // that anything non-tax falls into FBM/FBA Other).
    function _sumOtherCharges(item) {
      const KNOWN_OTHER = new Set(['GiftWrap', 'Shipping', 'ShippingCharge']);
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
      for (const c of (item.ItemChargeList || [])) {
        const t = c.ChargeType;
        if (!t) continue;
        if (t === 'Principal') continue;
        if (TAX_TYPES.has(t)) continue;
        if (KNOWN_OTHER.has(t) || !TAX_TYPES.has(t)) total += _amount(c.ChargeAmount);
      }
      return total;
    }

    function _sumFees(item, predicate) {
      let total = 0;
      for (const f of (item.ItemFeeList || [])) {
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
      let total = 0;
      for (const p of (item.PromotionList || [])) {
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
      'FBA Inbound Placement Fees', 'FBA Inbound Shipping Costs',
      'FBA Inventory Storage Fees', 'FBA Inventory Reimbursement', 'FBA Ad Spend',
      'Other Expenses', 'Unallocated Ad Spend'
    ];

    function _buildStatement(rows, products) {
      const statement = {
        income: Object.fromEntries(STATEMENT_INCOME_LINES.map(k => [k, { debit: 0, credit: 0 }])),
        expenses: Object.fromEntries(STATEMENT_EXPENSE_LINES.map(k => [k, { debit: 0, credit: 0 }]))
      };
      const missing = new Map(); // sku → Set of orderIds using it

      const add = (line, section, amount) => {
        if (amount > 0) statement[section][line].credit += amount;
        else if (amount < 0) statement[section][line].debit += Math.abs(amount);
      };

      for (const r of rows) {
        const prod = products[r.sku];
        if (!prod) {
          if (!missing.has(r.sku)) missing.set(r.sku, new Set());
          missing.get(r.sku).add(r.orderId);
          continue; // Can't categorize without knowing fulfillment.
        }
        const fulfillment = (prod.fulfillment || '').trim();
        const isFba = fulfillment === 'Amazon';
        const prefix = isFba ? 'FBA' : 'FBM';

        add(`${prefix} Sales`, 'income', r.sale);
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
      return { statement, missingSkus };
    }

    // ─── RENDER ─────────────────────────────────────────────────────────

    function _renderUpstashStatement(container, { statement, missingSkus, rows, lastSynced, startDate, endDate }) {
      const warning = missingSkus.length > 0 ? _renderMissingSkuWarning(missingSkus) : '';
      const period = startDate === endDate.slice(0, 7) + '-' + endDate.slice(8)
        ? `${startDate} – ${endDate}`
        : `${startDate} – ${endDate}`;
      const syncLine = lastSynced
        ? `<div style="font-size: 0.8rem; color: var(--text-secondary); margin-bottom: 0.5rem;">Last synced: ${_formatSyncTime(lastSynced)}</div>`
        : '';
      const headerLine = `
        <div style="font-size: 1rem; font-weight: 600; margin-bottom: 0.5rem;">${period}</div>
        <div style="font-size: 0.85rem; color: var(--text-secondary); margin-bottom: 1rem;">
          ${rows.length.toLocaleString()} ShipmentEvent row${rows.length === 1 ? '' : 's'} derived from raw SP-API payload
        </div>
      `;

      container.innerHTML = `
        ${headerLine}
        ${syncLine}
        ${warning}
        ${_renderSection('Income', statement.income)}
        ${_renderSection('Expenses', statement.expenses)}
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

    function _renderSection(label, lines) {
      const fmt = (n) => '$' + Math.abs(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      let totalDebit = 0, totalCredit = 0;
      const rows = Object.entries(lines).map(([category, amounts]) => {
        totalDebit  += amounts.debit;
        totalCredit += amounts.credit;
        return `
          <tr>
            <td style="padding: 0.625rem; border-bottom: 1px solid var(--border);">${category}</td>
            <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${amounts.debit  > 0 ? fmt(amounts.debit)  : '$0.00'}</td>
            <td style="padding: 0.625rem; border-bottom: 1px solid var(--border); text-align: right; font-family: 'Roboto Mono', monospace;">${amounts.credit > 0 ? fmt(amounts.credit) : '$0.00'}</td>
          </tr>
        `;
      }).join('');

      const color = label === 'Income' ? 'var(--success)' : 'var(--error)';
      return `
        <div style="margin-bottom: 2rem;">
          <h3 style="font-size: 1.25rem; font-weight: 600; margin-bottom: 1rem; color: ${color};">${label}</h3>
          <table style="width: 100%;">
            <thead>
              <tr>
                <th style="text-align: left; padding: 0.75rem; background: var(--bg-secondary); width: 50%;">Category</th>
                <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 25%; min-width: 140px;">Debit</th>
                <th style="text-align: right; padding: 0.75rem; background: var(--bg-secondary); width: 25%; min-width: 140px;">Credit</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
              <tr style="font-weight: 700; background: var(--bg-secondary);">
                <td style="padding: 0.75rem;">Totals</td>
                <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">${fmt(totalDebit)}</td>
                <td style="padding: 0.75rem; text-align: right; font-family: 'Roboto Mono', monospace;">${fmt(totalCredit)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      `;
    }

    // ─── CSV EXPORT ─────────────────────────────────────────────────────
    // Exports the derived ShipmentEvent rows (9 columns per the schema) —
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
        const rows = _deriveShipmentRows(pages, startDate, endDate);
        if (rows.length === 0) {
          alert('No ShipmentEvent rows in range — has this period been synced?');
          return;
        }
        const headers = ['order id', 'date', 'sku', 'qty', 'sale', 'other charges', 'fba fees', 'transaction fees', 'promotions'];
        const lines = [headers.map(_csvCell).join(',')];
        for (const r of rows) {
          lines.push([
            r.orderId, r.date, r.sku, r.qty,
            _round2(r.sale), _round2(r.otherCharges),
            _round2(r.fbaFees), _round2(r.transactionFees), _round2(r.promotions)
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
          seller_sku: item.SellerSKU || '',
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
        seller_sku: ev.SellerSKU || '',
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
          seller_sku: item.SellerSKU || '',
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
