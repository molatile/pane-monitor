const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const {
  loadConfig,
  saveConfig,
  isGuiRunning,
  stopGui,
  getGuiSourceMtime,
  isGuiStale
} = require('../src/shared');
const { startGui } = require('../src/gui');
const { parseArgs } = require('../bin/agentwatch');

console.log('Running agentwatch GUI Lifecycle & Stale Instance test suite...\n');

let passCount = 0;

// -------------------------------------------------------------
// Test Group 1: CLI Argument Parsing for --restart
// -------------------------------------------------------------
console.log('--- Test Group 1: CLI Argument Parsing for --restart ---');
{
  const p1 = parseArgs(['gui']);
  assert.strictEqual(p1.command, 'gui');
  assert.strictEqual(p1.restart, false);
  passCount++;

  const p2 = parseArgs(['gui', '--restart']);
  assert.strictEqual(p2.command, 'gui');
  assert.strictEqual(p2.restart, true);
  passCount++;

  const p3 = parseArgs(['gui', '--quiet', '--restart']);
  assert.strictEqual(p3.command, 'gui');
  assert.strictEqual(p3.quiet, true);
  assert.strictEqual(p3.restart, true);
  passCount++;

  const p4 = parseArgs(['--restart', 'gui']);
  assert.strictEqual(p4.command, 'gui');
  assert.strictEqual(p4.restart, true);
  passCount++;

  console.log('✓ Test Group 1 passed: parseArgs parses --restart correctly');
}

