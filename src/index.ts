/**
 * Pi Agent Dashboard — session data layer library.
 *
 * Scans Pi session directories and produces a unified
 * {@link ScanResult} with flat and hierarchical session views.
 *
 * @packageDocumentation
 */

export { scanSessions } from "./scanner.js";
export type { ScanResult, SessionInfo, SessionTree } from "./types.js";
