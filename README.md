# agentwatch (Stage 4 - Auto-Accept)

`agentwatch` is a local-only terminal monitor, permission prompt interceptor, live terminal dashboard, and companion desktop GUI for AI coding agents (such as Antigravity CLI).

---

## Hard Safety & Privacy Rules

1. **Child Input Injection Safety**:
   - Auto-accept is **OFF by default**.
   - Exactly **ONE** function (`sendAutoAnswer`) may write anything to the child process other than the user's own keystrokes.
   - It sends strictly one single option key (`1`–`9`, no Enter, no text) from the profile, only after an approved rules decision.
   - Any other extra byte written to the child fails tests immediately.
2. **Dashboard & GUI are Read-Only toward Agents**: Neither the terminal dashboard nor the graphical window ever writes to any child process or sends keys to any agent.
3. **Local Only & Zero Network Calls**: Everything stays on the local machine. Zero network calls, zero telemetry, no analytics, and no new servers or open ports. Remote content is strictly forbidden and blocked.
4. **Privacy Rule (Prompt Answer Recording)**:
   The wrapper sees user keyboard input to forward it to the child process. To preserve privacy:
   - **What is recorded**: ONLY the discrete answer signal given to a complete permission prompt on screen:
     - Single digit keys (`1`–`4`) matching an option on screen -> records that option number, masked option text, and classification.
     - `Enter` -> records the option indicated by the `>` selection marker on screen at that moment (read from in-memory terminal emulation, never from typed text).
     - `Esc` -> records `cancelled` (`answer_key: "esc"`, `answer_class: "no"`).
     - Tab / Ctrl+G editing -> records `amended` (`answer_key: "amended"`, `answer_class: "unknown"`).
     - No answer signal seen -> records `unknown` (`answer_key: "unknown"`, `agreement: "n/a"`).
   - **What is NEVER recorded**:
     - Typed letters, numbers outside options, commands edited via Tab/Ctrl+G, passwords, secrets, and pasted text are **NEVER** stored or logged.
     - Arrow keys only move selection and are not answers.
     - Keystroke text never reaches ANY file on disk (`prompts.log`, `history.jsonl`, `screen-snapshots.txt`, debug logs, or status files).
5. **Restricted File Reading**: The window may read ONLY:
   - `~/.agentwatch/sessions/*.json`
   - `~/.agentwatch/config.json`
   - `history.jsonl` through **ONE fixed function** (`readHistory`)
   It must NEVER read `raw-session.bin`, `prompts.log`, or `screen-snapshots.txt`.
6. **Allowed Writes**: The only writes permitted from the graphical interface are:
   - `~/.agentwatch/config.json` (display names, session order, window bounds, always-on-top, auto-open, notifications, time format, autoPaused)
   - The **"Clear this agent's history"** atomic rewrite action. Nothing else.
7. **Electron Security Architecture**:
   - `contextIsolation: true`
   - `nodeIntegration: false`
   - `sandbox: true`
   - Preload script exposes only a minimal, strictly typed context bridge API (`window.agentwatch`).
   - Strict Content-Security-Policy (`default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self'; img-src 'self' data:`).
   - All navigation attempts (`will-navigate`) and new window requests (`setWindowOpenHandler`) are permanently blocked.
   - `webviewTag: false`.
8. **Secret Masking Before Disk Writes**: Secrets, API keys, tokens, credentials, and Google account header lines are masked before writing to `prompts.log`, `history.jsonl`, `screen-snapshots.txt`, or session status files.
9. **No Raw Paths Stored**: Session configuration and status files only store folder names and stable hashes (`agent:folderHash`), never raw directory paths.
10. **Recording Off by Default**: Raw session stream recording (`raw-session.bin`) is OFF by default and only activated when the `--record` flag is explicitly provided.
11. **Focus Safety & Single-Instance**: When launched automatically by the wrapper, the window opens in the background (`showInactive`) and never steals focus. When launched explicitly via `agentwatch gui`, it focuses the existing instance using Electron's single-instance lock.

---

## What's New in Stage 4 (Auto-Accept)

- **Safe Auto-Accept Engine**:
  - **OFF by Default**: Only runs for sessions started with `agentwatch --auto <agent>` or when `autoAcceptDefault: true` is configured.
  - **Single Write Path (`sendAutoAnswer`)**: Exactly one function can send keys to the child; sends only the single digit key for the eligible option (no Enter).
  - **Re-evaluation Right Before Sending**: Re-reads the live screen memory immediately before sending; verifies identical prompt, command, and options unchanged for at least 300 ms. Any change aborts to `needs_user`.
  - **Strict Eligibility**: Rules engine decision must be `would_approve`, deny list still wins on unmasked command in memory, exactly ONE option on screen must be `yes_once`, and prompt cannot look like a choice question. Never sends for `yes_session`, `yes_persist`, or `no`.
  - **Countdown & Keystroke Veto**: Waits rule delay (default 3s). Any user keystroke during countdown instantly vetoes auto-accept. Mid-typing safety treats any user key typed within the last 1s as a veto.
  - **Circuit Breaker**: Trips and disables auto-accept for the session (reverting to ASKING) if > 8 auto answers happen in 60s or the same command is auto-answered 3 times in a row within 30s.
  - **Pause Toggle**: GUI toggle writes `autoPaused` to `config.json`, instantly pausing auto-accept across all sessions.
  - **Answer Distinguishability**: Logs whether answer was by `auto`, `user`, `vetoed`, or `unknown` in `prompts.log` and `history.jsonl`.
