const assert = require("node:assert/strict");
const {
  classifyDisplayMath,
  needsDisplayMeasurement
} = require("../math-display-policy.js");

function classify(tex, inlineWidth = 0, containerWidth = 900) {
  return classifyDisplayMath(tex, { inlineWidth, containerWidth });
}

assert.equal(classify("W \\to D", 44).preserve, false);
assert.equal(classify("g_B \\ge 2", 62).preserve, false);
assert.equal(classify("\\Delta \\ge \\frac{1}{42}", 84).preserve, false);
assert.equal(needsDisplayMeasurement("W \\to D"), false);
assert.equal(needsDisplayMeasurement("g_B \\ge 2"), false);

assert.equal(
  classify(
    "\\operatorname{MonSupp}^{\\circ}_{\\ell}(C)=\\left\\{[H] : H=\\overline{\\rho(\\pi_1(C'))}^{\\mathrm{Zar},\\circ}\\text{ for some finite etale }C'\\to C\\right\\}",
    760
  ).preserve,
  true
);

assert.equal(
  classify(
    "\\operatorname{JacSupp}(C)=\\{\\text{simple abelian varieties appearing in Jacobians of finite etale covers}\\}",
    650
  ).preserve,
  true
);
assert.equal(
  needsDisplayMeasurement(
    "\\operatorname{JacSupp}(C)=\\{\\text{simple abelian varieties appearing in Jacobians of finite etale covers}\\}"
  ),
  true
);

assert.equal(classify("\\begin{cases}x,&x>0\\\\-x,&x<0\\end{cases}", 160).preserve, true);

console.log("display policy ok");
