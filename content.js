(() => {
  "use strict";

  /**
   * @typedef {{
   *   enabled: boolean;
   *   removeBoxes: boolean;
   *   displayMathMode: "visual-inline" | "rerender-simple-inline";
   *   displayMathModeExplicit: boolean;
   *   skipComplexDisplayMath: boolean;
   *   displayMathEnabled: boolean;
   * }} MathNormalizerSettings
   */

  /** @type {MathNormalizerSettings} */
  const DEFAULT_SETTINGS = {
    enabled: true,
    removeBoxes: true,
    displayMathMode: "rerender-simple-inline",
    displayMathModeExplicit: false,
    skipComplexDisplayMath: false,
    displayMathEnabled: true
  };

  const CANDIDATE_SELECTOR = ".katex, .katex-display, .fbox, .fcolorbox";
  const BOX_SELECTOR = ".fbox, .fcolorbox";
  const SKIP_SELECTOR = [
    "pre",
    "code",
    "textarea",
    "[contenteditable]",
    "#prompt-textarea",
    "[data-testid='composer']",
    "form[data-type='unified-composer']",
    "[aria-label='Message ChatGPT']"
  ].join(",");

  const SIMPLE_INLINE_MACROS = {
    "\\boxed": "{#1}",
    "\\fbox": "{#1}",
    "\\fcolorbox": "{#3}"
  };
  const normalizeTexForCopy =
    globalThis.cgmnTexNormalizer &&
    typeof globalThis.cgmnTexNormalizer.normalizeTexForCopy === "function"
      ? globalThis.cgmnTexNormalizer.normalizeTexForCopy
      : (tex) => tex;
  const extensionApi = globalThis.cgmnExtensionApi;

  /** @type {MathNormalizerSettings} */
  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  let pendingRoots = new Set();
  let debounceTimer = 0;
  let nextFlowId = 1;

  init();

  function init() {
    injectClipboardHook();
    bindRuntimeMessages();
    bindCopyNormalizer();

    loadSettings().then((loaded) => {
      settings = normalizeSettings(loaded);
      applyDocumentFlags();
      processRoot(document.body || document.documentElement, true);
      startObserverWhenReady();
      bindStorageChanges();
    });
  }

  function startObserverWhenReady() {
    if (observer || !document.body) {
      if (!document.body) {
        setTimeout(startObserverWhenReady, 100);
      }
      return;
    }

    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type !== "childList") {
          continue;
        }

        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && nodeContainsCandidate(node)) {
            pendingRoots.add(node);
          }
        }
      }

      scheduleProcessing();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });
  }

  function bindStorageChanges() {
    if (!extensionApi) {
      return;
    }

    extensionApi.onStorageChanged((changes, areaName) => {
      if (areaName !== "sync") {
        return;
      }

      const nextSettings = { ...settings };
      let changed = false;

      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (Object.prototype.hasOwnProperty.call(changes, key)) {
          nextSettings[key] = changes[key].newValue;
          changed = true;
        }
      }

      if (!changed) {
        return;
      }

      settings = normalizeSettings(nextSettings);
      applyDocumentFlags();
      processRoot(document.body || document.documentElement, true);
    });
  }

  function bindRuntimeMessages() {
    if (!extensionApi) {
      return;
    }

    extensionApi.onRuntimeMessage((message, _sender, sendResponse) => {
      if (!message || message.type !== "CGMN_STATUS") {
        return false;
      }

      sendResponse({
        supported: true,
        enabled: settings.enabled
      });
      return false;
    });
  }

  function scheduleProcessing() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = 0;
      const roots = pendingRoots;
      pendingRoots = new Set();

      for (const root of roots) {
        processRoot(root, false);
      }
    }, 120);
  }

  async function loadSettings() {
    if (!extensionApi) {
      return DEFAULT_SETTINGS;
    }

    return extensionApi.storageGet(DEFAULT_SETTINGS);
  }

  function normalizeSettings(value) {
    const displayMathMode =
      value.displayMathMode === "visual-inline" &&
      value.displayMathModeExplicit === true
        ? "visual-inline"
        : "rerender-simple-inline";

    return {
      enabled: value.enabled !== false,
      removeBoxes: value.removeBoxes !== false,
      displayMathMode,
      displayMathModeExplicit: value.displayMathModeExplicit === true,
      skipComplexDisplayMath: value.skipComplexDisplayMath === true,
      displayMathEnabled: value.displayMathEnabled !== false
    };
  }

  function applyDocumentFlags() {
    const root = document.documentElement;
    root.dataset.cgmnEnabled = String(settings.enabled);
    root.dataset.cgmnRemoveBoxes = String(settings.enabled && settings.removeBoxes);
    root.dataset.cgmnDisplayInline = String(
      settings.enabled && settings.displayMathEnabled
    );
    root.dataset.cgmnDisplayMode = settings.displayMathMode;
  }

  function nodeContainsCandidate(node) {
    if (!(node instanceof Element) || isSkipped(node)) {
      return false;
    }

    return node.matches(CANDIDATE_SELECTOR) || Boolean(node.querySelector(CANDIDATE_SELECTOR));
  }

  function processRoot(root, force) {
    if (!(root instanceof Element)) {
      return;
    }

    const candidates = collectCandidates(root);
    const settingsKey = getSettingsKey();

    for (const candidate of candidates) {
      if (isSkipped(candidate)) {
        continue;
      }

      if (
        !force &&
        candidate.dataset.cgmnProcessed === "true" &&
        candidate.dataset.cgmnSettingsKey === settingsKey
      ) {
        continue;
      }

      processCandidate(candidate);
      candidate.dataset.cgmnProcessed = "true";
      candidate.dataset.cgmnSettingsKey = settingsKey;
    }
  }

  function collectCandidates(root) {
    const candidates = [];

    if (root.matches(CANDIDATE_SELECTOR)) {
      candidates.push(root);
    }

    candidates.push(...root.querySelectorAll(CANDIDATE_SELECTOR));
    return candidates;
  }

  function processCandidate(candidate) {
    if (candidate.matches(".katex")) {
      processMathWrapper(candidate);
    }

    if (candidate.matches(BOX_SELECTOR)) {
      processBox(candidate);
    }

    if (candidate.matches(".katex-display")) {
      processDisplayMath(candidate);
    }
  }

  function processBox(boxNode) {
    const mathWrapper = boxNode.closest(".katex");
    if (!mathWrapper) {
      return;
    }

    mathWrapper.dataset.cgmnUnboxed = "true";
    const displayWrapper = mathWrapper.closest(".katex-display");
    if (displayWrapper) {
      displayWrapper.dataset.cgmnUnboxed = "true";
    }
  }

  function processMathWrapper(mathNode) {
    if (mathNode.closest("[data-cgmn-unboxed-render]")) {
      return;
    }

    if (!settings.enabled || !settings.removeBoxes) {
      removeUnboxedRender(mathNode);
      restoreTexAnnotations(mathNode);
      return;
    }

    renderUnboxedMath(mathNode);
    normalizeTexAnnotations(mathNode);
  }

  function normalizeTexAnnotations(root) {
    const annotations = root.querySelectorAll(
      'annotation[encoding="application/x-tex"]'
    );

    for (const annotation of annotations) {
      const original =
        annotation.getAttribute("data-cgmn-original-tex") ||
        annotation.textContent ||
        "";
      const normalized = normalizeTexForCopy(original);

      if (normalized === original) {
        continue;
      }

      annotation.setAttribute("data-cgmn-original-tex", original);
      annotation.textContent = normalized;
    }
  }

  function restoreTexAnnotations(root) {
    const annotations = root.querySelectorAll(
      'annotation[encoding="application/x-tex"][data-cgmn-original-tex]'
    );

    for (const annotation of annotations) {
      annotation.textContent = annotation.getAttribute("data-cgmn-original-tex") || "";
      annotation.removeAttribute("data-cgmn-original-tex");
    }
  }

  function renderUnboxedMath(mathNode) {
    if (!globalThis.katex || typeof globalThis.katex.render !== "function") {
      return;
    }

    const rawTex = readMathTex(mathNode);
    const normalizedTex = normalizeTexForCopy(rawTex);

    if (!rawTex || normalizedTex === rawTex) {
      removeUnboxedRender(mathNode);
      return;
    }

    const sourceId = ensureUnboxedSourceId(mathNode);
    const existing = document.querySelector(
      `[data-cgmn-unboxed-for="${cssEscape(sourceId)}"]`
    );

    if (
      existing &&
      existing.dataset.cgmnRenderedTex === rawTex &&
      existing.dataset.cgmnNormalizedTex === normalizedTex
    ) {
      mathNode.dataset.cgmnUnboxedOriginal = "true";
      return;
    }

    removeUnboxedRender(mathNode);

    const mount = document.createElement("span");
    mount.dataset.cgmnUnboxedRender = "true";
    mount.dataset.cgmnUnboxedFor = sourceId;
    mount.dataset.cgmnRenderedTex = rawTex;
    mount.dataset.cgmnNormalizedTex = normalizedTex;

    try {
      globalThis.katex.render(normalizedTex, mount, {
        displayMode: false,
        throwOnError: true,
        strict: "ignore",
        trust: false,
        macros: SIMPLE_INLINE_MACROS
      });
    } catch (_error) {
      mount.remove();
      delete mathNode.dataset.cgmnUnboxedOriginal;
      return;
    }

    mathNode.before(mount);
    mathNode.dataset.cgmnUnboxedOriginal = "true";
  }

  function removeUnboxedRender(mathNode) {
    const sourceId = mathNode.dataset.cgmnUnboxedSourceId;
    if (sourceId) {
      const selector = `[data-cgmn-unboxed-for="${cssEscape(sourceId)}"]`;
      for (const node of document.querySelectorAll(selector)) {
        node.remove();
      }
    }

    delete mathNode.dataset.cgmnUnboxedSourceId;
    delete mathNode.dataset.cgmnUnboxedOriginal;
  }

  function ensureUnboxedSourceId(mathNode) {
    if (!mathNode.dataset.cgmnUnboxedSourceId) {
      mathNode.dataset.cgmnUnboxedSourceId = `cgmn-box-${nextFlowId}`;
      nextFlowId += 1;
    }

    return mathNode.dataset.cgmnUnboxedSourceId;
  }

  function readMathTex(mathNode) {
    const annotation = mathNode.querySelector(
      'annotation[encoding="application/x-tex"]'
    );

    return annotation
      ? (
          annotation.getAttribute("data-cgmn-original-tex") ||
          annotation.textContent ||
          ""
        ).trim()
      : "";
  }

  function processDisplayMath(displayNode) {
    if (!settings.enabled || !settings.displayMathEnabled) {
      removeInlineRender(displayNode);
      clearInlineFlow(displayNode);
      delete displayNode.dataset.cgmnComplex;
      return;
    }

    const rawTex = readTex(displayNode);
    const complex = isComplexFormula(rawTex) || widthExceedsContainer(displayNode);

    if (complex && settings.skipComplexDisplayMath) {
      displayNode.dataset.cgmnComplex = "true";
      removeInlineRender(displayNode);
      clearInlineFlow(displayNode);
      return;
    }

    delete displayNode.dataset.cgmnComplex;

    if (settings.displayMathMode !== "rerender-simple-inline") {
      removeInlineRender(displayNode);
      clearInlineFlow(displayNode);
      return;
    }

    if (!rawTex || complex) {
      removeInlineRender(displayNode);
      clearInlineFlow(displayNode);
      return;
    }

    renderSimpleInline(displayNode, rawTex);
  }

  function readTex(displayNode) {
    const annotation = displayNode.querySelector(
      'annotation[encoding="application/x-tex"]'
    );
    return annotation
      ? (
          annotation.getAttribute("data-cgmn-original-tex") ||
          annotation.textContent ||
          ""
        ).trim()
      : "";
  }

  function isComplexFormula(rawTex) {
    if (!rawTex) {
      return false;
    }

    if (rawTex.length > 180) {
      return true;
    }

    return /\\begin\{(?:align|aligned|matrix|cases)/.test(rawTex)
      || /\\tag\b/.test(rawTex)
      || /\\\\/.test(rawTex);
  }

  function widthExceedsContainer(displayNode) {
    const formulaWidth = Math.max(displayNode.scrollWidth, displayNode.getBoundingClientRect().width);
    const container = displayNode.closest(
      "[data-message-author-role], article, main"
    );

    if (!container) {
      return false;
    }

    const containerWidth = container.getBoundingClientRect().width;
    if (!containerWidth || !formulaWidth) {
      return false;
    }

    return formulaWidth > containerWidth * 1.15 && formulaWidth - containerWidth > 48;
  }

  function renderSimpleInline(displayNode, rawTex) {
    if (!globalThis.katex || typeof globalThis.katex.render !== "function") {
      removeInlineRender(displayNode);
      return;
    }

    const normalizedTex =
      settings.enabled && settings.removeBoxes
        ? normalizeTexForCopy(rawTex)
        : rawTex;
    const existing = displayNode.querySelector(":scope > [data-cgmn-inline-render]");
    if (
      existing &&
      existing.dataset.cgmnRenderedTex === rawTex &&
      existing.dataset.cgmnNormalizedTex === normalizedTex &&
      displayNode.dataset.cgmnRerendered === "true"
    ) {
      applyInlineFlow(displayNode);
      return;
    }

    removeInlineRender(displayNode);
    clearInlineFlow(displayNode);

    const mount = document.createElement("span");
    mount.dataset.cgmnInlineRender = "true";
    mount.dataset.cgmnRenderedTex = rawTex;
    mount.dataset.cgmnNormalizedTex = normalizedTex;

    try {
      globalThis.katex.render(normalizedTex, mount, {
        displayMode: false,
        throwOnError: true,
        strict: "ignore",
        trust: false,
        macros:
          settings.enabled && settings.removeBoxes ? SIMPLE_INLINE_MACROS : undefined
      });
    } catch (_error) {
      mount.remove();
      delete displayNode.dataset.cgmnRerendered;
      return;
    }

    displayNode.prepend(mount);
    displayNode.dataset.cgmnRerendered = "true";
    applyInlineFlow(displayNode);
  }

  function removeInlineRender(displayNode) {
    const renderedNodes = displayNode.querySelectorAll(
      ":scope > [data-cgmn-inline-render]"
    );

    for (const node of renderedNodes) {
      node.remove();
    }

    delete displayNode.dataset.cgmnRerendered;
  }

  function applyInlineFlow(displayNode) {
    clearInlineFlow(displayNode);

    const ownerId = `cgmn-${nextFlowId}`;
    nextFlowId += 1;
    displayNode.dataset.cgmnFlowId = ownerId;
    displayNode.dataset.cgmnInlineFlow = "true";
    displayNode.dataset.cgmnFlowOwner = ownerId;

    const flowBlock = getMathOnlyFlowBlock(displayNode) || displayNode;
    markFlowElement(flowBlock, ownerId);

    const previousBlock = getPreviousElementSibling(flowBlock);
    const nextBlock = getNextElementSibling(flowBlock);

    if (isMergeableTextBlock(previousBlock)) {
      markFlowElement(previousBlock, ownerId);
      previousBlock.dataset.cgmnFlowSpaceAfter = "true";
    }

    if (isMergeableTextBlock(nextBlock)) {
      markFlowElement(nextBlock, ownerId);
    }
  }

  function clearInlineFlow(displayNode) {
    const ownerId = displayNode.dataset.cgmnFlowId;
    if (!ownerId) {
      delete displayNode.dataset.cgmnInlineFlow;
      delete displayNode.dataset.cgmnFlowOwner;
      return;
    }

    const ownerSelector = `[data-cgmn-flow-owner="${cssEscape(ownerId)}"]`;
    for (const node of document.querySelectorAll(ownerSelector)) {
      delete node.dataset.cgmnInlineFlow;
      delete node.dataset.cgmnInlineFlowBlock;
      delete node.dataset.cgmnFlowOwner;
      delete node.dataset.cgmnFlowSpaceAfter;
    }

    delete displayNode.dataset.cgmnFlowId;
  }

  function markFlowElement(element, ownerId) {
    element.dataset.cgmnInlineFlowBlock = "true";
    element.dataset.cgmnFlowOwner = ownerId;
  }

  function getMathOnlyFlowBlock(displayNode) {
    const parent = displayNode.parentElement;
    if (!parent || !["P", "DIV", "LI"].includes(parent.tagName)) {
      return null;
    }

    if (parent.matches(SKIP_SELECTOR)) {
      return null;
    }

    for (const child of parent.childNodes) {
      if (child === displayNode) {
        continue;
      }

      if (child.nodeType === Node.TEXT_NODE && child.textContent.trim() === "") {
        continue;
      }

      return null;
    }

    return parent;
  }

  function getPreviousElementSibling(element) {
    let sibling = element.previousElementSibling;
    while (sibling && isIgnorableFlowSibling(sibling)) {
      sibling = sibling.previousElementSibling;
    }
    return sibling;
  }

  function getNextElementSibling(element) {
    let sibling = element.nextElementSibling;
    while (sibling && isIgnorableFlowSibling(sibling)) {
      sibling = sibling.nextElementSibling;
    }
    return sibling;
  }

  function isIgnorableFlowSibling(element) {
    return element.matches("script, style") || element.hidden;
  }

  function isMergeableTextBlock(element) {
    if (!element || !["P", "DIV", "LI"].includes(element.tagName)) {
      return false;
    }

    if (isSkipped(element)) {
      return false;
    }

    const text = element.textContent.trim();
    if (!text || text.length > 240) {
      return false;
    }

    return !element.querySelector(
      "pre, code, table, ul, ol, blockquote, h1, h2, h3, h4, h5, h6, .katex-display[data-cgmn-complex='true']"
    );
  }

  function cssEscape(value) {
    if (globalThis.CSS && typeof globalThis.CSS.escape === "function") {
      return globalThis.CSS.escape(value);
    }

    return value.replace(/["\\]/g, "\\$&");
  }

  function isSkipped(element) {
    return Boolean(element.closest(SKIP_SELECTOR));
  }

  function bindCopyNormalizer() {
    document.addEventListener(
      "copy",
      (event) => {
        if (!settings.enabled || !settings.removeBoxes || !event.clipboardData) {
          return;
        }

        const selection = document.getSelection();
        if (!selection || selection.isCollapsed || !selection.rangeCount) {
          return;
        }

        const anchorElement = getSelectionElement(selection);
        if (!anchorElement || isSkipped(anchorElement)) {
          return;
        }

        const selectedText = selection.toString();
        const normalizedText = normalizeTexForCopy(selectedText);

        if (normalizedText === selectedText) {
          return;
        }

        event.clipboardData.setData("text/plain", normalizedText);
        event.preventDefault();
      },
      true
    );
  }

  function injectClipboardHook() {
    if (!extensionApi || typeof extensionApi.runtimeGetURL !== "function") {
      return;
    }

    injectPageScript("tex-normalizer.js", () => {
      injectPageScript("page-clipboard-hook.js");
    });
  }

  function injectPageScript(path, onLoad) {
    const url = extensionApi.runtimeGetURL(path);
    if (!url || !document.documentElement) {
      return;
    }

    const script = document.createElement("script");
    script.src = url;
    script.onload = () => {
      script.remove();
      if (onLoad) {
        onLoad();
      }
    };
    script.onerror = () => script.remove();
    document.documentElement.append(script);
  }

  function getSelectionElement(selection) {
    const node = selection.anchorNode || selection.focusNode;
    if (!node) {
      return null;
    }

    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
  }

  function getSettingsKey() {
    return [
      settings.enabled,
      settings.removeBoxes,
      settings.displayMathMode,
      settings.displayMathModeExplicit,
      settings.skipComplexDisplayMath,
      settings.displayMathEnabled
    ].join("|");
  }
})();
