#!/usr/bin/env node
/**
 * CLI entry point for the Pi Agent Dashboard.
 *
 * Usage:
 *   pi-agent-dashboard                  # uses ~/.pi/agent/sessions/
 *   pi-agent-dashboard --sessions-dir /path/to/sessions
 */

import * as os from "node:os";
import * as path from "node:path";
import { createDashboard } from "./tui.js";

const DEFAULT_SESSIONS_DIR = path.join(os.homedir(), ".pi", "agent", "sessions");

function parseArgs(argv: string[]): string {
  const idx = argv.indexOf("--sessions-dir");
  if (idx >= 0 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  // Also support shorthand
  for (const arg of argv) {
    if (arg.startsWith("--sessions-dir=")) {
      return arg.slice("--sessions-dir=".length);
    }
  }
  return DEFAULT_SESSIONS_DIR;
}

const sessionsDir = parseArgs(process.argv.slice(2));
createDashboard(sessionsDir);
