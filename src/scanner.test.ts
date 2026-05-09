/**
 * Tests for the session scanner library.
 *
 * Uses `vi.mock("node:fs")` to create an in-memory filesystem so tests
 * are fast, deterministic, and free of side effects.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { scanSessions } from "./scanner.js";
import type { ScanResult, SessionInfo } from "./types.js";

// ---------------------------------------------------------------------------
// In-memory filesystem
// ---------------------------------------------------------------------------

type FileEntry =
  | { type: "file"; content: string }
  | { type: "dir"; children: Map<string, FileEntry> };

let memFs: Map<string, FileEntry>;

function resetFs(): void {
  memFs = new Map();
}

function ensureDir(fsPath: string): Map<string, FileEntry> {
  const parts = fsPath.replace(/^\//, "").split("/").filter(Boolean);
  let node = memFs;
  for (const part of parts) {
    let entry = node.get(part);
    if (!entry || entry.type !== "dir") {
      entry = { type: "dir", children: new Map() };
      node.set(part, entry);
    }
    node = entry.children;
  }
  return node;
}

function writeFile(fsPath: string, content: string): void {
  const parts = fsPath.replace(/^\//, "").split("/").filter(Boolean);
  const fileName = parts.pop()!;
  const dir = ensureDir("/" + parts.join("/"));
  dir.set(fileName, { type: "file", content });
}

function getEntry(fsPath: string): FileEntry | undefined {
  const parts = fsPath.replace(/^\//, "").split("/").filter(Boolean);
  let node: FileEntry | undefined = { type: "dir", children: memFs };
  for (const part of parts) {
    if (!node || node.type !== "dir") return undefined;
    node = node.children.get(part);
  }
  return node;
}

// ---------------------------------------------------------------------------
// Mock fs
// ---------------------------------------------------------------------------

vi.mock("node:fs", () => {
  function statSyncError(path: string): Error {
    const err = new Error(`ENOENT: no such file or directory, stat '${path}'`);
    (err as any).code = "ENOENT";
    return err;
  }

  return {
    openSync(fp: string, _flags: string) {
      const entry = getEntry(fp);
      if (!entry || entry.type !== "file") throw statSyncError(fp);
      // Return a fake fd (just the path so we can look it up later)
      return fp;
    },
    closeSync(_fd: unknown): void {
      // no-op
    },
    readSync(
      _fd: unknown,
      buf: Buffer,
      off: number,
      len: number,
      pos: number,
    ): number {
      const fp = _fd as string;
      const entry = getEntry(fp);
      if (!entry || entry.type !== "file") throw statSyncError(fp);
      const content = Buffer.from(entry.content, "utf-8");
      const slice = content.subarray(pos, pos + len);
      slice.copy(buf, off);
      return slice.length;
    },
    readFileSync(fp: string, _encoding: string): string {
      const entry = getEntry(fp);
      if (!entry || entry.type !== "file") throw statSyncError(fp);
      return entry.content;
    },
    readdirSync(
      fp: string,
      options?: { withFileTypes?: boolean },
    ): string[] | { name: string; isDirectory: () => boolean; isFile: () => boolean; isSymbolicLink: () => boolean }[] {
      const entry = getEntry(fp);
      if (!entry || entry.type !== "dir") throw statSyncError(fp);
      const names = Array.from(entry.children.keys());
      if (options?.withFileTypes) {
        return names.map((name) => {
          const child = entry.children.get(name)!;
          return {
            name,
            isDirectory: () => child.type === "dir",
            isFile: () => child.type === "file",
            isSymbolicLink: () => false,
          };
        });
      }
      return names;
    },
    existsSync(fp: string): boolean {
      return getEntry(fp) !== undefined;
    },
    mkdirSync(_fp: string, _opts?: any): void {
      ensureDir(_fp);
    },
    writeFileSync(fp: string, data: string, _encoding?: string): void {
      writeFile(fp, data);
    },
    renameSync(_old: string, _new: string): void {
      // Not needed for scanner tests
    },
    unlinkSync(_fp: string): void {
      // Not needed for scanner tests
    },
  };
});

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid session event line. */
function sessionLine(opts: {
  id: string;
  timestamp?: string;
  cwd?: string;
}): string {
  return JSON.stringify({
    type: "session",
    version: "3",
    id: opts.id,
    timestamp: opts.timestamp ?? "2025-01-15T10:00:00.000Z",
    cwd: opts.cwd ?? "/home/user/project",
  });
}

