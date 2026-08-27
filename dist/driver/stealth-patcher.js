// Stealth & Anti-Bot Detection Evasion Scripts for CDP / Playwright Driver
export function getStealthScripts() {
    return `
    // Override navigator.webdriver
    Object.defineProperty(navigator, 'webdriver', {
      get: () => false,
    });

    // Mock chrome runtime object
    window.chrome = {
      runtime: {},
      app: {},
      csi: () => {},
      loadTimes: () => {},
    };

    // Override navigator.languages
    Object.defineProperty(navigator, 'languages', {
      get: () => ['en-US', 'en'],
    });

    // Override navigator.plugins
    Object.defineProperty(navigator, 'plugins', {
      get: () => [1, 2, 3, 4, 5],
    });
  `;
}
//# sourceMappingURL=stealth-patcher.js.map