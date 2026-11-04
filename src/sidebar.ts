export const PANEL_ID = "openai-usage";

interface SidebarPanel {
  id: string;
  order: number;
  render: (_ctx: unknown, width: number) => string[];
}

interface SidebarGlobals {
  __PI_SIDEBAR_PANELS__?: Map<string, SidebarPanel>;
  __PI_SIDEBAR_REQUEST_RENDER__?: (() => void) | null;
  __PI_SIDEBAR_TUI__?: {
    registerPanel?: (panel: SidebarPanel) => () => void;
    getPanels?: () => SidebarPanel[];
    requestRender?: () => void;
  };
}

function globals(): SidebarGlobals {
  return globalThis as unknown as SidebarGlobals;
}

export function requestSidebarRender(): void {
  const g = globals();
  // This hook belongs to another extension and may already be torn down.
  // Repainting must not interrupt panel registration/removal or status updates.
  try {
    const result = typeof g.__PI_SIDEBAR_TUI__?.requestRender === "function"
      ? g.__PI_SIDEBAR_TUI__.requestRender()
      : g.__PI_SIDEBAR_REQUEST_RENDER__?.();
    void Promise.resolve(result).catch(() => {});
  } catch { /* Best-effort repaint. */ }
}

/** Use the same load-order-independent protocol as pi-antigravity-auth. */
export function registerUsagePanel(render: (width: number) => string[]): () => void {
  const g = globals();
  const panel: SidebarPanel = {
    id: PANEL_ID,
    order: 21, // After Antigravity quota (20), before MCP (30).
    render: (_ctx, width) => render(width),
  };
  const api = g.__PI_SIDEBAR_TUI__;
  let unregister: (() => void) | undefined;
  if (typeof api?.registerPanel === "function") {
    unregister = api.registerPanel(panel);
  } else {
    g.__PI_SIDEBAR_PANELS__ ??= new Map();
    g.__PI_SIDEBAR_PANELS__.set(PANEL_ID, panel);
    requestSidebarRender();
  }

  let disposed = false;
  return () => {
    if (disposed) return;
    disposed = true;
    // A late shutdown from an old runtime must not remove a replacement panel.
    const current = globals().__PI_SIDEBAR_PANELS__?.get(PANEL_ID)
      ?? globals().__PI_SIDEBAR_TUI__?.getPanels?.().find((entry) => entry.id === PANEL_ID);
    if (current && current !== panel) return;
    if (unregister) unregister();
    else if (globals().__PI_SIDEBAR_PANELS__?.get(PANEL_ID) === panel) {
      globals().__PI_SIDEBAR_PANELS__?.delete(PANEL_ID);
      requestSidebarRender();
    }
  };
}
