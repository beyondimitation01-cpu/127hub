(function () {
  if (window.top !== window.self || document.getElementById("127hub-happy-license-gate")) return;

  function message(action, data) {
    return chrome.runtime.sendMessage(Object.assign({ action }, data || {})).catch(error => ({
      ok: false,
      valid: false,
      status: "unavailable",
      message: error && error.message || "The extension could not check the additional license."
    }));
  }

  function mount() {
    const page = document.documentElement;
    if (!page || document.getElementById("127hub-happy-license-gate")) return;

    const overlay = document.createElement("section");
    overlay.id = "127hub-happy-license-gate";
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-labelledby", "127hub-happy-license-title");

    const panel = document.createElement("div");
    panel.className = "happy-license-panel";
    const eyebrow = document.createElement("p");
    eyebrow.className = "happy-license-eyebrow";
    eyebrow.textContent = "127HUB AI";
    const title = document.createElement("h1");
    title.id = "127hub-happy-license-title";
    title.textContent = "Additional license";
    const status = document.createElement("p");
    status.className = "happy-license-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.textContent = "Checking license...";

    const form = document.createElement("form");
    form.className = "happy-license-form";
    form.hidden = true;
    const label = document.createElement("label");
    label.htmlFor = "127hub-happy-license-key";
    label.textContent = "License key";
    const input = document.createElement("input");
    input.id = "127hub-happy-license-key";
    input.name = "licenseKey";
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.maxLength = 100;
    input.required = true;
    input.minLength = 16;
    input.placeholder = "Enter your license key";
    const actions = document.createElement("div");
    actions.className = "happy-license-actions";
    const activate = document.createElement("button");
    activate.type = "submit";
    activate.className = "happy-license-primary";
    activate.textContent = "Activate";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "happy-license-retry";
    retry.textContent = "Retry check";
    actions.append(activate, retry);
    form.append(label, input, actions);
    panel.append(eyebrow, title, status, form);
    overlay.append(panel);
    page.append(overlay);

    async function check() {
      status.textContent = "Checking license...";
      form.hidden = true;
      const result = await message("happyLicenseStatus");
      if (result && result.valid === true && result.ready === true) {
        overlay.remove();
        return;
      }
      status.textContent = result && result.message || "A valid additional license is required.";
      form.hidden = false;
      const initializationFailed = result && result.valid === true;
      label.hidden = initializationFailed;
      input.hidden = initializationFailed;
      activate.hidden = initializationFailed;
      input.focus();
    }

    retry.addEventListener("click", check);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      activate.disabled = true;
      retry.disabled = true;
      status.textContent = "Activating license...";
      const result = await message("happyLicenseActivate", { licenseKey: input.value });
      if (result && result.valid === true && result.ready === true) {
        status.textContent = "License activated. Continuing...";
        overlay.remove();
        return;
      }
      if (result && result.valid === true) {
        status.textContent = result.message || "The license is active, but this page could not be initialized. Retry the check.";
        label.hidden = true;
        input.hidden = true;
        activate.hidden = true;
        retry.disabled = false;
        input.blur();
        return;
      }
      status.textContent = result && result.message || "License activation failed. Check the key and retry.";
      activate.disabled = false;
      retry.disabled = false;
      input.focus();
    });

    chrome.runtime.onMessage.addListener(incoming => {
      if (!incoming || incoming.action !== "happyLicenseRequired") return;
      if (!overlay.isConnected) page.append(overlay);
      status.textContent = incoming.message || "A valid additional license is required.";
      form.hidden = false;
      label.hidden = false;
      input.hidden = false;
      activate.hidden = false;
      input.focus();
    });

    check();
  }

  if (document.documentElement) mount();
  else document.addEventListener("readystatechange", mount, { once: true });
})();
