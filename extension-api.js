(function exposeExtensionApi(globalObject) {
  "use strict";

  const browserApi =
    globalObject.browser && typeof globalObject.browser === "object"
      ? globalObject.browser
      : null;
  const chromeApi =
    globalObject.chrome && typeof globalObject.chrome === "object"
      ? globalObject.chrome
      : null;
  const promiseApi = browserApi || null;
  const callbackApi = chromeApi || null;

  function getStorageArea(api) {
    return api && api.storage && api.storage.sync ? api.storage.sync : null;
  }

  function storageGet(defaults) {
    const area = getStorageArea(promiseApi);
    if (area && typeof area.get === "function") {
      return area.get(defaults).then(
        (items) => ({ ...defaults, ...items }),
        () => ({ ...defaults })
      );
    }

    const callbackArea = getStorageArea(callbackApi);
    if (!callbackArea || typeof callbackArea.get !== "function") {
      return Promise.resolve({ ...defaults });
    }

    return new Promise((resolve) => {
      callbackArea.get(defaults, (items) => {
        if (getLastError()) {
          resolve({ ...defaults });
          return;
        }

        resolve({ ...defaults, ...items });
      });
    });
  }

  function storageSet(items) {
    const area = getStorageArea(promiseApi);
    if (area && typeof area.set === "function") {
      return area.set(items).catch(() => undefined);
    }

    const callbackArea = getStorageArea(callbackApi);
    if (!callbackArea || typeof callbackArea.set !== "function") {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      callbackArea.set(items, () => resolve());
    });
  }

  function onStorageChanged(listener) {
    const storageApi =
      (promiseApi && promiseApi.storage) || (callbackApi && callbackApi.storage);

    if (!storageApi || !storageApi.onChanged) {
      return;
    }

    storageApi.onChanged.addListener(listener);
  }

  function tabsQuery(queryInfo) {
    const tabsApi = promiseApi && promiseApi.tabs;
    if (tabsApi && typeof tabsApi.query === "function") {
      return tabsApi.query(queryInfo).catch(() => []);
    }

    const callbackTabsApi = callbackApi && callbackApi.tabs;
    if (!callbackTabsApi || typeof callbackTabsApi.query !== "function") {
      return Promise.resolve([]);
    }

    return new Promise((resolve) => {
      callbackTabsApi.query(queryInfo, (tabs) => {
        if (getLastError()) {
          resolve([]);
          return;
        }

        resolve(tabs || []);
      });
    });
  }

  function tabsSendMessage(tabId, message) {
    const tabsApi = promiseApi && promiseApi.tabs;
    if (tabsApi && typeof tabsApi.sendMessage === "function") {
      return tabsApi.sendMessage(tabId, message).catch(() => undefined);
    }

    const callbackTabsApi = callbackApi && callbackApi.tabs;
    if (!callbackTabsApi || typeof callbackTabsApi.sendMessage !== "function") {
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      callbackTabsApi.sendMessage(tabId, message, (response) => {
        if (getLastError()) {
          resolve(undefined);
          return;
        }

        resolve(response);
      });
    });
  }

  function onRuntimeMessage(listener) {
    const runtimeApi =
      (promiseApi && promiseApi.runtime) || (callbackApi && callbackApi.runtime);

    if (!runtimeApi || !runtimeApi.onMessage) {
      return;
    }

    runtimeApi.onMessage.addListener(listener);
  }

  function getLastError() {
    return callbackApi && callbackApi.runtime
      ? callbackApi.runtime.lastError
      : null;
  }

  const api = {
    storageGet,
    storageSet,
    onStorageChanged,
    tabsQuery,
    tabsSendMessage,
    onRuntimeMessage
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      createExtensionApi: exposeExtensionApi,
      extensionApi: api
    };
  } else {
    globalObject.cgmnExtensionApi = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
