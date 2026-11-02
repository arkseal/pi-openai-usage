import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import openaiUsageExtension from "../index.ts";

const TOKEN = "test-access-token-never-to-be-exposed";
const g = globalThis as unknown as { __PI_SIDEBAR_PANELS__?: Map<string, any> };
let originalAgentDir: string | undefined;
let originalFetch: typeof fetch;
let agentDir: string;
let cleanup: (() => void) | undefined;

beforeEach(() => {
  originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  originalFetch = globalThis.fetch;
  agentDir = mkdtempSync(join(tmpdir(), "pi-openai-usage-test-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
    "openai-codex": { type: "oauth", access: TOKEN, refresh: "test-refresh", expires: Date.now() + 86_400_000, accountId: "test-account" },
  }));
  globalThis.fetch = async () => new Response(JSON.stringify({
    plan_type: "plus",
    rate_limit: {
      primary_window: { used_percent: 25, limit_window_seconds: 18_000, reset_after_seconds: 3600 },
      secondary_window: { used_percent: 60, limit_window_seconds: 604_800, reset_after_seconds: 86_400 },
    },
  }));
});

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  globalThis.fetch = originalFetch;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  delete g.__PI_SIDEBAR_PANELS__;
  rmSync(agentDir, { recursive: true, force: true });
});

function harness(mode: ExtensionContext["mode"] = "tui") {
  const events = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  const tools = new Map<string, any>();
  const statuses = new Map<string, string | undefined>();
  const notices: string[] = [];
  const reports: string[] = [];
  const ctx = {
    mode,
    hasUI: mode === "tui" || mode === "rpc",
    model: { provider: "openai-codex" },
    ui: {
      theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
      setStatus: (key: string, text: string | undefined) => statuses.set(key, text),
      notify: (message: string) => notices.push(message),
      editor: async (_title: string, text: string) => { reports.push(text); return text; },
    },
  };
  openaiUsageExtension({
    on: (event: string, handler: (...args: any[]) => any) => events.set(event, handler),
    registerCommand: (name: string, command: unknown) => commands.set(name, command),
    registerTool: (tool: any) => tools.set(tool.name, tool),
  } as unknown as ExtensionAPI);
  cleanup = () => events.get("session_shutdown")?.({}, ctx);
  return { events, commands, tools, statuses, notices, reports, ctx };
}

test("registers commands and tool without starting network requests in the factory", async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("must not fetch"); };
  const h = harness();
  assert.ok(h.commands.has("openai-usage"));
  assert.ok(h.tools.has("openai_usage"));
  await Promise.resolve();
  assert.equal(requests, 0);
  assert.equal(g.__PI_SIDEBAR_PANELS__, undefined);
});

test("TUI startup integrates with sidebar, command report, footer, and shutdown", async () => {
  const authBefore = readFileSync(join(agentDir, "auth.json"), "utf8");
  const h = harness();
  h.events.get("session_start")!({}, h.ctx);
  await h.commands.get("openai-usage").handler("refresh", h.ctx);
  const panel = g.__PI_SIDEBAR_PANELS__?.get("openai-usage");
  assert.ok(panel);
  assert.match(panel.render({}, 60).join("\n"), /5h.*75%/);
  await h.commands.get("openai-usage").handler("report", h.ctx);
  assert.match(h.reports[0]!, /\| Weekly \| 40% \| 60%/);
  await h.commands.get("openai-usage").handler("status", h.ctx);
  assert.match(h.statuses.get("openai-usage")!, /OpenAI left/);
  await h.commands.get("openai-usage").handler("status", h.ctx);
  assert.equal(h.statuses.get("openai-usage"), undefined);
  h.events.get("session_shutdown")!({}, h.ctx);
  assert.equal(g.__PI_SIDEBAR_PANELS__?.has("openai-usage"), false);
  assert.equal(readFileSync(join(agentDir, "auth.json"), "utf8"), authBefore);
});

