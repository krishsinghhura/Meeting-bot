import "./loadEnv";

const DEFAULT_CALLBACK_URL = "http://host.docker.internal:3001";

export function getRequiredEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function describeDatabaseUrl(value = process.env.DATABASE_URL) {
  if (!value) return "unset";

  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ""}${url.pathname}`;
  } catch {
    return "set but invalid URL";
  }
}

export function getBotDatabaseUrl() {
  return process.env.BOT_DATABASE_URL || getRequiredEnv("DATABASE_URL");
}

export function getBackendCallbackUrl() {
  return (process.env.BACKEND_CALLBACK_URL || DEFAULT_CALLBACK_URL).replace(
    /\/+$/,
    "",
  );
}

export function getBotNetwork() {
  return process.env.BOT_NETWORK;
}
