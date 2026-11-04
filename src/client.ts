import type { UsageAccount, UsageCredentials, UsageSnapshot, UsageWindow } from "./types.ts";

export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
// The endpoint normally returns a few KiB. Bound decoded bytes, not Content-Length
// (which may be absent, incorrect, or refer to a compressed representation).
export const MAX_USAGE_RESPONSE_BYTES = 1024 * 1024;

export function formatWindowDuration(seconds: number): { id: string; label: string } {
  if (seconds === 18000) {
    return { id: "5h", label: "5h" };
  }
  if (seconds === 604800) {
    return { id: "weekly", label: "Wk" };
  }
  // Unknown durations label accurately e.g. 3h not 5h
  if (seconds % 86400 === 0) {
    const days = seconds / 86400;
    return { id: `${days}d`, label: `${days}d` };
  }
  if (seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return { id: `${hours}h`, label: `${hours}h` };
  }
  if (seconds % 60 === 0) {
    const mins = seconds / 60;
    return { id: `${mins}m`, label: `${mins}m` };
  }
  return { id: `${seconds}s`, label: `${seconds}s` };
}

function parseWindow(
  raw: unknown,
  defaultDurationSeconds: number,
  nowMs: number
): UsageWindow | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;

  // Numeric finite percentages only, clamp 0..100
  if (typeof obj.used_percent !== "number" || !Number.isFinite(obj.used_percent)) {
    return undefined;
  }
  const usedPercent = Math.min(100, Math.max(0, obj.used_percent));
  const remainingPercent = Math.min(100, Math.max(0, 100 - usedPercent));

  // Positional duration defaults only when missing
  let duration = defaultDurationSeconds;
  if (typeof obj.limit_window_seconds === "number" && Number.isFinite(obj.limit_window_seconds)) {
    if (obj.limit_window_seconds > 0) {
      duration = obj.limit_window_seconds;
    } else {
      // duration <= 0 is invalid
      return undefined;
    }
  } else if (obj.limit_window_seconds !== undefined && obj.limit_window_seconds !== null) {
    return undefined;
  }

  const { id, label } = formatWindowDuration(duration);

  // reset_at seconds to ms preferred then reset_after_seconds (including 0)
  let resetsAt: number | undefined;
  if (typeof obj.reset_at === "number" && Number.isFinite(obj.reset_at) && obj.reset_at > 0) {
    resetsAt = obj.reset_at < 1e11 ? Math.round(obj.reset_at * 1000) : Math.round(obj.reset_at);
  } else if (
    typeof obj.reset_after_seconds === "number" &&
    Number.isFinite(obj.reset_after_seconds) &&
    obj.reset_after_seconds >= 0
  ) {
    resetsAt = nowMs + Math.round(obj.reset_after_seconds * 1000);
  }
  if (resetsAt !== undefined && !Number.isFinite(new Date(resetsAt).getTime())) resetsAt = undefined;

  return {
    id,
    label,
    usedPercent,
    remainingPercent,
    windowSeconds: duration,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  };
}

export function parseUsageResponse(
  data: unknown,
  account: UsageAccount,
  now?: number
): UsageSnapshot {
  const nowMs = typeof now === "number" && Number.isFinite(now) ? now : Date.now();

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Invalid usage response: payload must be a JSON object");
  }

  const root = data as Record<string, unknown>;
  const rateLimit = root.rate_limit;
  if (!rateLimit || typeof rateLimit !== "object" || Array.isArray(rateLimit)) {
    throw new Error("Invalid usage response: missing rate_limit data");
  }

  const rl = rateLimit as Record<string, unknown>;

  // Parse rate_limit.primary_window / secondary_window only GPT capacity, omit absent/malformed rows not fake 100%.
  // Positional duration defaults only when missing: 18000 for primary, 604800 for secondary.
  const primary = parseWindow(rl.primary_window, 18000, nowMs);
  const secondary = parseWindow(rl.secondary_window, 604800, nowMs);

  const windows: UsageWindow[] = [];
  if (primary) windows.push(primary);
  if (secondary) windows.push(secondary);

  // window duration >0 finite, throw if response no usable windows
  if (windows.length === 0) {
    throw new Error("No usable usage windows found in response");
  }

  // sort 5h before weekly regardless positions
  windows.sort((a, b) => {
    if (a.id === "5h" && b.id !== "5h") return -1;
    if (b.id === "5h" && a.id !== "5h") return 1;
    if (a.id === "weekly" && b.id !== "weekly") return 1;
    if (b.id === "weekly" && a.id !== "weekly") return -1;
    return a.windowSeconds - b.windowSeconds;
  });

  // plan_type optional sanitized string no controls
  let plan: string | undefined;
  if (typeof root.plan_type === "string") {
    const sanitized = root.plan_type.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").trim();
    if (sanitized.length > 0) {
      plan = sanitized;
    }
  }

  const limitReached = Boolean(rl.limit_reached === true);

  return {
    account,
    ...(plan ? { plan } : {}),
    windows,
    fetchedAt: nowMs,
    limitReached,
  };
}

