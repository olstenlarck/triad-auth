const updateCount = () => {
  chrome.tabs.query({}, (tabs) => {
    chrome.action.setBadgeText({ text: tabs.length.toString() });
    chrome.action.setBadgeBackgroundColor({ color: "#4688F1" });
    if (chrome.action.setBadgeTextColor) {
      chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
    }
  });
};

chrome.tabs.onCreated.addListener(updateCount);
chrome.tabs.onRemoved.addListener(updateCount);
chrome.runtime.onInstalled.addListener(updateCount);
chrome.runtime.onStartup.addListener(updateCount);

// Update on startup
updateCount();
