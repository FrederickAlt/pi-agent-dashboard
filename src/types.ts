/**
 * Unified types for the Pi Agent Dashboard session data layer.
 */

export interface SessionInfo {
  /** Pi session UUID from the .jsonl session event or sub-agent record. */
  id: string;
  /** Workspace directory name (e.g. "--home-frederick-projects-foo--"). */
  workspace: string;
  /** Working directory at session start (from the first .jsonl event or inherited). */
  cwd: string;
  /** ISO timestamp when the session started. */
  startedAt: string;
  /** Session status derived from .pi-status.json or inferred. */
  status: "running" | "completed" | "unknown";
  /** PID of the Pi process (from .pi-status.json). */
  pid?: number;
  /** Whether this is a root/main session (true) or a sub-agent session (false). */
  isMain: boolean;

  // --- Sub-agent extension fields (optional) ---

  /** Parent session ID (UUID). Undefined for main sessions; for sub-agents,
   *  this is the session UUID of the parent (main or another sub-agent). */
  parentAgentId?: string;
  /** Agent type name (e.g. "Explore", "Planner"). */
  agentType?: string;
  /** Human-readable display name (e.g. "Explore Tom"). */
  displayName?: string;
  /** Short human name assigned to the sub-agent (e.g. "Tom"). */
  humanName?: string;
  /** Nesting depth of the sub-agent (0 for main sessions). */
  depth?: number;
  /** ISO timestamp when the session ended (from .pi-status.json). */
  endedAt?: string;
  /** ISO timestamp of the last update to the sub-agent record. */
  updatedAt?: string;
}

/**
 * Hierarchical view of sessions.
 */
export interface SessionTree {
  /** Top-level main sessions (isMain: true). */
  roots: SessionInfo[];
  /** Maps a session ID (UUID) to its direct child sessions. */
  children: Map<string, SessionInfo[]>;
}

/**
 * Result of a session directory scan.
 */
export interface ScanResult {
  /** Flat list of all discovered sessions (main + sub-agents). */
  flat: SessionInfo[];
  /** Hierarchical tree view. */
  tree: SessionTree;
}
