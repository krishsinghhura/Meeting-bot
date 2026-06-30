/* scripts/generate-teams-auth.js
 * Opens a real browser, lets you complete Microsoft/Teams login manually,
 * then exports Playwright storage state to teams-auth.json.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
require("dotenv").config();

const { AUTH_BROWSER, AUTH_BROWSER_PATH } = process.env;

const browserPaths = {
  chrome: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  brave: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
};

function resolveBrowserPath() {
  if (AUTH_BROWSER_PATH) return AUTH_BROWSER_PATH;

  const preferred = AUTH_BROWSER || "chrome";
  if (browserPaths[preferred] && fs.existsSync(browserPaths[preferred])) {
    return browserPaths[preferred];
  }

  return Object.values(browserPaths).find((p) => fs.existsSync(p));
}

function promptEnter(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
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
    throw new Error(
      `Microsoft redirected to sign-in (${url}). Complete login before saving teams-auth.json.`,
    );
  }

  const signedInMarker = await page
    .locator(
      '[data-tid*="me-control"], [aria-label*="Account"], [aria-label*="Profile"], button:has-text("Chat"), [data-tid*="app-bar"]',
    )
    .first()
    .isVisible({ timeout: 3000 })
    .catch(() => false);

  if (!signedInMarker && /sign in/i.test(normalized)) {
    throw new Error(
      `Teams loaded without a confirmed signed-in account. url=${url}; page=${normalized.slice(0, 500)}`,
    );
  }

  console.log(`Verified Teams session appears usable: ${url}`);
}

(async () => {
  const executablePath = resolveBrowserPath();
  if (!executablePath) {
    throw new Error(
      "No supported browser found. Install Google Chrome, switch AUTH_BROWSER=brave, or set AUTH_BROWSER_PATH in .env.",
    );
  }

  const profileName = `.teams-auth-browser-profile-${Date.now()}`;
  const userDataDir = path.resolve(profileName);
  console.log(`Launching real browser for Teams auth: ${executablePath}`);
  console.log(`Using temporary auth profile: ${userDataDir}`);

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath,
    headless: false,
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-default-browser-check",
      "--no-first-run",
    ],
  });

  const page = context.pages()[0] || (await context.newPage());

  console.log("Navigating to Teams sign-in ...");
  await page.goto("https://teams.live.com/");

  console.log("");
  console.log("Complete Microsoft/Teams sign-in in the opened browser.");
  console.log("Important: wait until Teams itself is loaded as the bot account.");
  await promptEnter("Press Enter here after Teams has loaded signed in...");

  await verifyTeamsSignedIn(page);

  const savePath = path.resolve("teams-auth.json");
  await context.storageState({ path: savePath });
  console.log(`Saved Teams logged-in session -> ${savePath}`);

  await context.close();
  console.log("Finished. You can now run Teams bot containers using this teams-auth.json.");
})().catch((err) => {
  console.error("generate-teams-auth failed:", err);
  process.exit(1);
});
