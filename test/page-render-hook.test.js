const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const hookSource = fs.readFileSync(
  path.resolve(__dirname, "..", "page-render-hook.js"),
  "utf8"
);

const context = {
  globalThis: null,
  katex: {
    render(tex, element, options) {
      element.renderedTex = tex;
      element.renderedOptions = options;
    },
    renderToString(tex, options) {
      return JSON.stringify({ tex, options });
    }
  }
};
context.globalThis = context;

vm.runInNewContext(hookSource, context, {
  filename: "page-render-hook.js"
});

const element = {};
context.katex.render("\\boxed{a+b}", element, { displayMode: true });
const renderedString = JSON.parse(
  context.katex.renderToString("g_B \\ge 2", { displayMode: true })
);

assert.equal(element.renderedTex, "a+b");
assert.equal(element.renderedOptions.displayMode, false);
assert.equal(renderedString.tex, "g_B \\ge 2");
assert.equal(renderedString.options.displayMode, false);
assert.equal(context.__cgmnRenderHookStats.patched, true);
assert.equal(context.__cgmnRenderHookStats.normalizedBoxCalls, 1);
assert.equal(context.__cgmnRenderHookStats.forcedInlineDisplays, 2);

console.log("page render hook ok");
