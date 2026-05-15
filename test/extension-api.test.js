const assert = require("node:assert/strict");

function loadWithGlobals(globals) {
  const previous = {
    browser: global.browser,
    chrome: global.chrome
  };

  delete require.cache[require.resolve("../extension-api.js")];
  global.browser = globals.browser;
  global.chrome = globals.chrome;

  const loaded = require("../extension-api.js").extensionApi;

  global.browser = previous.browser;
  global.chrome = previous.chrome;

  return loaded;
}

async function testPromiseApi() {
  const changes = [];
  const messages = [];
  const api = loadWithGlobals({
    browser: {
      storage: {
        sync: {
          get: async () => ({ enabled: false }),
          set: async (items) => changes.push(items)
        },
        onChanged: {
          addListener: (listener) => changes.push(listener)
        }
      },
      tabs: {
        query: async () => [{ id: 12 }],
        sendMessage: async (_tabId, message) => ({
          supported: message.type === "CGMN_STATUS"
        })
      },
      runtime: {
        getURL: (path) => `moz-extension://id/${path}`,
        onMessage: {
          addListener: (listener) => messages.push(listener)
        }
      }
    }
  });

  assert.deepEqual(await api.storageGet({ enabled: true }), { enabled: false });
  await api.storageSet({ enabled: true });
  assert.deepEqual(changes[0], { enabled: true });
  assert.deepEqual(await api.tabsQuery({ active: true }), [{ id: 12 }]);
  assert.deepEqual(await api.tabsSendMessage(12, { type: "CGMN_STATUS" }), {
    supported: true
  });
  api.onRuntimeMessage(() => false);
  assert.equal(messages.length, 1);
  assert.equal(api.runtimeGetURL("hook.js"), "moz-extension://id/hook.js");
}

async function testCallbackApi() {
  const stored = [];
  const api = loadWithGlobals({
    chrome: {
      runtime: {},
      storage: {
        sync: {
          get: (_defaults, callback) => callback({ removeBoxes: false }),
          set: (items, callback) => {
            stored.push(items);
            callback();
          }
        },
        onChanged: {
          addListener: () => undefined
        }
      },
      tabs: {
        query: (_query, callback) => callback([{ id: 4 }]),
        sendMessage: (_tabId, _message, callback) =>
          callback({ supported: true })
      }
    }
  });

  assert.deepEqual(await api.storageGet({ removeBoxes: true }), {
    removeBoxes: false
  });
  await api.storageSet({ removeBoxes: true });
  assert.deepEqual(stored[0], { removeBoxes: true });
  assert.deepEqual(await api.tabsQuery({ active: true }), [{ id: 4 }]);
  assert.deepEqual(await api.tabsSendMessage(4, { type: "CGMN_STATUS" }), {
    supported: true
  });
}

Promise.all([testPromiseApi(), testCallbackApi()]).then(() => {
  console.log("extension api ok");
});
