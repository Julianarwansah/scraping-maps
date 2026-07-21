// ============================================================
// Popup Script — Google Maps Scraper V4
// Multi-query batch + CSV export + history
// Audit-fixed: removed dead code, optimized DOM queries,
//              capped history storage, fixed event listener leak
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const btn  = document.getElementById('scrapeButton');
  const stat = document.getElementById('status');
  const textarea = document.getElementById('searchQuery');
  const queryCount = document.getElementById('queryCount');
  const themeToggle = document.getElementById('themeToggle');

  // ── Theme toggle ──
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    themeToggle.textContent = theme === 'dark' ? '☀️' : '🌙';
  }
  chrome.storage.local.get(['theme'], d => {
    applyTheme(d.theme || 'light');
  });
  themeToggle.addEventListener('click', () => {
    const current = document.documentElement.getAttribute('data-theme');
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    chrome.storage.local.set({ theme: next });
  });

  // ── Query counter ──
  function updateQueryCount() {
    const queries = parseQueries(textarea.value);
    queryCount.textContent = queries.length > 0 ? `${queries.length} keyword siap` : '';
  }
  textarea.addEventListener('input', updateQueryCount);

  // ── Restore saved format ──
  chrome.storage.local.get(['exportFormat'], d => {
    if (d.exportFormat) {
      const radio = document.querySelector(`input[name="exportFormat"][value="${d.exportFormat}"]`);
      if (radio) radio.checked = true;
    }
  });

  // ── Save format on change ──
  document.querySelectorAll('input[name="exportFormat"]').forEach(r => {
    r.addEventListener('change', () => {
      chrome.storage.local.set({ exportFormat: r.value });
    });
  });

  // ── Restore speed setting ──
  const speedSelect = document.getElementById('speedSelect');
  chrome.storage.local.get(['scrapeSpeed'], d => {
    if (d.scrapeSpeed) speedSelect.value = d.scrapeSpeed;
  });
  speedSelect.addEventListener('change', () => {
    chrome.storage.local.set({ scrapeSpeed: speedSelect.value });
  });

  // ── Check stored results from previous scrape ──
  chrome.storage.local.get(['lastResults', 'lastTime'], d => {
    if (d.lastResults?.length && d.lastTime && (Date.now() - d.lastTime < 3600000)) {
      stat.textContent = `📋 Hasil sebelumnya: ${d.lastResults.length} data (1 jam terakhir)`;
      stat.style.color = 'var(--accent)';
      addExportBtn(d.lastResults);
    }
  });

  // ── Restore last query ──
  chrome.storage.local.get(['lastQuery'], d => {
    if (d.lastQuery) textarea.value = d.lastQuery;
    updateQueryCount();
  });

  // ── Load history ──
  loadHistory();

  // ── Column selector ──
  initColumnSelector();

  // ── Clear history button ──
  document.getElementById('clearHistoryBtn').addEventListener('click', () => {
    chrome.storage.local.remove('scrapeHistory', () => {
      loadHistory();
    });
  });

  // ── Scrape button ──
  btn.addEventListener('click', () => {
    const queries = parseQueries(textarea.value);
    if (queries.length === 0) {
      stat.textContent = '⚠️ Masukkan keyword pencarian.';
      stat.style.color = 'var(--danger)';
      return;
    }

    chrome.storage.local.set({ lastQuery: textarea.value });

    btn.disabled = true;
    removeExportBtn();

    const speed = speedSelect.value;

    if (queries.length === 1) {
      startScrape(queries[0], stat, btn, speed);
    } else {
      startBatchScrape(queries, stat, btn, speed);
    }
  });
});

// ── Parse queries from textarea ──
function parseQueries(text) {
  return text.split('\n')
    .map(q => q.trim())
    .filter(q => q.length > 0);
}

