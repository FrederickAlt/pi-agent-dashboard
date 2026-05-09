/**
 * Pi Agent Dashboard — session status extension.
 *
 * Writes `.pi-status.json` into the session directory on `session_start`
 * and updates it to `"completed"` on `session_shutdown`.  Designed for
 * external monitors (dashboards, status widgets, scripts) that need to
 * know whether a Pi session is running or has finished.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

/** Shape of the status file written to the session directory. */
interface SessionStatus {
  pid: number;
  status: "running" | "completed";
  startedAt: string;
  endedAt?: string;
}

const STATUS_FILE = ".pi-status.json";

/**
 * Atomically write `data` as JSON to `filePath` using a temp file + rename.
 */
function atomicWriteJson(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpFile = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmpFile, filePath);
}

/**
 * Read and parse the existing status file, returning `undefined` if it
 * doesn't exist or can't be parsed.
 */
function readStatus(filePath: string): SessionStatus | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as SessionStatus;
  } catch {
    return undefined;
  }
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", async (_event, ctx) => {
    const sessionDir = ctx.sessionManager.getSessionDir();
    const statusPath = path.join(sessionDir, STATUS_FILE);

    const status: SessionStatus = {
      pid: process.pid,
      status: "running",
      startedAt: new Date().toISOString(),
    };

    atomicWriteJson(statusPath, status);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const sessionDir = ctx.sessionManager.getSessionDir();
    const statusPath = path.join(sessionDir, STATUS_FILE);

    const existing = readStatus(statusPath);
    const status: SessionStatus = {
      pid: process.pid,
      status: "completed",
      startedAt: existing?.startedAt ?? new Date().toISOString(),
      endedAt: new Date().toISOString(),
    };

    atomicWriteJson(statusPath, status);
  });
}
