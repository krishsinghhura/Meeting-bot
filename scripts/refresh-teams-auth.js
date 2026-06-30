/* scripts/refresh-teams-auth.js
 * Verifies the existing Teams Playwright auth storage state still reaches
 * Teams as a signed-in account, then writes current storage state back.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
require("dotenv").config();

function resolveAuthStatePath() {
  return path.resolve(
    process.env.TEAMS_AUTH_STATE_PATH ||
      process.env.TEAMS_AUTH_STATE_HOST_PATH ||
      "teams-auth.json",
  );
}

async function verifyTeamsSignedIn(page) {
  await page.goto("https://teams.live.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);

  const url = page.url();
  const hostname = new URL(url).hostname;
  const text = await page
    .locator("body")
    .innerText({ timeout: 2000 })
    .catch(() => "");
  const normalized = text.replace(/\s+/g, " ").trim();

  if (/login\.live\.com|login\.microsoftonline\.com/.test(hostname)) {
    throw new Error(`Microsoft redirected to sign-in (${url}). Run npm run gen:teams-auth again.`);
  }

  const signedInMarker = await page
    .locator(
      '[data-tid*="me-control"], [aria-label*="Account"], [aria-label*="Profile"], button:has-text("Chat"), [data-tid*="app-bar"]',
    )
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  if (!signedInMarker && /sign in/i.test(normalized)) {
    throw new Error(`Teams loaded without a confirmed signed-in account. Page: ${normalized.slice(0, 500)}`);
  }

  return url;
}

(async () => {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: npm run teams-auth:refresh");
    console.log("");
    console.log("Environment:");
    console.log("  TEAMS_AUTH_STATE_HOST_PATH=/absolute/path/to/teams-auth.json");
    console.log("  TEAMS_AUTH_REFRESH_HEADLESS=0  # show browser while checking");
    return;
  }

  const authStatePath = resolveAuthStatePath();
  if (!fs.existsSync(authStatePath)) {
    throw new Error(`Teams auth state file not found: ${authStatePath}`);
  }

  const headless = process.env.TEAMS_AUTH_REFRESH_HEADLESS !== "0";

  console.log(`[teams-auth] Refreshing storage state: ${authStatePath}`);
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({ storageState: authStatePath });
  const page = await context.newPage();

  try {
    const verifiedUrl = await verifyTeamsSignedIn(page);
    await context.storageState({ path: authStatePath });
    console.log(`[teams-auth] Refreshed successfully after verifying ${verifiedUrl}`);
  } finally {
    await browser.close();
  }
})().catch((err) => {
  console.error("[teams-auth] Refresh failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
