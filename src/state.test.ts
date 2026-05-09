import { describe, expect, test, beforeEach } from "vitest";
import { DashboardState } from "./state.js";
import type { ScanResult, SessionInfo } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers to build test data
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "019e0000-0000-7000-0000-000000000001",
    workspace: "--test--",
    cwd: "/home/test/project",
    startedAt: "2026-05-09T12:00:00.000Z",
    status: "running",
    isMain: true,
    ...overrides,
  };
}

function makeFlat(flat: SessionInfo[]): SessionInfo[] {
  return flat;
}

function buildTree(roots: SessionInfo[], children: Map<string, SessionInfo[]>): { roots: SessionInfo[]; children: Map<string, SessionInfo[]> } {
  return { roots, children };
}

function result(roots: SessionInfo[], childrenMap: Map<string, SessionInfo[]>, flat: SessionInfo[]): ScanResult {
  return { flat, tree: { roots, children: childrenMap } };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("DashboardState", () => {
  let state: DashboardState;

  beforeEach(() => {
    state = new DashboardState();
    state.setFilterStale(false);
    state.setFilterCompleted(false);
  });

  describe("empty state", () => {
    test("returns empty visible rows on init", () => {
      const result: ScanResult = { flat: [], tree: { roots: [], children: new Map() } };
      state.setData(result);
      expect(state.getVisibleRows()).toHaveLength(0);
      expect(state.flatCount).toBe(0);
      expect(state.rootCount).toBe(0);
    });

    test("selection is 0 on empty", () => {
      const result: ScanResult = { flat: [], tree: { roots: [], children: new Map() } };
      state.setData(result);
      expect(state.clampSelection()).toBe(0);
      expect(state.selectedIndex).toBe(0);
    });
  });

  describe("flat sessions (no tree)", () => {
    test("shows all root sessions as flat list", () => {
      const r1 = makeSession({ id: "r1", cwd: "/a" });
      const r2 = makeSession({ id: "r2", cwd: "/b" });
      state.setData(result([r1, r2], new Map(), [r1, r2]));

      const rows = state.getVisibleRows();
      expect(rows).toHaveLength(2);
      expect(rows[0].session.id).toBe("r1");
      expect(rows[1].session.id).toBe("r2");
      expect(rows[0].hasChildren).toBe(false);
    });
  });

  describe("tree with children", () => {
    test("roots show hasChildren when they have sub-agents", () => {
      const root = makeSession({ id: "root" });
      const child = makeSession({ id: "child", isMain: false, parentAgentId: "root", agentType: "Explore", displayName: "Explore Tom", depth: 1 });
      const children = new Map([["root", [child]]]);
      state.setData(result([root], children, [root, child]));

      const rows = state.getVisibleRows();
      expect(rows).toHaveLength(1); // only root visible (collapsed)
      expect(rows[0].hasChildren).toBe(true);
      expect(rows[0].expanded).toBe(false);
    });

    test("expanding a root shows its children", () => {
      const root = makeSession({ id: "root" });
      const child = makeSession({ id: "child", isMain: false, parentAgentId: "root", agentType: "Explore", displayName: "Explore Tom", depth: 1 });
      const children = new Map([["root", [child]]]);
      state.setData(result([root], children, [root, child]));

      state.toggleExpand("root");
      const rows = state.getVisibleRows();
      expect(rows).toHaveLength(2);
      expect(rows[0].session.id).toBe("root");
      expect(rows[0].expanded).toBe(true);
      expect(rows[1].session.id).toBe("child");
      expect(rows[1].depth).toBe(1);
    });

    test("toggling again collapses children", () => {
      const root = makeSession({ id: "root" });
      const child = makeSession({ id: "child", isMain: false, parentAgentId: "root", agentType: "Explore", depth: 1 });
      const children = new Map([["root", [child]]]);
      state.setData(result([root], children, [root, child]));

      state.toggleExpand("root");
      expect(state.getVisibleRows()).toHaveLength(2);

      state.toggleExpand("root");
      expect(state.getVisibleRows()).toHaveLength(1);
    });

    test("toggleExpand returns false when node has no children", () => {
      const root = makeSession({ id: "root" });
      state.setData(result([root], new Map(), [root]));
      expect(state.toggleExpand("root")).toBe(false);
      expect(state.isExpanded("root")).toBe(false);
    });

    test("nested grandchildren expand correctly", () => {
      const root = makeSession({ id: "root" });
      const child = makeSession({ id: "child", isMain: false, parentAgentId: "root", agentType: "Explore", depth: 1 });
      const grandchild = makeSession({ id: "gc", isMain: false, parentAgentId: "child", agentType: "Planner", depth: 2 });
      const children = new Map([
        ["root", [child]],
        ["child", [grandchild]],
      ]);
      state.setData(result([root], children, [root, child, grandchild]));

      // Only root visible
      expect(state.getVisibleRows()).toHaveLength(1);

      // Expand root → root + child
      state.toggleExpand("root");
      expect(state.getVisibleRows()).toHaveLength(2);

      // Expand child → root + child + grandchild
      state.toggleExpand("child");
      const rows = state.getVisibleRows();
      expect(rows).toHaveLength(3);
      expect(rows[2].session.id).toBe("gc");
      expect(rows[2].depth).toBe(2);
    });
  });

  describe("filter: hide completed", () => {
    test("hides completed sessions when filter is on", () => {
      const running = makeSession({ id: "r1", status: "running" });
      const completed = makeSession({ id: "r2", status: "completed" });
      state.setData(result([running, completed], new Map(), [running, completed]));

      expect(state.getVisibleRows()).toHaveLength(2);

      state.setFilterCompleted(true);
      const rows = state.getVisibleRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].session.id).toBe("r1");
    });

    test("does not hide completed when filter is off", () => {
      const completed = makeSession({ id: "r2", status: "completed" });
      state.setData(result([completed], new Map(), [completed]));
      expect(state.getVisibleRows()).toHaveLength(1);
    });
  });

  describe("filter: hide stale", () => {
    test("hides running sessions older than threshold", () => {
      const old = makeSession({
        id: "old",
        status: "running",
        startedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
      });
      const fresh = makeSession({
        id: "fresh",
        status: "running",
        startedAt: new Date().toISOString(), // now
      });
      state.setData(result([old, fresh], new Map(), [old, fresh]));
      state.setStaleThreshold(5); // 5 min threshold

      expect(state.getVisibleRows()).toHaveLength(2);

      state.setFilterStale(true);
      const rows = state.getVisibleRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].session.id).toBe("fresh");
    });

    test("adjustable stale threshold", () => {
      const session = makeSession({
        id: "s1",
        status: "running",
        startedAt: new Date(Date.now() - 7 * 60 * 1000).toISOString(), // 7 min ago
      });
      state.setData(result([session], new Map(), [session]));
      state.setFilterStale(true);

      // 5 min threshold → filtered out
      state.setStaleThreshold(5);
      expect(state.getVisibleRows()).toHaveLength(0);

      // 10 min threshold → visible
      state.setStaleThreshold(10);
      expect(state.getVisibleRows()).toHaveLength(1);
    });
  });

  describe("combined filters", () => {
    test("hides both completed and stale simultaneously", () => {
      const running = makeSession({ id: "r1", status: "running", startedAt: new Date().toISOString() });
      const completed = makeSession({ id: "r2", status: "completed" });
      const stale = makeSession({ id: "r3", status: "running", startedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString() });

      state.setData(result([running, completed, stale], new Map(), [running, completed, stale]));
      state.setStaleThreshold(5);
      state.setFilterCompleted(true);
      state.setFilterStale(true);

      const rows = state.getVisibleRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].session.id).toBe("r1");
    });
  });

  describe("selection clamping", () => {
    test("clamps selection to visible range", () => {
      const r1 = makeSession({ id: "r1" });
      const r2 = makeSession({ id: "r2" });
      state.setData(result([r1, r2], new Map(), [r1, r2]));

      state.selectedIndex = 5; // beyond range
      expect(state.clampSelection()).toBe(1);
      expect(state.selectedIndex).toBe(1);
    });

    test("selection resets to 0 when list is empty", () => {
      state.setData(result([], new Map(), []));
      state.selectedIndex = 3;
      state.clampSelection();
      expect(state.selectedIndex).toBe(0);
    });
  });

  describe("statusCounts", () => {
    test("counts all statuses from flat list", () => {
      const sessions = [
        makeSession({ id: "r1", status: "running" }),
        makeSession({ id: "r2", status: "running" }),
        makeSession({ id: "c1", status: "completed" }),
        makeSession({ id: "u1", status: "unknown" }),
      ];
      state.setData(result(sessions, new Map(), sessions));

      const counts = state.statusCounts();
      expect(counts.running).toBe(2);
      expect(counts.completed).toBe(1);
      expect(counts.unknown).toBe(1);
    });
  });

  describe("filter state", () => {
    test("filter getter reflects current state", () => {
      state.setStaleThreshold(10);
      state.setFilterCompleted(true);
      state.setFilterStale(true);

      expect(state.filter).toEqual({
        hideCompleted: true,
        hideStale: true,
        staleThresholdMinutes: 10,
      });
    });

    test("setStaleThreshold clamps to 1-120 range", () => {
      state.setStaleThreshold(0);
      expect(state.filter.staleThresholdMinutes).toBe(1);

      state.setStaleThreshold(200);
      expect(state.filter.staleThresholdMinutes).toBe(120);
    });
  });

  describe("no-op guards", () => {
    test("setting same filter value does not rebuild", () => {
      const r1 = makeSession({ id: "r1" });
      state.setData(result([r1], new Map(), [r1]));
      const rows1 = state.getVisibleRows();

      // Setting same value should not change anything
      state.setFilterCompleted(false); // already false
      const rows2 = state.getVisibleRows();

      expect(rows2).toHaveLength(rows1.length);
    });
  });
});
