    // ─── AD GLOSSARY ─────────────────────────────────────────────────────────
    // The definitions behind the small "i" icons on the Ad Admin pages. One
    // entry per term, shared by every page, so ACoS is defined once and means
    // the same thing wherever it is hovered.
    //
    // Thresholds are written into the text rather than passed in, because a
    // definition has to read on its own. tests/glossary.test.mjs holds each
    // number here against the server config it describes, so a changed rule
    // fails a test instead of leaving the definition quietly wrong.
    //
    // Everything is prefixed `adg`, apart from adTip, which the pages call.
    // These files share one global scope, so escapeHtml is CALLED, never
    // redefined.

    const AD_TERMS = {
      // ── Shared ─────────────────────────────────────────────────────────────
      acos: 'Advertising cost of sales: ad spend ÷ the sales those ads were credited with. ' +
            '25% means $0.25 of spend for every $1 of ad sales. Lower is better.',
      roas: 'Return on ad spend: ad sales ÷ ad spend, the inverse of ACoS. ' +
            '4.00 means $4 of sales for every $1 of spend. Higher is better.',
      retention: 'Profit retention: the share of gross margin left after ad spend, ' +
                 '(gross margin − ACoS) ÷ gross margin. 100% would mean the ads cost nothing, ' +
                 '0% is break-even, and below 0% every ad sale loses money.',
      cpc: 'Cost per click: spend ÷ clicks.',
      ctr: 'Click-through rate: clicks ÷ impressions. How often a shopper who sees the ad clicks it.',
      cvr: 'Conversion rate: orders ÷ clicks. How often a click becomes an order.',

      // ── Campaign Overview ──────────────────────────────────────────────────
      'aco.type': 'Read from the suffix in the campaign name, such as (Exact) or (ASIN). ' +
                  'A name without one shows Auto or Manual, from the targeting set in Amazon.',
      'aco.ad': 'SP is Sponsored Products. SB is Sponsored Brands.',
      'aco.brand': 'Worked out from the prefix of the campaign name, unless it has been set by hand here.',
      'aco.dailyBudget': 'What Amazon aims to spend per day. It can spend more than this on a single ' +
                         'day, but not more than the budget × the days in the calendar month.',
      'aco.bidding': 'Fixed bids: Amazon bids exactly what is set. ' +
                     'Dynamic down only: Amazon lowers the bid when a click looks less likely to sell. ' +
                     'Dynamic up and down: it also raises it when a click looks more likely to sell, ' +
                     'by up to 100% at top of search and 50% elsewhere.',
      'aco.placements': 'Bid increases by where the ad appears. TOS is top of search, the first row ' +
                        'of results. ROS is rest of search. PP is product pages. TOS 50% bids 1.5× ' +
                        'the normal bid at top of search.',

      // ── Weekly Trends ──────────────────────────────────────────────────────
      'wk.week': 'Weeks run Monday to Sunday. A week appears only once Amazon has finished ' +
                 'crediting sales to its last day, 7 days after it ends.',
      'wk.sales': 'Sales Amazon credits to an ad: a purchase within 7 days of a click on it, ' +
                  'counted on the day of the click rather than the day of the purchase.',
      'wk.orders': 'Orders Amazon credits to an ad: a purchase within 7 days of a click on it, ' +
                   'counted on the day of the click.',
      'wk.trend': 'A degree-4 polynomial curve fitted through the weekly points, the same ' +
                  'trendline the spreadsheet used. It shows the direction of the series without ' +
                  'following every single week. It needs at least 6 weeks to draw.',

      // ── Weekly Red Flags ───────────────────────────────────────────────────
      'rf.spend7': 'Spend over the week being checked, Monday to Sunday.',
      'rf.atCap': 'Days this week that spend reached 95% of the daily budget. Days over the ' +
                  'budget count too. 4 or more days, with retention of 50% or better, flags it.',
      'rf.acos28': 'ACoS over the 28 days before this week. Those days are old enough that ' +
                   'Amazon has finished crediting their sales.',
      'rf.retention28': 'Profit retention over the 28 days before this week, whose sales are complete.',
      'rf.raiseTo': 'The suggested daily budget: 25% more at 4 days at cap, rising to 50% more at ' +
                    '7, and never below the most it spent in a single day. Applying writes to Amazon.',
      'rf.campaigns': 'Campaigns in this portfolio that were checked this week.',
      'rf.typicalSpend': 'Spend over the 28 days before this week, divided by 4.',
      'rf.impressions28': 'Impressions across the portfolio\'s campaigns in the 28 days before this week.',
      'rf.impressions7': 'Impressions across the portfolio\'s campaigns this week.',
      'rf.typicalCtr': 'Click-through rate over the 28 days before this week.',
      'rf.typicalCpc': 'Cost per click over the 28 days before this week.',
      'rf.change': 'This week against the typical figure from the 28 days before it, as a percentage.',
      'rf.bid': 'The campaign\'s default bid in Amazon now.',
      'rf.lowerTo': 'The suggested default bid: 10% lower at 1.5× the typical CPC, rising to 25% ' +
                    'lower at 3×. Applying writes to Amazon.',
      'rf.trailingAvg': 'The brand\'s spend over the 28 days before this week, divided by 4.',

      // ── Bi-Weekly Budgets ──────────────────────────────────────────────────
      'bw.window': 'The 14 days being judged end 8 days before today, so Amazon has finished ' +
                   'crediting their sales. The prior 14 days are used to tell a bad fortnight ' +
                   'from a bad month.',
      'bw.posture': 'Set on Monthly Review. Scale makes each raise one step larger. Constrain ' +
                    'gives no raises and makes each decrease one step deeper. Hold Steady, ' +
                    'shown as —, uses the normal rules.',
      'bw.atCap': 'Days out of the 14 that spend reached 95% of the daily budget. A raise needs 8 or more.',
      // Line breaks show: the bubble keeps them.
      'bw.action': 'Checked in this order, and the first that fits decides.\n' +
                   'Hold: under $10 of spend and under 3 orders.\n' +
                   'Cut: below break-even on over $20 of spend, or no orders on over $15. ' +
                   '−40%, or −70% when the prior 14 days had the same problem.\n' +
                   'Increase: at cap on 8 or more days. +15% at 25% retention, +30% at 50%, ' +
                   '+50% at 75%. At cap but under 25% holds.\n' +
                   'Decrease: retention under 10% (−40%), under 25% (−25%), or under 50% and ' +
                   'down more than 5 points on the prior 14 days (−15%).\n' +
                   'Hold: anything else.\n' +
                   'Adjusted: the budget was changed after these 14 days ended, by either ' +
                   'cadence or in Amazon itself. Every day judged here is from before that ' +
                   'change, so the row is locked until the window catches up. This is why the ' +
                   'run can be made weekly without cutting the same campaign two weeks running.',
      'bw.budget': 'The campaign\'s daily budget in Amazon now.',
      'bw.new': 'The recommended daily budget. Never below $1.',

      // ── Monthly Review ─────────────────────────────────────────────────────
      'mo.adSales': 'Sales credited to the brand\'s Sponsored Products ads for the month.',
      'mo.vsTarget': 'ACoS minus the brand\'s target ACoS, in points. Negative is under target. ' +
                     'The target is set per brand, or per product line where a brand has more than one, ' +
                     'weighted by each one\'s ad sales.',
      'mo.retention': 'Profit retention for the month: gross profit on the ad sales, minus ad ' +
                      'spend, ÷ that gross profit. 0% is break-even.',
      'mo.vsLastMonth': 'This month\'s retention minus last month\'s, in points. A fall of 10 ' +
                        'points or more, with retention under 50%, recommends Constrain.',
      'mo.share': 'The brand\'s share of all Sponsored Products spend on this page / its share ' +
                  'of the ad sales. Spend share more than 10 points above sales share, with ' +
                  'retention under 50%, recommends Constrain.',
      'mo.adShare': 'Ad sales, Sponsored Products and Sponsored Brands together, ÷ all of the ' +
                    'brand\'s sales for the month. At 70% or more the brand is flagged as ' +
                    'carried by ads, with little organic sales under it.',
      'mo.recommended': 'What the rules recommend from this month\'s numbers. The reason is ' +
                        'written under the brand name.',
      'mo.posture': 'The posture the bi-weekly uses for this brand now. Change it, then press ' +
                    'Confirm to save.',
      'mo.sbBudget': 'The campaign\'s daily budget in Amazon now.',
      'mo.sbSales': 'Sponsored Brands credits a purchase to an ad for 14 days after the click, ' +
                    'twice as long as Sponsored Products.',
      'mo.sbDaysAtCap': 'Days in the month that spend reached 95% of the current daily budget. ' +
                        'A raise needs 4 of every 7 days: 18 in a 30- or 31-day month.',
      'mo.ntb': 'New to brand: the share of orders from shoppers who had not bought from the ' +
                'brand in the past 12 months.',
      'mo.sbRecommended': 'Lower: retention under 25% (−25%), or under 10% (−40%). Raise: ' +
                          'retention 50% or better and at cap on 4 of every 7 days. Hold: ' +
                          'anything else, or a budget already changed since the month ended.'
    };

    // The icon, placed straight after a label. The key goes in the markup and
    // the text is looked up on hover, so a table header stays short. An unknown
    // key renders nothing rather than an icon with no definition behind it.
    //
    // The icon is a box of its own, and a browser will break a line before a
    // box, so a narrow column would drop it under its label. The word joiner
    // (&#8288;, invisible) removes that break. The header's own words still
    // wrap; the icon just travels with the last one.
    function adTip(key) {
      const text = AD_TERMS[key];
      if (!text) {
        console.warn('[ADG] no definition for', key);
        return '';
      }
      return `&#8288;<span class="adg-tip" tabindex="0" role="button" data-adg="${escapeHtml(key)}"` +
             ` aria-label="${escapeHtml(text)}">i</span>`;
    }

    // ── THE TOOLTIP ──────────────────────────────────────────────────────────
    // One element for the whole app, fixed to the viewport and attached to
    // <body>. Inside a table it would be clipped by the scrolling wrapper and
    // wiped every time the page re-renders. Listeners are delegated from the
    // document for the same reason: the icons are replaced constantly.

    let adgEl = null;
    let adgFor = null;

    function adgShow(icon) {
      const text = AD_TERMS[icon.dataset.adg];
      if (!text) return;
      if (!adgEl) {
        adgEl = document.createElement('div');
        adgEl.className = 'adg-bubble';
        adgEl.setAttribute('role', 'tooltip');
        document.body.appendChild(adgEl);
      }
      adgFor = icon;
      adgEl.textContent = text;
      adgEl.style.visibility = 'hidden';
      adgEl.style.display = 'block';

      // Below the icon, centred on it, kept inside the window; above it when
      // there is no room below.
      const gap = 8, edge = 8;
      const a = icon.getBoundingClientRect();
      const b = adgEl.getBoundingClientRect();
      let left = a.left + a.width / 2 - b.width / 2;
      left = Math.max(edge, Math.min(left, window.innerWidth - b.width - edge));
      let top = a.bottom + gap;
      if (top + b.height > window.innerHeight - edge) top = Math.max(edge, a.top - gap - b.height);
      adgEl.style.left = `${Math.round(left)}px`;
      adgEl.style.top = `${Math.round(top)}px`;
      adgEl.style.visibility = 'visible';
    }

    function adgHide() {
      if (adgEl) adgEl.style.display = 'none';
      adgFor = null;
    }

    document.addEventListener('mouseover', (e) => {
      const icon = e.target.closest && e.target.closest('.adg-tip');
      if (icon && icon !== adgFor) adgShow(icon);
      // A page that re-renders under an open bubble removes its icon, and a
      // removed icon never fires mouseout.
      else if (!icon && adgFor && !adgFor.isConnected) adgHide();
    });
    document.addEventListener('mouseout', (e) => {
      const icon = e.target.closest && e.target.closest('.adg-tip');
      if (icon && !(e.relatedTarget && icon.contains(e.relatedTarget))) adgHide();
    });
    document.addEventListener('focusin', (e) => {
      const icon = e.target.closest && e.target.closest('.adg-tip');
      if (icon) adgShow(icon);
    });
    document.addEventListener('focusout', (e) => {
      if (e.target.closest && e.target.closest('.adg-tip')) adgHide();
    });

    // Capture phase, so a click on an icon never reaches what it sits inside: a
    // <summary> would fold, a <label> would open its dropdown. On a touch
    // screen, where there is no hover, the click is what shows the definition.
    document.addEventListener('click', (e) => {
      const icon = e.target.closest && e.target.closest('.adg-tip');
      if (!icon) {
        if (adgFor) adgHide();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      if (adgFor === icon && adgEl && adgEl.style.display !== 'none') adgHide();
      else adgShow(icon);
    }, true);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && adgFor) adgHide();
    });
    // The bubble is placed once, so anything that moves the icon hides it.
    window.addEventListener('scroll', () => { if (adgFor) adgHide(); }, true);
    window.addEventListener('resize', () => { if (adgFor) adgHide(); });
