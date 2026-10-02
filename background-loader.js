importScripts("happy-license-worker.js");

if (!self.HappyLicenseGate || self.HappyLicenseGate.installed !== true) {
  throw new Error("Unable to install the additional license gate");
}

importScripts("background.js");