/** Build a valid .pi-status.json content. */
function piStatusJson(opts: {
  pid?: number;
  status?: "running" | "completed";
  startedAt?: string;
  endedAt?: string;
}): string {
  return JSON.stringify({
    pid: opts.pid ?? 12345,
    status: opts.status ?? "running",
    startedAt: opts.startedAt ?? "2025-01-15T10:00:00.000Z",
    endedAt: opts.endedAt,
  });
}

/** Build a valid .task-subagents-*.json content. */
function subagentsJson(opts: {
  mainSessionId: string;
  records: Array<{
    id: string;
    humanName: string;
    displayName: string;
    agentType: string;
    sessionFile: string;
    parentAgentId?: string;
    depth: number;
    createdAt: string;
    updatedAt: string;
  }>;
}): string {
  return JSON.stringify(
    {
      version: 1,
      mainSessionId: opts.mainSessionId,
      records: opts.records,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("scanSessions", () => {
  beforeEach(() => {
    resetFs();
  });

  it("returns empty result for non-existent directory", () => {
    const result = scanSessions("/nonexistent");
    expect(result.flat).toEqual([]);
    expect(result.tree.roots).toEqual([]);
    expect(result.tree.children.size).toBe(0);
  });

  it("returns empty result for empty sessions directory", () => {
    ensureDir("/sessions");
    const result = scanSessions("/sessions");
    expect(result.flat).toEqual([]);
    expect(result.tree.roots).toEqual([]);
  });

  // ------------------------------------------------------------------
  // Basic .jsonl scanning
  // ------------------------------------------------------------------

  it("parses a single .jsonl session file", () => {
    writeFile(
      "/sessions/--ws--/2025-01-15T10-00-00-000Z_abc123.jsonl",
      sessionLine({ id: "abc123" }) + "\n" + '{"type": "message", ...}\n',
    );
    const result = scanSessions("/sessions");

    expect(result.flat).toHaveLength(1);
    const s = result.flat[0];
    expect(s.id).toBe("abc123");
    expect(s.workspace).toBe("--ws--");
    expect(s.cwd).toBe("/home/user/project");
    expect(s.startedAt).toBe("2025-01-15T10:00:00.000Z");
    expect(s.status).toBe("unknown");
    expect(s.isMain).toBe(true);
    expect(result.tree.roots).toEqual([s]);
    expect(result.tree.children.size).toBe(0);
  });

  it("reads only the first line of a .jsonl file", () => {
    // Create a file with a valid first line followed by megabytes of junk
    const firstLine = sessionLine({ id: "test1" });
    const bigContent = firstLine + "\n" + "x".repeat(100_000);
    writeFile("/sessions/--ws--/2025-01-15T10-00-00-000Z_test1.jsonl", bigContent);

    const result = scanSessions("/sessions");
    expect(result.flat).toHaveLength(1);
    expect(result.flat[0].id).toBe("test1");
  });

  it("skips .jsonl files with invalid first-line JSON", () => {
    writeFile(
      "/sessions/--ws--/bad.jsonl",
      "not valid json\n",
    );
    const result = scanSessions("/sessions");
    expect(result.flat).toEqual([]);
  });

  it("skips .jsonl files whose first line is not a session event", () => {
    writeFile(
      "/sessions/--ws--/2025-01-15T10-00-00-000Z_xyz.jsonl",
      JSON.stringify({ type: "message", content: "hello" }) + "\n",
    );
    const result = scanSessions("/sessions");
    expect(result.flat).toEqual([]);
  });

  it("handles multiple .jsonl files in a workspace", () => {
    writeFile(
      "/sessions/--ws--/2025-01-15T10-00-00-000Z_sess1.jsonl",
      sessionLine({ id: "sess1", timestamp: "2025-01-15T10:00:00.000Z" }) + "\n",
    );
    writeFile(
      "/sessions/--ws--/2025-01-16T12-00-00-000Z_sess2.jsonl",
      sessionLine({ id: "sess2", timestamp: "2025-01-16T12:00:00.000Z" }) + "\n",
    );
    const result = scanSessions("/sessions");
    expect(result.flat).toHaveLength(2);
    // Most recent root first
    expect(result.tree.roots.map((r) => r.id)).toEqual(["sess2", "sess1"]);
  });

  it("handles multiple workspaces", () => {
    writeFile(
      "/sessions/--ws1--/2025-01-15T10-00-00-000Z_s1.jsonl",
      sessionLine({ id: "s1", timestamp: "2025-01-15T10:00:00.000Z" }) + "\n",
    );
    writeFile(
      "/sessions/--ws2--/2025-01-16T12-00-00-000Z_s2.jsonl",
      sessionLine({ id: "s2", timestamp: "2025-01-16T12:00:00.000Z" }) + "\n",
    );
    const result = scanSessions("/sessions");
    expect(result.flat).toHaveLength(2);
    expect(result.tree.roots).toHaveLength(2);
  });

  // ------------------------------------------------------------------
  // .pi-status.json
  // ------------------------------------------------------------------

  it("applies .pi-status.json to the most recent main session", () => {
    writeFile(
      "/sessions/--ws--/2025-01-15T10-00-00-000Z_s1.jsonl",
      sessionLine({ id: "s1", timestamp: "2025-01-15T10:00:00.000Z" }) + "\n",
    );
    writeFile(
      "/sessions/--ws--/2025-01-16T12-00-00-000Z_s2.jsonl",
      sessionLine({ id: "s2", timestamp: "2025-01-16T12:00:00.000Z" }) + "\n",
    );
    writeFile(
      "/sessions/--ws--/.pi-status.json",
      piStatusJson({ pid: 99999, status: "completed", endedAt: "2025-01-16T14:00:00.000Z" }),
    );

    const result = scanSessions("/sessions");

    // Most recent (s2) gets the status
    const s2 = result.flat.find((s) => s.id === "s2")!;
    expect(s2.pid).toBe(99999);
    expect(s2.status).toBe("completed");
    expect(s2.endedAt).toBe("2025-01-16T14:00:00.000Z");

    // Older session stays unknown
    const s1 = result.flat.find((s) => s.id === "s1")!;
    expect(s1.status).toBe("unknown");
    expect(s1.pid).toBeUndefined();
  });

  it("keeps status unknown when .pi-status.json is absent", () => {
    writeFile(
      "/sessions/--ws--/2025-01-15T10-00-00-000Z_s1.jsonl",
      sessionLine({ id: "s1" }) + "\n",
    );
    const result = scanSessions("/sessions");
    expect(result.flat[0].status).toBe("unknown");
    expect(result.flat[0].pid).toBeUndefined();
  });

  it("handles malformed .pi-status.json gracefully", () => {
    writeFile(
      "/sessions/--ws--/2025-01-15T10-00-00-000Z_s1.jsonl",
      sessionLine({ id: "s1" }) + "\n",
    );
    writeFile("/sessions/--ws--/.pi-status.json", "not json {{");
    const result = scanSessions("/sessions");
    expect(result.flat[0].status).toBe("unknown");
  });

  // ------------------------------------------------------------------
  // Sub-agent metadata (.task-subagents-*.json)
  // ------------------------------------------------------------------

  it("reads sub-agent records and links them to main session", () => {
    writeFile(
      "/sessions/--ws--/2025-01-15T10-00-00-000Z_main.jsonl",
      sessionLine({ id: "main-uuid", timestamp: "2025-01-15T10:00:00.000Z" }) + "\n",
    );
    writeFile(
      "/sessions/--ws--/.task-subagents-main-uuid.json",
      subagentsJson({
        mainSessionId: "main-uuid",
        records: [
          {
            id: "3f00dc3b",
            humanName: "Tom",
            displayName: "Explore Tom",
            agentType: "Explore",
            sessionFile: "/sessions/--ws--/2025-01-15T10-05-00-000Z_sub-uuid.jsonl",
            depth: 1,
            createdAt: "2025-01-15T10:05:00.000Z",
            updatedAt: "2025-01-15T10:30:00.000Z",
          },
        ],
      }),
    );

    const result = scanSessions("/sessions");
    expect(result.flat).toHaveLength(2);

    const main = result.flat.find((s) => s.isMain)!;
    expect(main.id).toBe("main-uuid");

    const sub = result.flat.find((s) => !s.isMain)!;
    expect(sub.id).toBe("sub-uuid");
    expect(sub.parentAgentId).toBe("main-uuid");
    expect(sub.agentType).toBe("Explore");
    expect(sub.displayName).toBe("Explore Tom");
    expect(sub.humanName).toBe("Tom");
    expect(sub.depth).toBe(1);
    expect(sub.workspace).toBe("--ws--");

    // Tree
    expect(result.tree.roots).toHaveLength(1);
    expect(result.tree.roots[0].id).toBe("main-uuid");
    expect(result.tree.children.get("main-uuid")).toHaveLength(1);
    expect(result.tree.children.get("main-uuid")![0].id).toBe("sub-uuid");
  });

  it("links sub-agents to other sub-agents via parentAgentId", () => {
    writeFile(
      "/sessions/--ws--/2025-01-15T10-00-00-000Z_main.jsonl",
      sessionLine({ id: "main-uuid", timestamp: "2025-01-15T10:00:00.000Z" }) + "\n",
    );
    writeFile(
      "/sessions/--ws--/.task-subagents-main-uuid.json",
      subagentsJson({
        mainSessionId: "main-uuid",
        records: [
          {
            id: "aaa111",
            humanName: "Tom",
            displayName: "Explore Tom",
            agentType: "Explore",
            sessionFile: "/sessions/--ws--/2025-01-15T10-05-00-000Z_sub1.jsonl",
            depth: 1,
            createdAt: "2025-01-15T10:05:00.000Z",
            updatedAt: "2025-01-15T10:30:00.000Z",
          },
          {
            id: "bbb222",
            humanName: "Ada",
            displayName: "Scout Ada",
            agentType: "Scout",
            sessionFile: "/sessions/--ws--/2025-01-15T10-10-00-000Z_sub2.jsonl",
            parentAgentId: "aaa111",
            depth: 2,
            createdAt: "2025-01-15T10:10:00.000Z",
            updatedAt: "2025-01-15T10:25:00.000Z",
          },
        ],
      }),
    );

    const result = scanSessions("/sessions");
    expect(result.flat).toHaveLength(3);

    const sub1 = result.flat.find((s) => s.id === "sub1")!;
    const sub2 = result.flat.find((s) => s.id === "sub2")!;

    expect(sub1.parentAgentId).toBe("main-uuid");
    expect(sub2.parentAgentId).toBe("sub1"); // resolved from hex "aaa111"

    // Tree
    const mainChildren = result.tree.children.get("main-uuid")!;
    expect(mainChildren).toHaveLength(1);
    expect(mainChildren[0].id).toBe("sub1");

    const sub1Children = result.tree.children.get("sub1")!;
    expect(sub1Children).toHaveLength(1);
    expect(sub1Children[0].id).toBe("sub2");
  });

  it("merges sub-agent record with existing .jsonl session file", () => {
    // Sub-agent .jsonl exists alongside the metadata
    writeFile(
      "/sessions/--ws--/2025-01-15T10-00-00-000Z_main.jsonl",
      sessionLine({ id: "main-uuid", timestamp: "2025-01-15T10:00:00.000Z" }) + "\n",
    );
    writeFile(
      "/sessions/--ws--/2025-01-15T10-05-00-000Z_sub-uuid.jsonl",
      sessionLine({
        id: "sub-uuid",
        timestamp: "2025-01-15T10:05:00.000Z",
        cwd: "/home/user/project/sub",
      }) + "\n",
    );
    writeFile(
      "/sessions/--ws--/.task-subagents-main-uuid.json",
      subagentsJson({
        mainSessionId: "main-uuid",
        records: [
          {
            id: "3f00dc3b",
            humanName: "Tom",
            displayName: "Explore Tom",
            agentType: "Explore",
            sessionFile: "/sessions/--ws--/2025-01-15T10-05-00-000Z_sub-uuid.jsonl",
            depth: 1,
            createdAt: "2025-01-15T10:05:00.000Z",
            updatedAt: "2025-01-15T10:30:00.000Z",
          },
        ],
      }),
    );

    const result = scanSessions("/sessions");
    expect(result.flat).toHaveLength(2);

    const sub = result.flat.find((s) => s.id === "sub-uuid")!;
    expect(sub.isMain).toBe(false);
    expect(sub.cwd).toBe("/home/user/project/sub"); // from .jsonl
    expect(sub.displayName).toBe("Explore Tom"); // from metadata
    expect(sub.agentType).toBe("Explore");
  });

  it("handles sub-agents without a .jsonl file", () => {
    // Only main session has .jsonl; sub-agent exists only in metadata
    writeFile(
      "/sessions/--ws--/2025-01-15T10-00-00-000Z_main.jsonl",
      sessionLine({ id: "main-uuid", timestamp: "2025-01-15T10:00:00.000Z" }) + "\n",
    );
    writeFile(
      "/sessions/--ws--/.task-subagents-main-uuid.json",
      subagentsJson({
        mainSessionId: "main-uuid",
        records: [
          {
            id: "3f00dc3b",
            humanName: "Ivy",
            displayName: "Planner Ivy",
            agentType: "Planner",
            sessionFile: "/sessions/--ws--/2025-01-15T10-05-00-000Z_sub-only-meta.jsonl",
            depth: 1,
            createdAt: "2025-01-15T10:05:00.000Z",
            updatedAt: "2025-01-15T10:30:00.000Z",
          },
        ],
      }),
    );

    const result = scanSessions("/sessions");
    expect(result.flat).toHaveLength(2);

    const sub = result.flat.find((s) => !s.isMain)!;
    expect(sub.id).toBe("sub-only-meta");
    expect(sub.agentType).toBe("Planner");
    expect(sub.cwd).toBe("/home/user/project"); // inherited from main
  });

  it("handles sub-agent with empty sessionFile gracefully", () => {
    writeFile(
      "/sessions/--ws--/2025-01-15T10-00-00-000Z_main.jsonl",
      sessionLine({ id: "main-uuid" }) + "\n",
    );
    writeFile(
      "/sessions/--ws--/.task-subagents-main-uuid.json",
      subagentsJson({
        mainSessionId: "main-uuid",
        records: [
          {
            id: "abc12345",
            humanName: "Max",
            displayName: "Worker Max",
            agentType: "Worker",
            sessionFile: "", // empty
            depth: 1,
            createdAt: "2025-01-15T10:05:00.000Z",
            updatedAt: "2025-01-15T10:30:00.000Z",
          },
        ],
      }),
    );

    const result = scanSessions("/sessions");
    expect(result.flat).toHaveLength(2);

    const sub = result.flat.find((s) => !s.isMain)!;
    expect(sub.id).toBe("subagent-abc12345"); // fallback
    expect(sub.parentAgentId).toBe("main-uuid");
  });

  it("works with multiple .task-subagents-*.json files", () => {
    writeFile(
      "/sessions/--ws--/2025-01-15T10-00-00-000Z_main1.jsonl",
      sessionLine({ id: "main1", timestamp: "2025-01-15T10:00:00.000Z" }) + "\n",
    );
    writeFile(
      "/sessions/--ws--/2025-01-16T10-00-00-000Z_main2.jsonl",
      sessionLine({ id: "main2", timestamp: "2025-01-16T10:00:00.000Z" }) + "\n",
    );
    writeFile(
      "/sessions/--ws--/.task-subagents-main1.json",
      subagentsJson({
        mainSessionId: "main1",
        records: [
          {
            id: "aaa111",
            humanName: "Tom",
            displayName: "Explore Tom",
            agentType: "Explore",
            sessionFile: "/sessions/--ws--/2025-01-15T10-05-00-000Z_sub1.jsonl",
            depth: 1,
            createdAt: "2025-01-15T10:05:00.000Z",
            updatedAt: "2025-01-15T10:30:00.000Z",
          },
        ],
      }),
    );
    writeFile(
      "/sessions/--ws--/.task-subagents-main2.json",
      subagentsJson({
        mainSessionId: "main2",
        records: [
          {
            id: "bbb222",
            humanName: "Ada",
            displayName: "Scout Ada",
            agentType: "Scout",
            sessionFile: "/sessions/--ws--/2025-01-16T10-05-00-000Z_sub2.jsonl",
            depth: 1,
            createdAt: "2025-01-16T10:05:00.000Z",
            updatedAt: "2025-01-16T10:30:00.000Z",
          },
        ],
      }),
    );

    const result = scanSessions("/sessions");
    expect(result.flat).toHaveLength(4); // 2 mains + 2 subs

    const sub1 = result.flat.find((s) => s.id === "sub1")!;
    const sub2 = result.flat.find((s) => s.id === "sub2")!;
    expect(sub1.parentAgentId).toBe("main1");
    expect(sub2.parentAgentId).toBe("main2");
  });

  it("handles malformed .task-subagents-*.json gracefully", () => {
    writeFile(
      "/sessions/--ws--/2025-01-15T10-00-00-000Z_main.jsonl",
      sessionLine({ id: "main-uuid" }) + "\n",
    );
    writeFile("/sessions/--ws--/.task-subagents-main-uuid.json", "not valid json {{{");
    const result = scanSessions("/sessions");
    expect(result.flat).toHaveLength(1);
    expect(result.flat[0].isMain).toBe(true);
  });

  // ------------------------------------------------------------------
  // Graceful degradation (no extension data)
  // ------------------------------------------------------------------

  it("works with no extension data at all (all sessions flat, status unknown)", () => {
    writeFile(
      "/sessions/--ws1--/2025-01-15T10-00-00-000Z_s1.jsonl",
      sessionLine({ id: "s1" }) + "\n",
    );
    writeFile(
      "/sessions/--ws2--/2025-01-16T10-00-00-000Z_s2.jsonl",
      sessionLine({ id: "s2" }) + "\n",
    );
    const result = scanSessions("/sessions");

    expect(result.flat).toHaveLength(2);
    for (const s of result.flat) {
      expect(s.isMain).toBe(true);
      expect(s.status).toBe("unknown");
      expect(s.pid).toBeUndefined();
    }
    expect(result.tree.roots).toHaveLength(2);
    expect(result.tree.children.size).toBe(0);
  });

  // ------------------------------------------------------------------
  // Tree structure
  // ------------------------------------------------------------------

  it("builds correct tree with nested children", () => {
    writeFile(
      "/sessions/--ws--/2025-01-15T10-00-00-000Z_main.jsonl",
      sessionLine({ id: "main", timestamp: "2025-01-15T10:00:00.000Z" }) + "\n",
    );
    writeFile(
      "/sessions/--ws--/.task-subagents-main.json",
      subagentsJson({
        mainSessionId: "main",
        records: [
          {
            id: "a1",
            humanName: "Tom",
            displayName: "Explore Tom",
            agentType: "Explore",
            sessionFile: "/sessions/--ws--/2025-01-15T10-05-00-000Z_sub1.jsonl",
            depth: 1,
            createdAt: "2025-01-15T10:05:00.000Z",
            updatedAt: "2025-01-15T10:30:00.000Z",
          },
          {
            id: "a2",
            humanName: "Ada",
            displayName: "Scout Ada",
            agentType: "Scout",
            sessionFile: "/sessions/--ws--/2025-01-15T10-10-00-000Z_sub2.jsonl",
            parentAgentId: "a1",
            depth: 2,
            createdAt: "2025-01-15T10:10:00.000Z",
            updatedAt: "2025-01-15T10:25:00.000Z",
          },
          {
            id: "a3",
            humanName: "Max",
            displayName: "Worker Max",
            agentType: "Worker",
            sessionFile: "/sessions/--ws--/2025-01-15T10-15-00-000Z_sub3.jsonl",
            parentAgentId: "a2",
            depth: 3,
            createdAt: "2025-01-15T10:15:00.000Z",
            updatedAt: "2025-01-15T10:20:00.000Z",
          },
        ],
      }),
    );

    const result = scanSessions("/sessions");

    // Roots
    expect(result.tree.roots).toHaveLength(1);
    expect(result.tree.roots[0].id).toBe("main");

    // main → sub1
    const mainChildren = result.tree.children.get("main")!;
    expect(mainChildren).toHaveLength(1);
    expect(mainChildren[0].id).toBe("sub1");

    // sub1 → sub2
    const sub1Children = result.tree.children.get("sub1")!;
    expect(sub1Children).toHaveLength(1);
    expect(sub1Children[0].id).toBe("sub2");

    // sub2 → sub3
    const sub2Children = result.tree.children.get("sub2")!;
    expect(sub2Children).toHaveLength(1);
    expect(sub2Children[0].id).toBe("sub3");

    // sub3 has no children
    expect(result.tree.children.get("sub3")).toBeUndefined();
  });

  it("sorts children by startedAt ascending", () => {
    writeFile(
      "/sessions/--ws--/2025-01-15T10-00-00-000Z_main.jsonl",
      sessionLine({ id: "main", timestamp: "2025-01-15T10:00:00.000Z" }) + "\n",
    );
    writeFile(
      "/sessions/--ws--/.task-subagents-main.json",
      subagentsJson({
        mainSessionId: "main",
        records: [
          {
            id: "a1",
            humanName: "C",
            displayName: "C",
            agentType: "Explore",
            sessionFile: "/sessions/--ws--/2025-01-15T10-20-00-000Z_c.jsonl",
            depth: 1,
            createdAt: "2025-01-15T10:20:00.000Z",
            updatedAt: "2025-01-15T10:30:00.000Z",
          },
          {
            id: "a2",
            humanName: "A",
            displayName: "A",
            agentType: "Scout",
            sessionFile: "/sessions/--ws--/2025-01-15T10-05-00-000Z_a.jsonl",
            depth: 1,
            createdAt: "2025-01-15T10:05:00.000Z",
            updatedAt: "2025-01-15T10:10:00.000Z",
          },
          {
            id: "a3",
            humanName: "B",
            displayName: "B",
            agentType: "Worker",
            sessionFile: "/sessions/--ws--/2025-01-15T10-10-00-000Z_b.jsonl",
            depth: 1,
            createdAt: "2025-01-15T10:10:00.000Z",
            updatedAt: "2025-01-15T10:15:00.000Z",
          },
        ],
      }),
    );

    const result = scanSessions("/sessions");
    const children = result.tree.children.get("main")!;
    expect(children.map((c) => c.id)).toEqual(["a", "b", "c"]);
  });
});
