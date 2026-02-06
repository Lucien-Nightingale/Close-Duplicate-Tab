# Implementation Status

## Completed
- MV3 service worker duplicate closing.
- Rule priority: pinned/group > whitelist > blacklist.
- Two-stage rule matching (explicit regex, then URL fragment).
- Focus-change immediate badge refresh.

## TODO (optional)
- Optional URL normalization (ignore selected query params like `t=` for YouTube).
- CI workflow (GitHub Actions) to enforce `npm run quality` on PRs.
- Add more unit tests for edge cases (tabs closing race, group id collisions, etc.).
