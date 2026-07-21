// ============================================================
// Google Maps Scraper - Content Script V3
// Production-quality: two-pass, verified clicks, multi-language
// ============================================================

(() => {
  if (window.__mapsScraperV3) return;
  window.__mapsScraperV3 = true;

  // ── Config ──────────────────────────────────────────────────
  const CFG = {
    MAX_RETRIES:       15,
    RETRY_DELAY:       2000,
    CLICK_SETTLE:      4500,   // ms to wait after click for panel
    PANEL_POLL:        500,    // ms between panel-readiness checks
    PANEL_TIMEOUT:     10000,  // max ms to wait for panel
    SCROLL_PAUSE:      1200,
    BETWEEN_ITEMS:     1500,
    MAX_SCROLLS:       30,
    SCROLL_STABLE:     3,      // scrolls with no new items → done
  };

  // ── Language mappings (en + id) ─────────────────────────────
  const L = {
    phone:   ['phone','telepon','telp','nomor telepon','call','โทร'],
    address: ['address','alamat','lokasi','location'],
    website: ['website','situs','situs web','open website','laman'],
    hours:   ['hours','jam buka','open','buka','operational'],
    reviews: ['review','ulasan','reviews'],
    star:    ['star','bintang','rated'],
    price:   ['price','harga','price level'],
    delivery:['delivery','pengantaran'],
    takeout: ['takeout','ambil sendiri','take away'],
    dinein:  ['dine-in','makan di tempat'],
  };

  // ── State ───────────────────────────────────────────────────
  let running = false;

  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.action === 'startScraping' && !running) {
      running = true;
      reply({ status: 'started' });
      setTimeout(() => main(msg.query || ''), 1500);
    }
    return true;
  });

  // ============================================================
  //  MAIN ORCHESTRATOR
  // ============================================================
  async function main(query) {
    log('═══ START ═══  query="' + query + '"');

    // 1. Wait for the results feed
    const feed = await waitFeed();
    if (!feed) { fail('Feed tidak ditemukan. Pastikan Google Maps terbuka dengan benar.'); return; }

    // 2. Scroll feed to load ALL results
    overlay('Loading all results...');
    const allCards = await loadAllCards(feed);
    log('Total cards loaded: ' + allCards.length);
    if (allCards.length === 0) { fail('Tidak ada hasil ditemukan.'); return; }

    // 3. PASS 1 — collect basic data from every list card (no clicking)
    overlay('Pass 1: Reading list cards...');
    const basics = allCards.map((card, i) => ({
      idx: i,
      listData: extractCard(card),
    }));
    log('Pass 1 done — ' + basics.filter(b => b.listData.name).length + ' names found');

    // 4. PASS 2 — click each card, read the detail panel, merge
    overlay('Pass 2: Opening detail panels...');
    const results = [];
    let prevName = '';

    for (let i = 0; i < basics.length; i++) {
      const b = basics[i];
      const pct = `${i + 1}/${basics.length}`;
      overlay(`Scraping ${pct} — ${b.listData.name || '...'}`);

      try {
        // Scroll into view
        allCards[i].scrollIntoView({ block: 'center', behavior: 'instant' });
        await sleep(600);

        // Click with full event simulation
        const clicked = robustClick(allCards[i]);
        if (!clicked) {
          log(`  [${pct}] SKIP — no click target`);
          results.push(merge(b.listData, {}));
          continue;
        }

        // Wait for detail panel to actually change
        const detail = await waitForDetail(prevName);

        // Merge: detail panel wins, list card fills gaps
        const merged = merge(b.listData, detail);
        results.push(merged);
        prevName = merged.name;

        log(`  [${pct}] ✓ ${merged.name}  📞${merged.phone || '-'}  📧${merged.email || '-'}  🌐${merged.website ? 'yes' : '-'}`);

        // Close detail panel before next
        pressEscape();
        await sleep(CFG.BETWEEN_ITEMS);

      } catch (err) {
        log(`  [${pct}] ERROR: ${err.message}`);
        results.push(merge(b.listData, {}));
      }
    }

    // 5. Send results
    removeOverlay();
    log('═══ DONE ═══  ' + results.length + ' results');
    notify(results);
    running = false;
  }

  // ============================================================
  //  FEED & CARD LOADING
  // ============================================================
  async function waitFeed() {
    for (let i = 0; i < CFG.MAX_RETRIES; i++) {
      const f = document.querySelector('[role="feed"]');
      if (f) return f;
      log('Waiting for feed (' + (i + 1) + '/' + CFG.MAX_RETRIES + ')...');
      await sleep(CFG.RETRY_DELAY);
    }
    return null;
  }

  async function loadAllCards(feed) {
    const seen = new Set();
    let stable = 0;
    let prev = 0;

    for (let s = 0; s < CFG.MAX_SCROLLS; s++) {
      // Collect current cards
      queryCards(feed).forEach(c => seen.add(cardId(c)));

      feed.scrollTop = feed.scrollHeight;
      await sleep(CFG.SCROLL_PAUSE);

      const now = seen.size;
      if (now === prev) {
        stable++;
        if (stable >= CFG.SCROLL_STABLE) break;
      } else {
        stable = 0;
      }
      prev = now;
    }

    // Return actual DOM elements in order
    return queryCards(feed);
  }

  function queryCards(feed) {
    // Try progressively broader selectors
    const selectors = [
      ':scope > div > div > div[data-index]',
      ':scope > div > div[jsaction*="mouseover"]',
      ':scope > div > div > div[role="article"]',
      ':scope > div > div > a[href*="/maps/place"]',
    ];
    for (const sel of selectors) {
      const items = feed.querySelectorAll(sel);
      if (items.length > 0) return Array.from(items);
    }
    // Broadest: any div child that contains a link
    const all = feed.querySelectorAll(':scope > div > div > div');
    return Array.from(all).filter(el =>
      el.querySelector('a[href*="/maps/place"], a[data-item-id], [role="article"], [role="link"]')
    );
  }

  function cardId(card) {
    // Use a combination of text content and position for dedup
    const name = card.querySelector('[class*="fontHeadlineSmall"], [role="heading"]')?.textContent || '';
    const link = card.querySelector('a[href*="/maps/place"]')?.getAttribute('href') || '';
    return name + '|' + link.slice(0, 80);
  }

  // ============================================================
  //  PASS 1 — LIST CARD EXTRACTION
  // ============================================================
  function extractCard(card) {
    const d = { name:'', rating:'', reviews:'', category:'', address:'', phone:'', listUrl:'' };

    // Name
    d.name = txt(
      card.querySelector('[class*="fontHeadlineSmall"]'),
      card.querySelector('[role="heading"]'),
      card.querySelector('.qBF1Pd'),
      card.querySelector('.NrDZNb')
    );

    // Rating from aria-label on star image
    const starEl = card.querySelector('span[role="img"]');
    if (starEl) {
      const al = starEl.getAttribute('aria-label') || '';
      const m = al.match(/([\d.,]+)/);
      if (m) d.rating = m[1].replace(',', '.');
      // Reviews count: "4.5 (123)" pattern
      const r = al.match(/\(([\d.,]+)\)/);
      if (r) d.reviews = r[1].replace(/[.,]/g, '');
    }

    // Category — usually a span after the rating
    const spans = card.querySelectorAll('span');
    for (const sp of spans) {
      const t = sp.textContent?.trim() || '';
      if (t.length >= 4 && t.length < 80 && !/^\d/.test(t) && !t.includes('•')
          && !sp.closest('[role="heading"]') && !sp.closest('a[href*="/maps/place"]')
          && !sp.closest('span[role="img"]')) {
        d.category = t;
        break;
      }
    }

    // Address from list card (sometimes visible)
    const addrEl = card.querySelector('[class*="W4Efsd"]:last-child span:last-child');
    if (addrEl) {
      const t = addrEl.textContent?.trim() || '';
      if (t.length > 10 && !t.includes('·')) d.address = t;
    }

    // URL from the card's link
    const link = card.querySelector('a[href*="/maps/place"]');
    if (link) d.listUrl = link.getAttribute('href') || '';

    return d;
  }

  // ============================================================
  //  PASS 2 — CLICK & DETAIL PANEL
  // ============================================================
  function robustClick(item) {
    // Find the best clickable target
    const targets = [
      item.querySelector('a[href*="/maps/place"]'),
      item.querySelector('a[data-item-id]'),
      item.querySelector('[role="article"]'),
      item.querySelector('[role="link"]'),
      item.querySelector('button[data-item-id]'),
      item.querySelector('[jsaction*="mousedown"]'),
      item.querySelector('[tabindex="0"]'),
    ].filter(Boolean);

    const target = targets[0] || item;

    // Full pointer + mouse event chain for Google Maps
    const opts = { bubbles: true, cancelable: true, composed: true, view: window };
    const rect = target.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    target.dispatchEvent(new PointerEvent('pointerdown', { ...opts, clientX: cx, clientY: cy, pointerId: 1 }));
    target.dispatchEvent(new MouseEvent('mousedown',   { ...opts, clientX: cx, clientY: cy, button: 0 }));
    target.dispatchEvent(new PointerEvent('pointerup',   { ...opts, clientX: cx, clientY: cy, pointerId: 1 }));
    target.dispatchEvent(new MouseEvent('mouseup',      { ...opts, clientX: cx, clientY: cy, button: 0 }));
    target.dispatchEvent(new MouseEvent('click',        { ...opts, clientX: cx, clientY: cy, button: 0 }));

    return true;
  }

  async function waitForDetail(prevName) {
    const start = Date.now();

    while (Date.now() - start < CFG.PANEL_TIMEOUT) {
      await sleep(CFG.PANEL_POLL);

      const panel = getPanel();
      if (!panel) continue;

      const name = extractPanelName(panel);
      if (!name) continue;

      // If we had a previous name, verify this is different
      if (prevName && name.toLowerCase() === prevName.toLowerCase()) {
        // Same name — panel hasn't updated yet, keep waiting
        continue;
      }

      // Panel has a name (and it's different from prev) — extract everything
      return extractAll(panel);
    }

    // Timeout — extract whatever we can
    const panel = getPanel();
    return panel ? extractAll(panel) : emptyData();
  }

  function getPanel() {
    return document.querySelector('[role="main"]') || document.querySelector('[role="complementary"]');
  }

  function extractPanelName(panel) {
    return txt(
      panel.querySelector('[class*="DUwDvf"]'),
      panel.querySelector('h1'),
      panel.querySelector('[data-attrid="title"]'),
      panel.querySelector('.qUyWKc'),
      panel.querySelector('.Io6YTe'),
      panel.querySelector('.qUyWKc span')
    );
  }

  // ============================================================
  //  DETAIL PANEL — COMPREHENSIVE EXTRACTION
  // ============================================================
  function extractAll(panel) {
    const d = emptyData();

    // ── Name ──
    d.name = extractPanelName(panel);
    if (!d.name) return d;

    // ── Rating ──
    const starImg = panel.querySelector('span[role="img"]');
    if (starImg) {
      const al = (starImg.getAttribute('aria-label') || '').toLowerCase();
      const tx = starImg.textContent || '';
      const combined = al + ' ' + tx;
      const m = combined.match(/([\d][.,]?\d?)/);
      if (m) d.rating = m[1].replace(',', '.');
    }

    // ── Reviews count ──
    panel.querySelectorAll('span').forEach(sp => {
      if (d.reviews) return;
      const al = (sp.getAttribute('aria-label') || '').toLowerCase();
      const tx = sp.textContent || '';
      if (matchKw(al, L.reviews) || matchKw(tx, L.reviews)) {
        const m = (al + ' ' + tx).match(/([\d.,]+)/);
        if (m) d.reviews = m[1].replace(/[.,]/g, '');
      }
    });

    // ── Category ──
    const catEl = panel.querySelector('button[jsaction*="category"]') ||
                  panel.querySelector('.DkEaL') ||
                  panel.querySelector('[data-attrid="category"]');
    d.category = txt(catEl);

    // ── Scan ALL elements with aria-label or data-item-id ──
    panel.querySelectorAll('[aria-label], [data-item-id]').forEach(el => {
      const al  = (el.getAttribute('aria-label') || '').toLowerCase();
      const did = (el.getAttribute('data-item-id') || '').toLowerCase();
      const tx  = el.textContent?.trim() || '';

      // PHONE
      if (!d.phone && (matchKw(al, L.phone) || did.includes('phone') || did.includes('telp'))) {
        d.phone = cleanPhone(el, al, tx);
      }

      // ADDRESS
      if (!d.address && (matchKw(al, L.address) || did.includes('address') || did.includes('loc'))) {
        d.address = cleanLabel(al, L.address) || tx;
      }

      // WEBSITE
      if (!d.website && (matchKw(al, L.website) || did.includes('website') || did === 'url')) {
        const a = el.querySelector('a[href]');
        d.website = a?.getAttribute('href') || tx;
      }

      // HOURS
      if (!d.hours && (matchKw(al, L.hours) || did.includes('oh') || did.includes('hours'))) {
        d.hours = cleanLabel(al, L.hours) || tx;
      }

      // PLUS CODE
      if (!d.plusCode && (did.includes('plus_code') || did.includes('pluscode') || al.includes('plus code'))) {
        d.plusCode = tx;
      }

      // PRICE LEVEL
      if (!d.priceLevel && (matchKw(al, L.price) || did.includes('price'))) {
        d.priceLevel = tx || cleanLabel(al, L.price);
      }

      // SERVICES
      if (!d.hasDelivery && (matchKw(al, L.delivery) || did.includes('delivery'))) {
        d.hasDelivery = true;
      }
      if (!d.hasTakeout && (matchKw(al, L.takeout) || did.includes('takeout'))) {
        d.hasTakeout = true;
      }
      if (!d.hasDineIn && (matchKw(al, L.dinein) || did.includes('dine-in'))) {
        d.hasDineIn = true;
      }
    });

    // ── Website fallback: scan links ──
    if (!d.website) {
      panel.querySelectorAll('a[href]').forEach(a => {
        if (d.website) return;
        const href = a.getAttribute('href') || '';
        const al = (a.getAttribute('aria-label') || '').toLowerCase();
        if ((matchKw(al, L.website) || al.includes('buka'))
            && href.startsWith('http')
            && !href.includes('google') && !href.includes('gstatic')) {
          d.website = href;
        }
      });
    }

    // ── Hours: look for the hours button/section more aggressively ──
    if (!d.hours) {
      const hoursSection = panel.querySelector('[aria-label*="Jam"], [aria-label*="jam"], [data-item-id="oh"]');
      if (hoursSection) {
        d.hours = hoursSection.getAttribute('aria-label') || hoursSection.textContent?.trim() || '';
      }
    }

    // ── Email from panel text ──
    const bodyText = panel.innerText || '';
    const emails = bodyText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/g);
    if (emails) {
      for (const e of emails) {
        const low = e.toLowerCase();
        if (!low.includes('google.com') && !low.includes('gstatic') && !low.includes('googleapis')
            && !low.includes('example.com') && !low.includes('sentry.io')) {
          d.email = e;
          break;
        }
      }
    }

    // ── Phone fallback: scan all buttons and divs for phone patterns ──
    if (!d.phone) {
      panel.querySelectorAll('button, div[data-item-id], [role="link"]').forEach(el => {
        if (d.phone) return;
        const al = (el.getAttribute('aria-label') || '').toLowerCase();
        const tx = el.textContent?.trim() || '';
        const combined = al + ' ' + tx;
        // Indonesian phone pattern: 0xxx-xxxx-xxxx or +62 xxx
        const phoneMatch = combined.match(/(\+?62[\d\s\-]{8,15}|0[\d][\d\s\-]{7,14})/);
        if (phoneMatch) {
          d.phone = phoneMatch[1].trim();
        }
      });
    }

    // ── Google Maps URL ──
    const urlEl = panel.querySelector('[data-item-id="url"] a') ||
                  panel.querySelector('a[href*="/maps/place"]');
    if (urlEl) {
      d.googleMapsUrl = urlEl.getAttribute('href') || '';
    }
    if (!d.googleMapsUrl) {
      d.googleMapsUrl = window.location.href;
    }

    // ── Business status (open/closed) ──
    const statusEl = panel.querySelector('[class*="o0Svhf"], [class*="t39EBf"]');
    if (statusEl) {
      d.hours = d.hours || statusEl.textContent?.trim() || '';
    }

    return d;
  }

  // ============================================================
  //  DATA MERGE (list card + detail panel)
  // ============================================================
  function merge(list, detail) {
    return {
      name:          detail.name          || list.name          || '',
      rating:        detail.rating        || list.rating        || '',
      reviews:       detail.reviews       || list.reviews       || '',
      category:      detail.category      || list.category      || '',
      phone:         detail.phone         || list.phone         || '',
      address:       detail.address       || list.address       || '',
      website:       detail.website       || '',
      email:         detail.email         || '',
      hours:         detail.hours         || '',
      priceLevel:    detail.priceLevel    || '',
      hasDelivery:   detail.hasDelivery   || false,
      hasTakeout:    detail.hasTakeout    || false,
      hasDineIn:     detail.hasDineIn     || false,
      plusCode:      detail.plusCode      || '',
      googleMapsUrl: detail.googleMapsUrl || list.listUrl      || '',
    };
  }

  function emptyData() {
    return {
      name:'', rating:'', reviews:'', category:'', phone:'',
      address:'', website:'', email:'', hours:'', priceLevel:'',
      hasDelivery:false, hasTakeout:false, hasDineIn:false,
      plusCode:'', googleMapsUrl:''
    };
  }

  // ============================================================
  //  HELPERS
  // ============================================================
  function txt(...els) {
    for (const e of els) { if (e) { const t = e.textContent?.trim(); if (t) return t; } }
    return '';
  }

  function matchKw(text, keywords) {
    if (!text) return false;
    const lower = text.toLowerCase();
    return keywords.some(kw => lower.includes(kw));
  }

  function cleanLabel(ariaLabel, keywords) {
    if (!ariaLabel) return '';
    let c = ariaLabel;
    for (const kw of keywords) c = c.replace(new RegExp(kw, 'gi'), '');
    return c.replace(/^[\s:–\-]+/, '').replace(/[\s:–\-]+$/, '').trim();
  }

  function cleanPhone(el, ariaLabel, text) {
    // From aria-label
    if (ariaLabel) {
      let c = ariaLabel;
      for (const kw of L.phone) c = c.replace(new RegExp(kw, 'gi'), '');
      c = c.replace(/^[\s:]+/, '').replace(/[\s:]+$/, '').trim();
      if (c.length >= 8) return c;
    }
    // From text content
    const m = text.match(/(\+?62[\d\s\-]{8,15}|0[\d][\d\s\-]{7,14})/);
    if (m) return m[1].trim();
    // Raw text if short enough to be a phone
    if (text.length >= 8 && text.length <= 20 && /^[\d\s\-+()]+$/.test(text)) return text;
    return text;
  }

  function pressEscape() {
    const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function log(msg) { console.log('[MapsScraper] ' + msg); }

  function notify(results) {
    chrome.runtime.sendMessage({ action: 'scrapeResults', results })
      .catch(e => log('notify failed: ' + e.message));
  }

  function fail(msg) {
    log('FAIL: ' + msg);
    notify([]);
    running = false;
    removeOverlay();
  }

  // ── Overlay ──
  function overlay(text) {
    let el = document.getElementById('__ms_v3');
    if (!el) {
      el = document.createElement('div');
      el.id = '__ms_v3';
      el.style.cssText = `
        position:fixed; top:12px; right:12px; z-index:999999;
        background:linear-gradient(135deg,#1a73e8,#0d47a1); color:#fff;
        padding:14px 22px; border-radius:10px;
        font:bold 14px/1.4 'Segoe UI',Arial,sans-serif;
        box-shadow:0 6px 20px rgba(0,0,0,.35);
        pointer-events:none; max-width:360px; word-wrap:break-word;
      `;
      document.body.appendChild(el);
    }
    el.textContent = text;
    el.style.display = 'block';
  }

  function removeOverlay() {
    const el = document.getElementById('__ms_v3');
    if (el) {
      el.textContent = '✓ Selesai! Data sudah dikirim.';
      el.style.background = 'linear-gradient(135deg,#34a853,#1b7a3d)';
      setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .5s'; setTimeout(() => el.remove(), 600); }, 2500);
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
})();
