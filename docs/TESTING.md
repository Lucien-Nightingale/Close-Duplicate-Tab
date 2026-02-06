# Testing Guide

## Automated tests
Run:
```bash
npm test
```

Tests are implemented with Node's built-in test runner (`node --test`) and do not require external dependencies.

## Manual testing (recommended)
- Verify badge count updates when switching focused windows.
- Verify All windows scope respects:
  - Pinned protection
  - Group bucketing
  - Focused-window unique-tab protection
- Verify whitelist override restricts processing to included URLs.