- **Viewer Enhancements**:
  - Dashboard and GUI display `COUNTDOWN` state with remaining seconds (`● COUNTDOWN 3s`) and `[AUTO ON]` indicator.
  - Desktop GUI header features an instant "Pause auto" toggle checkbox.

---

## What's New in Stage 3b

- **Prompt Answer Detection**:
  - Captures discrete answer signals during prompt lifetime: digit keys (`1`–`4`), `Enter` (reading `>` marker from screen), `Esc` (`cancelled`), and Tab/Ctrl+G (`amended`).
  - Resolves last signal before prompt close, or records `unknown` if no signal was seen.
- **Dry-run Agreement Evaluation**:
  - Compares dry-run decision with user answer: `agrees` if `would_approve` and user chose `yes_once`, or if decision was `blocked`/`needs_user` and user chose `no` or did not choose `yes_once`; `differs` otherwise; `n/a` if answer unknown.
  - Records duration (seconds from prompt appearance to closing) on `prompt_closed` event.
- **Updated GUI History Cards**:
  - Shows real answer, e.g. `You chose: 1. Yes, run command (yes once)` (or `You cancelled`, `You amended`, `Answer: not detected`).
  - Small decision badge: `Tool would have agreed` or `Tool would have differed`.
- **Top Agent History Summary Line**:
  - Summarizes: `Out of N prompts, the dry run would have handled M the same way you did. Persist options chosen: P · Needs you prompts: Q` (counting only prompts with known answer).
- **Strict Privacy Guarantee**:
  - Zero keystroke text leaked to disk; verified by automated tests scanning all output files against simulated passwords and random input strings.

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
| `tests/test-stage4.js` | Stage 4 auto-accept test suite: single option key write path, 2/4/8 options, no-send conditions, countdown vetoes, circuit breaker, unmasked deny checks, mock app fake-agent integration, and privacy scans. |
| `tests/test-stage3b.js` | Stage 3b test suite covering: digit answers (1-4), Enter reading `>` marker from screen, Esc cancellation, Tab/Ctrl+G amend editing, answer unknown, last signal wins, agreement logic combinations, zero keystroke text leak scan, and hard safety rules re-run. |
| `tests/test-stage3a.js` | Stage 3a test suite covering: single-instance behavior, detached launch, large fake file reading (< 50ms), malformed lines, key filtering, unassigned events, atomic clear-history, time display with real weekday, session grouping, and Electron security settings. |
| `tests/test-gui.js` | Stage 2.5 GUI test suite covering: shared module agreement, drag-and-drop reordering, and security settings. |
| `tests/test-dashboard.js` | Stage 2 dashboard test suite. |
| `tests/test-agentwatch.js` | Stage 1 test suite. |
| `tests/test-unit.js` | Unit tests for parser and state tracker. |
| `tests/test-fast-prompt.js` | Fast prompt dismissal integration test (< 500 ms). |
| `tests/test-integration.js` | End-to-end integration tests with mock CLI apps. |
| `tests/test-custom-locations.js` | Custom locations test suite: custom log/snapshot directories, CLI flags, env vars, config persistence, and non-existent folder auto-creation. |

---

## Test Commands

To run all test suites:
```bash
npm run test:all
```

To run individual suites:
```bash
# Stage 4 auto-accept test suite (Auto-accept rules, single key write path, circuit breaker, countdown vetoes)
npm run test:stage4

# Stage 3b test suite (Prompt answers, agreement logic, zero keystroke leaks, safety rules)
npm run test:stage3b

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

With auto-accept enabled (Stage 4):
```bash
agentwatch --auto agy
```

With raw session stream recording enabled:
```bash
agentwatch --record agy
```

With custom storage location for logs and snapshots:
```bash
# Store all logs, screen snapshots, and recordings in a designated directory
agentwatch --log-dir D:\my-agent-logs agy

# Or specify individual target files
agentwatch --snapshots D:\my-agent-logs\snapshots.txt --prompts-log D:\my-agent-logs\prompts.log agy
```

### Customizing Log & Snapshot Locations

By default, `prompts.log`, `screen-snapshots.txt`, and `raw-session.bin` are saved in the current working directory. You can customize the storage location in any of four ways:

1. **CLI Flags**:
   - `--log-dir <dir>` or `--output-dir <dir>`: Sets directory for `prompts.log`, `screen-snapshots.txt`, and `raw-session.bin`.
   - `--prompts-log <path>`: Specifies custom path for the prompt log.
   - `--snapshots <path>`: Specifies custom path for screen snapshots.
   - `--raw-session <path>`: Specifies custom path for raw session recording.
   *(Parent directories are created automatically if they do not exist)*

2. **Environment Variables**:
   - `AGENTWATCH_LOG_DIR` or `AGENTWATCH_OUTPUT_DIR`
   - `AGENTWATCH_PROMPTS_LOG`
   - `AGENTWATCH_SNAPSHOTS_PATH`
   - `AGENTWATCH_RAW_SESSION_PATH`

3. **Persistent Configuration (`~/.agentwatch/config.json`)**:
   Add `"logDir": "C:\\path\\to\\logs"` to your config file to use that location automatically for all sessions.

4. **Programmatic Options (`startAgentwatch`)**:
   Pass `{ logDir, promptsLogPath, snapshotsPath, rawSessionPath }` in `options`.

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