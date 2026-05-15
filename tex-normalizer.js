(function exposeTexNormalizer(globalObject) {
  "use strict";

  const BOX_MACROS = [
    { name: "\\fcolorbox", args: 3, outputArg: 2 },
    { name: "\\boxed", args: 1, outputArg: 0 },
    { name: "\\fbox", args: 1, outputArg: 0 }
  ];

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

  const api = { normalizeTexForCopy };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalObject.cgmnTexNormalizer = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
