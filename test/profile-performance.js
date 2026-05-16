const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const katex = require("katex");
const { chromium } = require("playwright-core");

const repoRoot = path.resolve(__dirname, "..");
const artifactDir = path.join(repoRoot, "test-artifacts", "perf");
const chromeCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
];

const rows = readNumberArg("--rows", 600);
const topRows = readNumberArg("--top", 30);
const sampleIntervalUs = readNumberArg("--sample-interval-us", 250);

const profiledScripts = new Set([
  "extension-api.js",
  "tex-normalizer.js",
  "math-display-policy.js",
  "content.js",
  "vendor/katex/katex.min.js"
]);

const mainScriptNames = new Set([
  "tex-normalizer.js",
  "math-display-policy.js",
  "content.js"
]);

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const server = await startServer(repoRoot);
  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--disable-background-timer-throttling"]
  });

  const url = `http://127.0.0.1:${server.address().port}/profile-page.html?rows=${rows}`;
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const client = await page.context().newCDPSession(page);
  const consoleMessages = [];
  const pageErrors = [];

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleMessages.push(`${message.type()}: ${message.text()}`);
    }
  });
  page.on("pageerror", (error) => pageErrors.push(error.stack || error.message));

  try {
    await client.send("Profiler.enable");
    await client.send("Profiler.setSamplingInterval", {
      interval: sampleIntervalUs
    });
    await client.send("Profiler.startPreciseCoverage", {
      callCount: true,
      detailed: true
    });

    await client.send("Profiler.start");
    const startedAt = performance.now();

    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      (expected) => {
        const simpleDisplays = Array.from(
          document.querySelectorAll('[data-profile-kind="simple-display"]')
        );
        const boxedParagraphs = Array.from(
          document.querySelectorAll('[data-profile-kind="boxed-inline"]')
        );

        return (
          simpleDisplays.length === expected.simpleDisplays &&
          simpleDisplays.every(
            (element) => element.dataset.cgmnRerendered === "true"
          ) &&
          boxedParagraphs.length === expected.boxedInline &&
          boxedParagraphs.every(
            (element) =>
              element.querySelector('.katex[data-cgmn-unboxed="true"]') &&
              element
                .querySelector('annotation[encoding="application/x-tex"]')
                ?.textContent.trim()
                .indexOf("\\boxed") === -1
          )
        );
      },
      { simpleDisplays: rows + 1, boxedInline: rows + 1 },
      { timeout: 15000 }
    );
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve))
        )
    );

    const durationMs = performance.now() - startedAt;
    const coverage = await client.send("Profiler.takePreciseCoverage");
    await client.send("Profiler.stopPreciseCoverage");
    const { profile } = await client.send("Profiler.stop");

    const processedState = await page.evaluate(() => ({
      simpleDisplays: document.querySelectorAll(
        '[data-profile-kind="simple-display"][data-cgmn-rerendered="true"]'
      ).length,
      boxedInline: document.querySelectorAll(
        '[data-profile-kind="boxed-inline"] .katex[data-cgmn-unboxed="true"]'
      ).length,
      complexPreserved: document.querySelectorAll(
        '[data-profile-kind="complex-display"][data-cgmn-complex="true"]'
      ).length,
      inlineRenders: document.querySelectorAll("[data-cgmn-inline-render]").length,
      unboxedRenders: document.querySelectorAll("[data-cgmn-unboxed-render]").length
    }));

    const profilePath = path.join(artifactDir, "profile.cpuprofile");
    const flamegraphPath = path.join(artifactDir, "flamegraph.svg");
    const summaryPath = path.join(artifactDir, "summary.json");
    const reportPath = path.join(artifactDir, "report.md");

    fs.writeFileSync(profilePath, JSON.stringify(profile, null, 2));

    const cpuSummary = summarizeCpuProfile(profile);
    const coverageSummary = summarizeCoverage(coverage.result, durationMs);
    writeFlamegraph(profile, flamegraphPath);

    const summary = {
      generatedAt: new Date().toISOString(),
      rows,
      durationMs,
      sampleIntervalUs,
      processedState,
      artifacts: {
        profile: profilePath,
        flamegraph: flamegraphPath,
        report: reportPath
      },
      mainFunctionCalls: coverageSummary.mainFunctionCalls.slice(0, topRows),
      cpuHotFrames: cpuSummary.hotFrames.slice(0, topRows),
      consoleMessages,
      pageErrors
    };

    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    fs.writeFileSync(reportPath, renderReport(summary));

    console.log(renderConsoleSummary(summary));
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

