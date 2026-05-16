(function installCgmnRenderHook(globalObject) {
  "use strict";

  const STATS_KEY = "__cgmnRenderHookStats";
  const PATCHED_KEY = "__cgmnRenderHookPatched";
  const FORCE_SIMPLE_DISPLAY_INLINE = true;
  const BOX_MACRO_PATTERN = /\\(?:boxed|fbox|fcolorbox)(?![A-Za-z])/;
  const BOX_MACROS = [
    { name: "\\fcolorbox", args: 3, outputArg: 2 },
    { name: "\\boxed", args: 1, outputArg: 0 },
    { name: "\\fbox", args: 1, outputArg: 0 }
  ];

  const stats = ensureStats();
  let currentKatex = globalObject.katex;

  patchKatex(currentKatex);

  try {
    Object.defineProperty(globalObject, "katex", {
      configurable: true,
      enumerable: true,
      get() {
        return currentKatex;
      },
      set(value) {
        stats.assignments += 1;
        currentKatex = patchKatex(value);
      }
    });
  } catch (_error) {
    stats.definePropertyFailed = true;
  }

  function ensureStats() {
    const existing = globalObject[STATS_KEY];
    if (existing && typeof existing === "object") {
      existing.installed = true;
      return existing;
    }

    const created = {
      installed: true,
      patched: false,
      assignments: 0,
      renderCalls: 0,
      renderToStringCalls: 0,
      normalizedBoxCalls: 0,
      forcedInlineDisplays: 0,
      definePropertyFailed: false
    };
    globalObject[STATS_KEY] = created;
    return created;
  }

  function patchKatex(katex) {
    if (!katex || typeof katex !== "object" || katex[PATCHED_KEY]) {
      return katex;
    }

    const originalRender = katex.render;
    const originalRenderToString = katex.renderToString;
    if (
      typeof originalRender !== "function" &&
      typeof originalRenderToString !== "function"
    ) {
      return katex;
    }

    try {
      Object.defineProperty(katex, PATCHED_KEY, {
        configurable: false,
        enumerable: false,
        value: true
      });
    } catch (_error) {
      return katex;
    }

    if (typeof originalRender === "function") {
      katex.render = function cgmnRender(tex, element, options) {
        stats.renderCalls += 1;
        const normalized = normalizeRenderInput(tex, options);
        return originalRender.call(
          this,
          normalized.tex,
          element,
          normalized.options
        );
      };
    }

    if (typeof originalRenderToString === "function") {
      katex.renderToString = function cgmnRenderToString(tex, options) {
        stats.renderToStringCalls += 1;
        const normalized = normalizeRenderInput(tex, options);
        return originalRenderToString.call(this, normalized.tex, normalized.options);
      };
    }

    stats.patched = true;
    return katex;
  }

  function normalizeRenderInput(tex, options) {
    if (typeof tex !== "string") {
      return { tex, options };
    }

    const normalizedTex = containsBoxMacro(tex) ? normalizeTexForCopy(tex) : tex;
    let nextOptions = options;

    if (normalizedTex !== tex) {
      stats.normalizedBoxCalls += 1;
    }

    if (
      FORCE_SIMPLE_DISPLAY_INLINE &&
      options &&
      options.displayMode === true &&
      shouldInlineDisplay(normalizedTex)
    ) {
      nextOptions = { ...options, displayMode: false };
      stats.forcedInlineDisplays += 1;
    }

    return {
      tex: normalizedTex,
      options: nextOptions
    };
  }

  function shouldInlineDisplay(tex) {
    const value = typeof tex === "string" ? tex.trim() : "";
    if (!value || value.length > 72) {
      return false;
    }

    if (/\\begin\{/.test(value) || /\\tag\b/.test(value) || /\\\\/.test(value)) {
      return false;
    }

    if (
      /\\(?:d?frac|sum|prod|coprod|int|iint|iiint|lim|bigcup|bigcap|left|right|middle|substack|underset|overset|operatorname|quad|qquad)\b/.test(
        value
      )
    ) {
      return false;
    }

    return countRelations(value) <= 1;
  }

  function countRelations(tex) {
    const relationPattern =
      /(=|\\leq?|\\geq?|\\lt|\\gt|\\subset(?:eq)?|\\supset(?:eq)?|\\in\b|\\ni\b|\\to\b|\\mapsto\b|\\rightarrow\b|\\leftarrow\b|\\cong\b|\\simeq\b|\\sim\b|\\equiv\b)/g;
    let count = 0;

    while (relationPattern.exec(tex)) {
      count += 1;
    }

    return count;
  }

  function containsBoxMacro(tex) {
    return typeof tex === "string" && BOX_MACRO_PATTERN.test(tex);
  }

  function normalizeTexForCopy(tex) {
    if (typeof tex !== "string" || tex.indexOf("\\") === -1) {
      return tex;
    }

    let normalized = "";
    let index = 0;

    while (index < tex.length) {
      const macro = matchBoxMacro(tex, index);

      if (!macro) {
        normalized += tex[index];
        index += 1;
        continue;
      }

      const parsed = parseMacroArgs(tex, index + macro.name.length, macro.args);

      if (!parsed) {
        normalized += tex[index];
        index += 1;
        continue;
      }

      normalized += normalizeTexForCopy(parsed.args[macro.outputArg].content);
      index = parsed.end;
    }

    return normalized;
  }

  function matchBoxMacro(tex, index) {
    for (const macro of BOX_MACROS) {
      if (!tex.startsWith(macro.name, index)) {
        continue;
      }

      const next = tex[index + macro.name.length] || "";
      if (!/[A-Za-z]/.test(next)) {
        return macro;
      }
    }

    return null;
  }

  function parseMacroArgs(tex, start, count) {
    const args = [];
    let index = start;

    for (let argIndex = 0; argIndex < count; argIndex += 1) {
      index = skipWhitespace(tex, index);

      const parsed = parseTexArgument(tex, index);
      if (!parsed) {
        return null;
      }

      args.push(parsed);
      index = parsed.end;
    }

    return { args, end: index };
  }

  function parseTexArgument(tex, index) {
    if (index >= tex.length) {
      return null;
    }

    if (tex[index] === "{") {
      return parseBracedArgument(tex, index);
    }

    if (tex[index] === "\\") {
      return parseControlSequence(tex, index);
    }

    return {
      content: tex[index],
      end: index + 1
    };
  }

  function parseBracedArgument(tex, start) {
    let depth = 1;
    let index = start + 1;

    while (index < tex.length) {
      const char = tex[index];

      if (char === "\\") {
        index += 2;
        continue;
      }

      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;

        if (depth === 0) {
          return {
            content: tex.slice(start + 1, index),
            end: index + 1
          };
        }
      }

      index += 1;
    }

    return null;
  }

  function parseControlSequence(tex, start) {
    let index = start + 1;

    while (index < tex.length && /[A-Za-z]/.test(tex[index])) {
      index += 1;
    }

    if (index === start + 1 && index < tex.length) {
      index += 1;
    }

    return {
      content: tex.slice(start, index),
      end: index
    };
  }

  function skipWhitespace(tex, start) {
    let index = start;

    while (index < tex.length && /\s/.test(tex[index])) {
      index += 1;
    }

    return index;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
