import { BrowserContext, chromium, Locator, Page } from "playwright";
import { existsSync } from "fs";
import { saveTranscriptBatch } from "../storage";
import { v4 as uuidv4 } from "uuid";
import { Segment } from "src/models";
import { backendCallback } from "../callback";

type MeetingProvider = "google_meet" | "microsoft_teams";

// bot will leave the meeting immediately if it hears any of the following phrases
const EXIT_PHRASES = [
  "notetaker, please leave",
  "note taker, please leave",
  "no taker please leave",
  "notetaker please leave",
].map((p) => p.toLowerCase());

// flush interval to save captions
const FLUSH_EVERY_MS = 1_000;

// selector used to detect the Google Meet meeting has ended
const LEAVE_BANNER_SEL =
  'body > div[role="heading"]:has-text("You left the meeting"),' +
  'body > div[role="heading"]:has-text("You’ve left the call"),' +
  'body > div[role="heading"]:has-text("You’ve been removed from the meeting"),' +
  'body > div[role="heading"]:has-text("You\'ve been removed from the meeting")';
const MEET_ENDED_TEXT =
  /you left the meeting|you.ve left the call|you.ve been removed from the meeting|you have been removed from the meeting|return to home screen|rejoin/i;

const TEAMS_CAPTIONS_CONTAINER_SEL =
  'div[data-tid="closed-caption-renderer-wrapper"]';
const DEFAULT_TEAMS_ADMISSION_TIMEOUT_MS = 10 * 60 * 1000;

// launches browser, detects provider, joins meeting, records captions
export async function runBot(url: string): Promise<string> {
  const provider = providerFromUrl(url);
  const meetingId = uuidv4();
  const createdAt = new Date();

  // ensures meeting always exists
  await saveTranscriptBatch(meetingId, createdAt, [], true);

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--enable-unsafe-swiftshader",
      "--mute-audio",
      "--deny-permission-prompts",
      ...(provider === "microsoft_teams"
        ? [
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
          ]
        : []),
    ],
  });

  const authStatePath =
    provider === "google_meet"
      ? process.env.AUTH_STATE_PATH ?? "auth.json"
      : process.env.TEAMS_AUTH_STATE_PATH ?? "teams-auth.json";
  const shouldUseAuthState = existsSync(authStatePath);
  if (shouldUseAuthState) {
    console.log(`[auth] Using Playwright storage state from ${authStatePath}`);
  } else if (provider === "google_meet") {
    console.warn(
      `[auth] No Playwright storage state found at ${authStatePath}; continuing without a signed-in Google session`,
    );
  } else {
    console.warn(
      `[auth] No Teams storage state found at ${authStatePath}; continuing as a Teams guest`,
    );
  }

  const contextOptions: {
    storageState?: string;
    viewport?: { width: number; height: number };
    userAgent?: string;
  } = {};
  if (shouldUseAuthState) {
    contextOptions.storageState = authStatePath;
  }
  if (provider === "microsoft_teams") {
    contextOptions.viewport = { width: 1280, height: 720 };
    contextOptions.userAgent =
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";
  }
  const context: BrowserContext = await browser.newContext(contextOptions);
  const page = await context.newPage();
  let canPersistAuthState = false;

  // for debugging so that you see all console lines in terminal
  page.on("console", (msg) => console.log(`[page:${msg.type()}]`, msg.text()));

  try {
    console.log(`[orchestrator] Detected provider: ${provider}`);
    if (provider === "google_meet") {
      if (shouldUseAuthState) {
        await logGoogleAuthState(page);
        canPersistAuthState = true;
      }
      return await runGoogleMeetBot(page, url, meetingId, createdAt);
    }

    canPersistAuthState = shouldUseAuthState;
    return await runMicrosoftTeamsBot(
      page,
      url,
      meetingId,
      createdAt,
      shouldUseAuthState,
    );
  } catch (err) {
    await notifyBackendFailure(meetingId, err);
    throw new Error(`Run Bot error: ${err}`);
  } finally {
    await persistAuthState(context, authStatePath, canPersistAuthState);
    await browser.close().catch(() => undefined);
  }
}

