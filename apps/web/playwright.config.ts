import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: "e2e-results",
  // E2E_BASE_URL runs the same journeys against a deployed site.
  use: { baseURL: process.env.E2E_BASE_URL ?? "http://127.0.0.1:4791", trace: "retain-on-failure", screenshot: "only-on-failure" },
  ...(process.env.E2E_BASE_URL ? {} : { webServer: { command: "node e2e/serve.mjs", url: "http://127.0.0.1:4791/", reuseExistingServer: true } }),
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "mobile", use: { ...devices["Pixel 7"] }, grep: /@mobile/ },
  ],
});
