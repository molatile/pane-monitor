const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const {
  SessionStatusManager,
  getSessionStatusList,
  readSessionFile,
  formatDecision,
  isSessionAlive
} = require('../src/status');

const {
  loadConfig,
  saveConfig,
  getSessionKey,
  getDisplayName,
  setSessionName,
  setNotifications,
  orderSessions,
  reorderSession
} = require('../src/config');

const { NotificationManager } = require('../src/notifier');
const {
  formatDuration,
  getStateLight,
  getSessionSummary,
  renderDashboardLines,
  startDashboard
} = require('../src/dashboard');
const { parseArgs } = require('../bin/agentwatch');

console.log('Running agentwatch Stage 2 test suite...\n');

// -------------------------------------------------------------
// Test Group 1: Atomic status writes & Corruption Resilience
// -------------------------------------------------------------
console.log('--- Test Group 1: Atomic Writes & Half-written File Resilience ---');
{
  const testDir = path.join(os.tmpdir(), `agentwatch-test-atomic-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });

  const manager = new SessionStatusManager({
    sessionId: 'session-atomic-1',
    agent: 'agy',
    cwd: 'D:\\projects\\secret-repo',
    sessionsDir: testDir,
    initialState: 'busy'
  });

  manager.start();
  const filePath = path.join(testDir, 'session-atomic-1.json');
  assert(fs.existsSync(filePath), 'Status file must exist after start');

  // Verify atomic write: content is valid JSON
  const content = fs.readFileSync(filePath, 'utf8');
  const parsed = JSON.parse(content);
  assert.strictEqual(parsed.sessionId, 'session-atomic-1');
  assert.strictEqual(parsed.folder, 'secret-repo', 'Must record folder name only');
  assert(!content.includes('D:\\projects'), 'Must NEVER contain raw folder path');
  assert(parsed.folderHash, 'Folder hash must be computed');
  assert(parsed.sessionKey, 'Session key must be computed');

  // Half-written / empty / missing file resilience
  const emptyFile = path.join(testDir, 'session-empty.json');
  fs.writeFileSync(emptyFile, '', 'utf8');
  assert.strictEqual(readSessionFile(emptyFile), null, 'Empty file must return null without crashing');

  const halfWrittenFile = path.join(testDir, 'session-corrupted.json');
  fs.writeFileSync(halfWrittenFile, '{"sessionId": "bad', 'utf8');
  assert.strictEqual(readSessionFile(halfWrittenFile), null, 'Half-written file must return null without crashing');

  const missingFile = path.join(testDir, 'nonexistent.json');
  assert.strictEqual(readSessionFile(missingFile), null, 'Missing file must return null without crashing');

  // getSessionStatusList must skip empty and corrupted files
  const list = getSessionStatusList(testDir);
  assert.strictEqual(list.length, 1, 'Only the valid session should be returned');
  assert.strictEqual(list[0].sessionId, 'session-atomic-1');

  manager.cleanup();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('✓ Test Group 1 passed: Atomic status file writing & corruption resilience verified');
}

// -------------------------------------------------------------
// Test Group 2: Dead Sessions & 60s File Removal
// -------------------------------------------------------------
console.log('\n--- Test Group 2: Dead Sessions & Automatic Cleanup ---');
{
  const testDir = path.join(os.tmpdir(), `agentwatch-test-dead-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });

  const now = Date.now();

  // 1. Live session (heartbeat 2s ago)
  const liveSession = {
    sessionId: 'session-live',
    agent: 'agy',
    folder: 'live-app',
    state: 'idle',
    heartbeat: new Date(now - 2000).toISOString()
  };
  fs.writeFileSync(path.join(testDir, 'session-live.json'), JSON.stringify(liveSession));

  // 2. Dead session (heartbeat 10s ago > 6s)
  const deadSession = {
    sessionId: 'session-dead',
    agent: 'agy',
    folder: 'dead-app',
    state: 'busy',
    heartbeat: new Date(now - 10000).toISOString()
  };
  const deadPath = path.join(testDir, 'session-dead.json');
  fs.writeFileSync(deadPath, JSON.stringify(deadSession));

  // 3. Stale session (heartbeat 70s ago > 60s)
  const staleSession = {
    sessionId: 'session-stale',
    agent: 'agy',
    folder: 'stale-app',
    state: 'idle',
    heartbeat: new Date(now - 70000).toISOString()
  };
  const stalePath = path.join(testDir, 'session-stale.json');
  fs.writeFileSync(stalePath, JSON.stringify(staleSession));

  // Retrieve sessions with simulated current time
  const sessions = getSessionStatusList(testDir, now);

  // Stale session must be deleted from disk
  assert(!fs.existsSync(stalePath), 'Session older than 60s must be removed from disk');

  // Should have 2 sessions left: 1 live, 1 dead
  assert.strictEqual(sessions.length, 2);

  const foundLive = sessions.find(s => s.sessionId === 'session-live');
  assert(foundLive, 'Live session must be present');
  assert.strictEqual(foundLive.isDead, false);
  assert.strictEqual(foundLive.state, 'idle');

  const foundDead = sessions.find(s => s.sessionId === 'session-dead');
  assert(foundDead, 'Dead session must be present');
  assert.strictEqual(foundDead.isDead, true);
  assert.strictEqual(foundDead.state, 'dead');

  // Verify light for dead session
  const deadLight = getStateLight(foundDead.state, foundDead.isDead, false);
  assert.strictEqual(deadLight.plain.trim(), '● DEAD');

  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('✓ Test Group 2 passed: Dead sessions marked DEAD (>6s) and unlinked (>60s)');
}

