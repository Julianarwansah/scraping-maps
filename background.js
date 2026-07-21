// Background service worker - orchestrates scraping flow
// Fixed: listener leak, error handling, retry logic

// Track active scrape sessions to prevent duplicates
const activeSessions = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'scrapeData') {
    const searchQuery = message.query?.trim();
    if (!searchQuery) {
      sendResponse({ status: 'error', error: 'Empty query' });
      return false;
    }

    // Prevent duplicate scrapes
    if (activeSessions.has('current')) {
      sendResponse({ status: 'error', error: 'Scrape already in progress' });
      return false;
    }

    activeSessions.set('current', { query: searchQuery, startTime: Date.now() });

    chrome.tabs.create(
      { url: `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}` },
      (tab) => {
        if (chrome.runtime.lastError) {
          console.error('[BG] Failed to create tab:', chrome.runtime.lastError);
          activeSessions.delete('current');
          sendResponse({ status: 'error', error: chrome.runtime.lastError.message });
          return;
        }

        setupTabListener(tab.id, searchQuery);
      }
    );

    sendResponse({ status: 'started' });
    return false;
  }

  // Content script -> Popup: forward scrape results
  if (message.action === 'scrapeResults') {
    const count = message.results?.length || 0;
    console.log(`[BG] Received ${count} results, forwarding to popup`);
    activeSessions.delete('current');

    // Forward to popup (all extension pages listening)
    chrome.runtime.sendMessage(message).catch(() => {
      // Popup might be closed — store results for later retrieval
      chrome.storage.local.set({
        lastScrapeResults: message.results,
        lastScrapeTime: Date.now()
      });
    });

    sendResponse({ status: 'received', count });
    return false;
  }

  // Popup requests stored results (after reopen)
  if (message.action === 'getStoredResults') {
    chrome.storage.local.get(['lastScrapeResults', 'lastScrapeTime'], (data) => {
      if (data.lastScrapeResults && data.lastScrapeTime) {
        // Only return results from last 10 minutes
        if (Date.now() - data.lastScrapeTime < 600000) {
          sendResponse({ status: 'ok', results: data.lastScrapeResults });
          return;
        }
      }
      sendResponse({ status: 'empty' });
    });
    return true; // async response
  }

  return false;
});

function setupTabListener(tabId, searchQuery) {
  let listenerRemoved = false;

  const listener = (changedTabId, changeInfo) => {
    if (changedTabId !== tabId) return;

    // Only act when the page is fully loaded
    if (changeInfo.status === 'complete') {
      if (listenerRemoved) return;
      listenerRemoved = true;
      chrome.tabs.onUpdated.removeListener(listener);

      // Send start message to content script
      // Content script is auto-injected via manifest content_scripts
      const sendStart = () => {
        chrome.tabs.sendMessage(tabId, {
          action: 'startScraping',
          query: searchQuery
        }).then(() => {
          console.log('[BG] Sent startScraping to tab', tabId);
        }).catch(err => {
          console.error('[BG] Failed to send startScraping:', err);
          // Content script might not be injected yet, try injecting manually
          chrome.scripting.executeScript({
            target: { tabId },
            files: ['content.js']
          }).then(() => {
            return chrome.tabs.sendMessage(tabId, {
              action: 'startScraping',
              query: searchQuery
            });
          }).catch(e => {
            console.error('[BG] Manual injection also failed:', e);
            activeSessions.delete('current');
          });
        });
      };

      // Small delay to let Google Maps settle after load
      setTimeout(sendStart, 2000);
    }
  };

  chrome.tabs.onUpdated.addListener(listener);

  // Safety timeout: remove listener after 30s to prevent leaks
  setTimeout(() => {
    if (!listenerRemoved) {
      listenerRemoved = true;
      chrome.tabs.onUpdated.removeListener(listener);
      console.warn('[BG] Tab listener timed out for tab', tabId);
      activeSessions.delete('current');
    }
  }, 30000);
}
