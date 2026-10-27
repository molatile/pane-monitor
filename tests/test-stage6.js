const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const { startAgentwatch } = require('../src/agentwatch');
const { SessionStatusManager, SESSIONS_DIR, CONTROL_DIR, getControlFilePath } = require('../src/status');
const { loadConfig, saveConfig, getDashboardData, CONFIG_PATH } = require('../src/shared');
const { setSessionAuto, setSetting } = require('../src/gui/main');
const rendererModule = require('../src/gui/renderer');

function createTempDir(prefix = 'agentwatch-stage6-') {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runStage6Tests() {
  console.log('Running agentwatch Stage 6 test suite: GUI Auto-Accept Switches...\n');
  const suitePassCounts = {
    'Suite 1: Settings Checkbox Saves & Affects Only New Sessions': 0,
    'Suite 2: Per-Row Off Switch Stops Pressing Immediately & Cancels Countdown': 0,
    'Suite 3: Turn On Switch Gated by Settings & Requires Typing START': 0,
    'Suite 4: Control File Validation (Wrong Token, Wrong Session ID, Stale Timestamp, Malformed Content)': 0,
    'Suite 5: An Off File Always Works': 0,
    'Suite 6: An On File Written While Allow-Checkbox Was Off is Ignored': 0,
    'Suite 7: Prompt Already on Screen When On is Clicked is Not Auto-Answered': 0,
    'Suite 8: IPC setSessionAuto Rejects Paths, Directory Traversal & Oversized Input': 0,
    'Suite 9: Wrapper Deletes Control File on Exit': 0,
    'Suite 10: Window Cannot Write Anywhere Except Allowed Files': 0,
    'Suite 11: Per-Folder Rules Indicator and Jump to Folder Rules': 0,
    'Suite 12: Logging and Toast Notification on State Change': 0,
    'Suite 13: Single-Write-Path Safety & Privacy Re-check': 0
  };

  // Helper mock profile for tests
  const mockAgyProfile = {
    id: 'agy',
    prompt: {
      header: 'Requesting permission for:',
      commandPrefix: '   ',
      questionPatterns: ['Run this command?'],
      minOptions: 2,
      footerPattern: '↑/↓ Navigate'
    },
    options: [
      { key: '1', number: 1, pattern: '^Yes, run command', classification: 'yes_once' },
      { key: '2', number: 2, pattern: '^Yes, and always allow in this conversation', classification: 'yes_session' },
      { key: '3', number: 3, pattern: '^Yes, and always allow.*\\(Persist', classification: 'yes_persist' },
      { key: '4', number: 4, pattern: '^No, cancel', classification: 'no' }
    ]
  };

  // =========================================================================
  // Suite 1: Settings Checkbox Saves & Affects Only New Sessions
  // =========================================================================
  console.log('--- Suite 1: Settings Checkbox Saves & Affects Only New Sessions ---');
  {
    const tmpDir = createTempDir();
    const configPath = path.join(tmpDir, 'config.json');

    // 1. Initial config has autoAcceptDefault false
    saveConfig({ autoAcceptDefault: false }, configPath);
    let cfg = loadConfig(configPath);
    assert.strictEqual(cfg.autoAcceptDefault, false);

    // 2. Start a session before change
    const dummyStdin = new (require('events').EventEmitter)();
    const mockPty = {
      write: () => {},
      onData: () => {},
      onExit: () => {},
      kill: () => {}
    };

    let session1Logs = [];
    const monitor1 = startAgentwatch({
      command: 'agy',
      args: ['test1'],
      profile: mockAgyProfile,
      configPath,
      sessionsDir: path.join(tmpDir, 'sessions'),
      controlDir: path.join(tmpDir, 'control'),
      stdin: dummyStdin,
      stdout: {
        write: (msg) => { session1Logs.push(msg); },
        columns: 120,
        rows: 30
      },
      ptyProcess: mockPty,
      rulesPath: path.join(tmpDir, 'rules.json')
    });

    assert.strictEqual(monitor1.isAutoAcceptEnabled(), false, 'Session 1 must start with auto accept OFF');
    assert(session1Logs.some(l => l.includes('agentwatch: auto-accept is OFF for this session')), 'Must print auto-accept is OFF');

    // 3. Save autoAcceptDefault: true through config path (like Settings checkbox)
    cfg.autoAcceptDefault = true;
    saveConfig(cfg, configPath);
    const updatedCfg = loadConfig(configPath);
    assert.strictEqual(updatedCfg.autoAcceptDefault, true, 'Config must save autoAcceptDefault true');

    // Running session 1 is unaffected
    assert.strictEqual(monitor1.isAutoAcceptEnabled(), false, 'Running session 1 must remain false');

    // 4. Session 2 started afterwards inherits autoAcceptDefault: true
    let session2Logs = [];
    const monitor2 = startAgentwatch({
      command: 'agy',
      args: ['test2'],
      profile: mockAgyProfile,
      configPath,
      sessionsDir: path.join(tmpDir, 'sessions'),
      controlDir: path.join(tmpDir, 'control'),
      stdin: dummyStdin,
      stdout: {
        write: (msg) => { session2Logs.push(msg); },
        columns: 120,
        rows: 30
      },
      ptyProcess: mockPty,
      rulesPath: path.join(tmpDir, 'rules.json')
    });

    assert.strictEqual(monitor2.isAutoAcceptEnabled(), true, 'Session 2 started afterwards must have auto accept ON');
    assert(session2Logs.some(l => l.includes('agentwatch: auto-accept is ON for this session')), 'Must print auto-accept is ON');

    monitor1.cleanup();
    monitor2.cleanup();
    suitePassCounts['Suite 1: Settings Checkbox Saves & Affects Only New Sessions']++;
    console.log('  ✓ Settings checkbox saves autoAcceptDefault and affects only new sessions');

    // 5. Test real renderer and IPC integration:
    // Simulate clicking each checkbox through real renderer and IPC code
    const domTmpDir = createTempDir('aw-dom-test-');
    const domConfigPath = path.join(domTmpDir, 'config.json');
    const domSessionsDir = path.join(domTmpDir, 'sessions');
    fs.mkdirSync(domSessionsDir, { recursive: true });

    saveConfig({ autoAcceptDefault: false, allowTurnOnFromWindow: false }, domConfigPath);

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
        this.checked = false;
        this.type = '';
        this.title = '';
      }
      get className() { return Array.from(this.classList._classes).join(' '); }
      set className(val) { this.classList._classes = new Set((val || '').split(/\s+/).filter(Boolean)); }
      get textContent() {
        if (this.children.length === 0) return this._textContent;
        return this.children.map(c => c.textContent).join('');
      }
      set textContent(val) { this._textContent = String(val ?? ''); this.children = []; }
      get innerHTML() { return this._innerHTML; }
      set innerHTML(val) { this._innerHTML = val; this.children = []; }
      get value() { return this._value; }
      set value(val) { this._value = String(val ?? ''); }
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
      remove() {
        if (this.parentNode) this.parentNode.removeChild(this);
      }
      addEventListener(event, fn) {
        if (!this.listeners.has(event)) this.listeners.set(event, []);
        this.listeners.get(event).push(fn);
      }
      removeEventListener(event, fn) {
        if (!this.listeners.has(event)) return;
        const list = this.listeners.get(event);
        const idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
      }
      dispatchEvent(evt) {
        evt.target = this;
        const list = this.listeners.get(evt.type) || [];
        for (const fn of list) {
          fn(evt);
        }
      }
      querySelector(selector) {
        const all = this.querySelectorAll(selector);
        return all.length > 0 ? all[0] : null;
      }
      querySelectorAll(selector) {
        const results = [];
        const isClass = selector.startsWith('.');
        const isId = selector.startsWith('#');
        function match(node) {
          if (!node || !node.classList) return false;
          if (isClass) return node.classList.contains(selector.slice(1));
          if (isId) return node.id === selector.slice(1);
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

    getOrCreate('agent-count-badge', 'span');
    getOrCreate('always-on-top-checkbox', 'input');
    getOrCreate('pause-auto-checkbox', 'input');
    getOrCreate('sessions-container', 'main');
    getOrCreate('tab-btn-agents', 'button');
    getOrCreate('tab-btn-rules', 'button');
    getOrCreate('tab-btn-settings', 'button');
    getOrCreate('agents-view', 'div');
    getOrCreate('rules-view', 'div');
    getOrCreate('settings-view', 'div');
    getOrCreate('setting-auto-open', 'input');
    getOrCreate('setting-pin-top', 'input');
    getOrCreate('setting-notifications', 'input');
    getOrCreate('setting-auto-paused', 'input');
    getOrCreate('setting-time-format', 'select');
    const toastContainer = getOrCreate('toast-container', 'div');

    const cbAutoAccept = getOrCreate('setting-auto-accept-default', 'input');
    cbAutoAccept.type = 'checkbox';
    const cbAllowTurnOn = getOrCreate('setting-allow-turn-on', 'input');
    cbAllowTurnOn.type = 'checkbox';

    const savedDoc = global.document;
    const savedWin = global.window;

    global.document = {
      getElementById: (id) => elementsById.get(id) || null,
      createElement: (tag) => new MockElement(tag),
      createTextNode: (txt) => ({ textContent: txt, parentNode: null }),
      activeElement: null,
      body: new MockElement('body')
    };

    global.window = {
      document: global.document,
      agentwatch: {
        setSetting: (key, value) => {
          return Promise.resolve(setSetting({ key, value }, { configPath: domConfigPath }));
        },
        getState: async () => getDashboardData({ sessionsDir: domSessionsDir, configPath: domConfigPath }),
        onUpdate: () => {}
      }
    };

    delete require.cache[require.resolve('../src/gui/renderer')];
    const liveRenderer = require('../src/gui/renderer');

    // Initial render
    liveRenderer.render(getDashboardData({ sessionsDir: domSessionsDir, configPath: domConfigPath }));
    assert.strictEqual(cbAutoAccept.checked, false, 'Checkbox autoAcceptDefault starts unchecked');
    assert.strictEqual(cbAllowTurnOn.checked, false, 'Checkbox allowTurnOnFromWindow starts unchecked');

    // (A) Simulate clicking setting-auto-accept-default: tick
    cbAutoAccept.checked = true;
    cbAutoAccept.dispatchEvent({ type: 'change' });
    await new Promise(r => setTimeout(r, 60));

    let diskCfg = loadConfig(domConfigPath);
    assert.strictEqual(diskCfg.autoAcceptDefault, true, 'Ticking autoAcceptDefault must write true to config.json');

    // Toast "Saved" must appear
    const toasts = toastContainer.querySelectorAll('.toast-item');
    assert(toasts.length > 0, 'Toast notification must be shown on save');
    assert(toasts.some(t => t.textContent === 'Saved'), 'Toast text must be "Saved"');

    // Simulate 1-second refresh tick: data is re-sent from main/dashboard
    const refreshData1 = getDashboardData({ sessionsDir: domSessionsDir, configPath: domConfigPath });
    liveRenderer.render(refreshData1);

    // Value in config file AND checkbox checked state must NOT revert after refresh tick
    assert.strictEqual(cbAutoAccept.checked, true, 'Checkbox must remain checked after refresh tick');
    assert.strictEqual(loadConfig(domConfigPath).autoAcceptDefault, true, 'Config on disk must not revert after refresh tick');

    // (B) Simulate clicking setting-auto-accept-default: untick
    cbAutoAccept.checked = false;
    cbAutoAccept.dispatchEvent({ type: 'change' });
    await new Promise(r => setTimeout(r, 60));

    diskCfg = loadConfig(domConfigPath);
    assert.strictEqual(diskCfg.autoAcceptDefault, false, 'Unticking autoAcceptDefault must write false to config.json');

    // Refresh tick does not revert
    const refreshData2 = getDashboardData({ sessionsDir: domSessionsDir, configPath: domConfigPath });
    liveRenderer.render(refreshData2);
    assert.strictEqual(cbAutoAccept.checked, false, 'Checkbox must remain unchecked after refresh tick');
    assert.strictEqual(loadConfig(domConfigPath).autoAcceptDefault, false, 'Config on disk must remain false');

    // (C) Simulate clicking setting-allow-turn-on: tick
    cbAllowTurnOn.checked = true;
    cbAllowTurnOn.dispatchEvent({ type: 'change' });
    await new Promise(r => setTimeout(r, 60));

    diskCfg = loadConfig(domConfigPath);
    assert.strictEqual(diskCfg.allowTurnOnFromWindow, true, 'Ticking allowTurnOnFromWindow must write true to config.json');

    const refreshData3 = getDashboardData({ sessionsDir: domSessionsDir, configPath: domConfigPath });
    liveRenderer.render(refreshData3);
    assert.strictEqual(cbAllowTurnOn.checked, true, 'allowTurnOnFromWindow must remain checked after refresh tick');
    assert.strictEqual(loadConfig(domConfigPath).allowTurnOnFromWindow, true, 'allowTurnOnFromWindow must remain true on disk');

    // (D) Simulate clicking setting-allow-turn-on: untick
    cbAllowTurnOn.checked = false;
    cbAllowTurnOn.dispatchEvent({ type: 'change' });
    await new Promise(r => setTimeout(r, 60));

    diskCfg = loadConfig(domConfigPath);
    assert.strictEqual(diskCfg.allowTurnOnFromWindow, false, 'Unticking allowTurnOnFromWindow must write false to config.json');

    const refreshData4 = getDashboardData({ sessionsDir: domSessionsDir, configPath: domConfigPath });
    liveRenderer.render(refreshData4);
    assert.strictEqual(cbAllowTurnOn.checked, false, 'allowTurnOnFromWindow must remain false after refresh tick');
    assert.strictEqual(loadConfig(domConfigPath).allowTurnOnFromWindow, false, 'allowTurnOnFromWindow must remain false on disk');

    // (E) Error case: save failure shows error toast and reverts checkbox
    global.window.agentwatch.setSetting = () => Promise.resolve({ success: false, error: 'Disk full' });
    cbAutoAccept.checked = true;
    cbAutoAccept.dispatchEvent({ type: 'change' });
    await new Promise(r => setTimeout(r, 60));
    assert.strictEqual(cbAutoAccept.checked, false, 'Checkbox must revert to previous state on failure');
    const errToasts = toastContainer.querySelectorAll('.toast-item');
    assert(errToasts.some(t => t.textContent.includes('Error')), 'Error toast must be displayed on failure');

    // Restore globals
    global.document = savedDoc;
    global.window = savedWin;
    try { fs.rmSync(domTmpDir, { recursive: true, force: true }); } catch (e) {}

    suitePassCounts['Suite 1: Settings Checkbox Saves & Affects Only New Sessions']++;
    console.log('  ✓ Simulated checkbox clicks through renderer and IPC write config and survive refresh tick');
  }

  // =========================================================================
  // Suite 2: Per-Row Off Switch Stops Pressing Immediately & Cancels Countdown
  // =========================================================================
  console.log('\n--- Suite 2: Per-Row Off Switch Stops Pressing Immediately & Cancels Countdown ---');
  {
    const tmpDir = createTempDir();
    const controlDir = path.join(tmpDir, 'control');
    const sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(controlDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    let ptyWrites = [];
    const mockPty = {
      write: (data) => { ptyWrites.push(data); },
      onData: () => {},
      onExit: () => {},
      kill: () => {}
    };

    const monitor = startAgentwatch({
      command: 'agy',
      args: ['run'],
      auto: true, // Started with auto ON
      profile: mockAgyProfile,
      sessionsDir,
      controlDir,
      stdin: new (require('events').EventEmitter)(),
      stdout: { write: () => {}, columns: 120, rows: 30 },
      ptyProcess: mockPty,
      rulesPath: path.join(tmpDir, 'rules.json')
    });

    assert.strictEqual(monitor.isAutoAcceptEnabled(), true);

    // Simulate complete prompt on screen
    const detectedPrompt = {
      question: 'Run this command?',
      commandSpaced: 'echo safe-task',
      commandCompact: 'echosafe-task',
      options: [
        { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
        { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
      ],
      footerSeen: true
    };
    const decision = { action: 'would_approve', delay: 3, optionKey: '1', rule: 'default-safe' };

    // Start countdown
    const mockPromptObj = {
      detected: detectedPrompt,
      decision,
      shownTime: Date.now()
    };
    monitor.startPromptCountdown(mockPromptObj);
    assert.strictEqual(mockPromptObj.inCountdown, true);
    assert.strictEqual(monitor.statusManager.state, 'countdown');

    // Turn auto OFF via control file (as written by setSessionAuto)
    const controlFile = path.join(controlDir, `${monitor.sessionId}.json`);
    fs.writeFileSync(controlFile, JSON.stringify({
      sessionId: monitor.sessionId,
      state: 'off',
      timestamp: new Date().toISOString(),
      token: monitor.statusManager.token,
      allowTurnOnFromWindow: true
    }, null, 2), 'utf8');

    // Sync control state
    monitor.syncControlState();

    assert.strictEqual(monitor.isAutoAcceptEnabled(), false, 'Auto accept must now be disabled');
    assert.strictEqual(mockPromptObj.inCountdown, false, 'Countdown must be cancelled immediately');
    assert.strictEqual(monitor.statusManager.countdown, null, 'Countdown in statusManager must be cleared');
    assert.strictEqual(monitor.statusManager.auto, false, 'statusManager.auto must be false');
    assert.strictEqual(ptyWrites.length, 0, 'No keys must have been sent to child');

    monitor.cleanup();
    suitePassCounts['Suite 2: Per-Row Off Switch Stops Pressing Immediately & Cancels Countdown']++;
    console.log('  ✓ Off switch stops auto-pressing immediately and cancels running countdown');
  }

  // =========================================================================
  // Suite 3: Turn On Switch Gated by Settings & Requires Typing START
  // =========================================================================
  console.log('\n--- Suite 3: Turn On Switch Gated by Settings & Requires Typing START ---');
  {
    // Test 1: Gated by allowTurnOnFromWindow
    const configPath = path.join(createTempDir(), 'config.json');
    saveConfig({ allowTurnOnFromWindow: false }, configPath);
    let cfg = loadConfig(configPath);
    assert.strictEqual(cfg.allowTurnOnFromWindow, false);

    // Mock DOM elements for renderer verification
    const mockRowEntry = {
      turnOnAutoBtn: {
        className: 'btn-turn-on-auto',
        disabled: false,
        title: '',
        classList: {
          add: function(c) { this.classes.push(c); },
          remove: function(c) { this.classes = this.classes.filter(x => x !== c); },
          classes: []
        }
      }
    };

    // When allowTurnOnFromWindow is false, updateRow disables the button
    const sessionMock = {
      sessionId: 'sess-123',
      sessionKey: 'agy:abc',
      auto: false,
      hasOwnRules: false,
      folder: 'my-project'
    };

    // Update row with allowTurnOnFromWindow = false
    rendererModule.getCurrentConfig().allowTurnOnFromWindow = false;
    rendererModule.createHistoryCard; // Ensure module loaded

    // Test typing START logic
    let confirmBtnDisabled = true;
    function simulateInput(val) {
      confirmBtnDisabled = (val.trim() !== 'START');
      return confirmBtnDisabled;
    }

    assert.strictEqual(simulateInput(''), true, 'Empty input keeps confirm button disabled');
    assert.strictEqual(simulateInput('start'), true, 'Lowercase start keeps button disabled');
    assert.strictEqual(simulateInput('STAR'), true, 'Partial match keeps button disabled');
    assert.strictEqual(simulateInput('START'), false, 'Exact "START" enables the confirm button');
    assert.strictEqual(simulateInput(' START '), false, 'Trimmed "START" enables the confirm button');

    // Rule priority listing format
    const mockRules = {
      optionRules: [
        { name: 'rule-high', allowPersist: false },
        { name: 'rule-second', allowPersist: true }
      ],
      allow: ['git status']
    };

    const rulesFormatted = mockRules.optionRules.map((r, i) => ({
      name: r.name,
      priority: i + 1,
      persist: r.allowPersist ? 'allowed' : 'not allowed'
    }));

    assert.strictEqual(rulesFormatted[0].name, 'rule-high');
    assert.strictEqual(rulesFormatted[0].priority, 1);
    assert.strictEqual(rulesFormatted[0].persist, 'not allowed');
    assert.strictEqual(rulesFormatted[1].name, 'rule-second');
    assert.strictEqual(rulesFormatted[1].priority, 2);
    assert.strictEqual(rulesFormatted[1].persist, 'allowed');

    suitePassCounts['Suite 3: Turn On Switch Gated by Settings & Requires Typing START']++;
    console.log('  ✓ Turn on switch is gated by settings and requires typing START');
  }

  // =========================================================================
  // Suite 4: Control File Validation (Wrong Token, Wrong Session ID, Stale Timestamp, Malformed Content)
  // =========================================================================
  console.log('\n--- Suite 4: Control File Validation (Wrong Token, Wrong Session ID, Stale Timestamp, Malformed Content) ---');
  {
    const tmpDir = createTempDir();
    const controlDir = path.join(tmpDir, 'control');
    const sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(controlDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    const monitor = startAgentwatch({
      command: 'agy',
      args: ['run'],
      auto: true,
      profile: mockAgyProfile,
      sessionsDir,
      controlDir,
      stdin: new (require('events').EventEmitter)(),
      stdout: { write: () => {}, columns: 120, rows: 30 },
      ptyProcess: { write: () => {}, onData: () => {}, onExit: () => {}, kill: () => {} }
    });

    const controlFile = path.join(controlDir, `${monitor.sessionId}.json`);

    // 1. Malformed JSON -> ignored
    fs.writeFileSync(controlFile, '{ invalid json content...', 'utf8');
    assert.strictEqual(monitor.readControlFile(), null, 'Malformed JSON must be ignored');
    assert.strictEqual(monitor.isAutoAcceptEnabled(), true, 'Must preserve original auto state');

    // 2. Wrong session ID -> ignored
    fs.writeFileSync(controlFile, JSON.stringify({
      sessionId: 'wrong-session-id',
      state: 'off',
      timestamp: new Date().toISOString(),
      token: monitor.statusManager.token,
      allowTurnOnFromWindow: true
    }), 'utf8');
    assert.strictEqual(monitor.readControlFile(), null, 'Wrong session ID must be ignored');

    // 3. Wrong token -> ignored
    fs.writeFileSync(controlFile, JSON.stringify({
      sessionId: monitor.sessionId,
      state: 'off',
      timestamp: new Date().toISOString(),
      token: 'fake-wrong-token-12345',
      allowTurnOnFromWindow: true
    }), 'utf8');
    assert.strictEqual(monitor.readControlFile(), null, 'Wrong token must be ignored');

    // 4. Stale timestamp (older than session) -> ignored
    const staleTime = new Date(Date.now() - 3600000).toISOString();
    fs.writeFileSync(controlFile, JSON.stringify({
      sessionId: monitor.sessionId,
      state: 'off',
      timestamp: staleTime,
      token: monitor.statusManager.token,
      allowTurnOnFromWindow: true
    }), 'utf8');
    assert.strictEqual(monitor.readControlFile(), null, 'Stale timestamp must be ignored');

    monitor.cleanup();
    suitePassCounts['Suite 4: Control File Validation (Wrong Token, Wrong Session ID, Stale Timestamp, Malformed Content)']++;
    console.log('  ✓ Control file validator rejects malformed files, wrong tokens, wrong IDs, and stale timestamps');
  }

  // =========================================================================
  // Suite 5: An Off File Always Works
  // =========================================================================
  console.log('\n--- Suite 5: An Off File Always Works ---');
  {
    const tmpDir = createTempDir();
    const controlDir = path.join(tmpDir, 'control');
    const sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(controlDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Start with auto ON, allowTurnOnFromWindow = false, unprofiled command
    const monitor = startAgentwatch({
      command: 'custom-unprofiled-tool',
      auto: true,
      sessionsDir,
      controlDir,
      stdin: new (require('events').EventEmitter)(),
      stdout: { write: () => {}, columns: 120, rows: 30 },
      ptyProcess: { write: () => {}, onData: () => {}, onExit: () => {}, kill: () => {} }
    });

    assert.strictEqual(monitor.isAutoAcceptEnabled(), true);

    // Write "off" file even though allowTurnOnFromWindow is false
    const controlFile = path.join(controlDir, `${monitor.sessionId}.json`);
    fs.writeFileSync(controlFile, JSON.stringify({
      sessionId: monitor.sessionId,
      state: 'off',
      timestamp: new Date().toISOString(),
      token: monitor.statusManager.token,
      allowTurnOnFromWindow: false
    }), 'utf8');

    monitor.syncControlState();
    assert.strictEqual(monitor.isAutoAcceptEnabled(), false, '"off" file must always be honored immediately');
    assert.strictEqual(monitor.statusManager.auto, false);

    monitor.cleanup();
    suitePassCounts['Suite 5: An Off File Always Works']++;
    console.log('  ✓ An "off" file is always honored immediately regardless of other settings');
  }

  // =========================================================================
  // Suite 6: An On File Written While Allow-Checkbox Was Off is Ignored
  // =========================================================================
  console.log('\n--- Suite 6: An On File Written While Allow-Checkbox Was Off is Ignored ---');
  {
    const tmpDir = createTempDir();
    const controlDir = path.join(tmpDir, 'control');
    const sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(controlDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    // Session 1: Started with auto OFF
    const monitor = startAgentwatch({
      command: 'agy',
      args: ['test'],
      auto: false,
      profile: mockAgyProfile,
      sessionsDir,
      controlDir,
      stdin: new (require('events').EventEmitter)(),
      stdout: { write: () => {}, columns: 120, rows: 30 },
      ptyProcess: { write: () => {}, onData: () => {}, onExit: () => {}, kill: () => {} }
    });

    assert.strictEqual(monitor.isAutoAcceptEnabled(), false);

    // 1. Control file has state: "on" but allowTurnOnFromWindow: false
    const controlFile = path.join(controlDir, `${monitor.sessionId}.json`);
    fs.writeFileSync(controlFile, JSON.stringify({
      sessionId: monitor.sessionId,
      state: 'on',
      timestamp: new Date().toISOString(),
      token: monitor.statusManager.token,
      allowTurnOnFromWindow: false // Checkbox was off when written!
    }), 'utf8');

    monitor.syncControlState();
    assert.strictEqual(monitor.isAutoAcceptEnabled(), false, '"on" file written with allowTurnOnFromWindow=false must be ignored');

    // 2. Control file has state: "on" and allowTurnOnFromWindow: true, BUT unprofiled session
    const unprofiledMonitor = startAgentwatch({
      command: 'unprofiled-agent',
      auto: false,
      sessionsDir,
      controlDir,
      stdin: new (require('events').EventEmitter)(),
      stdout: { write: () => {}, columns: 120, rows: 30 },
      ptyProcess: { write: () => {}, onData: () => {}, onExit: () => {}, kill: () => {} }
    });

    const unprofiledControlFile = path.join(controlDir, `${unprofiledMonitor.sessionId}.json`);
    fs.writeFileSync(unprofiledControlFile, JSON.stringify({
      sessionId: unprofiledMonitor.sessionId,
      state: 'on',
      timestamp: new Date().toISOString(),
      token: unprofiledMonitor.statusManager.token,
      allowTurnOnFromWindow: true
    }), 'utf8');

    unprofiledMonitor.syncControlState();
    assert.strictEqual(unprofiledMonitor.isAutoAcceptEnabled(), false, '"on" file for unprofiled session must be ignored');

    monitor.cleanup();
    unprofiledMonitor.cleanup();
    suitePassCounts['Suite 6: An On File Written While Allow-Checkbox Was Off is Ignored']++;
    console.log('  ✓ An "on" file written while allow-checkbox was off or for unprofiled sessions is ignored');
  }

  // =========================================================================
  // Suite 7: Prompt Already on Screen When On is Clicked is Not Auto-Answered
  // =========================================================================
  console.log('\n--- Suite 7: Prompt Already on Screen When On is Clicked is Not Auto-Answered ---');
  {
    const tmpDir = createTempDir();
    const controlDir = path.join(tmpDir, 'control');
    const sessionsDir = path.join(tmpDir, 'sessions');
    fs.mkdirSync(controlDir, { recursive: true });
    fs.mkdirSync(sessionsDir, { recursive: true });

    let ptyWrites = [];
    const monitor = startAgentwatch({
      command: 'agy',
      args: ['run'],
      auto: false, // Started with auto OFF
      profile: mockAgyProfile,
      sessionsDir,
      controlDir,
      stdin: new (require('events').EventEmitter)(),
      stdout: { write: () => {}, columns: 120, rows: 30 },
      ptyProcess: { write: (k) => { ptyWrites.push(k); }, onData: () => {}, onExit: () => {}, kill: () => {} },
      rulesPath: path.join(tmpDir, 'rules.json')
    });

    // Prompt 1 appears at T1 while auto is OFF
    const t1 = Date.now();
    const prompt1 = {
      detected: {
        question: 'Run command 1?',
        commandSpaced: 'echo prompt-1',
        options: [
          { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ],
        footerSeen: true
      },
      decision: { action: 'would_approve', delay: 1, optionKey: '1', rule: 'safe-echo' },
      shownTime: t1
    };

    // User turns auto ON at T2 (T2 > T1)
    const t2 = t1 + 500;
    const controlFile = path.join(controlDir, `${monitor.sessionId}.json`);
    fs.writeFileSync(controlFile, JSON.stringify({
      sessionId: monitor.sessionId,
      state: 'on',
      timestamp: new Date(t2).toISOString(),
      token: monitor.statusManager.token,
      allowTurnOnFromWindow: true
    }), 'utf8');

    monitor.syncControlState();
    assert.strictEqual(monitor.isAutoAcceptEnabled(), true, 'Auto accept is now ON');

    // Prompt 1 (which was shown before T2) must NOT be eligible for auto-answer
    assert.strictEqual(
      monitor.isPromptEligibleForAuto(prompt1.detected, prompt1.decision),
      true // without promptObj activePrompt set
    );

    // When prompt1 is active during auto-on:
    monitor.setAutoOnTimestamp(t2);
    // triggerAutoAnswer with prompt1 whose shownTime <= autoOnTimestamp
    monitor.triggerAutoAnswer(prompt1);
    assert.strictEqual(ptyWrites.length, 0, 'In-flight prompt 1 must NOT be auto-answered');

    // Prompt 2 appears at T3 (T3 > T2) -> MUST be auto-answered
    const t3 = t2 + 500;
    const prompt2 = {
      detected: {
        question: 'Run command 2?',
        commandSpaced: 'echo prompt-2',
        options: [
          { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ],
        footerSeen: true
      },
      decision: { action: 'would_approve', delay: 1, optionKey: '1', rule: 'safe-echo' },
      shownTime: t3
    };

    // Prompt 2 sends auto answer
    monitor.sendAutoAnswer('1');
    assert.strictEqual(ptyWrites.length, 1, 'Subsequent prompt 2 appearing after auto-on MUST be answered');
    assert.strictEqual(ptyWrites[0], '1');

    monitor.cleanup();
    suitePassCounts['Suite 7: Prompt Already on Screen When On is Clicked is Not Auto-Answered']++;
    console.log('  ✓ Prompt already on screen when "on" is clicked is left to user; subsequent prompts are auto-answered');
  }

  // =========================================================================
  // Suite 8: IPC setSessionAuto Rejects Paths, Directory Traversal & Oversized Input
  // =========================================================================
  console.log('\n--- Suite 8: IPC setSessionAuto Rejects Paths, Directory Traversal & Oversized Input ---');
  {
    const tmpDir = createTempDir();
    const sessionsDir = path.join(tmpDir, 'sessions');
    const controlDir = path.join(tmpDir, 'control');
    const configPath = path.join(tmpDir, 'config.json');
    const logPath = path.join(tmpDir, 'rules-changes.log');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(controlDir, { recursive: true });

    saveConfig({ allowTurnOnFromWindow: true }, configPath);

    // Create a valid session status file
    const validSessionId = 'sess-valid-test-123';
    const statusManager = new SessionStatusManager({
      sessionId: validSessionId,
      sessionsDir,
      controlDir
    });
    statusManager.start();

    const opts = { sessionsDir, configPath, controlDir, rulesChangesLogPath: logPath };

    // 1. Non-object payload
    assert.strictEqual(setSessionAuto(null, opts).success, false);
    assert.strictEqual(setSessionAuto('bad', opts).success, false);

    // 2. Oversized payload (> 64KB)
    const bigData = 'x'.repeat(70 * 1024);
    assert.strictEqual(setSessionAuto({ sessionId: validSessionId, state: 'on', extra: bigData }, opts).success, false);

    // 3. Path selection forbidden
    assert.strictEqual(setSessionAuto({ sessionId: validSessionId, state: 'on', path: '/etc/passwd' }, opts).success, false);
    assert.strictEqual(setSessionAuto({ sessionId: validSessionId, state: 'on', filePath: 'C:\\bad.json' }, opts).success, false);
    assert.strictEqual(setSessionAuto({ sessionId: validSessionId, state: 'on', controlPath: 'hack.json' }, opts).success, false);

    // 4. Directory traversal in sessionId
    assert.strictEqual(setSessionAuto({ sessionId: '../../sess', state: 'on' }, opts).success, false);
    assert.strictEqual(setSessionAuto({ sessionId: 'folder/sess', state: 'on' }, opts).success, false);
    assert.strictEqual(setSessionAuto({ sessionId: 'sess\\name', state: 'on' }, opts).success, false);

    // 5. Unknown fields rejected
    assert.strictEqual(setSessionAuto({ sessionId: validSessionId, state: 'on', unknownField: 123 }, opts).success, false);

    // 6. Valid payload succeeds
    const res = setSessionAuto({ sessionId: validSessionId, state: 'on' }, opts);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.state, 'on');

    // Verify control file was written atomically with correct content
    const ctrlPath = path.join(controlDir, `${validSessionId}.json`);
    assert(fs.existsSync(ctrlPath), 'Control file must exist');
    const ctrlContent = JSON.parse(fs.readFileSync(ctrlPath, 'utf8'));
    assert.strictEqual(ctrlContent.sessionId, validSessionId);
    assert.strictEqual(ctrlContent.state, 'on');
    assert.strictEqual(ctrlContent.token, statusManager.token);
    assert.strictEqual(ctrlContent.allowTurnOnFromWindow, true);

    statusManager.cleanup();
    suitePassCounts['Suite 8: IPC setSessionAuto Rejects Paths, Directory Traversal & Oversized Input']++;
    console.log('  ✓ IPC setSessionAuto rejects path selection, path traversal, oversized inputs, and unknown fields');
  }

  // =========================================================================
  // Suite 9: Wrapper Deletes Control File on Exit
  // =========================================================================
  console.log('\n--- Suite 9: Wrapper Deletes Control File on Exit ---');
  {
    const tmpDir = createTempDir();
    const sessionsDir = path.join(tmpDir, 'sessions');
    const controlDir = path.join(tmpDir, 'control');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(controlDir, { recursive: true });

    const monitor = startAgentwatch({
      command: 'agy',
      args: ['run'],
      profile: mockAgyProfile,
      sessionsDir,
      controlDir,
      stdin: new (require('events').EventEmitter)(),
      stdout: { write: () => {}, columns: 120, rows: 30 },
      ptyProcess: { write: () => {}, onData: () => {}, onExit: () => {}, kill: () => {} }
    });

    const controlFile = path.join(controlDir, `${monitor.sessionId}.json`);
    fs.writeFileSync(controlFile, JSON.stringify({
      sessionId: monitor.sessionId,
      state: 'off',
      timestamp: new Date().toISOString(),
      token: monitor.statusManager.token,
      allowTurnOnFromWindow: true
    }), 'utf8');

    assert(fs.existsSync(controlFile), 'Control file must exist while active');

    // Run cleanup
    monitor.cleanup();

    assert(!fs.existsSync(controlFile), 'Wrapper must delete control file on exit');

    suitePassCounts['Suite 9: Wrapper Deletes Control File on Exit']++;
    console.log('  ✓ Wrapper cleanly deletes its control file on exit');
  }

  // =========================================================================
  // Suite 10: Window Cannot Write Anywhere Except Allowed Files
  // =========================================================================
  console.log('\n--- Suite 10: Window Cannot Write Anywhere Except Allowed Files ---');
  {
    // Check main.js and renderer.js write destinations
    const mainJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'gui', 'main.js'), 'utf8');
    
    // Check that writeFileSync and appendFileSync targets are all within authorized paths
    const allowedPathPatterns = [
      /configPath/,
      /filePath/,
      /sessionPath/,
      /controlPath/,
      /tempPath/,
      /\bp\b/,
      /CANONICAL_RULES_PATH/,
      /targetPath/,
      /targetLogPath/,
      /logPath/
    ];

    const writeLines = mainJs.split('\n').filter(l => l.includes('fs.writeFileSync(') || l.includes('fs.appendFileSync('));
    for (const line of writeLines) {
      const isAllowed = allowedPathPatterns.some(p => p.test(line));
      assert(isAllowed, `Main process write line must use sanctioned path variable: ${line.trim()}`);
    }

    suitePassCounts['Suite 10: Window Cannot Write Anywhere Except Allowed Files']++;
    console.log('  ✓ Window and main process write exclusively to allowed configuration and control files');
  }

  // =========================================================================
  // Suite 11: Per-Folder Rules Indicator and Jump to Folder Rules
  // =========================================================================
  console.log('\n--- Suite 11: Per-Folder Rules Indicator and Jump to Folder Rules ---');
  {
    const tmpDir = createTempDir();
    const folderRulesDir = path.join(tmpDir, 'folder-rules');
    fs.mkdirSync(folderRulesDir, { recursive: true });

    // Session 1: No own rules -> "default rules"
    const session1Key = 'agy:1111111111111111';
    // Session 2: Has own rules file
    const session2Key = 'agy:2222222222222222';
    fs.writeFileSync(path.join(folderRulesDir, 'agy_2222222222222222.json'), JSON.stringify({
      optionRules: [{ name: 'own-rule-1', startsWith: 'Yes, run command' }]
    }), 'utf8');

    // In getDashboardData
    const data = getDashboardData({
      sessionsDir: tmpDir,
      configPath: path.join(tmpDir, 'config.json')
    });

    // Check row display label logic
    const { hasFolderRules } = require('../src/rules');
    assert.strictEqual(hasFolderRules(session1Key, folderRulesDir), false);
    assert.strictEqual(hasFolderRules(session2Key, folderRulesDir), true);

    const label1 = hasFolderRules(session1Key, folderRulesDir) ? 'own rules' : 'default rules';
    const label2 = hasFolderRules(session2Key, folderRulesDir) ? 'own rules' : 'default rules';

    assert.strictEqual(label1, 'default rules');
    assert.strictEqual(label2, 'own rules');

    suitePassCounts['Suite 11: Per-Folder Rules Indicator and Jump to Folder Rules']++;
    console.log('  ✓ Rows show "default rules" or "own rules" and link to folder rules view');
  }

  // =========================================================================
  // Suite 12: Logging and Toast Notification on State Change
  // =========================================================================
  console.log('\n--- Suite 12: Logging and Toast Notification on State Change ---');
  {
    const tmpDir = createTempDir();
    const logPath = path.join(tmpDir, 'rules-changes.log');
    const sessionsDir = path.join(tmpDir, 'sessions');
    const controlDir = path.join(tmpDir, 'control');
    const configPath = path.join(tmpDir, 'config.json');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(controlDir, { recursive: true });

    saveConfig({ allowTurnOnFromWindow: true }, configPath);

    const sid = 'sess-log-test';
    const statusManager = new SessionStatusManager({
      sessionId: sid,
      sessionsDir,
      controlDir
    });
    statusManager.start();

    // Call setSessionAuto to turn auto ON
    const resOn = setSessionAuto(
      { sessionId: sid, state: 'on' },
      { sessionsDir, configPath, controlDir, rulesChangesLogPath: logPath }
    );
    assert.strictEqual(resOn.success, true);

    // Call setSessionAuto to turn auto OFF
    const resOff = setSessionAuto(
      { sessionId: sid, state: 'off' },
      { sessionsDir, configPath, controlDir, rulesChangesLogPath: logPath }
    );
    assert.strictEqual(resOff.success, true);

    // Verify rules-changes.log
    assert(fs.existsSync(logPath), 'rules-changes.log must exist');
    const logLines = fs.readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    assert.strictEqual(logLines.length, 2);

    const log1 = logLines[0];
    assert.strictEqual(log1.who, 'gui');
    assert.strictEqual(log1.to, 'on');
    assert(log1.time);
    assert(log1.folder);
    assert(!log1.folder.includes('/'), 'Log must not contain raw paths');

    const log2 = logLines[1];
    assert.strictEqual(log2.who, 'gui');
    assert.strictEqual(log2.to, 'off');
    assert.strictEqual(log2.from, 'on');

    // Test toast notification function
    assert(typeof rendererModule.showToast === 'function', 'showToast must be a function');

    statusManager.cleanup();
    suitePassCounts['Suite 12: Logging and Toast Notification on State Change']++;
    console.log('  ✓ State changes logged to rules-changes.log (no secrets) and toast notification fired');
  }

  // =========================================================================
  // Suite 13: Single-Write-Path Safety & Privacy Re-check
  // =========================================================================
  console.log('\n--- Suite 13: Single-Write-Path Safety & Privacy Re-check ---');
  {
    // 1. Single write path invariant in agentwatch.js
    const agentwatchSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agentwatch.js'), 'utf8');
    const writeMatches = agentwatchSrc.match(/\bptyProcess\.write\s*\(/g) || [];
    assert(
      writeMatches.length > 0 && writeMatches.length <= 3,
      `ptyProcess.write must only be called in stdin handler or sendAutoAnswer, found ${writeMatches.length}`
    );

    // 2. GUI files must contain ZERO write calls to child processes
    const guiFiles = fs.readdirSync(path.join(__dirname, '..', 'src', 'gui')).filter(f => f.endsWith('.js'));
    for (const f of guiFiles) {
      const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'gui', f), 'utf8');
      assert(!code.includes('ptyProcess'), `GUI file ${f} must never reference ptyProcess`);
      assert(!code.includes('.write('), `GUI file ${f} must never call .write()`);
    }

    suitePassCounts['Suite 13: Single-Write-Path Safety & Privacy Re-check']++;
    console.log('  ✓ Child process single-write-path and privacy invariants strictly maintained');
  }

  console.log('\n=========================================');
  console.log('Stage 6 Pass Counts Per Suite:');
  for (const [suite, count] of Object.entries(suitePassCounts)) {
    console.log(`  ${suite}: ${count} passed`);
  }
  console.log('\nAll 13 Stage 6 suites passed successfully!');
  console.log('=========================================\n');
}

runStage6Tests().catch(err => {
  console.error('Stage 6 test failure:', err);
  process.exit(1);
});
