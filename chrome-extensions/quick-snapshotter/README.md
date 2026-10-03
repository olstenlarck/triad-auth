# Quick Snapshotter

Takes a screenshot of one element or a region you draw on a web page. You can download it or copy it to the clipboard.

It works in Chrome, Chromium, Brave, Helium, and other Chromium browsers.

## Features

- Hover to highlight an element, then click to select it. Elements larger than the screen are cut to the visible part, so the capture is never blank.
- Click and drag to select a free region instead.
- Drag the corner and edge handles to adjust the selection.
- Download the cropped image, or copy it to the clipboard.
- Set a subfolder of `Downloads`, or ask for a save location each time.

## Install

Copy the extension folder with [gitpick](https://github.com/nrjdalal/gitpick). Use the runner you have:

```sh
npx gitpick https://github.com/tunnckoCoreHQ/monarch/tree/master/chrome-extensions/quick-snapshotter quick-snapshotter
pnpx gitpick https://github.com/tunnckoCoreHQ/monarch/tree/master/chrome-extensions/quick-snapshotter quick-snapshotter
bunx gitpick https://github.com/tunnckoCoreHQ/monarch/tree/master/chrome-extensions/quick-snapshotter quick-snapshotter
```

Then load it in the browser:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the `quick-snapshotter` folder.

To update, run the same command with `-o` to overwrite the folder, then click the reload icon on the extension card in `chrome://extensions`.

## Use

1. Start a selection. Press `Ctrl+Shift+F` (`Cmd+Shift+F` on macOS), or right-click the page and choose **Screenshot Element**.
2. Hover an element and click it, or click and drag to draw a region.
3. Adjust the selection with the handles if you need to.
4. Choose **Download** or **Copy to Clipboard** in the floating menu. Press **Cancel** or `Escape` to stop.

Click the toolbar icon to open the settings. There you set the `Downloads` subfolder, turn on "Always ask where to save", and change the shortcut.

> [!NOTE]
>
> Browsers let an extension save files without asking only inside the default `Downloads` folder. To save somewhere else, turn on "Always ask where to save".

## Permissions

- `activeTab` and `scripting`: to add the selection overlay to the current page and capture it.
- `contextMenus`: for the **Screenshot Element** menu item.
- `downloads`: to save the image.
- `storage`: to keep your settings.

## Files

- `manifest.json`: the Manifest V3 config.
- `src/background.js`: the service worker. It captures the tab, crops the image, and downloads it or sends it back to the page for copying.
- `src/content.js`: the page script for the highlight, the selection, the floating menu, and the clipboard copy.
- `src/styles.css`: the styles for the highlight and the floating menu.
- `src/popup.html`, `src/popup.js`, `src/popup.css`: the settings popup.

## License

Apache-2.0. See [LICENSE](./LICENSE).