function providerFromUrl(url: string): MeetingProvider {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Unsupported meeting URL: ${url}`);
  }

  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "meet.google.com") {
    return "google_meet";
  }
  if (hostname === "teams.microsoft.com" || hostname === "teams.live.com") {
    return "microsoft_teams";
  }

  throw new Error(`Unsupported meeting URL host: ${hostname}`);
}

async function runGoogleMeetBot(
  page: Page,
  url: string,
  meetingId: string,
  createdAt: Date,
): Promise<string> {
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // mute mic, turn off camera, clear popup
  await clickIfVisible(page, 'button[aria-label*="Turn off microphone"]');
  await clickIfVisible(page, 'button[aria-label*="Turn off camera"]');
  await clickIfVisible(page, 'button:has-text("Got it")');

  console.log("Current URL:", page.url());
  console.log(
    "Visible buttons on screen:",
    await page.locator("button").allTextContents(),
  );

  // join/ask to join, handle 2-step join preview, close modals, wait until in meeting
  await clickJoin(page);
  await collapsePreviewIfNeeded(page);
  await dismissOverlays(page);
  await waitUntilJoined(page);
  console.log("joined meeting");

  // turn captions on
  await ensureCaptionsOn(page);
  console.log("captions visible");

  // scrape captions
  const mid = await scrapeCaptions(page, meetingId, createdAt);
  console.log("done scraping. Returning meetingId.");

  return mid;
}

async function persistAuthState(
  context: BrowserContext,
  authStatePath: string,
  hasAuthState: boolean,
) {
  if (!hasAuthState || process.env.AUTH_STATE_WRITE_BACK === "0") {
    return;
  }

  try {
    await context.storageState({ path: authStatePath });
    console.log(`[auth] Refreshed storage state at ${authStatePath}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[auth] Could not refresh storage state at ${authStatePath}: ${message}`);
  }
}

async function notifyBackendFailure(meetingId: string, err: unknown) {
  const jobId = process.env.JOB_ID;
  if (!jobId) return;

  const error = err instanceof Error ? err.message : String(err);
  try {
    const res = await fetch(backendCallback("/bot-failed"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, meetingId, error }),
    });
    console.log(`[bot-failed] ${res.status}`);
  } catch (postErr) {
    console.error("[bot-failed] POST failed:", postErr);
  }
}

async function runMicrosoftTeamsBot(
  page: Page,
  url: string,
  meetingId: string,
  createdAt: Date,
  hasAuthState: boolean,
): Promise<string> {
  const displayName = process.env.BOT_DISPLAY_NAME || "Boom Notetaker";
  const launchUrl = await resolveTeamsLaunchUrlWithoutDialog(url, hasAuthState);

  await page.goto(launchUrl.toString(), { waitUntil: "domcontentloaded" });
  console.log(`[teams] Opened launch URL: ${page.url()}`);

  await clickTeamsJoinOnWeb(page);
  await joinTeamsPrejoin(page, displayName);

  if (await isTeamsInLobby(page, 10_000)) {
    console.log("[teams] Bot is waiting in Teams lobby.");
  }

  await waitUntilTeamsJoined(page, teamsAdmissionTimeoutMs());
  console.log("[teams] joined meeting");

  await enableTeamsCaptions(page);
  console.log("[teams] captions visible");

  const mid = await scrapeTeamsCaptions(page, meetingId, createdAt);
  console.log("[teams] done scraping. Returning meetingId.");
  return mid;
}

function teamsAdmissionTimeoutMs() {
  const configured = Number(process.env.TEAMS_ADMISSION_TIMEOUT_MS || "");
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TEAMS_ADMISSION_TIMEOUT_MS;
}

async function resolveTeamsLaunchUrlWithoutDialog(
  meetingUrl: string,
  preferSignedIn: boolean,
): Promise<URL> {
  try {
    const response = await fetch(meetingUrl, { redirect: "follow" });
    const launchUrl = new URL(response.url);
    if (preferSignedIn) {
      removeAnonymousTeamsLaunchParams(launchUrl);
    }
    launchUrl.searchParams.set("msLaunch", "false");
    launchUrl.searchParams.set("type", "meetup-join");
    launchUrl.searchParams.set("directDl", "true");
    launchUrl.searchParams.set("enableMobilePage", "true");
    launchUrl.searchParams.set("suppressPrompt", "true");
    console.log(`[teams] resolved launch URL: ${launchUrl.toString()}`);
    return launchUrl;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to resolve Teams launch URL: ${message}`);
  }
}

function removeAnonymousTeamsLaunchParams(launchUrl: URL) {
  launchUrl.searchParams.delete("anon");

  const nestedUrl = launchUrl.searchParams.get("url");
  if (nestedUrl) {
    launchUrl.searchParams.set("url", removeAnonymousTeamsUrlParam(nestedUrl));
  }
}

