(function () {
  if (window.__wgwQuickSnapshotterExtensionActive) {
    return;
  }
  window.__wgwQuickSnapshotterExtensionActive = true;

  const overlay = document.createElement("div");
  overlay.id = "screenshot-extension-overlay";
  document.body.appendChild(overlay);

  const highlight = document.createElement("div");
  highlight.id = "screenshot-extension-highlight";
  highlight.innerHTML = `
    <div class="screenshot-handle n" data-handle="n"></div>
    <div class="screenshot-handle s" data-handle="s"></div>
    <div class="screenshot-handle e" data-handle="e"></div>
    <div class="screenshot-handle w" data-handle="w"></div>
    <div class="screenshot-handle nw" data-handle="nw"></div>
    <div class="screenshot-handle ne" data-handle="ne"></div>
    <div class="screenshot-handle sw" data-handle="sw"></div>
    <div class="screenshot-handle se" data-handle="se"></div>
  `;
  document.body.appendChild(highlight);

  const actionUi = document.createElement("div");
  actionUi.id = "screenshot-extension-actions";
  actionUi.innerHTML = `
    <button id="screenshot-btn-download">Download</button>
    <button id="screenshot-btn-copy">Copy to Clipboard</button>
    <button id="screenshot-btn-cancel">Cancel</button>
  `;
  document.body.appendChild(actionUi);

  let currentTarget = null;
  let locked = false;

  let isMouseDown = false;
  let isDragging = false;
  let isResizing = false;
  let resizeHandle = null;
  let originalRect = null;

  let startX = 0;
  let startY = 0;
  let selectedRect = null;

  function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
  }

  function updateHighlightDOM() {
    if (!selectedRect) {
      return;
    }
    highlight.style.left = `${selectedRect.x}px`;
    highlight.style.top = `${selectedRect.y}px`;
    highlight.style.width = `${selectedRect.width}px`;
    highlight.style.height = `${selectedRect.height}px`;
    highlight.style.display = "block";
    highlight.style.border = "2px dashed #ffffff";
    highlight.style.background = "transparent";
  }

  function positionActionUi() {
    actionUi.style.display = "flex";

    const uiWidth = actionUi.offsetWidth || 200;
    const uiHeight = actionUi.offsetHeight || 40;

    let topPos = selectedRect.bottom + 10;
    if (topPos + uiHeight > window.innerHeight) {
      topPos = selectedRect.top - uiHeight - 10;
    }
    // if still out of bounds (element bigger than viewport)
    if (topPos < 0) topPos = 10;

    let leftPos = selectedRect.right - uiWidth;
    if (leftPos < 0) {
      leftPos = selectedRect.left;
      if (leftPos < 0) leftPos = 10;
    }

    actionUi.style.top = `${topPos}px`;
    actionUi.style.left = `${leftPos}px`;
    actionUi.style.opacity = "1";
    actionUi.style.pointerEvents = "auto";
  }

  function onMouseDown(e) {
    if (e.target.closest("#screenshot-extension-actions")) {
      return;
    }

    if (locked) {
      if (e.target.classList.contains("screenshot-handle")) {
        isResizing = true;
        resizeHandle = e.target.dataset.handle;
        originalRect = { ...selectedRect };
        startX = e.clientX;
        startY = e.clientY;

        // Hide actions while resizing
        actionUi.style.opacity = "0";
        actionUi.style.pointerEvents = "none";
        return;
      }

      // Click outside to unlock
      locked = false;
      highlight.classList.remove("locked");
      actionUi.style.display = "none";

      // Update hover highlight immediately based on mouse position
      isMouseDown = true;
      startX = e.clientX;
      startY = e.clientY;
      isDragging = false;
      return;
    }

    if (e.button !== 0) {
      return; // Only left clic
    }

    isMouseDown = true;
    isDragging = false;
    startX = e.clientX;
    startY = e.clientY;
  }

  function onMouseMove(e) {
    if (isResizing) {
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      let { x, y, width, height } = originalRect;

      if (resizeHandle.includes("n")) {
        y += dy;
        height -= dy;
      }
      if (resizeHandle.includes("s")) {
        height += dy;
      }
      if (resizeHandle.includes("w")) {
        x += dx;
        width -= dx;
      }
      if (resizeHandle.includes("e")) {
        width += dx;
      }

      // Prevent negative size
      if (width < 10) {
        width = 10;
        if (resizeHandle.includes("w")) x = originalRect.x + originalRect.width - 10;
      }
      if (height < 10) {
        height = 10;
        if (resizeHandle.includes("n")) y = originalRect.y + originalRect.height - 10;
      }

      // Constrain to viewport
      if (x < 0) {
        width += x;
        x = 0;
      }
      if (y < 0) {
        height += y;
        y = 0;
      }
      if (x + width > window.innerWidth) width = window.innerWidth - x;
      if (y + height > window.innerHeight) height = window.innerHeight - y;

      selectedRect = {
        x,
        y,
        width,
        height,
        bottom: y + height,
        right: x + width,
        top: y,
        left: x,
      };
      updateHighlightDOM();
      return;
    }

    if (locked) {
      return;
    }

    if (isMouseDown) {
      isDragging = true;
      const currentX = clamp(e.clientX, 0, window.innerWidth);
      const currentY = clamp(e.clientY, 0, window.innerHeight);

      const cx = clamp(startX, 0, window.innerWidth);
      const cy = clamp(startY, 0, window.innerHeight);

      const x = Math.min(cx, currentX);
      const y = Math.min(cy, currentY);
      const width = Math.abs(cx - currentX);
      const height = Math.abs(cy - currentY);

      selectedRect = {
        x,
        y,
        width,
        height,
        bottom: y + height,
        right: x + width,
        top: y,
        left: x,
      };

      updateHighlightDOM();
      return;
    }

    // Element hover mode
    overlay.style.pointerEvents = "none";
    highlight.style.pointerEvents = "none";
    actionUi.style.pointerEvents = "none";

    const target = document.elementFromPoint(e.clientX, e.clientY);

    overlay.style.pointerEvents = "auto";

    if (!target || target === document.body || target === document.documentElement) {
      currentTarget = null;
      selectedRect = null;
      highlight.style.display = "none";
      return;
    }

    if (target === currentTarget) {
      return;
    }

    currentTarget = target;
    const rect = target.getBoundingClientRect();

    // Constrain bounding client rect to viewport
    const top = Math.max(0, rect.top);
    const left = Math.max(0, rect.left);
    const bottom = Math.min(window.innerHeight, rect.bottom);
    const right = Math.min(window.innerWidth, rect.right);
    const width = Math.max(0, right - left);
    const height = Math.max(0, bottom - top);

    selectedRect = {
      x: left,
      y: top,
      width: width,
      height: height,
      bottom: bottom,
      right: right,
      top: top,
      left: left,
    };

    updateHighlightDOM();
  }

  function onMouseUp(e) {
    if (e.target.closest("#screenshot-extension-actions")) {
      return;
    }

    if (isResizing) {
      isResizing = false;
      positionActionUi();
      return;
    }

    if (!isMouseDown) {
      return;
    }
    isMouseDown = false;

    if (isDragging) {
      if (selectedRect && selectedRect.width > 10 && selectedRect.height > 10) {
        lockSelection();
        return;
      }

      // Drag was too small, cancel
      highlight.style.display = "none";
      selectedRect = null;

      return;
    }

    // Just a click, lock the currently hovered element
    if (selectedRect) {
      lockSelection();
    }
  }

  function lockSelection() {
    locked = true;
    highlight.classList.add("locked");
    updateHighlightDOM(); // Ensure borders are drawn correctly

    actionUi.style.opacity = "0";
    actionUi.style.display = "flex";

    // Slight delay to allow CSS calculation for offsetWidth/Height
    setTimeout(positionActionUi, 0);
  }

  function onClick(e) {
    if (!e.target.closest("#screenshot-extension-actions")) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    const id = e.target.id;

    if (id === "screenshot-btn-cancel") {
      cleanup();
      return;
    }

    if (id === "screenshot-btn-download" || id === "screenshot-btn-copy") {
      const action = id === "screenshot-btn-download" ? "download" : "copy";
      const rectToCapture = selectedRect;
      cleanup();

      if (!rectToCapture) {
        return;
      }

      chrome.runtime.sendMessage(
        {
          type: "ELEMENT_SELECTED",
          action: action,
          rect: {
            x: rectToCapture.x,
            y: rectToCapture.y,
            width: rectToCapture.width,
            height: rectToCapture.height,
          },
          dpr: window.devicePixelRatio,
        },
        async (response) => {
          if (response && response.success && action === "copy") {
            try {
              const res = await fetch(response.dataUrl);
              const blob = await res.blob();
              await navigator.clipboard.write([
                new ClipboardItem({
                  [blob.type]: blob,
                }),
              ]);
            } catch (err) {
              console.error("Failed to copy image: ", err);
              alert("Failed to copy to clipboard.");
            }
          }
        },
      );
    }
  }

  function onKeyDown(e) {
    if (e.key === "Escape") {
      cleanup();
    }
  }

  function cleanup() {
    document.removeEventListener("mousedown", onMouseDown, true);
    document.removeEventListener("mousemove", onMouseMove, true);
    document.removeEventListener("mouseup", onMouseUp, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKeyDown, true);
    if (overlay.parentNode) {
      overlay.parentNode.removeChild(overlay);
    }
    if (highlight.parentNode) {
      highlight.parentNode.removeChild(highlight);
    }
    if (actionUi.parentNode) {
      actionUi.parentNode.removeChild(actionUi);
    }
    window.__wgwQuickSnapshotterExtensionActive = false;
  }

  document.addEventListener("mousedown", onMouseDown, true);
  document.addEventListener("mousemove", onMouseMove, true);
  document.addEventListener("mouseup", onMouseUp, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKeyDown, true);
})();