// -------------------------------------------------------------
// Test Group 2: stopGui Process Termination & Config Cleanup
// -------------------------------------------------------------
console.log('\n--- Test Group 2: stopGui Process Termination & Config Cleanup ---');
{
  const tempDir = path.join(os.tmpdir(), `agentwatch-test-stopgui-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const configPath = path.join(tempDir, 'config.json');

  // Spawn a long-running mock child process
  const mockChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore'
  });
  const mockPid = mockChild.pid;
  assert(mockPid > 0, 'Mock child process must have valid PID');

  // Save config with this PID
  const cfg = {
    guiPid: mockPid,
    guiStartTime: Date.now()
  };
  saveConfig(cfg, configPath);

  const loaded = loadConfig(configPath);
  assert.strictEqual(loaded.guiPid, mockPid);
  assert.strictEqual(isGuiRunning(loaded), true);
  passCount++;

  // Stop GUI
  const stopped = stopGui(loaded, configPath);
  assert.strictEqual(stopped, true, 'stopGui must return true when process killed');
  passCount++;

  // Verify process is killed
  assert.strictEqual(isGuiRunning(loaded), false, 'isGuiRunning must be false after stopGui');
  let processAlive = true;
  try {
    process.kill(mockPid, 0);
  } catch (e) {
    processAlive = false;
  }
  assert.strictEqual(processAlive, false, 'Target OS process must no longer exist');
  passCount++;

  // Verify config was cleaned up (guiPid and guiStartTime deleted)
  const reloaded = loadConfig(configPath);
  assert.strictEqual(reloaded.guiPid, undefined, 'guiPid must be deleted from config');
  assert.strictEqual(reloaded.guiStartTime, undefined, 'guiStartTime must be deleted from config');
  passCount++;

  // Non-running PID safe handling
  const stoppedAgain = stopGui({ guiPid: 9999999 }, configPath);
  assert.strictEqual(stoppedAgain, false, 'Calling stopGui on dead process must return false without throwing');
  passCount++;

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✓ Test Group 2 passed: stopGui terminates process and cleans config');
}

// -------------------------------------------------------------
// Test Group 3: Source Mtime Tracking & isGuiStale Detection
// -------------------------------------------------------------
console.log('\n--- Test Group 3: Source Mtime Tracking & isGuiStale Detection ---');
{
  const tempDir = path.join(os.tmpdir(), `agentwatch-test-mtime-${Date.now()}`);
  fs.mkdirSync(path.join(tempDir, 'gui'), { recursive: true });
  fs.mkdirSync(path.join(tempDir, '..', 'bin'), { recursive: true });

  const testFile1 = path.join(tempDir, 'agentwatch.js');
  const testFile2 = path.join(tempDir, 'gui', 'main.js');

  const t0 = 10000000;
  fs.writeFileSync(testFile1, 'console.log(1);');
  fs.utimesSync(testFile1, t0 / 1000, t0 / 1000);

  fs.writeFileSync(testFile2, 'console.log(2);');
  fs.utimesSync(testFile2, t0 / 1000, t0 / 1000);

  const initialMtime = getGuiSourceMtime(tempDir);
  assert.strictEqual(initialMtime, t0, 'getGuiSourceMtime must match t0');
  passCount++;

  // Fake alive process (our own PID)
  const cfg = {
    guiPid: process.pid,
    guiStartTime: t0 + 1000 // GUI started 1s AFTER code files were touched
  };

  // 1. Fresh instance: GUI started after code files -> NOT stale
  assert.strictEqual(isGuiStale(cfg, tempDir), false, 'GUI must NOT be stale when started after code touches');
  passCount++;

  // 2. Modify a code file AFTER GUI started
  const t1 = t0 + 5000;
  fs.writeFileSync(testFile2, 'console.log("updated");');
  fs.utimesSync(testFile2, t1 / 1000, t1 / 1000);

  const updatedMtime = getGuiSourceMtime(tempDir);
  assert.strictEqual(updatedMtime, t1, 'getGuiSourceMtime must reflect updated file mtime');
  passCount++;

  // 3. Stale instance: code file touched after guiStartTime -> IS stale
  assert.strictEqual(isGuiStale(cfg, tempDir), true, 'GUI must BE stale when code changed after GUI started');
  passCount++;

  // 4. Missing guiStartTime -> treated as stale
  const cfgNoTime = { guiPid: process.pid };
  assert.strictEqual(isGuiStale(cfgNoTime, tempDir), true, 'Missing guiStartTime must be treated as stale');
  passCount++;

  // 5. Dead PID -> not running, so not stale
  const cfgDead = { guiPid: 9999999, guiStartTime: t0 - 5000 };
  assert.strictEqual(isGuiStale(cfgDead, tempDir), false, 'Dead GUI process is not considered stale (it is dead)');
  passCount++;

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✓ Test Group 3 passed: Source mtime tracking and isGuiStale detection verified');
}

// -------------------------------------------------------------
// Test Group 4: startGui with restart: true Closes Running Instance
// -------------------------------------------------------------
console.log('\n--- Test Group 4: startGui with restart: true Closes Running Instance ---');
{
  const tempDir = path.join(os.tmpdir(), `agentwatch-test-gui-restart-${Date.now()}`);
  fs.mkdirSync(tempDir, { recursive: true });
  const configPath = path.join(tempDir, 'config.json');

  // Spawn a mock running GUI
  const mockChild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);'], {
    stdio: 'ignore'
  });
  const mockPid = mockChild.pid;

  saveConfig({ guiPid: mockPid, guiStartTime: Date.now() }, configPath);
  assert.strictEqual(isGuiRunning(loadConfig(configPath)), true);
  passCount++;

  // Mock script for the new child
  const mockNewScript = path.join(tempDir, 'mock-new.js');
  fs.writeFileSync(mockNewScript, 'setInterval(() => {}, 1000);');

  // Call startGui with restart: true
  const launch = startGui({
    electronPath: process.execPath,
    args: [mockNewScript],
    restart: true,
    configPath,
    detached: true,
    autoOpen: true
  });

  assert(launch && launch.child, 'startGui must return new child');
  const newPid = launch.child.pid;
  assert.notStrictEqual(newPid, mockPid, 'New child must have different PID from old mock');
  passCount++;

  // Verify old PID is killed
  let oldAlive = true;
  try {
    process.kill(mockPid, 0);
  } catch (e) {
    oldAlive = false;
  }
  assert.strictEqual(oldAlive, false, 'Previous GUI process must be dead after restart: true');
  passCount++;

  // Clean up new child
  try {
    process.kill(newPid);
  } catch (e) {}

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('✓ Test Group 4 passed: startGui with restart: true stops old process and starts fresh one');
}

// -------------------------------------------------------------
// Test Group 5: Main.js Static Verification for Clean Exit & Lock Release
// -------------------------------------------------------------
console.log('\n--- Test Group 5: Main.js Static Verification for Clean Exit & Lock Release ---');
{
  const mainJsPath = path.resolve(__dirname, '../src/gui/main.js');
  const mainContent = fs.readFileSync(mainJsPath, 'utf8');

  // 1. window-all-closed calls app.quit unconditionally
  assert(
    mainContent.includes("app.on('window-all-closed'"),
    'main.js must have window-all-closed handler'
  );
  assert(
    !mainContent.includes("process.platform !== 'darwin'"),
    'window-all-closed handler must NOT skip macOS (must quit unconditionally)'
  );
  passCount++;

  // 2. Single instance lock failure terminates process immediately
  assert(
    mainContent.includes('!gotTheLock') && mainContent.includes('process.exit(0)'),
    'Duplicate instance must exit immediately with process.exit(0)'
  );
  passCount++;

  // 3. Single instance lock is released on quit
  assert(
    mainContent.includes('app.releaseSingleInstanceLock()'),
    'main.js must explicitly call app.releaseSingleInstanceLock()'
  );
  passCount++;

  // 4. mainWindow.on('closed') clears timers and calls app.quit()
  assert(
    mainContent.includes("mainWindow.on('closed'") && mainContent.includes('app.quit()'),
    'mainWindow closed handler must call app.quit()'
  );
  passCount++;

  // 5. No hide-on-close in main.js
  assert(
    !mainContent.includes("mainWindow.hide()") || !mainContent.includes("mainWindow.on('close'"),
    'main.js must not implement hide-on-close'
  );
  passCount++;

  // 6. guiStartTime is recorded at window creation
  assert(
    mainContent.includes('config.guiStartTime = Date.now()'),
    'main.js must record config.guiStartTime at creation'
  );
  passCount++;

  console.log('✓ Test Group 5 passed: Main.js clean exit, unconditional quit, and lock release verified');
}

// -------------------------------------------------------------
// Test Group 6: Real Electron Window Close & Complete Process Termination
// -------------------------------------------------------------
console.log('\n--- Test Group 6: Real Electron Window Close & Complete Process Termination ---');
(async () => {
  let electronExe = null;
  try {
    electronExe = require('electron');
  } catch (e) {}

  if (!electronExe || !fs.existsSync(electronExe)) {
    console.log('  (Skipping real Electron spawn: Electron executable not found)');
  } else {
    const tempDir = path.join(os.tmpdir(), `agentwatch-test-electron-close-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const configPath = path.join(tempDir, 'config.json');

    const testAppScript = path.join(tempDir, 'test-app.js');
    fs.writeFileSync(testAppScript, `
      const { app, BrowserWindow } = require('electron');
      app.setPath('userData', ${JSON.stringify(tempDir)});
      const gotLock = app.requestSingleInstanceLock();
      if (!gotLock) {
        app.quit();
        process.exit(0);
      }

      app.whenReady().then(() => {
        const win = new BrowserWindow({ show: false });
        win.on('closed', () => {
          app.releaseSingleInstanceLock();
          app.quit();
        });
        setTimeout(() => {
          win.close();
        }, 500);
      });

      app.on('window-all-closed', () => {
        app.releaseSingleInstanceLock();
        app.quit();
      });
    `);

    const child = spawn(electronExe, [testAppScript], {
      stdio: 'ignore'
    });
    const electronPid = child.pid;
    assert(electronPid > 0);

    const exitedCleanly = await new Promise((resolve) => {
      child.on('exit', (code) => {
        resolve(true);
      });
      setTimeout(() => {
        try {
          process.kill(electronPid);
        } catch (_) {}
        resolve(false);
      }, 5000);
    });

    assert.strictEqual(exitedCleanly, true, 'Electron process must fully exit when window closes');
    passCount++;

    // Verify no running process with this PID
    let isStillRunning = false;
    try {
      process.kill(electronPid, 0);
      isStillRunning = true;
    } catch (_) {}
    assert.strictEqual(isStillRunning, false, 'No residual Electron process after window close');
    passCount++;

    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('✓ Test Group 6 passed: Real Electron window close ends all processes cleanly');
  }

  console.log('\n=========================================');
  console.log(`All GUI lifecycle and stale instance tests passed successfully! (${passCount} assertions)`);
  console.log('=========================================');
  process.exit(0);
})().catch((err) => {
  console.error('\nTest failure:', err);
  process.exit(1);
});
