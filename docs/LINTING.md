# Linting Guide

This repo is prepared for ESLint/Prettier.

## With dependencies installed
```bash
npm run lint
npm run format
```

## In offline environments
If you cannot install dependencies, you can still run the built-in quality checks:
```bash
npm run quality
```
`npm run quality` runs:
- `node --check` on JS files
- manifest sanity checks
- built-in unit tests
