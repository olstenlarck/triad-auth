chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "screenshot-element",
    title: "Screenshot Element",
    contexts: ["all"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "screenshot-element") {
    startSelection(tab.id);
  }
});

chrome.commands.onCommand.addListener((command) => {
  if (command === "take-screenshot") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        startSelection(tabs[0].id);
      }
    });
  }
});

function startSelection(tabId) {
  chrome.scripting.executeScript(
    {
      target: { tabId: tabId },
      func: () => {
        const active = window.__wgwQuickSnapshotterExtensionActive;
        const cssInjected = window.__wgwQuickSnapshotterCssInjected;
        window.__wgwQuickSnapshotterCssInjected = true;
        return { active, cssInjected };
      },
    },
    (results) => {
      if (chrome.runtime.lastError || !results || !results[0]) return;
      const { active, cssInjected } = results[0].result || {};

      if (!active) {
        if (!cssInjected) {
          chrome.scripting.insertCSS({
            target: { tabId: tabId },
            files: ["src/styles.css"],
          });
        }
        chrome.scripting.executeScript({
          target: { tabId: tabId },
          files: ["src/content.js"],
        });
      }
    },
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type !== "ELEMENT_SELECTED") {
    return;
  }

  const { rect, dpr, action } = message;

  // Slight delay to allow the highlight overlay to disappear before capturing
  setTimeout(() => {
    chrome.tabs.captureVisibleTab(sender.tab.windowId, { format: "png" }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        console.error(chrome.runtime.lastError);
        sendResponse({
          success: false,
          error: chrome.runtime.lastError.message,
        });
        return;
      }

      cropImage(dataUrl, rect, dpr).then((croppedDataUrl) => {
        if (action === "download") {
          chrome.storage.sync.get({ subfolder: "", saveAs: false }, (items) => {
            let filename = `screenshot-${Date.now()}.png`;
            if (items.subfolder) {
              // Ensure no leading/trailing slashes, though popup already cleans it
              let folder = items.subfolder.replace(/^[\/\\]+|[\/\\]+$/g, "");
              filename = `${folder}/${filename}`;
            }
            chrome.downloads.download({
              url: croppedDataUrl,
              filename: filename,
              saveAs: items.saveAs,
            });
            sendResponse({ success: true });
          });
          return;
        }

        if (action === "copy") {
          sendResponse({ success: true, dataUrl: croppedDataUrl });
        }
      });
    });
  }, 150);

  return true; // Indicate async response
});

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function cropImage(dataUrl, rect, dpr) {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const bitmap = await createImageBitmap(blob);

  // Create an offscreen canvas
  const canvas = new OffscreenCanvas(rect.width * dpr, rect.height * dpr);
  const ctx = canvas.getContext("2d");

  const sx = rect.x * dpr;
  const sy = rect.y * dpr;
  const sWidth = rect.width * dpr;
  const sHeight = rect.height * dpr;

  ctx.drawImage(bitmap, sx, sy, sWidth, sHeight, 0, 0, sWidth, sHeight);

  const croppedBlob = await canvas.convertToBlob({ type: "image/png" });

  return blobToBase64(croppedBlob);
}
