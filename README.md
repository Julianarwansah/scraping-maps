# Google Maps Web Scraper

Chrome extension untuk scraping data bisnis dari Google Maps.

## Fitur

- Cari bisnis berdasarkan keyword (contoh: sports, restaurant, hotel)
- Scrape detail lengkap: nama, rating, review, kategori, telepon, alamat, website, email, jam buka
- Export otomatis ke file Excel (.xlsx)
- Visual overlay progress di tab Google Maps
- Resume: hasil scrape tersimpan otomatis (bisa export meski popup sudah ditutup)

## Data Yang Di-Scrape

| Field | Keterangan |
|---|---|
| Business Name | Nama bisnis |
| Rating | Bintang (1-5) |
| Reviews | Jumlah review |
| Category | Kategori bisnis |
| Phone | Nomor telepon |
| Address | Alamat lengkap |
| Website | URL website |
| Email | Email (jika tersedia di listing) |
| Hours | Jam operasional |
| Plus Code | Kode lokasi |
| Google Maps URL | Link Google Maps |

## Instalasi

1. Buka Chrome, ketik `chrome://extensions` di address bar
2. Enable **Developer mode** (toggle pojok kanan atas)
3. Klik **"Load unpacked"**
4. Pilih folder project ini
5. Extension akan muncul di toolbar Chrome

## Cara Pakai

1. Klik icon extension di toolbar
2. Ketik search query (misal: `sports`, `restaurant Jakarta`, `hotel Bali`)
3. Klik **"Scrape Data"**
4. Tab baru akan terbuka ke Google Maps
5. Tunggu scraping selesai (ada overlay progress di tab Maps)
6. File Excel `.xlsx` akan otomatis ter-download

## Catatan

- Scraping otomatis klik satu per satu ke detail setiap bisnis
- Waktu scraping tergantung jumlah hasil (±2-3 detik per bisnis)
- Google Maps jarang menampilkan email di listing, field email mungkin kosong untuk sebagian besar hasil
- Hasil scrape tersimpan otomatis selama 10 menit (bisa export ulang dari popup)
