// ============================================================
// Google Maps Scraper - Content Script V5
// API Intercept Approach - Most reliable & fastest
// Intercepts Google Maps internal API calls for complete data
// ============================================================

(() => {
  // Remove old listener if re-injected
  if (window.__msListener) {
    chrome.runtime.onMessage.removeListener(window.__msListener);
  }

  // ── Config ──────────────────────────────────────────────────
  const BASE_CFG = {
    MAX_RETRIES: 20,
    RETRY_DELAY: 1500,
    SCROLL_PAUSE: 800,
    BETWEEN_ITEMS: 800,
    MAX_SCROLLS: 50,
    SCROLL_STABLE: 3,
    PANEL_TIMEOUT: 12000,
  };
  let CFG = { ...BASE_CFG };

  // ── Speed presets ──────────────────────────────────────────
  const SPEED_PRESETS = {
    slow:       { BETWEEN_ITEMS: 2000, SCROLL_PAUSE: 1500 },
    normal:     { BETWEEN_ITEMS: 800,  SCROLL_PAUSE: 800 },
    fast:       { BETWEEN_ITEMS: 500,  SCROLL_PAUSE: 500 },
    aggressive: { BETWEEN_ITEMS: 300,  SCROLL_PAUSE: 300 },
  };

  // ── State ───────────────────────────────────────────────────
  let running = false;
  let scrapeLimits = { min: 0, max: 0 };

  // ── API Intercept State ─────────────────────────────────────
  let interceptedData = {};
  let interceptedTimestamp = 0;
  let originalFetch = null;
  let originalXHR = null;

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
  //  API INTERCEPT - Capture Google Maps internal data
  // ============================================================
  function setupAPIIntercept() {
    // Intercept fetch
    originalFetch = window.fetch;
    window.fetch = function(...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      const result = originalFetch.apply(this, args);

      // Capture place detail responses
      if (url.includes('/maps/preview/place') || url.includes('/maps/preview/entity')) {
        result.then(response => response.clone().text().then(text => {
          try {
            parseAPIResponse(text, url);
          } catch (e) {}
        })).catch(() => {});
      }

      return result;
    };

    // Intercept XMLHttpRequest
    originalXHR = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__url = url;
      if (url && (url.includes('/maps/preview/place') || url.includes('/maps/preview/entity'))) {
        this.addEventListener('load', function() {
          try {
            parseAPIResponse(this.responseText, url);
          } catch (e) {}
        });
      }
      return originalXHR.apply(this, [method, url, ...rest]);
    };

    log('API intercept installed');
  }

  function parseAPIResponse(text, url) {
    // Google Maps API responses contain protobuf-like data with business info
    const newTimestamp = Date.now();

    // Phone patterns in API response
    const phoneMatch = text.match(/"(\+?62[\d\s\-]{8,15}|0[\d][\d\s\-]{7,14})"/);
    if (phoneMatch) {
      interceptedData.phone = phoneMatch[1];
      interceptedTimestamp = newTimestamp;
    }

    // Also try escaped phone patterns
    const phoneMatch2 = text.match(/\\\\x22(\+?62[\d\s\-]{8,15}|0[\d][\d\s\-]{7,14})\\\\x22/);
    if (phoneMatch2 && !interceptedData.phone) {
      interceptedData.phone = phoneMatch2[1];
      interceptedTimestamp = newTimestamp;
    }

    // Address patterns - look for structured address data
    const addrMatch = text.match(/"((?:Jl\.|Jalan|Jl|Jalan Raya|BSD|Taman|Kec\.|Kota|Indonesia)[^"]{10,200})"/);
    if (addrMatch) {
      interceptedData.address = addrMatch[1];
      interceptedTimestamp = newTimestamp;
    }

    // Website
    const webMatch = text.match(/"((?:https?:\/\/)[^"]*(?:\.com|\.co\.id|\.id|\.net|\.org)[^"]*)"/);
    if (webMatch && !webMatch[1].includes('google')) {
      interceptedData.website = webMatch[1];
      interceptedTimestamp = newTimestamp;
    }

    // Hours
    const hoursMatch = text.match(/"((?:Buka|Tutup|Jam|Open|Closed)[^"]{5,100})"/);
    if (hoursMatch) {
      interceptedData.hours = hoursMatch[1];
      interceptedTimestamp = newTimestamp;
    }

    // Email
    const emailMatch = text.match(/"([^"]*@[^"]*\.(?:com|co\.id|id|net|org)[^"]*)"/);
    if (emailMatch && !emailMatch[1].includes('google')) {
      interceptedData.email = emailMatch[1];
      interceptedTimestamp = newTimestamp;
    }

    // Reviews count
    const reviewsMatch = text.match(/"(\d+)\s*(?:ulasan|review|reviews)"/i);
    if (reviewsMatch) {
      interceptedData.reviews = reviewsMatch[1];
      interceptedTimestamp = newTimestamp;
    }

    // Plus code
    const plusMatch = text.match(/"([A-Z0-9]{4}\+[A-Z0-9]{2,3})"/);
    if (plusMatch) {
      interceptedData.plusCode = plusMatch[1];
      interceptedTimestamp = newTimestamp;
    }

    // Price level
    const priceMatch = text.match(/"((?:Harga|Price|Rp)[^"]{2,30})"/i);
    if (priceMatch) {
      interceptedData.priceLevel = priceMatch[1];
      interceptedTimestamp = newTimestamp;
    }
  }

  function restoreAPIIntercept() {
    if (originalFetch) window.fetch = originalFetch;
    if (originalXHR) XMLHttpRequest.prototype.open = originalXHR;
    log('API intercept restored');
  }

  // ============================================================
  //  MAIN ORCHESTRATOR
  // ============================================================
  async function main(query) {
    log('═══ START ═══  query="' + query + '"');
    log('Limits: min=' + scrapeLimits.min + ', max=' + scrapeLimits.max);

    // Setup API intercept before scraping
    setupAPIIntercept();

    try {
      // 1. Wait for the results feed
      const feed = await waitFeed();
      if (!feed) {
        fail('Feed tidak ditemukan. Pastikan Google Maps terbuka.');
        return;
      }

      // 2. Scroll and collect cards
      overlay('Loading all results...');
      const collectedCards = await loadAllCards(feed);
      log('Total cards loaded: ' + collectedCards.length);
      if (collectedCards.length === 0) {
        fail('Tidak ada hasil ditemukan.');
        return;
      }

      // 3. Click each card and extract data
      overlay('Scraping data...');
      const results = [];
      const cardsToScrape = scrapeLimits.max > 0 ? collectedCards.slice(0, scrapeLimits.max) : collectedCards;

      for (let i = 0; i < cardsToScrape.length; i++) {
        const card = cardsToScrape[i];
        const pct = `${i + 1}/${cardsToScrape.length}`;
        overlay(`Scraping ${pct} — ${card.data.name || '...'}`);

        try {
          // Reset intercepted data for this card
          interceptedData = {};
          interceptedTimestamp = 0;

          // Get current panel name (to detect change)
          const prevPanelName = getPanelName();

          // Scroll into view
          if (card.element && card.element.isConnected) {
            card.element.scrollIntoView({ block: 'center', behavior: 'instant' });
            await sleep(400);
          }

          // Click the card
          if (card.element && card.element.isConnected) {
            robustClick(card.element);
          }

          // Wait for panel to show DIFFERENT business name
          let panelChanged = false;
          const waitStart = Date.now();
          while (Date.now() - waitStart < CFG.PANEL_TIMEOUT) {
            await sleep(300);
            const currentName = getPanelName();
            // Panel changed if name is different from previous AND matches current card
            if (currentName && currentName !== prevPanelName) {
              panelChanged = true;
              break;
            }
          }

          if (!panelChanged) {
            log(`[${pct}] Panel did not change for ${card.data.name}`);
          }

          // Wait a bit more for full data load
          await sleep(800);

          // Extract from DOM panel
          const panel = getPanel();
          let domData = {};
          if (panel) {
            domData = extractFromPanel(panel);
          }

          // Use intercepted API data only if it's FRESH
          const apiData = {};
          if (interceptedTimestamp > 0 && (Date.now() - interceptedTimestamp) < 5000) {
            Object.assign(apiData, interceptedData);
          }

          // Merge: list card data + API intercepted + DOM panel
          const merged = {
            name:          card.data.name || domData.name || '',
            rating:        card.data.rating || domData.rating || '',
            reviews:       apiData.reviews || domData.reviews || card.data.reviews || '',
            category:      domData.category || card.data.category || '',
            phone:         apiData.phone || domData.phone || '',
            address:       apiData.address || domData.address || '',
            website:       apiData.website || domData.website || '',
            email:         apiData.email || domData.email || '',
            hours:         apiData.hours || domData.hours || '',
            priceLevel:    domData.priceLevel || '',
            hasDelivery:   domData.hasDelivery || false,
            hasTakeout:    domData.hasTakeout || false,
            hasDineIn:     domData.hasDineIn || false,
            plusCode:      apiData.plusCode || domData.plusCode || '',
            googleMapsUrl: card.data.listUrl || domData.googleMapsUrl || window.location.href,
          };

          results.push(merged);

          const hasPhone = merged.phone ? '✓' : '-';
          const hasAddr = merged.address ? '✓' : '-';
          log(`[${pct}] ${merged.name} 📞${hasPhone} 📍${hasAddr}`);

          // Close panel and wait for it to fully close
          pressEscape();
          await sleep(1000);

        } catch (err) {
          log(`[${pct}] ERROR: ${err.message}`);
          results.push({
            ...card.data,
            googleMapsUrl: card.data.listUrl || window.location.href
          });
        }
      }

      // 4. Send results
      removeOverlay();

      let warning = '';
      if (scrapeLimits.min > 0 && results.length < scrapeLimits.min) {
        warning = `⚠️ Hanya ${results.length} data (minimum: ${scrapeLimits.min})`;
      }

      log('═══ DONE ═══  ' + results.length + ' results');
      log('With phone: ' + results.filter(r => r.phone).length);
      log('With address: ' + results.filter(r => r.address).length);
      notify(results, warning);

    } catch (err) {
      log('═══ FATAL ERROR ═══  ' + err.message);
      if (chrome.runtime?.id) {
        fail('Terjadi error: ' + err.message);
      } else {
        running = false;
        removeOverlay();
      }
    } finally {
      running = false;
      restoreAPIIntercept();
    }
  }

  // ============================================================
  //  FEED & CARD LOADING (Same as before)
  // ============================================================
  async function waitFeed() {
    for (let i = 0; i < CFG.MAX_RETRIES; i++) {
      const selectors = [
        '[role="feed"]',
        '.m6QErb',
        '[role="main"] > div > div > div',
      ];
      for (const sel of selectors) {
        const f = document.querySelector(sel);
        if (f && f.children.length > 0) {
          log('Feed found: ' + sel);
          return f;
        }
      }
      log('Waiting for feed (' + (i + 1) + '/' + CFG.MAX_RETRIES + ')...');
      await sleep(CFG.RETRY_DELAY);
    }
    return document.querySelector('[role="main"]') || document.querySelector('.m6QErb');
  }

  let collectedCards = [];

  async function loadAllCards(feed) {
    collectedCards = [];
    const seenIds = new Set();

    for (let w = 0; w < 10; w++) {
      if (queryCards(feed).length > 0) break;
      await sleep(1000);
    }

    for (let s = 0; s < CFG.MAX_SCROLLS; s++) {
      const currentCards = queryCards(feed);
      for (const card of currentCards) {
        const id = cardId(card);
        if (id && !seenIds.has(id)) {
          seenIds.add(id);
          collectedCards.push({
            element: card,
            data: extractCard(card),
            id: id
          });
        }
      }

      feed.scrollTop = feed.scrollHeight;
      await sleep(CFG.SCROLL_PAUSE);

      const now = seenIds.size;
      if (now === seenIds.size && s > 3) break;
    }

    log('Collected: ' + collectedCards.length + ' cards');
    return collectedCards;
  }

  function queryCards(feed) {
    const selectors = [
      'div[data-index]',
      'div[jsaction*="mouseover"]',
      'div[role="article"]',
      '.Nv2PK',
    ];
    for (const sel of selectors) {
      try {
        const items = feed.querySelectorAll(sel);
        if (items.length > 0) return Array.from(items);
      } catch (e) {}
    }
    // Fallback
    const all = feed.querySelectorAll('a[href*="/maps/place"]');
    const cards = [];
    for (const link of all) {
      const card = link.closest('[data-index]') || link.closest('[role="article"]') || link.parentElement?.parentElement;
      if (card && !cards.includes(card)) cards.push(card);
    }
    return cards;
  }

  function cardId(card) {
    const name = card.querySelector('[class*="fontHeadlineSmall"], [role="heading"], .qBF1Pd')?.textContent || '';
    const link = card.querySelector('a[href*="/maps/place"]')?.getAttribute('href') || '';
    if (!name && !link) return '';
    return (name || 'x') + '|' + (link.slice(0, 80) || Math.random().toString(36).slice(2, 8));
  }

  // ============================================================
  //  CARD & PANEL EXTRACTION
  // ============================================================
  function extractCard(card) {
    const d = { name:'', rating:'', reviews:'', category:'', address:'', phone:'', listUrl:'' };

    d.name = card.querySelector('[class*="fontHeadlineSmall"], [role="heading"], .qBF1Pd')?.textContent?.trim() || '';

    const starEl = card.querySelector('span[role="img"]');
    if (starEl) {
      const al = starEl.getAttribute('aria-label') || '';
      const m = al.match(/([\d.,]+)/);
      if (m) d.rating = m[1].replace(',', '.');
      const r = al.match(/\(([\d.,]+)\)/);
      if (r) d.reviews = r[1].replace(/[.,]/g, '');
    }

    // Category
    const catEl = card.querySelector('[class*="W4Efsd"] span, [class*="fontBodyMedium"] span');
    if (catEl) {
      const t = catEl.textContent?.trim() || '';
      if (t.length >= 4 && t.length < 80 && !/^\d/.test(t)) d.category = t;
    }

    // URL
    const link = card.querySelector('a[href*="/maps/place"]');
    if (link) d.listUrl = link.getAttribute('href') || '';

    return d;
  }

  function getPanel() {
    const selectors = [
      '[role="main"]',
      '[role="complementary"]',
      '.m6QErb.DxyBCb.kA9KIf.dS8AEf',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.length > 50) return el;
    }
    return null;
  }

  function getPanelName() {
    const panel = getPanel();
    if (!panel) return null;
    const h1 = panel.querySelector('h1');
    if (h1) return h1.textContent?.trim() || null;
    return null;
  }

  function extractFromPanel(panel) {
    const d = {};
    const allText = panel.innerText || '';
    log('Panel text (500): ' + allText.substring(0, 500));

    // Name
    const h1 = panel.querySelector('h1');
    if (h1) d.name = h1.textContent?.trim() || '';

    // Rating
    const starImg = panel.querySelector('span[role="img"]');
    if (starImg) {
      const al = (starImg.getAttribute('aria-label') || '').toLowerCase();
      const m = al.match(/([\d][.,]?\d?)/);
      if (m) d.rating = m[1].replace(',', '.');
    }

    // Reviews - scan aria-labels
    const allSpans = panel.querySelectorAll('span[aria-label]');
    for (const sp of allSpans) {
      const al = (sp.getAttribute('aria-label') || '').toLowerCase();
      if (al.includes('ulasan') || al.includes('review')) {
        const m = al.match(/(\d[\d.,]*)/);
        if (m) { d.reviews = m[1].replace(/[.,]/g, ''); break; }
      }
    }
    if (!d.reviews) {
      const m = allText.match(/\((\d[\d.,]+)\)/);
      if (m) d.reviews = m[1].replace(/[.,]/g, '');
    }

    // Category
    const ratingEl = panel.querySelector('span[role="img"]');
    if (ratingEl && ratingEl.parentElement) {
      const siblings = ratingEl.parentElement.querySelectorAll('span');
      for (const sp of siblings) {
        const t = sp.textContent?.trim() || '';
        if (t.length > 3 && t.length < 50 && !/^\d/.test(t) && !t.includes('(') &&
            !t.includes('ulasan') && t.toLowerCase() !== 'link yang dikunjungi') {
          d.category = t;
          break;
        }
      }
    }

    // Phone - scan ALL elements with text containing phone pattern
    const phoneRegex = /(\+?62[\d\s\-]{8,15}|0[\d][\d\s\-]{7,14})/;
    const allEls = panel.querySelectorAll('button, [role="link"], a, [data-item-id], div[tabindex], span');
    for (const el of allEls) {
      const tx = el.textContent?.trim() || '';
      if (tx.length < 20) {
        const m = tx.match(phoneRegex);
        if (m && !m[1].includes('pukul')) { d.phone = m[1].trim(); break; }
      }
    }
    if (!d.phone) {
      const m = allText.match(phoneRegex);
      if (m && !m[1].includes('pukul')) d.phone = m[1].trim();
    }

    // Address
    const addrPatterns = [/MM[A-Z0-9]\+[A-Z0-9]{2}[^,\n]{3,100}/i, /Jl\.[^,\n]{5,100}/i, /Jalan[^,\n]{5,100}/i, /BSD[^,\n]{5,100}/i, /Kec\.[^,\n]{5,100}/i];
    for (const el of allEls) {
      const tx = el.textContent?.trim() || '';
      if (tx.length > 15) {
        for (const pat of addrPatterns) {
          const m = tx.match(pat);
          if (m) { d.address = m[0].trim(); break; }
        }
        if (d.address) break;
      }
    }

    // Hours
    const hoursMatch = allText.match(/(Buka\s*·?\s*Tutup\s+pukul\s+\d{1,2}\.\d{2}|Tutup\s+pukul\s+\d{1,2}\.\d{2})/i);
    if (hoursMatch) d.hours = hoursMatch[1].trim();

    // Website
    const links = panel.querySelectorAll('a[href]');
    for (const a of links) {
      const href = a.getAttribute('href') || '';
      if (href.startsWith('http') && !href.includes('google') && !href.includes('gstatic')) {
        d.website = href;
        break;
      }
    }

    log('DOM: phone=' + d.phone + ' reviews=' + d.reviews + ' addr=' + (d.address || '').substring(0, 40));
    return d;
  }

  // ============================================================
  //  CLICK & HELPERS
  // ============================================================
  function robustClick(item) {
    const targets = [
      item.querySelector('a[href*="/maps/place"]'),
      item.querySelector('[role="article"]'),
      item.querySelector('[role="link"]'),
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
  }

  function pressEscape() {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true }));
  }

  function log(msg) { console.log('[MapsScraper] ' + msg); }

  function notify(results, warning) {
    if (!chrome.runtime?.id) return;

    try {
      chrome.storage.local.set({ lastResults: results, lastTime: Date.now() });
    } catch (e) {}

    try {
      chrome.storage.local.get(['scrapeHistory'], d => {
        const history = d.scrapeHistory || [];
        const stored = results.length > 50 ? results.slice(0, 50) : results;
        history.unshift({
          id: Date.now(), query: window.__msQuery || '', count: results.length,
          timestamp: Date.now(), results: stored, truncated: results.length > 50
        });
        if (history.length > 10) history.length = 10;
        chrome.storage.local.set({ scrapeHistory: history });
      });
    } catch (e) {}

    log('Saved ' + results.length + ' results');

    try {
      chrome.runtime.sendMessage({ action: 'scrapeResults', results, query: window.__msQuery || '', warning: warning || '' })
        .catch(() => {});
    } catch (e) {}
  }

  function fail(msg) {
    log('FAIL: ' + msg);
    try { notify([]); } catch (e) {}
    running = false;
    removeOverlay();
  }

  function overlay(text) {
    let el = document.getElementById('__ms_v3');
    if (!el) {
      el = document.createElement('div');
      el.id = '__ms_v3';
      el.style.cssText = `position:fixed;top:12px;right:12px;z-index:999999;background:linear-gradient(135deg,#1a73e8,#0d47a1);color:#fff;padding:14px 22px;border-radius:10px;font:bold 14px/1.4 'Segoe UI',Arial,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.35);pointer-events:none;max-width:360px;word-wrap:break-word;`;
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
      el.innerHTML = '✅ <b>Selesai!</b> Buka popup extension untuk export.';
      setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 1s'; }, 8000);
      setTimeout(() => { el.remove(); }, 9500);
    }
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
})();
