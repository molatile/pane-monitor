const assert = require('assert');

// -------------------------------------------------------------
// Mock DOM & Environment Setup
// -------------------------------------------------------------
class MockClassList {
  constructor() {
    this._classes = new Set();
  }
  add(...names) {
    names.forEach(n => { if (n) this._classes.add(n); });
  }
  remove(...names) {
    names.forEach(n => this._classes.delete(n));
  }
  contains(name) {
    return this._classes.has(name);
  }
  get length() {
    return this._classes.size;
  }
  toString() {
    return Array.from(this._classes).join(' ');
  }
}

class MockElement {
  constructor(tag = 'div') {
    this.tagName = tag.toUpperCase();
    this.nodeType = 1;
    this.classList = new MockClassList();
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.listeners = new Map();
    this.parentNode = null;
    this.children = [];
    this._textContent = '';
    this._innerHTML = '';
    this._value = '';
  }

  get textContent() {
    if (this._textContent) return this._textContent;
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

  get className() {
    return this.classList.toString();
  }
  set className(val) {
    this.classList = new MockClassList();
    if (val) {
      val.split(/\s+/).forEach(c => this.classList.add(c));
    }
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
    let curr = this;
    evt.target = this;
    if (!evt.stopPropagation) {
      evt.stopPropagation = () => { evt._stopped = true; };
    }
    while (curr) {
      const list = curr.listeners.get(evt.type) || [];
      for (const fn of list) {
        fn(evt);
        if (evt._stopped) break;
      }
      if (evt._stopped) break;
      curr = curr.parentNode;
    }
  }

  closest(selector) {
    let curr = this;
    while (curr) {
      if (curr.classList && selector.startsWith('.') && curr.classList.contains(selector.slice(1))) {
        return curr;
      }
      if (curr.id && selector.startsWith('#') && curr.id === selector.slice(1)) {
        return curr;
      }
      curr = curr.parentNode;
    }
    return null;
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

// Build standard fixture elements
const agentCountBadge = getOrCreate('agent-count-badge', 'span');
const pinCheckbox = getOrCreate('always-on-top-checkbox', 'input');
const container = getOrCreate('sessions-container', 'main');
container.className = 'sessions-list';
const tabBtnAgents = getOrCreate('tab-btn-agents', 'button');
const tabBtnSettings = getOrCreate('tab-btn-settings', 'button');
const agentsView = getOrCreate('agents-view', 'div');
const settingsView = getOrCreate('settings-view', 'div');
const pastAgentsDetails = getOrCreate('past-agents-details', 'details');
const pastAgentsCount = getOrCreate('past-agents-count', 'span');
const pastAgentsList = getOrCreate('past-agents-list', 'div');
const historyHeader = getOrCreate('history-header', 'div');
const historyAgentName = getOrCreate('history-agent-name', 'span');
const clearHistoryBtn = getOrCreate('clear-history-btn', 'button');
const historyPlaceholder = getOrCreate('history-placeholder', 'div');
const historyGroups = getOrCreate('history-groups', 'div');
const loadOlderContainer = getOrCreate('load-older-container', 'div');
const loadOlderBtn = getOrCreate('load-older-btn', 'button');
const settingAutoOpen = getOrCreate('setting-auto-open', 'input');
const settingPinTop = getOrCreate('setting-pin-top', 'input');
const settingNotifications = getOrCreate('setting-notifications', 'input');
const settingTimeFormat = getOrCreate('setting-time-format', 'select');

// Live agents section enclosing container
const liveAgentsSection = new MockElement('section');
liveAgentsSection.className = 'live-agents-section';
liveAgentsSection.appendChild(container);

global.document = {
  getElementById: (id) => elementsById.get(id) || null,
  querySelector: (sel) => {
    if (sel === '.live-agents-section') return liveAgentsSection;
    return null;
  },
  createElement: (tag) => new MockElement(tag),
  createTextNode: (txt) => ({ textContent: txt, parentNode: null }),
  activeElement: null
};

const windowListeners = new Map();
global.window = {
  confirm: () => true,
  addEventListener: (event, fn) => {
    if (!windowListeners.has(event)) windowListeners.set(event, []);
    windowListeners.get(event).push(fn);
  },
  dispatchEvent: (evt) => {
    if (!evt.stopPropagation) {
      evt.stopPropagation = () => { evt._stopped = true; };
    }
    const list = windowListeners.get(evt.type) || [];
    for (const fn of list) {
      fn(evt);
      if (evt._stopped) break;
    }
  },
  agentwatch: {
    getState: async () => ({}),
    onUpdate: () => {},
    readHistory: async (opts) => ({
      events: [],
      hasOlder: false,
      nextOffset: 0,
      knownAgents: []
    }),
    clearAgentHistory: async () => ({ success: true }),
    renameSession: () => {},
    reorderSessions: () => {},
    setSetting: () => {},
    setAlwaysOnTop: () => {}
  }
};

const renderer = require('../src/gui/renderer');

console.log('Running agentwatch GUI Unselect UX test suite...\n');

let passCount = 0;
let totalTests = 0;

function testCase(name, fn) {
  totalTests++;
  try {
    fn();
    passCount++;
    console.log(`  ✓ Test ${totalTests}: ${name} passed`);
  } catch (err) {
    console.error(`  ✗ Test ${totalTests}: ${name} FAILED:`, err.message);
    throw err;
  }
}

// -------------------------------------------------------------
// Test Group 1: Clicking the already-selected row unselects it
// -------------------------------------------------------------
console.log('--- Test Group 1: Clicking Already-Selected Row ---');
{
  renderer.resetState();
  const testData = {
    sessions: [
      {
        sessionKey: 'live:agent-a',
        sessionId: 'sess-a',
        displayName: 'Worker A',
        agent: 'agy',
        folder: 'project-a',
        duration: '10s',
        state: 'idle',
        isAsking: false
      },
      {
        sessionKey: 'live:agent-b',
        sessionId: 'sess-b',
        displayName: 'Worker B',
        agent: 'agy',
        folder: 'project-b',
        duration: '20s',
        state: 'busy',
        isAsking: false
      }
    ]
  };

  renderer.render(testData);
  const rowA = container.querySelector('[data-session-key="live:agent-a"]');
  const rowB = container.querySelector('[data-session-key="live:agent-b"]');
  assert(rowA && rowB, 'Rows must be created in container');

  testCase('Clicking row selects it', () => {
    rowA.dispatchEvent({ type: 'click' });
    assert.strictEqual(renderer.getSelectedAgentKey(), 'live:agent-a');
    assert.strictEqual(rowA.classList.contains('selected'), true);
    assert.strictEqual(rowB.classList.contains('selected'), false);
  });

  testCase('Clicking the already-selected row unselects it', () => {
    rowA.dispatchEvent({ type: 'click' });
    assert.strictEqual(renderer.getSelectedAgentKey(), null, 'selectedAgentKey must be null');
    assert.strictEqual(rowA.classList.contains('selected'), false, 'rowA must not have selected class');
    assert.strictEqual(rowB.classList.contains('selected'), false);
    assert.strictEqual(historyPlaceholder.style.display, 'block');
    assert.strictEqual(historyPlaceholder.textContent, 'Select an agent to see its history');
  });

  testCase('Selecting past agent and clicking again unselects it', () => {
    renderer.setKnownAgents([
      { sessionKey: 'past:agent-c', displayName: 'Past Worker', agent: 'agy', folder: 'past-app' }
    ]);
    renderer.renderPastAgents();

    const pastRow = pastAgentsList.querySelector('[data-session-key="past:agent-c"]');
    assert(pastRow, 'Past agent row must exist');

    // Click to select
    pastRow.dispatchEvent({ type: 'click' });
    assert.strictEqual(renderer.getSelectedAgentKey(), 'past:agent-c');
    assert.strictEqual(pastRow.classList.contains('selected'), true);

    // Click again to unselect
    pastRow.dispatchEvent({ type: 'click' });
    assert.strictEqual(renderer.getSelectedAgentKey(), null);
    assert.strictEqual(pastRow.classList.contains('selected'), false);
    assert.strictEqual(historyPlaceholder.style.display, 'block');
  });
}

// -------------------------------------------------------------
// Test Group 2: Pressing Esc unselects it (when not editing)
// -------------------------------------------------------------
console.log('\n--- Test Group 2: Pressing Esc Unselects Agent ---');
{
  renderer.resetState();
  const testData = {
    sessions: [
      {
        sessionKey: 'live:agent-esc',
        sessionId: 'sess-esc',
        displayName: 'Esc Worker',
        agent: 'agy',
        folder: 'project-esc',
        duration: '5s',
        state: 'idle',
        isAsking: false
      }
    ]
  };
  renderer.render(testData);
  const row = container.querySelector('[data-session-key="live:agent-esc"]');

  testCase('Pressing Esc when selected unselects the agent', () => {
    // Select agent
    row.dispatchEvent({ type: 'click' });
    assert.strictEqual(renderer.getSelectedAgentKey(), 'live:agent-esc');
    assert.strictEqual(row.classList.contains('selected'), true);

    // Press Escape via window keydown
    window.dispatchEvent({ type: 'keydown', key: 'Escape' });

    assert.strictEqual(renderer.getSelectedAgentKey(), null, 'selectedAgentKey must be null');
    assert.strictEqual(row.classList.contains('selected'), false);
    assert.strictEqual(historyPlaceholder.style.display, 'block');
    assert.strictEqual(historyPlaceholder.textContent, 'Select an agent to see its history');
  });

  testCase('Pressing Esc when nothing is selected is a safe no-op', () => {
    assert.strictEqual(renderer.getSelectedAgentKey(), null);
    window.dispatchEvent({ type: 'keydown', key: 'Escape' });
    assert.strictEqual(renderer.getSelectedAgentKey(), null);
    assert.strictEqual(historyPlaceholder.style.display, 'block');
  });
}

// -------------------------------------------------------------
// Test Group 3: Esc while name is being edited cancels edit first
// -------------------------------------------------------------
console.log('\n--- Test Group 3: Esc While Editing Cancels Edit First ---');
{
  renderer.resetState();
  const testData = {
    sessions: [
      {
        sessionKey: 'live:rename-agent',
        sessionId: 'sess-rn',
        displayName: 'Original Name',
        agent: 'agy',
        folder: 'proj-rn',
        duration: '1m',
        state: 'idle',
        isAsking: false
      }
    ]
  };
  renderer.render(testData);
  const row = container.querySelector('[data-session-key="live:rename-agent"]');

  testCase('First Esc cancels rename edit without unselecting agent', () => {
    // Select agent
    row.dispatchEvent({ type: 'click' });
    assert.strictEqual(renderer.getSelectedAgentKey(), 'live:rename-agent');
    assert.strictEqual(row.classList.contains('selected'), true);

    // Start renaming
    renderer.startRename('live:rename-agent');
    assert.strictEqual(renderer.getEditingSessionKey(), 'live:rename-agent');

    const input = row.querySelector('.rename-input');
    assert(input, 'Rename input element must be present in DOM');
    input.value = 'Changed Name';

    // Press Escape on the input
    input.dispatchEvent({ type: 'keydown', key: 'Escape' });

    // The edit MUST be cancelled
    assert.strictEqual(renderer.getEditingSessionKey(), null, 'Editing mode must be cancelled');
    assert.strictEqual(row.querySelector('.rename-input'), null, 'Rename input must be removed');
    const nameEl = row.querySelector('.session-name');
    assert.strictEqual(nameEl.textContent, 'Original Name', 'Original name must remain');

    // BUT agent MUST still be selected!
    assert.strictEqual(renderer.getSelectedAgentKey(), 'live:rename-agent', 'Agent must still be selected after first Esc');
    assert.strictEqual(row.classList.contains('selected'), true, 'Row must still have selected class');
  });

  testCase('Second Esc unselects the agent after edit was cancelled', () => {
    assert.strictEqual(renderer.getSelectedAgentKey(), 'live:rename-agent');
    assert.strictEqual(renderer.getEditingSessionKey(), null);

    // Press Escape again on window
    window.dispatchEvent({ type: 'keydown', key: 'Escape' });

    assert.strictEqual(renderer.getSelectedAgentKey(), null, 'Agent must now be unselected');
    assert.strictEqual(row.classList.contains('selected'), false);
    assert.strictEqual(historyPlaceholder.style.display, 'block');
  });

  testCase('Global Esc handler directly checks editingSessionKey if event reaches it', () => {
    // Select agent and start rename
    row.dispatchEvent({ type: 'click' });
    renderer.startRename('live:rename-agent');
    assert.strictEqual(renderer.getEditingSessionKey(), 'live:rename-agent');

    // Trigger handleKeyDown directly
    renderer.handleKeyDown({ key: 'Escape' });

    // Must cancel rename and preserve selection
    assert.strictEqual(renderer.getEditingSessionKey(), null);
    assert.strictEqual(renderer.getSelectedAgentKey(), 'live:rename-agent');

    // Next handleKeyDown unselects
    renderer.handleKeyDown({ key: 'Escape' });
    assert.strictEqual(renderer.getSelectedAgentKey(), null);
  });
}

// -------------------------------------------------------------
// Test Group 4: Clicking empty space in the list unselects it
// -------------------------------------------------------------
console.log('\n--- Test Group 4: Clicking Empty Space in List ---');
{
  renderer.resetState();
  const testData = {
    sessions: [
      {
        sessionKey: 'live:empty-agent',
        sessionId: 'sess-empty',
        displayName: 'Empty Test Agent',
        agent: 'agy',
        folder: 'proj-empty',
        duration: '30s',
        state: 'idle',
        isAsking: false
      }
    ]
  };
  renderer.render(testData);
  const row = container.querySelector('[data-session-key="live:empty-agent"]');

  testCase('Clicking empty space on container unselects agent', () => {
    // Select agent
    row.dispatchEvent({ type: 'click' });
    assert.strictEqual(renderer.getSelectedAgentKey(), 'live:empty-agent');
    assert.strictEqual(row.classList.contains('selected'), true);

    // Click container empty space
    container.dispatchEvent({ type: 'click' });

    assert.strictEqual(renderer.getSelectedAgentKey(), null, 'Agent must be unselected');
    assert.strictEqual(row.classList.contains('selected'), false);
    assert.strictEqual(historyPlaceholder.style.display, 'block');
  });

  testCase('Clicking on liveAgentsSection outside row unselects agent', () => {
    row.dispatchEvent({ type: 'click' });
    assert.strictEqual(renderer.getSelectedAgentKey(), 'live:empty-agent');

    liveAgentsSection.dispatchEvent({ type: 'click' });

    assert.strictEqual(renderer.getSelectedAgentKey(), null, 'Agent must be unselected');
    assert.strictEqual(row.classList.contains('selected'), false);
  });

  testCase('Clicking inside row does NOT trigger empty space unselection', () => {
    // Row is unselected, click inside row folder element
    const folderEl = row.querySelector('.session-folder');
    assert(folderEl, 'Folder element must exist in row');

    folderEl.dispatchEvent({ type: 'click' });

    // Must be selected, NOT unselected by container
    assert.strictEqual(renderer.getSelectedAgentKey(), 'live:empty-agent');
    assert.strictEqual(row.classList.contains('selected'), true);
  });
}

// -------------------------------------------------------------
// Test Group 5: Placeholder display when nothing is selected
// -------------------------------------------------------------
console.log('\n--- Test Group 5: Placeholder When Nothing Selected ---');
{
  renderer.resetState();

  testCase('Placeholder shown initially when nothing is selected', () => {
    renderer.render({ sessions: [] });
    assert.strictEqual(renderer.getSelectedAgentKey(), null);
    assert.strictEqual(historyPlaceholder.style.display, 'block');
    assert.strictEqual(historyPlaceholder.textContent, 'Select an agent to see its history');
    assert.strictEqual(historyHeader.style.display, 'none');
    assert.strictEqual(historyGroups.children.length, 0);
  });

  testCase('Placeholder restored after selecting then unselecting', () => {
    renderer.render({
      sessions: [
        {
          sessionKey: 'live:dummy',
          sessionId: 'sess-dummy',
          displayName: 'Dummy',
          agent: 'agy',
          folder: 'dummy',
          duration: '1s',
          state: 'idle',
          isAsking: false
        }
      ]
    });
    renderer.selectAgent('live:dummy');
    assert.strictEqual(renderer.getSelectedAgentKey(), 'live:dummy');

    renderer.unselectAgent();

    assert.strictEqual(renderer.getSelectedAgentKey(), null);
    assert.strictEqual(historyPlaceholder.style.display, 'block');
    assert.strictEqual(historyPlaceholder.textContent, 'Select an agent to see its history');
    assert.strictEqual(historyHeader.style.display, 'none');
    assert.strictEqual(historyGroups.children.length, 0);
  });
}

// -------------------------------------------------------------
// Test Group 6: 1-Second Refresh Stability
// -------------------------------------------------------------
console.log('\n--- Test Group 6: 1-Second Refresh Selection Stability ---');
{
  renderer.resetState();
  const cycle1 = {
    sessions: [
      {
        sessionKey: 'live:refresh-1',
        sessionId: 'sess-rf-1',
        displayName: 'Stable Worker 1',
        agent: 'agy',
        folder: 'folder-1',
        duration: '1s',
        state: 'idle',
        isAsking: false
      },
      {
        sessionKey: 'live:refresh-2',
        sessionId: 'sess-rf-2',
        displayName: 'Stable Worker 2',
        agent: 'agy',
        folder: 'folder-2',
        duration: '2s',
        state: 'busy',
        isAsking: false
      }
    ]
  };

  testCase('1-second refresh never re-selects an agent when nothing is selected', () => {
    renderer.render(cycle1);
    assert.strictEqual(renderer.getSelectedAgentKey(), null);

    // Simulate 5 periodic 1-second updates
    for (let i = 0; i < 5; i++) {
      const cycleN = {
        sessions: [
          { ...cycle1.sessions[0], duration: `${i + 2}s` },
          { ...cycle1.sessions[1], duration: `${i + 3}s` }
        ]
      };
      renderer.render(cycleN);
      assert.strictEqual(renderer.getSelectedAgentKey(), null, `Cycle ${i}: must never re-select an agent`);
      const r1 = container.querySelector('[data-session-key="live:refresh-1"]');
      const r2 = container.querySelector('[data-session-key="live:refresh-2"]');
      assert(!r1.classList.contains('selected'), `Cycle ${i}: r1 must not be selected`);
      assert(!r2.classList.contains('selected'), `Cycle ${i}: r2 must not be selected`);
      assert.strictEqual(historyPlaceholder.style.display, 'block', `Cycle ${i}: placeholder must be visible`);
      assert.strictEqual(historyPlaceholder.textContent, 'Select an agent to see its history');
    }
  });

  testCase('1-second refresh never loses selection when an agent is selected', () => {
    renderer.selectAgent('live:refresh-1');
    assert.strictEqual(renderer.getSelectedAgentKey(), 'live:refresh-1');

    // Simulate 5 periodic 1-second updates while agent is selected
    for (let i = 0; i < 5; i++) {
      const cycleN = {
        sessions: [
          { ...cycle1.sessions[0], duration: `${i + 10}s` },
          { ...cycle1.sessions[1], duration: `${i + 10}s` }
        ]
      };
      renderer.render(cycleN);
      assert.strictEqual(renderer.getSelectedAgentKey(), 'live:refresh-1', `Cycle ${i}: must preserve selectedAgentKey`);
      const r1 = container.querySelector('[data-session-key="live:refresh-1"]');
      const r2 = container.querySelector('[data-session-key="live:refresh-2"]');
      assert(r1.classList.contains('selected'), `Cycle ${i}: r1 must have selected class`);
      assert(!r2.classList.contains('selected'), `Cycle ${i}: r2 must not have selected class`);
    }
  });
}

// -------------------------------------------------------------
// Test Group 7: Session Length Running vs Unknown
// -------------------------------------------------------------
console.log('\n--- Test Group 7: Session Length Running vs Unknown ---');
{
  renderer.resetState();

  testCase('Active session with no ended event displays Session length: running', () => {
    const runningEvents = [
      {
        type: 'session_started',
        time: '2026-10-19T00:00:00Z',
        sessionId: 'sess-active-1',
        sessionKey: 'live:running-agent'
      },
      {
        type: 'prompt',
        time: '2026-10-19T00:01:00Z',
        sessionId: 'sess-active-1',
        sessionKey: 'live:running-agent',
        question: 'Run migration?',
        command: { spaced: 'npm run migrate' },
        options: [{ number: 1, text: 'Yes', classification: 'yes_once' }],
        decision: { action: 'needs_user' }
      }
    ];

    // groupHistoryBySession with activeSessionIds containing sessionKey
    const groups = renderer.groupHistoryBySession(runningEvents, new Set(['live:running-agent']));
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].sessionLength, 'running', 'Session that has not ended yet must have sessionLength: running');

    // Also verify rendered card output in renderHistory
    renderer.render({
      sessions: [
        {
          sessionKey: 'live:running-agent',
          sessionId: 'sess-active-1',
          displayName: 'Running Worker',
          agent: 'agy',
          folder: 'backend',
          state: 'idle',
          isAsking: false
        }
      ]
    });
    renderer.selectAgent('live:running-agent');
    renderer.renderHistory(runningEvents);

    const lengthEl = historyGroups.querySelector('.session-group-length');
    assert(lengthEl, 'session-group-length element must be rendered');
    assert.strictEqual(lengthEl.textContent, 'Session length: running', 'Must render "Session length: running"');
  });

  testCase('Abrupt process death from past (not active) still displays Session length: unknown', () => {
    const deadEvents = [
      {
        type: 'session_started',
        time: '2026-10-18T10:00:00Z',
        sessionId: 'sess-dead-1',
        sessionKey: 'past:dead-agent'
      }
    ];

    const groups = renderer.groupHistoryBySession(deadEvents, new Set());
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].sessionLength, 'unknown', 'Abrupt process death must have sessionLength: unknown');
    assert.strictEqual(groups[0].isEndedUnknown, true);
  });

  testCase('Clean ended session displays formatted duration', () => {
    const cleanEvents = [
      {
        type: 'session_started',
        time: '2026-10-18T10:00:00Z',
        sessionId: 'sess-clean-1',
        sessionKey: 'live:clean-agent'
      },
      {
        type: 'session_ended',
        time: '2026-10-18T11:12:00Z',
        sessionId: 'sess-clean-1',
        sessionKey: 'live:clean-agent',
        durationSeconds: 4320 // 1h 12m
      }
    ];

    const groups = renderer.groupHistoryBySession(cleanEvents, new Set(['live:clean-agent']));
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].sessionLength, '1h 12m', 'Clean exit must display formatted session length');
    assert.strictEqual(groups[0].isEndedUnknown, false);
  });
}

console.log(`\n=========================================`);
console.log(`All ${passCount} agentwatch GUI Unselect UX tests passed successfully! (${passCount}/${totalTests})`);
console.log(`=========================================\n`);
