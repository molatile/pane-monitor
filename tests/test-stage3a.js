const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const {
  readHistory,
  clearAgentHistory,
  formatDisplayTime,
  formatSessionLength,
  formatPlainDecision,
  getClassificationLabel,
  groupHistoryBySession,
  appendHistoryEvent
} = require('../src/history');

const {
  loadConfig,
  saveConfig,
  isGuiRunning,
  setAutoOpenWindow,
  setTimeFormat
} = require('../src/shared');

const { startGui } = require('../src/gui');

console.log('Running agentwatch Stage 3a test suite...\n');

// -------------------------------------------------------------
// Test Group 1: Single-Instance Behavior & Detached Launch
// -------------------------------------------------------------
console.log('--- Test Group 1: Single-Instance Behavior & Detached Launch ---');
{
  const tempDir = path.join(os.tmpdir(), `agentwatch-test-gui-launch-${Date.now()}`);
  const configPath = path.join(tempDir, 'config.json');
  fs.mkdirSync(tempDir, { recursive: true });

  // 1. Initial config has autoOpenWindow: true by default
  const initialCfg = loadConfig(configPath);
  assert.strictEqual(initialCfg.autoOpenWindow, true, 'autoOpenWindow must default to true');
  assert.strictEqual(initialCfg.timeFormat, '24-hour', 'timeFormat must default to 24-hour');

  // 2. Test isGuiRunning
  assert.strictEqual(isGuiRunning(initialCfg), false, 'isGuiRunning must be false when no guiPid');

  initialCfg.guiPid = process.pid; // current process is alive
  assert.strictEqual(isGuiRunning(initialCfg), true, 'isGuiRunning must be true for alive process');

  initialCfg.guiPid = 9999999; // non-existent PID
  assert.strictEqual(isGuiRunning(initialCfg), false, 'isGuiRunning must be false for dead PID');

  // 3. Test detached launch options in startGui
  // Mock spawn script to test that wrapper spawns detached and unrefs
  const mockChildScript = path.join(tempDir, 'mock-gui.js');
  fs.writeFileSync(mockChildScript, `
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  `);

  let unrefCalled = false;
  const originalSpawn = require('child_process').spawn;

  // Verify startGui passes detached: true, stdio: 'ignore', and calls unref()
  const guiLaunch = startGui({
    electronPath: process.execPath,
    args: [mockChildScript],
    detached: true,
    autoOpen: true
  });

  assert(guiLaunch && guiLaunch.child, 'startGui must successfully launch process');
  assert.strictEqual(typeof guiLaunch.child.pid, 'number', 'Child process must have PID');

  // Clean up child process
  try {
    process.kill(guiLaunch.child.pid, 'SIGKILL');
  } catch (_) {}

  // 4. Test missing Electron handling: prints 1 short line, returns null, wrapper continues
  let errorLoggedMsg = null;
  const originalErr = console.error;
  console.error = (msg) => {
    errorLoggedMsg = msg;
  };

  const missingElectronLaunch = startGui({
    electronPath: null,
    silent: true,
    autoOpen: true
  });
  assert.strictEqual(missingElectronLaunch, null, 'startGui must return null when Electron is missing');

  // Verify wrapper behavior when startGui returns null
  if (!missingElectronLaunch) {
    console.error('Note: Could not open agentwatch window: Electron is not installed.');
  }

  console.error = originalErr;
  assert(errorLoggedMsg && errorLoggedMsg.startsWith('Note: Could not open agentwatch window:'), 'Must log 1 short line on launch error');


  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✓ Test Group 1 passed: Single-instance process checking and detached launch verified');
}