function summarizeCoverage(scripts, durationMs) {
  const durationSeconds = durationMs / 1000;
  const byFunction = new Map();

  for (const script of scripts) {
    const scriptName = getScriptName(script.url);
    if (!mainScriptNames.has(scriptName)) {
      continue;
    }

    for (const fn of script.functions) {
      const callCount = fn.ranges && fn.ranges[0] ? fn.ranges[0].count : 0;
      if (!callCount) {
        continue;
      }

      const functionName = fn.functionName || "(anonymous/top-level)";
      const key = `${scriptName}\u0000${functionName}`;
      const current =
        byFunction.get(key) ||
        {
          script: scriptName,
          functionName,
          calls: 0,
          callsPerSecond: 0
        };

      current.calls += callCount;
      byFunction.set(key, current);
    }
  }

  const mainFunctionCalls = Array.from(byFunction.values())
    .map((row) => ({
      ...row,
      callsPerSecond: row.calls / durationSeconds
    }))
    .sort((left, right) => {
      if (right.callsPerSecond !== left.callsPerSecond) {
        return right.callsPerSecond - left.callsPerSecond;
      }
      return right.calls - left.calls;
    });

  return { mainFunctionCalls };
}

function summarizeCpuProfile(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const selfMsByFrame = new Map();
  const deltas = getSampleDeltas(profile);

  for (let index = 0; index < (profile.samples || []).length; index += 1) {
    const node = nodes.get(profile.samples[index]);
    if (!node) {
      continue;
    }

    const scriptName = getScriptName(node.callFrame.url);
    if (!profiledScripts.has(scriptName)) {
      continue;
    }

    const functionName = node.callFrame.functionName || "(anonymous)";
    const key = `${scriptName}\u0000${functionName}`;
    const current =
      selfMsByFrame.get(key) ||
      {
        script: scriptName,
        functionName,
        selfMs: 0,
        samples: 0
      };

    current.selfMs += deltas[index];
    current.samples += 1;
    selfMsByFrame.set(key, current);
  }

  return {
    hotFrames: Array.from(selfMsByFrame.values()).sort(
      (left, right) => right.selfMs - left.selfMs
    )
  };
}