function removeAnonymousTeamsUrlParam(value: string) {
  const parsed = new URL(value, "https://teams.live.com");
  parsed.searchParams.delete("anon");
  parsed.hash = removeAnonymousTeamsHashParam(parsed.hash);

  if (/^https?:\/\//i.test(value)) {
    return parsed.toString();
  }

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

function removeAnonymousTeamsHashParam(hash: string) {
  if (!hash) return hash;

  const questionIndex = hash.indexOf("?");
  if (questionIndex === -1) return hash;

  const route = hash.slice(0, questionIndex);
  const params = new URLSearchParams(hash.slice(questionIndex + 1));
  params.delete("anon");

  const query = params.toString();
  return query ? `${route}?${query}` : route;
}

async function clickTeamsJoinOnWeb(page: Page) {
  if (await isTeamsPrejoinReady(page, 3000)) {
    console.log("[teams] already on signed-in web prejoin screen");
    return;
  }

  if (
    await page
      .locator('input[placeholder="Type your name"]')
      .first()
      .isVisible({ timeout: 3000 })
      .catch(() => false)
  ) {
    console.log("[teams] already on web join lobby");
    return;
  }

  const selectors = [
    'button[data-tid="joinOnWeb"]',
    'button:has-text("Continue on this browser")',
    'button:has-text("Join on the web instead")',
    'button:has-text("Use the web app instead")',
  ];

  for (const selector of selectors) {
    if (await clickIfVisible(page, selector, 30_000)) {
      console.log(`[teams] clicked web join control: ${selector}`);
      return;
    }
  }

  const pageText = await getPageTextSnippet(page);
  throw new Error(`Teams did not show a web join control. Page text: ${pageText}`);
}

async function isTeamsPrejoinReady(page: Page, timeoutMs = 1000): Promise<boolean> {
  return page
    .locator('button:has-text("Join now")')
    .first()
    .isVisible({ timeout: timeoutMs })
    .catch(() => false);
}

async function joinTeamsPrejoin(page: Page, displayName: string) {
  const nameInput = page.locator('input[placeholder="Type your name"]').first();
  const hasGuestNameInput = await nameInput
    .isVisible({ timeout: 10_000 })
    .catch(() => false);

  if (hasGuestNameInput) {
    await nameInput.fill(displayName);
    console.log(`[teams] entered guest display name: ${displayName}`);
  } else {
    console.log("[teams] no guest name input visible; continuing with signed-in Teams identity");
  }

  await disableTeamsPrejoinMedia(page);

  const joinNow = page.locator('button:has-text("Join now")').first();
  await joinNow
    .waitFor({ state: "visible", timeout: 45_000 })
    .catch(async (err) => {
      const state = await getTeamsPageState(page);
      throw new Error(
        `Teams prejoin did not show Join now. url=${state.url}; buttons=${JSON.stringify(
          state.buttons,
        )}; page=${state.bodyText}; cause=${err instanceof Error ? err.message : String(err)}`,
      );
    });
  await clickLocator(joinNow, 'Teams "Join now"');
  console.log('[teams] clicked "Join now"');
}

async function disableTeamsPrejoinMedia(page: Page) {
  for (const selector of [
    'button:has-text("Don\'t use audio")',
    'button:has-text("No audio")',
    'div[role="button"]:has-text("Don\'t use audio")',
    'div[role="button"]:has-text("No audio")',
  ]) {
    if (await clickIfVisible(page, selector, 1500)) {
      console.log(`[teams] selected no-audio option: ${selector}`);
      break;
    }
  }

  const toggles = [
    'button[aria-label*="Microphone"]',
    'button[aria-label*="Camera"]',
    '[data-tid*="toggle-mute"]',
    '[data-tid*="toggle-video"]',
  ];

  for (const selector of toggles) {
    const controls = page.locator(selector);
    const count = await controls.count().catch(() => 0);
    for (let i = 0; i < count; i++) {
      const control = controls.nth(i);
      const label = [
        await control.getAttribute("aria-label").catch(() => ""),
        await control.getAttribute("title").catch(() => ""),
        await control.textContent().catch(() => ""),
      ].join(" ");
      if (
        /turn off|mute microphone|mic is on|microphone is on|camera is on|turn camera off|turn microphone off/i.test(
          label,
        )
      ) {
        await clickLocator(control, `Teams media control ${selector}`, 1000).catch(() => undefined);
      }
    }
  }
}

async function isTeamsInLobby(page: Page, timeoutMs = 1000): Promise<boolean> {
  return page
    .getByText(/someone will let you in shortly|waiting for someone to let you in|you.re in the lobby|you.re waiting in the lobby|when someone lets you in|admit you/i)
    .first()
    .isVisible({ timeout: timeoutMs })
    .catch(() => false);
}

async function waitUntilTeamsJoined(page: Page, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastState = "";

  while (Date.now() < deadline) {
    const inMeeting = await page
      .locator(
        'button[id="hangup-button"], button[aria-label*="Leave"], button[title*="Leave"], [data-tid*="hangup"], [data-tid*="leave"]',
      )
      .first()
      .isVisible({ timeout: 1000 })
      .catch(() => false);

    if (inMeeting) {
      return;
    }

    if (await isTeamsInLobby(page, 1000)) {
      const state = await getTeamsPageState(page);
      if (state.signature !== lastState) {
        lastState = state.signature;
        console.log(`[teams] lobby wait state: ${state.signature}`);
      }
      await page.waitForTimeout(1500);
      continue;
    }

    const state = await getTeamsPageState(page);
    if (state.signature !== lastState) {
      lastState = state.signature;
      console.log(`[teams] join wait state: ${state.signature}`);
    }

    const bodyText = state.bodyText.toLowerCase();
    if (
      bodyText.includes("meeting has ended") ||
      bodyText.includes("someone in the meeting should let you in soon") ||
      bodyText.includes("we couldn't connect you")
    ) {
      throw new Error(`Teams join failed or stalled. Page text: ${bodyText}`);
    }

    await page.waitForTimeout(1000);
  }

  const state = await getTeamsPageState(page);
  throw new Error(
    `Teams bot was not admitted within ${timeoutMs}ms. url=${state.url}; buttons=${JSON.stringify(
      state.buttons,
    )}; page=${state.bodyText}`,
  );
}

async function getTeamsPageState(page: Page) {
  const bodyText = await getPageTextSnippet(page);
  const buttons = (await getVisibleButtonLabels(page)).slice(0, 20);
  return {
    url: page.url(),
    bodyText,
    buttons,
    signature: `url=${page.url()} buttons=${JSON.stringify(buttons)} text=${bodyText.slice(0, 240)}`,
  };
}

async function enableTeamsCaptions(page: Page) {
  await page
    .locator(TEAMS_CAPTIONS_CONTAINER_SEL)
    .first()
    .waitFor({ state: "visible", timeout: 3000 })
    .then(() => undefined)
    .catch(() => undefined);

  if (await isTeamsCaptionsVisible(page, 500)) {
    return;
  }

  const moreButton = page.locator('button[id="callingButtons-showMoreBtn"]').first();
  await moreButton.waitFor({ state: "visible", timeout: 120_000 });
  await clickLocator(moreButton, 'Teams "More" button');
  console.log('[teams] clicked "More"');

  const captionsButton = page.locator('div[id="closed-captions-button"]').first();
  await captionsButton.waitFor({ state: "visible", timeout: 120_000 });
  await clickLocator(captionsButton, 'Teams "Captions" button');
  console.log('[teams] clicked "Captions"');

  await page
    .locator(TEAMS_CAPTIONS_CONTAINER_SEL)
    .first()
    .waitFor({ state: "visible", timeout: 120_000 });
}

async function isTeamsCaptionsVisible(page: Page, timeoutMs = 1000): Promise<boolean> {
  return page
    .locator(TEAMS_CAPTIONS_CONTAINER_SEL)
    .first()
    .isVisible({ timeout: timeoutMs })
    .catch(() => false);
}

async function scrapeTeamsCaptions(
  page: Page,
  meetingId: string,
  createdAt: Date,
): Promise<string> {
  let index = 0;
  let exitRequested = false;
  const segments: Segment[] = [];
  const seenFingerprints = new Set<string>();

  await page.exposeFunction(
    "onTeamsCaption",
    async (caption: { participant?: { name?: string }; text?: string }) => {
      const text = String(caption.text || "").replace(/\s+/g, " ").trim();
      if (!text || !/[.,!?]$/.test(text)) {
        return;
      }

      const speaker = String(caption.participant?.name || "Unknown Speaker").trim();
      const fingerprint = `${speaker}\n${text.replace(/[.,'"!~-]/g, "")}`;
      if (seenFingerprints.has(fingerprint)) {
        return;
      }
      seenFingerprints.add(fingerprint);

      const normalized = text.toLowerCase();
      const isExit = EXIT_PHRASES.some((phrase) => normalized.includes(phrase));
      if (isExit) {
        console.log("[teams] Exit phrase heard - hanging up");
        exitRequested = true;
      }

      const segment = {
        speaker,
        text,
        start: index,
        end: index + 1,
        meetingId,
      };
      index += 1;
      segments.push(segment);
      console.log(`[teams caption] ${speaker}: ${text}`);
      await saveTranscriptBatch(meetingId, createdAt, segments);
    },
  );

  await page.waitForSelector(TEAMS_CAPTIONS_CONTAINER_SEL, { timeout: 120_000 });

  await page.evaluate((captionsContainerSelector) => {
    const targetNode = document.querySelector(captionsContainerSelector);
    if (!targetNode) {
      return;
    }

    const observeCaptionMessage = (element: Element) => {
      const captionMessage =
        element.matches(".fui-ChatMessageCompact")
          ? element
          : element.querySelector(".fui-ChatMessageCompact");
      if (!captionMessage) {
        return;
      }

      const authorElement = captionMessage.querySelector('span[data-tid="author"]');
      const contentElement = captionMessage.querySelector('span[data-tid="closed-caption-text"]');
      if (!authorElement || !contentElement) {
        return;
      }

      const emit = () => {
        const name = authorElement.textContent?.trim() || "Unknown Speaker";
        const text = (contentElement as HTMLElement).innerText?.trim() || "";
        void (window as any).onTeamsCaption?.({
          participant: { name },
          text,
          started_at: {
            absolute_timestamp: new Date().toISOString(),
          },
        });
      };

      emit();
      new MutationObserver(emit).observe(contentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    };

    targetNode.querySelectorAll(".fui-ChatMessageCompact").forEach(observeCaptionMessage);

    new MutationObserver((mutationsList) => {
      for (const mutation of mutationsList) {
        if (mutation.type !== "childList") {
          continue;
        }
        mutation.addedNodes.forEach((node) => {
          if (node.nodeType === Node.ELEMENT_NODE) {
            observeCaptionMessage(node as Element);
          }
        });
      }
    }).observe(targetNode, { childList: true, subtree: true });
  }, TEAMS_CAPTIONS_CONTAINER_SEL);

  const flushTimer = setInterval(async () => {
    if (segments.length) {
      await saveTranscriptBatch(meetingId, createdAt, segments);
    }
  }, FLUSH_EVERY_MS);

  try {
    const deadline = Date.now() + 100 * 60 * 1000;
    while (Date.now() < deadline) {
      if (exitRequested) {
        await leaveTeamsMeeting(page);
        break;
      }

      if (await isTeamsMeetingEnded(page)) {
        break;
      }

      await page.waitForTimeout(1000);
    }

    if (Date.now() >= deadline) {
      throw new Error("Hard timeout (100 min) exceeded");
    }
  } finally {
    clearInterval(flushTimer);
  }

  await saveTranscriptBatch(meetingId, createdAt, segments, true);
  await notifyBackendDone(meetingId);
  console.log(`Teams meeting ${meetingId}: ${segments.length} segments captured`);
  return meetingId;
}

async function leaveTeamsMeeting(page: Page) {
  const leaveButton = page
    .locator('button[id="hangup-button"], button[aria-label*="Leave"]')
    .first();
  if (await leaveButton.isVisible({ timeout: 1000 }).catch(() => false)) {
    await clickLocator(leaveButton, "Teams leave button");
  }
}

async function isTeamsMeetingEnded(page: Page): Promise<boolean> {
  const text = (await getPageTextSnippet(page)).toLowerCase();
  return (
    text.includes("you left the meeting") ||
    text.includes("meeting has ended") ||
    text.includes("you've been removed") ||
    text.includes("you have been removed")
  );
}

async function notifyBackendDone(meetingId: string) {
  const jobId = process.env.JOB_ID;
  if (!jobId) {
    console.warn("Missing JOB_ID env var - backend completion will not run");
    return;
  }

  try {
    const res = await fetch(backendCallback("/bot-done"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId, meetingId }),
    });
    console.log(`[bot-done] ${res.status}`);
  } catch (err) {
    console.error("[bot-done] POST failed:", err);
  }
}

