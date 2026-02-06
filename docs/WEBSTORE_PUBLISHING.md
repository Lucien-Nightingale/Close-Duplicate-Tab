# Chrome Web Store publishing checklist (MV3)

This repo contains a Node-based build workflow for lint/tests and for producing a clean upload zip.

## Build the upload zip
```bash
npm ci
npm run quality
npm run build
```

The upload-ready zip is written to `dist/`.

## Manifest & code requirements
- MV3 service worker (`background.service_worker`) ✅
- No remote code (no `eval`, no remote scripts, no WASM fetched from the internet) ✅
- Permissions are minimal and match the feature set:
  - `tabs` (read/close tabs, dedupe planning)
  - `storage` (save settings)
- No host permissions are required ✅

## Store listing notes
When the Web Store asks about data practices:
- The extension reads tab URLs/titles to detect duplicates.
- No data is sent to any server; everything is processed locally.
- Settings are stored using Chrome storage.

A suggested privacy policy is provided in `PRIVACY.md`.

## Common rejection pitfalls
- Uploading the repo zip instead of the extension zip (do NOT include `node_modules`).
- Using overly broad permissions without clear justification.
- Using “experimental” features without clear user-facing warnings.

## Recommended QA before submission
- Verify options page renders correctly and all controls save/load.
- Verify dedupe works in:
  - Current window scope
  - All windows scope
  - Whitelist mode
  - With and without Content equivalence enabled
