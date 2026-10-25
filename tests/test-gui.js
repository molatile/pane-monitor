const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  loadConfig,
  saveConfig,
  getSessionKey,
  getDisplayName,
  setSessionName,
  setSessionOrder,
  setNotifications,
  setAlwaysOnTop,
  setWindowBounds,
  orderSessions,
  reorderSession,
  acquireNotificationLock,
  formatDuration,
  getStateLight,
  getSessionSummary,
  getDashboardData
} = require('../src/shared');

const { SESSIONS_DIR, SessionStatusManager } = require('../src/status');
const { NotificationManager } = require('../src/notifier');
const { parseArgs } = require('../bin/agentwatch');

console.log('Running agentwatch Stage 2.5 GUI test suite...\n');

// -------------------------------------------------------------
// Test Group 1: Shared Module Functions & Dashboard Data Aggregation
// -------------------------------------------------------------
console.log('--- Test Group 1: Shared Module & Dashboard Data ---');
{
  const tempDir = path.join(os.tmpdir(), `agentwatch-test-shared-${Date.now()}`);
  const sessionsDir = path.join(tempDir, 'sessions');
  const configPath = path.join(tempDir, 'config.json');
  fs.mkdirSync(sessionsDir, { recursive: true });

  const now = Date.now();

  // Create two sessions: 1 idle, 1 asking
  const s1 = {
    sessionId: 'sess-s1',
    sessionKey: 'agy:hash1',
    folderHash: 'hash1',
    agent: 'agy',
    folder: 'app-one',
    state: 'idle',
    stateSince: new Date(now - 45000).toISOString(), // 45s
    heartbeat: new Date(now - 1000).toISOString(),
    backgroundTasks: 0
  };
  fs.writeFileSync(path.join(sessionsDir, 'sess-s1.json'), JSON.stringify(s1));

  const s2 = {
    sessionId: 'sess-s2',
    sessionKey: 'agy:hash2',
    folderHash: 'hash2',
    agent: 'agy',
    folder: 'app-two',
    state: 'asking',
    stateSince: new Date(now - 12000).toISOString(), // 12s
    heartbeat: new Date(now - 1000).toISOString(),
    prompt: {
      question: 'Run this command?',
      command: 'echo deploy',
      decision: 'would approve option 1 after 3s'
    },
    backgroundTasks: 2
  };
  fs.writeFileSync(path.join(sessionsDir, 'sess-s2.json'), JSON.stringify(s2));

  // Set initial config
  const initialConfig = {
    order: ['agy:hash2', 'agy:hash1'],
    names: {
      'agy:hash1': 'Primary Server',
      'agy:hash2': 'Worker Service'
    },
    notifications: true,
    alwaysOnTop: true,
    window: { width: 440, height: 380, x: 100, y: 150 }
  };
  saveConfig(initialConfig, configPath);

  // Retrieve dashboard data via shared module
  const data = getDashboardData({ sessionsDir, configPath, nowMs: now });
  assert(data && data.sessions, 'getDashboardData must return structured object');
  assert.strictEqual(data.sessions.length, 2, 'Must return 2 sessions');

  // Verify order matches config.order
  assert.strictEqual(data.sessions[0].sessionId, 'sess-s2');
  assert.strictEqual(data.sessions[0].displayName, 'Worker Service');
  assert.strictEqual(data.sessions[0].state, 'asking');
  assert.strictEqual(data.sessions[0].isAsking, true);
  assert.strictEqual(data.sessions[0].duration, '12s');
  assert.strictEqual(data.sessions[0].backgroundTasks, 2);
  assert(data.sessions[0].prompt !== null);
  assert.strictEqual(data.sessions[0].prompt.command, 'echo deploy');

  assert.strictEqual(data.sessions[1].sessionId, 'sess-s1');
  assert.strictEqual(data.sessions[1].displayName, 'Primary Server');
  assert.strictEqual(data.sessions[1].state, 'idle');
  assert.strictEqual(data.sessions[1].isAsking, false);
  assert.strictEqual(data.sessions[1].duration, '45s');
  assert.strictEqual(data.sessions[1].summary, 'Waiting for user');

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✓ Test Group 1 passed: Shared module functions and dashboard data agreement verified');
}