async function logGoogleAuthState(page: Page) {
  await page.goto("https://meet.google.com/", {
    waitUntil: "domcontentloaded",
  });
  await page.waitForTimeout(3000);

  const url = page.url();
  const bodyText = await getPageTextSnippet(page);
  const hostname = new URL(url).hostname;

  if (/accounts\.google\.com/.test(url)) {
    throw new Error(
      `Google auth is not complete; redirected to account chooser/sign-in (${url}). Regenerate auth.json and select the bot Google account before saving.`,
    );
  }

  if (hostname !== "meet.google.com") {
    throw new Error(
      `Google auth is not complete; expected meet.google.com but landed on ${url}. Regenerate auth.json and wait until the signed-in Google Meet home page loads before saving. Page text: ${bodyText}`,
    );
  }

  const signedInMeet = await page
    .locator(
      'a[aria-label*="Google Account"], button[aria-label*="Google Account"], [aria-label*="@"]',
    )
    .first()
    .isVisible({ timeout: 1500 })
    .catch(() => false);

  if (signedInMeet) {
    console.log(`[auth] Google Meet session appears usable (${url})`);
    return;
  }

  throw new Error(
    `Google auth is not complete; Meet loaded without a confirmed signed-in Google account (${url}). Regenerate auth.json and select the bot account before saving. Page text: ${bodyText}`,
  );
}

