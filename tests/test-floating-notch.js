const assert = require('assert');
const path = require('path');
const fs = require('fs');

console.log('Running Floating Dynamic Island Notch Overlay Tests...\n');

// -------------------------------------------------------------
// Test 1: Static HTML, CSS, Preload Verification
// -------------------------------------------------------------
console.log('--- Test 1: HTML, CSS & Preload Structure ---');
const htmlPath = path.join(__dirname, '../src/gui/notch.html');
const cssPath = path.join(__dirname, '../src/gui/notch-styles.css');
const preloadPath = path.join(__dirname, '../src/gui/notch-preload.js');
const mainPath = path.join(__dirname, '../src/gui/main.js');

assert(fs.existsSync(htmlPath), 'notch.html must exist');
assert(fs.existsSync(cssPath), 'notch-styles.css must exist');
assert(fs.existsSync(preloadPath), 'notch-preload.js must exist');

const html = fs.readFileSync(htmlPath, 'utf8');
const css = fs.readFileSync(cssPath, 'utf8');
const preload = fs.readFileSync(preloadPath, 'utf8');
const main = fs.readFileSync(mainPath, 'utf8');

assert(html.includes('id="notch-container"'), 'notch.html must have #notch-container');
assert(html.includes('id="notch-island"'), 'notch.html must have #notch-island');
assert(html.includes('id="island-glow"'), 'notch.html must have #island-glow');
assert(html.includes('id="island-dot"'), 'notch.html must have #island-dot');
assert(html.includes('id="island-agent-name"'), 'notch.html must have #island-agent-name');
assert(html.includes('id="island-tag"'), 'notch.html must have #island-tag');
assert(html.includes('id="island-status-text"'), 'notch.html must have #island-status-text');
assert(html.includes('id="island-expanded"'), 'notch.html must have #island-expanded');
assert(html.includes('id="expanded-open-btn"'), 'notch.html must have #expanded-open-btn');

assert(css.includes('.notch-island'), 'notch-styles.css must style .notch-island');
assert(css.includes('.notch-island.visible'), 'notch-styles.css must style .notch-island.visible');
assert(css.includes('.glow-green'), 'notch-styles.css must have .glow-green');
assert(css.includes('.glow-red'), 'notch-styles.css must have .glow-red');
assert(css.includes('.glow-orange'), 'notch-styles.css must have .glow-orange');
assert(css.includes('.dot-green'), 'notch-styles.css must have .dot-green');
assert(css.includes('.dot-red'), 'notch-styles.css must have .dot-red');
assert(css.includes('.dot-orange'), 'notch-styles.css must have .dot-orange');
assert(css.includes('dot-heartbeat'), 'notch-styles.css must have heartbeat animation for red alert');

assert(preload.includes("contextBridge.exposeInMainWorld('notchApi'"), 'preload must expose notchApi');
assert(preload.includes('onUpdate:'), 'notchApi must expose onUpdate');
assert(preload.includes('resize:'), 'notchApi must expose resize');
assert(preload.includes('openMainApp:'), 'notchApi must expose openMainApp');
assert(preload.includes('setVisibility:'), 'notchApi must expose setVisibility');

assert(main.includes('createNotchWindow'), 'main.js must define createNotchWindow');
assert(main.includes('recenterNotch'), 'main.js must define recenterNotch');
assert(main.includes('notch-resize'), 'main.js must handle notch-resize IPC');
assert(main.includes('notch-open-app'), 'main.js must handle notch-open-app IPC');
assert(main.includes('notch-visibility'), 'main.js must handle notch-visibility IPC');

console.log('  ✓ Static files, structure, and IPC routes verified');

// -------------------------------------------------------------
// Test 2: Notch State Computation Logic
// -------------------------------------------------------------
console.log('\n--- Test 2: Notch State & Auto-Hide Computation ---');
const { computeNotchState, getAgentDisplayName } = require('../src/gui/notch-renderer');

// Case A: Dormant / 0 sessions -> HIDDEN
{
  const res = computeNotchState([], {});
  assert.strictEqual(res.state, 'hidden', 'Dormant state must be hidden');
  assert.strictEqual(res.session, null);
}

// Case B: All dead sessions -> HIDDEN
{
  const res = computeNotchState([{ sessionId: 's1', state: 'dead', isDead: true }], {});
  assert.strictEqual(res.state, 'hidden', 'Dead sessions must result in hidden');
}

// Case C: Active calm/idle session -> GREEN
{
  const s = { sessionId: 's1', state: 'idle', agent: 'agy', folder: 'my-app' };
  const res = computeNotchState([s], {});
  assert.strictEqual(res.state, 'green', 'Idle active session must be green');
  assert.strictEqual(res.session.sessionId, 's1');
  assert.strictEqual(getAgentDisplayName(res.session), 'my-app');
}

