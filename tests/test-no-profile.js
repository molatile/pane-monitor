const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const { getProfileForCommand, getNoProfileNotice } = require('../src/profile');
const { startAgentwatch } = require('../src/agentwatch');
const { SessionStateTracker } = require('../src/state');
const { SessionStatusManager, getSessionStatusList } = require('../src/status');
const {
  renderDashboardLines,
  getSessionSummary
} = require('../src/dashboard');
const {
  getDashboardData,
  EXAMPLE_AGENTS,
  formatEmptyStateMessage,
  EMPTY_STATE_MESSAGE
} = require('../src/shared');

console.log('Running tests for commands with no matching profile...\n');

let passCount = 0;
function test(name, fn) {
  fn();
  passCount++;
  console.log(`✓ Passed: ${name}`);
}

// -------------------------------------------------------------
// 1. Profile Resolution & Fallback Safety
// -------------------------------------------------------------
test('getProfileForCommand returns null for commands with no profile (claude, gemini, etc.)', () => {
  assert.strictEqual(getProfileForCommand('claude'), null);
  assert.strictEqual(getProfileForCommand('gemini'), null);
  assert.strictEqual(getProfileForCommand('unknown-tool'), null);
  assert.strictEqual(getProfileForCommand(''), null);
  assert.strictEqual(getProfileForCommand(null), null);
  assert.strictEqual(getProfileForCommand(undefined), null);

  // Profiled commands still resolve properly
  const agyProfile = getProfileForCommand('agy');
  assert(agyProfile !== null);
  assert.strictEqual(agyProfile.id, 'agy');

  const antigravityProfile = getProfileForCommand('antigravity');
  assert(antigravityProfile !== null);
  assert.strictEqual(antigravityProfile.id, 'agy');
});

// -------------------------------------------------------------
// 2. Notice Format
// -------------------------------------------------------------
test('Notice string correctly says "No profile for <name>: prompts won\'t be detected. Profiles can be added in profiles/"', () => {
  const claudeNotice = getNoProfileNotice('claude');
  assert.strictEqual(claudeNotice, "No profile for claude: prompts won't be detected. Profiles can be added in profiles/");

  const geminiNotice = getNoProfileNotice('gemini');
  assert.strictEqual(geminiNotice, "No profile for gemini: prompts won't be detected. Profiles can be added in profiles/");
});

