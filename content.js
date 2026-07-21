// ============================================================
// Google Maps Scraper - Content Script V4
// Production-quality: two-pass, verified clicks, multi-language
// Audit-fixed: global try-catch, optimized DOM scanning,
//              isolated speed presets, cleaned guard state
// ============================================================

(() => {
  // Remove old listener if re-injected (prevents duplicate listeners)
  if (window.__msListener) {
    chrome.runtime.onMessage.removeListener(window.__msListener);
  }

  // ── Config ──────────────────────────────────────────────────
  const BASE_CFG = {
    MAX_RETRIES:       20,
    RETRY_DELAY:       1500,
    CLICK_SETTLE:      4500,
    PANEL_POLL:        200,
    PANEL_TIMEOUT:     15000,
    SCROLL_PAUSE:      1000,
    BETWEEN_ITEMS:     1500,
    MAX_SCROLLS:       50,
    SCROLL_STABLE:     3,
  };
  // Clone so speed presets don't mutate the original
  let CFG = { ...BASE_CFG };

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

  // ── Speed presets ──────────────────────────────────────────
  const SPEED_PRESETS = {
    slow:       { CLICK_SETTLE: 6000, BETWEEN_ITEMS: 2500, SCROLL_PAUSE: 1800, PANEL_POLL: 300 },
    normal:     { CLICK_SETTLE: 4500, BETWEEN_ITEMS: 1500, SCROLL_PAUSE: 1000, PANEL_POLL: 200 },
    fast:       { CLICK_SETTLE: 3500, BETWEEN_ITEMS: 1000, SCROLL_PAUSE: 700,  PANEL_POLL: 150 },
    aggressive: { CLICK_SETTLE: 2500, BETWEEN_ITEMS: 600,  SCROLL_PAUSE: 500,  PANEL_POLL: 100 },
  };

  // ── State ───────────────────────────────────────────────────
  let running = false;
  let scrapeLimits = { min: 0, max: 0 };

  function messageHandler(msg, _sender, reply) {
    if (msg.action === 'startScraping') {
      if (running) {
        reply({ status: 'error', error: 'Scraping already in progress' });
        return false;
      }
      running = true;
      window.__msQuery = msg.query || '';
      scrapeLimits = { min: msg.min || 0, max: msg.max || 0 };
      const speed = msg.speed || 'normal';
      const preset = SPEED_PRESETS[speed] || SPEED_PRESETS.normal;
      CFG = { ...BASE_CFG, ...preset };
      reply({ status: 'started' });
      setTimeout(() => main(msg.query || ''), 1500);
    }
    return false;
  }

  chrome.runtime.onMessage.addListener(messageHandler);
  window.__msListener = messageHandler;

  // ============================================================
  //  MAIN ORCHESTRATOR
  // ============================================================
  async function main(query) {
    log('═══ START ═══  query="' + query + '"');
    log('Limits: min=' + scrapeLimits.min + ', max=' + scrapeLimits.max);
    log('URL: ' + window.location.href);

    try {
      // 1. Wait for the results feed
      const feed = await waitFeed();
      if (!feed) {
        log('Feed not found. Page elements: ' + document.querySelectorAll('*').length);
        fail('Feed tidak ditemukan. Pastikan Google Maps terbuka dengan benar.');
        return;
      }

      // 2. Scroll feed to load ALL results
      overlay('Loading all results...');
      log('Feed tag: ' + feed.tagName + ', role: ' + feed.getAttribute('role') + ', children: ' + feed.children.length);
      const collectedCards = await loadAllCards(feed);
      log('Total cards loaded: ' + collectedCards.length);
      if (collectedCards.length === 0) {
        log('No cards found. Feed HTML (first 500 chars): ' + feed.innerHTML.substring(0, 500));
        fail('Tidak ada hasil ditemukan.');
        return;
      }

      // 3. PASS 1 — data already collected during scroll!
      overlay('Pass 1: Reading list cards...');
      const basics = collectedCards.map((c, i) => ({
        idx: i,
        listData: c.data,
        element: c.element,
      }));
      log('Pass 1 done — ' + basics.filter(b => b.listData.name).length + ' names found');

      // 4. PASS 2 — click each card, read the detail panel, merge
      overlay('Pass 2: Opening detail panels...');
      const results = [];
      let prevName = '';

      // Limit cards to scrape if max is set
      const cardsToScrape = scrapeLimits.max > 0 ? basics.slice(0, scrapeLimits.max) : basics;

      for (let i = 0; i < cardsToScrape.length; i++) {
        const b = cardsToScrape[i];
        const pct = `${i + 1}/${cardsToScrape.length}`;
        overlay(`Scraping ${pct} — ${b.listData.name || '...'}${scrapeLimits.max > 0 ? ` (max: ${scrapeLimits.max})` : ''}`);

        try {
          // Scroll element into view (if still in DOM)
          if (b.element && b.element.isConnected) {
            b.element.scrollIntoView({ block: 'center', behavior: 'instant' });
            await sleep(600);
          }

          // Click with full event simulation
          const clicked = b.element && b.element.isConnected ? robustClick(b.element) : false;
          if (!clicked) {
            log(`  [${pct}] SKIP — element not in DOM or no click target`);
            // Still add the basic data we collected during scroll
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

      // Check min limit
      let warning = '';
      if (scrapeLimits.min > 0 && results.length < scrapeLimits.min) {
        warning = `⚠️ Hanya ${results.length} data (minimum: ${scrapeLimits.min})`;
        log(warning);
      }

      log('═══ DONE ═══  ' + results.length + ' results');
      notify(results, warning);

    } catch (err) {
      // Global catch: never leave `running = true`
      log('═══ FATAL ERROR ═══  ' + err.message);
      if (chrome.runtime?.id) {
        fail('Terjadi error: ' + err.message);
      } else {
        running = false;
        removeOverlay();
      }
    } finally {
      running = false;
    }
  }

  // ============================================================
  //  FEED & CARD LOADING
  // ============================================================
  async function waitFeed() {
    for (let i = 0; i < CFG.MAX_RETRIES; i++) {
      // Try multiple selectors for the feed container
      const selectors = [
        '[role="feed"]',
        '[role="main"] > div > div > div',
        '.m6QErb',  // Common Google Maps feed class
        '[aria-label]',
      ];
      for (const sel of selectors) {
        const f = document.querySelector(sel);
        if (f && f.children.length > 0) {
          log('Feed found via: ' + sel + ' (children: ' + f.children.length + ')');
          return f;
        }
      }
      log('Waiting for feed (' + (i + 1) + '/' + CFG.MAX_RETRIES + ')...');
      await sleep(CFG.RETRY_DELAY);
    }
    // Final fallback: return the scrollable container
    const fallback = document.querySelector('[role="main"]') || document.querySelector('.m6QErb');
    if (fallback) {
      log('Using fallback feed container');
      return fallback;
    }
    return null;
  }

  // Store cards data globally so we don't lose them after DOM changes
  let collectedCards = [];

  async function loadAllCards(feed) {
    collectedCards = [];
    const seenIds = new Set();
    let stable = 0;
    let prev = 0;

    // Initial wait for cards to appear
    for (let w = 0; w < 10; w++) {
      const initialCards = queryCards(feed);
      if (initialCards.length > 0) {
        log('Initial cards found: ' + initialCards.length);
        break;
      }
      log('Waiting for cards to appear... (' + (w + 1) + '/10)');
      await sleep(1000);
    }

    // Scroll and COLLECT card data during scroll (not after!)
    for (let s = 0; s < CFG.MAX_SCROLLS; s++) {
      const currentCards = queryCards(feed);

      // Collect new cards data while they're in the DOM
      for (const card of currentCards) {
        const id = cardId(card);
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          // Store the card element AND its extracted data
          collectedCards.push({
            element: card,
            data: extractCard(card),
            id: id
          });
        }
      }

      log('Scroll ' + (s + 1) + ': ' + currentCards.length + ' visible, ' + collectedCards.length + ' collected');

      feed.scrollTop = feed.scrollHeight;
      await sleep(CFG.SCROLL_PAUSE);

      const now = seenIds.size;
      if (now === prev) {
        stable++;
        if (stable >= CFG.SCROLL_STABLE) break;
      } else {
        stable = 0;
      }
      prev = now;
    }

    log('Scroll complete. Total collected: ' + collectedCards.length);
    return collectedCards;
  }

  function queryCards(feed) {
    // Try progressively broader selectors to find result cards
    const selectors = [
      // Specific Google Maps selectors
      'div[data-index]',
      'div[jsaction*="mouseover"]',
      'div[role="article"]',
      'a[href*="/maps/place"]',
      // Common class patterns
      '.Nv2PK',
      '.bfw7rf',
      // Structural selectors
      ':scope > div > div > div[data-index]',
      ':scope > div > div[jsaction*="mouseover"]',
      ':scope > div > div > div[role="article"]',
      ':scope > div > div > a[href*="/maps/place"]',
    ];
    for (const sel of selectors) {
      try {
        const items = feed.querySelectorAll(sel);
        if (items.length > 0) {
          log('Cards found via: ' + sel + ' (count: ' + items.length + ')');
          return Array.from(items);
        }
      } catch (e) { /* invalid selector, skip */ }
    }

    // Fallback: find direct children that contain links to places
    log('Trying fallback card detection...');
    const cards = [];
    const allLinks = feed.querySelectorAll('a[href*="/maps/place"]');
    for (const link of allLinks) {
      // Get the closest card-like parent
      let card = link.closest('[data-index]') ||
                 link.closest('[role="article"]') ||
                 link.closest('div[jsaction]') ||
                 link.parentElement?.parentElement;
      if (card && !cards.includes(card)) {
        cards.push(card);
      }
    }
    if (cards.length > 0) {
      log('Fallback found ' + cards.length + ' cards');
      return cards;
    }

    // Last resort: any element with place links
    const all = feed.querySelectorAll('div');
    const result = Array.from(all).filter(el => {
      const link = el.querySelector('a[href*="/maps/place"]');
      return link && el.offsetHeight > 50 && el.offsetHeight < 500;
    }).slice(0, 100);
    log('Last resort found ' + result.length + ' potential cards');
    return result;
  }

  function cardId(card) {
    const name = card.querySelector('[class*="fontHeadlineSmall"], [role="heading"], .qBF1Pd, .NrDZNb')?.textContent || '';
    const link = card.querySelector('a[href*="/maps/place"]')?.getAttribute('href') || '';
    if (!name && !link) return ''; // Skip cards with no identifiable data
    return (name || 'unknown') + '|' + (link.slice(0, 80) || Math.random().toString(36).slice(2, 8));
  }

  // ============================================================
  //  PASS 1 — LIST CARD EXTRACTION
  // ============================================================
  function extractCard(card) {
    const d = { name:'', rating:'', reviews:'', category:'', address:'', phone:'', listUrl:'' };

    d.name = txt(
      card.querySelector('[class*="fontHeadlineSmall"]'),
      card.querySelector('[role="heading"]'),
      card.querySelector('.qBF1Pd'),
      card.querySelector('.NrDZNb')
    );

    const starEl = card.querySelector('span[role="img"]');
    if (starEl) {
      const al = starEl.getAttribute('aria-label') || '';
      const m = al.match(/([\d.,]+)/);
      if (m) d.rating = m[1].replace(',', '.');
      const r = al.match(/\(([\d.,]+)\)/);
      if (r) d.reviews = r[1].replace(/[.,]/g, '');
    }

    // Category — use a more targeted selector instead of iterating all spans
    const catEl = card.querySelector('[class*="W4Efsd"] span, [class*="fontBodyMedium"] span');
    if (catEl) {
      const t = catEl.textContent?.trim() || '';
      if (t.length >= 4 && t.length < 80 && !/^\d/.test(t)) {
        d.category = t;
      }
    }

    const addrEl = card.querySelector('[class*="W4Efsd"]:last-child span:last-child');
    if (addrEl) {
      const t = addrEl.textContent?.trim() || '';
      if (t.length > 10 && !t.includes('·')) d.address = t;
    }

    const link = card.querySelector('a[href*="/maps/place"]');
    if (link) d.listUrl = link.getAttribute('href') || '';

    return d;
  }

  // ============================================================
  //  PASS 2 — CLICK & DETAIL PANEL
  // ============================================================
  function robustClick(item) {
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
    let panelFound = false;

    while (Date.now() - start < CFG.PANEL_TIMEOUT) {
      await sleep(CFG.PANEL_POLL);

      const panel = getPanel();
      if (!panel) {
        if (!panelFound) log('Waiting for panel... (no panel found)');
        continue;
      }

      if (!panelFound) {
        panelFound = true;
        log('Panel found: role=' + panel.getAttribute('role') + ' tag=' + panel.tagName + ' text=' + (panel.innerText || '').substring(0, 100));
      }

      const name = extractPanelName(panel);
      if (!name) continue;

      if (prevName && name.toLowerCase() === prevName.toLowerCase()) {
        continue;
      }

      log('Panel name: ' + name + ' (prev: ' + prevName + ')');
      return extractAll(panel);
    }

    const panel = getPanel();
    if (panel) {
      log('Panel timeout but found, extracting anyway');
      return extractAll(panel);
    }
    log('Panel NOT found after timeout');
    return emptyData();
  }

  function getPanel() {
    // Try multiple selectors for the detail panel
    const selectors = [
      '[role="main"]',
      '[role="complementary"]',
      '.m6QErb.DxyBCb.kA9KIf.dS8AEf',  // Common Google Maps panel class
      '.m6QErb',  // Broader class match
      '[data-panel]',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.length > 50) {
        return el;
      }
    }
    return null;
  }

  function extractPanelName(panel) {
    // Try multiple selectors for business name - Google Maps uses h1 for business name
    const candidates = [
      panel.querySelector('h1'),
      panel.querySelector('[class*="DUwDvf"]'),
      panel.querySelector('[data-attrid="title"]'),
      panel.querySelector('.qUyWKc'),
      panel.querySelector('.Io6YTe'),
      panel.querySelector('[role="heading"][aria-level="1"]'),
    ];
    for (const el of candidates) {
      if (!el) continue;
      const t = el.textContent?.trim() || '';
      // Filter out invalid names
      if (t && t.length > 1 &&
          t.toLowerCase() !== 'hasil' &&
          t.toLowerCase() !== 'result' &&
          t.toLowerCase() !== 'ringkasan' &&
          t.toLowerCase() !== 'ulasan' &&
          t.toLowerCase() !== 'tentang') {
        return t;
      }
    }
    return '';
  }

  // ============================================================
  //  DETAIL PANEL — AGGRESSIVE EXTRACTION
  // ============================================================
  function extractAll(panel) {
    const d = emptyData();

    d.name = extractPanelName(panel);
    if (!d.name) return d;

    // ── Get ALL text from panel for scanning ──
    const allText = panel.innerText || '';
    log('Panel text (first 300): ' + allText.substring(0, 300));

    // ── Rating ──
    const starImg = panel.querySelector('span[role="img"]');
    if (starImg) {
      const al = (starImg.getAttribute('aria-label') || '').toLowerCase();
      const tx = starImg.textContent || '';
      const combined = al + ' ' + tx;
      const m = combined.match(/([\d][.,]?\d?)/);
      if (m) d.rating = m[1].replace(',', '.');
    }

    // ── Reviews: scan all spans with aria-label containing numbers ──
    if (!d.reviews) {
      const allSpans = panel.querySelectorAll('span[aria-label]');
      for (const sp of allSpans) {
        const al = (sp.getAttribute('aria-label') || '').toLowerCase();
        // Match "136 ulasan" or "(136)" patterns
        if (al.includes('ulasan') || al.includes('review')) {
          const m = al.match(/([\d.,]+)/);
          if (m) { d.reviews = m[1].replace(/[.,]/g, ''); break; }
        }
      }
    }
    // Reviews fallback: scan text for "(123)" pattern near rating
    if (!d.reviews) {
      const m = allText.match(/\((\d[\d.,]*)\)/);
      if (m) d.reviews = m[1].replace(/[.,]/g, '');
    }

    // ── Category: scan near rating area ──
    if (!d.category) {
      // Look for text that looks like a category (short, no numbers, near rating)
      const catPatterns = allText.match(/(?:·\s*)([A-Z][a-zA-Z\s]{3,40})/);
      if (catPatterns) d.category = catPatterns[1].trim();
    }

    // ── PHONE: scan ALL buttons and text for phone patterns ──
    if (!d.phone) {
      // Method 1: scan all buttons/links with aria-label
      const phoneEls = panel.querySelectorAll('button, [role="link"], a, [data-item-id]');
      for (const el of phoneEls) {
        const al = (el.getAttribute('aria-label') || '').toLowerCase();
        const tx = el.textContent?.trim() || '';
        const combined = al + ' ' + tx;
        const m = combined.match(/(\+?62[\d\s\-]{8,15}|0[\d][\d\s\-]{7,14})/);
        if (m) { d.phone = m[1].trim(); break; }
      }
    }
    if (!d.phone) {
      // Method 2: scan entire panel text
      const m = allText.match(/(\+?62[\d\s\-]{8,15}|0[\d][\d\s\-]{7,14})/);
      if (m) d.phone = m[1].trim();
    }

    // ── ADDRESS: scan ALL buttons/links for address content ──
    if (!d.address) {
      const addrEls = panel.querySelectorAll('button, [role="link"], [data-item-id]');
      for (const el of addrEls) {
        const tx = el.textContent?.trim() || '';
        const al = (el.getAttribute('aria-label') || '').toLowerCase();
        // Match address patterns
        if (tx.length > 15 && (
            tx.includes('Jl.') || tx.includes('Jalan') || tx.includes('No.') ||
            tx.includes('Kec.') || tx.includes('Kota') || tx.includes('Kab.') ||
            tx.includes('Indonesia') || tx.includes('Banten') || tx.includes('Jakarta') ||
            (tx.includes(',') && tx.includes(' '))
          )) {
          d.address = tx;
          break;
        }
        // Also check aria-label
        if (al.includes('alamat') || al.includes('address')) {
          d.address = tx || al;
          break;
        }
      }
    }
    // Address fallback: scan text for address-like content
    if (!d.address) {
      const addrMatch = allText.match(/((?:Jl\.|Jalan|Jl\.|Jl|Jalan Raya)[\s\S]{10,120})/);
      if (addrMatch) d.address = addrMatch[1].trim().replace(/\n/g, ' ');
    }

    // ── HOURS: scan for time patterns ──
    if (!d.hours) {
      const hoursMatch = allText.match(/(Buka[\s\S]{0,30}pukul[\s\S]{0,20}|Tutup[\s\S]{0,30}pukul[\s\S]{0,20}|Jam[\s\S]{0,30})/i);
      if (hoursMatch) d.hours = hoursMatch[1].trim().replace(/\n/g, ' ');
    }
    if (!d.hours) {
      const hoursMatch2 = allText.match(/(\d{1,2}\.\d{2}\s*[-–]\s*\d{1,2}\.\d{2})/);
      if (hoursMatch2) d.hours = hoursMatch2[1];
    }

    // ── WEBSITE: scan for http links ──
    if (!d.website) {
      const links = panel.querySelectorAll('a[href]');
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const al = (a.getAttribute('aria-label') || '').toLowerCase();
        if (href.startsWith('http') && !href.includes('google') && !href.includes('gstatic') && !href.includes('googleapis')) {
          d.website = href;
          break;
        }
      }
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

    // ── Services: scan text ──
    if (!d.hasDelivery) d.hasDelivery = /belanja di toko|delivery|pengantaran/i.test(allText);
    if (!d.hasTakeout) d.hasTakeout = /ambil di toko|takeout|ambil sendiri/i.test(allText);
    if (!d.hasDineIn) d.hasDineIn = /makan di tempat|dine.in/i.test(allText);

    // ── Plus Code: scan text ──
    if (!d.plusCode) {
      const pcMatch = allText.match(/([A-Z0-9]{4}\+[A-Z0-9]{2,3})/);
      if (pcMatch) d.plusCode = pcMatch[1];
    }

    log('Extracted: name=' + d.name + ' rating=' + d.rating + ' phone=' + d.phone + ' addr=' + (d.address || '').substring(0, 50) + ' reviews=' + d.reviews + ' hours=' + (d.hours || '').substring(0, 30));
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
    try {
      if (ariaLabel) {
        let c = ariaLabel;
        const phoneKeywords = L.phone || ['phone','telepon','telp'];
        for (const kw of phoneKeywords) {
          c = c.replace(new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
        }
        c = c.replace(/^[\s:]+/, '').replace(/[\s:]+$/, '').trim();
        if (c.length >= 8) return c;
      }
      const m = text.match(/(\+?62[\d\s\-]{8,15}|0[\d][\d\s\-]{7,14})/);
      if (m) return m[1].trim();
      if (text.length >= 8 && text.length <= 20 && /^[\d\s\-+()]+$/.test(text)) return text;
    } catch (e) {
      log('cleanPhone error: ' + e.message);
    }
    return text || '';
  }

  function pressEscape() {
    const opts = { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true };
    document.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.dispatchEvent(new KeyboardEvent('keyup', opts));
  }

  function log(msg) { console.log('[MapsScraper] ' + msg); }

  function notify(results, warning) {
    // Check if extension context is still valid
    if (!chrome.runtime?.id) {
      log('Extension context invalidated — data saved locally only');
      return;
    }

    const query = window.__msQuery || '';

    // Save to chrome.storage directly
    try {
      chrome.storage.local.set({
        lastResults: results,
        lastTime: Date.now()
      });
    } catch (e) {
      log('Storage save failed: ' + e.message);
    }

    // Save to history
    try {
      chrome.storage.local.get(['scrapeHistory'], d => {
        const history = d.scrapeHistory || [];
        const storedResults = results.length > 50 ? results.slice(0, 50) : results;
        history.unshift({
          id: Date.now(),
          query: query,
          count: results.length,
          timestamp: Date.now(),
          results: storedResults,
          truncated: results.length > 50
        });
        if (history.length > 10) history.length = 10;
        chrome.storage.local.set({ scrapeHistory: history });
      });
    } catch (e) {
      log('History save failed: ' + e.message);
    }

    log('Saved ' + results.length + ' results to storage + history');

    // Try to send to background (for popup live update)
    try {
      chrome.runtime.sendMessage({ action: 'scrapeResults', results, query, warning: warning || '' })
        .catch(() => {}); // Silently ignore if popup closed
    } catch (e) {
      // Extension context invalidated — ignore
    }
  }

  function fail(msg) {
    log('FAIL: ' + msg);
    try { notify([]); } catch (e) {}
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
      el.style.background = 'linear-gradient(135deg,#34a853,#1b7a3d)';
      el.style.pointerEvents = 'auto';
      el.style.cursor = 'pointer';
      el.innerHTML = '✅ <b>Selesai!</b> Buka popup extension untuk export data.';
      el.title = 'Klik icon extension di toolbar untuk export';
      // Don't auto-remove — let user see the message
      setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 1s'; }, 10000);
      setTimeout(() => { el.remove(); }, 11500);
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
})();