async function scrapeCaptions(
  page: Page,
  meetingId: string,
  createdAt: Date,
): Promise<string> {
  // index = caption timing, flushedCount = how many segments have been saved
  // exitRequested = exit condition, segments = finalized segments, activeSegments = ongoing segment for speaker
  let index = 0;
  let flushedCount = 0;
  let exitRequested = false;
  const segments: Segment[] = [];
  const activeSegmentsBySpeaker = new Map<string, Segment>();

  // filter system msgs
  const normalizeCaption = (text: string) => text.replace(/\s+/g, " ").trim();
  const isNotRealCaption = (text: string) => {
    const normalized = normalizeCaption(text).toLowerCase();
    if (!normalized) return true;

    return [
      "you left the meeting",
      "you've left the call",
      "you have left the call",
      "you've been removed",
      "you have been removed",
      "return to home screen",
      "how was the audio and video",
      "very bad",
      "very good",
      "feedback",
      "submit feedback",
      "your meeting is safe",
      "no one can join",
      "learn more",
      "leave call",
      "leave meeting",
      "call controls",
      "audio settings",
      "video settings",
      "more options",
      "developing an extension for meet",
      "extensions frequently cause user issues",
      "https://developers.google.com/meet/add-ons",
      "using this console may allow attackers",
      "do not enter or paste code",
      "turn on captions",
      "turn off captions",
    ].some((phrase) => normalized.includes(phrase));
  };

  const shouldUpdateSegment = (existing: Segment, caption: string) =>
    caption.startsWith(existing.text) ||
    existing.text.startsWith(caption) ||
    caption.includes(existing.text);

  // browser-side func to receive captions from injected observer
  await page.exposeFunction(
    "onCaption",
    async (speaker: string, text: string) => {
      const caption = normalizeCaption(text);
      if (isNotRealCaption(caption)) return;

      const normalized = caption.toLowerCase();
      const isExit = EXIT_PHRASES.some((p) => normalized.includes(p));
      if (isExit) {
        console.log("Exit phrase heard — hanging up");
        exitRequested = true;
      }

      console.log(`[caption] ${speaker}: ${caption}`);

      const existing = activeSegmentsBySpeaker.get(speaker);

      if (!existing || !shouldUpdateSegment(existing, caption)) {
        // first segment for speaker
        const seg = {
          speaker,
          text: caption,
          start: index,
          end: index + 1,
          meetingId,
        };
        activeSegmentsBySpeaker.set(speaker, seg);
        segments.push(seg);
      } else {
        // update existing segment if caption is growing
        if (caption.length >= existing.text.length) {
          existing.text = caption;
        }
        existing.end = index + 1;
      }

      index++;
      // if exit = triggered, flush curr captions
      if (isExit) {
        const finalSegments = segments.filter((seg) => !isNotRealCaption(seg.text));
        await saveTranscriptBatch(meetingId, createdAt, finalSegments, true);
      }
    },
  );

  // wait for captions to be initialized
  await page.waitForSelector('[role="region"][aria-label*="Captions"]');

  // inject observer into page to listen to DOM changes & send caption updates
  await page.evaluate(() => {
    const badgeSel = ".NWpY1d, .xoMHSc";
    let lastSpeaker = "Unknown Speaker";
    let lastSent = "";

    const captionRegionSel =
      '[role="region"][aria-label*="Captions" i], [aria-live][aria-label*="Captions" i]';

    const normalize = (text: string): string =>
      text.replace(/\s+/g, " ").trim();

    const isSystemText = (text: string): boolean => {
      const normalized = normalize(text).toLowerCase();
      if (!normalized) return true;

      return [
        "you left the meeting",
        "you've left the call",
        "you have left the call",
        "you've been removed",
        "you have been removed",
        "return to home screen",
        "how was the audio and video",
        "very bad",
        "very good",
        "feedback",
        "submit feedback",
        "your meeting is safe",
        "no one can join",
        "learn more",
        "leave call",
        "leave meeting",
        "call controls",
        "audio settings",
        "video settings",
        "more options",
        "developing an extension for meet",
        "extensions frequently cause user issues",
        "https://developers.google.com/meet/add-ons",
        "using this console may allow attackers",
        "do not enter or paste code",
        "turn on captions",
        "turn off captions",
      ].some((phrase) => normalized.includes(phrase));
    };

    const getCaptionRoot = (node: Node): HTMLElement | null => {
      const element =
        node instanceof HTMLElement ? node : node.parentElement ?? null;
      return element?.closest<HTMLElement>(captionRegionSel) ?? null;
    };

    const findSpeaker = (node: HTMLElement, root: HTMLElement): string => {
      let current: HTMLElement | null = node;
      while (current && current !== root) {
        const badge = current.matches(badgeSel)
          ? current
          : current.querySelector<HTMLElement>(badgeSel);
        const speaker = badge?.textContent?.trim();
        if (speaker) {
          lastSpeaker = speaker;
          return speaker;
        }
        current = current.parentElement;
      }

      const rootSpeaker = root.querySelector<HTMLElement>(badgeSel);
      const speaker = rootSpeaker?.textContent?.trim();
      if (speaker) {
        lastSpeaker = speaker;
        return speaker;
      }

      return lastSpeaker;
    };

    const closestUsefulCaptionNode = (
      node: HTMLElement,
      root: HTMLElement,
    ): HTMLElement => {
      let current: HTMLElement | null = node;
      let fallback = node;

      while (current && current !== root) {
        const text = normalize(current.textContent ?? "");
        if (text && !isSystemText(text)) {
          fallback = current;
          if (
            current.querySelector(badgeSel) ||
            current.parentElement === root ||
            text.length <= 500
          ) {
            return current;
          }
        }
        current = current.parentElement;
      }

      return fallback;
    };

    // extract speaker
    const getSpeaker = (node: HTMLElement, root: HTMLElement): string => {
      const badge = node.querySelector<HTMLElement>(badgeSel);
      const speaker = badge?.textContent?.trim();
      if (speaker) {
        lastSpeaker = speaker;
        return speaker;
      }
      return findSpeaker(node, root);
    };

    // extract caption
    const getText = (node: HTMLElement): string => {
      const clone = node.cloneNode(true) as HTMLElement;
      clone
        .querySelectorAll<HTMLElement>(badgeSel)
        .forEach((el) => el.remove());
      return normalize(clone.textContent ?? "");
    };

    // send caption to exposed onCaption()
    const send = (node: Node): void => {
      const root = getCaptionRoot(node);
      const element =
        node instanceof HTMLElement ? node : node.parentElement ?? null;
      if (!root || !element) return;

      const captionNode = closestUsefulCaptionNode(element, root);
      const txt = getText(captionNode);
      const spk = getSpeaker(captionNode, root);
      const fingerprint = `${spk}\n${txt}`;

      if (
        txt &&
        txt.toLowerCase() !== spk.toLowerCase() &&
        !isSystemText(txt) &&
        fingerprint !== lastSent
      ) {
        lastSent = fingerprint;
        // @ts-expect-error
        window.onCaption?.(spk, txt);
      }
    };

    // watch DOm for caption updates and run send()
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        // new caption elements
        Array.from(m.addedNodes).forEach((n) => {
          if (n instanceof HTMLElement) send(n);
        });
        // live text edits inside an existing element
        if (
          m.type === "characterData" &&
          m.target?.parentElement instanceof HTMLElement
        ) {
          send(m.target);
        }
      }
    }).observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  });

  // flush segments to backend
  const flushTimer = setInterval(async () => {
    const segmentsToFlush = segments.filter(
      (seg) => !isNotRealCaption(seg.text),
    );
    if (segmentsToFlush.length) {
      await saveTranscriptBatch(meetingId, createdAt, segmentsToFlush);
    }
  }, FLUSH_EVERY_MS);

  // leave call and final flush
  const leaveCall = async () => {
    const hangUpSel =
      'button[aria-label*="Leave call"], button[aria-label*="Leave meeting"]';
    if (await page.$(hangUpSel)) {
      await clickIfVisible(page, hangUpSel);
    } else {
      await page.keyboard.press("Ctrl+Alt+Q");
    }
    await page
      .waitForSelector(LEAVE_BANNER_SEL, { timeout: 10_000 })
      .catch(() => undefined);
    await saveTranscriptBatch(
      meetingId,
      createdAt,
      segments
        .slice(flushedCount)
        .filter((seg) => !isNotRealCaption(seg.text)),
    )
      .then(() => {
        flushedCount = segments.length;
      })
      .catch((err) => console.error("[FLUSH-after-leave] failed", err));
  };

  // exit conditions (exit phrase, leave banner, hard timeout)
  await Promise.race([
    (async () => {
      while (!exitRequested) await new Promise((r) => setTimeout(r, 500));
      await leaveCall();
    })(),
    page.waitForSelector(LEAVE_BANNER_SEL, { timeout: 0 }),
    waitForGoogleMeetEndedText(page),
    new Promise((_, rej) =>
      setTimeout(
        () => rej(new Error("Hard timeout (100 min) exceeded")),
        100 * 60 * 1000,
      ),
    ),
  ]);

  // final flush and cleanup
  clearInterval(flushTimer);
  const finalSegments = segments.filter((seg) => !isNotRealCaption(seg.text));

  await saveTranscriptBatch(meetingId, createdAt, finalSegments, true);

  await notifyBackendDone(meetingId);
  console.log(`Meeting ${meetingId}: ${segments.length} segments captured`);
  return meetingId;
}

