/**
 * Configuration loader for the Pi Agent Dashboard.
 *
 * Reads `~/.config/pi-agent-dashboard/config.json` and merges with defaults.
 * Invalid values fall back to defaults silently.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Keybinds {
  toggleCompleted: string;
  toggleStale: string;
  increaseStaleThreshold: string;
  decreaseStaleThreshold: string;
  refresh: string;
  quit: string;
  navigateUp: string;
  navigateDown: string;
  toggleExpand: string;
}

export interface Config {
  keybinds: Keybinds;
  staleThresholdMinutes: number;
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_KEYBINDS: Keybinds = {
  toggleCompleted: "c",
  toggleStale: "s",
  increaseStaleThreshold: "+",
  decreaseStaleThreshold: "-",
  refresh: "r",
  quit: "q",
  navigateUp: "up",
  navigateDown: "down",
  toggleExpand: "enter",
};

const DEFAULT_CONFIG: Config = {
  keybinds: { ...DEFAULT_KEYBINDS },
  staleThresholdMinutes: 5,
};

// ---------------------------------------------------------------------------
// Config directory
// ---------------------------------------------------------------------------

function configDir(): string {
  // Respect XDG_CONFIG_HOME if set
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) return path.join(xdg, "pi-agent-dashboard");
  return path.join(os.homedir(), ".config", "pi-agent-dashboard");
}

function configPath(): string {
  return path.join(configDir(), "config.json");
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const KNOWN_KEYBIND_KEYS = Object.keys(DEFAULT_KEYBINDS) as (keyof Keybinds)[];

function isValidKeybinds(raw: unknown): raw is Partial<Keybinds> {
  if (typeof raw !== "object" || raw === null) return false;
  const obj = raw as Record<string, unknown>;
  return KNOWN_KEYBIND_KEYS.some((key) => key in obj);
}

function isValidThreshold(raw: unknown): raw is number {
  return typeof raw === "number" && raw > 0 && Number.isFinite(raw);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load the config file, merging with defaults.
 * Returns defaults on any error (missing file, invalid JSON, bad values).
 */
export function loadConfig(): Config {
  const cfg: Config = {
    keybinds: { ...DEFAULT_KEYBINDS },
    staleThresholdMinutes: DEFAULT_CONFIG.staleThresholdMinutes,
  };

  try {
    const raw = fs.readFileSync(configPath(), "utf-8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    // Merge keybinds
    if (isValidKeybinds(parsed.keybinds)) {
      const kb = parsed.keybinds as Record<string, unknown>;
      for (const key of KNOWN_KEYBIND_KEYS) {
        if (typeof kb[key] === "string" && (kb[key] as string).length > 0) {
          cfg.keybinds[key] = kb[key] as string;
        }
      }
    }

    // Merge stale threshold
    if (isValidThreshold(parsed.staleThresholdMinutes)) {
      cfg.staleThresholdMinutes = parsed.staleThresholdMinutes;
    }
  } catch {
    // File missing, unreadable, or invalid JSON — use defaults
  }

  return cfg;
}

/**
 * Get the config directory path (useful for error messages).
 */
export function getConfigPath(): string {
  return configPath();
}
