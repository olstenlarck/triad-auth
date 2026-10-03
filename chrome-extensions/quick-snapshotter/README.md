# Quick Snapshotter

A Google Chrome extension that allows you to effortlessly select and capture screenshots of specific HTML elements or free-form regions on any webpage.

## Features

- **Precise Element Selection**: Hover over elements to see exactly what will be captured. Elements larger than the screen are smartly bounded to your visible viewport so captures never end up blank.
- **Drag Selection**: Click and drag to capture a free-form region anywhere on the screen.
- **Resizable Area**: Once a selection is locked, use the corner and edge handles to fine-tune your capture.
- **Action Menu**: Click to lock onto an element or finish dragging to reveal quick actions.
- **Download**: Instantly download the cropped screenshot.
- **Copy to Clipboard**: Copy the image directly to your clipboard for easy pasting anywhere.
- **Customizable**: Set global shortcuts and configure your default download behavior via the extension's popup menu.

## Installation

Currently, the extension is installed via Developer Mode in Chrome.

1. Clone or download this repository.
2. Open Chrome/Brave/Helium and navigate to `chrome://extensions/` (yes it does work on any Chromium-based browser).
3. Enable **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the `chrome-extensions/quick-snapshotter` folder.

## Usage

1. Trigger the extension by using the global shortcut (`Ctrl+Shift+F` by default), clicking the toolbar icon, or using the right-click context menu.
2. Hover over the element you wish to capture, or click and drag to draw a custom region.
3. Lock the selection (by clicking the element or releasing the drag).
4. Choose **Download** or **Copy to Clipboard** from the floating menu. (Press **Cancel** or hit the `Escape` key to abort).

> **Note on Downloads:** For security reasons, Chrome Extensions can only silently download files into the default `Downloads` directory (or a subfolder of it). If you want to browse and choose a different folder for every screenshot, open the extension's popup menu and check "Always ask where to save (Browse...)".

## Project Structure

- `manifest.json`: Configuration for Manifest V3.
- `src/background.js`: Service worker handling capture, cropping, and clipboard/download orchestration.
- `src/content.js`: Content script injected into the page to manage hover highlighting and user interaction.
- `src/styles.css`: CSS for the highlight overlay and the floating action menu.
- `src/popup.*`: Settings menu logic.

## License

Apache-2.0 License. See `LICENSE` for details.
