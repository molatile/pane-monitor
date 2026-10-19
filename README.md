# agentwatch (Stage 3a)

`agentwatch` is a local-only terminal monitor, permission prompt interceptor, live terminal dashboard, and companion desktop GUI for AI coding agents (such as Antigravity CLI).

---

## Hard Safety Rules

1. **Zero Child Input Injection**: The only data ever written to the child process is the user's own keyboard input. No code path sends automated keystrokes to the child.
2. **Dashboard & GUI are Read-Only toward Agents**: Neither the terminal dashboard nor the graphical window ever writes to any child process or sends keys to any agent.
3. **Local Only & Zero Network Calls**: Everything stays on the local machine. Zero network calls, zero telemetry, no analytics, and no new servers or open ports. Remote content is strictly forbidden and blocked.
4. **Restricted File Reading**: The window may read ONLY:
   - `~/.agentwatch/sessions/*.json`
   - `~/.agentwatch/config.json`
   - `history.jsonl` through **ONE fixed function** (`readHistory`)
   It must NEVER read `raw-session.bin`, `prompts.log`, or `screen-snapshots.txt`.
5. **Allowed Writes**: The only writes permitted from the graphical interface are:
   - `~/.agentwatch/config.json` (display names, session order, window bounds, always-on-top, auto-open, notifications, time format)
   - The **"Clear this agent's history"** atomic rewrite action. Nothing else.
6. **Electron Security Architecture**:
   - `contextIsolation: true`
   - `nodeIntegration: false`
   - `sandbox: true`
   - Preload script exposes only a minimal, strictly typed context bridge API (`window.agentwatch`).
   - Strict Content-Security-Policy (`default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:`).
   - All navigation attempts (`will-navigate`) and new window requests (`setWindowOpenHandler`) are permanently blocked.
   - `webviewTag: false`.
7. **Secret Masking Before Disk Writes**: Secrets, API keys, tokens, credentials, and Google account header lines are masked before writing to `prompts.log`, `history.jsonl`, `screen-snapshots.txt`, or session status files.
8. **No Raw Paths Stored**: Session configuration and status files only store folder names and stable hashes (`agent:folderHash`), never raw directory paths.
9. **Recording Off by Default**: Raw session stream recording (`raw-session.bin`) is OFF by default and only activated when the `--record` flag is explicitly provided.
10. **Focus Safety & Single-Instance**: When launched automatically by the wrapper, the window opens in the background (`showInactive`) and never steals focus. When launched explicitly via `agentwatch gui`, it focuses the existing instance using Electron's single-instance lock.

---

## What's New in Stage 3a

- **Auto-Open Window**: When `agentwatch <agent>` starts, it checks if the window is already running. If not and `autoOpenWindow` is true (default true), it launches the window as a fully detached background process.
- **Single-Instance Lock**: Running `agentwatch gui` focuses the existing window rather than opening duplicates.
- **Task Manager Layout (Tabs)**:
  - **Agents tab**: Live active agents on top, collapsed "Past agents" section in the middle, and history of the selected agent below.
  - **Settings tab**: Toggles for auto-open window (on/off), pin on top, notifications on/off, and time format (24-hour vs 12-hour).
- **History Identity**: Every event stores the stable session key (`agent:folderHash`) plus the folder name. Events written before Stage 3a without a key appear under "Unassigned (older)".
- **Fixed End-of-File History Reader**: Reads `history.jsonl` backwards from the end, returning the newest 200 events for the selected agent without loading the whole file into memory. Includes pagination ("Load older") and skips malformed lines without crashing.
- **Atomic Clear-History**: A "Clear this agent's history" button with a confirmation dialog atomically rewrites `history.jsonl` omitting only that agent's events (the only write permitted to `history.jsonl`).
- **Session Timestamps**: Records `session_started` and `session_ended` with duration in UTC ISO format. If a process terminates abruptly without a clean exit, ended status is recorded as "unknown" rather than guessed.
- **Real Weekday and Local Time Display**: Timestamps display the real computed weekday (e.g., `Thursday, 2 July 2026 · 22:00` or `10:00 PM`) and session length (e.g., `1h 12m`).
- **Readable History Cards**: Readable prompt cards displaying the local time, question, masked command, option texts with classification labels (`yes once`, `yes this conversation`, `yes and save`, `no`), plain-words dry-run decision, duration on screen, and `Answer: not recorded`.

---

## File Structure & Responsibilities

