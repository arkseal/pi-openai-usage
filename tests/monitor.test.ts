import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageMonitor } from "../src/monitor.ts";
import { NOW, sampleSnapshot } from "./fixtures.ts";
import type { UsageSnapshot } from "../src/types.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test("concurrent refreshes share a single request", async () => {
  const pending = deferred<UsageSnapshot>();
  let calls = 0;
  const monitor = new UsageMonitor({ load: async () => { calls++; return pending.promise; } });
  const first = monitor.refresh(true);
  const second = monitor.refresh(true);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(monitor.getState().loading, true);
  pending.resolve(sampleSnapshot());
  await first;
  assert.equal(monitor.getState().loading, false);
  assert.equal(monitor.getState().snapshot?.windows[0]?.remainingPercent, 75);
  monitor.stop();
});

test("background refreshes honor TTL; explicit refresh bypasses it", async () => {
  let now = NOW;
  let calls = 0;
  const monitor = new UsageMonitor({ now: () => now, load: async () => { calls++; return sampleSnapshot(); } });
  await monitor.refresh();
  await monitor.refresh();
  assert.equal(calls, 1);
  now += 59_999;
  await monitor.refresh();
  assert.equal(calls, 1);
  now++;
  await monitor.refresh();
  assert.equal(calls, 2);
  await monitor.refresh(true);
  assert.equal(calls, 3);
  monitor.stop();
});

test("failed refreshes retain last-known data but mark it stale, and recovery clears errors", async () => {
  let fail = false;
  const monitor = new UsageMonitor({ load: async () => {
    if (fail) throw new Error("OpenAI usage unavailable (HTTP 503)");
    return sampleSnapshot();
  } });
  await monitor.refresh(true);
  fail = true;
  const stale = await monitor.refresh(true);
  assert.ok(stale.snapshot);
  assert.match(stale.error!, /HTTP 503/);
  assert.equal(stale.loading, false);
  fail = false;
  assert.equal((await monitor.refresh(true)).error, undefined);
  monitor.stop();
});

test("synchronous loader failures do not permanently wedge single-flight", async () => {
  let calls = 0;
  const monitor = new UsageMonitor({ load: () => { calls++; throw new Error("No OAuth login"); } });
  assert.equal((await monitor.refresh(true)).loading, false);
  await monitor.refresh(true);
  assert.equal(calls, 2);
  monitor.stop();
});

test("shutdown aborts work and ignores late results, including across a new start", async () => {
  const old = deferred<UsageSnapshot>();
  let oldSignal: AbortSignal | undefined;
  let calls = 0;
  let updates = 0;
  const monitor = new UsageMonitor({
    load: async (signal) => {
      calls++;
      if (calls === 1) { oldSignal = signal; return old.promise; }
      const snapshot = sampleSnapshot();
      snapshot.plan = "pro";
      return snapshot;
    },
    onChange: () => { updates++; },
  });
  const first = monitor.refresh(true);
  await Promise.resolve();
  monitor.stop();
  assert.equal(oldSignal?.aborted, true);
  const before = updates;
  old.resolve(sampleSnapshot());
  await first;
  assert.equal(updates, before);
  assert.equal(monitor.getState().snapshot, undefined);
  monitor.start();
  await monitor.refresh(true);
  assert.equal(monitor.getState().snapshot?.plan, "pro");
  monitor.stop();
});

test("an old completion cannot return a new session's loading state", async () => {
  const old = deferred<UsageSnapshot>();
  const next = deferred<UsageSnapshot>();
  let calls = 0;
  const monitor = new UsageMonitor({ load: () => (++calls === 1 ? old.promise : next.promise) });
  const first = monitor.refresh(true);
  await Promise.resolve();
  monitor.stop();
  monitor.start();
  const second = monitor.refresh(true);
  old.resolve(sampleSnapshot());
  assert.equal((await first).loading, false);
  assert.equal(monitor.getState().loading, true);
  next.resolve(sampleSnapshot());
  await second;
  monitor.stop();
});

test("polling resources are only created on start and stop is idempotent", async () => {
  let calls = 0;
  const monitor = new UsageMonitor({ load: async () => { calls++; return sampleSnapshot(); } });
  assert.equal(calls, 0);
  monitor.start();
  monitor.start();
  await monitor.refresh(true);
  assert.equal(calls, 1);
  monitor.stop();
  monitor.stop();
  await monitor.refresh(true);
  assert.equal(calls, 1);
});
