/* scripts/refresh-auth.js
 * Verifies the existing Playwright auth storage state still reaches Google
 * Meet as a signed-in account, then writes the current storage state back.
 *
 * This can extend usable cookie/session state when Google still accepts the
 * session. It cannot bypass a Google verification challenge or expired login.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { AUTH_REFRESH_BROWSER, AUTH_REFRESH_BROWSER_PATH } = process.env;

const browserPaths = {
  chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
};

function resolveAuthStatePath() {
  return path.resolve(
    process.env.AUTH_STATE_PATH ||
      process.env.AUTH_STATE_HOST_PATH ||
      "auth.json",
  );
}

function resolveBrowserPath() {
  if (AUTH_REFRESH_BROWSER_PATH) return AUTH_REFRESH_BROWSER_PATH;
  if (!AUTH_REFRESH_BROWSER) return undefined;

  const preferred = AUTH_REFRESH_BROWSER;
  if (browserPaths[preferred] && fs.existsSync(browserPaths[preferred])) {
    return browserPaths[preferred];
  }

  return Object.values(browserPaths).find((p) => fs.existsSync(p));
}

async function verifyMeetSignedIn(page) {
  await page.goto("https://meet.google.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const url = page.url();
  if (/accounts\.google\.com/.test(url)) {
    throw new Error(
      `Google redirected to sign-in (${url}). Run npm run gen:auth again.`,
    );
  }

  const hostname = new URL(url).hostname;
  if (hostname !== "meet.google.com") {
    throw new Error(`Expected meet.google.com but landed on ${url}.`);
  }

  const signedInMeet = await page
    .locator(
      'a[aria-label*="Google Account"], button[aria-label*="Google Account"], [aria-label*="@"]',
    )
    .first()
    .isVisible({ timeout: 2000 })
    .catch(() => false);

  if (!signedInMeet) {
    const text = await page
      .locator("body")
      .innerText({ timeout: 1000 })
      .catch(() => "");
    throw new Error(
      `Meet loaded without a confirmed signed-in account. Page text: ${text
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500)}`,
    );
  }

  return url;
}

(async () => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: npm run auth:refresh");
    console.log("");
    console.log("Environment:");
    console.log("  AUTH_STATE_HOST_PATH=/absolute/path/to/auth.json");
    console.log("  AUTH_REFRESH_HEADLESS=0  # show browser while checking");
    console.log("  AUTH_REFRESH_BROWSER_PATH=/path/to/browser  # optional");
    console.log("  AUTH_REFRESH_BROWSER=chrome|brave  # optional");
    return;
  }

  const authStatePath = resolveAuthStatePath();
  if (!fs.existsSync(authStatePath)) {
    throw new Error(`Auth state file not found: ${authStatePath}`);
  }

  const executablePath = resolveBrowserPath();
  const headless = process.env.AUTH_REFRESH_HEADLESS !== "0";

  console.log(`[auth] Refreshing storage state: ${authStatePath}`);
  const browser = await chromium.launch({
    headless,
    ...(executablePath ? { executablePath } : {}),
  });
  const context = await browser.newContext({ storageState: authStatePath });
  const page = await context.newPage();

  try {
    const verifiedUrl = await verifyMeetSignedIn(page);
    await context.storageState({ path: authStatePath });
    console.log(`[auth] Refreshed successfully after verifying ${verifiedUrl}`);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("[auth] Refresh failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