function withAbort<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const aborted = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener("abort", aborted);
    signal.addEventListener("abort", aborted, { once: true });
    try {
      void operation().then(
        (value) => { cleanup(); resolve(value); },
        (error) => { cleanup(); reject(error); },
      );
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

function cancelBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {});
  } catch { /* Best-effort cleanup; never expose upstream errors. */ }
}

class ResponseTooLargeError extends Error {}

async function readUsageJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!response.body) throw new Error("Missing response body");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_USAGE_RESPONSE_BYTES);
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await withAbort(() => reader.read(), signal);
      signal.throwIfAborted();
      if (done) { complete = true; break; }
      if (value.byteLength > MAX_USAGE_RESPONSE_BYTES - size) throw new ResponseTooLargeError();
      bytes.set(value, size);
      size += value.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes.subarray(0, size)));
  } finally {
    if (!complete) {
      // Cancellation can itself stall. Do not await it or retain the reader lock.
      try { void reader.cancel().catch(() => {}); } catch { /* Best effort. */ }
    }
    reader.releaseLock();
  }
}

export async function fetchUsage(
  credentials: UsageCredentials,
  options?: {
    signal?: AbortSignal;
    fetch?: typeof globalThis.fetch;
    now?: () => number;
    timeoutMs?: number;
  }
): Promise<UsageSnapshot> {
  const fetchFn = options?.fetch ?? globalThis.fetch;
  const timeoutMs = options?.timeoutMs ?? 15_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Invalid OpenAI usage request timeout");
  }
  if (!credentials?.accessToken) {
    throw new Error("Missing access token for OpenAI usage request");
  }
  if (options?.signal?.aborted) {
    throw new Error("OpenAI usage request was aborted");
  }

  const controller = new AbortController();
  const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let receivedResponse: Response | undefined;
  const failure = (fallback: string): Error => new Error(
    timedOut ? `OpenAI usage request timed out after ${timeoutMs}ms`
      : options?.signal?.aborted ? "OpenAI usage request was aborted" : fallback,
  );

  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credentials.accessToken}`,
      Accept: "application/json",
      "User-Agent": "pi-openai-usage",
    };
    if (credentials.account.accountId) headers["ChatGPT-Account-Id"] = credentials.account.accountId;

    let response: Response;
    try {
      response = await withAbort(async () => {
        const result = await fetchFn(USAGE_URL, {
          method: "GET", headers, redirect: "error", signal,
        });
        receivedResponse = result;
        // A non-cooperative transport can resolve after our caller has left.
        if (signal.aborted) cancelBody(result);
        return result;
      }, signal);
      signal.throwIfAborted();
    } catch {
      // Fetch/header validation errors can contain secret header values. Never echo them.
      throw failure("OpenAI usage network request failed");
    }

    if (!response.ok) {
      // Do not wait on a possibly stalled error body or expose its contents.
      cancelBody(response);
      if (response.status === 401 || response.status === 403) {
        throw new Error(`OpenAI usage request failed (HTTP ${response.status}): Authentication failed or insufficient permissions. Sign in with /login openai-codex or /login openai.`);
      }
      if (response.status === 429) {
        throw new Error("OpenAI usage request failed (HTTP 429): Rate limit exceeded. Please try again later.");
      }
      throw new Error(`OpenAI usage request failed with HTTP ${response.status}`);
    }

    let data: unknown;
    try {
      data = await readUsageJson(response, signal);
    } catch (error) {
      throw failure(error instanceof ResponseTooLargeError
        ? `OpenAI usage response exceeds ${MAX_USAGE_RESPONSE_BYTES} byte limit`
        : "OpenAI usage request failed: Invalid JSON response");
    }
    return parseUsageResponse(data, credentials.account, (options?.now ?? Date.now)());
  } finally {
    clearTimeout(timer);
    // Stop the underlying transport too, including on body-size/parse failures.
    controller.abort();
    // Also cover aborts between fetch resolution and the awaiting continuation.
    // Completed bodies are unlocked/closed, so cancellation is harmless there.
    if (receivedResponse) cancelBody(receivedResponse);
  }
}
