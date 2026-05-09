/**
 * Session directory scanner.
 *
 * Scans `~/.pi/agent/sessions/` (or an arbitrary root) and produces a unified
 * {@link ScanResult} with flat and hierarchical session views.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ScanResult, SessionInfo, SessionTree } from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Name of the status file written by the pi-agent-dashboard extension. */
const STATUS_FILE = ".pi-status.json";

/** Prefix for sub-agent metadata files. */
const SUBAGENT_FILE_PREFIX = ".task-subagents-";

/** The `.jsonl` file extension. */
const JSONL_EXT = ".jsonl";

// ---------------------------------------------------------------------------
// Internal types for on-disk formats
// ---------------------------------------------------------------------------

interface SessionEvent {
  type: string;
  version?: string;
  id: string;
  timestamp: string;
  cwd: string;
}

interface PiStatusFile {
  pid: number;
  status: "running" | "completed";
  startedAt: string;
  endedAt?: string;
}

interface SubagentRecord {
  id: string;
  humanName: string;
  displayName: string;
  agentType: string;
  sessionFile: string;
  parentAgentId?: string;
  depth: number;
  createdAt: string;
  updatedAt: string;
}

interface SubagentMetadata {
  version: number;
  mainSessionId: string;
  mainSessionFile?: string;
  selectedMainAgent?: string;
  records: SubagentRecord[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read only the first line of a file.  Returns `undefined` when the file
 * cannot be read or is empty.
 */
function readFirstLine(filePath: string): string | undefined {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(4096);
      const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
      if (bytesRead === 0) return undefined;
      const content = buf.toString("utf-8", 0, bytesRead);
      const newlineIdx = content.indexOf("\n");
      return newlineIdx >= 0 ? content.slice(0, newlineIdx) : content;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/**
 * Extract a session UUID from a `.jsonl` filename.
 *
 * Filename format: `2026-05-09T14-14-03-658Z_<uuid>.jsonl`
 * Returns the part after the last `_` before `.jsonl`, or `undefined`.
 */
function extractSessionIdFromFilename(filePath: string): string | undefined {
  const base = path.basename(filePath, JSONL_EXT);
  const lastUnderscore = base.lastIndexOf("_");
  if (lastUnderscore < 0) return undefined;
  return base.slice(lastUnderscore + 1);
}

/**
 * Safely parse JSON, returning `undefined` on failure.
 */
function tryParseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}

/**
 * Safely read and parse a JSON file, returning `undefined` on failure.
 */
function readJsonFile<T>(filePath: string): T | undefined {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content) as T;
  } catch {
    return undefined;
  }
}

/**
 * List subdirectories of a directory.  Returns an empty array on error.
 */
function listSubdirs(dirPath: string): string[] {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((d: fs.Dirent) => d.isDirectory())
      .map((d: fs.Dirent) => d.name);
  } catch {
    return [];
  }
}

/**
 * List files in a directory matching a suffix.  Returns an empty array on error.
 */
function listFilesWithExt(dirPath: string, ext: string): string[] {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((d: fs.Dirent) => d.isFile() && d.name.endsWith(ext))
      .map((d: fs.Dirent) => d.name);
  } catch {
    return [];
  }
}

/**
 * List files in a directory matching a prefix.  Returns an empty array on error.
 */
