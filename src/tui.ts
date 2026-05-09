/**
 * Blessed TUI for the Pi Agent Dashboard.
 *
 * Thin adapter over {@link DashboardState}: creates blessed widgets,
 * wires keybinds to state mutations, and re-renders on change.
 */

import * as os from "node:os";
import * as path from "node:path";
import blessed from "blessed";
import { watch } from "chokidar";
import { loadConfig } from "./config.js";
import { scanSessions } from "./scanner.js";
import { DashboardState, type VisibleRow } from "./state.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");
const REFRESH_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// Pure presentation helpers (no state, no blessed DOM dependency)
// ---------------------------------------------------------------------------

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

function shortId(id: string, n = 6): string {
  return id.slice(-n);
}

function statusColor(status: string): string {
  switch (status) {
    case "running": return "green";
    case "completed": return "gray";
    default: return "yellow";
  }
}

function statusChar(status: string): string {
  switch (status) {
    case "running": return "●";
    case "completed": return "■";
    default: return "?";
  }
}

function expandIcon(expanded: boolean): string {
  return expanded ? "▼" : "▶";
}

function formatRow(row: VisibleRow, colWidths: { name: number; id: number; cwd: number }): string {
  const { session, hasChildren, indent } = row;
  const color = statusColor(session.status);
  const char = statusChar(session.status);
  const expand = hasChildren ? expandIcon(row.expanded) : "  ";
  const name = session.displayName ?? (session.isMain ? "main session" : (session.agentType ?? "session"));
  const nameField = truncate(name, colWidths.name);
  const idField = shortId(session.id);
  const cwdField = truncate(session.cwd || session.workspace, colWidths.cwd);
  const openColor = `{${color}-fg}`;
  const closeColor = `{/${color}-fg}`;
  return `${openColor}${indent}${expand}{/}{bold}${nameField}{/bold}{/}  {gray-fg}${idField}{/}  {dim}${cwdField}{/dim}  ${openColor}${char} ${session.status}${closeColor}`;
}

// ---------------------------------------------------------------------------
// Filter bar
// ---------------------------------------------------------------------------

function filterBarContent(hideCompleted: boolean, hideStale: boolean, staleMinutes: number): string {
  const completedLabel = hideCompleted
    ? "{blue-fg}{bold}ON{/bold}{/blue-fg}"
    : "{gray-fg}OFF{/gray-fg}";
  const staleLabel = hideStale
    ? "{blue-fg}{bold}ON{/bold}{/blue-fg}"
    : "{gray-fg}OFF{/gray-fg}";
  return `  {dim}Hide Completed:{/dim} ${completedLabel}     {dim}Hide Stale:{/dim} ${staleLabel}     {dim}Stale threshold:{/dim} {bold}${staleMinutes}m{/bold}`;
}

// ---------------------------------------------------------------------------
// TUI
// ---------------------------------------------------------------------------

