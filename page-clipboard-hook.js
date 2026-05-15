(function installClipboardHook() {
  "use strict";

  if (window.__cgmnClipboardHookInstalled) {
    return;
  }

  window.__cgmnClipboardHookInstalled = true;

  const normalizer =
    window.cgmnTexNormalizer &&
    typeof window.cgmnTexNormalizer.normalizeTexForCopy === "function"
      ? window.cgmnTexNormalizer.normalizeTexForCopy
      : (text) => text;

  if (!navigator.clipboard || typeof navigator.clipboard.writeText !== "function") {
    return;
  }

  const writeText = navigator.clipboard.writeText.bind(navigator.clipboard);

  try {
    Object.defineProperty(navigator.clipboard, "writeText", {
      configurable: true,
      value(text) {
        const normalized = typeof text === "string" ? normalizer(text) : text;
        return writeText(normalized);
      }
    });
  } catch (_error) {
    navigator.clipboard.writeText = (text) => {
      const normalized = typeof text === "string" ? normalizer(text) : text;
      return writeText(normalized);
    };
  }
})();
