# pi-openai-usage

OpenAI ChatGPT subscription usage for Pi: **5-hour and weekly remaining capacity**, reset countdowns, and a sidebar panel styled like `pi-antigravity-auth`.

```text
 OpenAI Usage
────────────────────────────────────────
 user@example.com · plus
  GPT · remaining
   5h  ████████████░░░░  75% · 2h 0m
   Wk  ██░░░░░░░░░░░░░░  15% · 4d 0h
```

These are subscription limits shared with other clients using the same account, **not API billing, dollar spend, or this session's token totals**. Percentages and bars indicate **remaining**, not used, capacity.

## Install

Requires Pi 1.4+ and a **legacy ChatGPT/Codex OAuth login** in Pi (`/login openai-codex`) for numeric quota data. This extension does not register another provider or implement a login flow.

**Important:** Pi's newer `/login openai` “Sign in with ChatGPT” grant cannot access the numeric usage API. If that is your only login, the panel explains the limitation and links to [ChatGPT usage settings](https://chatgpt.com/settings/usage). You can keep that login for inference and add a separate `/login openai-codex` login for the usage panel.

```bash
pi install /home/aarush/code/pi_plugins/pi-openai-usage
```

Run `/reload` in an existing Pi session. For a one-off local test:

```bash
pi -e ./pi-openai-usage/index.ts
```

`pi-sidebar-tui` is optional. When installed, an **OpenAI Usage** panel appears immediately after Antigravity's quota panel and before MCP. Either package can load first. Without the sidebar, use the command, full report, or optional footer status. No existing panels or footers are replaced.

## Commands and tool

| Command | Behavior |
| --- | --- |
| `/openai-usage` | Fetch usage, update the sidebar, and show a compact summary |
| `/openai-usage refresh` | Same as above; bypass the normal cache interval |
| `/openai-usage report` | Open a full report with used/remaining percentages and reset timestamps |
| `/openai-usage full` | Alias for `report` |
| `/openai-usage status` | Toggle a compact footer status; disabled by default |

The **`openai_usage`** tool lets the agent inspect the same usage on demand. It also works in print/JSON/RPC sessions; those modes do not start background polling or terminal panels.

## Authentication and requests

- Reuses OAuth credentials in Pi's `<agent-dir>/auth.json`, honoring `PI_CODING_AGENT_DIR`.
- Prefers a valid `openai-codex` OAuth credential, then a compatible legacy OAuth credential under `openai`. API keys and recognized native direct-API OAuth grants are never sent to the subscription endpoint.
- Derives account information from the existing token or stored account ID. Access and refresh tokens are never included in reports, tool results, or sidebar data.
- Sends a read-only `GET https://chatgpt.com/backend-api/wham/usage`. It never issues model requests just to probe quota, so checking usage does not consume a model turn.
- Does **not** modify auth files, independently rotate refresh tokens, or read the separate Codex CLI credential store. Pi remains responsible for token refresh during normal provider use.

If a token has expired, use that provider normally in Pi so Pi refreshes it, then run `/openai-usage`. If the grant was revoked, reconnect through `/login`.

OpenAI's usage endpoint is an internal ChatGPT API. Native direct-API grants (`chatgpt.tokens.use.direct`) are currently not accepted; this is tracked in [openai/codex#54219](https://github.com/openai/codex/issues/54219). The extension recognizes these grants and reports the limitation without repeated unsupported HTTP requests. Repeating `/login openai` does not fix it. Other 401/403 failures are reported rather than replaced with invented quota data. Endpoint/schema changes can require an extension update.

## Refresh and display behavior

- Interactive TUI sessions fetch immediately and poll at most once per minute. Reset countdowns repaint every 15 seconds.
- OpenAI turn completion and model selection reuse the same throttled refresh. Explicit commands and tools bypass the cache interval; concurrent checks share one request.
- Requests have a 15-second deadline, including response-body parsing, and are aborted at session shutdown. Response bodies are limited to 1 MiB of decoded bytes, independent of `Content-Length`; incomplete bodies are cancelled on failure or abort. Redirects are rejected.
- Gauges are aligned and theme-aware: green above 50% remaining, amber at 20–50%, red below 20%. Narrow terminals omit reset suffixes.
- Windows are labeled by their actual duration, so a weekly-only response is not mislabeled as a 5-hour quota. Missing windows are omitted, not displayed as 100% available.
- On a transient failure, last-known usage is kept and explicitly marked **stale**. A reset countdown reaching zero displays **Due** until fresh data confirms the new quota.
- No usage cache or credentials are persisted by this extension. Timers and panel registrations are cleaned up on reload/shutdown.

## Development

```bash
cd pi-openai-usage
npm install
npm test
npm run check
```

Tests use Node's native test runner and mocked HTTP responses/temp auth files. They do not require an OpenAI account or make live requests.
