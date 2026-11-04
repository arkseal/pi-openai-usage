import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  USAGE_URL,
  MAX_USAGE_RESPONSE_BYTES,
  formatWindowDuration,
  parseUsageResponse,
  fetchUsage,
} from "../src/client.ts";
import type { UsageAccount, UsageCredentials } from "../src/types.ts";

describe("formatWindowDuration", () => {
  it("formats standard durations correctly", () => {
    assert.deepEqual(formatWindowDuration(18000), { id: "5h", label: "5h" });
    assert.deepEqual(formatWindowDuration(604800), { id: "weekly", label: "Wk" });
  });

  it("formats non-standard durations accurately without defaulting to 5h", () => {
    assert.deepEqual(formatWindowDuration(10800), { id: "3h", label: "3h" });
    assert.deepEqual(formatWindowDuration(7200), { id: "2h", label: "2h" });
    assert.deepEqual(formatWindowDuration(1800), { id: "30m", label: "30m" });
    assert.deepEqual(formatWindowDuration(86400), { id: "1d", label: "1d" });
    assert.deepEqual(formatWindowDuration(45), { id: "45s", label: "45s" });
  });
});

describe("parseUsageResponse", () => {
  const account: UsageAccount = {
    provider: "openai-codex",
    accountId: "test-account-id",
    email: "user@example.com",
  };
  const fixedNow = 1_700_000_000_000;

  it("parses standard response with 5h and weekly windows", () => {
    const raw = {
      plan_type: "pro",
      rate_limit: {
        limit_reached: false,
        primary_window: {
          used_percent: 25.5,
          limit_window_seconds: 18000,
          reset_at: 1700003600,
        },
        secondary_window: {
          used_percent: 80,
          limit_window_seconds: 604800,
          reset_at: 1700604800,
        },
      },
    };

    const snapshot = parseUsageResponse(raw, account, fixedNow);

    assert.equal(snapshot.plan, "pro");
    assert.equal(snapshot.limitReached, false);
    assert.equal(snapshot.fetchedAt, fixedNow);
    assert.deepEqual(snapshot.account, account);
    assert.equal(snapshot.windows.length, 2);

    const [w5h, wWk] = snapshot.windows;
    assert.equal(w5h.id, "5h");
    assert.equal(w5h.label, "5h");
    assert.equal(w5h.usedPercent, 25.5);
    assert.equal(w5h.remainingPercent, 74.5);
    assert.equal(w5h.windowSeconds, 18000);
    assert.equal(w5h.resetsAt, 1700003600 * 1000);

    assert.equal(wWk.id, "weekly");
    assert.equal(wWk.label, "Wk");
    assert.equal(wWk.usedPercent, 80);
    assert.equal(wWk.remainingPercent, 20);
    assert.equal(wWk.windowSeconds, 604800);
    assert.equal(wWk.resetsAt, 1700604800 * 1000);
  });

  it("applies positional duration defaults when limit_window_seconds is missing", () => {
    const raw = {
      rate_limit: {
        primary_window: { used_percent: 10 },
        secondary_window: { used_percent: 20 },
      },
    };

    const snapshot = parseUsageResponse(raw, account, fixedNow);
    assert.equal(snapshot.windows.length, 2);
    assert.equal(snapshot.windows[0].id, "5h");
    assert.equal(snapshot.windows[0].windowSeconds, 18000);
    assert.equal(snapshot.windows[1].id, "weekly");
    assert.equal(snapshot.windows[1].windowSeconds, 604800);
  });

  it("sorts 5h before weekly regardless of response positions (swapped weekly primary)", () => {
    const raw = {
      rate_limit: {
        // primary_window is weekly, secondary_window is 5h
        primary_window: {
          used_percent: 50,
          limit_window_seconds: 604800,
        },
        secondary_window: {
          used_percent: 10,
          limit_window_seconds: 18000,
        },
      },
    };

    const snapshot = parseUsageResponse(raw, account, fixedNow);
    assert.equal(snapshot.windows.length, 2);
    assert.equal(snapshot.windows[0].id, "5h");
    assert.equal(snapshot.windows[1].id, "weekly");
  });

  it("omits absent secondary window without creating a fake 0% or 100% window", () => {
    const raw = {
      rate_limit: {
        primary_window: {
          used_percent: 30,
          limit_window_seconds: 18000,
        },
      },
    };

    const snapshot = parseUsageResponse(raw, account, fixedNow);
    assert.equal(snapshot.windows.length, 1);
    assert.equal(snapshot.windows[0].id, "5h");
  });

  it("clamps percentages to 0..100 and computes remainingPercent", () => {
    const raw = {
      rate_limit: {
        primary_window: {
          used_percent: -15, // should clamp to 0
          limit_window_seconds: 18000,
        },
        secondary_window: {
          used_percent: 140, // should clamp to 100
          limit_window_seconds: 604800,
        },
      },
    };

    const snapshot = parseUsageResponse(raw, account, fixedNow);
    assert.equal(snapshot.windows[0].usedPercent, 0);
    assert.equal(snapshot.windows[0].remainingPercent, 100);
    assert.equal(snapshot.windows[1].usedPercent, 100);
    assert.equal(snapshot.windows[1].remainingPercent, 0);
  });

  it("prefers reset_at over reset_after_seconds", () => {
    const raw = {
      rate_limit: {
        primary_window: {
          used_percent: 10,
          reset_at: 1700005000,
          reset_after_seconds: 100,
        },
      },
    };

    const snapshot = parseUsageResponse(raw, account, fixedNow);
    assert.equal(snapshot.windows[0].resetsAt, 1700005000 * 1000);
  });

  it("supports reset_after_seconds: 0", () => {
    const raw = {
      rate_limit: {
        primary_window: {
          used_percent: 10,
          reset_after_seconds: 0,
        },
      },
    };

    const snapshot = parseUsageResponse(raw, account, fixedNow);
    assert.equal(snapshot.windows[0].resetsAt, fixedNow + 0);
  });

  it("supports relative reset_after_seconds > 0", () => {
    const raw = {
      rate_limit: {
        primary_window: {
          used_percent: 10,
          reset_after_seconds: 120,
        },
      },
    };

    const snapshot = parseUsageResponse(raw, account, fixedNow);
    assert.equal(snapshot.windows[0].resetsAt, fixedNow + 120_000);
  });

  it("sanitizes plan_type by removing control characters", () => {
    const raw = {
      plan_type: "team\x00\x1f\x7f\t",
      rate_limit: {
        primary_window: { used_percent: 10 },
      },
    };

    const snapshot = parseUsageResponse(raw, account, fixedNow);
    assert.equal(snapshot.plan, "team");
  });

  it("ignores invalid out-of-range reset timestamps", () => {
    const snapshot = parseUsageResponse({ rate_limit: {
      primary_window: { used_percent: 10, reset_at: 1e100 },
      secondary_window: { used_percent: 20, reset_after_seconds: 1e308 },
    } }, account, fixedNow);
    assert.ok(snapshot.windows.every((window) => window.resetsAt === undefined));
  });

  it("handles a weekly-only primary without inventing a five-hour row", () => {
    const snapshot = parseUsageResponse({ rate_limit: {
      primary_window: { used_percent: 37, limit_window_seconds: 604800 }, secondary_window: null,
    } }, account, fixedNow);
    assert.deepEqual(snapshot.windows.map((window) => window.id), ["weekly"]);
  });

  it("ignores non-GPT windows like code_review_rate_limit", () => {
    const raw = {
      rate_limit: {
        primary_window: { used_percent: 10 },
      },
      code_review_rate_limit: {
        primary_window: { used_percent: 99 },
      },
    };

    const snapshot = parseUsageResponse(raw, account, fixedNow);
    assert.equal(snapshot.windows.length, 1);
    assert.equal(snapshot.windows[0].id, "5h");
  });

  it("throws error when response has no usable windows", () => {
    assert.throws(
      () => parseUsageResponse({ rate_limit: {} }, account, fixedNow),
      /no usable usage windows found/i
    );
    assert.throws(
      () => parseUsageResponse({ rate_limit: { primary_window: { used_percent: "NaN" } } }, account, fixedNow),
      /no usable usage windows found/i
    );
  });
});

