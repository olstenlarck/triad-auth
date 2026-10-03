# ChatGPT Session Exporter Chrome

Copy a ChatGPT conversation to your clipboard as JSON or Markdown.

This is a small Manifest V3 extension for Chrome, Chromium, Brave, and Helium. It runs locally in the active tab after you click the extension button.

## Features

- Copy the current chat as JSON.
- Copy the current chat as Markdown.
- Preserve message roles, page title, URL, conversation id, and message order.
- Preserve formatted Markdown and fenced code blocks in `content_markdown`.
- Render Markdown from the same JSON-shaped export data.
- No server, sync service, analytics, or external API calls.

## Install

```bash
git clone git@github.com:tunnckoCore/chatgpt-session-exporter-chrome.git
cd chatgpt-session-exporter-chrome
```

Then load it in your browser:

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `chatgpt-session-exporter-chrome` folder.

If you change the extension files, reload the extension from `chrome://extensions`.

## Use

1. Open a ChatGPT conversation.
2. Click the extension icon.
3. Choose `JSON` or `Markdown`.
4. Click **Copy current chat**.
5. Paste the result wherever you want to save or process it.

**NOTE:** Make sure to scroll up, because it uses the DOM to get the session message history from the HTML, which sometimes can get hidden/removed if the session is too long.

## Output

JSON exports use this shape:

```json
{
  "schema": "chat-session-exporter.v1",
  "exported_at": "ISO-8601 timestamp",
  "source": {
    "platform": "chatgpt",
    "title": "Conversation title",
    "url": "https://chatgpt.com/c/...",
    "conversation_id": "optional-id"
  },
  "message_count": 2,
  "messages": [
    {
      "index": 0,
      "role": "user",
      "author": "user",
      "content": "Plain-text content",
      "content_markdown": "Markdown content"
    }
  ],
  "warnings": []
}
```

`content` is the readable plain-text version. `content_markdown` is the formatted version used for Markdown output.

## Supported pages

ChatGPT is the primary target. The extractor uses ChatGPT message-role attributes when available.

There are also best-effort adapters for Claude, Gemini, Copilot, and generic message-like pages. Those may break when the sites change their markup.

## Privacy

The extension reads the active tab only when you click **Copy current chat**. It builds the export in the browser and writes it to your clipboard. Nothing is sent anywhere.