// ── Single query scrape ──
function startScrape(query, stat, btn, speed) {
  stat.textContent = `Membuka Google Maps untuk "${query}"...`;
  stat.style.color = 'var(--text-muted)';

  chrome.runtime.sendMessage({ action: 'scrapeData', query, speed }, res => {
    if (chrome.runtime.lastError) {
      stat.textContent = '❌ ' + chrome.runtime.lastError.message;
      stat.style.color = 'var(--danger)';
      resetBtn(btn);
    } else if (res?.status === 'started') {
      stat.textContent = '🗺️ Tab Maps terbuka! Scraping berjalan...';
      stat.style.color = 'var(--success)';
    } else if (res?.status === 'error') {
      stat.textContent = '⚠️ ' + (res.error || 'Sedang berjalan.');
      stat.style.color = 'var(--danger)';
      resetBtn(btn);
    }
  });
}

// ── Batch scrape ──
function startBatchScrape(queries, stat, btn, speed) {
  stat.textContent = `🚀 Batch scrape: ${queries.length} keyword...`;
  stat.style.color = 'var(--text-muted)';

  chrome.runtime.sendMessage({
    action: 'batchScrape',
    queries,
    speed
  }, res => {
    if (chrome.runtime.lastError) {
      stat.textContent = '❌ ' + chrome.runtime.lastError.message;
      stat.style.color = 'var(--danger)';
      resetBtn(btn);
    } else if (res?.status === 'started') {
      stat.textContent = `🗺️ Batch scrape dimulai! ${queries.length} keyword akan diproses satu per satu...`;
      stat.style.color = 'var(--success)';
    } else if (res?.status === 'error') {
      stat.textContent = '⚠️ ' + (res.error || 'Gagal memulai batch scrape.');
      stat.style.color = 'var(--danger)';
      resetBtn(btn);
    }
  });
}

// ── Receive results ──
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  const stat = document.getElementById('status');
  const btn  = document.getElementById('scrapeButton');

  if (msg.action === 'scrapeResults') {
    resetBtn(btn);

    if (msg.results?.length > 0) {
      stat.textContent = `✅ ${msg.results.length} data ditemukan! Exporting...`;
      stat.style.color = 'var(--success)';

      chrome.storage.local.set({ lastResults: msg.results, lastTime: Date.now() });
      saveToHistory(msg.query || 'Scrape', msg.results);

      setTimeout(() => exportData(msg.results), 150);
    } else {
      stat.textContent = '⚠️ Tidak ada hasil. Coba keyword lain.';
      stat.style.color = 'var(--warning)';
    }
  }

  if (msg.action === 'batchProgress') {
    const { current, total, query, collected } = msg;
    stat.textContent = `🗺️ [${current}/${total}] Scraping "${query}"... (${collected} data terkumpul)`;
    stat.style.color = 'var(--accent)';
  }

  if (msg.action === 'batchComplete') {
    resetBtn(btn);

    if (msg.results?.length > 0) {
      const deduped = deduplicate(msg.results);
      const removed = msg.results.length - deduped.length;

      let statusMsg = `✅ Batch selesai! ${deduped.length} data`;
      if (removed > 0) statusMsg += ` (${removed} duplikat dihapus)`;
      stat.textContent = statusMsg;
      stat.style.color = 'var(--success)';

      chrome.storage.local.set({ lastResults: deduped, lastTime: Date.now() });
      setTimeout(() => exportData(deduped), 150);
    } else {
      stat.textContent = '⚠️ Tidak ada hasil dari semua keyword.';
      stat.style.color = 'var(--warning)';
    }
  }

  return true;
});