describe("fetchUsage", () => {
  const credentials: UsageCredentials = {
    account: {
      provider: "openai-codex",
      accountId: "acct-test-789",
    },
    accessToken: "super-secret-token",
  };

  it("sends expected headers and parses response on success", async () => {
    let capturedUrl: string | undefined;
    let capturedOptions: RequestInit | undefined;

    const mockFetch: typeof globalThis.fetch = async (url, options) => {
      capturedUrl = String(url);
      capturedOptions = options;
      return new Response(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: {
            primary_window: { used_percent: 42, limit_window_seconds: 18000 },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    };

    const snapshot = await fetchUsage(credentials, { fetch: mockFetch });

    assert.equal(capturedUrl, USAGE_URL);
    assert.equal(capturedOptions?.method, "GET");
    assert.equal(capturedOptions?.redirect, "error");

    const headers = capturedOptions?.headers as Record<string, string>;
    assert.equal(headers["Authorization"], "Bearer super-secret-token");
    assert.equal(headers["ChatGPT-Account-Id"], "acct-test-789");
    assert.equal(headers["User-Agent"], "pi-openai-usage");
    assert.equal(headers["Accept"], "application/json");

    assert.equal(snapshot.plan, "plus");
    assert.equal(snapshot.windows[0].usedPercent, 42);
  });

  it("omits ChatGPT-Account-Id when accountId is missing", async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const credsWithoutAcct: UsageCredentials = {
      account: { provider: "openai" },
      accessToken: "token-no-acct",
    };

    const mockFetch: typeof globalThis.fetch = async (_, options) => {
      capturedHeaders = options?.headers as Record<string, string>;
      return new Response(
        JSON.stringify({
          rate_limit: { primary_window: { used_percent: 5 } },
        }),
        { status: 200 }
      );
    };

    await fetchUsage(credsWithoutAcct, { fetch: mockFetch });
    assert.equal(capturedHeaders?.["ChatGPT-Account-Id"], undefined);
  });

  it("sanitizes 401 error and provides login instructions without leaking token", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return new Response("{\"error\":\"upstream raw message with super-secret-token\"}", {
        status: 401,
      });
    };

    await assert.rejects(
      async () => fetchUsage(credentials, { fetch: mockFetch }),
      (err: Error) => {
        assert.match(err.message, /HTTP 401/);
        assert.match(err.message, /\/login openai-codex or \/login openai/i);
        assert.doesNotMatch(err.message, /super-secret-token/);
        assert.doesNotMatch(err.message, /upstream raw message/);
        return true;
      }
    );
  });

  it("sanitizes 403 error and provides login instructions", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return new Response("Forbidden upstream body", { status: 403 });
    };

    await assert.rejects(
      async () => fetchUsage(credentials, { fetch: mockFetch }),
      (err: Error) => {
        assert.match(err.message, /HTTP 403/);
        assert.match(err.message, /\/login openai-codex or \/login openai/i);
        assert.doesNotMatch(err.message, /Forbidden upstream body/);
        return true;
      }
    );
  });

  it("sanitizes 429 rate limit error", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return new Response("{\"error\":\"Too Many Requests\"}", { status: 429 });
    };

    await assert.rejects(
      async () => fetchUsage(credentials, { fetch: mockFetch }),
      (err: Error) => {
        assert.match(err.message, /HTTP 429/);
        assert.match(err.message, /Rate limit exceeded/i);
        assert.doesNotMatch(err.message, /Too Many Requests/);
        return true;
      }
    );
  });

  it("never exposes rejected network errors that may contain secret headers", async () => {
    const mockFetch: typeof fetch = async () => { throw new Error("Invalid Authorization: super-secret-token"); };
    await assert.rejects(fetchUsage(credentials, { fetch: mockFetch }), (error: Error) => {
      assert.match(error.message, /network request failed/);
      assert.doesNotMatch(error.message, /super-secret-token/);
      return true;
    });
  });

  it("enforces the deadline even if a transport ignores its abort signal", async () => {
    const mockFetch: typeof fetch = () => new Promise(() => {});
    await assert.rejects(fetchUsage(credentials, { fetch: mockFetch, timeoutMs: 20 }), /timed out/);
  });

  it("handles timeout during network fetch", async () => {
    const mockFetch: typeof globalThis.fetch = async (_url, options) => {
      return new Promise((_, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    };

    await assert.rejects(
      async () => fetchUsage(credentials, { fetch: mockFetch, timeoutMs: 50 }),
      /timed out after 50ms/i
    );
  });

  it("cancels and unlocks a stalled response body on timeout without awaiting cancellation", async () => {
    let cancelled = false;
    let requestSignal: AbortSignal | null | undefined;
    const body = new ReadableStream<Uint8Array>({
      cancel() { cancelled = true; return new Promise(() => {}); },
    });
    const mockFetch: typeof fetch = async (_url, options) => {
      requestSignal = options?.signal;
      return new Response(body);
    };
    await assert.rejects(fetchUsage(credentials, { fetch: mockFetch, timeoutMs: 40 }), /timed out after 40ms/i);
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
    assert.equal(requestSignal?.aborted, true);
  });

  it("handles caller cancellation during fetch", async () => {
    const controller = new AbortController();
    const mockFetch: typeof globalThis.fetch = async (_url, options) => {
      return new Promise((_, reject) => {
        options?.signal?.addEventListener("abort", () => {
          reject(new Error("caller aborted"));
        });
      });
    };

    const promise = fetchUsage(credentials, {
      fetch: mockFetch,
      signal: controller.signal,
      timeoutMs: 5000,
    });

    controller.abort();

    await assert.rejects(promise, /aborted/i);
  });

  it("handles caller cancellation during response body consumption", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; } });
    const mockFetch: typeof fetch = async () => new Response(body);

    const promise = fetchUsage(credentials, {
      fetch: mockFetch,
      signal: controller.signal,
      timeoutMs: 5000,
    });

    setTimeout(() => controller.abort(), 30);

    await assert.rejects(promise, /aborted/i);
    assert.equal(cancelled, true);
    assert.equal(body.locked, false);
  });

  it("accepts a valid JSON body at exactly the byte limit", async () => {
    const json = JSON.stringify({ rate_limit: { primary_window: { used_percent: 25 } } });
    const body = json + " ".repeat(MAX_USAGE_RESPONSE_BYTES - Buffer.byteLength(json));
    const snapshot = await fetchUsage(credentials, { fetch: async () => new Response(body) });
    assert.equal(snapshot.windows[0].remainingPercent, 75);
  });

  it("rejects oversized streams regardless of missing or misleading Content-Length", async () => {
    for (const contentLength of [undefined, "1"]) {
      let cancelled = false;
      let requestSignal: AbortSignal | null | undefined;
      let reads = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          reads++;
          controller.enqueue(new Uint8Array(MAX_USAGE_RESPONSE_BYTES / 2 + 1));
        },
        cancel() { cancelled = true; },
      });
      await assert.rejects(fetchUsage(credentials, { fetch: async (_url, options) => {
        requestSignal = options?.signal;
        return new Response(body, { headers: contentLength ? { "Content-Length": contentLength } : {} });
      } }), /response exceeds .* byte limit/);
      assert.equal(cancelled, true);
      assert.equal(body.locked, false);
      assert.equal(requestSignal?.aborted, true);
      assert.ok(reads <= 3, "must stop reading as soon as the byte limit is exceeded");
    }
  });

  it("counts UTF-8 bytes rather than characters toward the response limit", async () => {
    const json = JSON.stringify({ pad: "é".repeat(MAX_USAGE_RESPONSE_BYTES / 2), rate_limit: { primary_window: { used_percent: 25 } } });
    assert.ok(json.length < MAX_USAGE_RESPONSE_BYTES);
    await assert.rejects(fetchUsage(credentials, { fetch: async () => new Response(json) }), /byte limit/);
  });

  it("decodes UTF-8 characters split across chunks", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ plan_type: "équipe", rate_limit: { primary_window: { used_percent: 25 } } }));
    let offset = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === bytes.length) controller.close();
        else controller.enqueue(bytes.subarray(offset, ++offset));
      },
    });
    const result = await fetchUsage(credentials, { fetch: async () => new Response(body) });
    assert.equal(result.plan, "équipe");
    assert.equal(body.locked, false);
  });

  it("sanitizes JSON errors without exposing response contents", async () => {
    await assert.rejects(fetchUsage(credentials, { fetch: async () => new Response("super-secret-token invalid JSON") }), (error: Error) => {
      assert.match(error.message, /Invalid JSON response/);
      assert.doesNotMatch(error.message, /super-secret-token/);
      return true;
    });
  });

  it("disposes a late response from a transport that ignored cancellation", async () => {
    let finish!: (response: Response) => void;
    const controller = new AbortController();
    const pending = fetchUsage(credentials, {
      fetch: () => new Promise<Response>((resolve) => { finish = resolve; }),
      signal: controller.signal,
    });
    controller.abort();
    await assert.rejects(pending, /aborted/);
    let cancelled = false;
    finish(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
    await Promise.resolve();
    assert.equal(cancelled, true);
  });
});