// -------------------------------------------------------------
// 3. Wrapper Launch, Pass-Through, & Notice
// -------------------------------------------------------------
test('Wrapper launches unprofiled agent normally, passes through keyboard input, and outputs notice', () => {
  class MockPty extends EventEmitter {
    constructor() {
      super();
      this.pid = 12345;
      this.written = [];
    }
    write(data) {
      this.written.push(data.toString());
    }
    resize() {}
    onData(fn) { this.on('data', fn); }
    onExit(fn) { this.on('exit', fn); }
  }

  const mockPty = new MockPty();
  const mockStdin = new EventEmitter();
  mockStdin.isTTY = false;
  mockStdin.pause = () => {};
  mockStdin.resume = () => {};
  mockStdin.setRawMode = () => {};

  const mockStdout = {
    columns: 80,
    rows: 24,
    write: () => {},
    on: () => {},
    removeListener: () => {}
  };

  const tempDir = path.join(os.tmpdir(), `test-no-profile-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const promptsLogPath = path.join(tempDir, 'prompts.log');

  let noticeReceived = null;
  const instance = startAgentwatch({
    command: 'claude',
    ptyProcess: mockPty,
    stdin: mockStdin,
    stdout: mockStdout,
    sessionsDir: tempDir,
    promptsLogPath,
    onNotice: (n) => { noticeReceived = n; }
  });

  // Verify notice output
  assert.strictEqual(noticeReceived, "No profile for claude: prompts won't be detected. Profiles can be added in profiles/");
  assert.strictEqual(instance.hasProfile, false);
  assert.strictEqual(instance.agentName, 'claude');

  // Verify pass-through unchanged
  mockStdin.emit('data', Buffer.from('hello claude\r'));
  assert.strictEqual(mockPty.written.length, 1);
  assert.strictEqual(mockPty.written[0], 'hello claude\r');

  // Cleanup
  instance.cleanup();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// -------------------------------------------------------------
// 4. Session Appearance, Status & "no profile" Summary
// -------------------------------------------------------------
test('Session appears on dashboard and GUI with "no profile" in summary', () => {
  const tempDir = path.join(os.tmpdir(), `test-no-profile-dash-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });

  const statusManager = new SessionStatusManager({
    sessionId: 'session-claude-test',
    agent: 'claude',
    hasProfile: false,
    cwd: tempDir,
    pid: 54321,
    sessionsDir: tempDir
  });
  statusManager.start();

  const sessions = getSessionStatusList(tempDir);
  assert.strictEqual(sessions.length, 1);
  const session = sessions[0];
  assert.strictEqual(session.agent, 'claude');
  assert.strictEqual(session.hasProfile, false);

  // Summary check
  const summary = getSessionSummary(session);
  assert.strictEqual(summary, 'no profile', 'Summary must be clearly labelled "no profile"');

  // Dashboard line rendering check
  const lines = renderDashboardLines({
    sessions: [session],
    useColor: false
  });
  const output = lines.join('\n');
  assert(output.includes('claude'), 'Dashboard must show agent name');
  assert(output.includes('no profile'), 'Dashboard must display "no profile" in summary');
  assert(!output.includes('[!]'), 'Must never show alert marker for unprofiled agent');

  // Structured GUI data agreement
  const guiData = getDashboardData({ sessionsDir: tempDir });
  assert.strictEqual(guiData.sessions.length, 1);
  assert.strictEqual(guiData.sessions[0].agent, 'claude');
  assert.strictEqual(guiData.sessions[0].hasProfile, false);
  assert.strictEqual(guiData.sessions[0].summary, 'no profile');
  assert.strictEqual(guiData.sessions[0].isAsking, false);
  assert.strictEqual(guiData.sessions[0].prompt, null);

  statusManager.cleanup();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// -------------------------------------------------------------
// 5. State Classifier: BUSY or IDLE strictly on screen changes, NEVER ASKING
// -------------------------------------------------------------
test('State is BUSY or IDLE based on visible screen changes, NEVER shows ASKING or makes decisions', () => {
  let stateTransitions = [];
  const tracker = new SessionStateTracker(null, (oldState, newState) => {
    stateTransitions.push({ oldState, newState });
  });

  assert.strictEqual(tracker.hasProfile, false);
  assert.strictEqual(tracker.currentState, 'idle');

  // Frame 1: initial text appears at t = 1000
  tracker.evaluateState({
    screenLines: [
      { text: 'Claude is thinking...', isWrapped: false }
    ],
    nowMs: 1000
  });
  assert.strictEqual(tracker.currentState, 'busy', 'Initial visible output marks session BUSY');

  // Frame 2: screen continues changing at t = 2000
  tracker.evaluateState({
    screenLines: [
      { text: 'Claude: Here is the code requested.', isWrapped: false }
    ],
    nowMs: 2000
  });
  assert.strictEqual(tracker.currentState, 'busy');

  // Frame 3: Permission prompt text appears on screen at t = 3000!
  // Even if prompt lines are present, unprofiled agent must NEVER show ASKING!
  const promptScreen = [
    { text: 'Requesting permission for:', isWrapped: false },
    { text: '   rm -rf /something', isWrapped: false },
    { text: 'Run this command?', isWrapped: false },
    { text: '> 1. Yes, run command', isWrapped: false },
    { text: '  2. No, cancel', isWrapped: false },
    { text: '↑/↓ Navigate · tab Amend', isWrapped: false }
  ];
  tracker.evaluateState({
    isPromptActive: false, // Agentwatch will never activate prompt for unprofiled agent
    screenLines: promptScreen,
    nowMs: 3000
  });
  assert.strictEqual(tracker.currentState, 'busy', 'Prompt text on screen must remain BUSY, NEVER ASKING');
  assert.notStrictEqual(tracker.currentState, 'asking');

  // Frame 4: Screen remains quiet for >= 3000ms (idleThresholdMs) at t = 6500
  tracker.evaluateState({
    screenLines: promptScreen,
    nowMs: 6500
  });
  assert.strictEqual(tracker.currentState, 'idle', 'Quiet screen transitions to IDLE');
  assert.notStrictEqual(tracker.currentState, 'asking');

  // Frame 5: Screen changes again at t = 8000
  tracker.evaluateState({
    screenLines: [
      { text: 'Executing command...', isWrapped: false }
    ],
    nowMs: 8000
  });
  assert.strictEqual(tracker.currentState, 'busy', 'New visible change marks session BUSY again');

  // Verify 'asking' was never in any transition
  for (const trans of stateTransitions) {
    assert.notStrictEqual(trans.newState, 'asking');
    assert.notStrictEqual(trans.oldState, 'asking');
  }
});

// -------------------------------------------------------------
// 6. Zero Prompts Logged and Zero Approvals Made
// -------------------------------------------------------------
test('Unprofiled session generates zero prompt logs and zero approval decisions', () => {
  class MockPty extends EventEmitter {
    constructor() {
      super();
      this.pid = 9999;
    }
    write() {}
    resize() {}
    onData(fn) { this.on('data', fn); }
    onExit(fn) { this.on('exit', fn); }
  }

  const mockPty = new MockPty();
  const mockStdin = new EventEmitter();
  mockStdin.isTTY = false;
  mockStdin.pause = () => {};
  mockStdin.resume = () => {};
  mockStdin.setRawMode = () => {};

  const mockStdout = {
    columns: 80,
    rows: 24,
    write: () => {},
    on: () => {},
    removeListener: () => {}
  };

  const tempDir = path.join(os.tmpdir(), `test-no-profile-zero-prompts-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const promptsLogPath = path.join(tempDir, 'prompts.log');
  const historyPath = path.join(tempDir, 'history.jsonl');

  const instance = startAgentwatch({
    command: 'gemini',
    ptyProcess: mockPty,
    stdin: mockStdin,
    stdout: mockStdout,
    sessionsDir: tempDir,
    promptsLogPath,
    historyPath
  });

  // Emit prompt text through PTY
  mockPty.emit('data', 'Requesting permission for:\r\n   rm -rf /test\r\nRun this command?\r\n> 1. Yes, run command\r\n  2. No, cancel\r\n↑/↓ Navigate\r\n');

  // Trigger inspection
  instance.inspectScreenForPrompts(Date.now());

  // Verify status is not asking
  assert.notStrictEqual(instance.statusManager.state, 'asking');
  assert.strictEqual(instance.statusManager.prompt, null);

  // Verify prompts.log does not contain any prompt decision
  if (fs.existsSync(promptsLogPath)) {
    const content = fs.readFileSync(promptsLogPath, 'utf8');
    assert(!content.includes('Decision:'), 'prompts.log must never contain Decision');
    assert(!content.includes('Run this command?'), 'prompts.log must never log prompts for unprofiled agent');
  }

  // Verify history.jsonl is empty or does not exist
  if (fs.existsSync(historyPath)) {
    const historyContent = fs.readFileSync(historyPath, 'utf8').trim();
    assert.strictEqual(historyContent, '', 'history.jsonl must not have prompt events');
  }

  instance.cleanup();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// -------------------------------------------------------------
// 7. Empty-State Message & Extensible Example Agents
// -------------------------------------------------------------
test('Empty-state message does not name a single agent and example agent names are stored in one place', () => {
  // Empty state constant
  assert.strictEqual(
    EMPTY_STATE_MESSAGE,
    'No agents running. Start one with: agentwatch <agent>  (for example: agentwatch agy)'
  );

  // Example agents array in one place
  assert(Array.isArray(EXAMPLE_AGENTS));
  assert(EXAMPLE_AGENTS.includes('agy'));

  // Test adding more example agents later
  const extended = formatEmptyStateMessage(['agy', 'claude', 'gemini']);
  assert.strictEqual(
    extended,
    'No agents running. Start one with: agentwatch <agent>  (for example: agentwatch agy, agentwatch claude, agentwatch gemini)'
  );

  // Terminal dashboard rendering empty state
  const dashLines = renderDashboardLines({ sessions: [], useColor: false });
  assert(
    dashLines.join('\n').includes('No agents running. Start one with: agentwatch <agent>  (for example: agentwatch agy)')
  );

  // GUI data empty state
  const guiData = getDashboardData();
  assert.strictEqual(
    guiData.emptyStateMessage,
    'No agents running. Start one with: agentwatch <agent>  (for example: agentwatch agy)'
  );
});

console.log(`\n=========================================`);
console.log(`All ${passCount} tests for unprofiled commands passed successfully!`);
console.log(`=========================================\n`);
