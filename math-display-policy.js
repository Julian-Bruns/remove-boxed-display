(function exposeMathDisplayPolicy(globalObject) {
  "use strict";

  const FORCED_DISPLAY_PATTERN =
    /\\begin\{(?:align|aligned|alignat|gather|gathered|multline|split|matrix|pmatrix|bmatrix|vmatrix|Vmatrix|smallmatrix|cases|array|CD)\}/;
  const RELATION_PATTERN =
    /(=|\\leq?|\\geq?|\\lt|\\gt|\\subset(?:eq)?|\\supset(?:eq)?|\\in\b|\\ni\b|\\to\b|\\mapsto\b|\\rightarrow\b|\\leftarrow\b|\\cong\b|\\simeq\b|\\sim\b|\\equiv\b)/g;
  const DISPLAY_STRUCTURE_PATTERN =
    /(\\left\s*\{|\\\{|\\middle\b|\\colon\b|\\text\{[^}]{12,}\}|\\substack\b|\\underset\b|\\overset\b|\\operatorname\{[^}]{7,}\}|\\quad|\\qquad|\\;)/;
  const LARGE_OBJECT_PATTERN =
    /(\\d?frac\b|\\sum\b|\\prod\b|\\coprod\b|\\int\b|\\iint\b|\\iiint\b|\\lim\b|\\bigcup\b|\\bigcap\b|\\bigoplus\b|\\bigotimes\b|\\sqrt\{[^}]{18,}\})/;

  function classifyDisplayMath(rawTex, metrics) {
    const tex = typeof rawTex === "string" ? rawTex.trim() : "";
    const safeMetrics = metrics || {};

    if (!tex) {
      return {
        preserve: false,
        reason: "empty"
      };
    }

    if (isForcedDisplayTex(tex)) {
      return {
        preserve: true,
        reason: "forced-display-construct"
      };
    }

    const traits = getDisplayTraits(tex);
    const inlineWidth = Number(safeMetrics.inlineWidth) || 0;
    const containerWidth = Number(safeMetrics.containerWidth) || 0;
    const widthRatio =
      inlineWidth > 0 && containerWidth > 0 ? inlineWidth / containerWidth : 0;
    const isLong = tex.length >= 72 || inlineWidth >= 340 || widthRatio >= 0.42;
    const isVeryLong = tex.length >= 130 || inlineWidth >= 520 || widthRatio >= 0.62;
    const isTooWide = inlineWidth > 0 && containerWidth > 0 && widthRatio >= 0.5;
    const isStructured =
      traits.hasSetBuilder ||
      traits.hasDisplayStructure ||
      (traits.hasLargeObject && tex.length >= 48) ||
      traits.relationCount >= 2;

    if ((isLong && isStructured && isTooWide) || (isVeryLong && isStructured)) {
      return {
        preserve: true,
        reason: traits.hasSetBuilder
          ? "set-builder-or-definition"
          : traits.hasLargeObject
            ? "large-object"
            : "long-structured-formula"
      };
    }

    return {
      preserve: false,
      reason: "inline-worthy"
    };
  }

  function needsDisplayMeasurement(rawTex) {
    const tex = typeof rawTex === "string" ? rawTex.trim() : "";

    if (!tex || isForcedDisplayTex(tex)) {
      return false;
    }

    const traits = getDisplayTraits(tex);
    return (
      tex.length >= 72 ||
      traits.hasSetBuilder ||
      traits.hasDisplayStructure ||
      traits.hasLargeObject ||
      traits.relationCount >= 2
    );
  }

  function isForcedDisplayTex(tex) {
    return FORCED_DISPLAY_PATTERN.test(tex) || /\\tag\b/.test(tex) || /\\\\/.test(tex);
  }

  function getDisplayTraits(tex) {
    return {
      relationCount: countMatches(tex, RELATION_PATTERN),
      hasDisplayStructure: DISPLAY_STRUCTURE_PATTERN.test(tex),
      hasLargeObject: LARGE_OBJECT_PATTERN.test(tex),
      hasSetBuilder:
        /(\\left\s*\{|\\\{|\{)/.test(tex) &&
        /(\\mid\b|\\;?:|\\colon\b|\\text\{[^}]*\b(?:for|such|where|with|all|some)\b[^}]*\})/.test(tex)
    };
  }

  function countMatches(text, pattern) {
    pattern.lastIndex = 0;
    let count = 0;

    while (pattern.exec(text)) {
      count += 1;
    }

    pattern.lastIndex = 0;
    return count;
  }

  const api = {
    classifyDisplayMath,
    isForcedDisplayTex,
    needsDisplayMeasurement
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalObject.cgmnDisplayPolicy = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
