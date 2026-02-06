# Close Duplicate Tabs

A Chrome/Brave MV3 extension to close duplicate tabs with explicit rule priority:

**Pinned + Group constraints > Whitelist > Blacklist**

## Features
- Close duplicates in the **current window** or **all windows**.
- Rule engine supports **two formats per line**:
  - **Regex rules**: `re:<pattern>` / `regex:<pattern>` / `/pattern/flags`
  - **URL fragments**: literal substring (case-insensitive). No escaping needed.
- Optional safeguards:
  - Never close **pinned** tabs.
  - Treat **tab groups** as separate buckets (no cross-group closing).
  - Protect a URL that appears **exactly once** in the focused window (All windows scope).
- Fast badge updates (re-calculates immediately on window focus switch).

## Install (Developer mode)
1. Open `chrome://extensions` (or `brave://extensions`).
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `extension/` folder.

## Build a release zip
```bash
npm run build
```
The output zip is generated under `dist/`.

## Rule format
Each textarea is a newline-separated list.

### URL fragment examples
- `youtube.com/watch?v=`
- `docs.google.com`

### Regex examples
- `re:^https?://(www\.)?youtube\.com/watch\?v=`
- `/\bexample\.com\b/i`

> Notes:
> - Regex matching runs **before** URL-fragment matching.
> - Regex flags are forced to include `i` (case-insensitive).
> - `g`/`y` are ignored to avoid stateful `.test()` behavior.

## License
Choose a license if you plan to publish the repo.


## New in 4.1

- Suspended-tab URL extraction (treat wrapper URLs as the original URL)
- Optional preference to close suspended tabs first when a normal tab exists
- Optional auto-close duplicates after a configurable delay


## Privacy
- The extension processes tab URLs locally to detect duplicates.
- No analytics, tracking, or network requests are performed.
- Settings are stored in Chrome sync storage, with a local backup to reduce the risk of losing preferences after updates.

