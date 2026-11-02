import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatDuration, formatReset, formatUsageReport, formatUsageStatus, plainText, renderUsagePanel } from "../src/panel.ts";
import { NOW, sampleSnapshot } from "./fixtures.ts";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");

test("sidebar shows remaining GPT capacity and reset countdowns like Antigravity", () => {
  const lines = renderUsagePanel({ snapshot: sampleSnapshot(), loading: false }, 40, undefined, NOW);
  const text = stripAnsi(lines.join("\n"));
  assert.match(text, /OpenAI Usage/);
  assert.match(text, /GPT · remaining/);
  assert.match(text, /5h.*75% · 2h 0m/);
  assert.match(text, /Wk.*15% · 4d 0h/);
  assert.ok(!lines.join("").includes("\x1b[2m"), "must not emit faint font weight");
});

test("all gauge starts, widths, and percentage columns align at different widths", () => {
  for (const width of [20, 31, 32, 35, 37, 40, 45, 50, 80]) {
    const lines = renderUsagePanel({ snapshot: sampleSnapshot(), loading: false }, width, undefined, NOW).map(stripAnsi);
    const rows = lines.filter((line) => /[█░]/.test(line));
    assert.equal(rows.length, 2);
    const columns = rows.map((line) => {
      const bar = line.match(/[█░]+/)!;
      return [bar.index, bar[0].length, line.indexOf("%")];
    });
    assert.deepEqual(columns[0], columns[1], `misaligned at width ${width}`);
  }
});

test("every line fits zero, narrow, and wide terminal widths, including wide labels", () => {
  const snapshot = sampleSnapshot();
  snapshot.account.email = "用户😃@example.com";
  snapshot.plan = "pro";
  snapshot.windows[0]!.label = "三小时";
  for (const width of [0, 1, 2, 5, 10, 19, 20, 31, 32, 40, 80]) {
    for (const line of renderUsagePanel({ snapshot, loading: false, error: "temporarily unavailable" }, width, undefined, NOW)) {
      assert.ok(visibleWidth(line) <= width, `${visibleWidth(line)} columns exceeds ${width}`);
    }
  }
});

test("missing, loading, error, and stale states are explicit", () => {
  assert.match(stripAnsi(renderUsagePanel({ loading: true }, 40).join("\n")), /Fetching usage/);
  assert.match(stripAnsi(renderUsagePanel({ loading: false, error: "Run \/login openai-codex" }, 60).join("\n")), /login openai-codex/);
  assert.match(stripAnsi(renderUsagePanel({ loading: false, snapshot: sampleSnapshot(), error: "HTTP 503" }, 40, undefined, NOW).join("\n")), /Stale · last refresh failed/);
  assert.match(formatUsageStatus({ loading: false, snapshot: sampleSnapshot(), error: "HTTP 503" }, NOW), /\(stale\)/);
});

test("expired windows are due, not made-up refilled quotas", () => {
  const snapshot = sampleSnapshot();
  snapshot.windows[0]!.remainingPercent = 0;
  snapshot.windows[0]!.usedPercent = 100;
  snapshot.windows[0]!.resetsAt = NOW;
  const text = stripAnsi(renderUsagePanel({ snapshot, loading: false }, 40, undefined, NOW).join("\n"));
  assert.match(text, /5h.*\s0% · Due/);
  assert.equal(formatReset(undefined, NOW), "—");
});

test("countdowns are compact and round upwards", () => {
  assert.equal(formatDuration(1), "1m");
  assert.equal(formatDuration(60_001), "2m");
  assert.equal(formatDuration(3_600_000), "1h 0m");
  assert.equal(formatDuration(86_400_000), "1d 0h");
  assert.equal(formatReset(NOW - 1, NOW), "Due");
});

test("current theme colors are computed at render time", () => {
  let palette = "first";
  const theme = {
    fg: (name: string, text: string) => `<${palette}:${name}>${text}</>`,
    bold: (text: string) => text,
  };
  const state = { snapshot: sampleSnapshot(), loading: false };
  const first = renderUsagePanel(state, 200, theme, NOW).join("\n");
  palette = "second";
  const second = renderUsagePanel(state, 200, theme, NOW).join("\n");
  assert.match(first, /first:success/);
  assert.match(first, /first:error/);
  assert.match(second, /second:success/);
  assert.ok(!second.includes("first:"));
});

test("report and status label remaining vs used unambiguously", () => {
  const state = { snapshot: sampleSnapshot(), loading: false };
  const report = formatUsageReport(state, NOW);
  assert.match(report, /\| Weekly \| 15% \| 85% \|/);
  assert.match(report, /Provider: openai-codex/);
  assert.match(formatUsageStatus(state, NOW), /OpenAI left: 5h 75%/);
  assert.match(formatUsageReport({ loading: false, error: "No OAuth login" }), /No OAuth login/);
});

test("reports tolerate invalid timestamps without throwing", () => {
  const snapshot = sampleSnapshot();
  for (const invalid of [NaN, Infinity, 1e100]) {
    snapshot.windows[0]!.resetsAt = invalid;
    assert.doesNotThrow(() => formatUsageReport({ snapshot, loading: false }, NOW));
    assert.equal(formatReset(invalid, NOW), "—");
  }
});

test("terminal control sequences cannot be injected by metadata", () => {
  const snapshot = sampleSnapshot();
  snapshot.account.email = "test\x1b[31m\n@example.com\x07";
  snapshot.plan = "plus\x1b]0;bad-title\x07";
  assert.equal(plainText("\x1b[31mtest\n"), "test");
  const report = formatUsageReport({ snapshot, loading: false }, NOW);
  assert.ok(!/[\x1b\x07]/.test(report));
});
