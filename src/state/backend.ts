import { spawnSync } from "node:child_process";

export type StateBackendMode = "sqlite" | "remote";

type StateBackendConfig =
  | { mode: "sqlite" }
  | {
      mode: "remote";
      url: string;
      token: string;
      timeoutMs: number;
    };

let backendConfig: StateBackendConfig = { mode: "sqlite" };

export function configureSqliteStateBackend(): void {
  backendConfig = { mode: "sqlite" };
}

export function configureRemoteStateBackend(params: {
  url: string;
  token: string;
  timeoutMs?: number;
}): void {
  const url = params.url.trim().replace(/\/+$/, "");
  const token = params.token.trim();
  if (!url) {
    throw new Error("STATE_BACKEND=remote requires MAVERICK_STATE_URL.");
  }
  if (!token) {
    throw new Error("STATE_BACKEND=remote requires MAVERICK_STATE_TOKEN.");
  }

  backendConfig = {
    mode: "remote",
    url,
    token,
    timeoutMs: params.timeoutMs ?? 30_000,
  };
}

export function configureStateBackendFromEnv(): StateBackendMode {
  const role = process.env.MAVERICK_ROLE?.trim().toLowerCase();
  const defaultMode = role === "client" ? "remote" : "sqlite";
  const mode = (process.env.STATE_BACKEND ?? defaultMode).trim().toLowerCase();
  if (mode === "remote") {
    configureRemoteStateBackend({
      url: process.env.MAVERICK_STATE_URL ?? "",
      token: process.env.MAVERICK_STATE_TOKEN ?? "",
      timeoutMs: parsePositiveInt(process.env.MAVERICK_STATE_TIMEOUT_MS) ?? 30_000,
    });
    return "remote";
  }

  if (mode !== "sqlite") {
    throw new Error(`Unsupported STATE_BACKEND "${mode}". Expected "sqlite" or "remote".`);
  }

  configureSqliteStateBackend();
  return "sqlite";
}

export function getStateBackendMode(): StateBackendMode {
  return backendConfig.mode;
}

export function invokeRemoteStateOperation<T>(
  repository: string,
  method: string,
  args: unknown[],
): T {
  if (backendConfig.mode !== "remote") {
    throw new Error("Remote state backend is not configured.");
  }

  const accessClientId = process.env.CLOUDFLARE_ACCESS_CLIENT_ID?.trim();
  const accessClientSecret = process.env.CLOUDFLARE_ACCESS_CLIENT_SECRET?.trim();
  const extraHeaders: Record<string, string> = {};
  if (accessClientId && accessClientSecret) {
    extraHeaders["CF-Access-Client-Id"] = accessClientId;
    extraHeaders["CF-Access-Client-Secret"] = accessClientSecret;
  }

  const request = {
    url: `${backendConfig.url}/internal/state/operation`,
    token: backendConfig.token,
    extraHeaders,
    repository,
    method,
    args,
  };

  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
let raw = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) raw += chunk;
const request = JSON.parse(raw);
const headers = Object.assign(
  {
    "content-type": "application/json",
    "authorization": "Bearer " + request.token,
  },
  request.extraHeaders && typeof request.extraHeaders === "object" ? request.extraHeaders : {},
);
const response = await fetch(request.url, {
  method: "POST",
  headers,
  body: JSON.stringify({
    repository: request.repository,
    method: request.method,
    args: request.args,
  }),
});
const text = await response.text();
if (!response.ok) {
  console.error(text);
  process.exit(2);
}
process.stdout.write(text);
`,
    ],
    {
      input: JSON.stringify(request),
      encoding: "utf8",
      timeout: backendConfig.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
    },
  );

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.status}`;
    throw new Error(`Remote Maverick state operation failed (${repository}.${method}): ${detail}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout) as unknown;
  } catch (error) {
    throw new Error(
      `Remote Maverick state operation returned invalid JSON (${repository}.${method}): ${String(error)}`
    );
  }

  if (!isObject(payload) || payload.ok !== true) {
    const message =
      isObject(payload) && typeof payload.error === "string"
        ? payload.error
        : `Unexpected response from remote state operation ${repository}.${method}.`;
    throw new Error(message);
  }

  return payload.result as T;
}

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