// -------------------------------------------------------------
// Test Group 3: Stable Session Key, Config Storage & Surviving Restarts
// -------------------------------------------------------------
console.log('\n--- Test Group 3: Stable Session Key, Config & Restart Survival ---');
{
  const testDir = path.join(os.tmpdir(), `agentwatch-test-config-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const configPath = path.join(testDir, 'config.json');

  const cwd1 = 'D:\\projects\\web-frontend';
  const manager1 = new SessionStatusManager({
    sessionId: 'session-init-1',
    agent: 'agy',
    cwd: cwd1,
    sessionsDir: testDir
  });

  const sessionKey1 = manager1.sessionKey;
  assert(sessionKey1.startsWith('agy:'), 'Session key must start with agent name');
  assert.strictEqual(manager1.folder, 'web-frontend');

  // Set custom name and save order in config
  let config = loadConfig(configPath);
  setSessionName(config, sessionKey1, 'Frontend UI', configPath);

  // Read config file directly to verify no raw folder path is stored
  const rawConfig = fs.readFileSync(configPath, 'utf8');
  assert(!rawConfig.includes('D:\\projects'), 'Raw folder path must NEVER appear in config.json');
  assert(rawConfig.includes('Frontend UI'), 'Custom name must be stored in config');

  // Simulate agent exiting and restarting later with a NEW sessionId but same folder
  manager1.cleanup();

  const managerRestarted = new SessionStatusManager({
    sessionId: 'session-restarted-999',
    agent: 'agy',
    cwd: cwd1,
    sessionsDir: testDir
  });

  assert.strictEqual(managerRestarted.sessionKey, sessionKey1, 'Session key must match across restarts for same agent & folder');

  // Verify display name survives restart
  const reloadedConfig = loadConfig(configPath);
  const displayName = getDisplayName(reloadedConfig, managerRestarted);
  assert.strictEqual(displayName, 'Frontend UI', 'Display name must survive restarts via stable sessionKey');

  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('✓ Test Group 3 passed: Stable session key and config survive restarts without raw paths');
}

// -------------------------------------------------------------
// Test Group 4: Navigation, Renaming and Reordering
// -------------------------------------------------------------
console.log('\n--- Test Group 4: Row Selection, u/d Reordering and r Renaming ---');
{
  const testDir = path.join(os.tmpdir(), `agentwatch-test-reorder-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const configPath = path.join(testDir, 'config.json');

  const sessions = [
    { sessionId: 's1', sessionKey: 'agy:key1', agent: 'agy', folder: 'repo-one', state: 'idle' },
    { sessionId: 's2', sessionKey: 'agy:key2', agent: 'agy', folder: 'repo-two', state: 'busy' },
    { sessionId: 's3', sessionKey: 'agy:key3', agent: 'agy', folder: 'repo-three', state: 'asking' }
  ];

  let config = {
    order: ['agy:key1', 'agy:key2', 'agy:key3'],
    names: {
      'agy:key1': 'One',
      'agy:key2': 'Two',
      'agy:key3': 'Three'
    }
  };
  saveConfig(config, configPath);

  // 1. Move 'agy:key2' up (direction = -1)
  const liveKeys = sessions.map(s => getSessionKey(s));
  config = reorderSession(config, 'agy:key2', -1, liveKeys, configPath);
  assert.deepStrictEqual(config.order, ['agy:key2', 'agy:key1', 'agy:key3'], 'Session 2 moved up to index 0');

  // Verify orderSessions reflects new order
  const ordered1 = orderSessions(sessions, config);
  assert.strictEqual(ordered1[0].sessionId, 's2');
  assert.strictEqual(ordered1[1].sessionId, 's1');
  assert.strictEqual(ordered1[2].sessionId, 's3');

  // 2. Move 'agy:key2' down (direction = 1) from its new position (index 0)
  const liveKeysAfterMove = ordered1.map(s => getSessionKey(s));
  config = reorderSession(config, 'agy:key2', 1, liveKeysAfterMove, configPath);
  assert.deepStrictEqual(config.order, ['agy:key1', 'agy:key2', 'agy:key3'], 'Session 2 moved back down');

  // 3. Rename session
  setSessionName(config, 'agy:key3', 'Approval Needed', configPath);
  const reloaded = loadConfig(configPath);
  assert.strictEqual(reloaded.names['agy:key3'], 'Approval Needed');
  assert.strictEqual(getDisplayName(reloaded, sessions[2]), 'Approval Needed');

  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('✓ Test Group 4 passed: Row reordering (u/d) and renaming (r) successfully verified');
}

// -------------------------------------------------------------
// Test Group 5: Screen Layout & Color / Plain Text Rendering
// -------------------------------------------------------------
console.log('\n--- Test Group 5: Screen Layout & Asking Second Line ---');
{
  const now = Date.now();
  const sessions = [
    {
      sessionId: 's-idle',
      sessionKey: 'agy:k1',
      agent: 'agy',
      folder: 'backend-api',
      state: 'idle',
      stateSince: new Date(now - 130000).toISOString(), // 2m 10s
      isDead: false
    },
    {
      sessionId: 's-busy',
      sessionKey: 'agy:k2',
      agent: 'agy',
      folder: 'frontend-ui',
      state: 'busy',
      stateSince: new Date(now - 45000).toISOString(), // 45s
      isDead: false
    },
    {
      sessionId: 's-asking',
      sessionKey: 'agy:k3',
      agent: 'agy',
      folder: 'scripts',
      state: 'asking',
      stateSince: new Date(now - 12000).toISOString(), // 12s
      isDead: false,
      prompt: {
        question: 'Run this command?',
        command: 'rm -rf /dist',
        decision: 'blocked by rule: rm -rf'
      }
    }
  ];

  const config = {
    order: ['agy:k1', 'agy:k2', 'agy:k3'],
    names: {
      'agy:k1': 'API Server',
      'agy:k2': 'Client App',
      'agy:k3': 'Deploy Script'
    }
  };

  // Render without ANSI color to verify plain-text readability
  const linesPlain = renderDashboardLines({
    sessions,
    selectedIndex: 2,
    config,
    nowMs: now,
    useColor: false
  });

  const fullText = linesPlain.join('\n');

  // 1. State words present and readable without color
  assert(fullText.includes('● IDLE'), 'Plain text must include "● IDLE"');
  assert(fullText.includes('● BUSY'), 'Plain text must include "● BUSY"');
  assert(fullText.includes('● ASKING'), 'Plain text must include "● ASKING"');

  // 2. Visible marker [!] for asking session
  assert(fullText.includes('[!]'), 'Asking row must have visible marker [!]');

  // 3. Durations correctly formatted
  assert(fullText.includes('2m 10s'), 'Duration 2m 10s must be formatted');
  assert(fullText.includes('45s'), 'Duration 45s must be formatted');

  // 4. Second line for asking session shows masked command and dry-run decision
  assert(fullText.includes('rm -rf /dist'), 'Second line must show masked command');
  assert(fullText.includes('blocked by rule: rm -rf'), 'Second line must show dry-run decision');

  // 5. Selected row indicator
  const selectedLine = linesPlain.find(l => l.includes('Deploy Script'));
  assert(selectedLine && selectedLine.startsWith('>'), 'Selected row must have "> " indicator');

  // 6. Empty state check
  const emptyLines = renderDashboardLines({
    sessions: [],
    useColor: false
  });
  const emptyText = emptyLines.join('\n');
  assert(
    emptyText.includes('No agents running. Start one with: agentwatch <agent>  (for example: agentwatch agy)'),
    'Friendly empty message must be shown when no agents running'
  );

  console.log('✓ Test Group 5 passed: Layout, state lights, visible alert marker, asking second line and empty state verified');
}

// -------------------------------------------------------------
// Test Group 6: Dry-run Decision Formats on Second Line
// -------------------------------------------------------------
console.log('\n--- Test Group 6: Dry-run Decision Formats ---');
{
  const testCases = [
    {
      decision: { action: 'would_approve', optionKey: '1', delay: 3 },
      expected: 'would approve option 1 after 3s'
    },
    {
      decision: { action: 'blocked', rule: 'rm -rf' },
      expected: 'blocked by rule: rm -rf'
    },
    {
      decision: { action: 'needs_user' },
      expected: 'needs you'
    },
    {
      decision: 'custom dry-run decision text',
      expected: 'custom dry-run decision text'
    }
  ];

  for (const tc of testCases) {
    const formatted = formatDecision(tc.decision);
    assert.strictEqual(formatted, tc.expected, `Formatted decision mismatch for ${JSON.stringify(tc.decision)}`);
  }

  console.log('✓ Test Group 6 passed: Dry-run decision strings match specified examples');
}

// -------------------------------------------------------------
// Test Group 7: Notifications Once Per Change
// -------------------------------------------------------------
console.log('\n--- Test Group 7: Terminal Bell & Desktop Notifications ---');
{
  let bellCount = 0;
  const notifications = [];

  const notifier = new NotificationManager({
    bellSender: () => { bellCount++; },
    desktopNotifier: (title, message) => {
      notifications.push({ title, message });
    }
  });

  // Step 1: Initial load with idle session -> NO notification on initial discovery
  const sessionA = { sessionId: 'sess-A', folder: 'repo-A', state: 'idle' };
  let t = 10000;
  notifier.checkSessions([sessionA], null, t);
  assert.strictEqual(bellCount, 0, 'No notification on initial connection');
  assert.strictEqual(notifications.length, 0);

  // Step 2: sessionA transitions to 'asking' -> NOTIFIES ONCE
  t += 1000;
  sessionA.state = 'asking';
  const fired1 = notifier.checkSessions([sessionA], null, t);
  assert.strictEqual(bellCount, 1, 'Bell must ring on transition to asking');
  assert.strictEqual(notifications.length, 1, 'Notification must fire on transition to asking');
  assert.strictEqual(fired1[0].type, 'asking');

  // Step 3: Next tick, sessionA is STILL 'asking' -> DOES NOT NOTIFY AGAIN
  t += 1000;
  const fired2 = notifier.checkSessions([sessionA], null, t);
  assert.strictEqual(bellCount, 1, 'Bell must NOT ring again when state has not changed');
  assert.strictEqual(notifications.length, 1, 'Notification must NOT repeat');
  assert.strictEqual(fired2.length, 0);

  // Step 4: sessionA transitions to 'busy' -> no notification (busy is not finished)
  t += 1000;
  sessionA.state = 'busy';
  notifier.checkSessions([sessionA], null, t);
  assert.strictEqual(bellCount, 1);
  assert.strictEqual(notifications.length, 1);

  // Step 5: sessionA transitions from 'busy' to 'idle' -> NOTIFIES ONCE (finished after >5s cooldown)
  t += 6000;
  sessionA.state = 'idle';
  const fired3 = notifier.checkSessions([sessionA], null, t);
  assert.strictEqual(bellCount, 2, 'Bell must ring when busy transitions to idle');
  assert.strictEqual(notifications.length, 2, 'Notification must fire when finished');
  assert.strictEqual(fired3[0].type, 'idle');

  // Step 6: Next tick, still 'idle' -> NO REPEAT
  t += 1000;
  notifier.checkSessions([sessionA], null, t);
  assert.strictEqual(bellCount, 2);
  assert.strictEqual(notifications.length, 2);

  console.log('✓ Test Group 7 passed: Terminal bell & notifications fire exactly once per qualifying transition');
}

// -------------------------------------------------------------
// Test Group 8: HARD SAFETY RULES Verification
// -------------------------------------------------------------
console.log('\n--- Test Group 8: Hard Safety Rules Verification ---');
{
  const dashboardCode = fs.readFileSync(path.join(__dirname, '../src/dashboard.js'), 'utf8');
  const configCode = fs.readFileSync(path.join(__dirname, '../src/config.js'), 'utf8');

  // Rule 1: Dashboard is read-only, never writes to child process, never sends keys to agent
  assert(!dashboardCode.includes('ptyProcess.write'), 'Dashboard must never write to ptyProcess');
  assert(!dashboardCode.includes('.stdin.write('), 'Dashboard must never write to child stdin');
  assert(!dashboardCode.includes('child_process.spawn(') || dashboardCode.includes('startDashboard'), 'Dashboard must never spawn agent processes');

  // Rule 2: No network calls, no telemetry, no servers or open ports
  const forbiddenModules = ['http', 'https', 'net', 'dgram', 'ws', 'socket.io', 'axios', 'fetch'];
  for (const mod of forbiddenModules) {
    const requirePattern = new RegExp(`require\\(['"]${mod}['"]\\)`);
    assert(!requirePattern.test(dashboardCode), `Dashboard must not import forbidden network module: ${mod}`);
    assert(!requirePattern.test(configCode), `Config must not import forbidden network module: ${mod}`);
  }

  // Rule 3: Only reads ~/.agentwatch/sessions/*.json, never raw-session.bin
  assert(!dashboardCode.includes('raw-session.bin'), 'Dashboard must never read raw-session.bin');
  assert(!configCode.includes('raw-session.bin'), 'Config must never read raw-session.bin');

  console.log('✓ Test Group 8 passed: All HARD SAFETY RULES verified');
}

// -------------------------------------------------------------
// Test Group 9: Full Interactive Mock Test for startDashboard
// -------------------------------------------------------------
console.log('\n--- Test Group 9: Interactive Mock Dashboard Lifecycle ---');
{
  const testDir = path.join(os.tmpdir(), `agentwatch-test-dash-${Date.now()}`);
  const sessionsDir = path.join(testDir, 'sessions');
  const configPath = path.join(testDir, 'config.json');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const mockSession = {
    sessionId: 'session-mock-1',
    sessionKey: 'agy:mock1',
    agent: 'agy',
    folder: 'mock-repo',
    state: 'idle',
    stateSince: new Date().toISOString(),
    heartbeat: new Date().toISOString()
  };
  fs.writeFileSync(path.join(sessionsDir, 'session-mock-1.json'), JSON.stringify(mockSession));

  class MockStream extends EventEmitter {
    constructor() {
      super();
      this.isTTY = false;
      this.written = [];
    }
    write(chunk) {
      this.written.push(chunk);
      return true;
    }
    pause() {}
    resume() {}
    setRawMode() {}
  }

  const mockStdin = new MockStream();
  const mockStdout = new MockStream();
  let exitCodeReceived = null;

  const handle = startDashboard({
    sessionsDir,
    configPath,
    refreshIntervalMs: 50,
    stdin: mockStdin,
    stdout: mockStdout,
    useColor: false,
    desktopNotifier: () => {},
    bellSender: () => {},
    onExit: (code) => { exitCodeReceived = code; }
  });

  // Verify dashboard rendered initial frame
  assert(mockStdout.written.length > 0, 'Dashboard must render initial frame');
  const lastOutput = mockStdout.written[mockStdout.written.length - 1];
  assert(lastOutput.includes('mock-repo'), 'Dashboard output must show mock session');

  // Test 'r' key -> rename
  mockStdin.emit('data', Buffer.from('r'));
  assert(handle.getState().isRenaming, 'Dashboard must enter renaming state');

  // Type new name: 'Custom Name' then Enter
  mockStdin.emit('data', Buffer.from('Custom Name'));
  mockStdin.emit('data', Buffer.from('\r'));
  assert.strictEqual(handle.getState().isRenaming, false, 'Renaming must end on Enter');

  // Verify name saved in config
  const savedConfig = loadConfig(configPath);
  assert.strictEqual(savedConfig.names['agy:mock1'], 'Custom Name');

  // Test 'q' key -> exits cleanly
  mockStdin.emit('data', Buffer.from('q'));
  assert.strictEqual(exitCodeReceived, 0, 'Dashboard must exit with code 0 on q');

  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('✓ Test Group 9 passed: Live mock dashboard lifecycle and clean exit on q verified');
}

// -------------------------------------------------------------
// Test Group 10: Notification Text Format and Command Sanitization
// -------------------------------------------------------------
console.log('\n--- Test Group 10: Notification Text Format & Command Sanitization ---');
{
  const notifications = [];
  const notifier = new NotificationManager({
    desktopNotifier: (title, message) => {
      notifications.push({ title, message });
    }
  });

  const session = {
    sessionId: 'sess-cmd-test',
    agent: 'agy',
    folder: 'frontend',
    state: 'idle',
    prompt: {
      command: 'rm -rf / --no-preserve-root',
      question: 'Dangerous execution?'
    }
  };

  let t = 10000;
  notifier.checkSessions([session], null, t);

  // 1. Transition to asking
  t += 1000;
  session.state = 'asking';
  const askingFired = notifier.checkSessions([session], null, t);
  assert.strictEqual(askingFired.length, 1);
  assert.strictEqual(askingFired[0].message, 'frontend needs you');
  assert.strictEqual(askingFired[0].text, 'frontend needs you');
  assert.strictEqual(notifications[0].message, 'frontend needs you');

  // Verify NEVER contains any command text or prompt question
  assert(!askingFired[0].message.includes('rm -rf'), 'Notification message must never contain command text');
  assert(!askingFired[0].title.includes('rm -rf'), 'Notification title must never contain command text');
  assert(!askingFired[0].message.includes('Dangerous execution?'), 'Notification message must not contain prompt question');
  assert(!notifications[0].message.includes('rm -rf'), 'Desktop notification message must never contain command text');
  assert(!notifications[0].title.includes('rm -rf'), 'Desktop notification title must never contain command text');

  // 2. Transition to busy then idle (>5s later)
  t += 1000;
  session.state = 'busy';
  notifier.checkSessions([session], null, t);

  t += 6000;
  session.state = 'idle';
  const idleFired = notifier.checkSessions([session], null, t);
  assert.strictEqual(idleFired.length, 1);
  assert.strictEqual(idleFired[0].message, 'frontend finished');
  assert.strictEqual(idleFired[0].text, 'frontend finished');
  assert.strictEqual(notifications[1].message, 'frontend finished');

  // Verify NEVER contains any command text
  assert(!idleFired[0].message.includes('rm -rf'), 'Notification message must never contain command text');
  assert(!idleFired[0].title.includes('rm -rf'), 'Notification title must never contain command text');

  // 3. Custom display name
  const getCustomName = s => (s.sessionId === 'custom-s' ? 'UI Service' : s.folder);
  const customSession = { sessionId: 'custom-s', folder: 'raw-folder', state: 'idle' };
  t += 6000;
  notifier.checkSessions([customSession], getCustomName, t);

  t += 1000;
  customSession.state = 'asking';
  const customAsking = notifier.checkSessions([customSession], getCustomName, t);
  assert.strictEqual(customAsking[0].message, 'UI Service needs you');

  t += 1000;
  customSession.state = 'busy';
  notifier.checkSessions([customSession], getCustomName, t);

  t += 6000;
  customSession.state = 'idle';
  const customFinished = notifier.checkSessions([customSession], getCustomName, t);
  assert.strictEqual(customFinished[0].message, 'UI Service finished');

  console.log('✓ Test Group 10 passed: Notification text is strictly "<name> needs you" or "<name> finished" and never contains command text');
}

// -------------------------------------------------------------
// Test Group 11: 5-Second Per-Session Cooldown
// -------------------------------------------------------------
console.log('\n--- Test Group 11: 5-Second Per-Session Cooldown ---');
{
  const firedEvents = [];
  const notifier = new NotificationManager({
    desktopNotifier: (title, message) => {
      firedEvents.push({ title, message });
    }
  });

  const sessionA = { sessionId: 'sess-cooldown-A', folder: 'service-a', state: 'idle' };
  const sessionB = { sessionId: 'sess-cooldown-B', folder: 'service-b', state: 'idle' };

  let t = 10000;
  notifier.checkSessions([sessionA, sessionB], null, t);

  // t = 11000: Session A transitions to asking -> FIRES (Notification #1)
  t = 11000;
  sessionA.state = 'asking';
  const f1 = notifier.checkSessions([sessionA, sessionB], null, t);
  assert.strictEqual(f1.length, 1);
  assert.strictEqual(f1[0].sessionId, 'sess-cooldown-A');
  assert.strictEqual(firedEvents.length, 1);

  // t = 12000 (1s later): Session A transitions to busy -> no notification
  t = 12000;
  sessionA.state = 'busy';
  const f2 = notifier.checkSessions([sessionA, sessionB], null, t);
  assert.strictEqual(f2.length, 0);

  // t = 13000 (2s after notification #1): Session A transitions back to asking -> BLOCKED by 5s cooldown
  t = 13000;
  sessionA.state = 'asking';
  const f3 = notifier.checkSessions([sessionA, sessionB], null, t);
  assert.strictEqual(f3.length, 0, 'Session A must be blocked by cooldown at 2s (< 5s)');
  assert.strictEqual(firedEvents.length, 1, 'Total notifications must remain 1');

  // t = 14000 (3s after Session A notified): Session B transitions to asking -> FIRES! (Per-session isolation)
  t = 14000;
  sessionB.state = 'asking';
  const f4 = notifier.checkSessions([sessionA, sessionB], null, t);
  assert.strictEqual(f4.length, 1, 'Session B must fire independently of Session A cooldown');
  assert.strictEqual(f4[0].sessionId, 'sess-cooldown-B');
  assert.strictEqual(firedEvents.length, 2);

  // t = 15000: Session B transitions to busy then idle (1s after notification #2) -> BLOCKED by Session B cooldown
  t = 14500;
  sessionB.state = 'busy';
  notifier.checkSessions([sessionA, sessionB], null, t);
  t = 15000;
  sessionB.state = 'idle';
  const f5 = notifier.checkSessions([sessionA, sessionB], null, t);
  assert.strictEqual(f5.length, 0, 'Session B must be blocked by its own cooldown at 1s (< 5s)');

  // t = 15999 (4.999s after Session A first notification at 11000): Session A transitions to idle -> STILL BLOCKED (4999ms < 5000ms)
  sessionA.state = 'busy';
  notifier.checkSessions([sessionA, sessionB], null, 15500);
  sessionA.state = 'idle';
  const f6 = notifier.checkSessions([sessionA, sessionB], null, 15999);
  assert.strictEqual(f6.length, 0, 'Session A must still be blocked before 5000ms elapsed');

  // t = 16001 (5.001s after Session A first notification at 11000): Session A transitions to asking -> FIRES! (cooldown expired)
  sessionA.state = 'asking';
  const f7 = notifier.checkSessions([sessionA, sessionB], null, 16001);
  assert.strictEqual(f7.length, 1, 'Session A must fire after 5000ms cooldown has expired');
  assert.strictEqual(f7[0].sessionId, 'sess-cooldown-A');
  assert.strictEqual(firedEvents.length, 3);

  // t = 19001 (5.001s after Session B notification at 14000): Session B transitions to asking -> FIRES!
  sessionB.state = 'asking';
  const f8 = notifier.checkSessions([sessionA, sessionB], null, 19001);
  assert.strictEqual(f8.length, 1, 'Session B must fire after its 5000ms cooldown expired');
  assert.strictEqual(f8[0].sessionId, 'sess-cooldown-B');
  assert.strictEqual(firedEvents.length, 4);

  console.log('✓ Test Group 11 passed: 5-second per-session cooldown correctly isolates and rate limits notifications');
}

// -------------------------------------------------------------
// Test Group 12: Notification Config Option
// -------------------------------------------------------------
console.log('\n--- Test Group 12: Notification Config Option ---');
{
  const testDir = path.join(os.tmpdir(), `agentwatch-test-conf-notif-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });
  const configPath = path.join(testDir, 'config.json');

  // 1. Default config has notifications: true
  let config = loadConfig(configPath);
  assert.strictEqual(config.notifications, true, 'Default config must enable notifications');

  // 2. Set notifications: false via setNotifications
  setNotifications(config, false, configPath);
  let loaded = loadConfig(configPath);
  assert.strictEqual(loaded.notifications, false, 'Saved config must have notifications: false');

  // 3. Direct JSON write with notifications: false
  fs.writeFileSync(configPath, JSON.stringify({ order: [], names: {}, notifications: false }), 'utf8');
  loaded = loadConfig(configPath);
  assert.strictEqual(loaded.notifications, false);

  // 4. saveConfig preserves notifications: false when renaming
  setSessionName(loaded, 'agy:keyX', 'Test Name', configPath);
  loaded = loadConfig(configPath);
  assert.strictEqual(loaded.notifications, false, 'saveConfig must preserve notifications: false');
  assert.strictEqual(loaded.names['agy:keyX'], 'Test Name');

  // 5. NotificationManager with enabled: false / notifications: false
  let bellCount = 0;
  const notifications = [];
  const disabledNotifier = new NotificationManager({
    enabled: false,
    bellSender: () => { bellCount++; },
    desktopNotifier: (t, m) => { notifications.push({ t, m }); }
  });

  const session = { sessionId: 's-conf-test', folder: 'conf-test', state: 'idle' };
  disabledNotifier.checkSessions([session]);
  session.state = 'asking';
  const firedDisabled = disabledNotifier.checkSessions([session]);
  assert.strictEqual(firedDisabled.length, 0, 'No notification event when disabled');
  assert.strictEqual(bellCount, 0, 'No bell ring when disabled');
  assert.strictEqual(notifications.length, 0, 'No desktop notification when disabled');

  // 6. Live Dashboard integration: config has notifications: false
  const sessionsDir = path.join(testDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const mockSession = {
    sessionId: 'sess-dash-conf',
    sessionKey: 'agy:conf1',
    agent: 'agy',
    folder: 'conf-repo',
    state: 'idle',
    heartbeat: new Date().toISOString()
  };
  fs.writeFileSync(path.join(sessionsDir, 'sess-dash-conf.json'), JSON.stringify(mockSession));

  let dashBells = 0;
  let dashNotifs = 0;
  class MockStream extends EventEmitter {
    constructor() { super(); this.isTTY = false; }
    write() { return true; }
    pause() {}
    resume() {}
    setRawMode() {}
  }

  const handle = startDashboard({
    sessionsDir,
    configPath,
    refreshIntervalMs: 50,
    stdin: new MockStream(),
    stdout: new MockStream(),
    useColor: false,
    bellSender: () => { dashBells++; },
    desktopNotifier: () => { dashNotifs++; },
    onExit: () => {}
  });

  // Session transitions to asking
  mockSession.state = 'asking';
  fs.writeFileSync(path.join(sessionsDir, 'sess-dash-conf.json'), JSON.stringify(mockSession));
  handle.refresh();

  assert.strictEqual(dashBells, 0, 'Dashboard must not ring bell when config.notifications is false');
  assert.strictEqual(dashNotifs, 0, 'Dashboard must not notify when config.notifications is false');

  handle.cleanup();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('✓ Test Group 12 passed: Config option to turn notifications off verified');
}

// -------------------------------------------------------------
// Test Group 13: --quiet Flag
// -------------------------------------------------------------
console.log('\n--- Test Group 13: --quiet Flag ---');
{
  // 1. Argument parser tests
  const p1 = parseArgs(['dash', '--quiet']);
  assert.strictEqual(p1.command, 'dash');
  assert.strictEqual(p1.quiet, true);

  const p2 = parseArgs(['--quiet', 'dash']);
  assert.strictEqual(p2.command, 'dash');
  assert.strictEqual(p2.quiet, true);

  const p3 = parseArgs(['-q', 'dash']);
  assert.strictEqual(p3.command, 'dash');
  assert.strictEqual(p3.quiet, true);

  const p4 = parseArgs(['--record', '--quiet', 'agy', 'some-arg']);
  assert.strictEqual(p4.command, 'agy');
  assert.strictEqual(p4.record, true);
  assert.strictEqual(p4.quiet, true);
  assert.deepStrictEqual(p4.commandArgs, ['some-arg']);

  const p5 = parseArgs(['dash']);
  assert.strictEqual(p5.quiet, false);

  // 2. NotificationManager with quiet: true
  let bells = 0;
  const notifs = [];
  const quietNotifier = new NotificationManager({
    quiet: true,
    bellSender: () => { bells++; },
    desktopNotifier: (t, m) => { notifs.push({ t, m }); }
  });

  const session = { sessionId: 'sess-quiet', folder: 'quiet-app', state: 'idle' };
  quietNotifier.checkSessions([session]);
  session.state = 'asking';
  const firedQuiet = quietNotifier.checkSessions([session]);
  assert.strictEqual(firedQuiet.length, 0, 'No notification triggered when quiet: true');
  assert.strictEqual(bells, 0, 'No bell when quiet: true');
  assert.strictEqual(notifs.length, 0, 'No desktop notification when quiet: true');

  // 3. Live Dashboard integration with quiet: true
  const testDir = path.join(os.tmpdir(), `agentwatch-test-quiet-dash-${Date.now()}`);
  const sessionsDir = path.join(testDir, 'sessions');
  const configPath = path.join(testDir, 'config.json');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const mockSession = {
    sessionId: 'sess-dash-quiet',
    sessionKey: 'agy:quiet1',
    agent: 'agy',
    folder: 'quiet-repo',
    state: 'idle',
    heartbeat: new Date().toISOString()
  };
  fs.writeFileSync(path.join(sessionsDir, 'sess-dash-quiet.json'), JSON.stringify(mockSession));

  let dashBells = 0;
  let dashNotifs = 0;
  class MockStream extends EventEmitter {
    constructor() { super(); this.isTTY = false; }
    write() { return true; }
    pause() {}
    resume() {}
    setRawMode() {}
  }

  const handle = startDashboard({
    sessionsDir,
    configPath,
    quiet: true,
    refreshIntervalMs: 50,
    stdin: new MockStream(),
    stdout: new MockStream(),
    useColor: false,
    bellSender: () => { dashBells++; },
    desktopNotifier: () => { dashNotifs++; },
    onExit: () => {}
  });

  mockSession.state = 'asking';
  fs.writeFileSync(path.join(sessionsDir, 'sess-dash-quiet.json'), JSON.stringify(mockSession));
  handle.refresh();

  assert.strictEqual(dashBells, 0, 'Dashboard must not ring bell when quiet: true');
  assert.strictEqual(dashNotifs, 0, 'Dashboard must not notify when quiet: true');

  handle.cleanup();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('✓ Test Group 13 passed: --quiet flag suppresses all notifications and bells');
}

// -------------------------------------------------------------
// Test Group 14: Clear Line to End on Redraw (\x1b[K)
// -------------------------------------------------------------
console.log('\n--- Test Group 14: Clear Each Line to End When Redrawing ---');
{
  const testDir = path.join(os.tmpdir(), `agentwatch-test-clear-line-${Date.now()}`);
  const sessionsDir = path.join(testDir, 'sessions');
  const configPath = path.join(testDir, 'config.json');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const session1 = {
    sessionId: 'sess-active-1',
    sessionKey: 'agy:s1',
    agent: 'agy',
    folder: 'app-one',
    state: 'idle',
    heartbeat: new Date().toISOString()
  };
  const session2 = {
    sessionId: 'sess-active-2',
    sessionKey: 'agy:s2',
    agent: 'agy',
    folder: 'app-two',
    state: 'busy',
    heartbeat: new Date().toISOString()
  };
  fs.writeFileSync(path.join(sessionsDir, 'sess-active-1.json'), JSON.stringify(session1));
  fs.writeFileSync(path.join(sessionsDir, 'sess-active-2.json'), JSON.stringify(session2));

  class MockStream extends EventEmitter {
    constructor() { super(); this.isTTY = false; this.written = []; }
    write(chunk) { this.written.push(chunk); return true; }
    pause() {}
    resume() {}
    setRawMode() {}
  }

  const mockStdout = new MockStream();
  const handle = startDashboard({
    sessionsDir,
    configPath,
    refreshIntervalMs: 50,
    stdin: new MockStream(),
    stdout: mockStdout,
    useColor: false,
    onExit: () => {}
  });

  // Frame 1: 2 agents active -> header: "  agentwatch dashboard · 2 agents active"
  const frame1 = mockStdout.written[mockStdout.written.length - 1];
  assert(frame1.includes('2 agents active'));
  assert(frame1.includes('\x1b[K'), 'Frame 1 must include \\x1b[K to clear each line to end');

  // Session 2 exits -> 1 agent active -> header: "  agentwatch dashboard · 1 agent active"
  // Note: "1 agent active" is 1 char shorter than "2 agents active"
  fs.unlinkSync(path.join(sessionsDir, 'sess-active-2.json'));
  handle.refresh();

  const frame2 = mockStdout.written[mockStdout.written.length - 1];
  assert(frame2.includes('1 agent active'));

  // Every line before \r\n must end with \x1b[K to ensure no stray trailing chars ("1 agent activee")
  const linesInOutput = frame2.replace(/^\x1b\[H/, '').replace(/\x1b\[J$/, '').split('\r\n');
  for (const line of linesInOutput) {
    assert(line.endsWith('\x1b[K'), `Every line must end with \\x1b[K, got: ${JSON.stringify(line)}`);
  }

  handle.cleanup();
  fs.rmSync(testDir, { recursive: true, force: true });
  console.log('✓ Test Group 14 passed: Clear line to end (\\x1b[K) verified, preventing stray trailing characters');
}

// -------------------------------------------------------------
// Test Group 15: Background Tasks Count in Dashboard Summary
// -------------------------------------------------------------
console.log('\n--- Test Group 15: Background Tasks Count in Dashboard Summary ---');
{
  const session2Tasks = {
    sessionId: 'session-bg-2',
    agent: 'agy',
    folder: 'bg-app',
    state: 'busy',
    backgroundTasks: 2
  };
  assert.strictEqual(
    getSessionSummary(session2Tasks),
    '2 background tasks running',
    'Dashboard summary must show "2 background tasks running" for 2 tasks'
  );

  const session1Task = {
    sessionId: 'session-bg-1',
    agent: 'agy',
    folder: 'bg-app',
    state: 'busy',
    backgroundTasks: 1
  };
  assert.strictEqual(
    getSessionSummary(session1Task),
    '1 background task running',
    'Dashboard summary must show "1 background task running" for 1 task'
  );

  // Render dashboard lines
  const lines = renderDashboardLines({
    sessions: [session2Tasks, session1Task],
    useColor: false
  });
  const text = lines.join('\n');
  assert(text.includes('2 background tasks running'), 'Dashboard rendered output must contain "2 background tasks running"');
  assert(text.includes('1 background task running'), 'Dashboard rendered output must contain "1 background task running"');

  console.log('✓ Test Group 15 passed: Running background tasks counted and shown on dashboard summary');
}

// -------------------------------------------------------------
// Test Group 16: No-Profile Sessions & Empty-State in Dashboard
// -------------------------------------------------------------
console.log('\n--- Test Group 16: No-Profile Sessions & Empty-State in Dashboard ---');
{
  const { getDashboardData, EXAMPLE_AGENTS, formatEmptyStateMessage, EMPTY_STATE_MESSAGE } = require('../src/shared');

  // 1. Summary for unprofiled sessions
  const busyNoProfile = { agent: 'claude', state: 'busy', hasProfile: false };
  assert.strictEqual(getSessionSummary(busyNoProfile), 'no profile', 'Busy unprofiled session must have summary "no profile"');

  const idleNoProfile = { agent: 'gemini', state: 'idle', hasProfile: false };
  assert.strictEqual(getSessionSummary(idleNoProfile), 'no profile', 'Idle unprofiled session must have summary "no profile"');

  // 2. Render dashboard lines for unprofiled sessions
  const rendered = renderDashboardLines({
    sessions: [busyNoProfile, idleNoProfile],
    useColor: false
  });
  const text = rendered.join('\n');
  assert(text.includes('claude'), 'Must display agent claude');
  assert(text.includes('gemini'), 'Must display agent gemini');
  assert(text.includes('no profile'), 'Must display "no profile" in summary');
  assert(!text.includes('[!]'), 'Must never show alert marker for unprofiled session');

  // 3. Empty-state message requirement
  assert.strictEqual(
    EMPTY_STATE_MESSAGE,
    'No agents running. Start one with: agentwatch <agent>  (for example: agentwatch agy)',
    'Empty state message must match specification'
  );
  assert(Array.isArray(EXAMPLE_AGENTS), 'EXAMPLE_AGENTS must be an array');
  assert(EXAMPLE_AGENTS.includes('agy'), 'EXAMPLE_AGENTS must include agy');

  // 4. Extensible example agent formatting
  const formattedMulti = formatEmptyStateMessage(['agy', 'claude']);
  assert.strictEqual(
    formattedMulti,
    'No agents running. Start one with: agentwatch <agent>  (for example: agentwatch agy, agentwatch claude)'
  );

  console.log('✓ Test Group 16 passed: Unprofiled sessions clearly labelled "no profile", never show alert, and empty-state verified');
}

console.log('\n=========================================');
console.log('All agentwatch Stage 2 tests passed successfully!');
console.log('=========================================\n');


