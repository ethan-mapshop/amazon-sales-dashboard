    // ─── CAMPAIGN OVERVIEW ───────────────────────────────────────────────────
    // Amazon ad campaign and portfolio CONFIGURATION, grouped by portfolio.
    // Reads a stored snapshot from /api/adcampaigns; refreshing is an explicit
    // user action.
    //
    // loadAdCampaigns() renders the cache and NEVER triggers a refresh —
    // showPage() and triggerCurrentPageLoad() both fire on restore and after
    // sign-in, so auto-syncing there would hammer Amazon on every navigation.
    //
    // Everything is prefixed `aco`. These files share one global scope, so
    // escapeHtml / formatNumber / _svTimeAgo are CALLED, never redefined — and
    // note filterDropdown() belongs to catalog.js and closes over its own
    // state, so shadowing it would silently break Product Catalog's filter row.

    const ACO_COLUMNS = [
      { field: 'name',            label: 'Campaign' },
      { field: 'campaignType',    label: 'Type',          filter: true },
      { field: 'adProduct',       label: 'Ad',            filter: true },
      { field: 'state',           label: 'State',         filter: true },
      { field: 'brand',           label: 'Brand',         filter: true, editable: 'brand' },
      { field: 'dailyBudget',     label: 'Daily budget',  align: 'right', mono: true, format: 'money' },
      { field: 'biddingStrategy', label: 'Bidding' },
      { field: 'placements',      label: 'Placements',    format: 'placements' },
      // Hidden rather than deleted: gone from the table, still in the CSV.
      { field: 'startDate',       label: 'Started',       hidden: true },
      // Present in the CSV, absent from the table. Without ids an export can't
      // be joined back to anything after the first rename.
      { field: 'portfolio',       label: 'Portfolio',     hidden: true },
      { field: 'portfolioId',     label: 'Portfolio ID',  hidden: true },
      { field: 'campaignId',      label: 'Campaign ID',   hidden: true }
    ];

    // Amazon's API enums translated to the wording Campaign Manager shows.
    // Strings verified against the console's own SP Campaign Report export.
    // LEGACY_FOR_SALES is "legacy" only in the sense that down-only bidding
    // predates up-and-down — the enum was kept for backwards compatibility and
    // says nothing about the campaign being outdated.
    const ACO_LABELS = {
      biddingStrategy: {
        LEGACY_FOR_SALES: 'Dynamic bids - down only',
        AUTO_FOR_SALES:   'Dynamic bids - up and down',
        MANUAL:           'Fixed bids'
      },
      targetingType: {
        AUTO:   'Automatic targeting',
        MANUAL: 'Manual targeting'
      },
      state: {
        ENABLED:  'Enabled',
        PAUSED:   'Paused',
        ARCHIVED: 'Archived'
      },
      placement: {
        PLACEMENT_TOP:            'Top of search',
        PLACEMENT_PRODUCT_PAGE:   'Product pages',
        PLACEMENT_REST_OF_SEARCH: 'Rest of search'
      }
    };

    // Short forms for the table cell; the full names go in the title.
    const ACO_PLACEMENT_SHORT = {
      PLACEMENT_TOP:            'TOS',
      PLACEMENT_PRODUCT_PAGE:   'PP',
      PLACEMENT_REST_OF_SEARCH: 'ROS'
    };

    // null means Amazon did not tell us, which is a different fact from "none"
    // and is rendered differently — same treatment as an unknown daily budget.
    function acoPlacementsText(placements) {
      if (placements === null || placements === undefined) return null;
      if (!placements.length) return '';
      return placements
        .map(p => `${ACO_PLACEMENT_SHORT[p.placement] || p.placement} ${p.percentage}%`)
        .join(' · ');
    }

    // Unknown values fall through to the raw string rather than rendering
    // blank — a new Amazon enum should look unfamiliar, not disappear.
    function acoLabel(field, value) {
      if (value === null || value === undefined || value === '') return '';
      const map = ACO_LABELS[field];
      return (map && map[String(value).toUpperCase()]) || String(value);
    }

    const ACO_VISIBLE = ACO_COLUMNS.filter(c => !c.hidden);

    let acoData = { campaigns: [], portfolios: [], changes: [], meta: null, syncedAt: null };
    let acoFilters = {};
    let acoSearch = '';
    let acoOnlyEnabled = true;   // most of the time you only care about what's running
    let acoCollapsed = new Set();
    let acoBusy = false;

    // ── EDITOR STATE ─────────────────────────────────────────────────────────
    // acoRenderTable replaces the whole table on every keystroke, filter change
    // and collapse toggle, so the editor cannot hold state in the DOM. Inputs
    // write into acoEditDraft and the panel renders FROM the draft — a
    // re-render mid-edit then restores what was typed instead of discarding it.
    let acoEditingId = null;
    let acoEditDraft = null;
    let acoEditBusy = false;
    let acoEditError = null;
    let acoFlash = null;

    function loadAdCampaigns() {
      const container = document.getElementById('adcampaigns-content');
      if (!container) return;

      if (!accessToken) {
        container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Sign in to view campaigns.</div>';
        return;
      }

      container.innerHTML = '<div style="padding: 4rem; text-align: center; color: var(--text-secondary);">Loading campaigns…</div>';

      fetch('/api/adcampaigns?action=get', { headers: { Authorization: `Bearer ${accessToken}` } })
        .then(async res => {
          // Parse defensively: an error page is HTML, and res.json() throwing
          // first would surface "Unexpected token '<'" instead of the status.
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || `Failed to load (${res.status})`);
          acoData = {
            campaigns: data.campaigns || [], portfolios: data.portfolios || [],
            changes: data.changes || [], meta: data.meta || null, syncedAt: data.syncedAt || null,
            knownBrands: data.knownBrands || []
          };
          acoRender();
        })
        .catch(err => {
          console.error('[ACO] load failed:', err);
          container.innerHTML = `<div style="padding: 4rem; text-align: center; color: var(--error);">Error: ${escapeHtml(err.message)}</div>`;
        });
    }

    async function acoRefresh(dry) {
      if (acoBusy || !accessToken) return;
      acoBusy = true;
      acoSetBusy(true, dry ? 'Dry run…' : 'Refreshing…');
      try {
        const res = await fetch(`/api/adcampaigns?action=refresh${dry ? '&dry=1' : ''}`, {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || `Refresh failed (${res.status})`);

        if (data.aborted) {
          acoShowDiagnostic('Refresh aborted', data);
          return;
        }
        if (dry) {
          acoShowDiagnostic('Dry run — nothing was written', data);
          return;
        }
        loadAdCampaigns();
      } catch (err) {
        console.error('[ACO] refresh failed:', err);
        acoShowDiagnostic('Refresh failed', { error: err.message });
      } finally {
        acoBusy = false;
        acoSetBusy(false);
      }
    }

    async function acoProbe() {
      if (acoBusy || !accessToken) return;
      acoBusy = true;
      acoSetBusy(true, 'Probing…');
      try {
        const res = await fetch('/api/adcampaigns?action=probe', {
          headers: { Authorization: `Bearer ${accessToken}` }
        });
        const data = await res.json();
        acoShowDiagnostic('Raw API probe', data);
      } catch (err) {
        acoShowDiagnostic('Probe failed', { error: err.message });
      } finally {
        acoBusy = false;
        acoSetBusy(false);
      }
    }

    // ─── RENDER ──────────────────────────────────────────────────────────────

    function acoRender() {
      const container = document.getElementById('adcampaigns-content');
      if (!container) return;

      if (!acoData.campaigns.length) {
        container.innerHTML = `
          <div class="card card-flat" style="text-align: center; padding: 4rem 2rem;">
            <div style="font-size: 2.5rem; opacity: 0.35; margin-bottom: 1rem;">📋</div>
            <div style="color: var(--text-secondary); max-width: 40rem; margin: 0 auto; line-height: 1.6;">
              No campaign data stored yet. Press <strong>Refresh from Amazon</strong> to fetch
              campaigns and portfolios. This reads campaign settings directly, so it takes a
              second or two rather than the minutes a performance report needs.
            </div>
          </div>
          <div id="aco-diagnostic"></div>`;
        acoSetBlurb('No data yet');
        return;
      }

      acoSetBlurb(
        `${acoData.campaigns.length} campaigns · ${acoData.portfolios.length} portfolios · ` +
        `synced ${acoData.syncedAt ? _svTimeAgo(acoData.syncedAt) : 'never'}`
      );

      container.innerHTML =
        acoFlashBlock() + acoStats() + acoCoverageNotes() + acoCoverageBanner() + acoToolbar() +
        '<div id="aco-table-wrap"></div>' +
        acoChangesCard() + acoCoverageDetails() + '<div id="aco-diagnostic"></div>';

      acoRenderTable();
      acoBindControls();
    }

    // acoRender rebuilds the container, so a success message has to be rendered
    // by it and then cleared — otherwise a successful save looks like nothing
    // happened at all.
    function acoFlashBlock() {
      if (!acoFlash) return '';
      const msg = acoFlash;
      acoFlash = null;
      return `<div class="card" style="margin-bottom: 1.5rem; border-left: 3px solid var(--success);">
        <div style="color: var(--success);">${escapeHtml(msg)}</div>
      </div>`;
    }

    function acoStats() {
      const c = acoData.campaigns;
      const enabled = c.filter(x => x.state === 'ENABLED');
      const budgeted = enabled.filter(x => typeof x.dailyBudget === 'number');
      const total = budgeted.reduce((s, x) => s + x.dailyBudget, 0);
      return `
        <div class="stats-bar" style="margin-bottom: 1.5rem;">
          <div class="stat-item"><span class="stat-label">Campaigns</span><span class="stat-value">${c.length}</span></div>
          <div class="stat-item"><span class="stat-label">Portfolios</span><span class="stat-value">${acoData.portfolios.length}</span></div>
          <div class="stat-item"><span class="stat-label">Enabled</span><span class="stat-value">${enabled.length}</span></div>
          <div class="stat-item"><span class="stat-label">Daily budget (enabled)</span><span class="stat-value">$${formatNumber(total)}</span></div>
        </div>`;
    }

    // Warns about WRONG KEYS, not absent values. A field that is legitimately
    // empty — an open-ended campaign has no end date, Sponsored Brands has no
    // targetingType — is not a failure, and reporting it as one buried the
    // single case this exists to catch. Coverage counts enabled campaigns only.
    function acoCoverageBanner() {
      const cov = acoCoverage();
      if (!cov) return '';
      const wrong = Object.entries(cov.fields).filter(([, v]) => v.looksWrong);
      if (!wrong.length) return '';

      return `
        <div class="card" style="margin-bottom: 1.5rem; border-left: 3px solid var(--error);">
          <div style="font-weight: 600; color: var(--error); margin-bottom: 0.5rem;">
            ${wrong.length} field${wrong.length === 1 ? ' looks' : 's look'} like the wrong key
          </div>
          <div style="color: var(--text-secondary); font-size: 0.8125rem; margin-bottom: 0.75rem;">
            These are missing on campaigns that should have them, or resolving through more than one
            key — which means the shape varies and at least one guess is wrong. Run the raw probe to
            see the real field names.
          </div>
          <div style="font-family: monospace; font-size: 0.75rem; line-height: 1.7;">
            ${wrong.map(([f, v]) => {
              return `<div>${escapeHtml(f)}: ${v.resolved} of ${v.applicable}${v.appliesTo ? ` ${escapeHtml(v.appliesTo)}` : ''} enabled — ${acoViaKeyText(v)}</div>`;
            }).join('')}
          </div>
        </div>`;
    }

    // Grouped by ad product, because "SP via one key, SB via another" is an
    // explanation whereas a bare merged list reads as ambiguity.
    function acoViaKeyText(v) {
      const byProduct = v.viaKeyByProduct || {};
      const products = Object.keys(byProduct);
      if (!products.length) return 'no key resolved';
      return products.map(p => {
        const keys = Object.entries(byProduct[p]).map(([k, n]) => `${k}×${n}`).join(', ');
        return products.length > 1 ? `${p} via ${keys}` : `via ${keys}`;
      }).join(' · ');
    }

    function acoCoverage() {
      const cov = acoData.meta && acoData.meta.coverage && acoData.meta.coverage.campaigns;
      // Snapshots written before coverage gained its rules have the old flat
      // shape; skip rather than render nonsense until the next refresh.
      return cov && cov.fields ? cov : null;
    }

    // Absences that are facts about the account rather than mapping errors.
    // Worth knowing, not worth a warning.
    function acoCoverageNotes() {
      const cov = acoCoverage();
      if (!cov) return '';
      const notes = Object.entries(cov.fields)
        .filter(([, v]) => v.informational && v.applicable && v.resolved < v.applicable)
        .map(([f, v]) => `${v.applicable - v.resolved} of ${v.applicable} without ${escapeHtml(f === 'portfolioId' ? 'a portfolio' : f)}`);
      if (!notes.length) return '';
      return `<div style="color: var(--text-secondary); font-size: 0.8125rem; margin: -0.75rem 0 1.25rem 0;">
        Across ${cov.scope.counted} enabled campaigns: ${notes.join(' · ')}.
      </div>`;
    }

    // The full picture, for when you want it rather than in your face.
    function acoCoverageDetails() {
      const cov = acoCoverage();
      if (!cov) return '';
      const rows = Object.entries(cov.fields).map(([f, v]) => {
        const note = v.optional ? 'optional' : v.informational ? 'informational'
                   : v.appliesTo ? `${v.appliesTo} only` : '';
        const via = acoViaKeyText(v);
        const colour = v.looksWrong ? 'var(--error)'
                     : v.resolved === v.applicable ? 'var(--success)' : 'var(--text-secondary)';
        return `<tr>
          <td>${escapeHtml(f)}</td>
          <td style="color: ${colour};">${v.resolved} of ${v.applicable}</td>
          <td style="color: var(--text-secondary);">${escapeHtml(note)}</td>
          <td style="font-family: monospace; font-size: 0.7rem; color: var(--text-secondary);">${escapeHtml(via)}</td>
        </tr>`;
      }).join('');
      return `
        <div class="card card-flat" style="margin-top: 1.5rem;">
          <details>
            <summary style="cursor: pointer; font-weight: 600;">Field coverage (${cov.scope.counted} enabled of ${cov.scope.of})</summary>
            <div style="margin-top: 1rem; overflow-x: auto;">
              <table><thead><tr><th>Field</th><th>Resolved</th><th></th><th>Read from</th></tr></thead>
              <tbody>${rows}</tbody></table>
            </div>
          </details>
        </div>`;
    }

    function acoToolbar() {
      const filters = ACO_COLUMNS.filter(c => c.filter).map(col => {
        const values = [...new Set(acoData.campaigns.map(c => c[col.field]).filter(v => v !== null && v !== ''))].sort();
        return `
          <select class="catalog-filter-select" data-aco-filter="${col.field}">
            <option value="">${escapeHtml(col.label)}: all</option>
            ${values.map(v => `<option value="${escapeHtml(v)}"${acoFilters[col.field] === v ? ' selected' : ''}>${escapeHtml(acoLabel(col.field, v))}</option>`).join('')}
          </select>`;
      }).join('');

      return `
        <div class="catalog-toolbar" style="flex-wrap: wrap; gap: 0.75rem;">
          <div class="aco-filter-row">
            <input type="search" id="aco-search" placeholder="Search campaigns…" value="${escapeHtml(acoSearch)}">
            ${filters}
            <label class="catalog-active-toggle">
              <input type="checkbox" id="aco-only-enabled"${acoOnlyEnabled ? ' checked' : ''}> Only enabled
            </label>
          </div>
          <div class="aco-toolbar-actions">
            <button class="btn btn-secondary" id="aco-toggle-all" type="button">Collapse all</button>
            <button class="btn btn-secondary" id="aco-export" type="button">Export CSV</button>
          </div>
        </div>`;
    }

    function acoFiltered() {
      const q = acoSearch.trim().toLowerCase();
      return acoData.campaigns.filter(c => {
        // An open editor outranks every filter. Otherwise typing in the search
        // box makes an in-progress edit vanish along with its unsaved draft.
        if (acoEditingId && c.campaignId === acoEditingId) return true;
        if (acoOnlyEnabled && c.state !== 'ENABLED') return false;
        for (const [field, val] of Object.entries(acoFilters)) {
          if (val && c[field] !== val) return false;
        }
        if (q && !String(c.name || '').toLowerCase().includes(q)) return false;
        return true;
      });
    }

    function acoRenderTable() {
      const wrap = document.getElementById('aco-table-wrap');
      if (!wrap) return;

      const pfById = new Map(acoData.portfolios.map(p => [p.portfolioId, p]));
      const groups = new Map();
      for (const c of acoFiltered()) {
        const key = c.portfolioId || '(none)';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(c);
      }
      // Unfiltered, so the portfolio summary stays a fact about the portfolio
      // rather than a restatement of the filter.
      const allByPf = new Map();
      for (const c of acoData.campaigns) {
        const key = c.portfolioId || '(none)';
        if (!allByPf.has(key)) allByPf.set(key, []);
        allByPf.get(key).push(c);
      }

      if (!groups.size) {
        wrap.innerHTML = '<div style="padding: 3rem; text-align: center; color: var(--text-secondary);">No campaigns match these filters.</div>';
        return;
      }

      const ordered = [...groups.entries()].sort((a, b) => {
        const an = pfById.get(a[0])?.name || '(no portfolio)';
        const bn = pfById.get(b[0])?.name || '(no portfolio)';
        return an.localeCompare(bn);
      });

      const head = `<thead><tr>${ACO_VISIBLE.map(c =>
        `<th style="text-align: ${c.align === 'right' ? 'right' : 'left'};">${escapeHtml(c.label)}</th>`).join('')}</tr></thead>`;

      const body = ordered.map(([pfId, rows]) => {
        const pf = pfById.get(pfId);
        const collapsed = acoCollapsed.has(pfId);
        return `<tbody class="aco-group">
          ${acoPortfolioRow(pfId, pf, allByPf.get(pfId) || rows, rows.length, collapsed)}
          ${rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))
                .map(c => acoCampaignRow(c, pfId, collapsed)).join('')}
        </tbody>`;
      }).join('');

      wrap.innerHTML = `<div class="aco-table-wrapper"><table class="aco-table">${head}${body}</table></div>`;

      // Sticky group rows pin below the real thead, whose height is only known
      // after layout.
      requestAnimationFrame(() => {
        const table = wrap.querySelector('.aco-table');
        const thead = table && table.querySelector('thead');
        if (table && thead) table.style.setProperty('--aco-thead-height', `${thead.offsetHeight}px`);
      });
    }

    function acoPortfolioRow(pfId, pf, allRows, shownCount, collapsed) {
      const rows = allRows;
      const enabled = rows.filter(r => r.state === 'ENABLED');
      const total = enabled.reduce((s, r) => s + (typeof r.dailyBudget === 'number' ? r.dailyBudget : 0), 0);
      const name = pf ? pf.name : '(no portfolio)';

      // Portfolio budgets are PERIOD TOTALS with a policy, not daily caps.
      // Shown with the policy spelled out and never divided against the daily
      // sum beside it — they are different units, and "$500 cap vs $60/day"
      // reads as over-provisioned when it means the portfolio starves in 8 days.
      const cap = pf && typeof pf.budgetAmount === 'number'
        ? `<span title="Portfolio budget is a period total, not a daily cap">cap $${formatNumber(pf.budgetAmount)}${pf.budgetPolicy ? ` / ${escapeHtml(String(pf.budgetPolicy).toLowerCase().replace(/_/g, ' '))}` : ''}</span>`
        : '<span style="color: var(--text-secondary);">no cap</span>';

      return `
        <tr class="aco-portfolio-row${collapsed ? '' : ' expanded'}" data-aco-pf="${escapeHtml(pfId)}">
          <td><span class="expand-icon">▶</span><strong>${escapeHtml(name)}</strong></td>
          <td>${acoTypeChips(rows)}</td>
          <td></td>
          <td style="color: var(--text-secondary);">${enabled.length} of ${rows.length} on${
            shownCount < rows.length ? ` <span style="opacity: 0.6;">(${shownCount} shown)</span>` : ''
          }</td>
          <td style="color: var(--text-secondary);">${escapeHtml(rows[0]?.brand || '—')}</td>
          <td style="text-align: right; font-family: monospace;">$${formatNumber(total)}</td>
          <td colspan="${ACO_VISIBLE.length - 6}" style="color: var(--text-secondary); font-size: 0.75rem;">${cap}</td>
        </tr>`;
    }

    // Labelled "campaign types in this portfolio" deliberately — 42 portfolios
    // against 43 SKUs means this is not SKU coverage, and reading it that way
    // would miss exactly the SKU that has no portfolio.
    function acoTypeChips(rows) {
      const present = new Set(rows.filter(r => r.state !== 'ARCHIVED').map(r => r.campaignType));
      const live = new Set(rows.filter(r => r.state === 'ENABLED').map(r => r.campaignType));
      return ['Auto', 'Broad', 'Exact', 'ASIN'].map(t => {
        const exists = present.has(t);
        const running = live.has(t);
        const title = running ? `${t}: running`
                    : exists ? `${t}: exists but not enabled`
                    : `${t}: no campaign of this type in this portfolio`;
        // Three states, because "paused" and "absent" are different findings —
        // one is a campaign to switch on, the other is a gap to fill.
        const color = running ? 'var(--success)' : exists ? 'var(--warning)' : 'var(--text-secondary)';
        return `<span title="${escapeHtml(title)}" style="display: inline-block; margin-right: 0.35rem; font-size: 0.7rem; color: ${color}; opacity: ${exists ? 1 : 0.4};">${t}</span>`;
      }).join('');
    }

    function acoCampaignRow(c, pfId, collapsed) {
      const editing = c.campaignId === acoEditingId;
      const editIcon = editing
        ? acoRowActions(c)
        : `<span class="aco-edit-affordance" data-aco-edit="${escapeHtml(c.campaignId)}" title="Edit this campaign">&#9998;</span>`;
      const cells = ACO_VISIBLE.map(col => {
        // An editable column swaps its display value for a control in place.
        if (editing && col.editable) {
          return `<td class="aco-cell-editing">${acoEditCell(col, c)}</td>`;
        }
        const align = col.align === 'right' ? 'text-align: right;' : '';
        const mono = col.mono ? "font-family: 'Roboto Mono', monospace;" : '';
        let value;
        if (col.format === 'placements') {
          const text = acoPlacementsText(c.placements);
          if (text === null) {
            value = '<span style="color: var(--warning);" title="Amazon did not return placement modifiers for this campaign">unknown</span>';
          } else if (text === '') {
            value = '<span style="color: var(--text-secondary);">—</span>';
          } else {
            const full = (c.placements || [])
              .map(p => `${acoLabel('placement', p.placement)}: ${p.percentage}%`).join(', ');
            value = `<span title="${escapeHtml(full)}">${escapeHtml(text)}</span>`;
          }
        } else if (col.format === 'money') {
          value = typeof c[col.field] === 'number'
            ? '$' + formatNumber(c[col.field])
            : '<span style="color: var(--warning);">unknown</span>';
        } else if (col.field === 'state') {
          value = acoStateCell(c.state);
        } else if (col.field === 'campaignType') {
          value = c.typeSource === 'conflict'
            ? `<span style="color: var(--warning);" title="Campaign name and Amazon's targetingType disagree">${escapeHtml(c.campaignType || '—')} ⚠</span>`
            : escapeHtml(c.campaignType || '—');
        } else if (col.field === 'brand') {
          const label = c.brand
            ? escapeHtml(c.brand)
            : '<span style="color: var(--warning);">unmapped</span>';
          value = c.brandSource === 'override'
            ? `${label} <span title="Set in the dashboard, not derived from the campaign name" style="color: var(--text-secondary); font-size: 0.7rem;">·set</span>`
            : label;
        } else if (ACO_LABELS[col.field]) {
          // Raw enum kept on hover — the label is for reading, the enum is what
          // Amazon actually returned.
          value = `<span title="${escapeHtml(c[col.field] || '')}">${escapeHtml(acoLabel(col.field, c[col.field]) || '—')}</span>`;
        } else {
          value = escapeHtml(c[col.field] === null || c[col.field] === undefined ? '—' : c[col.field]);
        }
        if (col.field === 'name') {
          value += editIcon;
          // The failure message belongs next to the row that failed, not in a
          // banner somewhere else on the page.
          if (editing && acoEditError) {
            value += `<div class="aco-row-error">${escapeHtml(acoEditError)}</div>`;
          }
        }
        return `<td style="${align} ${mono}">${value}</td>`;
      }).join('');

      const archived = c.presumedArchived ? ' title="Absent from recent syncs — presumed archived"' : '';
      // A collapsed group must not hide the row being edited.
      const hidden = collapsed && !editing;
      return `<tr class="aco-campaign-row${editing ? ' aco-row-editing' : ''}" data-aco-pf="${escapeHtml(pfId)}" data-aco-id="${escapeHtml(c.campaignId)}"${archived}
                  style="display: ${hidden ? 'none' : 'table-row'};${c.presumedArchived ? ' opacity: 0.5;' : ''}">${cells}</tr>`;
    }

    // ── EDITOR ───────────────────────────────────────────────────────────────
    // Editing happens IN the row: the editable cells become controls in place
    // and the ✎ is replaced by Save / Cancel, following the in-place pattern in
    // js/credentials.js rather than opening a panel underneath.

    // Renders the control for one editable cell, valued from the draft so an
    // unrelated re-render (search keystroke, filter change) restores what was
    // chosen rather than discarding it.
    function acoEditCell(col, c) {
      const draft = acoEditDraft || {};
      if (col.editable === 'brand') {
        const selected = draft.brand === null || draft.brand === undefined ? '' : draft.brand;
        const opts = acoBrandOptions();
        return `<select class="aco-cell-input" data-aco-input="brand"
                        title="Stored in the dashboard only — Amazon has no brand field">
          <option value=""${selected === '' ? ' selected' : ''}>${c.brandFromPrefix ? escapeHtml(c.brandFromPrefix) + ' (from name)' : 'unmapped'}</option>
          ${opts.map(b => `<option value="${escapeHtml(b)}"${selected === b ? ' selected' : ''}>${escapeHtml(b)}</option>`).join('')}
        </select>`;
      }
      return '';
    }

    // Save / Cancel take the ✎'s place, so no extra column is needed.
    function acoRowActions(c) {
      const dirty = acoEditDiffs(c).length > 0;
      if (acoEditBusy) {
        return `<span class="aco-row-actions"><span class="loading"></span></span>`;
      }
      return `<span class="aco-row-actions">
        <button class="aco-row-btn aco-row-save" data-aco-action="save"${dirty ? '' : ' disabled'}
                title="${dirty ? 'Save changes' : 'Nothing changed yet'}">&#10003;</button>
        <button class="aco-row-btn" data-aco-action="cancel" title="Cancel">&#10005;</button>
      </span>`;
    }

    function acoBrandOptions() {
      // Server-supplied, so the options always match what the update action
      // accepts. Falling back to the loaded data would silently offer fewer
      // brands whenever a filter or a sparse account hid one.
      if (Array.isArray(acoData.knownBrands) && acoData.knownBrands.length) return acoData.knownBrands;
      return [...new Set(acoData.campaigns.map(c => c.brandFromPrefix).filter(Boolean))].sort();
    }

    function acoEditDiffs(c) {
      const draft = acoEditDraft || {};
      const out = [];
      if ('brand' in draft) {
        const wanted = draft.brand === '' ? null : draft.brand;
        const effective = wanted === null ? (c.brandFromPrefix || null) : wanted;
        if ((effective || null) !== (c.brand || null)) {
          out.push({ field: 'brand', label: 'Brand', scope: 'local', from: c.brand, to: effective });
        }
      }
      return out;
    }

    function acoStartEdit(campaignId) {
      const c = acoData.campaigns.find(x => x.campaignId === campaignId);
      if (!c) return;
      acoEditingId = campaignId;
      acoEditError = null;
      acoEditDraft = { brand: c.brandSource === 'override' ? c.brand : '' };
      acoCollapsed.delete(c.portfolioId || '(none)');
      acoRenderTable();
    }

    function acoCancelEdit() {
      acoEditingId = null;
      acoEditDraft = null;
      acoEditError = null;
      acoRenderTable();
    }

    async function acoSaveEdit() {
      if (acoEditBusy || !accessToken) return;
      const c = acoData.campaigns.find(x => x.campaignId === acoEditingId);
      if (!c) return;
      const diffs = acoEditDiffs(c);
      if (!diffs.length) return;

      acoEditBusy = true;
      acoEditError = null;
      acoRenderTable();

      try {
        const brandDiff = diffs.find(d => d.field === 'brand');
        const res = await fetch('/api/adcampaigns?action=update', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({
            campaignId: c.campaignId,
            adProduct: c.adProduct,
            local: brandDiff ? { brand: brandDiff.to } : {},
            amazon: {}
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || `Save failed (${res.status})`);

        acoFlash = `${c.name}: ${diffs.map(d => `${d.label} ${d.from ?? '—'} → ${d.to ?? '—'}`).join(', ')}`;
        acoEditingId = null;
        acoEditDraft = null;
        // No optimistic update — the row's new values come back from the server.
        loadAdCampaigns();
      } catch (err) {
        console.error('[ACO] save failed:', err);
        acoEditError = err.message;
      } finally {
        // Clear busy BEFORE re-rendering, or a failed save leaves Save disabled
        // for good and the only way to retry is to cancel and start again.
        acoEditBusy = false;
        if (acoEditingId) acoRenderTable();
      }
    }

    function acoStateCell(state) {
      const color = state === 'ENABLED' ? 'var(--success)'
                  : state === 'PAUSED' ? 'var(--warning)'
                  : 'var(--text-secondary)';
      return `<span style="color: ${color};" title="${escapeHtml(state || '')}">${escapeHtml(acoLabel('state', state) || '—')}</span>`;
    }

    function acoChangesCard() {
      const rows = (acoData.changes || []).slice().reverse();
      if (!rows.length) return '';
      return `
        <div class="card card-flat" style="margin-top: 1.5rem;">
          <details>
            <summary style="cursor: pointer; font-weight: 600;">Recent settings changes (${rows.length})</summary>
            <div style="margin-top: 1rem; overflow-x: auto;">
              <table>
                <thead><tr><th>When</th><th>Campaign</th><th>Field</th><th>From</th><th>To</th></tr></thead>
                <tbody>${rows.slice(0, 50).map(r => `
                  <tr>
                    <td>${escapeHtml(r.ptDate || '')}</td>
                    <td>${escapeHtml(r.name || r.campaignId)}</td>
                    <td>${escapeHtml(r.field)}</td>
                    <td>${escapeHtml(r.from === null || r.from === undefined ? '—' : r.from)}</td>
                    <td>${escapeHtml(r.to === null || r.to === undefined ? '—' : r.to)}</td>
                  </tr>`).join('')}
                </tbody>
              </table>
            </div>
          </details>
        </div>`;
    }

    // ─── CONTROLS ────────────────────────────────────────────────────────────

    function acoBindControls() {
      const search = document.getElementById('aco-search');
      if (search) search.addEventListener('input', e => { acoSearch = e.target.value; acoRenderTable(); });

      document.querySelectorAll('[data-aco-filter]').forEach(sel => {
        sel.addEventListener('change', e => {
          acoFilters[e.target.dataset.acoFilter] = e.target.value;
          acoRenderTable();
        });
      });

      const only = document.getElementById('aco-only-enabled');
      if (only) only.addEventListener('change', e => { acoOnlyEnabled = e.target.checked; acoRenderTable(); });

      const exp = document.getElementById('aco-export');
      if (exp) exp.addEventListener('click', acoExportCSV);

      const toggleAll = document.getElementById('aco-toggle-all');
      if (toggleAll) toggleAll.addEventListener('click', () => {
        const anyOpen = acoCollapsed.size < acoData.portfolios.length;
        acoCollapsed = anyOpen ? new Set(acoData.portfolios.map(p => p.portfolioId).concat('(none)')) : new Set();
        toggleAll.textContent = anyOpen ? 'Expand all' : 'Collapse all';
        acoRenderTable();
      });

      // Delegated so it survives every re-render of the table.
      const wrap = document.getElementById('aco-table-wrap');
      if (wrap) wrap.addEventListener('input', e => {
        const key = e.target && e.target.dataset && e.target.dataset.acoInput;
        // Draft-backed, so a re-render triggered by anything else does not
        // discard what was typed.
        if (key && acoEditDraft) acoEditDraft[key] = e.target.value;
      });
      if (wrap) wrap.addEventListener('change', e => {
        const key = e.target && e.target.dataset && e.target.dataset.acoInput;
        if (!key || !acoEditDraft) return;
        acoEditDraft[key] = e.target.value;
        acoRenderTable();   // re-evaluates whether Save should be enabled
      });

      if (wrap) wrap.addEventListener('click', e => {
        const editBtn = e.target.closest('[data-aco-edit]');
        if (editBtn) { acoStartEdit(editBtn.dataset.acoEdit); return; }

        const action = e.target.closest('[data-aco-action]');
        if (action) {
          const what = action.dataset.acoAction;
          if (what === 'cancel') acoCancelEdit();
          else if (what === 'save') acoSaveEdit();
          return;
        }

        const row = e.target.closest('.aco-portfolio-row');
        if (!row) return;
        const pfId = row.dataset.acoPf;
        if (acoCollapsed.has(pfId)) acoCollapsed.delete(pfId);
        else acoCollapsed.add(pfId);
        acoRenderTable();
      });
    }

    function acoExportCSV() {
      const pfById = new Map(acoData.portfolios.map(p => [p.portfolioId, p]));
      const fields = ACO_COLUMNS.map(c => c.field);
      const rows = acoFiltered().map(c => {
        const enriched = { ...c, portfolio: pfById.get(c.portfolioId)?.name || '' };
        return fields.map(f => {
          const v = enriched[f];
          if (v === null || v === undefined) return csvEscape('');
          if (f === 'placements') return csvEscape(acoPlacementsText(v) ?? 'unknown');
          return csvEscape(ACO_LABELS[f] ? acoLabel(f, v) : v);
        }).join(',');
      });
      const csv = [ACO_COLUMNS.map(c => csvEscape(c.label)).join(','), ...rows].join('\r\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ad-campaigns-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    function acoShowDiagnostic(title, payload) {
      const el = document.getElementById('aco-diagnostic');
      if (!el) return;
      el.innerHTML = `
        <div class="card card-flat" style="margin-top: 1.5rem; border-left: 3px solid var(--accent-orange);">
          <details open>
            <summary style="cursor: pointer; font-weight: 600;">${escapeHtml(title)}</summary>
            <pre style="margin-top: 1rem; max-height: 26rem; overflow: auto; font-size: 0.7rem; white-space: pre-wrap; word-break: break-word; color: var(--text-secondary);">${escapeHtml(JSON.stringify(payload, null, 2))}</pre>
          </details>
        </div>`;
    }

    function acoSetBlurb(text) {
      const el = document.getElementById('adcampaigns-blurb');
      if (el) el.textContent = text;
    }

    function acoSetBusy(busy, label) {
      ['aco-refresh-btn', 'aco-dry-btn', 'aco-probe-btn'].forEach(id => {
        const b = document.getElementById(id);
        if (b) b.disabled = !!busy;
      });
      const main = document.getElementById('aco-refresh-btn');
      if (main) main.textContent = busy ? (label || 'Working…') : 'Refresh from Amazon';
    }
