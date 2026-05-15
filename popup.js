(() => {
  "use strict";

  const DEFAULT_SETTINGS = {
    enabled: true,
    removeBoxes: true,
    displayMathMode: "visual-inline",
    skipComplexDisplayMath: false,
    displayMathEnabled: true
  };

  const controls = {
    enabled: document.getElementById("enabled"),
    removeBoxes: document.getElementById("removeBoxes"),
    displayMathMode: document.getElementById("displayMathMode"),
    skipComplexDisplayMath: document.getElementById("skipComplexDisplayMath"),
    displayMathEnabled: document.getElementById("displayMathEnabled")
  };

  const status = document.getElementById("status");
  let hydrated = false;

  hydrate();
  bindControls();
  updateTabStatus();

  function hydrate() {
    chrome.storage.sync.get(DEFAULT_SETTINGS, (items) => {
      const settings = normalizeSettings(items);
      controls.enabled.checked = settings.enabled;
      controls.removeBoxes.checked = settings.removeBoxes;
      controls.displayMathMode.value = settings.displayMathMode;
      controls.skipComplexDisplayMath.checked = settings.skipComplexDisplayMath;
      controls.displayMathEnabled.checked = settings.displayMathEnabled;
      hydrated = true;
    });
  }

  function bindControls() {
    for (const [key, control] of Object.entries(controls)) {
      control.addEventListener("change", () => {
        if (!hydrated) {
          return;
        }

        const value = control.type === "checkbox" ? control.checked : control.value;
        chrome.storage.sync.set({ [key]: value });
      });
    }
  }

  function updateTabStatus() {
    if (!chrome.tabs || !chrome.tabs.query) {
      setStatus("Options page", "");
      return;
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabId = tabs[0] && tabs[0].id;

      if (!tabId) {
        setStatus("No active tab detected", "unsupported");
        return;
      }

      chrome.tabs.sendMessage(tabId, { type: "CGMN_STATUS" }, (response) => {
        if (chrome.runtime.lastError || !response || !response.supported) {
          setStatus("Open ChatGPT to use this extension", "unsupported");
          return;
        }

        setStatus("Current tab is supported", "supported");
      });
    });
  }

  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync" || !hydrated) {
        return;
      }

      for (const [key, change] of Object.entries(changes)) {
        const control = controls[key];
        if (!control) {
          continue;
        }

        if (control.type === "checkbox") {
          control.checked = change.newValue !== false;
        } else {
          control.value = change.newValue;
        }
      }
    });
  }

  function setStatus(text, className) {
    status.textContent = text;
    status.className = className ? `status ${className}` : "status";
  }

  function normalizeSettings(value) {
    return {
      enabled: value.enabled !== false,
      removeBoxes: value.removeBoxes !== false,
      displayMathMode:
        value.displayMathMode === "rerender-simple-inline"
          ? "rerender-simple-inline"
          : "visual-inline",
      skipComplexDisplayMath: value.skipComplexDisplayMath === true,
      displayMathEnabled: value.displayMathEnabled !== false
    };
  }
})();
