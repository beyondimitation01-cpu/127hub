const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const { createFeatureLoader, createHappyLicenseGate, installMessageGate } = require("../happy-license-worker.js");

function makeStore(initial = {}) {
  const state = { ...initial };
  return {
    state,
    async get() {
      return { ...state };
    },
    async set(changes) {
      Object.assign(state, changes);
    }
  };
}

function makeResponse(result, ok = true, status = 200) {
  return { ok, status, json: async () => result };
}

const licenseKey = "LXC-ABCDEFGH-JKLMNPQR-STUVWXYZ-1234";
const deviceId = "device-id-123456";

test("activates the additional license and stores it separately", async () => {
  const store = makeStore();
  const requests = [];
  const gate = createHappyLicenseGate({
    store,
    now: () => 1000,
    makeDeviceId: () => deviceId,
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return makeResponse({ valid: true, status: "active" });
    }
  });

  const result = await gate.activate(licenseKey);

  assert.equal(result.valid, true);
  assert.equal(store.state.licenseKey, licenseKey);
  assert.equal(store.state.deviceId, deviceId);
  assert.equal(requests[0].body.operation, "activate");
  assert.equal(requests[0].body.productIdentifier, "browser-extension-core");
  assert.equal(requests[0].body.deviceIdentifier, deviceId);
  assert.equal(await gate.authorize(), true);
  assert.equal(requests.length, 1);
});

test("requires online validation of an existing stored key", async () => {
  const store = makeStore({ licenseKey, deviceId });
  const gate = createHappyLicenseGate({
    store,
    now: () => 1000,
    fetchImpl: async () => makeResponse({ valid: false, status: "revoked" })
  });

  assert.equal(await gate.authorize(), false);
  assert.equal((await gate.getStatus()).status, "revoked");
  assert.equal(store.state.licenseKey, licenseKey);
});

test("denies access when no additional license is stored", async () => {
  const store = makeStore();
  let requests = 0;
  const gate = createHappyLicenseGate({
    store,
    now: () => 1000,
    makeDeviceId: () => deviceId,
    fetchImpl: async () => {
      requests++;
      return makeResponse({ valid: true, status: "active" });
    }
  });

  assert.equal(await gate.authorize(), false);
  assert.equal((await gate.getStatus()).status, "activation_required");
  assert.equal(requests, 0);
});

test("fails closed on service failure and does not persist an interrupted activation", async () => {
  const store = makeStore();
  const seenDevices = [];
  let attempt = 0;
  const gate = createHappyLicenseGate({
    store,
    now: () => 1000,
    makeDeviceId: () => deviceId,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      seenDevices.push(body.deviceIdentifier);
      if (attempt++ === 0) throw new Error("offline");
      return makeResponse({ valid: true, status: "active" });
    }
  });

  assert.equal((await gate.activate(licenseKey)).valid, false);
  assert.equal(store.state.licenseKey, undefined);
  assert.equal(await gate.authorize(), false);
  assert.equal((await gate.activate(licenseKey)).valid, true);
  assert.deepEqual(seenDevices, [deviceId, deviceId]);
});

