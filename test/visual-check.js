const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { chromium } = require("playwright-core");

const repoRoot = path.resolve(__dirname, "..");
const artifactDir = path.join(repoRoot, "test-artifacts");
const chromeCandidates = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium"
];

async function main() {
  fs.mkdirSync(artifactDir, { recursive: true });
  const server = await startServer(repoRoot);
  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--disable-background-timer-throttling"]
  });

  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const url = `http://127.0.0.1:${server.address().port}/test/fixtures/chatgpt-visual.html`;
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.evaluate(() => {
      window.cgmnLongTasks = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          window.cgmnLongTasks.push({
            duration: entry.duration,
            startTime: entry.startTime
          });
        }
      }).observe({ entryTypes: ["longtask"] });
    });

    const firstFrameMs = await page.evaluate(async () => {
      const startedAt = performance.now();
      window.cgmnLoadTranscript({ rows: 180 });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      return performance.now() - startedAt;
    });

    await page.screenshot({
      path: path.join(artifactDir, "initial-open-first-frame.png"),
      fullPage: false
    });

    await page.waitForFunction(
      () =>
        document.querySelector('[data-case="simple-display"]')?.dataset.cgmnRerendered ===
        "true",
      null,
      { timeout: 1500 }
    );

    await page.screenshot({
      path: path.join(artifactDir, "initial-open-settled.png"),
      fullPage: false
    });

    const visualState = await page.evaluate(() => {
      const rect = (selector) => {
        const element = document.querySelector(selector);
        if (!element) {
          return null;
        }

        const bounds = element.getBoundingClientRect();
        return {
          top: bounds.top,
          right: bounds.right,
          bottom: bounds.bottom,
          left: bounds.left,
          width: bounds.width,
          height: bounds.height,
          centerY: bounds.top + bounds.height / 2,
          display: getComputedStyle(element).display
        };
      };
      const boxedMath = document.querySelector(
        '[data-case="boxed"] .katex[data-cgmn-unboxed="true"]'
      );
      const boxedAnnotation = boxedMath?.querySelector(
        'annotation[encoding="application/x-tex"]'
      );
      const boxedFrame = document.querySelector('[data-case="boxed"] .fbox');
      const boxedFrameStyle = boxedFrame ? getComputedStyle(boxedFrame) : null;
      const visibleUnrendered = Array.from(
        document.querySelectorAll('[data-case="scroll-display"]')
      ).filter((element) => {
        const bounds = element.getBoundingClientRect();
        return (
          bounds.bottom >= 0 &&
          bounds.top <= window.innerHeight &&
          element.dataset.cgmnRerendered !== "true"
        );
      }).length;

      return {
        simpleBefore: rect('[data-case="simple-before"]'),
        simpleDisplay: rect('[data-case="simple-display"]'),
        simpleAfter: rect('[data-case="simple-after"]'),
        complexDisplay: document.querySelector('[data-case="complex-display"]')?.dataset
          .cgmnComplex,
        complexRerendered: document.querySelector('[data-case="complex-display"]')?.dataset
          .cgmnRerendered,
        boxedAnnotation: boxedAnnotation?.textContent || "",
        boxedDisplay: boxedMath ? getComputedStyle(boxedMath).display : "",
        boxedBorderTopWidth: boxedFrameStyle?.borderTopWidth || "",
        boxedPaddingLeft: boxedFrameStyle?.paddingLeft || "",
        boxedBackgroundColor: boxedFrameStyle?.backgroundColor || "",
        visibleUnrendered
      };
    });

    assert.equal(visualState.simpleDisplay.display, "inline");
    assert.equal(visualState.complexDisplay, "true");
    assert.notEqual(visualState.complexRerendered, "true");
    assert.equal(visualState.boxedAnnotation.trim(), "a+b");
    assert.notEqual(visualState.boxedDisplay, "none");
    assert.equal(visualState.boxedBorderTopWidth, "0px");
    assert.equal(visualState.boxedPaddingLeft, "0px");
    assert.equal(visualState.visibleUnrendered, 0);
    assert.ok(
      Math.abs(visualState.simpleBefore.centerY - visualState.simpleDisplay.centerY) < 20,
      "simple display math should share the previous text line"
    );
    assert.ok(
      Math.abs(visualState.simpleAfter.centerY - visualState.simpleDisplay.centerY) < 20,
      "simple display math should share the following text line"
    );

    const scrollMetrics = await page.evaluate(async () => {
      const gaps = [];
      const scrollRoot = document.scrollingElement || document.documentElement;
      let previous = performance.now();

      for (let index = 0; index < 80; index += 1) {
        const maxScroll = scrollRoot.scrollHeight - window.innerHeight;
        window.scrollTo(0, (maxScroll * index) / 79);
        await new Promise((resolve) => requestAnimationFrame(resolve));
        const now = performance.now();
        gaps.push(now - previous);
        previous = now;
      }

      const visibleUnrendered = Array.from(
        document.querySelectorAll('[data-case="scroll-display"]')
      ).filter((element) => {
        const bounds = element.getBoundingClientRect();
        return (
          bounds.bottom >= 0 &&
          bounds.top <= window.innerHeight &&
          element.dataset.cgmnRerendered !== "true"
        );
      }).length;

      return {
        maxFrameGap: Math.max(...gaps),
        longTasks: window.cgmnLongTasks,
        visibleUnrendered,
        scrollY: window.scrollY
      };
    });

    await page.screenshot({
      path: path.join(artifactDir, "after-fast-scroll.png"),
      fullPage: false
    });

    assert.ok(firstFrameMs < 250, `initial open first frame took ${firstFrameMs.toFixed(1)}ms`);
    assert.ok(
      scrollMetrics.maxFrameGap < 120,
      `fast scrolling had a ${scrollMetrics.maxFrameGap.toFixed(1)}ms frame gap`
    );
    assert.equal(scrollMetrics.visibleUnrendered, 0);
    assert.ok(scrollMetrics.scrollY > 0);

    console.log(
      [
        "visual check ok",
        `first frame ${firstFrameMs.toFixed(1)}ms`,
        `max scroll frame gap ${scrollMetrics.maxFrameGap.toFixed(1)}ms`,
        `long tasks ${scrollMetrics.longTasks.length}`
      ].join(" | ")
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

function findChrome() {
  for (const candidate of chromeCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("No local Chrome/Chromium executable found for visual checks.");
}

function startServer(root) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
