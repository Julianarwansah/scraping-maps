// Background service worker - orchestrates scraping flow
// V4: Multi-query batch + notifications + badge

// Track active scrape sessions
const activeSessions = new Map();

// Batch scrape state
let batchState = null;

// ── Badge helpers ──
function setBadge(text, color) {
  chrome.action.setBadgeText({ text: text || '' });
  chrome.action.setBadgeBackgroundColor({ color: color || '#1a73e8' });
}

function clearBadge() {
  chrome.action.setBadgeText({ text: '' });
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

    activeSessions.set('current', { query: searchQuery, startTime: Date.now(), speed: message.speed || 'normal' });
    setBadge('...', '#1a73e8');

    chrome.tabs.create(
      { url: `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}` },
      (tab) => {
        if (chrome.runtime.lastError) {
          console.error('[BG] Failed to create tab:', chrome.runtime.lastError);
          activeSessions.delete('current');
          sendResponse({ status: 'error', error: chrome.runtime.lastError.message });
          return;
        }
        setupTabListener(tab.id, searchQuery, message.speed || 'normal');
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
      speed: message.speed || 'normal'
    };

    // Start first query
    startBatchQuery();

    sendResponse({ status: 'started' });
    return false;
  }

  // ── Content script -> BG: scrape results for current query ──
  if (message.action === 'scrapeResults') {
    const count = message.results?.length || 0;
    console.log(`[BG] Received ${count} results`);

    // Check if we're in batch mode
    if (batchState) {
      batchState.allResults.push(...message.results);

      // Update badge with total collected
      setBadge(String(batchState.allResults.length), '#1a73e8');

      // Notify popup of progress
      const { currentIndex, queries, allResults } = batchState;
      chrome.runtime.sendMessage({
        action: 'batchProgress',
        current: currentIndex + 1,
        total: queries.length,
        query: queries[currentIndex],
        collected: allResults.length
      }).catch(() => {});

      // Move to next query
      batchState.currentIndex++;

      if (batchState.currentIndex < batchState.queries.length) {
        // Small delay before next query
        activeSessions.delete('current');
        setTimeout(() => startBatchQuery(), 3000);
      } else {
        // All done
        const finalResults = batchState.allResults;
        const batchQueries = batchState.queries;
        batchState = null;
        activeSessions.delete('current');

        setBadge(String(finalResults.length), '#34a853');
        notify('Batch Scrape Selesai!', `${finalResults.length} data dari ${batchQueries.length} keyword`);
        setTimeout(clearBadge, 30000);

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
    } else {
      // Single scrape mode
      activeSessions.delete('current');
      setBadge(String(count), count > 0 ? '#34a853' : '#e67700');
      if (count > 0) {
        notify('Scrape Selesai!', `${count} data bisnis ditemukan`);
      } else {
        notify('Scrape Selesai', 'Tidak ada hasil ditemukan');
      }
      chrome.runtime.sendMessage(message).catch(() => {
        chrome.storage.local.set({
          lastScrapeResults: message.results,
          lastScrapeTime: Date.now()
        });
      });
      // Clear badge after 30s
      setTimeout(clearBadge, 30000);
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

// ── Start a single query in batch mode ──
function startBatchQuery() {
  if (!batchState) return;

  const query = batchState.queries[batchState.currentIndex];
  console.log(`[BG] Batch query ${batchState.currentIndex + 1}/${batchState.queries.length}: "${query}"`);

  activeSessions.set('current', { query, startTime: Date.now() });

  chrome.tabs.create(
    { url: `https://www.google.com/maps/search/${encodeURIComponent(query)}` },
    (tab) => {
      if (chrome.runtime.lastError) {
        console.error('[BG] Failed to create batch tab:', chrome.runtime.lastError);
        // Skip this query, try next
        batchState.currentIndex++;
        if (batchState.currentIndex < batchState.queries.length) {
          setTimeout(() => startBatchQuery(), 1000);
        } else {
          const finalResults = batchState.allResults;
          batchState = null;
          activeSessions.delete('current');
          chrome.runtime.sendMessage({
            action: 'batchComplete',
            results: finalResults
          }).catch(() => {});
        }
        return;
      }
      setupTabListener(tab.id, query, batchState.speed);
    }
  );
}

// ── Tab listener setup ──
function setupTabListener(tabId, searchQuery, speed) {
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
          speed: speed
        }).then(() => {
          console.log('[BG] Sent startScraping to tab', tabId);
        }).catch(err => {
          console.error('[BG] Failed to send startScraping:', err);
          chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
          }).then(() => {
            return chrome.tabs.sendMessage(tabId, {
              action: 'startScraping',
              query: searchQuery,
              speed: speed
            });
          }).catch(e => {
            console.error('[BG] Manual injection also failed:', e);
            activeSessions.delete('current');
          });
        });
      };

      setTimeout(sendStart, 2000);
    }
  };

  chrome.tabs.onUpdated.addListener(listener);

  // Safety timeout: remove listener after 60s (longer for batch)
  setTimeout(() => {
    if (!listenerRemoved) {
      listenerRemoved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      console.warn('[BG] Tab listener timed out for tab', tabId);
      activeSessions.delete('current');
    }
  }, 60000);
}
