(function installKatexHook() {
  "use strict";

  if (window.__cgmnKatexHookInstalled) {
    return;
  }

  window.__cgmnKatexHookInstalled = true;

  const normalizer =
    window.cgmnTexNormalizer &&
    typeof window.cgmnTexNormalizer.normalizeTexForCopy === "function"
      ? window.cgmnTexNormalizer.normalizeTexForCopy
      : (text) => text;
  const displayPolicy =
    window.cgmnDisplayPolicy &&
    typeof window.cgmnDisplayPolicy.classifyDisplayMath === "function"
      ? window.cgmnDisplayPolicy
      : null;
  const BOX_MACRO_OVERRIDES = {
    "\\boxed": "{#1}",
    "\\fbox": "{#1}",
    "\\fcolorbox": "{#3}"
  };

  let currentKatex = window.katex;

  if (currentKatex) {
    currentKatex = wrapKatex(currentKatex);
  }

  try {
    Object.defineProperty(window, "katex", {
      configurable: true,
      get() {
        return currentKatex;
      },
      set(value) {
        currentKatex = wrapKatex(value);
      }
    });
  } catch (_error) {
    if (window.katex) {
      window.katex = wrapKatex(window.katex);
    }
  }

  function wrapKatex(katex) {
    if (!katex || katex.__cgmnWrappedKatex) {
      return katex;
    }

    if (typeof katex.render === "function") {
      const render = katex.render.bind(katex);
      katex.render = (tex, element, options) =>
        render(...normalizeRenderArgs(tex, element, options));
    }

    if (typeof katex.renderToString === "function") {
      const renderToString = katex.renderToString.bind(katex);
      katex.renderToString = (tex, options) =>
        renderToString(...normalizeRenderToStringArgs(tex, options));
    }

    try {
      Object.defineProperty(katex, "__cgmnWrappedKatex", {
        configurable: false,
        value: true
      });
    } catch (_error) {
      katex.__cgmnWrappedKatex = true;
    }

    return katex;
  }

  function normalizeRenderArgs(tex, element, options) {
    const normalizedTex = normalizeTex(tex);
    return [normalizedTex, element, normalizeOptions(tex, normalizedTex, options)];
  }

  function normalizeRenderToStringArgs(tex, options) {
    const normalizedTex = normalizeTex(tex);
    return [normalizedTex, normalizeOptions(tex, normalizedTex, options)];
  }

  function normalizeTex(tex) {
    return typeof tex === "string" ? normalizer(tex) : tex;
  }

  function normalizeOptions(rawTex, normalizedTex, options) {
    const nextOptions = { ...(options || {}) };

    if (typeof normalizedTex === "string" && normalizedTex !== rawTex) {
      nextOptions.macros = {
        ...(nextOptions.macros || {}),
        ...BOX_MACRO_OVERRIDES
      };
    }

    if (nextOptions.displayMode === true && canRenderDisplayAsInline(rawTex)) {
      nextOptions.displayMode = false;
    }

    return nextOptions;
  }

  function canRenderDisplayAsInline(rawTex) {
    if (!displayPolicy || typeof rawTex !== "string") {
      return false;
    }

    if (
      typeof displayPolicy.needsDisplayMeasurement === "function" &&
      displayPolicy.needsDisplayMeasurement(rawTex)
    ) {
      return false;
    }

    return displayPolicy.classifyDisplayMath(rawTex).preserve !== true;
  }
})();