| File | Purpose |
| --- | --- |
| `profiles/agy.json` | Agent profile definition for Antigravity CLI. |
| `rules.json` | Configuration for the dry-run rules engine. |
| `src/agentwatch.js` | Core runner; manages child process in PTY, auto-opens detached GUI, writes session start/end timestamps, and manages prompt logging. |
| `src/shared.js` | Shared configuration (autoOpenWindow, timeFormat, names, order, bounds), `isGuiRunning` helper, duration formatting, and dashboard data aggregation. |
| `src/history.js` | Appends masked history events, provides the ONE fixed history read function (`readHistory`) reading from file end, atomic `clearAgentHistory`, and date/time formatting. |
| `src/dashboard.js` | Full-screen live terminal dashboard (`agentwatch dash`). |
| `src/gui/index.js` | Spawns and manages the Electron companion window (supports detached, focus, and auto-open). |
| `src/gui/main.js` | Electron main process with single-instance lock, focus management, security hardening, and IPC handlers for settings and history. |
| `src/gui/preload.js` | Hardened context bridge isolating renderer from Node.js while exposing fixed IPC methods. |
| `src/gui/index.html` | Tabbed GUI markup with strict Content-Security-Policy meta tag. |
| `src/gui/styles.css` | Light and dark theme styling for tabs, live/past agents, and readable history cards. |
| `src/gui/renderer.js` | Tab switching, live row updates, past agent list, agent selection, and session-grouped history cards. |
| `src/config.js` | Backwards-compatible configuration re-exporting from `src/shared.js`. |
| `src/notifier.js` | Dispatches terminal bell and desktop notifications with inter-viewer locking. |
| `src/profile.js` | Profile loader and rule-based option classifier. |
| `src/parser.js` | Terminal screen line parser detecting structured permission prompts. |
| `src/rules.js` | Dry-run rules engine matching deny/allow rules. |
| `src/masker.js` | Redacts sensitive information before writing to disk. |
| `src/state.js` | State classifier maintaining `asking`, `busy`, and `idle` states. |
| `src/status.js` | Atomic session status file manager (`~/.agentwatch/sessions/<sessionId>.json`). |
| `bin/agentwatch.js` | Executable CLI binary (`agentwatch <agent>`, `agentwatch dash`, `agentwatch gui`). |
| `tests/test-stage3a.js` | Stage 3a test suite covering: single-instance behavior, detached launch, large fake file reading (< 50ms), malformed lines, key filtering, unassigned events, atomic clear-history, time display with real weekday, session grouping, and Electron security settings. |
| `tests/test-gui.js` | Stage 2.5 GUI test suite covering: shared module agreement, drag-and-drop reordering, and security settings. |
| `tests/test-dashboard.js` | Stage 2 dashboard test suite. |
| `tests/test-agentwatch.js` | Stage 1 test suite. |
| `tests/test-unit.js` | Unit tests for parser and state tracker. |
| `tests/test-fast-prompt.js` | Fast prompt dismissal integration test (< 500 ms). |
| `tests/test-integration.js` | End-to-end integration tests with mock CLI apps. |

---

## Test Commands

To run all test suites:
```bash
npm run test:all
```

To run individual suites:
```bash
# Stage 3a test suite (Auto-open, fixed history reader, session timestamps, settings)
npm run test:stage3a

# Stage 2.5 Electron GUI test suite
npm run test:gui

# Stage 2 terminal dashboard test suite
npm run test:dash

# Stage 1 test suite
npm run test:agentwatch

# Unit tests
npm run test:unit

# Fast prompt test (< 500 ms)
npm run test:fast

# Integration tests
npm run test:integration
```

---

## Usage

### 1. Launching an Agent under agentwatch
```bash
agentwatch agy
```
*(On Windows: `.\agentwatch.cmd agy`)*

When started, agentwatch automatically launches the GUI window in the background without stealing focus (if `autoOpenWindow` is enabled in settings).

With raw session stream recording enabled:
```bash
agentwatch --record agy
```

### 2. Launching the Live Terminal Dashboard
```bash
agentwatch dash
```
*(On Windows: `.\agentwatch.cmd dash` or `npm run dash`)*

### 3. Launching the Companion Desktop GUI Window
```bash
agentwatch gui
```
*(On Windows: `.\agentwatch.cmd gui` or `npm run gui`)*

If the window is already running, running `agentwatch gui` brings the existing window to the front and focuses it.