test("blocks feature messages before validation and forwards them after validation", async () => {
  const store = makeStore();
  const gate = createHappyLicenseGate({
    store,
    now: () => 1000,
    makeDeviceId: () => deviceId,
    fetchImpl: async () => makeResponse({ valid: true, status: "active" })
  });
  let wrappedListener;
  let handled = 0;
  const runtime = { onMessage: { addListener(listener) { wrappedListener = listener; } } };
  assert.equal(installMessageGate(runtime, gate), true);
  runtime.onMessage.addListener(() => { handled++; });

  let denied;
  wrappedListener({ action: "protectedAction" }, {}, response => { denied = response; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(denied.status, 403);
  assert.equal(handled, 0);

  const activation = await gate.activate(licenseKey);
  assert.equal(activation.valid, true);
  wrappedListener({ action: "protectedAction" }, {}, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handled, 1);
});

test("holds the existing core loader until Happy activation", async () => {
  const gate = createHappyLicenseGate({
    store: makeStore(),
    now: () => 1000,
    fetchImpl: async () => makeResponse({ valid: true, status: "active" })
  });
  let wrappedListener;
  let handled = 0;
  const runtime = { onMessage: { addListener(listener) { wrappedListener = listener; } } };
  installMessageGate(runtime, gate);
  runtime.onMessage.addListener(message => {
    handled++;
    assert.equal(message.action, "pkFetchCore");
  });

  let denied;
  wrappedListener({ action: "pkFetchCore" }, {}, response => { denied = response; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(denied.status, 403);
  assert.equal(handled, 0);

  wrappedListener({ action: "pkActivate" }, {}, response => { denied = response; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(denied.status, 403);
  assert.equal(handled, 0);

  assert.equal((await gate.activate("LXC-ABCDEFGH-JKLMNPQR-STUVWXYZ-1234")).valid, true);
  wrappedListener({ action: "pkFetchCore" }, {}, () => {});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(handled, 1);
});

test("does not inject the existing content bridge before Happy activation", async () => {
  const store = makeStore();
  const releasedTabs = [];
  const gate = createHappyLicenseGate({
    store,
    now: () => 1000,
    makeDeviceId: () => deviceId,
    fetchImpl: async () => makeResponse({ valid: true, status: "active" })
  });
  let wrappedListener;
  const runtime = { onMessage: { addListener(listener) { wrappedListener = listener; } } };
  installMessageGate(runtime, gate, async sender => { releasedTabs.push(sender.tab.id); });
  runtime.onMessage.addListener(() => {});

  let initialStatus;
  wrappedListener({ action: "happyLicenseStatus" }, { tab: { id: 7 } }, response => { initialStatus = response; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(initialStatus.valid, false);
  assert.equal(releasedTabs.length, 0);

  let activation;
  wrappedListener({ action: "happyLicenseActivate", licenseKey }, { tab: { id: 7 } }, response => { activation = response; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(activation.valid, true);
  assert.equal(activation.ready, true);
  assert.deepEqual(releasedTabs, [7]);
});

test("reports valid licensing separately when feature initialization fails", async () => {
  const gate = createHappyLicenseGate({
    store: makeStore(),
    now: () => 1000,
    makeDeviceId: () => deviceId,
    fetchImpl: async () => makeResponse({ valid: true, status: "active" })
  });
  let wrappedListener;
  const runtime = { onMessage: { addListener(listener) { wrappedListener = listener; } } };
  installMessageGate(runtime, gate, async () => { throw new Error("injection failed"); });
  runtime.onMessage.addListener(() => {});

  let activation;
  wrappedListener({ action: "happyLicenseActivate", licenseKey }, { tab: { id: 7 } }, response => { activation = response; });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(activation.valid, true);
  assert.equal(activation.ready, false);
  assert.equal(activation.status, "initialization_failed");
});

test("injects the original content and OTA scripts in baseline order", async () => {
  let injection;
  const loadFeatures = createFeatureLoader({
    scripting: {
      async executeScript(details) {
        injection = details;
      }
    }
  });

  await loadFeatures({ tab: { id: 12 } });

  assert.deepEqual(injection, {
    target: { tabId: 12 },
    files: ["content.js", "ota-update.js"],
    injectImmediately: true
  });
});

test("shows a retryable error when the extension message never responds", async () => {
  function createElement() {
    return {
      children: [],
      listeners: {},
      append(...children) { this.children.push(...children); },
      addEventListener(name, listener) { this.listeners[name] = listener; },
      setAttribute() {},
      focus() {},
      remove() { this.isConnected = false; }
    };
  }

  const page = createElement();
  const window = {};
  window.top = window;
  window.self = window;
  const context = {
    window,
    document: {
      documentElement: page,
      createElement,
      getElementById() { return null; },
      addEventListener() {}
    },
    chrome: {
      runtime: {
        sendMessage() { return new Promise(() => {}); },
        onMessage: { addListener() {} }
      }
    },
    setTimeout(callback) {
      queueMicrotask(callback);
      return 1;
    },
    clearTimeout() {}
  };

  vm.runInNewContext(fs.readFileSync(require.resolve("../happy-license-ui.js"), "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));

  const panel = page.children[0].children[0];
  const status = panel.children[2];
  const form = panel.children[3];
  assert.match(status.textContent, /did not respond in time/i);
  assert.equal(form.hidden, false);
});
