import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { readUsageCredentials } from "./src/auth.ts";
import { fetchUsage } from "./src/client.ts";
import { UsageMonitor } from "./src/monitor.ts";
import { formatUsageReport, formatUsageStatus, renderUsagePanel } from "./src/panel.ts";
import { registerUsagePanel, requestSidebarRender } from "./src/sidebar.ts";
import type { UsageState } from "./src/types.ts";

/** Cancel one caller's wait without aborting a request shared with the sidebar. */
function waitForRefresh(pending: Promise<UsageState>, signal?: AbortSignal): Promise<UsageState> {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const aborted = () => reject(signal.reason ?? new Error("OpenAI usage check cancelled"));
    signal.addEventListener("abort", aborted, { once: true });
    void pending.then(
      (state) => { signal.removeEventListener("abort", aborted); resolve(state); },
      (error) => { signal.removeEventListener("abort", aborted); reject(error); },
    );
  });
}

const STATUS_KEY = "openai-usage";

function isOpenAIModel(model?: { provider?: string }): boolean {
  return model?.provider === "openai-codex" || model?.provider === "openai";
}

export default function openaiUsageExtension(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let unregisterPanel: (() => void) | undefined;
  let statusEnabled = false;
  let sessionEpoch = 0;

  const monitor = new UsageMonitor({
    load: (signal) => fetchUsage(readUsageCredentials(), { signal }),
    onChange: (state) => {
      requestSidebarRender();
      if (statusEnabled && context?.mode === "tui") {
        context.ui.setStatus(STATUS_KEY, formatUsageStatus(state));
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    sessionEpoch++;
    context = ctx;
    if (ctx.mode !== "tui") {
      monitor.start(false);
      return;
    }
    unregisterPanel?.();
    unregisterPanel = registerUsagePanel((width) => renderUsagePanel(monitor.getState(), width, context?.ui.theme));
    if (isOpenAIModel(ctx.model)) {
      monitor.start();
    } else {
      monitor.start(false);
      void monitor.refresh();
    }
  });

  pi.on("turn_end", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    context = ctx;
    if (isOpenAIModel(ctx.model)) {
      void monitor.refresh();
    }
  });

  pi.on("model_select", (event, ctx) => {
    if (ctx.mode !== "tui") return;
    context = ctx;
    if (isOpenAIModel(event.model)) {
      monitor.start();
      void monitor.refresh();
    } else {
      monitor.start(false);
    }
  });

  pi.on("session_shutdown", (_event, ctx) => {
    sessionEpoch++;
    monitor.stop();
    unregisterPanel?.();
    unregisterPanel = undefined;
    if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, undefined);
    context = undefined;
  });

  pi.registerCommand("openai-usage", {
    description: "Refresh OpenAI 5h/weekly usage; report for details, status to toggle the footer",
    handler: async (args, ctx) => {
      const epoch = sessionEpoch;
      context = ctx;
      const action = args.trim().toLowerCase();
      if (!["", "refresh", "report", "full", "status", "toggle-status"].includes(action)) {
        ctx.ui.notify("Usage: /openai-usage [refresh|report|status]", "info");
        return;
      }
      if (action === "status" || action === "toggle-status") {
        if (ctx.mode !== "tui") {
          ctx.ui.notify("OpenAI usage footer requires interactive TUI mode", "warning");
          return;
        }
        statusEnabled = !statusEnabled;
        ctx.ui.setStatus(STATUS_KEY, statusEnabled ? formatUsageStatus(monitor.getState()) : undefined);
        if (statusEnabled) await monitor.refresh();
        if (epoch !== sessionEpoch) return;
        ctx.ui.notify(`OpenAI usage status ${statusEnabled ? "enabled" : "disabled"}`, "info");
        return;
      }

      const state = await monitor.refresh(true);
      if (epoch !== sessionEpoch) return;
      if ((action === "report" || action === "full") && ctx.hasUI) {
        await ctx.ui.editor("OpenAI Usage", formatUsageReport(state));
      } else {
        ctx.ui.notify(state.error || formatUsageStatus(state), state.error ? "warning" : "info");
      }
    },
  });

  pi.registerTool({
    name: "openai_usage",
    label: "OpenAI Usage",
    description: "Check remaining OpenAI ChatGPT/Codex subscription capacity for the 5-hour and weekly windows and their reset times. Reuses Pi's existing OAuth login; not API billing or session token usage.",
    parameters: Type.Object({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    async execute(_toolCallId, _params, signal) {
      const epoch = sessionEpoch;
      signal?.throwIfAborted();
      const state = await waitForRefresh(monitor.refresh(true), signal);
      signal?.throwIfAborted();
      if (epoch !== sessionEpoch) throw new Error("OpenAI usage session ended");
      return {
        content: [{ type: "text", text: formatUsageReport(state) }],
        details: state,
        ...(state.error ? { isError: true } : {}),
      };
    },
  });
}
