# Basic Tab Counter

Shows how many tabs you have open as a badge on the toolbar icon.

It works in Chrome, Chromium, Brave, Helium, and other Chromium browsers.

## Features

- **Real-time Updates**: Automatically updates the tab count when you open or close tabs.
- **All Windows**: Counts the tabs in every open window.
- **Lightweight**: Uses a minimal background service worker and only requires the `tabs` permission.
- **Unobtrusive**: Just a simple badge on your toolbar, with no popups or extra menus.
- **Minimalist**: Just 17 lines of code.

## Install

Copy the extension folder with [gitpick](https://github.com/nrjdalal/gitpick):

```sh
npx gitpick https://github.com/tunnckoCoreHQ/monarch/tree/master/chrome-extensions/basic-tab-counter basic-tab-counter
```

Then load it in the browser:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the `basic-tab-counter` folder.

To update, run the same command with `-o` to overwrite the folder, then click the reload icon on the extension card in `chrome://extensions`.

## Use

Pin the extension to the toolbar. The badge shows the tab count.

## Permissions

- `tabs`: to count the open tabs.

## Files

- `manifest.json`: the Manifest V3 config.
- `src/background.js`: the service worker that counts tabs and sets the badge.
- `assets/icon.png`: the toolbar icon.

## License

Apache-2.0. See [LICENSE](./LICENSE).
