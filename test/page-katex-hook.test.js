const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const calls = [];
const window = {
  cgmnTexNormalizer: {
    normalizeTexForCopy: (tex) => tex.replace(/\\boxed\{([^}]*)\}/g, "$1")
  },
  cgmnDisplayPolicy: {
    needsDisplayMeasurement: (tex) => tex.length > 12,
    classifyDisplayMath: () => ({ preserve: false })
  }
};

vm.runInNewContext(fs.readFileSync("page-katex-hook.js", "utf8"), {
  window
});

window.katex = {
  render: (tex, element, options) => {
    calls.push({ element, options, tex });
  },
  renderToString: (tex, options) => {
    calls.push({ options, tex });
    return tex;
  }
};

window.katex.render("\\boxed{x}", {}, { displayMode: true });
assert.equal(calls[0].tex, "x");
assert.equal(calls[0].options.displayMode, false);

window.katex.render("LongFormulaName = \\boxed{x}", {}, { displayMode: true });
assert.equal(calls[1].tex, "LongFormulaName = x");
assert.equal(calls[1].options.displayMode, true);

console.log("page katex hook ok");
