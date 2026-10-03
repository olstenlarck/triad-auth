# Basic Tab Counter

A simple Chrome/Chromium/Brave/Helium extension that counts the total number of open tabs and displays the count directly on the extension icon as a badge.

## Features

- **Real-time Updates**: Automatically updates the tab count when you open, close, or move tabs.
- **Lightweight**: Uses a minimal background service worker and only requires the `tabs` permission.
- **Unobtrusive**: Just a simple badge on your toolbar—no popups or extra menus required.
- **Minimalist:** Just 15 lines of code.

## Installation

Currently, the extension is installed via Developer Mode in Chrome.

1. Clone or download this repository.
2. Open Google Chrome and navigate to `chrome://extensions/`.
3. Enable **Developer mode** using the toggle switch in the top right corner.
4. Click the **Load unpacked** button.
5. Select the `chrome-extensions/basic-tab-counter` folder.

## Project Structure

- `manifest.json`: Configuration for Manifest V3.
- `src/background.js`: Service worker handling the tab counting logic and badge updates.
- `assets/icon.png`: The extension's toolbar icon.

## License

Apache-2.0 License. See `LICENSE` for details.
