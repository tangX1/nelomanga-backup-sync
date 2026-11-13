# Nelomanga Backup Sync

A Tampermonkey userscript that lets you upload your **Futon** or **Tachiyomi/Mihon** manga reader backup and sync your bookmarks and reading progress to [nelomanga.net](https://nelomanga.net).

## Features

- **Drag-and-drop upload** — drop your backup file right onto the page
- **Multi-format support** — handles `.tachibk` (Tachiyomi/Mihon protobuf) and `.bk`/`.zip` (Futon JSON) backups
- **Bookmark sync** — automatically bookmarks all manga from your library
- **Reading progress sync** — marks the last chapter you read on each manga
- **Deduplication** — merges duplicate entries and keeps the highest progress
- **Live progress UI** — real-time log with color-coded status for each manga
- **Error reporting** — detailed failure tracking with downloadable JSON report
- **Minimizable panel** — collapse the UI to a small pill while it runs in the background

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) for your browser
2. Click the link below to install the script (or create a new script and paste the contents):

   **[Install nelomanga-backup-sync.user.js](nelomanga-backup-sync.user.js)**

3. Navigate to [nelomanga.net](https://nelomanga.net) — a star button (★) appears in the bottom-right corner

## Usage

1. **Log in** to your nelomanga.net account
2. Click the **★ button** to open the sync panel
3. **Drop your backup file** onto the upload zone (or click Browse)
4. Review the extracted manga list in the preview table
5. Click **Start Sync**
6. Watch the live log as bookmarks and progress are synced
7. When finished, view any failures or download the full report

## Supported Backup Formats

| Format | Extension | Source App | Bookmarks | Reading Progress |
|--------|-----------|------------|-----------|-----------------|
| Tachiyomi/Mihon Backup | `.tachibk` | Tachiyomi, Mihon, TachiyomiSY | Yes | Yes (if chapters included) |
| Futon Backup | `.bk`, `.zip` | Futon | Yes | Yes |

### How progress is calculated

- **Futon `.bk`** — uses `percent × total_chapters` from the reading history to estimate the last chapter read
- **Tachiyomi `.tachibk`** — reads chapter entries marked as read and extracts chapter numbers from URLs

## How It Works

The script runs entirely in your browser on nelomanga.net. No data is sent to any third-party server.

1. **Decode** — `.tachibk` files are decompressed (gzip) and decoded (protobuf) in-browser using [pako](https://github.com/nicedoc/pako). `.bk`/`.zip` files are extracted using [JSZip](https://stuk.github.io/jszip/). All parsing happens client-side.

2. **Extract** — manga entries are pulled from the backup with their URL slugs and reading progress. Duplicates are merged, keeping the highest chapter number.

3. **Bookmark** — for each manga, the script fetches its page on nelomanga to find the internal `comic_id`, then calls the bookmark API.

4. **Sync Progress** — if reading progress exists, the script fetches the specific chapter page to find the internal `chapter_id`, then calls the view-count API to mark it as read.

5. **Report** — every result (success, skipped, or failed) is logged. Failures include the exact error reason. The full report can be downloaded as JSON.

## Error Report

After syncing, you can download a JSON report containing:

```json
{
  "timestamp": "2024-01-15T12:00:00.000Z",
  "totalProcessed": 97,
  "summary": {
    "bookmarkSuccess": 85,
    "bookmarkExists": 7,
    "bookmarkFailed": 5,
    "progressSuccess": 52,
    "progressFailed": 3,
    "progressSkipped": 42
  },
  "failed": [ ... ],
  "allResults": [ ... ]
}
```

Each failed entry includes:
- `title` — manga name
- `slug` — URL slug used
- `targetChapter` — chapter number attempted
- `errors` — array of specific error messages

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Cloudflare challenge" errors | Refresh nelomanga.net normally, solve any captcha, then retry |
| "Not logged in" warning | Log in to your nelomanga account before opening the panel |
| Many 404 errors on chapters | The chapter numbering in the backup may not match nelomanga's URL format |
| Script doesn't appear | Make sure Tampermonkey is enabled and the script matches `nelomanga.net` |
| Rate limiting (429 errors) | The script auto-delays 2s between requests — if still limited, wait and retry |

## License

MIT
