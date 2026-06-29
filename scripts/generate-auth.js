/* scripts/generate-auth.js
 * Opens a real browser, lets you complete Google login manually, then exports
 * Playwright storage state to auth.json when you press Enter in this terminal.
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

async function verifyMeetSignedIn(page) {
  await page.goto("https://meet.google.com/", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);

  const url = page.url();
  if (/accounts\.google\.com/.test(url)) {
    throw new Error(
      `Google Meet redirected to account chooser/sign-in (${url}). Select the bot account and wait for Meet to load before saving auth.json.`,
    );
  }
  const hostname = new URL(url).hostname;
  if (hostname !== "meet.google.com") {
    const text = await page
      .locator("body")
      .innerText({ timeout: 1000 })
      .catch(() => "");
    throw new Error(
      `Google Meet did not load a signed-in Meet page. Expected meet.google.com but landed on ${url}. Select the bot account and wait until the signed-in Meet home page loads before pressing Enter. Page text: ${text
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500)}`,
    );
  }

  const signedInMeet = await page
    .locator(
      'a[aria-label*="Google Account"], button[aria-label*="Google Account"], [aria-label*="@"]',
    )
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);

  if (!signedInMeet) {
    const text = await page
      .locator("body")
      .innerText({ timeout: 1000 })
      .catch(() => "");
    throw new Error(
      `Google Meet loaded without a confirmed signed-in Google account. url=${url}; page=${text
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 500)}`,
    );
  }

  console.log(`Verified Google Meet is usable: ${url}`);
}

const LOGIN_URL =
  "https://accounts.google.com/ServiceLogin" +
  "?service=wise&passive=true&continue=https%3A%2F%2Fmeet.google.com%2F";

(async () => {
  const executablePath = resolveBrowserPath();
  if (!executablePath) {
    throw new Error(
      "No supported browser found. Install Google Chrome, switch AUTH_BROWSER=brave, or set AUTH_BROWSER_PATH in .env.",
    );
  }

  const profileName = `.auth-browser-profile-${Date.now()}`;
  const userDataDir = path.resolve(profileName);
  console.log(`Launching real browser for auth: ${executablePath}`);
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

  console.log("Navigating to Google sign-in ...");
  await page.goto(LOGIN_URL);

  console.log("");
  console.log("Complete Google sign-in in the opened browser.");
  console.log(
    "Important: select the bot account and wait until https://meet.google.com/ itself is loaded.",
  );
  await promptEnter("Press Enter here after Google Meet has loaded...");

  await verifyMeetSignedIn(page);

  const savePath = path.resolve("auth.json");
  await context.storageState({ path: savePath });
  console.log(`Saved logged-in session -> ${savePath}`);

  await context.close();
  console.log("Finished. You can now run the bot containers using this auth.json.");
})().catch((err) => {
  console.error("generate-auth failed:", err);
  process.exit(1);
});