async function waitForGoogleMeetEndedText(page: Page) {
  while (true) {
    const pageText = await getPageTextSnippet(page);
    const buttons = await getVisibleButtonLabels(page);
    if (
      MEET_ENDED_TEXT.test(pageText) ||
      buttons.some((button) => MEET_ENDED_TEXT.test(button))
    ) {
      console.log(`[meet] detected meeting end/removal state: ${pageText}`);
      return;
    }

    await page.waitForTimeout(1000);
  }
}

// click visible element by selector, true if successful
async function clickIfVisible(page: Page, selector: string, timeout = 5000) {
  try {
    const elem = page.locator(selector);
    await elem.waitFor({ state: "visible", timeout });
    await clickLocator(elem, selector);
    return true;
  } catch {
    return false;
  }
}

function formatClickError(err: unknown) {
  return err instanceof Error ? err.message.split("\n")[0] : String(err);
}

async function clickLocator(locator: Locator, label: string, timeout = 3000) {
  try {
    await locator.click({ timeout });
  } catch (err) {
    console.warn(
      `Normal click failed for ${label}; trying DOM click: ${formatClickError(
        err,
      )}`,
    );
    await locator.evaluate((el) => (el as HTMLElement).click());
  }
}

async function clickButtonText(page: Page, text: string, timeout = 3000) {
  const btn = page.locator(`button:has-text("${text}")`).first();
  try {
    await btn.waitFor({ state: "visible", timeout });
    await clickLocator(btn, `button "${text}"`);
    return true;
  } catch (err) {
    console.log(`Skipped "${text}" - ${formatClickError(err)}`);
    return false;
  }
}

