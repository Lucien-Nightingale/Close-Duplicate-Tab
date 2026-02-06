# Changelog

## 4.2.2

- Content equivalence: added **multi-host rules** (comma-separated host list) so one rule can share a single scope across multiple hosts (e.g. youtube.com + youtu.be).
- Content equivalence: whitelist override is now **optional** ("Whitelist mode overrides and disables content equivalence.").
- Content equivalence token normalization: query values treat '+' as space (x-www-form-urlencoded).
- Fixpoint canonicalization: apply canonical redirects repeatedly until stable.
- Added local settings backup (storage.local) to mitigate sync/update loss.
- Options page help text refreshed (English-only).

## 4.1.0

- Added suspended-tab URL extraction (requires extension IDs)
- Added option to prefer closing suspended tabs when a normal tab exists
- Added optional auto-close duplicates after a configurable delay (seconds)

## 4.0.1
- Fix: allow literal URL fragments (non-regex lines) to be saved reliably by validating only explicitly-marked regex rules.

## 4.0
- Priority model: **Pinned/Group constraints > Whitelist > Blacklist**.
- Two-stage rule matching: explicit **Regex rules** first, then **URL fragment** substring rules.
- Immediate badge refresh on window focus switch.
- Optional protections: pinned tabs, tab group bucketing, focused-window unique-tab protection.
- Options UI in English.