function writeFlamegraph(profile, outputPath) {
  const tree = buildFlameTree(profile);
  const frameHeight = 18;
  const width = 1600;
  const leftPad = 12;
  const rightPad = 12;
  const titleHeight = 48;
  const maxDepth = getMaxDepth(tree);
  const height = titleHeight + Math.max(1, maxDepth) * frameHeight + 28;
  const graphWidth = width - leftPad - rightPad;
  const minFrameWidth = 0.5;
  const rects = [];

  layoutFlameNode(tree, leftPad, 0, graphWidth);

  const svg = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    "<style>",
    "text{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;font-size:12px;fill:#111}",
    ".title{font-size:18px;font-weight:650}",
    ".subtitle{font-size:12px;fill:#444}",
    "rect{stroke:#fff;stroke-width:.5}",
    "</style>",
    '<rect x="0" y="0" width="100%" height="100%" fill="#f8f8f8"/>',
    '<text class="title" x="12" y="24">Extension CPU flame graph</text>',
    `<text class="subtitle" x="12" y="42">Filtered to extension scripts. Width is sampled CPU time. Total shown: ${tree.value.toFixed(1)}ms.</text>`,
    ...rects,
    "</svg>"
  ].join("\n");

  fs.writeFileSync(outputPath, svg);

  function layoutFlameNode(node, x, depth, availableWidth) {
    if (!node.children.length || !node.value) {
      return;
    }

    const sortedChildren = [...node.children].sort((left, right) => {
      if (right.value !== left.value) {
        return right.value - left.value;
      }
      return left.name.localeCompare(right.name);
    });

    let childX = x;
    for (const child of sortedChildren) {
      const childWidth = availableWidth * (child.value / node.value);
      if (childWidth < minFrameWidth) {
        childX += childWidth;
        continue;
      }

      const y = titleHeight + (maxDepth - depth - 1) * frameHeight;
      const fill = colorForName(child.name);
      const label = fitLabel(child.name, childWidth);
      const percent = tree.value ? (child.value / tree.value) * 100 : 0;
      rects.push(
        `<g><title>${escapeXml(child.name)} - ${child.value.toFixed(2)}ms (${percent.toFixed(1)}%)</title>` +
          `<rect x="${childX.toFixed(2)}" y="${y}" width="${childWidth.toFixed(2)}" height="${frameHeight - 1}" fill="${fill}"/>` +
          (label
            ? `<text x="${(childX + 4).toFixed(2)}" y="${y + 13}">${escapeXml(label)}</text>`
            : "") +
          "</g>"
      );
      layoutFlameNode(child, childX, depth + 1, childWidth);
      childX += childWidth;
    }
  }
}

function buildFlameTree(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const parents = new Map();
  const deltas = getSampleDeltas(profile);
  const root = createTreeNode("(root)");

  for (const node of profile.nodes) {
    for (const childId of node.children || []) {
      parents.set(childId, node.id);
    }
  }

  for (let index = 0; index < (profile.samples || []).length; index += 1) {
    const stack = getRelevantStack(profile.samples[index]);
    if (!stack.length) {
      continue;
    }

    addStack(root, stack, deltas[index]);
  }

  return root;

  function getRelevantStack(nodeId) {
    const stack = [];
    let currentId = nodeId;

    while (currentId) {
      const node = nodes.get(currentId);
      if (!node) {
        break;
      }

      const scriptName = getScriptName(node.callFrame.url);
      if (profiledScripts.has(scriptName)) {
        const functionName = node.callFrame.functionName || "(anonymous)";
        stack.push(`${functionName} (${scriptName})`);
      }

      currentId = parents.get(currentId);
    }

    return stack.reverse();
  }
}

function createTreeNode(name) {
  return {
    name,
    value: 0,
    children: [],
    childMap: new Map()
  };
}

function addStack(root, stack, value) {
  root.value += value;
  let node = root;

  for (const frame of stack) {
    let child = node.childMap.get(frame);
    if (!child) {
      child = createTreeNode(frame);
      node.childMap.set(frame, child);
      node.children.push(child);
    }

    child.value += value;
    node = child;
  }
}

function getMaxDepth(node) {
  if (!node.children.length) {
    return 0;
  }

  return 1 + Math.max(...node.children.map(getMaxDepth));
}

function getSampleDeltas(profile) {
  if (profile.timeDeltas && profile.timeDeltas.length) {
    return profile.timeDeltas.map((delta) => delta / 1000);
  }

  const sampleCount = (profile.samples || []).length || 1;
  const durationMs = ((profile.endTime || 0) - (profile.startTime || 0)) / 1000;
  return new Array(sampleCount).fill(durationMs / sampleCount);
}

