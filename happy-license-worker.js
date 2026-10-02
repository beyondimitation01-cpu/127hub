(function (root) {
  const API_URL = "https://happy-little101.lovable.app/api/public/v1/licenses";
  const PRODUCT_IDENTIFIER = "browser-extension-core";
  const DB_NAME = "127hub-happy-license";
  const DB_STORE = "state";
  const DB_KEY = "license";
  const MESSAGE_ACTIONS = new Set(["happyLicenseStatus", "happyLicenseActivate"]);
  const BOOTSTRAP_ACTIONS = new Set(["handshakeStatus", "ping"]);
  const VALID_CACHE_MS = 30000;
  const INVALID_CACHE_MS = 5000;

  function createIndexedDbStore(indexedDb) {
    let databasePromise;

    function openDatabase() {
      if (!databasePromise) {
        databasePromise = new Promise((resolve, reject) => {
          const request = indexedDb.open(DB_NAME, 1);
          request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(DB_STORE)) {
              request.result.createObjectStore(DB_STORE);
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error || new Error("License storage unavailable"));
          request.onblocked = () => reject(new Error("License storage is blocked"));
        });
      }
      return databasePromise;
    }

    return {
      async get() {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
          const transaction = database.transaction(DB_STORE, "readonly");
          const request = transaction.objectStore(DB_STORE).get(DB_KEY);
          request.onsuccess = () => resolve(request.result || {});
          request.onerror = () => reject(request.error || new Error("License storage read failed"));
          transaction.onabort = () => reject(transaction.error || new Error("License storage read failed"));
        });
      },
      async set(changes) {
        const database = await openDatabase();
        return new Promise((resolve, reject) => {
          const transaction = database.transaction(DB_STORE, "readwrite");
          const store = transaction.objectStore(DB_STORE);
          const request = store.get(DB_KEY);
          request.onsuccess = () => store.put(Object.assign({}, request.result || {}, changes), DB_KEY);
          request.onerror = () => reject(request.error || new Error("License storage write failed"));
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error || new Error("License storage write failed"));
          transaction.onabort = () => reject(transaction.error || new Error("License storage write failed"));
        });
      }
    };
  }

  function createHappyLicenseGate(options) {
    const store = options.store;
    const fetchImpl = options.fetchImpl;
    const now = options.now || Date.now;
    const makeDeviceId = options.makeDeviceId || (() => {
      if (root.crypto && typeof root.crypto.randomUUID === "function") {
        return root.crypto.randomUUID();
      }
      const bytes = new Uint8Array(16);
      root.crypto.getRandomValues(bytes);
      return Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("");
    });
    let deviceIdPromise;
    let validationPromise;
    let cachedValidation = null;
    let activationPromise;

    async function getDeviceId() {
      if (!deviceIdPromise) {
        deviceIdPromise = (async () => {
          const state = await store.get();
          if (state.deviceId) return state.deviceId;
          const deviceId = makeDeviceId();
          await store.set({ deviceId });
          return deviceId;
        })();
      }
      return deviceIdPromise;
    }

    async function requestLicenseOperation(operation, licenseKey) {
      const deviceIdentifier = await getDeviceId();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetchImpl(API_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            operation,
            licenseKey,
            productIdentifier: PRODUCT_IDENTIFIER,
            deviceIdentifier
          }),
          cache: "no-store",
          signal: controller.signal
        });
        const result = await response.json().catch(() => null);
        if (!response.ok || !result || typeof result !== "object") {
          return {
            valid: false,
            status: result && result.status || (response.status === 429 ? "rate_limited" : "unavailable"),
            message: "The additional licensing service could not validate this license."
          };
        }
        return result;
      } catch (_error) {
        return {
          valid: false,
          status: "unavailable",
          message: "The additional licensing service could not be reached. Check your connection and retry."
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    function cacheResult(valid, result, licenseKey) {
      cachedValidation = {
        valid,
        result,
        licenseKey,
        expiresAt: now() + (valid ? VALID_CACHE_MS : INVALID_CACHE_MS)
      };
      return cachedValidation;
    }

    async function validateStoredLicense() {
      if (validationPromise) return validationPromise;
      validationPromise = (async () => {
        const state = await store.get();
        const licenseKey = String(state.licenseKey || "").trim();
        if (!licenseKey) {
          return cacheResult(false, {
            valid: false,
            status: "activation_required",
            message: "Enter your additional license to continue."
          }, "");
        }
        if (cachedValidation && cachedValidation.licenseKey === licenseKey && cachedValidation.expiresAt > now()) {
          return cachedValidation;
        }
        const result = await requestLicenseOperation("check", licenseKey);
        const valid = result.valid === true && result.status === "active";
        return cacheResult(valid, result, licenseKey);
      })().catch(error => cacheResult(false, {
        valid: false,
        status: "unavailable",
        message: error && error.message || "Additional license state is unavailable."
      }, "")).finally(() => {
        validationPromise = null;
      });
      return validationPromise;
    }

    async function getStatus() {
      const status = await validateStoredLicense();
      return {
        ok: status.valid,
        valid: status.valid,
        status: status.result.status,
        message: status.result.message || ""
      };
    }

    async function activate(licenseKey) {
      if (activationPromise) return activationPromise;
      const normalizedKey = String(licenseKey || "").trim();
      if (normalizedKey.length < 16 || normalizedKey.length > 100) {
        return {
          ok: false,
          valid: false,
          status: "invalid_request",
          message: "Enter a valid license key."
        };
      }
      activationPromise = (async () => {
        try {
          const result = await requestLicenseOperation("activate", normalizedKey);
          const valid = result.valid === true && result.status === "active";
          if (valid) {
            const deviceId = await getDeviceId();
            await store.set({ licenseKey: normalizedKey, deviceId });
          }
          cacheResult(valid, result, valid ? normalizedKey : "");
          return {
            ok: valid,
            valid,
            status: result.status || "invalid",
            message: valid ? "License activated." : result.message || "The additional license was not accepted."
          };
        } catch (error) {
          cachedValidation = null;
          return {
            ok: false,
            valid: false,
            status: "unavailable",
            message: error && error.message || "License activation could not be completed. Retry the same key."
          };
        } finally {
          activationPromise = null;
        }
      })();
      return activationPromise;
    }

    async function authorize() {
      const status = await validateStoredLicense();
      return status.valid;
    }

    return { activate, authorize, getStatus };
  }

  function installMessageGate(runtime, gate, releaseFeatures) {
    const event = runtime && runtime.onMessage;
    if (!event || typeof event.addListener !== "function") return false;
    const originalAddListener = event.addListener;
    const loadFeatures = releaseFeatures || (() => Promise.resolve());

    async function reportStatus(sender, sendResponse) {
      const result = await gate.getStatus();
      if (!result.valid) {
        sendResponse(result);
        return;
      }
      try {
        await loadFeatures(sender);
        sendResponse(Object.assign({}, result, { ready: true }));
      } catch (_error) {
        sendResponse({
          ok: false,
          valid: true,
          ready: false,
          status: "initialization_failed",
          message: "The license is valid, but the extension could not initialize this page. Retry the check."
        });
      }
    }

    async function reportActivation(licenseKey, sender, sendResponse) {
      const result = await gate.activate(licenseKey);
      if (!result.valid) {
        sendResponse(result);
        return;
      }
      try {
        await loadFeatures(sender);
        sendResponse(Object.assign({}, result, { ready: true }));
      } catch (_error) {
        sendResponse(Object.assign({}, result, {
          ready: false,
          status: "initialization_failed",
          message: "The license is active, but the extension could not initialize this page. Retry the check."
        }));
      }
    }

    const wrappedAddListener = function (listener) {
      const guardedListener = function (message, sender, sendResponse) {
        const action = message && message.action;
        if (action === "happyLicenseStatus") {
          reportStatus(sender, sendResponse).catch(() => sendResponse({
            ok: false,
            valid: false,
            status: "unavailable",
            message: "Additional license state is unavailable."
          }));
          return true;
        }
        if (action === "happyLicenseActivate") {
          reportActivation(message.licenseKey, sender, sendResponse).catch(() => sendResponse({
            ok: false,
            valid: false,
            status: "unavailable",
            message: "License activation could not be completed."
          }));
          return true;
        }
        if (BOOTSTRAP_ACTIONS.has(action)) {
          return listener(message, sender, sendResponse);
        }
        gate.authorize().then(valid => {
          if (valid) {
            listener(message, sender, sendResponse);
            return;
          }
          if (sender && sender.tab && Number.isInteger(sender.tab.id)) {
            try {
              root.chrome.tabs.sendMessage(sender.tab.id, { action: "happyLicenseRequired" }).catch(() => {});
            } catch (_error) {}
          }
          sendResponse({
            ok: false,
            status: 403,
            data: {
              error: "additional_license_required",
              message: "Activate a valid additional license to use 127HUB AI."
            }
          });
        }).catch(() => sendResponse({
          ok: false,
          status: 403,
          data: {
            error: "additional_license_unavailable",
            message: "The additional license could not be verified."
          }
        }));
        return true;
      };
      return originalAddListener.call(event, guardedListener);
    };
    try {
      event.addListener = wrappedAddListener;
      return event.addListener === wrappedAddListener;
    } catch (_error) {
      return false;
    }
  }

  const api = { createHappyLicenseGate, createIndexedDbStore, installMessageGate };
  root.HappyLicenseGate = api;
  if (typeof module === "object" && module.exports) module.exports = api;

  if (root.chrome && root.chrome.runtime) {
    try {
      const gate = createHappyLicenseGate({
        store: createIndexedDbStore(root.indexedDB),
        fetchImpl: root.fetch.bind(root)
      });
      api.installed = installMessageGate(root.chrome.runtime, gate, async sender => {
        const tabId = sender && sender.tab && sender.tab.id;
        if (!Number.isInteger(tabId)) throw new Error("No page tab is available");
        await root.chrome.scripting.executeScript({
          target: { tabId },
          files: ["content.js"],
          injectImmediately: true
        });
      });
      if (!api.installed) throw new Error("Unable to install additional license gate");
    } catch (error) {
      api.installed = false;
      console.error("[127HUB AI] Additional license gate failed to initialize:", error && error.message);
    }
  }
})(globalThis);