// -------------------------------------------------------------
// Test Group 2: Drag-Reorder and Window Settings Persistence
// -------------------------------------------------------------
console.log('\n--- Test Group 2: Drag-Reorder & Window Settings Persistence ---');
{
  const tempDir = path.join(os.tmpdir(), `agentwatch-test-reorder-${Date.now()}`);
  const configPath = path.join(tempDir, 'config.json');

  const config = loadConfig(configPath);
  assert.deepStrictEqual(config.order, []);
  assert.strictEqual(config.alwaysOnTop, false);

  // 1. Reorder via drag-and-drop: user reorders to ['agy:h3', 'agy:h1', 'agy:h2']
  const newDragOrder = ['agy:h3', 'agy:h1', 'agy:h2'];
  setSessionOrder(config, newDragOrder, configPath);

  // 2. Window bounds resize / move
  setWindowBounds(config, { width: 500, height: 420, x: 250, y: 300 }, configPath);

  // 3. Always on top toggle
  setAlwaysOnTop(config, true, configPath);

  // 4. Rename
  setSessionName(config, 'agy:h3', 'Database Node', configPath);

  // Reload config fresh from disk
  const reloaded = loadConfig(configPath);
  assert.deepStrictEqual(reloaded.order, ['agy:h3', 'agy:h1', 'agy:h2'], 'Drag-and-drop order must be persisted');
  assert.strictEqual(reloaded.alwaysOnTop, true, 'alwaysOnTop must be persisted');
  assert.strictEqual(reloaded.window.width, 500);
  assert.strictEqual(reloaded.window.height, 420);
  assert.strictEqual(reloaded.window.x, 250);
  assert.strictEqual(reloaded.window.y, 300);
  assert.strictEqual(reloaded.names['agy:h3'], 'Database Node');

  // Verify raw content NEVER contains raw directory paths
  const fileContent = fs.readFileSync(configPath, 'utf8');
  assert(!fileContent.includes('C:\\'), 'Must never contain raw paths');
  assert(!fileContent.includes('/Users/'), 'Must never contain raw paths');
  assert(!fileContent.includes('/home/'), 'Must never contain raw paths');

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✓ Test Group 2 passed: Drag-reorder, rename, window bounds, and alwaysOnTop persistence verified');
}

// -------------------------------------------------------------
// Test Group 3: Inter-Viewer Notification Coordination (Locking)
// -------------------------------------------------------------
console.log('\n--- Test Group 3: Inter-Viewer Notification Coordination ---');
{
  const tempDir = path.join(os.tmpdir(), `agentwatch-test-notify-lock-${Date.now()}`);
  const configPath = path.join(tempDir, 'config.json');

  const now = 100000;

  // Viewer 1 (e.g. Terminal Dashboard) checks and acquires lock for asking transition
  const lock1 = acquireNotificationLock('sess-100', 'asking', now, configPath);
  assert.strictEqual(lock1, true, 'First viewer must successfully acquire notification lock');

  // Viewer 2 (GUI) checks simultaneously (within 5 seconds) for same session and state
  const lock2 = acquireNotificationLock('sess-100', 'asking', now + 500, configPath);
  assert.strictEqual(lock2, false, 'Second viewer must be blocked by notification lock within 5s');

  // Viewer 2 checks for a DIFFERENT session
  const lockOtherSession = acquireNotificationLock('sess-200', 'asking', now + 600, configPath);
  assert.strictEqual(lockOtherSession, true, 'Different session must acquire its own lock');

  // After 5.1s cooldown, new transition qualifies
  const lockAfterCooldown = acquireNotificationLock('sess-100', 'idle', now + 6000, configPath);
  assert.strictEqual(lockAfterCooldown, true, 'Qualifying transition after cooldown must acquire lock');

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✓ Test Group 3 passed: Inter-viewer notification locking prevents duplicate notifications');
}