export function createDashboard(sessionsDir: string = DEFAULT_SESSIONS_DIR): void {
  const cfg = loadConfig();

  // --- State module ---
  const state = new DashboardState();
  state.setFilterStale(false);
  state.setFilterCompleted(false);
  state.setStaleThreshold(cfg.staleThresholdMinutes);

  // --- Blessed screen ---
  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: "Pi Agent Dashboard",
    dockBorders: true,
  });

  const titleBox = blessed.box({
    parent: screen,
    top: 0, left: 0, right: 0, height: 3,
    border: { type: "line" },
    label: " {bold}Pi Agent Dashboard{/bold} ",
    tags: true,
  });

  const infoText = blessed.text({
    parent: titleBox,
    top: 0, left: 1,
    tags: true,
    content: "",
  });

  const filterBox = blessed.box({
    parent: screen,
    top: 4, left: 0, right: 0, height: 1,
    tags: true,
    content: "",
  });

  const list = blessed.list({
    parent: screen,
    top: 6, left: 0, right: 0, bottom: 3,
    border: { type: "line" },
    label: " Sessions ",
    tags: true,
    style: {
      selected: { bg: "blue", fg: "white" },
      item: { fg: "white" },
    },
    keys: true,
    mouse: true,
    vi: true,
  });

  const helpBox = blessed.box({
    parent: screen,
    bottom: 0, left: 0, right: 0, height: 2,
    border: { type: "line" },
    tags: true,
    content: "",
  });

  // --- Column widths ---
  function computeColWidths(): { name: number; id: number; cwd: number } {
    const width = (screen.width as number) || 80;
    const available = Math.max(30, width - 64);
    const idWidth = 8;
    const nameWidth = Math.floor(available * 0.35);
    return { name: nameWidth, id: idWidth, cwd: available - nameWidth - idWidth };
  }

  // --- Refresh: scan filesystem, push data into state, re-render ---
  function doRefresh(): void {
    // Scan filesystem
    const result = scanSessions(sessionsDir);
    state.setData(result);

    // Render list
    const rows = state.getVisibleRows();
    const colWidths = computeColWidths();

    if (rows.length === 0) {
      list.setItems(["{gray-fg}  No sessions found. Waiting for Pi sessions to appear...{/}"]);
    } else {
      list.setItems([...rows].map((r) => formatRow(r, colWidths)));
    }

    // Update info
    const filteredNote = (state.filter.hideCompleted || state.filter.hideStale)
      ? ` (filtered from ${state.flatCount})`
      : "";
    infoText.setContent(
      `{dim}${rows.length} session(s) in ${state.rootCount} workspace(s)${filteredNote}{/dim}`,
    );

    // Update filter bar
    const f = state.filter;
    filterBox.setContent(filterBarContent(f.hideCompleted, f.hideStale, f.staleThresholdMinutes));

    // Update help bar
    const counts = state.statusCounts();
    const statusLine = [
      counts.running > 0 ? `{green-fg}● ${counts.running} running{/}` : "",
      counts.completed > 0 ? `{gray-fg}■ ${counts.completed} completed{/}` : "",
      counts.unknown > 0 ? `{yellow-fg}? ${counts.unknown} unknown{/}` : "",
    ].filter(Boolean).join("  ");

    const kb = cfg.keybinds;
    helpBox.setContent(
      `  {bold}${kb.navigateUp}/${kb.navigateDown}{/bold} nav  {bold}${kb.toggleExpand}{/bold} expand  {bold}${kb.refresh}{/bold} refresh  {bold}${kb.quit}{/bold} quit  {bold}${kb.toggleCompleted}{/bold} completed  {bold}${kb.toggleStale}{/bold} stale    ${statusLine}`,
    );

    // Clamp selection and apply
    const selectedIdx = state.clampSelection();
    list.select(selectedIdx);
    screen.render();
  }

  // --- Keybinds (map blessed keys to state mutations, then re-render) ---
  const kb = cfg.keybinds;

  screen.key(kb.quit, () => {
    watcher.close();
    process.exit(0);
  });

  screen.key(kb.refresh, doRefresh);

  screen.key(kb.toggleExpand, () => {
    const idx = state.selectedIndex;
    const rows = state.getVisibleRows();
    if (idx >= 0 && idx < rows.length) {
      state.toggleExpand(rows[idx].session.id);
    }
    doRefresh();
  });

  screen.key(kb.toggleCompleted, () => {
    const f = state.filter;
    state.setFilterCompleted(!f.hideCompleted);
    doRefresh();
  });

  screen.key(kb.toggleStale, () => {
    const f = state.filter;
    state.setFilterStale(!f.hideStale);
    doRefresh();
  });

  screen.key(kb.increaseStaleThreshold, () => {
    state.setStaleThreshold(state.filter.staleThresholdMinutes + 1);
    doRefresh();
  });

  screen.key(kb.decreaseStaleThreshold, () => {
    state.setStaleThreshold(state.filter.staleThresholdMinutes - 1);
    doRefresh();
  });

  // Blessed list handles up/down internally; sync selection on click/select
  list.on("select", (_item, index: number) => {
    state.selectedIndex = index;
    const rows = state.getVisibleRows();
    if (index >= 0 && index < rows.length && rows[index].hasChildren) {
      state.toggleExpand(rows[index].session.id);
      doRefresh();
    }
  });

  // --- File watching ---
  const watcher = watch(sessionsDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  watcher.on("add", () => scheduleRefresh());
  watcher.on("change", () => scheduleRefresh());
  watcher.on("unlink", () => scheduleRefresh());
  watcher.on("addDir", () => scheduleRefresh());
  watcher.on("unlinkDir", () => scheduleRefresh());

  function scheduleRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(doRefresh, REFRESH_DEBOUNCE_MS);
  }

  // --- Initial render ---
  screen.on("resize", doRefresh);
  doRefresh();
  list.focus();
}