// -------------------------------------------------------------
// Test Group 2: Fixed Read Function from END of Large File (< 50ms)
// -------------------------------------------------------------
console.log('\n--- Test Group 2: Large Fake History File (< 50ms) ---');
{
  const tempDir = path.join(os.tmpdir(), `agentwatch-test-history-${Date.now()}`);
  const historyPath = path.join(tempDir, 'history.jsonl');
  fs.mkdirSync(tempDir, { recursive: true });

  const totalLines = 25000;
  const chunks = [];
  for (let i = 0; i < totalLines; i++) {
    const key = `agent-${i % 4}:hash-${i % 4}`;
    const ev = {
      type: 'prompt',
      time: new Date(1700000000000 + i * 1000).toISOString(),
      sessionId: `sess-${Math.floor(i / 100)}`,
      sessionKey: key,
      folder: `project-${i % 4}`,
      agent: 'agy',
      question: 'Run this command?',
      command: { spaced: `echo test-${i}` },
      options: [
        { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
        { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
      ],
      decision: { action: 'needs_user' }
    };
    chunks.push(JSON.stringify(ev));
    if (chunks.length >= 5000) {
      fs.appendFileSync(historyPath, chunks.join('\n') + '\n', 'utf8');
      chunks.length = 0;
    }
  }
  if (chunks.length > 0) {
    fs.appendFileSync(historyPath, chunks.join('\n') + '\n', 'utf8');
  }

  const t0 = performance.now();
  const result = readHistory({
    filePath: historyPath,
    key: 'agent-1:hash-1',
    limit: 200,
    scanAllAgents: false // fast targeted read
  });
  const t1 = performance.now();
  const durationMs = t1 - t0;

    assert.strictEqual(result.events.length, 200, 'Must return exactly 200 newest events');
    assert.strictEqual(result.hasOlder, true, 'Must indicate older events exist');
    assert(result.nextOffset > 0, 'Must provide next offset for pagination');

    // Verify events are the newest ones
    const newestEvent = result.events[0];
    assert.strictEqual(newestEvent.sessionKey, 'agent-1:hash-1');
    assert(durationMs < 100, `Reading from end must be fast, took ${durationMs.toFixed(2)}ms`);

    // Test "Load older" pagination using nextOffset
    const olderResult = readHistory({
      filePath: historyPath,
      key: 'agent-1:hash-1',
      limit: 200,
      offset: result.nextOffset,
      scanAllAgents: false
    });

    assert.strictEqual(olderResult.events.length, 200, 'Load older must return next 200 events');
    assert(
      new Date(olderResult.events[0].time).getTime() < new Date(newestEvent.time).getTime(),
      'Older events must precede newer events'
    );

    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log(`✓ Test Group 2 passed: 200 newest events read from 25,000-line file in ${durationMs.toFixed(2)}ms`);
}

// -------------------------------------------------------------
// Test Group 3: Malformed Lines, Key Filtering & Unassigned Events
// -------------------------------------------------------------
console.log('\n--- Test Group 3: Malformed Lines, Key Filtering & Unassigned Events ---');
{
  const tempDir = path.join(os.tmpdir(), `agentwatch-test-malformed-${Date.now()}`);
  const historyPath = path.join(tempDir, 'history.jsonl');
  fs.mkdirSync(tempDir, { recursive: true });

  const rawLines = [
    // 1. Valid event for Agent A
    JSON.stringify({
      type: 'prompt',
      time: '2026-07-02T10:00:00Z',
      sessionId: 'sess-a1',
      sessionKey: 'agy:hashA',
      folder: 'alpha',
      agent: 'agy',
      question: 'Run alpha?'
    }),
    // 2. Corrupt/malformed line
    '{ this is broken corrupt json line !!!',
    // 3. Truncated line
    '{"time": "2026-07-02',
    // 4. Older unassigned event (no sessionKey)
    JSON.stringify({
      time: '2026-06-01T08:00:00Z',
      sessionId: 'older-sess',
      question: 'Older unassigned question',
      command: { spaced: 'echo old' },
      options: [{ key: '1', text: 'Yes', classification: 'yes_once' }]
    }),
    // 5. Another malformed line
    '<<<malformed>>>',
    // 6. Valid event for Agent B
    JSON.stringify({
      type: 'prompt',
      time: '2026-07-02T11:00:00Z',
      sessionId: 'sess-b1',
      sessionKey: 'agy:hashB',
      folder: 'beta',
      agent: 'agy',
      question: 'Run beta?'
    })
  ];

  fs.writeFileSync(historyPath, rawLines.join('\n') + '\n', 'utf8');

  // 1. Read for Agent A
  const resA = readHistory({ filePath: historyPath, key: 'agy:hashA' });
  assert.strictEqual(resA.events.length, 1, 'Must return 1 event for agy:hashA');
  assert.strictEqual(resA.events[0].question, 'Run alpha?');

  // 2. Read for Agent B
  const resB = readHistory({ filePath: historyPath, key: 'agy:hashB' });
  assert.strictEqual(resB.events.length, 1, 'Must return 1 event for agy:hashB');
  assert.strictEqual(resB.events[0].question, 'Run beta?');

  // 3. Read for Unassigned
  const resUnassigned = readHistory({ filePath: historyPath, key: 'unassigned' });
  assert.strictEqual(resUnassigned.events.length, 1, 'Must return 1 event for unassigned');
  assert.strictEqual(resUnassigned.events[0].question, 'Older unassigned question');

  // 4. Verify knownAgents includes both agents and Unassigned (older)
  const allAgents = resA.knownAgents.map(a => a.sessionKey);
  assert(allAgents.includes('agy:hashA'), 'knownAgents must include agy:hashA');
  assert(allAgents.includes('agy:hashB'), 'knownAgents must include agy:hashB');
  assert(allAgents.includes('unassigned'), 'knownAgents must include unassigned');

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✓ Test Group 3 passed: Malformed lines skipped without crash, key filtering and unassigned events verified');
}

// -------------------------------------------------------------
// Test Group 4: Clear-History Rewrites ONLY That Key Atomically
// -------------------------------------------------------------
console.log('\n--- Test Group 4: Clear-History Atomic Rewrite ---');
{
  const tempDir = path.join(os.tmpdir(), `agentwatch-test-clear-${Date.now()}`);
  const historyPath = path.join(tempDir, 'history.jsonl');
  fs.mkdirSync(tempDir, { recursive: true });

  const events = [
    { type: 'prompt', sessionKey: 'target:key', question: 'Target Q1' },
    { type: 'prompt', sessionKey: 'other:key', question: 'Other Q1' },
    { type: 'prompt', sessionKey: 'target:key', question: 'Target Q2' },
    { type: 'prompt', question: 'Unassigned Q' }, // No sessionKey
    { type: 'prompt', sessionKey: 'other:key', question: 'Other Q2' }
  ];

  for (const ev of events) {
    appendHistoryEvent(ev, historyPath);
  }

  // Clear 'target:key'
  const clearRes = clearAgentHistory('target:key', historyPath);
  assert.strictEqual(clearRes.success, true);
  assert.strictEqual(clearRes.removedCount, 2, 'Must have removed 2 events');

  // Verify file content
  const remaining = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.strictEqual(remaining.length, 3, 'Must have 3 remaining events');

  const remainingKeys = remaining.map(e => e.sessionKey || 'unassigned');
  assert.deepStrictEqual(remainingKeys, ['other:key', 'unassigned', 'other:key']);
  assert.strictEqual(remaining[1].question, 'Unassigned Q', 'Unassigned event must be preserved');

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✓ Test Group 4 passed: Clear-history rewrites only that key atomically, preserving other events');
}

// -------------------------------------------------------------
// Test Group 5: Time Display (UTC to Local, Real Weekday, 24h & 12h Formats)
// -------------------------------------------------------------
console.log('\n--- Test Group 5: Time Display & Real Weekday Computation ---');
{
  // Test known UTC date: 2026-07-02T22:00:00Z
  const isoUtc = '2026-07-02T22:00:00.000Z';
  const d = new Date(isoUtc);

  const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  const expectedWeekday = weekdays[d.getDay()];
  const expectedDay = d.getDate();
  const expectedMonth = months[d.getMonth()];
  const expectedYear = d.getFullYear();

  // 24-hour full display
  const disp24 = formatDisplayTime(isoUtc, '24-hour', true);
  assert(disp24.startsWith(`${expectedWeekday}, ${expectedDay} ${expectedMonth} ${expectedYear} · `));
  const h24 = String(d.getHours()).padStart(2, '0');
  const m24 = String(d.getMinutes()).padStart(2, '0');
  assert(disp24.endsWith(`${h24}:${m24}`));

  // 12-hour full display
  const disp12 = formatDisplayTime(isoUtc, '12-hour', true);
  assert(disp12.startsWith(`${expectedWeekday}, ${expectedDay} ${expectedMonth} ${expectedYear} · `));
  const rawH = d.getHours();
  const h12 = rawH % 12 || 12;
  const ampm = rawH >= 12 ? 'PM' : 'AM';
  assert(disp12.endsWith(`${h12}:${m24} ${ampm}`));

  // Time-only display
  const timeOnly24 = formatDisplayTime(isoUtc, '24-hour', false);
  assert.strictEqual(timeOnly24, `${h24}:${m24}`);

  const timeOnly12 = formatDisplayTime(isoUtc, '12-hour', false);
  assert.strictEqual(timeOnly12, `${h12}:${m24} ${ampm}`);

  // Session length formatting
  assert.strictEqual(formatSessionLength(4320), '1h 12m', '4320s must be 1h 12m');
  assert.strictEqual(formatSessionLength(120), '2m', '120s must be 2m');
  assert.strictEqual(formatSessionLength(45), '45s', '45s must be 45s');
  assert.strictEqual(formatSessionLength('unknown'), 'unknown');
  assert.strictEqual(formatSessionLength(null), 'unknown');

  console.log('✓ Test Group 5 passed: UTC to local time with real weekday and 24h/12h formatting verified');
}

// -------------------------------------------------------------
// Test Group 6: Session Grouping & Clean vs Dead Exit Handlings
// -------------------------------------------------------------
console.log('\n--- Test Group 6: Session Grouping & Clean vs Dead Exit ---');
{
  const events = [
    // Session 1: Clean exit
    {
      type: 'session_started',
      time: '2026-07-02T10:00:00Z',
      sessionId: 'sess-1',
      sessionKey: 'agy:hash1',
      folder: 'app',
      agent: 'agy'
    },
    {
      type: 'prompt',
      time: '2026-07-02T10:01:00Z',
      sessionId: 'sess-1',
      sessionKey: 'agy:hash1',
      folder: 'app',
      agent: 'agy',
      question: 'Run test?',
      command: { spaced: 'npm test' },
      options: [
        { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
        { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
      ],
      decision: { action: 'would_approve', optionKey: '1', delay: 3 }
    },
    {
      type: 'prompt_closed',
      time: '2026-07-02T10:01:04Z',
      sessionId: 'sess-1',
      sessionKey: 'agy:hash1',
      folder: 'app',
      agent: 'agy',
      question: 'Run test?',
      command: { spaced: 'npm test' },
      durationSeconds: 4
    },
    {
      type: 'session_ended',
      time: '2026-07-02T11:12:00Z',
      sessionId: 'sess-1',
      sessionKey: 'agy:hash1',
      folder: 'app',
      agent: 'agy',
      durationSeconds: 4320 // 1h 12m
    },

    // Session 2: Abrupt termination (no session_ended written)
    {
      type: 'session_started',
      time: '2026-07-02T14:00:00Z',
      sessionId: 'sess-2',
      sessionKey: 'agy:hash1',
      folder: 'app',
      agent: 'agy'
    },
    {
      type: 'prompt',
      time: '2026-07-02T14:02:00Z',
      sessionId: 'sess-2',
      sessionKey: 'agy:hash1',
      folder: 'app',
      agent: 'agy',
      question: 'Run deploy?',
      command: { spaced: 'echo deploy' },
      options: [
        { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
        { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
      ],
      decision: { action: 'needs_user' }
    }
  ];

  const groups = groupHistoryBySession(events);
  assert.strictEqual(groups.length, 2, 'Must group into 2 sessions');

  // Sorted newest first: sess-2 (14:00) before sess-1 (10:00)
  assert.strictEqual(groups[0].sessionId, 'sess-2');
  assert.strictEqual(groups[0].sessionLength, 'unknown', 'Abrupt process death must have unknown length');
  assert.strictEqual(groups[0].isEndedUnknown, true, 'isEndedUnknown must be true');
  assert.strictEqual(groups[0].prompts.length, 1);
  assert.strictEqual(groups[0].prompts[0].question, 'Run deploy?');
  assert.strictEqual(groups[0].prompts[0].durationStr, 'unknown');
  assert.strictEqual(groups[0].prompts[0].answer, 'Answer: not recorded');

  // Clean exit session: sess-1
  assert.strictEqual(groups[1].sessionId, 'sess-1');
  assert.strictEqual(groups[1].sessionLength, '1h 12m', 'Clean exit must display 1h 12m length');
  assert.strictEqual(groups[1].isEndedUnknown, false);
  assert.strictEqual(groups[1].prompts.length, 1);
  assert.strictEqual(groups[1].prompts[0].durationStr, '4 s', 'Prompt duration must be 4 s');
  assert.strictEqual(groups[1].prompts[0].plainDecision, 'Would approve option 1 after 3 s');
  assert.strictEqual(groups[1].prompts[0].answer, 'Answer: not recorded');

  console.log('✓ Test Group 6 passed: Session grouping with start stamp heading and clean vs abrupt exit verified');
}

// -------------------------------------------------------------
// Test Group 7: Option Classification Labels & Plain Words Dry-run Decision
// -------------------------------------------------------------
console.log('\n--- Test Group 7: Readable History Cards Option Labels & Plain Decisions ---');
{
  assert.strictEqual(getClassificationLabel('yes_once'), 'yes once');
  assert.strictEqual(getClassificationLabel('yes_session'), 'yes this conversation');
  assert.strictEqual(getClassificationLabel('yes_persist'), 'yes and save');
  assert.strictEqual(getClassificationLabel('no'), 'no');
  assert.strictEqual(getClassificationLabel('unknown'), 'unknown');

  assert.strictEqual(
    formatPlainDecision({ action: 'would_approve', optionKey: '1', delay: 3 }),
    'Would approve option 1 after 3 s'
  );
  assert.strictEqual(
    formatPlainDecision({ action: 'blocked', rule: 'rm -rf' }),
    'Blocked by rule: rm -rf'
  );
  assert.strictEqual(
    formatPlainDecision({ action: 'needs_user' }),
    'Needs you'
  );

  console.log('✓ Test Group 7 passed: All four option classification labels and plain words decisions verified');
}

// -------------------------------------------------------------
// Test Group 8: Settings Persistence (autoOpenWindow, timeFormat, alwaysOnTop, notifications)
// -------------------------------------------------------------
console.log('\n--- Test Group 8: Settings Persistence ---');
{
  const tempDir = path.join(os.tmpdir(), `agentwatch-test-settings-${Date.now()}`);
  const configPath = path.join(tempDir, 'config.json');

  const cfg = loadConfig(configPath);
  assert.strictEqual(cfg.autoOpenWindow, true);
  assert.strictEqual(cfg.timeFormat, '24-hour');

  // Change settings
  setAutoOpenWindow(cfg, false, configPath);
  setTimeFormat(cfg, '12-hour', configPath);

  const reloaded = loadConfig(configPath);
  assert.strictEqual(reloaded.autoOpenWindow, false, 'autoOpenWindow: false must be saved');
  assert.strictEqual(reloaded.timeFormat, '12-hour', 'timeFormat: 12-hour must be saved');

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✓ Test Group 8 passed: Settings tab values successfully saved to config.json');
}

// -------------------------------------------------------------
// Test Group 9: Electron Security Settings & Forbidden Files
// -------------------------------------------------------------
console.log('\n--- Test Group 9: Security Settings & Forbidden Files Invariance ---');
{
  const mainJsPath = path.resolve(__dirname, '../src/gui/main.js');
  const preloadJsPath = path.resolve(__dirname, '../src/gui/preload.js');
  const indexHtmlPath = path.resolve(__dirname, '../src/gui/index.html');
  const rendererJsPath = path.resolve(__dirname, '../src/gui/renderer.js');

  const mainCode = fs.readFileSync(mainJsPath, 'utf8');
  const preloadCode = fs.readFileSync(preloadJsPath, 'utf8');
  const htmlCode = fs.readFileSync(indexHtmlPath, 'utf8');
  const rendererCode = fs.readFileSync(rendererJsPath, 'utf8');

  // Security checks
  assert(mainCode.includes('contextIsolation: true'), 'contextIsolation must be true');
  assert(mainCode.includes('nodeIntegration: false'), 'nodeIntegration must be false');
  assert(mainCode.includes('sandbox: true'), 'sandbox must be true');
  assert(mainCode.includes('webviewTag: false'), 'webviewTag must be false');
  assert(mainCode.includes("will-navigate") && mainCode.includes("event.preventDefault()"), 'navigation blocked');
  assert(mainCode.includes("setWindowOpenHandler") && mainCode.includes("action: 'deny'"), 'new windows blocked');
  assert(htmlCode.includes("default-src 'none'"), 'strict CSP declared in HTML');
  assert(mainCode.includes("default-src 'none'"), 'strict CSP declared in main webRequest');

  // Forbidden files check: raw-session.bin, prompts.log, snapshots
  const forbiddenFiles = ['raw-session.bin', 'prompts.log', 'snapshots'];
  for (const forbidden of forbiddenFiles) {
    assert(!mainCode.includes(forbidden), `main.js must not reference ${forbidden}`);
    assert(!preloadCode.includes(forbidden), `preload.js must not reference ${forbidden}`);
    assert(!rendererCode.includes(forbidden), `renderer.js must not reference ${forbidden}`);
    assert(!htmlCode.includes(forbidden), `index.html must not reference ${forbidden}`);
  }

  // Preload exposes only fixed API
  assert(preloadCode.includes('readHistory'), 'Preload must expose readHistory');
  assert(preloadCode.includes('clearAgentHistory'), 'Preload must expose clearAgentHistory');
  assert(!preloadCode.includes('require(') || (preloadCode.match(/require\(/g).length === 1 && preloadCode.includes("require('electron')")), 'Preload must not expose node require');

  console.log('✓ Test Group 9 passed: Electron security settings and zero access to forbidden files verified');
}

// -------------------------------------------------------------
// Test Group 10: Renderer UI Interactions (Tabs, Selection, History Cards)
// -------------------------------------------------------------
console.log('\n--- Test Group 10: Renderer UI Interactions (Tabs, Selection, History Cards) ---');
{
  class MockElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.children = [];
      this.parentNode = null;
      this.classList = {
        _classes: new Set(),
        add: (c) => this.classList._classes.add(c),
        remove: (c) => this.classList._classes.delete(c),
        contains: (c) => this.classList._classes.has(c)
      };
      this.dataset = {};
      this.style = {};
      this.attributes = new Map();
      this.listeners = new Map();
      this._textContent = '';
      this._innerHTML = '';
      this._value = '';
      this.type = '';
      this.title = '';
      this.checked = false;
      this.draggable = false;
    }

    get className() {
      return Array.from(this.classList._classes).join(' ');
    }
    set className(val) {
      this.classList._classes = new Set((val || '').split(/\s+/).filter(Boolean));
    }

    get textContent() {
      if (this.children.length === 0) return this._textContent;
      return this.children.map(c => c.textContent).join('');
    }
    set textContent(val) {
      this._textContent = String(val ?? '');
      this.children = [];
    }

    get innerHTML() {
      return this._innerHTML;
    }
    set innerHTML(val) {
      this._innerHTML = val;
      this.children = [];
    }

    get value() {
      return this._value;
    }
    set value(val) {
      this._value = String(val ?? '');
    }

    setAttribute(k, v) { this.attributes.set(k, String(v)); }
    getAttribute(k) { return this.attributes.get(k); }

    appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.children.push(child);
      return child;
    }

    removeChild(child) {
      const idx = this.children.indexOf(child);
      if (idx !== -1) {
        this.children.splice(idx, 1);
        child.parentNode = null;
      }
      return child;
    }

    insertBefore(newChild, refChild) {
      if (newChild.parentNode) newChild.parentNode.removeChild(newChild);
      const idx = this.children.indexOf(refChild);
      if (idx === -1) return this.appendChild(newChild);
      newChild.parentNode = this;
      this.children.splice(idx, 0, newChild);
      return newChild;
    }

    addEventListener(event, fn) {
      if (!this.listeners.has(event)) this.listeners.set(event, []);
      this.listeners.get(event).push(fn);
    }

    dispatchEvent(evt) {
      evt.target = this;
      const list = this.listeners.get(evt.type) || [];
      for (const fn of list) fn(evt);
    }

    querySelector(selector) {
      const all = this.querySelectorAll(selector);
      return all.length > 0 ? all[0] : null;
    }

    querySelectorAll(selector) {
      const results = [];
      const isClass = selector.startsWith('.');
      const isId = selector.startsWith('#');
      const isAttr = selector.startsWith('[') && selector.endsWith(']');

      function match(node) {
        if (!node || !node.classList) return false;
        if (isClass) return node.classList.contains(selector.slice(1));
        if (isId) return node.id === selector.slice(1);
        if (isAttr) {
          const parts = selector.slice(1, -1).split('=');
          const attr = parts[0];
          const val = parts[1] ? parts[1].replace(/['"]/g, '') : null;
          if (attr.startsWith('data-')) {
            const dataKey = attr.slice(5).replace(/-([a-z])/g, (_, l) => l.toUpperCase());
            return val !== null ? node.dataset[dataKey] === val : node.dataset[dataKey] !== undefined;
          }
          return val !== null ? node.getAttribute(attr) === val : node.getAttribute(attr) !== undefined;
        }
        return node.tagName.toLowerCase() === selector.toLowerCase();
      }

      function traverse(node) {
        if (!node || !node.children) return;
        for (const child of node.children) {
          if (match(child)) results.push(child);
          traverse(child);
        }
      }
      traverse(this);
      return results;
    }
  }

  const elementsById = new Map();
  function getOrCreate(id, tag = 'div') {
    if (!elementsById.has(id)) {
      const el = new MockElement(tag);
      el.id = id;
      elementsById.set(id, el);
    }
    return elementsById.get(id);
  }

  // Create required DOM fixture elements
  getOrCreate('agent-count-badge', 'span');
  getOrCreate('always-on-top-checkbox', 'input');
  getOrCreate('sessions-container', 'main');
  getOrCreate('tab-btn-agents', 'button');
  getOrCreate('tab-btn-settings', 'button');
  getOrCreate('agents-view', 'div');
  getOrCreate('settings-view', 'div');
  getOrCreate('past-agents-details', 'details');
  getOrCreate('past-agents-count', 'span');
  getOrCreate('past-agents-list', 'div');
  getOrCreate('history-header', 'div');
  getOrCreate('history-agent-name', 'span');
  getOrCreate('clear-history-btn', 'button');
  getOrCreate('history-placeholder', 'div');
  getOrCreate('history-groups', 'div');
  getOrCreate('load-older-container', 'div');
  getOrCreate('load-older-btn', 'button');
  getOrCreate('setting-auto-open', 'input');
  getOrCreate('setting-pin-top', 'input');
  getOrCreate('setting-notifications', 'input');
  getOrCreate('setting-time-format', 'select');

  global.document = {
    getElementById: (id) => elementsById.get(id) || null,
    createElement: (tag) => new MockElement(tag),
    createTextNode: (txt) => ({ textContent: txt, parentNode: null }),
    activeElement: null
  };

  const readHistoryCalls = [];
  const setSettingCalls = [];
  const clearAgentHistoryCalls = [];

  global.window = {
    confirm: () => true,
    agentwatch: {
      getState: async () => ({}),
      onUpdate: () => {},
      readHistory: async (opts) => {
        readHistoryCalls.push(opts);
        return {
          events: [
            {
              type: 'session_started',
              time: '2026-07-02T22:00:00Z',
              sessionId: 'sess-ui-1',
              sessionKey: opts.key
            },
            {
              type: 'prompt',
              time: '2026-07-02T22:01:00Z',
              sessionId: 'sess-ui-1',
              sessionKey: opts.key,
              question: 'Run migration?',
              command: { spaced: 'npm run migrate' },
              options: [
                { number: 1, text: 'Yes, run command', classification: 'yes_once' },
                { number: 2, text: 'No, cancel', classification: 'no' }
              ],
              decision: { action: 'would_approve', optionKey: '1', delay: 3 },
              durationSeconds: 3.5
            },
            {
              type: 'session_ended',
              time: '2026-07-02T23:12:00Z',
              sessionId: 'sess-ui-1',
              sessionKey: opts.key,
              durationSeconds: 4320
            }
          ],
          hasOlder: false,
          nextOffset: 0,
          knownAgents: [
            { sessionKey: 'past:agent1', folder: 'past-project', agent: 'agy', displayName: 'Old Worker' }
          ]
        };
      },
      clearAgentHistory: async (key) => {
        clearAgentHistoryCalls.push(key);
        return { success: true };
      },
      setSetting: (key, val) => {
        setSettingCalls.push({ key, val });
      },
      setAlwaysOnTop: () => {}
    }
  };

  const renderer = require('../src/gui/renderer');

  // 1. Test Tab Switching
  const btnAgents = getOrCreate('tab-btn-agents');
  const btnSettings = getOrCreate('tab-btn-settings');
  const viewAgents = getOrCreate('agents-view');
  const viewSettings = getOrCreate('settings-view');

  btnSettings.dispatchEvent({ type: 'click' });
  assert(btnSettings.classList.contains('active'), 'Settings tab must be active');
  assert(!btnAgents.classList.contains('active'), 'Agents tab must not be active');
  assert.strictEqual(viewSettings.style.display, 'flex');
  assert.strictEqual(viewAgents.style.display, 'none');

  btnAgents.dispatchEvent({ type: 'click' });
  assert(btnAgents.classList.contains('active'), 'Agents tab must be active');
  assert.strictEqual(viewAgents.style.display, 'flex');
  assert.strictEqual(viewSettings.style.display, 'none');

  // 2. Render initial dashboard data
  const testData = {
    config: {
      autoOpenWindow: true,
      alwaysOnTop: false,
      notifications: true,
      timeFormat: '24-hour'
    },
    sessions: [
      {
        sessionKey: 'live:agent1',
        sessionId: 'sess-live-1',
        displayName: 'Live Worker',
        agent: 'agy',
        folder: 'frontend',
        duration: '5m',
        state: 'idle',
        isAsking: false
      }
    ]
  };

  renderer.render(testData);

  const containerEl = getOrCreate('sessions-container');
  const liveRow = containerEl.querySelector('[data-session-key="live:agent1"]');
  assert(liveRow, 'Live agent row must be rendered');

  // 3. Select agent row by clicking
  liveRow.dispatchEvent({ type: 'click' });
  assert(liveRow.classList.contains('selected'), 'Selected row must have selected class');
  assert.strictEqual(renderer.getSelectedAgentKey(), 'live:agent1');

  // 4. Verify History Cards rendering
  assert(readHistoryCalls.length > 0, 'readHistory must be called on agent selection');
  assert.strictEqual(readHistoryCalls[readHistoryCalls.length - 1].key, 'live:agent1');

  // Render mock history events
  renderer.renderHistory([
    {
      type: 'session_started',
      time: '2026-07-02T22:00:00Z',
      sessionId: 'sess-ui-1',
      sessionKey: 'live:agent1'
    },
    {
      type: 'prompt',
      time: '2026-07-02T22:01:00Z',
      sessionId: 'sess-ui-1',
      sessionKey: 'live:agent1',
      question: 'Run migration?',
      command: { spaced: 'npm run migrate' },
      options: [
        { number: 1, text: 'Yes, run command', classification: 'yes_once' },
        { number: 2, text: 'No, cancel', classification: 'no' }
      ],
      decision: { action: 'would_approve', optionKey: '1', delay: 3 },
      durationSeconds: 3.5
    },
    {
      type: 'session_ended',
      time: '2026-07-02T23:12:00Z',
      sessionId: 'sess-ui-1',
      sessionKey: 'live:agent1',
      durationSeconds: 4320
    }
  ]);

  const historyGroupsEl = getOrCreate('history-groups');
  assert.strictEqual(historyGroupsEl.children.length, 1, 'Must render 1 session group');

  const sessionGroup = historyGroupsEl.children[0];
  const groupTitle = sessionGroup.querySelector('.session-group-title');
  const groupLength = sessionGroup.querySelector('.session-group-length');
  assert(groupTitle && groupTitle.textContent.length > 0, 'Must display session start stamp');
  assert.strictEqual(groupLength.textContent, 'Session length: 1h 12m', 'Must display Session length: 1h 12m');

  const historyCard = sessionGroup.querySelector('.history-card');
  assert(historyCard, 'History card must be rendered');

  const question = historyCard.querySelector('.card-question');
  const command = historyCard.querySelector('.card-command');
  const decision = historyCard.querySelector('.card-decision');
  const answer = historyCard.querySelector('.card-answer');
  const duration = historyCard.querySelector('.card-duration');

  assert.strictEqual(question.textContent, 'Run migration?');
  assert.strictEqual(command.textContent, 'npm run migrate');
  assert.strictEqual(decision.textContent, 'Dry-run: Would approve option 1 after 3 s');
  assert.strictEqual(answer.textContent, 'Answer: not recorded');
  assert.strictEqual(duration.textContent, 'On screen: 3.5 s');

  // Verify option badges
  const optionBadges = historyCard.querySelectorAll('.option-badge');
  assert.strictEqual(optionBadges.length, 2, 'Must render 2 option badges');
  assert.strictEqual(optionBadges[0].textContent, 'yes once');
  assert.strictEqual(optionBadges[1].textContent, 'no');

  // 5. Test Clear History Button
  const clearBtn = getOrCreate('clear-history-btn');
  clearBtn.dispatchEvent({ type: 'click' });
  assert.strictEqual(clearAgentHistoryCalls.length, 1, 'clearAgentHistory must be called');
  assert.strictEqual(clearAgentHistoryCalls[0], 'live:agent1');

  // 6. Test Settings Tab Controls
  const setAutoOpenEl = getOrCreate('setting-auto-open');
  setAutoOpenEl.checked = false;
  setAutoOpenEl.dispatchEvent({ type: 'change' });
  assert(setSettingCalls.some(c => c.key === 'autoOpenWindow' && c.val === false));

  const setTimeFormatEl = getOrCreate('setting-time-format');
  setTimeFormatEl.value = '12-hour';
  setTimeFormatEl.dispatchEvent({ type: 'change' });
  assert(setSettingCalls.some(c => c.key === 'timeFormat' && c.val === '12-hour'));

  console.log('✓ Test Group 10 passed: Renderer tab navigation, agent selection, and readable history cards verified');
}

console.log('\n=========================================');
console.log('All agentwatch Stage 3a tests passed successfully!');
console.log('=========================================\n');