test("non-TUI sessions do not poll or register panels, but the tool works on demand", async () => {
  let requests = 0;
  const mockFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { requests++; return mockFetch(...args); };
  const h = harness("print");
  h.events.get("session_start")!({}, h.ctx);
  assert.equal(requests, 0);
  assert.equal(g.__PI_SIDEBAR_PANELS__, undefined);
  const result = await h.tools.get("openai_usage").execute("call", {}, new AbortController().signal);
  assert.equal(requests, 1);
  assert.match(result.content[0].text, /75%/);
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test("tool reports missing auth as an error without leaking or changing credentials", async () => {
  writeFileSync(join(agentDir, "auth.json"), "{}");
  const h = harness("json");
  const result = await h.tools.get("openai_usage").execute("call", {}, new AbortController().signal);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /login|OAuth/i);
  assert.equal(readFileSync(join(agentDir, "auth.json"), "utf8"), "{}");
});

test("direct OAuth reports the limitation without repeatedly calling the unsupported API", async () => {
  const payload = Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString("base64url");
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: {
    type: "oauth", access: `header.${payload}.signature`, refresh: "test-refresh", expires: Date.now() + 3600_000,
    clientId: "test-client", scopes: ["chatgpt.tokens.use.direct"],
  } }));
  let requests = 0;
  globalThis.fetch = async () => { requests++; throw new Error("must not send direct grant to wham"); };
  const h = harness();
  h.events.get("session_start")!({}, h.ctx);
  await h.commands.get("openai-usage").handler("report", h.ctx);
  assert.equal(requests, 0);
  assert.match(h.reports[0]!, /direct OpenAI OAuth/);
  assert.match(h.reports[0]!, /\/login openai-codex/);
  assert.match(g.__PI_SIDEBAR_PANELS__?.get("openai-usage")?.render({}, 40).join("\n"), /openai-codex/);
});

test("tool cancellation does not wait for a shared sidebar request", async () => {
  let finish!: (response: Response) => void;
  globalThis.fetch = () => new Promise<Response>((resolve) => { finish = resolve; });
  const h = harness();
  h.events.get("session_start")!({}, h.ctx);
  const controller = new AbortController();
  const pending = h.tools.get("openai_usage").execute("call", {}, controller.signal);
  await Promise.resolve();
  controller.abort(new Error("cancelled by test"));
  await assert.rejects(pending, /cancelled by test/);
  finish(new Response(JSON.stringify({ rate_limit: { primary_window: { used_percent: 25 } } })));
  await h.commands.get("openai-usage").handler("refresh", h.ctx);
  assert.match(g.__PI_SIDEBAR_PANELS__?.get("openai-usage")?.render({}, 60).join("\n"), /75%/);
});

test("non-TUI sessions can be restarted without disabling on-demand usage", async () => {
  let requests = 0;
  const mockFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { requests++; return mockFetch(...args); };
  const h = harness("rpc");
  for (let session = 0; session < 2; session++) {
    h.events.get("session_start")!({}, h.ctx);
    const result = await h.tools.get("openai_usage").execute("call", {}, new AbortController().signal);
    assert.match(result.content[0].text, /75%/);
    h.events.get("session_shutdown")!({}, h.ctx);
  }
  assert.equal(requests, 2);
  assert.equal(g.__PI_SIDEBAR_PANELS__, undefined);
});

test("a command finishing after shutdown does not use its expired UI context", async () => {
  let finish!: (response: Response) => void;
  globalThis.fetch = () => new Promise<Response>((resolve) => { finish = resolve; });
  const h = harness();
  h.events.get("session_start")!({}, h.ctx);
  const command = h.commands.get("openai-usage").handler("report", h.ctx);
  await Promise.resolve();
  h.events.get("session_shutdown")!({}, h.ctx);
  await command;
  assert.equal(h.reports.length, 0);
  finish(new Response("{}"));
});

test("invalid command arguments and non-TUI footer requests are handled", async () => {
  const h = harness("rpc");
  await h.commands.get("openai-usage").handler("nope", h.ctx);
  await h.commands.get("openai-usage").handler("status", h.ctx);
  assert.match(h.notices[0]!, /Usage: \/openai-usage/);
  assert.match(h.notices[1]!, /interactive TUI/);
});