function renderReport(summary) {
  const functionRows = summary.mainFunctionCalls
    .map(
      (row) =>
        `| \`${row.functionName}\` | \`${row.script}\` | ${row.calls} | ${row.callsPerSecond.toFixed(1)} |`
    )
    .join("\n");
  const cpuRows = summary.cpuHotFrames
    .map(
      (row) =>
        `| \`${row.functionName}\` | \`${row.script}\` | ${row.selfMs.toFixed(2)} | ${row.samples} |`
    )
    .join("\n");

  return [
    "# Performance profile",
    "",
    `Generated: ${summary.generatedAt}`,
    `Rows: ${summary.rows}`,
    `Load-to-settled duration: ${summary.durationMs.toFixed(1)}ms`,
    `Sampling interval: ${summary.sampleIntervalUs}us`,
    "",
    "## Processed DOM",
    "",
    `- Simple displays re-rendered: ${summary.processedState.simpleDisplays}`,
    `- Boxed inline formulas unboxed: ${summary.processedState.boxedInline}`,
    `- Complex displays preserved: ${summary.processedState.complexPreserved}`,
    `- Inline render mounts: ${summary.processedState.inlineRenders}`,
    `- Unboxed render mounts: ${summary.processedState.unboxedRenders}`,
    "",
    "## Main Function Call Rates",
    "",
    "| Function | Script | Calls | Calls/sec |",
    "| --- | --- | ---: | ---: |",
    functionRows || "| n/a | n/a | 0 | 0 |",
    "",
    "## CPU Hot Frames",
    "",
    "| Function | Script | Self ms | Samples |",
    "| --- | --- | ---: | ---: |",
    cpuRows || "| n/a | n/a | 0 | 0 |",
    "",
    "## Artifacts",
    "",
    `- Flame graph: \`${summary.artifacts.flamegraph}\``,
    `- CPU profile: \`${summary.artifacts.profile}\``,
    "",
    summary.consoleMessages.length
      ? `Console messages:\n\n${summary.consoleMessages.map((line) => `- ${line}`).join("\n")}`
      : "Console messages: none",
    "",
    summary.pageErrors.length
      ? `Page errors:\n\n${summary.pageErrors.map((line) => `- ${line}`).join("\n")}`
      : "Page errors: none",
    ""
  ].join("\n");
}

function renderConsoleSummary(summary) {
  const lines = [
    "performance profile ok",
    `rows ${summary.rows}`,
    `duration ${summary.durationMs.toFixed(1)}ms`,
    `flame graph ${summary.artifacts.flamegraph}`,
    `report ${summary.artifacts.report}`,
    "",
    "top call rates:"
  ];

  for (const row of summary.mainFunctionCalls.slice(0, 10)) {
    lines.push(
      `  ${row.functionName} (${row.script}): ${row.calls} calls, ${row.callsPerSecond.toFixed(1)}/s`
    );
  }

  lines.push("", "top sampled self time:");
  for (const row of summary.cpuHotFrames.slice(0, 10)) {
    lines.push(
      `  ${row.functionName} (${row.script}): ${row.selfMs.toFixed(2)}ms, ${row.samples} samples`
    );
  }

  return lines.join("\n");
}

