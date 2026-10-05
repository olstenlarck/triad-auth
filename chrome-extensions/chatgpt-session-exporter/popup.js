"use strict";

const exportButton = document.getElementById("exportButton");
const formatSelect = document.getElementById("format");
const includeHtmlInput = document.getElementById("includeHtml");
const statusEl = document.getElementById("status");

exportButton.addEventListener("click", async () => {
  exportButton.disabled = true;
  setStatus("Reading the current tab…");

  try {
    const includeHtml = includeHtmlInput.checked;
    const exportFormat = formatSelect.value;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || typeof tab.id !== "number") {
      throw new Error("No active tab found.");
    }

    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractConversationFromPage,
      args: [
        {
          includeHtml,
          // Always build the canonical markdown field. JSON export should carry
          // the same formatting that Markdown export renders from.
          includeMarkdown: true,
        },
      ],
    });

    if (!result || !result.ok) {
      throw new Error(result?.error || "Could not extract a conversation from this page.");
    }

    setStatus("Copying to clipboard…");
    const clipboardText = makeClipboardText(result, exportFormat, includeHtml);
    await copyTextToClipboard(clipboardText);

    const warningText = result.warnings?.length ? ` ${result.warnings.join(" ")}` : "";
    setStatus(
      `Copied ${result.messages.length} message${result.messages.length === 1 ? "" : "s"} to clipboard.${warningText}`,
    );
  } catch (error) {
    console.error(error);
    setStatus(error?.message || String(error));
  } finally {
    exportButton.disabled = false;
  }
});

function setStatus(message) {
  statusEl.textContent = message;
}

function makeClipboardText(extraction, exportFormat, includeHtml) {
  const jsonPayload = makeJsonPayload(extraction, includeHtml);

  if (exportFormat === "json") {
    return JSON.stringify(jsonPayload, null, 2);
  }

  if (exportFormat === "both") {
    return [
      makeMarkdown(jsonPayload),
      "---",
      "## JSON export",
      "",
      "```json",
      JSON.stringify(jsonPayload, null, 2),
      "```",
    ].join("\n");
  }

  return makeMarkdown(jsonPayload);
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (error) {
      console.warn("navigator.clipboard.writeText failed; falling back to execCommand.", error);
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.inset = "0 auto auto 0";
  textarea.style.width = "1px";
  textarea.style.height = "1px";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  try {
    if (!document.execCommand("copy")) {
      throw new Error("Clipboard copy was rejected by the browser.");
    }
  } finally {
    textarea.remove();
  }
}

function makeJsonPayload(extraction, includeHtml) {
  return {
    schema: "chat-session-exporter.v1",
    exported_at: new Date().toISOString(),
    source: {
      platform: extraction.platform,
      title: extraction.title,
      url: extraction.url,
      conversation_id: extraction.conversationId || null,
    },
    message_count: extraction.messages.length,
    messages: extraction.messages.map((message, index) => {
      const contentMarkdown = message.contentMarkdown || message.contentText || "";
      const item = {
        index,
        role: message.role,
        author: message.author || message.role,
        content: message.contentText || contentMarkdown,
        content_markdown: contentMarkdown,
      };
      if (includeHtml && message.contentHtml) {
        item.content_html = message.contentHtml;
      }
      return item;
    }),
    warnings: extraction.warnings || [],
  };
}

function makeMarkdown(exportData) {
  const source = exportData.source || exportData;
  const messages = exportData.messages || [];
  const title = source.title || exportData.title || "Untitled chat";
  const url = source.url || exportData.url || "";
  const conversationId = source.conversation_id || exportData.conversationId;
  const exportedAt = exportData.exported_at || new Date().toISOString();
  const messageCount = exportData.message_count ?? messages.length;

  const lines = [];
  lines.push("---");
  lines.push(`schema: chat-session-exporter.v1`);
  lines.push(`exported_at: ${exportedAt}`);
  lines.push(`platform: ${yamlScalar(source.platform || exportData.platform)}`);
  lines.push(`title: ${yamlScalar(title)}`);
  lines.push(`url: ${yamlScalar(url)}`);
  if (conversationId) lines.push(`conversation_id: ${yamlScalar(conversationId)}`);
  lines.push(`message_count: ${messageCount}`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${title}`);
  lines.push("");
  lines.push(`Source: ${url}`);
  lines.push("");

  messages.forEach((message, index) => {
    const role = titleCase(message.author || message.role || "message");
    const content =
      message.content_markdown ||
      message.contentMarkdown ||
      message.content ||
      message.contentText ||
      "";
    lines.push(`## ${index + 1}. ${role}`);
    lines.push("");
    lines.push(content.trim() || "_No visible text extracted._");
    lines.push("");
  });

  if (exportData.warnings?.length) {
    lines.push("## Export warnings");
    lines.push("");
    exportData.warnings.forEach((warning) => lines.push(`- ${warning}`));
    lines.push("");
  }

  return lines.join("\n");
}