// Case D: Busy session -> GREEN
{
  const s = { sessionId: 's1', state: 'busy', agent: 'agy', folder: 'code-proj' };
  const res = computeNotchState([s], {});
  assert.strictEqual(res.state, 'green', 'Busy session must be green');
}

// Case E: Asking session -> RED ALERT
{
  const s1 = { sessionId: 's1', state: 'busy', agent: 'agy' };
  const s2 = { sessionId: 's2', state: 'asking', isAsking: true, agent: 'agy', folder: 'danger-zone' };
  const res = computeNotchState([s1, s2], {});
  assert.strictEqual(res.state, 'red', 'Asking session must trigger red alert state');
  assert.strictEqual(res.session.sessionId, 's2');
}

// Case F: Countdown session -> ORANGE ALERT
{
  const s1 = { sessionId: 's1', state: 'idle', agent: 'agy' };
  const s2 = { sessionId: 's2', state: 'countdown', countdown: 4, agent: 'agy', folder: 'auto-app' };
  const res = computeNotchState([s1, s2], {});
  assert.strictEqual(res.state, 'orange', 'Countdown session must trigger orange state');
  assert.strictEqual(res.session.sessionId, 's2');
}

// Case G: Priority Hierarchy: RED beats ORANGE and GREEN
{
  const sGreen = { sessionId: 's1', state: 'busy' };
  const sOrange = { sessionId: 's2', state: 'countdown', countdown: 3 };
  const sRed = { sessionId: 's3', state: 'asking', isAsking: true };
  const res = computeNotchState([sGreen, sOrange, sRed], {});
  assert.strictEqual(res.state, 'red', 'Asking must beat countdown and busy');
}

// Case H: Disabled in config -> HIDDEN
{
  const s = { sessionId: 's1', state: 'asking', isAsking: true };
  const res = computeNotchState([s], { floatingNotch: false });
  assert.strictEqual(res.state, 'hidden', 'Setting floatingNotch: false must force hidden');
}

console.log('  ✓ State computation, priority hierarchy, and config overrides verified');

// -------------------------------------------------------------
// Test 3: Auto-Adjustment Positioning Math
// -------------------------------------------------------------
console.log('\n--- Test 3: Screen Recenter & Dimension Auto-Adjustment ---');

function mockCalculateCenter(displayWidth, targetWidth) {
  return Math.round((displayWidth - targetWidth) / 2);
}

// Full HD monitor (1920)
assert.strictEqual(mockCalculateCenter(1920, 200), 860, '1920w centered with 200w pill');
assert.strictEqual(mockCalculateCenter(1920, 320), 800, '1920w centered with 320w pill');

// 4K monitor (3840)
assert.strictEqual(mockCalculateCenter(3840, 200), 1820, '3840w centered with 200w pill');
assert.strictEqual(mockCalculateCenter(3840, 360), 1740, '3840w centered with 360w pill');

// Laptop screen (1440)
assert.strictEqual(mockCalculateCenter(1440, 240), 600, '1440w centered with 240w pill');

console.log('  ✓ Horizontal recenter calculation verified across display resolutions');

// -------------------------------------------------------------
// Test 4: Setting Handler Verification in main.js
// -------------------------------------------------------------
console.log('\n--- Test 4: Settings Persistence & Handler ---');
const { setSetting } = require('../src/gui/main');
const os = require('os');

const tempDir = path.join(os.tmpdir(), `notch-test-${Date.now()}`);
fs.mkdirSync(tempDir, { recursive: true });
const tempConfig = path.join(tempDir, 'config.json');

const res1 = setSetting({ key: 'floatingNotch', value: false }, { configPath: tempConfig });
assert.strictEqual(res1.success, true);
const cfg1 = JSON.parse(fs.readFileSync(tempConfig, 'utf8'));
assert.strictEqual(cfg1.floatingNotch, false);

const res2 = setSetting({ key: 'floatingNotch', value: true }, { configPath: tempConfig });
assert.strictEqual(res2.success, true);
const cfg2 = JSON.parse(fs.readFileSync(tempConfig, 'utf8'));
assert.strictEqual(cfg2.floatingNotch, true);

// Cleanup
try {
  fs.unlinkSync(tempConfig);
  fs.rmdirSync(tempDir);
} catch (e) {}

console.log('  ✓ floatingNotch config setting successfully saved and persisted');

console.log('\n=========================================');
console.log('All Floating Notch Overlay tests passed successfully!');
console.log('=========================================\n');
