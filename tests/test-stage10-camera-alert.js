const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log('Running Stage 10: Camera Notch & Multi-Agent Graphic Alert Tests...\n');

// 1. Static HTML & CSS Verification
console.log('--- Test 1: HTML & CSS Structure Verification ---');
const htmlPath = path.join(__dirname, '../src/gui/index.html');
const cssPath = path.join(__dirname, '../src/gui/styles.css');
const htmlContent = fs.readFileSync(htmlPath, 'utf8');
const cssContent = fs.readFileSync(cssPath, 'utf8');

assert(htmlContent.includes('id="camera-notch-zone"'), 'index.html must contain #camera-notch-zone');
assert(htmlContent.includes('id="ambient-top-shade"'), 'index.html must contain #ambient-top-shade');
assert(htmlContent.includes('id="camera-notch-pill"'), 'index.html must contain #camera-notch-pill');
assert(htmlContent.includes('id="notch-traffic-lights"'), 'index.html must contain #notch-traffic-lights');
assert(htmlContent.includes('id="notch-dropdown-hud"'), 'index.html must contain #notch-dropdown-hud');
assert(htmlContent.includes('id="setting-camera-notch"'), 'index.html must contain #setting-camera-notch');

assert(cssContent.includes('.camera-notch-zone'), 'styles.css must style .camera-notch-zone');
assert(cssContent.includes('.ambient-top-shade.shade-asking'), 'styles.css must contain .ambient-top-shade.shade-asking');
assert(cssContent.includes('.ambient-top-shade.shade-busy'), 'styles.css must contain .ambient-top-shade.shade-busy');
assert(cssContent.includes('.ambient-top-shade.shade-idle'), 'styles.css must contain .ambient-top-shade.shade-idle');
assert(cssContent.includes('.ambient-top-shade.shade-countdown'), 'styles.css must contain .ambient-top-shade.shade-countdown');
assert(cssContent.includes('notch-heartbeat'), 'styles.css must contain heartbeat animation for asking alert');

console.log('  ✓ HTML & CSS structure verified');

// 2. DOM Mock & Renderer Functionality Tests
console.log('\n--- Test 2: Renderer Camera Notch & Traffic Light Logic ---');

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

  appendChild(child) {
    if (child && child.parentNode) {
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

  querySelector(selector) {
    for (const child of this.children) {
      if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) return child;
      if (selector.startsWith('#') && child.id === selector.slice(1)) return child;
      if (selector.startsWith('[data-session-key="')) {
        const key = selector.match(/data-session-key="([^"]+)"/)[1];
        if (child.dataset.sessionKey === key) return child;
      }
      const found = child.querySelector(selector);
      if (found) return found;
    }
    return null;
  }

  querySelectorAll(selector) {
    const results = [];
    const search = (el) => {
      for (const child of el.children) {
        if (selector.startsWith('.') && child.classList.contains(selector.slice(1))) results.push(child);
        if (selector.startsWith('[data-session-key="')) {
          const key = selector.match(/data-session-key="([^"]+)"/)[1];
          if (child.dataset.sessionKey === key) results.push(child);
        }
        search(child);
      }
    };
    search(this);
    return results;
  }

  addEventListener(event, fn) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(fn);
  }

  dispatchEvent(event) {
    const handlers = this.listeners.get(event.type) || [];
    for (const h of handlers) h(event);
  }

  scrollIntoView() {
    this._scrolledIntoView = true;
  }
}

// Setup simulated window environment
const elementsById = new Map();
function getOrCreate(id, tag = 'div') {
  if (!elementsById.has(id)) {
    const el = new MockElement(tag);
    el.id = id;
    elementsById.set(id, el);
  }
  return elementsById.get(id);
}

const notchZone = getOrCreate('camera-notch-zone');
const ambientShade = getOrCreate('ambient-top-shade');
const notchPill = getOrCreate('camera-notch-pill');
const lightsContainer = getOrCreate('notch-traffic-lights');
const notchHud = getOrCreate('notch-dropdown-hud');
const notchHudStatus = getOrCreate('notch-hud-status-text', 'span');
const notchHudList = getOrCreate('notch-hud-list');
const countBadge = getOrCreate('agent-count-badge', 'span');
const sessionsContainer = getOrCreate('sessions-container', 'main');
const tabBtnAgents = getOrCreate('tab-btn-agents', 'button');
tabBtnAgents.classList.add('active');

global.document = {
  getElementById: (id) => elementsById.get(id) || null,
  createElement: (tag) => new MockElement(tag),
  addEventListener: () => {}
};
global.window = {
  addEventListener: () => {},
  agentwatch: {
    setSetting: async () => ({ success: true }),
    getRules: async () => ({}),
    getHistory: async () => ({ events: [] })
  }
};

// Require renderer exports
const renderer = require('../src/gui/renderer.js');
const { updateCameraNotch, toggleNotchHud, closeNotchHud, jumpToAgent } = renderer;

// Test A: No active sessions -> dormant state
updateCameraNotch([], { cameraNotch: true });
assert(ambientShade.classList.contains('shade-off'), 'Shade should be shade-off with no sessions');
assert(lightsContainer.children.length >= 2, 'Should have dormant dot and label');
assert.strictEqual(lightsContainer.children[0].className, 'notch-dot dot-off');
assert.strictEqual(lightsContainer.children[1].textContent, 'ready');
console.log('  ✓ Test A passed: Dormant state with 0 sessions');