// -------------------------------------------------------------
// Test Group 4: Electron Security Settings Static Verification
// -------------------------------------------------------------
console.log('\n--- Test Group 4: Electron Security Settings ---');
{
  const mainJsPath = path.resolve(__dirname, '../src/gui/main.js');
  const preloadJsPath = path.resolve(__dirname, '../src/gui/preload.js');
  const indexHtmlPath = path.resolve(__dirname, '../src/gui/index.html');

  assert(fs.existsSync(mainJsPath), 'src/gui/main.js must exist');
  assert(fs.existsSync(preloadJsPath), 'src/gui/preload.js must exist');
  assert(fs.existsSync(indexHtmlPath), 'src/gui/index.html must exist');

  const mainCode = fs.readFileSync(mainJsPath, 'utf8');
  const preloadCode = fs.readFileSync(preloadJsPath, 'utf8');
  const htmlCode = fs.readFileSync(indexHtmlPath, 'utf8');

  // 1. contextIsolation on
  assert(
    mainCode.includes('contextIsolation: true'),
    'Security violation: contextIsolation must be true in main.js'
  );

  // 2. nodeIntegration off
  assert(
    mainCode.includes('nodeIntegration: false'),
    'Security violation: nodeIntegration must be false in main.js'
  );

  // 3. sandbox on
  assert(
    mainCode.includes('sandbox: true'),
    'Security requirement: sandbox must be true in main.js'
  );

  // 4. webviewTag off
  assert(
    mainCode.includes('webviewTag: false'),
    'Security requirement: webviewTag must be false'
  );

  // 5. Navigation blocked
  assert(
    mainCode.includes("will-navigate") && mainCode.includes("event.preventDefault()"),
    'Security requirement: all will-navigate attempts must be blocked'
  );

  // 6. New windows blocked
  assert(
    mainCode.includes("setWindowOpenHandler") && mainCode.includes("action: 'deny'"),
    'Security requirement: setWindowOpenHandler must deny new windows'
  );

  // 7. Window never steals focus
  assert(
    mainCode.includes("showInactive()"),
    'Requirement: Window must call showInactive() and never steal focus'
  );

  // 8. Strict Content-Security-Policy with no remote sources
  assert(
    htmlCode.includes("Content-Security-Policy") && htmlCode.includes("default-src 'none'"),
    'Security requirement: index.html must declare strict CSP with default-src none'
  );
  assert(
    !htmlCode.includes('http://') && !htmlCode.includes('https://'),
    'Security requirement: index.html must never reference remote URLs'
  );
  assert(
    mainCode.includes("default-src 'none'"),
    'Security requirement: main.js webRequest must enforce strict CSP header'
  );

  // 9. Preload exposes minimal fixed API via contextBridge
  assert(
    preloadCode.includes("contextBridge.exposeInMainWorld('agentwatch'"),
    'Preload script must use contextBridge to expose agentwatch API'
  );
  assert(
    !preloadCode.includes('require(') || (preloadCode.match(/require\(/g).length === 1 && preloadCode.includes("require('electron')")),
    'Preload script must never expose Node.js require or fs'
  );
  assert(!preloadCode.includes('process.'), 'Preload must not expose process object');

  console.log('✓ Test Group 4 passed: Electron security settings (contextIsolation, nodeIntegration, CSP, navigation blocked) verified');
}

// -------------------------------------------------------------
// Test Group 5: READ-ONLY toward agents & Forbidden Files Invariance
// -------------------------------------------------------------
console.log('\n--- Test Group 5: File Access Safety & Zero Network Calls ---');
{
  const guiDir = path.resolve(__dirname, '../src/gui');
  const guiFiles = fs.readdirSync(guiDir);

  const forbiddenFiles = ['raw-session.bin', 'prompts.log', 'snapshots', 'history.jsonl'];

  for (const file of guiFiles) {
    const content = fs.readFileSync(path.join(guiDir, file), 'utf8');

    // 1. Must never read or mention forbidden files
    for (const forbidden of forbiddenFiles) {
      assert(
        !content.includes(forbidden),
        `Safety violation: GUI file src/gui/${file} references forbidden file "${forbidden}"`
      );
    }

    // 2. Must never send keys or write to child process
    assert(!content.includes('.write('), `Safety violation: GUI file src/gui/${file} contains .write call`);
    assert(!content.includes('sendInput'), `Safety violation: GUI file src/gui/${file} contains sendInput`);

    // 3. Must never make network calls
    assert(!content.includes('http.request'), `Safety violation: GUI file src/gui/${file} makes http call`);
    assert(!content.includes('https.request'), `Safety violation: GUI file src/gui/${file} makes https call`);
    assert(!content.includes('fetch('), `Safety violation: GUI file src/gui/${file} makes fetch call`);
    assert(!content.includes('WebSocket'), `Safety violation: GUI file src/gui/${file} makes WebSocket call`);
    assert(!content.includes('net.connect'), `Safety violation: GUI file src/gui/${file} makes net.connect call`);
  }

  // Verify CLI parsing for gui command
  const cli1 = parseArgs(['gui']);
  assert.strictEqual(cli1.command, 'gui');
  assert.strictEqual(cli1.quiet, false);
  assert.strictEqual(cli1.restart, false);

  const cli2 = parseArgs(['gui', '--quiet']);
  assert.strictEqual(cli2.command, 'gui');
  assert.strictEqual(cli2.quiet, true);
  assert.strictEqual(cli2.restart, false);

  const cli3 = parseArgs(['gui', '--restart']);
  assert.strictEqual(cli3.command, 'gui');
  assert.strictEqual(cli3.quiet, false);
  assert.strictEqual(cli3.restart, true);

  const cli4 = parseArgs(['gui', '--quiet', '--restart']);
  assert.strictEqual(cli4.command, 'gui');
  assert.strictEqual(cli4.quiet, true);
  assert.strictEqual(cli4.restart, true);

  const cli5 = parseArgs(['--restart', 'gui']);
  assert.strictEqual(cli5.command, 'gui');
  assert.strictEqual(cli5.restart, true);

  console.log('✓ Test Group 5 passed: Zero child input, forbidden files not accessed, zero network calls, and CLI args verified');
}

// -------------------------------------------------------------
// Test Group 6: Renderer In-Place Updates & Interaction Survival During Refreshes
// -------------------------------------------------------------
console.log('\n--- Test Group 6: Interaction Survival During Refreshes (Edit & Drag) ---');
{
  // Lightweight DOM environment fixture for testing renderer.js in Node
  function createDOMFixture() {
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

      setAttribute(k, v) {
        this.attributes.set(k, String(v));
      }
      getAttribute(k) {
        return this.attributes.get(k);
      }

      appendChild(child) {
        if (child.parentNode) {
          child.parentNode.removeChild(child);
        }
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
        if (newChild.parentNode) {
          newChild.parentNode.removeChild(newChild);
        }
        const idx = this.children.indexOf(refChild);
        if (idx === -1) {
          return this.appendChild(newChild);
        }
        newChild.parentNode = this;
        this.children.splice(idx, 0, newChild);
        return newChild;
      }

      remove() {
        if (this.parentNode) {
          this.parentNode.removeChild(this);
        }
      }

      addEventListener(event, fn) {
        if (!this.listeners.has(event)) {
          this.listeners.set(event, []);
        }
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
        const isAttr = selector.startsWith('[') && selector.endsWith(']');

        function match(node) {
          if (!node || !node.classList) return false;
          if (isClass) {
            return node.classList.contains(selector.slice(1));
          }
          if (isId) {
            return node.id === selector.slice(1);
          }
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

      focus() {}
      select() {}
    }

    const elementsById = new Map();
    const countBadge = new MockElement('span');
    countBadge.id = 'agent-count-badge';
    elementsById.set('agent-count-badge', countBadge);

    const pinCheckbox = new MockElement('input');
    pinCheckbox.id = 'always-on-top-checkbox';
    pinCheckbox.type = 'checkbox';
    elementsById.set('always-on-top-checkbox', pinCheckbox);

    const container = new MockElement('main');
    container.id = 'sessions-container';
    elementsById.set('sessions-container', container);

    const document = {
      getElementById: (id) => elementsById.get(id) || null,
      createElement: (tag) => new MockElement(tag),
      createTextNode: (txt) => ({ textContent: txt, parentNode: null }),
      activeElement: null
    };

    const window = {
      agentwatch: {
        renameCalls: [],
        reorderCalls: [],
        renameSession: (key, name) => { window.agentwatch.renameCalls.push({ key, name }); },
        reorderSessions: (keys) => { window.agentwatch.reorderCalls.push(keys); },
        setAlwaysOnTop: () => {},
        onUpdate: () => {},
        getState: async () => ({})
      }
    };

    return { document, window, container, countBadge, pinCheckbox };
  }

  const dom = createDOMFixture();
  global.document = dom.document;
  global.window = dom.window;

  const renderer = require('../src/gui/renderer');

  const initialData = {
    config: { alwaysOnTop: false },
    sessions: [
      {
        sessionKey: 'agy:hash1',
        displayName: 'Primary Server',
        agent: 'agy',
        folder: 'app-one',
        duration: '10s',
        state: 'idle',
        isAsking: false,
        summary: 'Waiting for user'
      },
      {
        sessionKey: 'powershell:hash2',
        displayName: 'powershell-worker',
        agent: 'powershell',
        folder: 'scripts',
        duration: '5s',
        state: 'busy',
        isAsking: false,
        summary: 'Running migration'
      }
    ]
  };

  // 1. Initial Render
  renderer.render(initialData);
  assert.strictEqual(dom.container.children.length, 2, 'Must render 2 sessions');

  const row1 = dom.container.querySelector('[data-session-key="agy:hash1"]');
  const row2 = dom.container.querySelector('[data-session-key="powershell:hash2"]');
  assert(row1, 'Row 1 must exist');
  assert(row2, 'Row 2 must exist');

  // Verify agent name on each row (e.g. "agy" and "powershell")
  const agent1 = row1.querySelector('.session-agent');
  const agent2 = row2.querySelector('.session-agent');
  assert(agent1, 'Agent badge must exist on row 1');
  assert.strictEqual(agent1.textContent, 'agy', 'Row 1 agent must be "agy"');
  assert(agent2, 'Agent badge must exist on row 2');
  assert.strictEqual(agent2.textContent, 'powershell', 'Row 2 agent must be "powershell"');

  // Verify edit pencil button exists on each row
  const editBtn1 = row1.querySelector('.edit-btn');
  const editBtn2 = row2.querySelector('.edit-btn');
  assert(editBtn1 && editBtn1.textContent === '✎', 'Row 1 must have pencil edit button');
  assert(editBtn2 && editBtn2.textContent === '✎', 'Row 2 must have pencil edit button');

  // 2. In-place update test: updates without destroying elements
  const tickData1 = JSON.parse(JSON.stringify(initialData));
  tickData1.sessions[0].duration = '11s';
  tickData1.sessions[1].duration = '6s';
  renderer.render(tickData1);

  const row1AfterUpdate = dom.container.querySelector('[data-session-key="agy:hash1"]');
  const row2AfterUpdate = dom.container.querySelector('[data-session-key="powershell:hash2"]');
  assert.strictEqual(row1AfterUpdate, row1, 'Row 1 DOM node must be updated in place (never destroyed)');
  assert.strictEqual(row2AfterUpdate, row2, 'Row 2 DOM node must be updated in place (never destroyed)');
  assert.strictEqual(row1.querySelector('.session-duration').textContent, '11s', 'Duration updated in place');

  // 3. Simulate refresh arriving DURING an edit interaction
  // Start rename via single-click on the fallback pencil edit button
  editBtn1.dispatchEvent({ type: 'click', stopPropagation: () => {} });
  assert.strictEqual(renderer.getEditingSessionKey(), 'agy:hash1', 'Editing must be active for agy:hash1');

  const inputEl = row1.querySelector('.rename-input');
  assert(inputEl, 'Rename input element must be inserted into row 1');
  assert.strictEqual(inputEl.value, 'Primary Server');

  // User types into input during edit
  inputEl.value = 'Primary Server (Staging Node)';

  // 1-second refresh arrives WHILE user is actively editing
  const tickDataDuringEdit = JSON.parse(JSON.stringify(tickData1));
  tickDataDuringEdit.sessions[0].duration = '12s';
  tickDataDuringEdit.sessions[1].duration = '7s';
  renderer.render(tickDataDuringEdit);

  // Assert the edit interaction SURVIVED the refresh:
  assert.strictEqual(renderer.getEditingSessionKey(), 'agy:hash1', 'Editing must remain active after refresh');
  const inputElAfterRefresh = row1.querySelector('.rename-input');
  assert.strictEqual(inputElAfterRefresh, inputEl, 'Active input DOM node must NOT be destroyed by periodic refresh');
  assert.strictEqual(inputElAfterRefresh.value, 'Primary Server (Staging Node)', 'User typed value must survive periodic refresh');
  assert.strictEqual(row2.querySelector('.session-duration').textContent, '7s', 'Non-edited rows must still update in place');

  // Complete rename by pressing Enter
  inputEl.dispatchEvent({ type: 'keydown', key: 'Enter' });
  assert.strictEqual(renderer.getEditingSessionKey(), null, 'Editing must end on Enter');
  assert.strictEqual(dom.window.agentwatch.renameCalls.length, 1, 'renameSession IPC must be called');
  assert.strictEqual(dom.window.agentwatch.renameCalls[0].name, 'Primary Server (Staging Node)');
  assert.strictEqual(row1.querySelector('.session-name').textContent, 'Primary Server (Staging Node)');
  assert.strictEqual(row1.querySelector('.rename-input'), null, 'Input element must be removed after save');

  // 4. Double-click to rename works & Esc cancels
  const nameEl2 = row2.querySelector('.session-name');
  nameEl2.dispatchEvent({ type: 'dblclick', stopPropagation: () => {} });
  assert.strictEqual(renderer.getEditingSessionKey(), 'powershell:hash2', 'Double-click on session-name starts rename');
  const inputEl2 = row2.querySelector('.rename-input');
  assert(inputEl2 && inputEl2.value === 'powershell-worker');
  // Cancel with Escape
  inputEl2.dispatchEvent({ type: 'keydown', key: 'Escape' });
  assert.strictEqual(renderer.getEditingSessionKey(), null, 'Escape must cancel rename');
  assert.strictEqual(row2.querySelector('.rename-input'), null, 'Input element removed on cancel');
  assert.strictEqual(row2.querySelector('.session-name').textContent, 'powershell-worker');

  // 5. Simulate refresh arriving DURING a drag interaction
  // Start dragging row 1
  row1.dispatchEvent({ type: 'dragstart', dataTransfer: { effectAllowed: '', setData: () => {} } });
  assert.strictEqual(renderer.getDraggedKey(), 'agy:hash1', 'draggedKey must be set to agy:hash1');
  assert(row1.classList.contains('dragging'), 'Row 1 must have dragging class');

  // 1-second refresh arrives WHILE user is dragging
  const tickDataDuringDrag = JSON.parse(JSON.stringify(tickDataDuringEdit));
  tickDataDuringDrag.sessions[0].duration = '13s';
  tickDataDuringDrag.sessions[1].duration = '8s';
  renderer.render(tickDataDuringDrag);

  // Assert the drag interaction SURVIVED the refresh:
  assert.strictEqual(renderer.getDraggedKey(), 'agy:hash1', 'draggedKey must remain agy:hash1 during drag');
  assert(row1.classList.contains('dragging'), 'Row 1 must still have dragging class during drag');
  assert.strictEqual(dom.container.children.length, 2, 'Container children must not be wiped or destroyed');
  assert.strictEqual(dom.container.querySelector('[data-session-key="agy:hash1"]'), row1, 'Dragged DOM node preserved');

  // Complete drop onto row 2
  row2.dispatchEvent({ type: 'drop', preventDefault: () => {} });
  assert.strictEqual(dom.window.agentwatch.reorderCalls.length, 1, 'reorderSessions IPC must be called');
  assert.deepStrictEqual(dom.window.agentwatch.reorderCalls[0], ['powershell:hash2', 'agy:hash1']);

  // Complete dragend
  row1.dispatchEvent({ type: 'dragend' });
  assert.strictEqual(renderer.getDraggedKey(), null, 'draggedKey must be reset on dragend');
  assert(!row1.classList.contains('dragging'), 'dragging class removed on dragend');

  console.log('✓ Test Group 6 passed: In-place row updates and interaction survival during edit & drag verified');
}

console.log('\n=========================================');
console.log('All agentwatch Stage 2.5 GUI tests passed successfully!');
console.log('=========================================\n');