function listFilesWithPrefix(dirPath: string, prefix: string): string[] {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((d: fs.Dirent) => d.isFile() && d.name.startsWith(prefix) && d.name.endsWith(".json"))
      .map((d: fs.Dirent) => d.name);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Scan a single workspace directory and return discovered sessions.
 */
function scanWorkspace(
  workspaceName: string,
  workspacePath: string,
): SessionInfo[] {
  const sessions = new Map<string, SessionInfo>();

  // --- Phase 1: .jsonl files (main session candidates) ---
  const jsonlFiles = listFilesWithExt(workspacePath, JSONL_EXT);
  const jsonlSessionIds = new Set<string>();

  for (const jsonlFile of jsonlFiles) {
    const filePath = path.join(workspacePath, jsonlFile);
    const firstLine = readFirstLine(filePath);
    if (!firstLine) continue;

    const event = tryParseJson<SessionEvent>(firstLine);
    if (!event || event.type !== "session" || !event.id) continue;

    const sessionId = event.id;
    jsonlSessionIds.add(sessionId);

    // Don't overwrite if we already have this session from another source
    if (sessions.has(sessionId)) continue;

    sessions.set(sessionId, {
      id: sessionId,
      workspace: workspaceName,
      cwd: event.cwd ?? "",
      startedAt: event.timestamp ?? "",
      status: "unknown",
      isMain: true,
    });
  }

  // --- Phase 2: .pi-status.json ---
  const statusPath = path.join(workspacePath, STATUS_FILE);
  const piStatus = readJsonFile<PiStatusFile>(statusPath);

  if (piStatus) {
    // Apply status to the most recent main session (by startedAt).
    // If there are no main sessions, the status file is orphaned and we skip it.
    const mainSessions = Array.from(sessions.values())
      .filter((s) => s.isMain)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    if (mainSessions.length > 0) {
      const latest = mainSessions[0];
      latest.pid = piStatus.pid;
      latest.status = piStatus.status;
      latest.endedAt = piStatus.endedAt;
    }
  }

  // --- Phase 3: .task-subagents-*.json ---
  const subagentFiles = listFilesWithPrefix(workspacePath, SUBAGENT_FILE_PREFIX);

  // Build a mapping from hex sub-agent ID → session UUID (from sessionFile path)
  const hexToUuid = new Map<string, string>();

  // First pass: collect all records to build the hex→UUID mapping
  const allRecords: Array<{
    record: SubagentRecord;
    mainSessionId: string;
  }> = [];

  for (const metaFile of subagentFiles) {
    const metaPath = path.join(workspacePath, metaFile);
    const metadata = readJsonFile<SubagentMetadata>(metaPath);
    if (!metadata || metadata.version !== 1 || !Array.isArray(metadata.records)) continue;

    for (const record of metadata.records) {
      // Extract session UUID from the sessionFile path
      let sessionUuid = extractSessionIdFromFilename(record.sessionFile);

      // Fallback: if sessionFile is empty or unparseable, use the hex ID
      if (!sessionUuid) {
        sessionUuid = `subagent-${record.id}`;
      }

      hexToUuid.set(record.id, sessionUuid);
      allRecords.push({ record, mainSessionId: metadata.mainSessionId });
    }
  }

  // Second pass: resolve parent references and create/update SessionInfo
  for (const { record, mainSessionId } of allRecords) {
    const sessionUuid = hexToUuid.get(record.id) ?? `subagent-${record.id}`;

    // Determine parent session UUID
    let parentSessionId: string | undefined;
    if (record.parentAgentId) {
      // Parent is another sub-agent — resolve hex ID to UUID
      parentSessionId = hexToUuid.get(record.parentAgentId);
      if (!parentSessionId) {
        // Orphaned: parent not found. Link to main session as fallback.
        parentSessionId = mainSessionId;
      }
    } else {
      // Parent is the main session
      parentSessionId = mainSessionId;
    }

    // Check if this session was already discovered via a .jsonl file
    const existing = sessions.get(sessionUuid);

    if (existing) {
      // Merge sub-agent data into the existing entry
      existing.isMain = false;
      existing.parentAgentId = parentSessionId;
      existing.agentType = record.agentType;
      existing.displayName = record.displayName;
      existing.humanName = record.humanName;
      existing.depth = record.depth;
      existing.updatedAt = record.updatedAt;
      // Use the earlier of the two timestamps for startedAt
      if (!existing.startedAt || record.createdAt < existing.startedAt) {
        existing.startedAt = record.createdAt;
      }
    } else {
      // Create a new sub-agent entry from the record alone
      // Inherit cwd from the main session if available
      const mainSession = sessions.get(mainSessionId);
      const cwd = mainSession?.cwd ?? "";

      sessions.set(sessionUuid, {
        id: sessionUuid,
        workspace: workspaceName,
        cwd,
        startedAt: record.createdAt,
        status: "unknown",
        isMain: false,
        parentAgentId: parentSessionId,
        agentType: record.agentType,
        displayName: record.displayName,
        humanName: record.humanName,
        depth: record.depth,
        updatedAt: record.updatedAt,
      });
    }
  }

  return Array.from(sessions.values());
}

/**
 * Scan a Pi sessions directory and produce a unified {@link ScanResult}.
 *
 * @param rootDir  Path to the sessions root (e.g. `~/.pi/agent/sessions/`).
 * @returns        Flat list and hierarchical tree of all discovered sessions.
 */
export function scanSessions(rootDir: string): ScanResult {
  const workspaceNames = listSubdirs(rootDir);

  const allSessions: SessionInfo[] = [];

  for (const workspaceName of workspaceNames) {
    const workspacePath = path.join(rootDir, workspaceName);
    const sessions = scanWorkspace(workspaceName, workspacePath);
    allSessions.push(...sessions);
  }

  // Build tree
  const roots: SessionInfo[] = [];
  const children = new Map<string, SessionInfo[]>();

  for (const session of allSessions) {
    if (session.isMain) {
      roots.push(session);
    }

    if (session.parentAgentId) {
      const siblings = children.get(session.parentAgentId);
      if (siblings) {
        siblings.push(session);
      } else {
        children.set(session.parentAgentId, [session]);
      }
    }
  }

  // Sort roots by startedAt descending (most recent first)
  roots.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

  // Sort children within each parent by startedAt
  for (const [, childList] of children) {
    childList.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  }

  const tree: SessionTree = { roots, children };

  return { flat: allSessions, tree };
}
