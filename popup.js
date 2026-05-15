(() => {
  "use strict";

  const DEFAULT_SETTINGS = {
    enabled: true,
    removeBoxes: true,
    displayMathMode: "visual-inline",
    skipComplexDisplayMath: false,
    displayMathEnabled: true
  };
  const extensionApi = globalThis.cgmnExtensionApi;

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
    if (!extensionApi) {
      applySettings(DEFAULT_SETTINGS);
      hydrated = true;
      return;
    }

    extensionApi.storageGet(DEFAULT_SETTINGS).then((items) => {
      const settings = normalizeSettings(items);
      applySettings(settings);
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
        if (extensionApi) {
          extensionApi.storageSet({ [key]: value });
        }
      });
    }
  }

  function updateTabStatus() {
    if (!extensionApi) {
      setStatus("Options page", "");
      return;
    }

    extensionApi.tabsQuery({ active: true, currentWindow: true }).then((tabs) => {
      const tabId = tabs[0] && tabs[0].id;

      if (!tabId) {
        setStatus("No active tab detected", "unsupported");
        return;
      }

      extensionApi.tabsSendMessage(tabId, { type: "CGMN_STATUS" }).then((response) => {
        if (!response || !response.supported) {
          setStatus("Open ChatGPT to use this extension", "unsupported");
          return;
        }

        setStatus("Current tab is supported", "supported");
      });
    });
  }

  if (extensionApi) {
    extensionApi.onStorageChanged((changes, areaName) => {
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

  function applySettings(settings) {
    controls.enabled.checked = settings.enabled;
    controls.removeBoxes.checked = settings.removeBoxes;
    controls.displayMathMode.value = settings.displayMathMode;
    controls.skipComplexDisplayMath.checked = settings.skipComplexDisplayMath;
    controls.displayMathEnabled.checked = settings.displayMathEnabled;
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
