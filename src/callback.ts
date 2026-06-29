const DEFAULT_BACKEND_CALLBACK_URL = "http://host.docker.internal:3001";

export function getBackendCallbackUrl() {
  return (
    process.env.BACKEND_CALLBACK_URL || DEFAULT_BACKEND_CALLBACK_URL
  ).replace(/\/+$/, "");
}

export function backendCallback(path: string) {
  return `${getBackendCallbackUrl()}${path.startsWith("/") ? path : `/${path}`}`;
}