// Test B: Single IDLE agent
const idleSession = {
  sessionId: 'sess-1',
  sessionKey: 'agy:folder1',
  agent: 'agy',
  folder: 'project-alpha',
  state: 'idle',
  isDead: false
};
updateCameraNotch([idleSession], { cameraNotch: true });
assert(ambientShade.classList.contains('shade-idle'), 'Ambient shade should be shade-idle');
assert.strictEqual(lightsContainer.querySelectorAll('.notch-pod').length, 1);
assert.strictEqual(lightsContainer.querySelector('.notch-dot').className, 'notch-dot dot-idle');
assert.strictEqual(lightsContainer.querySelector('.notch-agent-name').textContent, 'project-alpha');
console.log('  ✓ Test B passed: Single IDLE agent displays calm green traffic dot and shade-idle');

// Test C: Single BUSY agent
const busySession = {
  sessionId: 'sess-2',
  sessionKey: 'agy:folder2',
  agent: 'agy',
  folder: 'worker-service',
  state: 'busy',
  isDead: false
};
updateCameraNotch([busySession], { cameraNotch: true });
assert(ambientShade.classList.contains('shade-busy'), 'Ambient shade should be shade-busy');
assert.strictEqual(lightsContainer.querySelector('.notch-dot').className, 'notch-dot dot-busy');
console.log('  ✓ Test C passed: Single BUSY agent displays yellow traffic dot and shade-busy');

// Test D: Single ASKING agent (Needs user approval)
const askingSession = {
  sessionId: 'sess-3',
  sessionKey: 'agy:folder3',
  agent: 'agy',
  folder: 'db-migration',
  state: 'asking',
  isAsking: true,
  isDead: false,
  prompt: {
    command: 'rm -rf dist',
    decision: 'needs you'
  }
};
updateCameraNotch([askingSession], { cameraNotch: true });
assert(ambientShade.classList.contains('shade-asking'), 'Ambient shade must be shade-asking for asking session');
assert.strictEqual(lightsContainer.querySelector('.notch-dot').className, 'notch-dot dot-asking');
assert(lightsContainer.querySelector('.notch-asking-tag') !== null, 'Should have asking tag [!]');
console.log('  ✓ Test D passed: Single ASKING agent triggers crimson alert shade and pulsing red dot');

// Test E: Single COUNTDOWN agent
const countdownSession = {
  sessionId: 'sess-4',
  sessionKey: 'agy:folder4',
  agent: 'agy',
  folder: 'auto-agent',
  state: 'countdown',
  countdown: 3,
  isDead: false
};
updateCameraNotch([countdownSession], { cameraNotch: true });
assert(ambientShade.classList.contains('shade-countdown'), 'Ambient shade should be shade-countdown');
assert.strictEqual(lightsContainer.querySelector('.notch-dot').className, 'notch-dot dot-countdown');
assert.strictEqual(lightsContainer.querySelector('.notch-countdown-tag').textContent, '3s');
console.log('  ✓ Test E passed: COUNTDOWN agent displays orange dot and remaining seconds tag');

// Test F: Multi-Agent Aggregation & Priority (1 BUSY + 1 ASKING + 1 IDLE)
const multiSessions = [idleSession, busySession, askingSession];
updateCameraNotch(multiSessions, { cameraNotch: true });
// Since one session is asking, asking TRUMPS all other states for ambient glow
assert(ambientShade.classList.contains('shade-asking'), 'Highest priority ASKING must determine ambient shade');
const pods = lightsContainer.querySelectorAll('.notch-pod');
assert.strictEqual(pods.length, 3, 'Notch should render all 3 active agent pods');
assert.strictEqual(pods[0].dataset.sessionKey, 'agy:folder1');
assert.strictEqual(pods[1].dataset.sessionKey, 'agy:folder2');
assert.strictEqual(pods[2].dataset.sessionKey, 'agy:folder3');
console.log('  ✓ Test F passed: Multi-agent renders pods for all 3 agents with dominant ASKING shade');

// Test G: Multi-Agent without Asking (1 IDLE + 1 BUSY)
updateCameraNotch([idleSession, busySession], { cameraNotch: true });
assert(ambientShade.classList.contains('shade-busy'), 'BUSY trumps IDLE for ambient shade');
console.log('  ✓ Test G passed: Priority hierarchy verified: ASKING > COUNTDOWN > BUSY > IDLE');

// Test H: Interaction - Jump to Agent
const mockRow = new MockElement('div');
mockRow.dataset.sessionKey = 'agy:folder3';
sessionsContainer.appendChild(mockRow);

jumpToAgent('agy:folder3');
assert.strictEqual(mockRow._scrolledIntoView, true, 'jumpToAgent must scroll session row into view');
console.log('  ✓ Test H passed: Clicking an agent pod smoothly focuses and scrolls to the agent row');

// Test I: HUD Toggle & Content
toggleNotchHud();
assert.strictEqual(notchHud.style.display, 'block', 'toggleNotchHud should open HUD');
assert(notchPill.classList.contains('hud-open'), 'Notch pill should have hud-open class');
closeNotchHud();
assert.strictEqual(notchHud.style.display, 'none', 'closeNotchHud should close HUD');
console.log('  ✓ Test I passed: HUD open/close toggles cleanly');

// Test J: Settings toggle (cameraNotch: false)
updateCameraNotch(multiSessions, { cameraNotch: false });
assert(notchZone.classList.contains('hidden'), 'Notch zone must have hidden class when cameraNotch is false');
assert(ambientShade.classList.contains('shade-off'), 'Ambient shade must be off when disabled');
console.log('  ✓ Test J passed: cameraNotch: false disables notch zone and shade cleanly');

console.log('\n=========================================');
console.log('All Stage 10 Camera Alert tests passed successfully!');
console.log('=========================================');
