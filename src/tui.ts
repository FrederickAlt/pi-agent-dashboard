/**
 * Blessed TUI for the Pi Agent Dashboard.
 *
 * Displays Pi agent sessions as a navigable tree with status indicators.
 * Uses `scanSessions` from the data layer for session discovery.
 */

import * as os from "node:os";
import * as path from "node:path";
import blessed from "blessed";
import { watch } from "chokidar";
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

/** Truncate a string to `maxLen` characters, adding ellipsis if needed. */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 1) + "…";
}

/** Shorten a session ID to its last N hex characters. */
function shortId(id: string, n = 6): string {
  return id.slice(-n);
}

/** Return a blessed color tag for the given status. */
function statusColor(status: string): string {
  switch (status) {
    case "running":
      return "green";
    case "completed":
      return "gray";
    default:
      return "yellow";
  }
}

/** Return the status indicator character for the given status. */
function statusChar(status: string): string {
  switch (status) {
    case "running":
      return "●";
    case "completed":
      return "■";
    default:
      return "?";
  }
}

/** Return the expand indicator for a node. */
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

/** Flatten a session tree into a list of visible rows, respecting expanded set. */
function flattenTree(
  tree: SessionTree,
  expanded: Set<string>,
): VisibleRow[] {
  const rows: VisibleRow[] = [];

  for (const root of tree.roots) {
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
      appendChildren(rows, tree, childList, expanded, 1);
    }
  }

  return rows;
}

/** Recursively append child rows. */
function appendChildren(
  out: VisibleRow[],
  tree: SessionTree,
  children: SessionInfo[],
  expanded: Set<string>,
  depth: number,
): void {
  const indentUnit = "    ";
  for (const child of children) {
    const grandchildren = tree.children.get(child.id) ?? [];
    const hasGrandchildren = grandchildren.length > 0;
    const isExpanded = expanded.has(child.id);
    const indent = indentUnit.repeat(depth - 1) + "  ├── ";

    out.push({
      session: child,
      depth,
      expanded: isExpanded,
      hasChildren: hasGrandchildren,
      indent,
    });

    if (isExpanded && hasGrandchildren) {
      appendChildren(out, tree, grandchildren, expanded, depth + 1);
    }
  }
}

/** Format a visible row into a blessed text string with markup. */
function formatRow(row: VisibleRow, colWidths: { name: number; id: number; cwd: number }): string {
  const { session, depth, hasChildren, indent } = row;
  const color = statusColor(session.status);
  const char = statusChar(session.status);

  // Expand indicator
  const expand = hasChildren ? expandIcon(row.expanded) : "  ";

  // Name column
  const name = session.displayName ?? (session.isMain ? "main session" : (session.agentType ?? "session"));
  const nameField = truncate(name, colWidths.name);

  // ID column
  const idField = shortId(session.id);

  // CWD column
  const cwdField = truncate(session.cwd || session.workspace, colWidths.cwd);

  const closeColor = `{/${color}-fg}`;
  const openColor = `{${color}-fg}`;
  return `${openColor}${indent}${expand}{/}{bold}${nameField}{/bold}{/}  {gray-fg}${idField}{/}  {dim}${cwdField}{/dim}  ${openColor}${char} ${session.status}${closeColor}`;
}

// ---------------------------------------------------------------------------
// TUI
// ---------------------------------------------------------------------------

export function createDashboard(sessionsDir: string = DEFAULT_SESSIONS_DIR): void {
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

  // --- Session list ---
  const list = blessed.list({
    parent: screen,
    top: 4,
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

  // --- Column widths (computed on each render) ---
  function computeColWidths(): { name: number; id: number; cwd: number } {
    const width = (screen.width as number) || 80;
    // Reserve space for: indent (max ~40), expand icon (2), separators (~6), status (~12), borders/padding (~4)
    const available = Math.max(30, width - 64);
    // Split: name 35%, id 8 chars fixed, cwd gets the rest
    const idWidth = 8;
    const nameWidth = Math.floor(available * 0.35);
    const cwdWidth = available - nameWidth - idWidth;
    return { name: nameWidth, id: idWidth, cwd: cwdWidth };
  }

  // --- Render ---
  function render(): void {
    scanResult = scanSessions(sessionsDir);
    visibleRows = flattenTree(scanResult.tree, expanded);

    const colWidths = computeColWidths();

    if (visibleRows.length === 0) {
      list.setItems(["{gray-fg}  No sessions found. Waiting for Pi sessions to appear...{/}"]);
    } else {
      list.setItems(visibleRows.map((row) => formatRow(row, colWidths)));
    }

    infoText.setContent(
      `{dim}${scanResult.flat.length} session(s) in ${scanResult.tree.roots.length} workspace(s){/dim}`,
    );

    const runningCount = scanResult.flat.filter((s) => s.status === "running").length;
    const completedCount = scanResult.flat.filter((s) => s.status === "completed").length;
    const unknownCount = scanResult.flat.filter((s) => s.status === "unknown").length;
    const statusLine = [
      runningCount > 0 ? `{green-fg}● ${runningCount} running{/}` : "",
      completedCount > 0 ? `{gray-fg}■ ${completedCount} completed{/}` : "",
      unknownCount > 0 ? `{yellow-fg}? ${unknownCount} unknown{/}` : "",
    ].filter(Boolean).join("  ");

    helpBox.setContent(
      `  {bold}↑/↓{/bold} navigate  {bold}Enter{/bold} expand/collapse  {bold}r{/bold} refresh  {bold}q{/bold} quit    ${statusLine}`,
    );

    screen.render();
  }

  // --- Keyboard shortcuts ---
  screen.key("q", () => {
    watcher.close();
    process.exit(0);
  });

  screen.key("r", () => {
    render();
    clampSelection();
    list.select(selectedIdx);
    screen.render();
  });

  screen.key("enter", () => {
    toggleExpand(selectedIdx);
  });

  // Blessed list handles up/down internally; we just need to sync our index.
  // Track selection changes via the select event.
  list.on("select", (_item, index: number) => {
    selectedIdx = index;
    // If clicked on a node with children, toggle expand
    if (index >= 0 && index < visibleRows.length && visibleRows[index].hasChildren) {
      toggleExpand(index);
    }
  });

  function toggleExpand(idx: number): void {
    if (idx < 0 || idx >= visibleRows.length) return;
    const row = visibleRows[idx];
    if (!row.hasChildren) return;
    const id = row.session.id;
    if (expanded.has(id)) {
      expanded.delete(id);
    } else {
      expanded.add(id);
    }
    render();
    clampSelection();
    list.select(selectedIdx);
    screen.render();
  }

  function clampSelection(): void {
    if (visibleRows.length === 0) {
      selectedIdx = 0;
      return;
    }
    if (selectedIdx >= visibleRows.length) selectedIdx = visibleRows.length - 1;
    if (selectedIdx < 0) selectedIdx = 0;
  }

  // --- Auto-refresh with chokidar ---
  const watcher = watch(sessionsDir, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
  });

  let refreshTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleRefresh(): void {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      render();
    }, REFRESH_DEBOUNCE_MS);
  }

  watcher.on("add", scheduleRefresh);
  watcher.on("change", scheduleRefresh);
  watcher.on("unlink", scheduleRefresh);
  watcher.on("addDir", scheduleRefresh);
  watcher.on("unlinkDir", scheduleRefresh);

  // --- Initial render ---
  screen.on("resize", () => render());
  render();
  list.focus();
}