// ============================================================
//  DATA DEDUPLICATION
// ============================================================
function deduplicate(results) {
  const seen = new Map();
  return results.filter(r => {
    const key = ((r.name || '') + '|' + (r.address || '')).toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
}

// ============================================================
//  FORMAT EXPORT (Excel / CSV)
// ============================================================
function getSelectedFormat() {
  const checked = document.querySelector('input[name="exportFormat"]:checked');
  return checked ? checked.value : 'xlsx';
}

function exportData(results) {
  const format = getSelectedFormat();
  if (format === 'csv') {
    exportCSV(results);
  } else {
    exportExcel(results);
  }
}

// ============================================================
//  CSV EXPORT
// ============================================================
function exportCSV(results) {
  const selectedKeys = getSelectedColumns();
  const selectedCols = COLUMNS.filter(col => selectedKeys.includes(col.key));
  const headers = ['No', ...selectedCols.map(col => col.label)];

  const rows = [headers.join(',')];
  results.forEach((r, i) => {
    const row = [i + 1];
    selectedCols.forEach(col => {
      const val = r[col.key];
      row.push(col.key.startsWith('has') ? (val ? 'Yes' : '') : csvEscape(val));
    });
    rows.push(row.join(','));
  });

  const csvContent = rows.join('\n');
  const blob = new Blob(['﻿' + csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `google_maps_${Date.now()}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);

  stat.textContent = `✅ Exported ${results.length} data ke CSV!`;
  stat.style.color = 'var(--success)';
}

function csvEscape(val) {
  const s = (val || '').toString();
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ============================================================
//  EXCEL EXPORT
// ============================================================
function exportExcel(results) {
  if (typeof XLSX === 'undefined') {
    document.getElementById('status').textContent = '❌ XLSX library tidak ada.';
    return;
  }

  const selectedKeys = getSelectedColumns();
  const selectedCols = COLUMNS.filter(col => selectedKeys.includes(col.key));
  const H = ['No', ...selectedCols.map(col => col.label)];

  const rows = [H];
  results.forEach((r, i) => {
    const row = [i + 1];
    selectedCols.forEach(col => {
      const val = r[col.key];
      row.push(col.key.startsWith('has') ? (val ? 'Yes' : '') : (val || ''));
    });
    rows.push(row);
  });

  try {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);

    const colWidths = { name:35, rating:8, reviews:10, category:28, phone:22, address:55, website:40, email:32, hours:35, priceLevel:10, hasDelivery:10, hasTakeout:10, hasDineIn:10, plusCode:15, googleMapsUrl:60 };
    ws['!cols'] = [{ wch: 5 }, ...selectedCols.map(col => ({ wch: colWidths[col.key] || 15 }))];

    XLSX.utils.book_append_sheet(wb, ws, 'Google Maps Data');

    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    download(buf, `google_maps_${Date.now()}.xlsx`);

    const stat = document.getElementById('status');
    stat.textContent = `✅ Exported ${results.length} data ke Excel!`;
    stat.style.color = 'var(--success)';
  } catch (e) {
    console.error('[Popup] Export error:', e);
    document.getElementById('status').textContent = '❌ Export gagal: ' + e.message;
  }
}

// ============================================================
//  HELPERS
// ============================================================
function download(buf, name) {
  const blob = new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function resetBtn(btn) {
  if (btn) { btn.disabled = false; btn.textContent = '🔍 Scrape Data'; }
}

function addExportBtn(results) {
  removeExportBtn();
  const b = document.createElement('button');
  b.id = 'exportStoredBtn';
  b.textContent = '📥 Export Hasil Tersimpan';
  b.style.cssText = 'width:100%;margin-top:8px;padding:8px;background:var(--success);color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer';
  b.onclick = () => { exportData(results); removeExportBtn(); };
  document.getElementById('status')?.parentNode?.insertBefore(b, document.getElementById('status').nextSibling);
}

function removeExportBtn() {
  document.getElementById('exportStoredBtn')?.remove();
}

// ============================================================
//  SCRAPE HISTORY (capped: max 10 entries, summary only)
// ============================================================
const MAX_HISTORY = 10;
const MAX_HISTORY_RESULTS = 50; // Store max 50 results per history entry (to save storage)

function saveToHistory(query, results) {
  chrome.storage.local.get(['scrapeHistory'], d => {
    const history = d.scrapeHistory || [];
    // Store summary + first N results to save storage
    const storedResults = results.length > MAX_HISTORY_RESULTS
      ? results.slice(0, MAX_HISTORY_RESULTS)
      : results;
    history.unshift({
      id: Date.now(),
      query,
      count: results.length,
      fullCount: results.length,
      timestamp: Date.now(),
      results: storedResults,
      truncated: results.length > MAX_HISTORY_RESULTS
    });
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    chrome.storage.local.set({ scrapeHistory: history }, () => {
      loadHistory();
    });
  });
}

function loadHistory() {
  chrome.storage.local.get(['scrapeHistory'], d => {
    const history = d.scrapeHistory || [];
    const list = document.getElementById('historyList');
    const countEl = document.getElementById('historyCount');
    countEl.textContent = history.length;

    if (history.length === 0) {
      list.innerHTML = '<div style="font-size:11px;color:var(--text-muted);text-align:center;padding:12px">Belum ada riwayat</div>';
      return;
    }

    list.innerHTML = history.map(item => {
      const date = new Date(item.timestamp);
      const timeStr = date.toLocaleDateString('id-ID', {
        day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      });
      const truncLabel = item.truncated ? ' (dipotong)' : '';
      return `
        <div class="history-item">
          <div class="history-info">
            <div class="history-query">${escapeHtml(item.query)}</div>
            <div class="history-meta">${item.count} data${truncLabel} · ${timeStr}</div>
          </div>
          <button class="history-export" data-id="${item.id}">📥 Export</button>
        </div>
      `;
    }).join('');

    // Use event delegation instead of attaching listeners to each button
    list.onclick = (e) => {
      const exportBtn = e.target.closest('.history-export');
      if (!exportBtn) return;
      const id = parseInt(exportBtn.dataset.id);
      const entry = history.find(h => h.id === id);
      if (entry?.results?.length) {
        exportData(entry.results);
      }
    };
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ============================================================
//  COLUMN SELECTOR
// ============================================================
const COLUMNS = [
  { key: 'name',          label: 'Business Name' },
  { key: 'rating',        label: 'Rating' },
  { key: 'reviews',       label: 'Reviews' },
  { key: 'category',      label: 'Kategori' },
  { key: 'phone',         label: 'Telepon' },
  { key: 'address',       label: 'Alamat' },
  { key: 'website',       label: 'Website' },
  { key: 'email',         label: 'Email' },
  { key: 'hours',         label: 'Jam Buka' },
  { key: 'priceLevel',    label: 'Level Harga' },
  { key: 'hasDelivery',   label: 'Delivery' },
  { key: 'hasTakeout',    label: 'Takeout' },
  { key: 'hasDineIn',     label: 'Dine-in' },
  { key: 'plusCode',      label: 'Plus Code' },
  { key: 'googleMapsUrl', label: 'Google Maps URL' },
];

function initColumnSelector() {
  const container = document.getElementById('columnSelector');
  const allColsBtn = document.getElementById('selectAllCols');
  const noneColsBtn = document.getElementById('deselectAllCols');

  container.innerHTML = COLUMNS.map(col => `
    <label class="col-opt">
      <input type="checkbox" name="col" value="${col.key}" checked> ${col.label}
    </label>
  `).join('');

  chrome.storage.local.get(['selectedColumns'], d => {
    if (d.selectedColumns) {
      container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
        cb.checked = d.selectedColumns.includes(cb.value);
      });
    }
  });

  container.addEventListener('change', saveColumnSelection);

  allColsBtn.addEventListener('click', () => {
    container.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = true);
    saveColumnSelection();
  });
  noneColsBtn.addEventListener('click', () => {
    container.querySelectorAll('input[type="checkbox"]').forEach(cb => cb.checked = false);
    saveColumnSelection();
  });
}

function saveColumnSelection() {
  const selected = Array.from(document.querySelectorAll('#columnSelector input[type="checkbox"]:checked'))
    .map(cb => cb.value);
  chrome.storage.local.set({ selectedColumns: selected });
}

function getSelectedColumns() {
  return Array.from(document.querySelectorAll('#columnSelector input[type="checkbox"]:checked'))
    .map(cb => cb.value);
}

function getExportHeaders() {
  const cols = getSelectedColumns();
  return COLUMNS.filter(col => cols.includes(col.key)).map(col => col.label);
}