async function getVisibleButtonLabels(page: Page): Promise<string[]> {
  return (
    await page.locator("button:visible").allTextContents().catch(() => [])
  ).map((label) => label.replace(/\s+/g, " ").trim());
}

async function getPageTextSnippet(page: Page): Promise<string> {
  const text = await page
    .locator("body")
    .innerText({ timeout: 1000 })
    .catch(() => "");
  return text.replace(/\s+/g, " ").trim().slice(0, 600);
}

async function throwIfUnjoinableMeetPage(page: Page, context: string) {
  const labels = await getVisibleButtonLabels(page);
  const hasTerminalActions = labels.some((label) =>
    /return to home screen|submit feedback/i.test(label),
  );
  const hasJoinAction = labels.some((label) =>
    /ask to join|join now|join meeting|join call/i.test(label),
  );

  if (!hasTerminalActions || hasJoinAction) return;

  const pageText = await getPageTextSnippet(page);
  throw new Error(
    `Google Meet is not showing a joinable lobby ${context}. Visible buttons: ${JSON.stringify(
      labels,
    )}. Page text: ${pageText}`,
  );
}

async function clearBlockingDialogs(page: Page) {
  const buttonTexts = [
    "Continue without microphone and camera",
    "Got it",
    "Dismiss",
  ];

  for (const text of buttonTexts) {
    if (await clickButtonText(page, text, 1000)) {
      await page.waitForTimeout(500);
    }
  }

  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(300);
}

// join mtg by clicking "Join" button/fallbacks
async function clickJoin(page: Page): Promise<void> {
  const allButtons = await getVisibleButtonLabels(page);
  console.log("Visible buttons on screen:", allButtons);
  await throwIfUnjoinableMeetPage(page, "before attempting to join");

  if (await clickButtonText(page, "Continue without microphone and camera")) {
    console.log('Clicked: "Continue without microphone and camera"');
    await page.waitForTimeout(1000);
  } else {
    console.log('"Continue without microphone and camera" not shown');
  }

  await clearBlockingDialogs(page);
  await throwIfUnjoinableMeetPage(page, "after clearing pre-join dialogs");

  // try related possibilites for joining
  const possibleTexts = [
    "Join now",
    "Ask to join",
    "Join meeting",
    "Join call",
    "Join",
    "Done",
    "Continue to join",
    "Start meeting",
  ];

  for (const text of possibleTexts) {
    if (await clickButtonText(page, text)) {
      console.log(`Clicked join button: "${text}"`);
      return;
    }
  }

  // fallback to any button with "join" in it
  const fallbackButtons = page.locator("button");
  const count = await fallbackButtons.count();
  for (let i = 0; i < count; i++) {
    const btn = fallbackButtons.nth(i);
    const label = (await btn.textContent())?.trim();
    if (label && /join/i.test(label)) {
      try {
        await clickLocator(btn, `fallback button "${label}"`);
        console.log(`Fallback: clicked button with text "${label}"`);
        return;
      } catch {}
    }
  }

  await throwIfUnjoinableMeetPage(page, "after checking all join buttons");

  // last effort = press Enter
  console.warn("No join button found — pressing Enter as fallback");
  await page.keyboard.press("Enter");
}

