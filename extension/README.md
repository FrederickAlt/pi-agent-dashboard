# pi-agent-dashboard

A [Pi](https://github.com/mariozechner/pi-coding-agent) extension that writes a `.pi-status.json` file into the session directory on session lifecycle events. This enables external dashboards, status widgets, or scripts to monitor whether a Pi agent session is running or has completed.

## Status file

On `session_start`, the extension creates `.pi-status.json` in the session directory (returned by `ctx.sessionManager.getSessionDir()`):

```json
{
  "pid": 12345,
  "status": "running",
  "startedAt": "2026-05-09T13:35:17.479Z"
}
```

On `session_shutdown`, it updates the same file:

```json
{
  "pid": 12345,
  "status": "completed",
  "startedAt": "2026-05-09T13:35:17.479Z",
  "endedAt": "2026-05-09T14:00:00.000Z"
}
```

Writes are **atomic** (temp file + `fs.renameSync`) so external readers never see a partial file.

## Installation

1. Add this extension to your Pi configuration. In your `~/.pi/config.json` (or equivalent), reference the extension path:

   ```json
   {
     "extensions": ["path/to/pi-agent-dashboard/extension/src/index.ts"]
   }
   ```

   Or if you've built the extension:

   ```json
   {
     "extensions": ["path/to/pi-agent-dashboard/extension/dist/index.js"]
   }
   ```

2. Start Pi — the extension activates automatically and writes the status file on every session start/shutdown.

## Development

```bash
cd extension
npm install
npm run build    # compiles to dist/
npm run watch    # incremental rebuild
```

## Use cases

- **Dashboard widgets** — poll `.pi-status.json` to show running/completed sessions
- **Process monitoring** — use `pid` to check if the agent process is still alive
- **Session analytics** — compute session duration from `startedAt` / `endedAt`
- **Automation** — trigger post-session scripts when status changes to `"completed"`
