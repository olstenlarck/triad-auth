# ChatGPT Session Exporter

Copies the open ChatGPT conversation to the clipboard as JSON or Markdown.

It works in Chrome, Chromium, Brave, Helium, and other Chromium browsers.

## Features

- Copy the current chat as JSON or Markdown.
- Keep the message roles, the message order, the page title, the URL, and the conversation id.
- Keep formatted Markdown and fenced code blocks.
- Add the raw message HTML to the JSON if you need it.
- Build the Markdown from the same data as the JSON.
- Everything runs in the browser. There is no server, sync, analytics, or external API call.

## Install

Copy the extension folder with [gitpick](https://github.com/nrjdalal/gitpick). Use the runner you have:

```sh
npx gitpick https://github.com/tunnckoCoreHQ/monarch/tree/master/chrome-extensions/chatgpt-session-exporter chatgpt-session-exporter
pnpx gitpick https://github.com/tunnckoCoreHQ/monarch/tree/master/chrome-extensions/chatgpt-session-exporter chatgpt-session-exporter
bunx gitpick https://github.com/tunnckoCoreHQ/monarch/tree/master/chrome-extensions/chatgpt-session-exporter chatgpt-session-exporter
```

Then load it in the browser:

1. Open `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select the `chatgpt-session-exporter` folder.

To update, run the same command with `-o` to overwrite the folder, then click the reload icon on the extension card in `chrome://extensions`.

## Use

1. Open a ChatGPT conversation.
2. Scroll to the top of the chat.
3. Click the extension icon.
4. Choose `JSON` or `Markdown`. For JSON, turn on **Include HTML in JSON** to add the message HTML.
5. Click **Copy current chat**.
6. Paste the result where you need it.

> [!NOTE]
>
> The extension reads the messages from the page HTML. ChatGPT can remove old messages from the page in long chats, so scroll up first to load them all.

## Output

The JSON export has this shape:

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

The `content` field has the plain text. The `content_markdown` field has the formatted text, and the Markdown export uses it. With **Include HTML in JSON** on, each message also has a `content_html` field.

## Supported pages

ChatGPT is the main target. The extension finds messages by the role attributes that ChatGPT puts on them.

It also tries Claude, Gemini, Copilot, and other pages that look like a chat. These can break when the sites change their HTML.

## Permissions

- `activeTab` and `scripting`: to read the messages from the current tab, and only when you click **Copy current chat**.
- `clipboardWrite`: to put the export on the clipboard.

## Files

- `manifest.json`: the Manifest V3 config.
- `popup.html`, `popup.js`, `popup.css`: the popup and the export code.
- `icons/`: the extension icons.

## License

MIT. See [LICENSE](./LICENSE).
