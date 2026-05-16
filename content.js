(() => {
  "use strict";

  /**
   * @typedef {{
   *   enabled: boolean;
   *   removeBoxes: boolean;
   *   displayMathMode: "visual-inline" | "rerender-simple-inline";
   *   displayMathModeExplicit: boolean;
   *   skipComplexDisplayMath: boolean;
   *   skipComplexDisplayMathExplicit: boolean;
   *   displayMathEnabled: boolean;
   * }} MathNormalizerSettings
   */

  /** @type {MathNormalizerSettings} */
  const DEFAULT_SETTINGS = {
    enabled: true,
    removeBoxes: true,
    displayMathMode: "rerender-simple-inline",
    displayMathModeExplicit: false,
    skipComplexDisplayMath: true,
    skipComplexDisplayMathExplicit: false,
    displayMathEnabled: true
  };

  const CANDIDATE_SELECTOR = ".katex-display, .fbox, .fcolorbox";
  const BOX_SELECTOR = ".fbox, .fcolorbox";
  const DEFER_OFFSCREEN_PROCESSING = false;
  const IMMEDIATE_CANDIDATE_LIMIT = 120;
  const DEFERRED_BATCH_SIZE = 80;
  const DEFERRED_BATCH_TIMEOUT_MS = 250;
  const WIDTH_CACHE_LIMIT = 300;
  const MEASURE_DISPLAY_WIDTH = false;
  const RERENDER_SIMPLE_DISPLAY_MATH = false;
  const RERENDER_UNBOXED_MATH = false;
  const DISPLAY_COMPLEX_HINT_PATTERN =
    /\\begin\{|\\tag\b|\\\\|\\(?:d?frac|sum|prod|coprod|int|iint|iiint|lim|bigcup|bigcap|left|right|middle|substack|underset|overset|operatorname|quad|qquad)\b/;
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
  const TEX_ANNOTATION_SELECTOR = 'annotation[encoding="application/x-tex"]';
  const BOX_MACRO_PATTERN = /\\(?:boxed|fbox|fcolorbox)(?![A-Za-z])/;
  const normalizeTexForCopy =
    globalThis.cgmnTexNormalizer &&
    typeof globalThis.cgmnTexNormalizer.normalizeTexForCopy === "function"
      ? globalThis.cgmnTexNormalizer.normalizeTexForCopy
      : (tex) => tex;
  const extensionApi = globalThis.cgmnExtensionApi;
  const classifyDisplayMath =
    globalThis.cgmnDisplayPolicy &&
    typeof globalThis.cgmnDisplayPolicy.classifyDisplayMath === "function"
      ? globalThis.cgmnDisplayPolicy.classifyDisplayMath
      : () => ({ preserve: false, reason: "policy-unavailable" });
  const needsDisplayMeasurement =
    globalThis.cgmnDisplayPolicy &&
    typeof globalThis.cgmnDisplayPolicy.needsDisplayMeasurement === "function"
      ? globalThis.cgmnDisplayPolicy.needsDisplayMeasurement
      : () => true;

  /** @type {MathNormalizerSettings} */
  let settings = { ...DEFAULT_SETTINGS };
  let observer = null;
  let pendingRoots = new Set();
  let deferredCandidates = [];
  let deferredTimer = 0;
  let initialBodyProcessed = false;
  let processingScheduled = false;
  let nextFlowId = 1;
  const widthByTex = new Map();
  const unboxedRenderByMath = new WeakMap();
  const inlineRenderByDisplay = new WeakMap();

  init();

  function init() {
    injectRenderHook();
    injectClipboardHook();
    bindRuntimeMessages();
    bindCopyNormalizer();
    applyDocumentFlags();
    initialBodyProcessed = Boolean(document.body);
    processRoot(document.body || document.documentElement, true);
    startObserverWhenReady();
    bindStorageChanges();

    loadSettings().then((loaded) => {
      const previousSettingsKey = getSettingsKey();
      settings = normalizeSettings(loaded);
      applyDocumentFlags();
      if (getSettingsKey() !== previousSettingsKey) {
        processRoot(document.body || document.documentElement, true);
      }
    });
  }

  function startObserverWhenReady() {
    if (observer) {
      return;
    }

    const observeRoot = document.body || document.documentElement;
    if (!observeRoot) {
      setTimeout(startObserverWhenReady, 10);
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

    observer.observe(observeRoot, {
      childList: true,
      subtree: true
    });

    if (!initialBodyProcessed && document.body) {
      initialBodyProcessed = true;
      processRoot(document.body, true);
    }
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
    if (processingScheduled) {
      return;
    }

    processingScheduled = true;

    if (typeof globalThis.queueMicrotask === "function") {
      globalThis.queueMicrotask(processPendingRoots);
      return;
    }

    Promise.resolve().then(processPendingRoots);
  }

  function processPendingRoots() {
    processingScheduled = false;
    const roots = pendingRoots;
    pendingRoots = new Set();

    for (const root of roots) {
      processRoot(root, false);
    }
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
      skipComplexDisplayMath:
        value.skipComplexDisplayMathExplicit === true
          ? value.skipComplexDisplayMath === true
          : true,
      skipComplexDisplayMathExplicit:
        value.skipComplexDisplayMathExplicit === true,
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

    const candidates = collectCandidates(root, force);
    const settingsKey = getSettingsKey();

    if (!DEFER_OFFSCREEN_PROCESSING) {
      for (const candidate of candidates) {
        processCandidateForSettings(candidate, force, settingsKey, false);
      }
      return;
    }

    const immediateCandidates = [];
    const deferredCandidatesForRoot = [];

    for (const candidate of candidates) {
      if (!shouldProcessCandidate(candidate, force, settingsKey)) {
        continue;
      }

      if (immediateCandidates.length < IMMEDIATE_CANDIDATE_LIMIT) {
        immediateCandidates.push(candidate);
      } else {
        deferredCandidatesForRoot.push(candidate);
      }
    }

    for (const candidate of immediateCandidates) {
      processCandidateForSettings(candidate, force, settingsKey, false);
    }

    queueDeferredCandidates(deferredCandidatesForRoot, force, settingsKey);
  }

  function shouldProcessCandidate(candidate, force, settingsKey) {
    if (!(candidate instanceof Element) || isSkipped(candidate)) {
      return false;
    }

    return (
      force ||
      candidate.dataset.cgmnProcessed !== "true" ||
      candidate.dataset.cgmnSettingsKey !== settingsKey
    );
  }

  function processCandidateForSettings(
    candidate,
    force,
    settingsKey,
    checkCurrentSettings
  ) {
    if (
      !candidate.isConnected ||
      (checkCurrentSettings && getSettingsKey() !== settingsKey) ||
      !shouldProcessCandidate(candidate, force, settingsKey)
    ) {
      return;
    }

    processCandidate(candidate);
    candidate.dataset.cgmnProcessed = "true";
    candidate.dataset.cgmnSettingsKey = settingsKey;
  }

  function queueDeferredCandidates(candidates, force, settingsKey) {
    if (!candidates.length) {
      return;
    }

    for (const candidate of candidates) {
      deferredCandidates.push({ candidate, force, settingsKey });
    }

    scheduleDeferredProcessing();
  }

  function scheduleDeferredProcessing() {
    if (deferredTimer) {
      return;
    }

    const callback = (deadline) => {
      deferredTimer = 0;
      processDeferredCandidates(deadline);
    };

    if (typeof globalThis.requestIdleCallback === "function") {
      deferredTimer = globalThis.requestIdleCallback(callback, {
        timeout: DEFERRED_BATCH_TIMEOUT_MS
      });
      return;
    }

    deferredTimer = setTimeout(() => callback(null), 0);
  }

  function processDeferredCandidates(deadline) {
    let processed = 0;

    while (deferredCandidates.length) {
      const item = deferredCandidates.shift();
      processCandidateForSettings(item.candidate, item.force, item.settingsKey, true);
      processed += 1;

      if (processed >= DEFERRED_BATCH_SIZE) {
        break;
      }

      if (
        deadline &&
        typeof deadline.timeRemaining === "function" &&
        deadline.timeRemaining() <= 2
      ) {
        break;
      }
    }

    if (deferredCandidates.length) {
      scheduleDeferredProcessing();
    }
  }

  function collectCandidates(root, force) {
    const candidates = [];
    const seen = new Set();
    const collectDisplays = settings.enabled && settings.displayMathEnabled;
    const collectBoxes = settings.enabled && settings.removeBoxes;

    if (!settings.enabled && !force) {
      return candidates;
    }

    if ((collectDisplays || force) && root.matches(".katex-display")) {
      addCandidate(root);
    } else if (
      (collectBoxes || force) &&
      root.matches(".katex") &&
      root.querySelector(BOX_SELECTOR)
    ) {
      addCandidate(root);
    } else if ((collectBoxes || force) && root.matches(BOX_SELECTOR)) {
      addBoxedMathCandidate(root);
    }

    if (collectDisplays || force) {
      for (const displayNode of root.querySelectorAll(".katex-display")) {
        addCandidate(displayNode);
      }
    }

    if (collectBoxes || force) {
      for (const boxNode of root.querySelectorAll(BOX_SELECTOR)) {
        addBoxedMathCandidate(boxNode);
      }
    }

    return candidates;

    function addBoxedMathCandidate(boxNode) {
      const mathWrapper = boxNode.closest(".katex");
      if (mathWrapper) {
        addCandidate(mathWrapper);
      }
    }

    function addCandidate(candidate) {
      if (seen.has(candidate)) {
        return;
      }

      seen.add(candidate);
      candidates.push(candidate);
    }
  }

  function processCandidate(candidate) {
    if (candidate.matches(".katex-display")) {
      processDisplayMath(candidate);
      return;
    }

    if (candidate.matches(".katex")) {
      processBoxedMathWrapper(candidate);
    }
  }

  function processBoxedMathWrapper(mathWrapper) {
    if (settings.enabled && settings.removeBoxes) {
      mathWrapper.dataset.cgmnUnboxed = "true";
    } else {
      delete mathWrapper.dataset.cgmnUnboxed;
    }

    const displayWrapper = mathWrapper.closest(".katex-display");
    if (displayWrapper && settings.enabled && settings.removeBoxes) {
      displayWrapper.dataset.cgmnUnboxed = "true";
    } else if (displayWrapper) {
      delete displayWrapper.dataset.cgmnUnboxed;
    }

    if (displayWrapper && displayWrapper.dataset.cgmnRerendered === "true") {
      return;
    }

    processMathWrapper(mathWrapper);
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

    if (RERENDER_UNBOXED_MATH) {
      renderUnboxedMath(mathNode);
    } else {
      removeUnboxedRender(mathNode, true);
      delete mathNode.dataset.cgmnUnboxedOriginal;
    }

    normalizeTexAnnotations(mathNode);
  }

  function normalizeTexAnnotations(root) {
    const annotation = root.querySelector(TEX_ANNOTATION_SELECTOR);
    if (!annotation) {
      return;
    }

    const original =
      annotation.getAttribute("data-cgmn-original-tex") ||
      annotation.textContent ||
      "";
    if (!containsBoxMacro(original)) {
      return;
    }

    const normalized = normalizeTexForCopy(original);

    if (normalized === original) {
      return;
    }

    annotation.setAttribute("data-cgmn-original-tex", original);
    annotation.textContent = normalized;
  }

  function restoreTexAnnotations(root) {
    const annotations = root.querySelectorAll(
      `${TEX_ANNOTATION_SELECTOR}[data-cgmn-original-tex]`
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
    const existing = getUnboxedRender(mathNode);

    if (
      existing &&
      existing.isConnected &&
      existing.dataset.cgmnRenderedTex === rawTex &&
      existing.dataset.cgmnNormalizedTex === normalizedTex
    ) {
      mathNode.dataset.cgmnUnboxedOriginal = "true";
      return;
    }

    removeUnboxedRender(mathNode, true);

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
    unboxedRenderByMath.set(mathNode, mount);
    mathNode.dataset.cgmnUnboxedOriginal = "true";
  }

  function getUnboxedRender(mathNode) {
    const existing = unboxedRenderByMath.get(mathNode);
    if (existing && existing.isConnected) {
      return existing;
    }

    const sourceId = mathNode.dataset.cgmnUnboxedSourceId;
    const previous = mathNode.previousElementSibling;
    if (
      sourceId &&
      previous &&
      previous.matches("[data-cgmn-unboxed-render]") &&
      previous.dataset.cgmnUnboxedFor === sourceId
    ) {
      unboxedRenderByMath.set(mathNode, previous);
      return previous;
    }

    return null;
  }

  function removeUnboxedRender(mathNode, preserveSourceId) {
    const sourceId = mathNode.dataset.cgmnUnboxedSourceId;
    const existing = getUnboxedRender(mathNode);
    if (existing) {
      existing.remove();
      unboxedRenderByMath.delete(mathNode);
    }

    if (!preserveSourceId || !sourceId) {
      delete mathNode.dataset.cgmnUnboxedSourceId;
    }
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
    const annotation = mathNode.querySelector(TEX_ANNOTATION_SELECTOR);

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
    let displayPolicy = isClearlyInlineDisplayTex(rawTex)
      ? { preserve: false, reason: "quick-inline-worthy" }
      : classifyDisplayMath(rawTex);
    if (
      settings.skipComplexDisplayMath &&
      MEASURE_DISPLAY_WIDTH &&
      !displayPolicy.preserve &&
      needsDisplayMeasurement(rawTex)
    ) {
      displayPolicy = classifyDisplayMath(rawTex, getDisplayMetrics(displayNode, rawTex));
    }
    const preserveDisplay =
      displayPolicy.reason === "forced-display-construct" ||
      (settings.skipComplexDisplayMath && displayPolicy.preserve);

    if (preserveDisplay) {
      displayNode.dataset.cgmnComplex = "true";
      displayNode.dataset.cgmnDisplayReason = displayPolicy.reason;
      removeInlineRender(displayNode);
      clearInlineFlow(displayNode);
      return;
    }

    delete displayNode.dataset.cgmnComplex;
    delete displayNode.dataset.cgmnDisplayReason;

    if (!rawTex) {
      removeInlineRender(displayNode);
      clearInlineFlow(displayNode);
      return;
    }

    if (settings.displayMathMode !== "rerender-simple-inline") {
      removeInlineRender(displayNode);
      applyInlineFlow(displayNode);
      return;
    }

    if (!RERENDER_SIMPLE_DISPLAY_MATH) {
      removeInlineRender(displayNode);
      applyInlineFlow(displayNode);
      return;
    }

    renderSimpleInline(displayNode, rawTex);
  }

  function readTex(displayNode) {
    const annotation = displayNode.querySelector(TEX_ANNOTATION_SELECTOR);
    return annotation
      ? (
          annotation.getAttribute("data-cgmn-original-tex") ||
          annotation.textContent ||
          ""
        ).trim()
      : "";
  }

  function isClearlyInlineDisplayTex(rawTex) {
    const tex = typeof rawTex === "string" ? rawTex.trim() : "";
    return Boolean(
      tex &&
        tex.length < 72 &&
        !DISPLAY_COMPLEX_HINT_PATTERN.test(tex)
    );
  }

  function getDisplayMetrics(displayNode, rawTex) {
    return {
      containerWidth: getMessageContainerWidth(displayNode),
      inlineWidth: measureInlineFormulaWidth(rawTex)
    };
  }

  function getMessageContainerWidth(displayNode) {
    const container = displayNode.closest(
      "[data-message-author-role], article, main"
    );

    return container ? container.getBoundingClientRect().width : 0;
  }

  function measureInlineFormulaWidth(rawTex) {
    if (!rawTex || !globalThis.katex || typeof globalThis.katex.render !== "function") {
      return 0;
    }

    const normalizedTex = getNormalizedRenderTex(rawTex);
    if (widthByTex.has(normalizedTex)) {
      return widthByTex.get(normalizedTex);
    }

    const mount = document.createElement("span");
    mount.style.cssText = [
      "position:absolute",
      "visibility:hidden",
      "white-space:nowrap",
      "contain:layout style paint",
      "left:-10000px",
      "top:0"
    ].join(";");

    try {
      globalThis.katex.render(normalizedTex, mount, {
        displayMode: false,
        throwOnError: true,
        strict: "ignore",
        trust: false,
        macros: settings.enabled && settings.removeBoxes ? SIMPLE_INLINE_MACROS : undefined
      });
      document.documentElement.append(mount);
      const width = mount.getBoundingClientRect().width;
      setCachedWidth(normalizedTex, width);
      return width;
    } catch (_error) {
      return 0;
    } finally {
      mount.remove();
    }
  }

  function setCachedWidth(tex, width) {
    if (widthByTex.size >= WIDTH_CACHE_LIMIT) {
      const oldestKey = widthByTex.keys().next().value;
      widthByTex.delete(oldestKey);
    }

    widthByTex.set(tex, width);
  }

  function renderSimpleInline(displayNode, rawTex) {
    if (!globalThis.katex || typeof globalThis.katex.render !== "function") {
      removeInlineRender(displayNode);
      return;
    }

    const normalizedTex = getNormalizedRenderTex(rawTex);
    const existing = getInlineRender(displayNode);
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
    inlineRenderByDisplay.set(displayNode, mount);
    displayNode.dataset.cgmnRerendered = "true";
    applyInlineFlow(displayNode);
  }

  function removeInlineRender(displayNode) {
    const renderedNode = getInlineRender(displayNode);
    if (renderedNode) {
      renderedNode.remove();
      inlineRenderByDisplay.delete(displayNode);
    }


    delete displayNode.dataset.cgmnRerendered;
  }

  function getInlineRender(displayNode) {
    const existing = inlineRenderByDisplay.get(displayNode);
    if (existing && existing.isConnected) {
      return existing;
    }

    const firstChild = displayNode.firstElementChild;
    if (firstChild && firstChild.matches("[data-cgmn-inline-render]")) {
      inlineRenderByDisplay.set(displayNode, firstChild);
      return firstChild;
    }

    return null;
  }

  function getNormalizedRenderTex(rawTex) {
    return settings.enabled && settings.removeBoxes && containsBoxMacro(rawTex)
      ? normalizeTexForCopy(rawTex)
      : rawTex;
  }

  function containsBoxMacro(tex) {
    return typeof tex === "string" && BOX_MACRO_PATTERN.test(tex);
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

    if (element.childElementCount === 0) {
      return true;
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

  function injectRenderHook() {
    if (!extensionApi || typeof extensionApi.runtimeGetURL !== "function") {
      return;
    }

    injectPageScript("page-render-hook.js");
  }

  function injectPageScript(path, onLoad) {
    const url = extensionApi.runtimeGetURL(path);
    if (!url) {
      return;
    }

    if (!document.documentElement) {
      setTimeout(() => injectPageScript(path, onLoad), 0);
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
      settings.skipComplexDisplayMathExplicit,
      settings.displayMathEnabled
    ].join("|");
  }
})();
