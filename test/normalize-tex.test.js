const assert = require("node:assert/strict");
const { normalizeTexForCopy } = require("../tex-normalizer.js");

const cases = [
  ["\\boxed{x}", "x"],
  ["a + \\boxed{x + y}", "a + x + y"],
  ["\\fbox{value}", "value"],
  ["\\fcolorbox{red}{yellow}{x + 1}", "x + 1"],
  ["\\boxed{\\fcolorbox{red}{yellow}{x}}", "x"],
  ["\\boxed{{x + 1}}", "{x + 1}"],
  ["\\boxed x", "x"],
  ["\\boxedmacroname{x}", "\\boxedmacroname{x}"]
];

for (const [input, expected] of cases) {
  assert.equal(normalizeTexForCopy(input), expected, input);
}

console.log("tex normalizer ok");