function renderProfilePage(rowCount) {
  const monSupp =
    "\\operatorname{MonSupp}^{\\circ}_{\\ell}(C)=\\left\\{[H] : H=\\overline{\\rho(\\pi_1(C'))}^{\\mathrm{Zar},\\circ}\\text{ for some finite etale }C'\\to C\\right\\}";

  let repeated = "";
  for (let index = 0; index < rowCount; index += 1) {
    repeated += `
      <article data-message-author-role="assistant" data-profile-kind="row">
        <p>For row ${index}, the display formula</p>
        ${displayMath(`x_{${index}} \\to y_{${index}}`, 'data-profile-kind="simple-display"')}
        <p data-profile-kind="boxed-inline">has a boxed inline term ${inlineMath(`\\boxed{a_{${index}}+b_{${index}}}`)} nearby.</p>
      </article>
    `;
  }

  const complexRows = Math.max(1, Math.floor(rowCount / 20));
  for (let index = 0; index < complexRows; index += 1) {
    repeated += `
      <article data-message-author-role="assistant" data-profile-kind="complex-row">
        <p>A structured invariant should stay as display math:</p>
        ${displayMath(monSupp, 'data-profile-kind="complex-display"')}
      </article>
    `;
  }

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>ChatGPT Math Normalizer Profile Fixture</title>
    <link rel="stylesheet" href="/vendor/katex/katex.min.css">
    <link rel="stylesheet" href="/content.css">
    <style>
      :root {
        color-scheme: dark;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        background: #050505;
        color: #f4f4f4;
      }

      body {
        margin: 0;
        background: #050505;
      }

      main {
        box-sizing: border-box;
        width: min(920px, calc(100vw - 48px));
        margin: 0 auto;
        padding: 56px 0 160px;
      }

      article {
        font-size: 20px;
        line-height: 1.55;
        margin: 0 0 28px;
      }

      p {
        margin: 0 0 12px;
      }

      .katex-display {
        margin: 0.5em 0;
      }
    </style>
  </head>
  <body>
    <main id="conversation" aria-label="Profile conversation">
      <article data-message-author-role="assistant" data-profile-kind="intro">
        <p>For</p>
        ${displayMath("g_B \\ge 2", 'data-profile-kind="simple-display"')}
        <p>you only need g_B.</p>
        <p data-profile-kind="boxed-inline">The copied result is ${inlineMath("\\boxed{a+b}")}.</p>
      </article>
      ${repeated}
    </main>
    <script src="/extension-api.js"></script>
    <script src="/vendor/katex/katex.min.js"></script>
    <script src="/tex-normalizer.js"></script>
    <script src="/math-display-policy.js"></script>
    <script src="/content.js"></script>
  </body>
</html>`;
}

function inlineMath(tex) {
  return katex.renderToString(tex, {
    displayMode: false,
    throwOnError: true,
    strict: "ignore",
    trust: false
  });
}

function displayMath(tex, attributes) {
  return katex
    .renderToString(tex, {
      displayMode: true,
      throwOnError: true,
      strict: "ignore",
      trust: false
    })
    .replace('class="katex-display"', `class="katex-display" ${attributes || ""}`);
}

function startServer(root) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");

    if (url.pathname === "/profile-page.html") {
      const requestedRows = readPositiveInteger(url.searchParams.get("rows"), rows);
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(renderProfilePage(requestedRows));
      return;
    }

    if (url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    const filePath = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
    if (!filePath.startsWith(root)) {
      response.writeHead(403);
      response.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (error, contents) => {
      if (error) {
        response.writeHead(404);
        response.end("Not found");
        return;
      }

      response.writeHead(200, { "Content-Type": getContentType(filePath) });
      response.end(contents);
    });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function getContentType(filePath) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }

  if (filePath.endsWith(".woff2")) {
    return "font/woff2";
  }

  if (filePath.endsWith(".woff")) {
    return "font/woff";
  }

  if (filePath.endsWith(".ttf")) {
    return "font/ttf";
  }

  return "application/octet-stream";
}

function getScriptName(url) {
  if (!url) {
    return "(unknown)";
  }

  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    if (pathname.endsWith("/vendor/katex/katex.min.js")) {
      return "vendor/katex/katex.min.js";
    }
    return path.basename(pathname);
  } catch (_error) {
    if (url.endsWith("/vendor/katex/katex.min.js")) {
      return "vendor/katex/katex.min.js";
    }
    return path.basename(url);
  }
}

function colorForName(name) {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) >>> 0;
  }

  const hue = hash % 360;
  const saturation = 55 + (hash % 20);
  const lightness = 68 + (hash % 12);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

function fitLabel(label, width) {
  const maxChars = Math.floor((width - 8) / 7);
  if (maxChars < 4) {
    return "";
  }

  if (label.length <= maxChars) {
    return label;
  }

  return `${label.slice(0, Math.max(1, maxChars - 3))}...`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function readNumberArg(name, fallback) {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return readPositiveInteger(inline.slice(prefix.length), fallback);
  }

  const index = process.argv.indexOf(name);
  if (index !== -1) {
    return readPositiveInteger(process.argv[index + 1], fallback);
  }

  return fallback;
}

function readPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function findChrome() {
  for (const candidate of chromeCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("No local Chrome/Chromium executable found for profiling.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
