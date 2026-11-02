import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { UsageSnapshot, UsageState, UsageWindow } from "./types.ts";

export type PanelTheme = Pick<Theme, "fg" | "bold">;
type Color = "success" | "warning" | "error" | "muted" | "accent";
const COLORS: Record<Color, string> = {
  success: "\x1b[38;2;95;175;95m",
  warning: "\x1b[38;2;254;188;56m",
  error: "\x1b[38;2;235;77;75m",
  muted: "\x1b[38;2;108;108;108m",
  accent: "\x1b[38;2;254;188;56m",
};
const RESET = "\x1b[22;23;24;39m";

/** Never allow account labels or errors to inject terminal control sequences. */
export function plainText(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor((minutes % 1440) / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}

export function formatReset(resetsAt: number | undefined, now = Date.now()): string {
  if (resetsAt === undefined || !Number.isFinite(new Date(resetsAt).getTime())) return "—";
  // A due reset does not imply the quota has actually refilled. Await the next fetch.
  return resetsAt <= now ? "Due" : formatDuration(resetsAt - now);
}

function formatTimestamp(timestamp: number | undefined): string {
  if (timestamp === undefined) return "—";
  const date = new Date(timestamp);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "—";
}

function remaining(window: UsageWindow): number {
  return Math.round(Math.max(0, Math.min(100, window.remainingPercent)));
}

function severity(percent: number): Color {
  return percent > 50 ? "success" : percent >= 20 ? "warning" : "error";
}

function accountLabel(snapshot: UsageSnapshot): string {
  return plainText(snapshot.account.email || "ChatGPT");
}

export function renderUsagePanel(
  state: UsageState,
  width: number,
  theme?: PanelTheme,
  now = Date.now(),
): string[] {
  const columns = Math.max(0, Math.floor(width));
  if (!columns) return [];
  const color = (name: Color, text: string) => theme?.fg(name, text) ?? `${COLORS[name]}${text}${RESET}`;
  const bold = (text: string) => theme?.bold(text) ?? `\x1b[1m${text}${RESET}`;
  const lines = [bold(" OpenAI Usage"), color("muted", "─".repeat(columns))];
  const snapshot = state.snapshot;

  if (!snapshot) {
    const message = plainText(state.error || (state.loading ? "Fetching usage…" : "Run /openai-usage to refresh"));
    lines.push(...wrapTextWithAnsi(message, Math.max(1, columns - 2)).map((line) => color(state.error ? "error" : "muted", ` ${line}`)));
    return lines.map((line) => truncateToWidth(line, columns));
  }

  const plan = snapshot.plan ? ` · ${plainText(snapshot.plan)}` : "";
  lines.push(color("accent", ` ${accountLabel(snapshot)}${plan}`));
  lines.push(color("muted", "  GPT · remaining"));

  // Uniform prefix, gauge width and suffix budget across all quota windows.
  const labelWidth = Math.max(3, ...snapshot.windows.map((window) => Math.min(8, visibleWidth(plainText(window.label)))));
  const prefixWidth = 4 + labelWidth;
  const showReset = columns >= 32;
  const suffixes = snapshot.windows.map((window) => ` · ${formatReset(window.resetsAt, now)}`);
  const suffixWidth = showReset ? Math.min(12, Math.max(0, ...suffixes.map(visibleWidth))) : 0;
  const barWidth = Math.max(0, columns - prefixWidth - 5 - suffixWidth - 2);

  snapshot.windows.forEach((window, index) => {
    const percent = remaining(window);
    const label = truncateToWidth(plainText(window.label), labelWidth, "");
    const prefix = `   ${label}${" ".repeat(Math.max(0, labelWidth - visibleWidth(label)))} `;
    const filled = Math.round((percent / 100) * barWidth);
    const gauge = color(severity(percent), "█".repeat(filled)) + color("muted", "░".repeat(barWidth - filled));
    const percentage = color(severity(percent), `${percent}%`.padStart(4));
    const suffix = showReset ? color("muted", truncateToWidth(suffixes[index]!, suffixWidth, "")) : "";
    lines.push(`${color("muted", prefix)}${gauge} ${percentage}${suffix}`);
  });

  if (snapshot.limitReached) lines.push(color("warning", "  Usage limit reached"));
  if (state.error) {
    lines.push(color("warning", "  Stale · last refresh failed"));
    lines.push(...wrapTextWithAnsi(plainText(state.error), Math.max(1, columns - 3)).map((line) => color("muted", `  ${line}`)));
  } else if (state.loading) {
    lines.push(color("muted", "  Refreshing…"));
  } else if (now - snapshot.fetchedAt >= 3 * 60_000) {
    lines.push(color("muted", `  Updated ${formatDuration(now - snapshot.fetchedAt)} ago`));
  }
  return lines.map((line) => truncateToWidth(line, columns));
}

export function formatUsageStatus(state: UsageState, now = Date.now()): string {
  if (!state.snapshot) return state.error ? "OpenAI: unavailable" : "OpenAI: fetching…";
  const windows = state.snapshot.windows.map((window) => `${plainText(window.label)} ${remaining(window)}% · ${formatReset(window.resetsAt, now)}`);
  return `OpenAI left: ${windows.join(" | ")}${state.error ? " (stale)" : ""}`;
}

export function formatUsageReport(state: UsageState, now = Date.now()): string {
  const lines = ["# OpenAI Usage", ""];
  if (state.error) lines.push(`Status: ${plainText(state.error)}`, "");
  const snapshot = state.snapshot;
  if (!snapshot) {
    lines.push(state.loading ? "Fetching usage…" : "No usage data available.");
    return lines.join("\n");
  }
  lines.push(`Account: ${accountLabel(snapshot)}`, `Provider: ${snapshot.account.provider}`);
  if (snapshot.plan) lines.push(`Plan: ${plainText(snapshot.plan)}`);
  lines.push(`Updated: ${formatTimestamp(snapshot.fetchedAt)}${state.error ? " (stale)" : ""}`, "");
  lines.push("| Window | Remaining | Used | Resets in | Reset time |", "| --- | ---: | ---: | --- | --- |");
  for (const window of snapshot.windows) {
    const label = window.id === "weekly" ? "Weekly" : plainText(window.label);
    lines.push(`| ${label} | ${remaining(window)}% | ${Math.round(window.usedPercent)}% | ${formatReset(window.resetsAt, now)} | ${formatTimestamp(window.resetsAt)} |`);
  }
  if (snapshot.limitReached) lines.push("", "The subscription usage limit has been reached.");
  lines.push("", "Percentages show remaining subscription capacity, not API billing or session token counts.");
  return lines.join("\n");
}
