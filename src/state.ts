/**
 * DashboardState — pure state module for the session dashboard.
 *
 * Owns all session data, tree flattening, filtering, expand/collapse,
 * and selection logic.  The blessed TUI becomes a thin adapter that reads
 * state through this module and dispatches mutations.
 *
 * @module
 */

import type { ScanResult, SessionInfo, SessionTree } from "./types.js";

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

export interface FilterState {
  hideCompleted: boolean;
  hideStale: boolean;
  staleThresholdMinutes: number;
}

const DEFAULT_FILTER: FilterState = {
  hideCompleted: false,
  hideStale: false,
  staleThresholdMinutes: 5,
};

// ---------------------------------------------------------------------------
// Visible row (view-model)
// ---------------------------------------------------------------------------

export interface VisibleRow {
  session: SessionInfo;
  depth: number;
  expanded: boolean;
  hasChildren: boolean;
  indent: string;
}

// ---------------------------------------------------------------------------
// DashboardState
// ---------------------------------------------------------------------------

export class DashboardState {
  private _tree: SessionTree = { roots: [], children: new Map() };
  private _flat: SessionInfo[] = [];
  private _expanded = new Set<string>();
  private _filter: FilterState = { ...DEFAULT_FILTER };
  private _selectedIdx = 0;

  // Cached visible rows, invalidated on mutation.
  private _rows: VisibleRow[] = [];

  // --- Data ingestion ---

  /** Replace the underlying session data and rebuild visible rows. */
  setData(result: ScanResult): void {
    this._tree = result.tree;
    this._flat = result.flat;
    this._rebuild();
  }

  /** The raw flat scan result (pre-filter). */
  get flatCount(): number {
    return this._flat.length;
  }

  // --- Visible rows ---

  /** Return the currently visible rows (post-filter, post-expand). */
  getVisibleRows(): readonly VisibleRow[] {
    return this._rows;
  }

  // --- Expand / collapse ---

  /**
   * Toggle the expanded state of a node.  Returns true when the node
   * actually has children (i.e. the toggle is meaningful).
   */
  toggleExpand(id: string): boolean {
    // Check if the node actually has children in the tree
    const children = this._tree.children.get(id);
    if (!children || children.length === 0) return false;

    if (this._expanded.has(id)) {
      this._expanded.delete(id);
    } else {
      this._expanded.add(id);
    }
    this._rebuild();
    return true;
  }

  /** Whether a node is currently expanded. */
  isExpanded(id: string): boolean {
    return this._expanded.has(id);
  }

  // --- Filter ---

  get filter(): FilterState {
    return this._filter;
  }

  setFilterCompleted(hide: boolean): void {
    if (this._filter.hideCompleted === hide) return;
    this._filter = { ...this._filter, hideCompleted: hide };
    this._rebuild();
  }

  setFilterStale(hide: boolean): void {
    if (this._filter.hideStale === hide) return;
    this._filter = { ...this._filter, hideStale: hide };
    this._rebuild();
  }

  setStaleThreshold(minutes: number): void {
    const clamped = Math.max(1, Math.min(minutes, 120));
    if (this._filter.staleThresholdMinutes === clamped) return;
    this._filter = { ...this._filter, staleThresholdMinutes: clamped };
    this._rebuild();
  }

  // --- Selection ---

  get selectedIndex(): number {
    return this._selectedIdx;
  }

  set selectedIndex(idx: number) {
    this._selectedIdx = idx;
  }

  /** Clamp selection to visible rows, then return the valid index. */
  clampSelection(): number {
    if (this._rows.length === 0) {
      this._selectedIdx = 0;
      return 0;
    }
    if (this._selectedIdx >= this._rows.length) {
      this._selectedIdx = this._rows.length - 1;
    }
    if (this._selectedIdx < 0) {
      this._selectedIdx = 0;
    }
    return this._selectedIdx;
  }

  // --- Stats (for the help bar) ---

  /**
   * Return status counts from the unfiltered flat list so the help bar
   * shows totals even when filters hide rows.
   */
  statusCounts(): { running: number; completed: number; unknown: number } {
    let running = 0;
    let completed = 0;
    let unknown = 0;
    for (const s of this._flat) {
      if (s.status === "running") running++;
      else if (s.status === "completed") completed++;
      else unknown++;
    }
    return { running, completed, unknown };
  }

  /** Number of root (main) sessions in the tree. */
  get rootCount(): number {
    return this._tree.roots.length;
  }

  // --- Internal: rebuild visible rows ---

  private _rebuild(): void {
    const staleMs = this._filter.staleThresholdMinutes * 60 * 1000;
    const now = Date.now();

    this._rows = this._flattenRoots(this._tree.roots, this._filter, staleMs, now);
    this.clampSelection();
  }

  private _flattenRoots(
    roots: SessionInfo[],
    filter: FilterState,
    staleMs: number,
    now: number,
  ): VisibleRow[] {
    const out: VisibleRow[] = [];

    for (const root of roots) {
      if (this._isFiltered(root, filter, staleMs, now)) continue;

      const childList = this._tree.children.get(root.id) ?? [];
      const hasChildren = childList.length > 0;
      const isExpanded = this._expanded.has(root.id);

      out.push({
        session: root,
        depth: 0,
        expanded: isExpanded,
        hasChildren,
        indent: "",
      });

      if (isExpanded && hasChildren) {
        this._appendChildren(out, childList, filter, staleMs, now, 1);
      }
    }

    return out;
  }

  private _appendChildren(
    out: VisibleRow[],
    children: SessionInfo[],
    filter: FilterState,
    staleMs: number,
    now: number,
    depth: number,
  ): void {
    const indentUnit = "    ";
    for (const child of children) {
      if (this._isFiltered(child, filter, staleMs, now)) continue;

      const grandchildren = this._tree.children.get(child.id) ?? [];
      const hasGrandchildren = grandchildren.length > 0;
      const isExpanded = this._expanded.has(child.id);
      const indent = indentUnit.repeat(depth - 1) + (depth > 1 ? "  ├── " : "  ├── ");

      out.push({
        session: child,
        depth,
        expanded: isExpanded,
        hasChildren: hasGrandchildren,
        indent,
      });

      if (isExpanded && hasGrandchildren) {
        this._appendChildren(out, grandchildren, filter, staleMs, now, depth + 1);
      }
    }
  }

  private _isFiltered(
    session: SessionInfo,
    filter: FilterState,
    staleMs: number,
    now: number,
  ): boolean {
    if (filter.hideCompleted && session.status === "completed") return true;
    if (filter.hideStale && session.status === "running") {
      const started = new Date(session.startedAt).getTime();
      if (started > 0 && now - started > staleMs) return true;
    }
    return false;
  }
}