// waits until bot is in the call/added to the call
async function waitUntilJoined(page: Page, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const inCall =
      (await page
        .locator('button[aria-label*="Leave call"]')
        .isVisible({ timeout: 500 })
        .catch(() => false)) ||
      (await page
        .locator("text=You've been admitted")
        .isVisible({ timeout: 500 })
        .catch(() => false)) ||
      (await page
        .locator("text=You’re the only one here")
        .isVisible({ timeout: 500 })
        .catch(() => false));

    if (inCall) return;

    await throwIfUnjoinableMeetPage(page, "while waiting for admission");
    await page.waitForTimeout(1000);
  }

  const pageText = await getPageTextSnippet(page);
  throw new Error(
    `Not admitted within time limit. Last visible page text: ${pageText}`,
  );
}

// sometimes there is a preview, handle preview here
async function collapsePreviewIfNeeded(page: Page) {
  const previewJoin = page.getByRole("button", { name: /join now/i }).nth(1);
  if (await previewJoin.isVisible({ timeout: 3000 })) {
    await clickLocator(previewJoin, "2-step Join");
    console.log("clicked 2-step Join");
  }
}

// dismiss modals like "Continue" using click/escape
async function dismissOverlays(page: Page) {
  const selectors = [
    'button:has-text("Got it")',
    'button:has-text("Dismiss")',
    'button:has-text("Continue")',
  ];
  for (const sel of selectors) {
    await clickIfVisible(page, sel, 1_000);
  }

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
}

// returns true if captions region is present and visible
async function captionsRegionVisible(page: Page, t = 4000): Promise<boolean> {
  const region = page.locator('[role="region"][aria-label*="Captions"]');
  try {
    await region.waitFor({ timeout: t });

    if (await region.isVisible().catch(() => false)) return true;

    console.warn("Captions region found but not visibly rendered yet");
    return true;
  } catch {
    return false;
  }
}

// make sure captions are enabled
async function ensureCaptionsOn(page: Page, timeoutMs = 60_000) {
  console.log(" Waiting for UI to stabilize after join...");
  await page.waitForTimeout(5000);
  await dismissOverlays(page);
  await page.mouse.click(20, 20).catch(() => undefined);

  // close overlays if blocking interaction
  const overlay = page.locator('div[data-disable-esc-to-close="true"]');
  for (let i = 0; i < 8; i++) {
    if (!(await overlay.isVisible().catch(() => false))) break;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
  }

  // keyboard shortcut with limited attempts
  for (let i = 0; i < 10; i++) {
    console.log(`Attempt ${i + 1}: Pressing Shift+C`);
    await page.keyboard.down("Shift");
    await page.keyboard.press("c");
    await page.keyboard.up("Shift");

    if (await captionsRegionVisible(page, 800)) {
      console.log("Captions enabled via Shift+C");
      return;
    }

    // are captions already on
    const ccOffBtn = page.locator('button[aria-label*="Turn off captions"]');
    if (await ccOffBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log("Captions are already ON (confirmed by CC button state)");
      return;
    }

    await page.waitForTimeout(600);
  }

  // fallback, click "Turn on captions" button
  console.log(' Falling back to clicking "Turn on captions" button...');
  await page.mouse.move(500, 700);
  await page.waitForTimeout(300);

  const ccButton = page.locator('button[aria-label*="Turn on captions"]');
  try {
    await ccButton.waitFor({ state: "visible", timeout: 4000 });
    await clickLocator(ccButton, "Turn on captions button");
    if (await captionsRegionVisible(page, 5000)) {
      console.log("captions enabled via CC button fallback");
      return;
    }
  } catch {
    console.warn("CC button fallback failed");
  }

  console.log(' Falling back to "More options" captions menu...');
  if (await enableCaptionsFromMoreOptions(page)) {
    if (await captionsRegionVisible(page, 5000)) {
      console.log("captions enabled via More options menu");
      return;
    }
  }

  // debug info if captions aren't on
  const visibleRegions = await page
    .locator('[role="region"]')
    .allTextContents();
  console.log("visible regions:", visibleRegions);

  const regions = await page.locator('[role="region"]').elementHandles();
  for (const r of regions) {
    const label = await r.getAttribute("aria-label");
    console.log("Region aria-label:", label);
  }

  throw new Error("could not enable captions using Shift+C or button");
}

async function enableCaptionsFromMoreOptions(page: Page): Promise<boolean> {
  const moreOptionsLocators = [
    page.locator('button[aria-label*="More options"]').first(),
    page.locator('button:has-text("More options")').first(),
    page.locator('button:has-text("more_vert")').first(),
  ];

  for (const moreOptions of moreOptionsLocators) {
    try {
      await moreOptions.waitFor({ state: "visible", timeout: 1500 });
      await clickLocator(moreOptions, "More options");
      await page.waitForTimeout(800);
      break;
    } catch {}
  }

  const captionsLocators = [
    page.getByRole("menuitem", { name: /turn on captions|captions/i }).first(),
    page
      .locator(
        '[role="menuitem"]:has-text("Turn on captions"), [role="menuitem"]:has-text("Captions")',
      )
      .first(),
    page.getByText(/turn on captions|captions/i).first(),
  ];

  for (const captions of captionsLocators) {
    try {
      await captions.waitFor({ state: "visible", timeout: 3000 });
      await clickLocator(captions, "captions menu item");
      return true;
    } catch {}
  }

  return false;
}
