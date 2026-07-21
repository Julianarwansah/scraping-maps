// ============================================================
// Popup Script — Google Maps Scraper V3
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  const btn  = document.getElementById('scrapeButton');
  const stat = document.getElementById('status');

  // ── XLSX check ──
  if (typeof XLSX === 'undefined') {
    stat.textContent = '❌ Excel library gagal load. Reload extension.';
    stat.style.color = 'red';
    btn.disabled = true;
    return;
  }

  // ── Check stored results from previous scrape ──
  chrome.storage.local.get(['lastResults', 'lastTime'], d => {
    if (d.lastResults?.length && d.lastTime && (Date.now() - d.lastTime < 3600000)) {
      stat.textContent = `📋 Hasil sebelumnya: ${d.lastResults.length} data (1 jam terakhir)`;
      stat.style.color = '#1a73e8';
      addExportBtn(d.lastResults);
    }
  });

  // ── Scrape button ──
  btn.addEventListener('click', () => {
    const q = document.getElementById('searchQuery')?.value?.trim();
    if (!q) { stat.textContent = '⚠️ Masukkan keyword pencarian.'; stat.style.color = 'red'; return; }

    btn.disabled = true;
    btn.textContent = '⏳ Scraping...';
    stat.textContent = `Membuka Google Maps untuk "${q}"...`;
    stat.style.color = '#666';
    removeExportBtn();

    chrome.runtime.sendMessage({ action: 'scrapeData', query: q }, res => {
      if (chrome.runtime.lastError) {
        stat.textContent = '❌ ' + chrome.runtime.lastError.message;
        stat.style.color = 'red';
        resetBtn();
      } else if (res?.status === 'started') {
        stat.textContent = '🗺️ Tab Maps terbuka! Scraping berjalan di tab tersebut...';
        stat.style.color = '#0d7d3f';
      } else if (res?.status === 'error') {
        stat.textContent = '⚠️ ' + (res.error || 'Sedang berjalan.');
        stat.style.color = 'red';
        resetBtn();
      }
    });
  });
});

// ── Receive results ──
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg.action === 'scrapeResults') {
    const stat = document.getElementById('status');
    const btn  = document.getElementById('scrapeButton');
    resetBtn();

    if (msg.results?.length > 0) {
      stat.textContent = `✅ ${msg.results.length} data ditemukan! Exporting...`;
      stat.style.color = '#0d7d3f';

      // Store for recovery
      chrome.storage.local.set({ lastResults: msg.results, lastTime: Date.now() });

      setTimeout(() => exportExcel(msg.results), 150);
    } else {
      stat.textContent = '⚠️ Tidak ada hasil. Coba keyword lain.';
      stat.style.color = '#e67700';
    }
  }
  return true;
});

// ============================================================
//  EXCEL EXPORT
// ============================================================
function exportExcel(results) {
  if (typeof XLSX === 'undefined') {
    document.getElementById('status').textContent = '❌ XLSX library tidak ada.';
    return;
  }

  const H = [
    'No',
    'Business Name',
    'Rating',
    'Reviews',
    'Category',
    'Phone',
    'Address',
    'Website',
    'Email',
    'Hours',
    'Price Level',
    'Delivery',
    'Takeout',
    'Dine-in',
    'Plus Code',
    'Google Maps URL'
  ];

  const rows = [H];
  results.forEach((r, i) => {
    rows.push([
      i + 1,
      r.name          || '',
      r.rating        || '',
      r.reviews       || '',
      r.category      || '',
      r.phone         || '',
      r.address       || '',
      r.website       || '',
      r.email         || '',
      r.hours         || '',
      r.priceLevel    || '',
      r.hasDelivery   ? 'Yes' : '',
      r.hasTakeout    ? 'Yes' : '',
      r.hasDineIn     ? 'Yes' : '',
      r.plusCode      || '',
      r.googleMapsUrl || ''
    ]);
  });

  try {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);

    ws['!cols'] = [
      { wch: 5 },   // No
      { wch: 35 },  // Name
      { wch: 8 },   // Rating
      { wch: 10 },  // Reviews
      { wch: 28 },  // Category
      { wch: 22 },  // Phone
      { wch: 55 },  // Address
      { wch: 40 },  // Website
      { wch: 32 },  // Email
      { wch: 35 },  // Hours
      { wch: 10 },  // Price
      { wch: 10 },  // Delivery
      { wch: 10 },  // Takeout
      { wch: 10 },  // Dine-in
      { wch: 15 },  // Plus Code
      { wch: 60 },  // URL
    ];

    XLSX.utils.book_append_sheet(wb, ws, 'Google Maps Data');

    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    download(buf, `google_maps_${ts()}.xlsx`);

    const stat = document.getElementById('status');
    stat.textContent = `✅ Exported ${results.length} data ke Excel!`;
    stat.style.color = '#0d7d3f';
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

function ts() { return Date.now(); }

function resetBtn() {
  const btn = document.getElementById('scrapeButton');
  if (btn) { btn.disabled = false; btn.textContent = '🔍 Scrape Data'; }
}

function addExportBtn(results) {
  removeExportBtn();
  const b = document.createElement('button');
  b.id = 'exportStoredBtn';
  b.textContent = '📥 Export Hasil Tersimpan';
  b.style.cssText = 'width:100%;margin-top:8px;padding:8px;background:#34a853;color:#fff;border:none;border-radius:6px;font-size:13px;cursor:pointer';
  b.onclick = () => { exportExcel(results); removeExportBtn(); };
  document.getElementById('status')?.parentNode?.insertBefore(b, document.getElementById('status').nextSibling);
}

function removeExportBtn() {
  document.getElementById('exportStoredBtn')?.remove();
}
