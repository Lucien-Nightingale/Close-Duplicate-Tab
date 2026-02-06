# Close Duplicate Ta

A Chrome extension that automatically identifies and closes duplicate browser tabs with identical URLs, helping reduce browser memory usage and tab clutter.

## 🚀 Quick Install

1. **Download**: [Download ZIP](https://github.com/skippdot/Close-Duplicate-Tab/archive/main.zip) or clone this repo
2. **Extract**: Unzip the downloaded file
3. **Chrome**: Go to `chrome://extensions/` and enable "Developer mode"
4. **Load**: Click "Load unpacked" and select the `extension` folder
5. **Done**: Start closing duplicate tabs! 🎉
[Install from Chrome Web Store](https://chromewebstore.google.com/detail/close-duplicate-tab/mbbfopgippcdjokhcejceahaiagjlpgn)

## Features

- **Duplicate Detection**: Automatically identifies tabs with identical URLs
- **Smart Badge**: Shows the number of duplicate tabs in the extension icon
- **Intelligent Closing**: Preserves active and pinned tabs when closing duplicates
- **Tab Sorting**: Optional feature to reorganize tabs by URL when closing duplicates
- **Multi-Window Support**: Works across all browser windows
- **Real-time Updates**: Badge updates automatically as you browse

## Installation

### From Chrome Web Store

Install from the Chrome Web Store:

[Close Duplicate Tab — Chrome Web Store](https://chromewebstore.google.com/detail/close-duplicate-tab/mbbfopgippcdjokhcejceahaiagjlpgn)

### Manual Installation (Developer Mode)
1. Download or clone this repository
2. Open Chrome and go to `chrome://extensions/`
3. Enable "Developer mode" in the top right
4. Click "Load unpacked" and select the `extension` folder (not the root directory)
5. The extension will appear in your toolbar

> **Important**: Make sure to select the `extension` folder, which contains only the necessary extension files.

## How It Works

1. **Detection**: The extension monitors all your tabs and identifies duplicates by comparing URLs
2. **Badge Display**: The number of duplicate tabs is shown on the extension icon
3. **Smart Closing**: When you click the extension icon, it closes duplicate tabs while preserving:
   - Active tabs (currently selected)
   - Pinned tabs
   - The most recently accessed tab for each URL

## Settings

Access settings by right-clicking the extension icon and selecting "Options":

- **Sort Tabs**: Reorganize tabs by URL when closing duplicates (helps group related tabs)
- **Auto Close**: *(Coming soon)* Automatically close duplicates as they're detected
- **Current Window Only**: *(Coming soon)* Limit duplicate detection to the current window

## Privacy

This extension respects your privacy:
- ✅ No data collection
- ✅ No external connections
- ✅ All processing happens locally in your browser
- ✅ Only stores your preferences locally

See our full [Privacy Policy](https://skippdot.github.io/Close-Duplicate-Tab/privacy-policy.html).

## Permissions

The extension requires these permissions:
- **tabs**: To read tab URLs, identify duplicates, and close duplicate tabs
- **storage**: To save your preferences

## Technical Details

- **Manifest Version**: 3 (latest Chrome extension standard)
- **Background**: Service Worker (efficient and modern)
- **Compatibility**: Chrome 88+ (Manifest V3 requirement)

## Development

### Project Structure
```
├── extension/            # 📁 Chrome Extension Files (load this folder)
│   ├── manifest.json     # Extension configuration
│   ├── close_tabs.js     # Main extension logic
│   ├── options.html      # Settings page
│   ├── options.js        # Settings functionality
│   ├── privacy-policy.html # Privacy policy
│   ├── README.md         # Extension-specific readme
│   └── icon_*.png        # Extension icons
├── tests/                # 🧪 Test files and framework
├── docs/                 # 📚 Documentation and guides
├── README.md             # This file (project overview)
├── CHANGELOG.md          # Version history
└── package.json          # Development dependencies
```

### Building
No build process required - this is a vanilla JavaScript extension.

### Development & Testing
1. **Load Extension**: Load the `extension` folder in Chrome developer mode
2. **Run Tests**: `npm test` to run the automated test suite
3. **Manual Testing**: Open multiple tabs with the same URL
4. **Verify Badge**: Check that the badge shows the number of duplicates
5. **Test Closing**: Click the extension icon to close duplicates
6. **Check Preservation**: Verify that active/pinned tabs are preserved

For detailed testing instructions, see [TESTING_GUIDE.md](docs/TESTING_GUIDE.md).

### Available Scripts
```bash
# Testing
npm test              # Run all tests
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Run tests with coverage report

# Code Quality
npm run lint          # Check for linting errors
npm run lint:fix      # Fix auto-fixable linting errors
npm run format        # Format all files with Prettier
npm run format:check  # Check if files are properly formatted
npm run quality       # Run all quality checks (lint + format + tests)

# Development
npm run test:url      # Run standalone URL extraction test
```

## 👨‍💻 For Developers

### Quick Start
```bash
# Clone the repository
git clone https://github.com/skippdot/Close-Duplicate-Tab.git
cd Close-Duplicate-Tab

# Install development dependencies
npm install

# Run tests
npm test

# Load extension in Chrome
# 1. Go to chrome://extensions/
# 2. Enable Developer mode
# 3. Click "Load unpacked"
# 4. Select the "extension" folder
```

### Development Workflow
1. **Make Changes**: Edit files in the `extension/` folder
2. **Code Quality**: Run `npm run quality` (linting + formatting + tests)
3. **Fix Issues**: Use `npm run lint:fix` and `npm run format` as needed
4. **Manual Testing**: Reload extension in Chrome and test manually
5. **Documentation**: Update relevant docs in `docs/` folder

### Code Quality Tools
- **ESLint**: Static code analysis with Chrome extension specific rules
- **Prettier**: Automatic code formatting for consistency
- **Jest**: Comprehensive testing framework with 24 tests
- **Quality Check**: `npm run quality` runs all checks together

### Project Structure
- `extension/` - Chrome extension files (production ready)
- `tests/` - Automated test suite with Jest
- `docs/` - Development documentation and guides

## 🤝 Contributing

We welcome contributions! Here's how to get started:

1. **Fork** the repository
2. **Create** a feature branch (`git checkout -b feature/amazing-feature`)
3. **Test** your changes (`npm test`)
4. **Document** your changes (update README/CHANGELOG as needed)
5. **Commit** your changes (`git commit -m 'Add amazing feature'`)
6. **Push** to the branch (`git push origin feature/amazing-feature`)
7. **Open** a Pull Request

### Contribution Guidelines
- All quality checks must pass (`npm run quality`)
- Follow existing code style and patterns (enforced by ESLint/Prettier)
- Update documentation for new features
- Add tests for new functionality
- Keep commits focused and descriptive

### Documentation
- **[Installation Guide](docs/INSTALLATION_GUIDE.md)** - Step-by-step installation instructions
- **[Testing Guide](docs/TESTING_GUIDE.md)** - Manual and automated testing procedures
- **[Linting Guide](docs/LINTING_GUIDE.md)** - Code quality and formatting standards
- **[Implementation Status](docs/IMPLEMENTATION_STATUS.md)** - Development tracking and progress

## 📁 Folder Structure

### For Users (Extension Installation)
- **`extension/`** - Contains all files needed to load the extension in Chrome
  - This is the only folder you need to install the extension

### For Developers
- **`tests/`** - Automated test suite (Jest framework)
- **`docs/`** - Development documentation and testing guides
- **Root files** - Project configuration (package.json, README, CHANGELOG)

## 📋 Changelog

See [CHANGELOG.md](CHANGELOG.md) for detailed version history.

### Latest Release - Version 2.6.0
- ✅ **Fixed critical tab counting bug** (now handles 500+ tabs correctly)
- ✅ **Added Marvellous Suspender compatibility**
- ✅ **Implemented auto-close feature**
- ✅ **Fixed currentWindowOnly functionality**
- ✅ **Added comprehensive error handling**
- ✅ **Modernized entire codebase**
- ✅ **Added 24 automated tests**
- ✅ **Enhanced options page**
- ✅ **Added keyboard shortcuts**

## License

This project is open source. See the repository for license details.

## Support

- Install from Chrome Web Store: [Close Duplicate Tab — Chrome Web Store](https://chromewebstore.google.com/detail/close-duplicate-tab/mbbfopgippcdjokhcejceahaiagjlpgn)

- Report issues on [GitHub Issues](https://github.com/skippdot/Close-Duplicate-Tab/issues)
- For Chrome Web Store related questions, use the store's support system

---

**Note**: The original extension was removed from the Chrome Web Store for using deprecated Manifest V2. This updated version uses the modern Manifest V3 standard and follows current Chrome extension best practices.
