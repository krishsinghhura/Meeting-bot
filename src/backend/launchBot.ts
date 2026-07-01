// src/backend/botLauncher.ts
import Docker from "dockerode";
import {
  getAuthStateHostPath,
  getBackendCallbackUrl,
  getBotDatabaseUrl,
  getBotNetwork,
  getTeamsAuthStateHostPath,
} from "./env";

// init Docker client
const docker = new Docker();

type MeetingProvider = "google_meet" | "microsoft_teams";

// launch Docker container to run mtg bot
export async function launchBotContainer(
  meetingUrl: string,
  jobId: string,
  provider: MeetingProvider,
) {
  // assign container a unique name using timestamp
  const containerName = `meetingbot-${Date.now()}`;
  const authStateHostPath =
    provider === "google_meet" ? getAuthStateHostPath() : getTeamsAuthStateHostPath();
  const authStateContainerPath =
    provider === "google_meet" ? "/app/auth.json" : "/app/teams-auth.json";

  const env = [
    `MEETING_URL=${meetingUrl}`,
    `JOB_ID=${jobId}`,
    `MEETING_PROVIDER=${provider}`,
    `GOOGLE_ACCOUNT_USER=${process.env.GOOGLE_ACCOUNT_USER ?? ""}`,
    `GOOGLE_ACCOUNT_PASSWORD=${process.env.GOOGLE_ACCOUNT_PASSWORD ?? ""}`,
    `DATABASE_URL=${getBotDatabaseUrl()}`,
    `BACKEND_CALLBACK_URL=${getBackendCallbackUrl()}`,
  ];
  const binds: string[] = [];
  if (authStateHostPath) {
    env.push(
      provider === "google_meet"
        ? `AUTH_STATE_PATH=${authStateContainerPath}`
        : `TEAMS_AUTH_STATE_PATH=${authStateContainerPath}`,
    );
    binds.push(`${authStateHostPath}:${authStateContainerPath}:ro`);
  }
  const botNetwork = getBotNetwork();

  // create Docker container with bot image to run, env vars, run cmd
  const container = await docker.createContainer({
    Image: "meetingbot-bot",
    Env: env,
    Cmd: ["node", "dist/bot/index.js"],
    HostConfig: {
      // comment out autoremove for debugging, otherwise cleans after exit
      AutoRemove: true,
      Binds: binds,
      ...(botNetwork ? { NetworkMode: botNetwork } : {}),
    },
  });

  await container.start();
  // attach to container logs and stream to curr process output
  const stream = await container.logs({
    follow: true,
    stdout: true,
    stderr: true,
  });
  docker.modem.demuxStream(stream, process.stdout, process.stderr);

  console.log(`Started bot container: ${containerName}`);
  if (authStateHostPath) {
    console.log(
      `[auth] Mounted Playwright storage state from ${authStateHostPath} (read-only)`,
    );
  } else if (provider === "google_meet") {
    console.warn("[auth] No auth.json found or AUTH_STATE_HOST_PATH configured; bot will run without signed-in storage state");
  } else {
    console.warn("[auth] No teams-auth.json found or TEAMS_AUTH_STATE_HOST_PATH configured; Teams bot will run as guest");
  }

  return {
    containerName,
    authStateHostPath,
    authStateMounted: Boolean(authStateHostPath),
  };
}