function yamlScalar(value) {
  const text = String(value ?? "");
  return JSON.stringify(text);
}

function titleCase(value) {
  return String(value)
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function makeFileBaseName(extraction) {
  const title = extraction.title || extraction.platform || "chat";
  const date = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const id = extraction.conversationId ? `-${extraction.conversationId}` : "";
  return `${sanitizeFileName(title).slice(0, 80) || "chat"}${id}-${date}`;
}

function sanitizeFileName(value) {
  return String(value)
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function extractConversationFromPage(options = {}) {
  const extractionStartedAt = new Date().toISOString();
  const url = location.href;
  const title =
    document.title.replace(/\s*[|—-]\s*ChatGPT\s*$/i, "").trim() ||
    document.title ||
    "Untitled chat";
  const platform = detectPlatform();
  const conversationId = detectConversationId();
  const warnings = [];
  const includeHtml = Boolean(options?.includeHtml);
  const includeMarkdown = Boolean(options?.includeMarkdown);

  try {
    const adapterMessages = extractByKnownAdapters(platform);
    const messages = adapterMessages.length ? adapterMessages : extractByGenericHeuristics();

    const normalized = normalizeMessages(messages);

    if (!normalized.length) {
      return {
        ok: false,
        error:
          "No chat messages were found. Open the conversation page and make sure messages are visible before exporting.",
        platform,
        title,
        url,
        conversationId,
        messages: [],
        warnings,
        extractionStartedAt,
      };
    }

    if (normalized.length < 2) {
      warnings.push(
        "Only one message was detected; the page may use selectors this extension does not yet know.",
      );
    }

    return {
      ok: true,
      schema: "chat-session-exporter.raw.v1",
      extractionStartedAt,
      platform,
      title,
      url,
      conversationId,
      messages: normalized,
      warnings,
    };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || String(error),
      platform,
      title,
      url,
      conversationId,
      messages: [],
      warnings,
      extractionStartedAt,
    };
  }

  function detectPlatform() {
    const host = location.hostname.replace(/^www\./, "");
    if (/(^|\.)chatgpt\.com$/.test(host) || /(^|\.)chat\.openai\.com$/.test(host)) return "chatgpt";
    if (/(^|\.)claude\.ai$/.test(host)) return "claude";
    if (/(^|\.)gemini\.google\.com$/.test(host)) return "gemini";
    if (/(^|\.)copilot\.microsoft\.com$/.test(host)) return "copilot";
    return host || "unknown";
  }

  function detectConversationId() {
    const pathParts = location.pathname.split("/").filter(Boolean);
    const cIndex = pathParts.indexOf("c");
    if (cIndex !== -1 && pathParts[cIndex + 1]) return pathParts[cIndex + 1];
    const chatIndex = pathParts.indexOf("chat");
    if (chatIndex !== -1 && pathParts[chatIndex + 1]) return pathParts[chatIndex + 1];
    return null;
  }

  function extractByKnownAdapters(site) {
    if (site === "chatgpt") return extractChatGPT();
    if (site === "claude") return extractClaude();
    if (site === "gemini") return extractGemini();
    if (site === "copilot") return extractCopilot();
    return [];
  }

  function extractChatGPT() {
    const roleNodes = Array.from(document.querySelectorAll("[data-message-author-role]"));
    if (roleNodes.length) {
      return roleNodes.map((node) => {
        const role = normalizeRole(node.getAttribute("data-message-author-role"));
        const container =
          node.closest('article[data-testid^="conversation-turn"], article') || node;
        const contentRoot = pickBestContentRoot(container, role, node);
        return createMessage(role, contentRoot, container);
      });
    }

    const turns = Array.from(
      document.querySelectorAll('article[data-testid^="conversation-turn"], article'),
    );
    return turns.map((turn) => {
      const label = [turn.getAttribute("aria-label"), turn.textContent?.slice(0, 80)]
        .filter(Boolean)
        .join(" ");
      const role = /\byou\b|\buser\b/i.test(label)
        ? "user"
        : /\bassistant\b|\bchatgpt\b/i.test(label)
          ? "assistant"
          : "unknown";
      return createMessage(role, pickBestContentRoot(turn, role, turn), turn);
    });
  }

  function extractClaude() {
    const known = [];
    document.querySelectorAll('[data-testid="user-message"]').forEach((node) => {
      known.push(createMessage("user", pickBestContentRoot(node, "user", node), node));
    });

    document
      .querySelectorAll(
        '[data-testid="assistant-message"], [data-testid="claude-message"], .font-claude-message',
      )
      .forEach((node) => {
        known.push(createMessage("assistant", pickBestContentRoot(node, "assistant", node), node));
      });

    if (known.length) return sortByDocumentOrder(known);

    const turns = Array.from(
      document.querySelectorAll('[data-testid*="message" i], [class*="message" i]'),
    ).filter((node) => visibleText(node).length > 0);

    return turns.map((node) => {
      const descriptor = `${node.getAttribute("data-testid") || ""} ${node.className || ""} ${node.getAttribute("aria-label") || ""}`;
      const role = /user|human|you/i.test(descriptor)
        ? "user"
        : /assistant|claude|bot/i.test(descriptor)
          ? "assistant"
          : "unknown";
      return createMessage(role, pickBestContentRoot(node, role, node), node);
    });
  }

  function extractGemini() {
    const candidates = Array.from(
      document.querySelectorAll(
        'user-query, model-response, [class*="query" i], [class*="response" i]',
      ),
    ).filter((node) => visibleText(node).length > 0);

    return candidates.map((node) => {
      const descriptor = `${node.tagName || ""} ${node.className || ""} ${node.getAttribute("aria-label") || ""}`;
      const role = /user|query|prompt/i.test(descriptor)
        ? "user"
        : /model|response|assistant|gemini/i.test(descriptor)
          ? "assistant"
          : "unknown";
      return createMessage(role, pickBestContentRoot(node, role, node), node);
    });
  }

  function extractCopilot() {
    const candidates = Array.from(
      document.querySelectorAll(
        '[data-content="user-message"], [data-content="ai-message"], [class*="message" i]',
      ),
    ).filter((node) => visibleText(node).length > 0);

    return candidates.map((node) => {
      const descriptor = `${node.getAttribute("data-content") || ""} ${node.className || ""} ${node.getAttribute("aria-label") || ""}`;
      const role = /user|human|you/i.test(descriptor)
        ? "user"
        : /ai|assistant|copilot|bot/i.test(descriptor)
          ? "assistant"
          : "unknown";
      return createMessage(role, pickBestContentRoot(node, role, node), node);
    });
  }

  function extractByGenericHeuristics() {
    const selectors = [
      "[data-message-author-role]",
      '[data-testid*="message" i]',
      '[data-testid*="conversation" i]',
      '[aria-label*="message" i]',
      "article",
      '[class*="message" i]',
    ];

    const nodes = uniqueElements(Array.from(document.querySelectorAll(selectors.join(",")))).filter(
      (node) => {
        const text = visibleText(node);
        return text.length >= 2 && text.length <= 100_000 && isMeaningfulContainer(node);
      },
    );

    const compact = removeNestedDuplicates(nodes);

    return compact.map((node) => {
      const descriptor = [
        node.getAttribute("data-message-author-role"),
        node.getAttribute("data-testid"),
        node.getAttribute("aria-label"),
        typeof node.className === "string" ? node.className : "",
      ].join(" ");
      const role = /\buser\b|\bhuman\b|\byou\b|prompt/i.test(descriptor)
        ? "user"
        : /assistant|model|bot|ai|response|answer/i.test(descriptor)
          ? "assistant"
          : "unknown";
      return createMessage(role, pickBestContentRoot(node, role, node), node);
    });
  }

  function normalizeMessages(messages) {
    const seen = new Set();
    return sortByDocumentOrder(messages)
      .map((message) => {
        const contentMarkdown = normalizeMarkdown(
          message.contentMarkdown || message.contentText || "",
        );
        const contentText = normalizePlainText(
          message.contentText || markdownToPlainText(contentMarkdown),
        );
        const contentHtml = message.contentHtml || "";
        return {
          role: normalizeRole(message.role),
          author: roleToAuthor(normalizeRole(message.role)),
          contentText,
          contentMarkdown,
          contentHtml,
          order: message.order,
        };
      })
      .filter((message) => message.contentText || message.contentMarkdown)
      .filter((message) => {
        const key = `${message.role}\n${message.contentText}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map(({ orderNode, ...message }) => message);
  }

  function createMessage(role, contentRoot, orderNode) {
    const cleaned = cleanClone(contentRoot);
    const contentMarkdown = includeMarkdown ? nodeToMarkdown(contentRoot) : "";
    const contentText = contentMarkdown
      ? markdownToPlainText(contentMarkdown)
      : visibleText(cleaned);
    return {
      role,
      contentText,
      contentMarkdown,
      contentHtml: includeHtml ? cleaned.innerHTML || "" : "",
      orderNode,
    };
  }

  function pickBestContentRoot(container, role, fallback) {
    const selectors =
      role === "assistant"
        ? [".markdown", "[data-message-content]", '[class*="markdown" i]', '[class*="prose" i]']
        : ["[data-message-content]", '[class*="whitespace-pre-wrap" i]', '[class*="message" i]'];

    for (const selector of selectors) {
      const match = container.querySelector(selector);
      if (match && visibleText(match).length > 0) return match;
    }

    return fallback || container;
  }

  function removableElementSelectors() {
    return [
      "script",
      "style",
      "noscript",
      "template",
      "button",
      "svg",
      "canvas",
      "form",
      "textarea",
      "input",
      "select",
      "nav",
      '[role="button"]',
      '[aria-hidden="true"]',
      "[hidden]",
      '[data-testid*="copy" i]',
      '[data-testid*="feedback" i]',
      '[data-testid*="share" i]',
      '[class*="copy" i]',
      '[class*="feedback" i]',
      '[class*="sr-only" i]',
    ].join(",");
  }

  function cleanClone(node) {
    const clone = node.cloneNode(true);
    clone.querySelectorAll(removableElementSelectors()).forEach((element) => element.remove());
    return clone;
  }

  function shouldIgnoreElement(element) {
    return Boolean(element.matches?.(removableElementSelectors()));
  }

  function nodeToMarkdown(root) {
    // Walk the live DOM, not a detached clone. Browser-rendered innerText is
    // what preserves ChatGPT code-block line breaks; detached clones often
    // collapse the same code into one long text node.
    const markdown = compactMarkdown(childrenToMarkdown(root));
    return markdown || visibleText(root);
  }

  function childrenToMarkdown(node) {
    return Array.from(node.childNodes).map(childToMarkdown).join("");
  }

  function childToMarkdown(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.nodeValue.replace(/\u00a0/g, " ");
    }
    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node;
    const tag = element.tagName.toLowerCase();

    if (shouldIgnoreElement(element)) return "";
    if (tag === "br") return "\n";

    if (tag === "pre") return codeBlockToMarkdown(element);

    // ChatGPT/Claude often render fenced blocks as a generic wrapper with a
    // language label plus a nested <code>, not always as <pre><code>.
    if (tag !== "code" && isCodeBlockContainer(element)) return codeBlockToMarkdown(element);

    if (tag === "code") {
      const rawText = getCodeText(element).replace(/\n+$/g, "");
      if (rawText.includes("\n")) return codeBlockToMarkdown(element);
      const text = rawText.replace(/`/g, "\\`");
      return `\`${text}\``;
    }

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag[1]);
      return `\n\n${"#".repeat(level)} ${childrenToMarkdown(element).trim()}\n\n`;
    }

    if (tag === "p") return `\n\n${childrenToMarkdown(element).trim()}\n\n`;
    if (tag === "blockquote")
      return `\n\n${childrenToMarkdown(element)
        .trim()
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n")}\n\n`;
    if (tag === "strong" || tag === "b") return `**${childrenToMarkdown(element).trim()}**`;
    if (tag === "em" || tag === "i") return `_${childrenToMarkdown(element).trim()}_`;

    if (tag === "a") {
      const text = childrenToMarkdown(element).trim() || element.href;
      const href = element.href;
      return href ? `[${text}](${href})` : text;
    }

    if (tag === "ul") {
      return `\n${Array.from(element.children)
        .filter((child) => child.tagName.toLowerCase() === "li")
        .map((li) => listItemToMarkdown(li, "-"))
        .join("")}\n`;
    }

    if (tag === "ol") {
      return `\n${Array.from(element.children)
        .filter((child) => child.tagName.toLowerCase() === "li")
        .map((li, index) => listItemToMarkdown(li, `${index + 1}.`))
        .join("")}\n`;
    }

    if (tag === "table") return tableToMarkdown(element);

    if (["div", "section", "article", "main"].includes(tag)) {
      const content = childrenToMarkdown(element);
      return content.match(/\n\s*$/) ? content : `${content}\n`;
    }

    return childrenToMarkdown(element);
  }

  function listItemToMarkdown(li, marker) {
    const content = childrenToMarkdown(li).trim().replace(/\n/g, "\n  ");
    return `${marker} ${content}\n`;
  }

  function tableToMarkdown(table) {
    const rows = Array.from(table.querySelectorAll("tr"))
      .map((tr) => {
        return Array.from(tr.children).map((cell) =>
          normalizeWhitespace(cell.textContent).replace(/\|/g, "\\|"),
        );
      })
      .filter((row) => row.length);

    if (!rows.length) return "";
    const header = rows[0];
    const separator = header.map(() => "---");
    const body = rows.slice(1);
    return `\n\n| ${header.join(" | ")} |\n| ${separator.join(" | ")} |\n${body.map((row) => `| ${row.join(" | ")} |`).join("\n")}\n\n`;
  }

  function codeBlockToMarkdown(node) {
    const code = node.tagName?.toLowerCase() === "code" ? node : node.querySelector("code") || node;
    const language =
      detectCodeLanguage(code) || detectCodeLanguage(node) || detectCodeLanguageFromLabel(node);
    const text = getCodeText(code).replace(/\n+$/g, "");
    return `\n\n\`\`\`${language}\n${text}\n\`\`\`\n\n`;
  }

  function getCodeText(node) {
    const rendered = typeof node.innerText === "string" ? node.innerText : "";
    const raw = node.textContent || "";
    let text = rendered || raw;

    if (!text.includes("\n")) {
      const lineChildren = Array.from(node.children || []).filter((child) => {
        const className = typeof child.className === "string" ? child.className : "";
        const display = child.ownerDocument?.defaultView?.getComputedStyle?.(child)?.display || "";
        return (
          child.hasAttribute("data-line") ||
          /\bline\b/i.test(className) ||
          /^(block|list-item|table-row)$/.test(display)
        );
      });

      if (lineChildren.length > 1) {
        text = lineChildren.map((child) => child.innerText || child.textContent || "").join("\n");
      }
    }

    return text.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");
  }

  function isCodeBlockContainer(element) {
    const codes = Array.from(element.querySelectorAll("code"));
    if (codes.length !== 1) return false;

    const codeText = getCodeText(codes[0]);
    if (!codeText.includes("\n") && codeText.length < 80) return false;

    const clone = element.cloneNode(true);
    clone.querySelector("code")?.remove();
    const leftover = normalizeWhitespace(clone.textContent || "")
      .replace(/copy code/gi, "")
      .replace(/copy/gi, "")
      .trim();
    if (!leftover) return true;

    return /^(markdown|md|json|javascript|js|typescript|ts|tsx|jsx|html|css|shell|bash|sh|python|py|yaml|yml|toml|sql|rust|go|java|c|cpp|c\+\+|text|plaintext)$/i.test(
      leftover,
    );
  }

  function detectCodeLanguage(node) {
    const className = typeof node.className === "string" ? node.className : "";
    const match = className.match(/(?:language|lang)-([a-z0-9_+-]+)/i);
    return match ? normalizeCodeLanguage(match[1]) : "";
  }

  function detectCodeLanguageFromLabel(node) {
    const clone = node.cloneNode(true);
    clone.querySelector("code")?.remove();
    const label = normalizeWhitespace(clone.textContent || "")
      .replace(/copy code/gi, "")
      .replace(/copy/gi, "")
      .trim()
      .toLowerCase();
    return normalizeCodeLanguage(label);
  }

  function normalizeCodeLanguage(value) {
    const text = String(value || "")
      .trim()
      .toLowerCase();
    if (!text) return "";
    if (text === "markdown") return "md";
    if (text === "javascript") return "js";
    if (text === "typescript") return "ts";
    if (text === "python") return "py";
    if (text === "shell") return "sh";
    if (text === "plaintext") return "text";
    if (/^[a-z0-9_+-]+$/.test(text)) return text;
    return "";
  }

  function normalizeRole(role) {
    const text = String(role || "").toLowerCase();
    if (/user|human|you/.test(text)) return "user";
    if (/assistant|model|bot|ai|chatgpt|claude|gemini|copilot/.test(text)) return "assistant";
    if (/system/.test(text)) return "system";
    if (/tool/.test(text)) return "tool";
    return "unknown";
  }

  function roleToAuthor(role) {
    if (role === "user") return "user";
    if (role === "assistant") return "assistant";
    return role || "unknown";
  }

  function visibleText(node) {
    return normalizeWhitespace(node?.innerText || node?.textContent || "");
  }

  function normalizeWhitespace(text) {
    return String(text)
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n[ \t]+/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizePlainText(text) {
    return String(text)
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function markdownToPlainText(markdown) {
    const lines = String(markdown || "")
      .replace(/\r\n/g, "\n")
      .split("\n");
    const plain = [];
    let inFence = false;
    let blankLines = 0;

    for (let line of lines) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        blankLines = 0;
        continue;
      }

      if (inFence) {
        plain.push(line);
        continue;
      }

      line = line
        .replace(/^#{1,6}\s+/, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/\*\*([^*]+)\*\*/g, "$1")
        .replace(/__([^_]+)__/g, "$1")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/[ \t]+$/g, "");

      if (!line.trim()) {
        blankLines += 1;
        if (blankLines <= 1) plain.push("");
      } else {
        blankLines = 0;
        plain.push(line);
      }
    }

    return normalizePlainText(plain.join("\n"));
  }

  function normalizeMarkdown(text) {
    return compactMarkdown(text);
  }

  function compactMarkdown(text) {
    const lines = String(text)
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ")
      .split("\n");

    const compacted = [];
    let inFence = false;
    let blankLines = 0;

    for (const line of lines) {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        blankLines = 0;
        compacted.push(line.replace(/[ \t]+$/g, ""));
        continue;
      }

      if (inFence) {
        compacted.push(line);
        continue;
      }

      const cleaned = line.replace(/[ \t]+$/g, "");
      if (!cleaned.trim()) {
        blankLines += 1;
        if (blankLines <= 1) compacted.push("");
      } else {
        blankLines = 0;
        compacted.push(cleaned);
      }
    }

    return compacted.join("\n").trim();
  }

  function uniqueElements(elements) {
    return Array.from(new Set(elements));
  }

  function removeNestedDuplicates(nodes) {
    return nodes.filter((node) => {
      return !nodes.some(
        (other) =>
          other !== node && other.contains(node) && visibleText(other) === visibleText(node),
      );
    });
  }

  function isMeaningfulContainer(node) {
    const text = visibleText(node);
    if (!text) return false;
    if (["HTML", "BODY"].includes(node.tagName)) return false;
    const rect = node.getBoundingClientRect?.();
    if (rect && rect.width === 0 && rect.height === 0) return false;
    return true;
  }

  function sortByDocumentOrder(messages) {
    return messages.toSorted((a, b) => {
      const aNode = a.orderNode;
      const bNode = b.orderNode;
      if (aNode === bNode) return 0;
      if (!aNode) return 1;
      if (!bNode) return -1;
      const position = aNode.compareDocumentPosition(bNode);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }
}
