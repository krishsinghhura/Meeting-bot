// src/backend/botLauncher.ts
import Docker from "dockerode";
import {
  getBackendCallbackUrl,
  getBotDatabaseUrl,
  getBotNetwork,
} from "./env";

// init Docker client
const docker = new Docker();

// launch Docker container to run mtg bot
export async function launchBotContainer(meetingUrl: string, jobId: string) {
  // assign container a unique name using timestamp
  const containerName = `meetingbot-${Date.now()}`;

  const env = [
    `MEETING_URL=${meetingUrl}`,
    `JOB_ID=${jobId}`,
    `GOOGLE_ACCOUNT_USER=${process.env.GOOGLE_ACCOUNT_USER ?? ""}`,
    `GOOGLE_ACCOUNT_PASSWORD=${process.env.GOOGLE_ACCOUNT_PASSWORD ?? ""}`,
    `DATABASE_URL=${getBotDatabaseUrl()}`,
    `BACKEND_CALLBACK_URL=${getBackendCallbackUrl()}`,
  ];
  const binds: string[] = [];
  if (process.env.AUTH_STATE_HOST_PATH) {
    env.push("AUTH_STATE_PATH=/app/auth.json");
    binds.push(`${process.env.AUTH_STATE_HOST_PATH}:/app/auth.json:ro`);
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
  return containerName;
}
