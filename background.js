// Background service worker - orchestrates scraping flow
// V4: Multi-query batch + notifications + badge
// Audit-fixed: session cleanup, badge timer management, tab close detection

// Track active scrape sessions
const activeSessions = new Map();

// Batch scrape state
let batchState = null;

// Badge timer tracking (to cancel old timers)
let badgeTimer = null;

// ── Badge helpers ──
function setBadge(text, color) {
  chrome.action.setBadgeText({ text: text || '' });
  chrome.action.setBadgeBackgroundColor({ color: color || '#1a73e8' });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: '' });
}

function scheduleBadgeClear(delayMs) {
  if (badgeTimer) clearTimeout(badgeTimer);
  badgeTimer = setTimeout(() => {
    clearBadge();
    badgeTimer = null;
  }, delayMs);
}

// ── Notification helper ──
function notify(title, message) {
  chrome.notifications.create({
    type: 'basic',
    iconUrl: 'images/icon128.png',
    title,
    message,
    priority: 1
  });
}

// ── Build Google Maps search URL ──
// Handles both keyword queries and coordinate-based queries (@lat,lng,zoom)
function buildSearchUrl(query) {
  // If query contains @ (coordinate-based), split into keyword and coords
  // Format: "keyword@lat,lng,zoom" or just "@lat,lng,zoom"
  const atIdx = query.indexOf('@');
  if (atIdx !== -1) {
    const keyword = query.substring(0, atIdx);
    const coords = query.substring(atIdx); // e.g., @-6.2088,106.8456,14z
    if (keyword) {
      return `https://www.google.com/maps/search/${encodeURIComponent(keyword)}/${coords}`;
    }
    return `https://www.google.com/maps/search/${coords}`;
  }
  return `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
}

// ── Cleanup session and related resources ──
function cleanupSession(tabId) {
  activeSessions.delete('current');
  if (tabId) {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ── Listen for tab close to cleanup sessions ──
chrome.tabs.onRemoved.addListener((tabId) => {
  const session = activeSessions.get('current');
  if (session && session.tabId === tabId) {
    console.warn('[BG] Scraping tab closed by user, cleaning up session');
    activeSessions.delete('current');
    clearBadge();
    if (batchState) {
      // Skip to next or finish
      batchState.currentIndex++;
      if (batchState.currentIndex < batchState.queries.length) {
        setTimeout(() => startBatchQuery(), 1000);
      } else {
        finishBatch();
      }
    }
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ── Single scrape ──
  if (message.action === 'scrapeData') {
    const searchQuery = message.query?.trim();
    if (!searchQuery) {
      sendResponse({ status: 'error', error: 'Empty query' });
      return false;
    }

    if (activeSessions.has('current')) {
      sendResponse({ status: 'error', error: 'Scrape already in progress' });
      return false;
    }

    activeSessions.set('current', { query: searchQuery, startTime: Date.now(), speed: message.speed || 'normal', tabId: null, min: message.min || 0, max: message.max || 0 });
    setBadge('...', '#1a73e8');

    chrome.tabs.create(
      { url: buildSearchUrl(searchQuery) },
      (tab) => {
        if (chrome.runtime.lastError) {
          console.error('[BG] Failed to create tab:', chrome.runtime.lastError);
          activeSessions.delete('current');
          sendResponse({ status: 'error', error: chrome.runtime.lastError.message });
          return;
        }
        // Store tabId for close detection
        const session = activeSessions.get('current');
        if (session) session.tabId = tab.id;
        setupTabListener(tab.id, searchQuery, message.speed || 'normal', message.min || 0, message.max || 0);
      }
    );

    sendResponse({ status: 'started' });
    return false;
  }

  // ── Batch scrape ──
  if (message.action === 'batchScrape') {
    const queries = message.queries;
    if (!queries?.length) {
      sendResponse({ status: 'error', error: 'No queries provided' });
      return false;
    }

    if (activeSessions.has('current') || batchState) {
      sendResponse({ status: 'error', error: 'Scrape already in progress' });
      return false;
    }

    batchState = {
      queries,
      currentIndex: 0,
      allResults: [],
      startTime: Date.now(),
      speed: message.speed || 'normal',
      min: message.min || 0,
      max: message.max || 0
    };

    startBatchQuery();

    sendResponse({ status: 'started' });
    return false;
  }

  // ── Content script -> BG: scrape results for current query ──
  if (message.action === 'scrapeResults') {
    const count = message.results?.length || 0;
    console.log(`[BG] Received ${count} results`);

    if (batchState) {
      batchState.allResults.push(...message.results);

      setBadge(String(batchState.allResults.length), '#1a73e8');

      const { currentIndex, queries, allResults } = batchState;
      chrome.runtime.sendMessage({
        action: 'batchProgress',
        current: currentIndex + 1,
        total: queries.length,
        query: queries[currentIndex],
        collected: allResults.length
      }).catch(() => {});

      batchState.currentIndex++;

      if (batchState.currentIndex < batchState.queries.length) {
        activeSessions.delete('current');
        setTimeout(() => startBatchQuery(), 3000);
      } else {
        finishBatch();
      }
    } else {
      // Single scrape mode
      activeSessions.delete('current');
      setBadge(String(count), count > 0 ? '#34a853' : '#e67700');
      if (count > 0) {
        const warnText = message.warning ? ` (${message.warning})` : '';
        notify('Scrape Selesai!', `${count} data bisnis ditemukan${warnText}`);
      }
      chrome.runtime.sendMessage(message).catch(() => {
        chrome.storage.local.set({
          lastScrapeResults: message.results,
          lastScrapeTime: Date.now()
        });
      });
      scheduleBadgeClear(30000);
    }

    sendResponse({ status: 'received', count });
    return false;
  }

  // ── Popup requests stored results (after reopen) ──
  if (message.action === 'getStoredResults') {
    chrome.storage.local.get(['lastScrapeResults', 'lastScrapeTime'], (data) => {
      if (data.lastScrapeResults && data.lastScrapeTime) {
        if (Date.now() - data.lastScrapeTime < 600000) {
          sendResponse({ status: 'ok', results: data.lastScrapeResults });
          return;
        }
      }
      sendResponse({ status: 'empty' });
    });
    return true;
  }

  return false;
});

// ── Finish batch and send results ──
function finishBatch() {
  if (!batchState) return;

  const finalResults = batchState.allResults;
  const batchQueries = batchState.queries;
  batchState = null;
  activeSessions.delete('current');

  setBadge(String(finalResults.length), '#34a853');
  notify('Batch Scrape Selesai!', `${finalResults.length} data dari ${batchQueries.length} keyword`);
  scheduleBadgeClear(30000);

  chrome.runtime.sendMessage({
    action: 'batchComplete',
    results: finalResults
  }).catch(() => {
    chrome.storage.local.set({
      lastResults: finalResults,
      lastTime: Date.now()
    });
  });
}

// ── Start a single query in batch mode ──
function startBatchQuery() {
  if (!batchState) return;

  const query = batchState.queries[batchState.currentIndex];
  console.log(`[BG] Batch query ${batchState.currentIndex + 1}/${batchState.queries.length}: "${query}"`);

  activeSessions.set('current', { query, startTime: Date.now(), tabId: null, min: batchState.min, max: batchState.max });

  chrome.tabs.create(
    { url: buildSearchUrl(query) },
    (tab) => {
      if (chrome.runtime.lastError) {
        console.error('[BG] Failed to create batch tab:', chrome.runtime.lastError);
        batchState.currentIndex++;
        if (batchState.currentIndex < batchState.queries.length) {
          setTimeout(() => startBatchQuery(), 1000);
        } else {
          finishBatch();
        }
        return;
      }
      // Store tabId for close detection
      const session = activeSessions.get('current');
      if (session) session.tabId = tab.id;
      setupTabListener(tab.id, query, batchState.speed, batchState.min, batchState.max);
    }
  );
}

// ── Tab listener setup ──
function setupTabListener(tabId, searchQuery, speed, min, max) {
  let listenerRemoved = false;

  const listener = (changedTabId, changeInfo) => {
    if (changedTabId !== tabId) return;

    if (changeInfo.status === 'complete') {
      if (listenerRemoved) return;
      listenerRemoved = true;
      chrome.tabs.onUpdated.removeListener(listener);

      const sendStart = () => {
        chrome.tabs.sendMessage(tabId, {
          action: 'startScraping',
          query: searchQuery,
          speed: speed,
          min: min || 0,
          max: max || 0
        }).then(res => {
          console.log('[BG] Sent startScraping to tab', tabId, res);
          if (res?.status === 'error') {
            console.warn('[BG] Content script reported error:', res.error);
          }
        }).catch(err => {
          console.error('[BG] Failed to send startScraping, injecting content script...', err);
          chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
          }).then(() => {
            // Wait a bit for content script to initialize
            return new Promise(r => setTimeout(r, 500));
          }).then(() => {
            return chrome.tabs.sendMessage(tabId, {
              action: 'startScraping',
              query: searchQuery,
              speed: speed,
              min: min || 0,
              max: max || 0
            });
          }).catch(e => {
            console.error('[BG] Manual injection also failed:', e);
            activeSessions.delete('current');
            setBadge('!', '#d93025');
          });
        });
      };

      // Wait longer for Google Maps to fully load
      setTimeout(sendStart, 3000);
    }
  };

  chrome.tabs.onUpdated.addListener(listener);

  // Safety timeout: remove listener after 120s (Google Maps can be slow)
  setTimeout(() => {
    if (!listenerRemoved) {
      listenerRemoved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      console.warn('[BG] Tab listener timed out for tab', tabId);
      activeSessions.delete('current');
      clearBadge();
    }
  }, 120000);
}
