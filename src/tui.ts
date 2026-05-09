/**
 * Blessed TUI for the Pi Agent Dashboard.
 *
 * Displays Pi agent sessions as a navigable tree with status indicators,
 * filter toggles, and configurable keybinds.
 */

import * as os from "node:os";
import * as path from "node:path";
import blessed from "blessed";
import { watch } from "chokidar";
import { loadConfig, type Config } from "./config.js";
import { scanSessions } from "./scanner.js";
import type { ScanResult, SessionInfo, SessionTree } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");
const REFRESH_DEBOUNCE_MS = 500;

// ---------------------------------------------------------------------------
// UI helpers
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

// ---------------------------------------------------------------------------
// Row rendering
// ---------------------------------------------------------------------------

interface VisibleRow {
  session: SessionInfo;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  indent: string;
}

/**
 * Flatten a session tree into visible rows, applying filters.
 */
function flattenTree(
  tree: SessionTree,
  expanded: Set<string>,
  hideCompleted: boolean,
  hideStale: boolean,
  staleThresholdMs: number,
): VisibleRow[] {
  const rows: VisibleRow[] = [];
  const now = Date.now();

  function isFiltered(session: SessionInfo): boolean {
    if (hideCompleted && session.status === "completed") return true;
    if (hideStale && session.status === "running") {
      const started = new Date(session.startedAt).getTime();
      if (started > 0 && now - started > staleThresholdMs) return true;
    }
    return false;
  }

  function appendRootChildren(
    out: VisibleRow[],
    children: SessionInfo[],
    depth: number,
  ): void {
    const indentUnit = "    ";
    for (const child of children) {
      if (isFiltered(child)) continue;

      const grandchildren = tree.children.get(child.id) ?? [];
      const hasGrandchildren = grandchildren.length > 0;
      const isExpanded = expanded.has(child.id);
      const indent = indentUnit.repeat(depth - 1) + (depth > 1 ? "  ├── " : "  ├── ");

      out.push({
        session: child,
        depth,
        expanded: isExpanded,
        hasChildren: hasGrandchildren,
        indent,
      });

      if (isExpanded && hasGrandchildren) {
        appendRootChildren(out, grandchildren, depth + 1);
      }
    }
  }

  for (const root of tree.roots) {
    if (isFiltered(root)) continue;

    const childList = tree.children.get(root.id) ?? [];
    const hasChildren = childList.length > 0;
    const isExpanded = expanded.has(root.id);

    rows.push({
      session: root,
      depth: 0,
      expanded: isExpanded,
      hasChildren,
      indent: "",
    });

    if (isExpanded && hasChildren) {
      appendRootChildren(rows, childList, 1);
    }
  }

  return rows;
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
  // --- Load config ---
  const cfg = loadConfig();

  // --- Blessed screen ---
  const screen = blessed.screen({
    smartCSR: true,
    fullUnicode: true,
    title: "Pi Agent Dashboard",
    dockBorders: true,
  });

  // --- Title box ---
  const titleBox = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    right: 0,
    height: 3,
    border: { type: "line" },
    label: " {bold}Pi Agent Dashboard{/bold} ",
    tags: true,
  });

  const infoText = blessed.text({
    parent: titleBox,
    top: 0,
    left: 1,
    tags: true,
    content: "",
  });

  // --- Filter bar ---
  const filterBox = blessed.box({
    parent: screen,
    top: 4,
    left: 0,
    right: 0,
    height: 1,
    tags: true,
    content: filterBarContent(false, false, cfg.staleThresholdMinutes),
  });

  // --- Session list ---
  const list = blessed.list({
    parent: screen,
    top: 6,
    left: 0,
    right: 0,
    bottom: 3,
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

  // --- Help bar ---
  const helpBox = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    right: 0,
    height: 2,
    border: { type: "line" },
    tags: true,
    content: "",
  });

  // --- State ---
  let scanResult: ScanResult = { flat: [], tree: { roots: [], children: new Map() } };
  let visibleRows: VisibleRow[] = [];
  const expanded = new Set<string>();
  let selectedIdx = 0;

  // Filter state
  let hideCompleted = false;
  let hideStale = false;
  let staleThresholdMinutes = cfg.staleThresholdMinutes;

  // --- Column widths ---
  function computeColWidths(): { name: number; id: number; cwd: number } {
    const width = (screen.width as number) || 80;
    const available = Math.max(30, width - 64);
    const idWidth = 8;
    const nameWidth = Math.floor(available * 0.35);
    const cwdWidth = available - nameWidth - idWidth;
    return { name: nameWidth, id: idWidth, cwd: cwdWidth };
  }

  // --- Render ---
  function render(): void {
    scanResult = scanSessions(sessionsDir);
    const staleThresholdMs = staleThresholdMinutes * 60 * 1000;
    visibleRows = flattenTree(scanResult.tree, expanded, hideCompleted, hideStale, staleThresholdMs);

    const colWidths = computeColWidths();

    if (visibleRows.length === 0) {
      list.setItems(["{gray-fg}  No sessions found. Waiting for Pi sessions to appear...{/}"]);
    } else {
      list.setItems(visibleRows.map((row) => formatRow(row, colWidths)));
    }

    const totalFiltered = hideCompleted || hideStale
      ? ` (filtered from ${scanResult.flat.length})`
      : "";
    infoText.setContent(
      `{dim}${visibleRows.length} session(s) in ${scanResult.tree.roots.length} workspace(s)${totalFiltered}{/dim}`,
    );

    filterBox.setContent(filterBarContent(hideCompleted, hideStale, staleThresholdMinutes));

    const runningCount = scanResult.flat.filter((s) => s.status === "running").length;
    const completedCount = scanResult.flat.filter((s) => s.status === "completed").length;
    const unknownCount = scanResult.flat.filter((s) => s.status === "unknown").length;
    const statusLine = [
      runningCount > 0 ? `{green-fg}● ${runningCount} running{/}` : "",
      completedCount > 0 ? `{gray-fg}■ ${completedCount} completed{/}` : "",
      unknownCount > 0 ? `{yellow-fg}? ${unknownCount} unknown{/}` : "",
    ].filter(Boolean).join("  ");

    const kb = cfg.keybinds;
    helpBox.setContent(
      `  {bold}${kb.navigateUp}/${kb.navigateDown}{/bold} nav  {bold}${kb.toggleExpand}{/bold} expand  {bold}${kb.refresh}{/bold} refresh  {bold}${kb.quit}{/bold} quit  {bold}${kb.toggleCompleted}{/bold} completed  {bold}${kb.toggleStale}{/bold} stale    ${statusLine}`,
    );

    screen.render();
  }

  function doRefresh(): void {
    render();
    clampSelection();
    list.select(selectedIdx);
    screen.render();
  }

  function toggleExpandAt(idx: number): void {
    if (idx < 0 || idx >= visibleRows.length) return;
    const row = visibleRows[idx];
    if (!row.hasChildren) return;
    const id = row.session.id;
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
    render();
    clampSelection();
    list.select(selectedIdx);
    screen.render();
  }

  function clampSelection(): void {
    if (visibleRows.length === 0) { selectedIdx = 0; return; }
    if (selectedIdx >= visibleRows.length) selectedIdx = visibleRows.length - 1;
    if (selectedIdx < 0) selectedIdx = 0;
  }

  // --- Register keybinds from config ---
  const kb = cfg.keybinds;

  screen.key(kb.quit, () => {
    watcher.close();
    process.exit(0);
  });

  screen.key(kb.refresh, doRefresh);
  screen.key(kb.toggleExpand, () => toggleExpandAt(selectedIdx));

  screen.key(kb.toggleCompleted, () => {
    hideCompleted = !hideCompleted;
    render();
    clampSelection();
    list.select(selectedIdx);
    screen.render();
  });

  screen.key(kb.toggleStale, () => {
    hideStale = !hideStale;
    render();
    clampSelection();
    list.select(selectedIdx);
    screen.render();
  });

  screen.key(kb.increaseStaleThreshold, () => {
    staleThresholdMinutes = Math.min(staleThresholdMinutes + 1, 120);
    render();
  });

  screen.key(kb.decreaseStaleThreshold, () => {
    staleThresholdMinutes = Math.max(staleThresholdMinutes - 1, 1);
    render();
  });

  // Blessed list handles up/down internally.
  list.on("select", (_item, index: number) => {
    selectedIdx = index;
    if (index >= 0 && index < visibleRows.length && visibleRows[index].hasChildren) {
      toggleExpandAt(index);
    }
  });

  // --- Auto-refresh with chokidar ---
  const watcher = watch(sessionsDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(doRefresh, REFRESH_DEBOUNCE_MS);
  }

  watcher.on("add", scheduleRefresh);
  watcher.on("change", scheduleRefresh);
  watcher.on("unlink", scheduleRefresh);
  watcher.on("addDir", scheduleRefresh);
  watcher.on("unlinkDir", scheduleRefresh);

  // --- Initial render ---
  screen.on("resize", doRefresh);
  doRefresh();
  list.focus();
}
