import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { PANEL_ID, registerUsagePanel, requestSidebarRender } from "../src/sidebar.ts";

type Globals = {
  __PI_SIDEBAR_PANELS__?: Map<string, any>;
  __PI_SIDEBAR_REQUEST_RENDER__?: (() => void) | null;
  __PI_SIDEBAR_TUI__?: any;
};
const g = globalThis as unknown as Globals;
afterEach(() => {
  delete g.__PI_SIDEBAR_PANELS__;
  delete g.__PI_SIDEBAR_TUI__;
  delete g.__PI_SIDEBAR_REQUEST_RENDER__;
});

test("fallback registration survives sidebar loading later", () => {
  const unregister = registerUsagePanel((width) => [`width=${width}`]);
  const panel = g.__PI_SIDEBAR_PANELS__?.get(PANEL_ID);
  assert.ok(panel);
  assert.equal(panel.order, 21);
  assert.deepEqual(panel.render({}, 40), ["width=40"]);
  unregister();
  assert.equal(g.__PI_SIDEBAR_PANELS__?.has(PANEL_ID), false);
});

test("uses sidebar public API and its unregister callback when available", () => {
  let registered: any;
  let renders = 0;
  let removals = 0;
  g.__PI_SIDEBAR_TUI__ = {
    registerPanel(panel: unknown) { registered = panel; return () => { removals++; }; },
    requestRender() { renders++; },
  };
  const unregister = registerUsagePanel(() => ["OpenAI"]);
  assert.equal(registered.id, PANEL_ID);
  requestSidebarRender();
  assert.equal(renders, 1);
  unregister();
  unregister();
  assert.equal(removals, 1);
});

test("render callback falls back to legacy hook", () => {
  let renders = 0;
  g.__PI_SIDEBAR_REQUEST_RENDER__ = () => { renders++; };
  requestSidebarRender();
  assert.equal(renders, 1);
});

test("shutdown from an old runtime cannot unregister a new replacement", () => {
  const first = registerUsagePanel(() => ["old"]);
  const second = registerUsagePanel(() => ["new"]);
  first();
  assert.deepEqual(g.__PI_SIDEBAR_PANELS__?.get(PANEL_ID)?.render({}, 30), ["new"]);
  second();
  assert.equal(g.__PI_SIDEBAR_PANELS__?.has(PANEL_ID), false);
});

test("registration does not remove other providers' panels", () => {
  g.__PI_SIDEBAR_PANELS__ = new Map([["antigravity-quota", { id: "antigravity-quota" }]]);
  const unregister = registerUsagePanel(() => []);
  assert.equal(g.__PI_SIDEBAR_PANELS__.size, 2);
  unregister();
  assert.equal(g.__PI_SIDEBAR_PANELS__.size, 1);
  assert.ok(g.__PI_SIDEBAR_PANELS__.has("antigravity-quota"));
});
