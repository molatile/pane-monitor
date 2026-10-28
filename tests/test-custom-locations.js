const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { EventEmitter } = require('events');
const { parseArgs } = require('../bin/agentwatch');
const { startAgentwatch, logPromptRecord } = require('../src/agentwatch');
const { loadConfig, saveConfig, setLogDir, validateLogDir, getDashboardData } = require('../src/shared');
const { getProfileForCommand } = require('../src/profile');
const { setSetting, pickLogFolder } = require('../src/gui/main');

function createTempDir(prefix = 'aw-loc-test-') {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runTests() {
  console.log('Running Custom Locations (Logs & Snapshots) Test Suite...\n');

  // =========================================================================
  // Test Group 1: CLI Argument Parsing for Custom Log/Snapshot Locations
  // =========================================================================
  console.log('--- Test Group 1: CLI Argument Parsing ---');
  {
    const p1 = parseArgs(['--log-dir', 'D:\\custom\\logs', 'agy']);
    assert.strictEqual(p1.command, 'agy');
    assert.strictEqual(p1.logDir, 'D:\\custom\\logs');
    assert.deepStrictEqual(p1.commandArgs, []);

    const p2 = parseArgs(['--output-dir=/var/log/agentwatch', 'dash']);
    assert.strictEqual(p2.command, 'dash');
    assert.strictEqual(p2.logDir, '/var/log/agentwatch');

    const p3 = parseArgs(['agy', 'task1', '--snapshots', 'D:\\snaps\\screen.txt', '--prompts-log', 'D:\\logs\\prompt.log']);
    assert.strictEqual(p3.command, 'agy');
    assert.deepStrictEqual(p3.commandArgs, ['task1']);
    assert.strictEqual(p3.snapshotsPath, 'D:\\snaps\\screen.txt');
    assert.strictEqual(p3.promptsLogPath, 'D:\\logs\\prompt.log');

    const p4 = parseArgs(['--record', '--raw-session=./rec/session.bin', 'cmd.exe']);
    assert.strictEqual(p4.record, true);
    assert.strictEqual(p4.rawSessionPath, './rec/session.bin');
    assert.strictEqual(p4.command, 'cmd.exe');

    console.log('  ✓ CLI argument parsing correctly extracts custom locations (--log-dir, --output-dir, --snapshots, --prompts-log, --raw-session)');
  }

  // =========================================================================
  // Test Group 2: startAgentwatch with options.logDir
  // =========================================================================
  console.log('\n--- Test Group 2: startAgentwatch with options.logDir ---');
  {
    const tempWorkDir = createTempDir('aw-work-dir-');
    const tempLogDir = path.join(createTempDir('aw-logs-dir-'), 'nested', 'logs'); // Non-existent nested dir

    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};

    const monitor = startAgentwatch({
      command: 'agy',
      cwd: tempWorkDir,
      logDir: tempLogDir,
      stdin: stdinMock,
      stdout: { columns: 80, rows: 24, write: () => {}, on: () => {} },
      ptyProcess: { write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {} },
      profile: getProfileForCommand('agy')
    });

    assert.strictEqual(monitor.getPromptsLogPath(), path.join(tempLogDir, 'prompts.log'));
    assert.strictEqual(monitor.getSnapshotsPath(), path.join(tempLogDir, 'screen-snapshots.txt'));

    // Trigger snapshot save
    monitor.saveScreenSnapshot();

    // Verify snapshot file exists in tempLogDir, NOT in tempWorkDir
    assert(fs.existsSync(path.join(tempLogDir, 'screen-snapshots.txt')), 'screen-snapshots.txt must exist in custom logDir');
    assert(!fs.existsSync(path.join(tempWorkDir, 'screen-snapshots.txt')), 'screen-snapshots.txt must NOT exist in working dir');

    monitor.cleanup();
    fs.rmSync(tempWorkDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(tempLogDir), { recursive: true, force: true });
    console.log('  ✓ Files saved to options.logDir and working directory remains clean');
  }

  // =========================================================================
  // Test Group 3: Environment Variables AGENTWATCH_LOG_DIR & AGENTWATCH_PROMPTS_LOG
  // =========================================================================
  console.log('\n--- Test Group 3: Environment Variables ---');
  {
    const tempWorkDir = createTempDir('aw-work-dir-');
    const tempLogDir = createTempDir('aw-env-logs-');
    const customSnapPath = path.join(createTempDir('aw-env-snaps-'), 'custom-screen.txt');

    process.env.AGENTWATCH_LOG_DIR = tempLogDir;
    process.env.AGENTWATCH_SNAPSHOTS_PATH = customSnapPath;

    try {
      const stdinMock = new EventEmitter();
      stdinMock.isTTY = true;
      stdinMock.setRawMode = () => {};

      const monitor = startAgentwatch({
        command: 'agy',
        cwd: tempWorkDir,
        stdin: stdinMock,
        stdout: { columns: 80, rows: 24, write: () => {}, on: () => {} },
        ptyProcess: { write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {} },
        profile: getProfileForCommand('agy')
      });

      assert.strictEqual(monitor.getPromptsLogPath(), path.join(tempLogDir, 'prompts.log'));
      assert.strictEqual(monitor.getSnapshotsPath(), customSnapPath);

      monitor.cleanup();
      console.log('  ✓ AGENTWATCH_LOG_DIR and AGENTWATCH_SNAPSHOTS_PATH environment variables honored');
    } finally {
      delete process.env.AGENTWATCH_LOG_DIR;
      delete process.env.AGENTWATCH_SNAPSHOTS_PATH;
      fs.rmSync(tempWorkDir, { recursive: true, force: true });
      fs.rmSync(tempLogDir, { recursive: true, force: true });
      fs.rmSync(path.dirname(customSnapPath), { recursive: true, force: true });
    }
  }

  // =========================================================================
  // Test Group 4: config.json logDir persistence & setLogDir helper
  // =========================================================================
  console.log('\n--- Test Group 4: Configuration Persistence ---');
  {
    const tempDir = createTempDir('aw-cfg-');
    const configPath = path.join(tempDir, 'config.json');

    const cfg = loadConfig(configPath);
    setLogDir(cfg, 'D:\\agent-logs', configPath);

    const reloaded = loadConfig(configPath);
    assert.strictEqual(reloaded.logDir, 'D:\\agent-logs');

    // Run startAgentwatch using this config
    const tempWorkDir = createTempDir('aw-work-');
    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};

    const monitor = startAgentwatch({
      command: 'agy',
      cwd: tempWorkDir,
      configPath,
      stdin: stdinMock,
      stdout: { columns: 80, rows: 24, write: () => {}, on: () => {} },
      ptyProcess: { write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {} },
      profile: getProfileForCommand('agy')
    });

    assert.strictEqual(monitor.getPromptsLogPath(), path.resolve('D:\\agent-logs', 'prompts.log'));
    monitor.cleanup();

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(tempWorkDir, { recursive: true, force: true });
    console.log('  ✓ config.json logDir and setLogDir helper successfully persist and apply');
  }

  // =========================================================================
  // Test Group 5: logPromptRecord with custom logDir
  // =========================================================================
  console.log('\n--- Test Group 5: logPromptRecord with custom logDir ---');
  {
    const tempLogDir = createTempDir('aw-logprompt-');
    const detected = {
      command: 'git status',
      question: 'Run this command?',
      options: [{ key: '1', text: 'Yes, run' }]
    };
    const decision = { action: 'would_approve', log: 'Approved test' };

    logPromptRecord(detected, decision, {
      logDir: tempLogDir
    });

    const targetPromptsLog = path.join(tempLogDir, 'prompts.log');
    assert(fs.existsSync(targetPromptsLog), 'prompts.log must exist in custom logDir');
    const content = fs.readFileSync(targetPromptsLog, 'utf8');
    assert(content.includes('git status'));
    assert(content.includes('Run this command?'));

    fs.rmSync(tempLogDir, { recursive: true, force: true });
    console.log('  ✓ logPromptRecord writes correctly to custom logDir');
  }

  // =========================================================================
  // Test Group 6: Native Folder Picker Result Saved Correctly
  // =========================================================================
  console.log('\n--- Test Group 6: Native Picker Result Saved Correctly ---');
  {
    const tempDir = createTempDir('aw-picker-cfg-');
    const configPath = path.join(tempDir, 'config.json');
    const targetFolder = createTempDir('aw-picker-target-');

    // 1. Mock native picker returning targetFolder
    const mockDialog = {
      showOpenDialog: async () => ({
        canceled: false,
        filePaths: [targetFolder]
      })
    };

    const res = await pickLogFolder({ dialog: mockDialog, configPath });
    assert.strictEqual(res.success, true, 'pickLogFolder must return success: true');
    assert.strictEqual(res.logDir, targetFolder, 'pickLogFolder must return chosen logDir');

    const reloaded = loadConfig(configPath);
    assert.strictEqual(reloaded.logDir, targetFolder, 'Config must persist the chosen logDir');

    // 2. Mock picker cancellation leaves config unchanged
    const mockCancelDialog = {
      showOpenDialog: async () => ({
        canceled: true,
        filePaths: []
      })
    };
    const resCancel = await pickLogFolder({ dialog: mockCancelDialog, configPath });
    assert.strictEqual(resCancel.canceled, true, 'Cancellation must be reported');
    assert.strictEqual(loadConfig(configPath).logDir, targetFolder, 'LogDir must remain unchanged on cancel');

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(targetFolder, { recursive: true, force: true });
    console.log('  ✓ Native picker result is saved correctly and cancellation is handled');
  }

  // =========================================================================
  // Test Group 7: Typed or Renderer-Supplied Paths Rejected
  // =========================================================================
  console.log('\n--- Test Group 7: Typed or Renderer-Supplied Paths Rejected ---');
  {
    const tempDir = createTempDir('aw-typed-cfg-');
    const configPath = path.join(tempDir, 'config.json');
    const directPath = createTempDir('aw-direct-path-');

    // Attempt direct save via setSetting without fromPicker flag (simulating typed or renderer-supplied path)
    const directRes = setSetting({ key: 'logDir', value: directPath }, { configPath });
    assert.strictEqual(directRes.success, false, 'Typed / renderer-supplied paths must be rejected');
    assert(directRes.error && directRes.error.includes('rejected'), 'Clear rejection error message must be returned');

    // Verify config file was NOT modified with the typed path
    const reloaded = loadConfig(configPath);
    assert.notStrictEqual(reloaded.logDir, directPath, 'Config must not save typed path');

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(directPath, { recursive: true, force: true });
    console.log('  ✓ Typed or renderer-supplied paths are rejected');
  }

  // =========================================================================
  // Test Group 8: Invalid, Unwritable and System Folders Rejected
  // =========================================================================
  console.log('\n--- Test Group 8: Invalid, Unwritable and System Folders Rejected ---');
  {
    const tempDir = createTempDir('aw-invalid-cfg-');
    const configPath = path.join(tempDir, 'config.json');

    // 8.1 Relative path rejected
    const relRes = await pickLogFolder({
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['relative/subfolder'] }) },
      configPath
    });
    assert.strictEqual(relRes.success, false, 'Relative path must be rejected');
    assert(relRes.error.includes('absolute'), 'Error must specify path must be absolute');

    // 8.2 Drive root rejected
    const driveRoot = process.platform === 'win32' ? 'C:\\' : '/';
    const rootRes = await pickLogFolder({
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [driveRoot] }) },
      configPath
    });
    assert.strictEqual(rootRes.success, false, 'Drive root must be rejected');
    assert(rootRes.error.includes('Drive roots'), 'Error must identify drive root');

    // 8.3 Windows system folder rejected
    const sysDrive = process.env.SystemDrive || 'C:';
    const winFolder = `${sysDrive}\\Windows`;
    const winRes = await pickLogFolder({
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [winFolder] }) },
      configPath
    });
    assert.strictEqual(winRes.success, false, 'Windows folder must be rejected');

    // 8.4 System32 folder rejected
    const sys32Folder = `${sysDrive}\\Windows\\System32`;
    const sys32Res = await pickLogFolder({
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [sys32Folder] }) },
      configPath
    });
    assert.strictEqual(sys32Res.success, false, 'System32 folder must be rejected');

    // 8.5 Program Files rejected
    const progFilesFolder = `${sysDrive}\\Program Files`;
    const progRes = await pickLogFolder({
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [progFilesFolder] }) },
      configPath
    });
    assert.strictEqual(progRes.success, false, 'Program Files folder must be rejected');

    // 8.6 Non-creatable invalid path rejected
    const badPath = process.platform === 'win32' ? 'Z:\\invalid\\<?*>\\dir' : '/proc/invalid/test/dir';
    const badRes = await pickLogFolder({
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [badPath] }) },
      configPath
    });
    assert.strictEqual(badRes.success, false, 'Uncreatable path must be rejected');

    // 8.7 Direct validation testing on unwritable / system folders
    const valSys32 = validateLogDir('C:\\Windows\\System32');
    assert.strictEqual(valSys32.valid, false, 'validateLogDir must reject System32');
    const valWin = validateLogDir('C:\\Windows');
    assert.strictEqual(valWin.valid, false, 'validateLogDir must reject Windows');
    const valProg = validateLogDir('C:\\Program Files');
    assert.strictEqual(valProg.valid, false, 'validateLogDir must reject Program Files');
    const valRoot = validateLogDir('C:\\');
    assert.strictEqual(valRoot.valid, false, 'validateLogDir must reject drive root');
    const valRel = validateLogDir('relative/logs');
    assert.strictEqual(valRel.valid, false, 'validateLogDir must reject relative path');

    fs.rmSync(tempDir, { recursive: true, force: true });
    console.log('  ✓ Invalid, unwritable and system folders (Windows, Program Files, System32, drive roots) are rejected');
  }

  // =========================================================================
  // Test Group 9: "Use default" Clears logDir
  // =========================================================================
  console.log('\n--- Test Group 9: "Use default" Clears logDir ---');
  {
    const tempDir = createTempDir('aw-default-cfg-');
    const configPath = path.join(tempDir, 'config.json');
    const targetFolder = createTempDir('aw-default-target-');

    // Set custom logDir first
    const mockDialog = {
      showOpenDialog: async () => ({ canceled: false, filePaths: [targetFolder] })
    };
    await pickLogFolder({ dialog: mockDialog, configPath });
    assert.strictEqual(loadConfig(configPath).logDir, targetFolder);

    // Call setSetting with empty string (as the "Use default" button triggers)
    const clearRes = setSetting({ key: 'logDir', value: '' }, { configPath });
    assert.strictEqual(clearRes.success, true, 'Clearing logDir must succeed');

    const reloaded = loadConfig(configPath);
    assert.strictEqual(reloaded.logDir, undefined, 'Config logDir must be cleared to undefined');

    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(targetFolder, { recursive: true, force: true });
    console.log('  ✓ "Use default" clears logDir');
  }

  // =========================================================================
  // Test Group 10: Wrapper Uses New Folder for New Sessions Only
  // =========================================================================
  console.log('\n--- Test Group 10: Wrapper Uses New Folder for New Sessions Only ---');
  {
    const tempCfgDir = createTempDir('aw-wrapper-cfg-');
    const configPath = path.join(tempCfgDir, 'config.json');

    const folder1 = createTempDir('aw-session1-logs-');
    const folder2 = createTempDir('aw-session2-logs-');
    const workDir1 = createTempDir('aw-work1-');
    const workDir2 = createTempDir('aw-work2-');

    // Configure folder 1
    setSetting({ key: 'logDir', value: folder1 }, { fromPicker: true, configPath });

    // Start Session 1
    const stdinMock1 = new EventEmitter();
    stdinMock1.isTTY = true;
    stdinMock1.setRawMode = () => {};

    const monitor1 = startAgentwatch({
      command: 'agy',
      cwd: workDir1,
      configPath,
      stdin: stdinMock1,
      stdout: { columns: 80, rows: 24, write: () => {}, on: () => {} },
      ptyProcess: { write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {} },
      profile: getProfileForCommand('agy')
    });

    assert.strictEqual(monitor1.getPromptsLogPath(), path.join(folder1, 'prompts.log'));
    assert.strictEqual(monitor1.getSnapshotsPath(), path.join(folder1, 'screen-snapshots.txt'));

    // Now user changes log folder in Settings to folder 2
    setSetting({ key: 'logDir', value: folder2 }, { fromPicker: true, configPath });
    assert.strictEqual(loadConfig(configPath).logDir, folder2);

    // Verify Session 1 STILL uses folder 1 (Applies to new sessions only)
    assert.strictEqual(monitor1.getPromptsLogPath(), path.join(folder1, 'prompts.log'), 'Session 1 must continue using folder 1');

    // Start Session 2 fresh
    const stdinMock2 = new EventEmitter();
    stdinMock2.isTTY = true;
    stdinMock2.setRawMode = () => {};

    const monitor2 = startAgentwatch({
      command: 'agy',
      cwd: workDir2,
      configPath,
      stdin: stdinMock2,
      stdout: { columns: 80, rows: 24, write: () => {}, on: () => {} },
      ptyProcess: { write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {} },
      profile: getProfileForCommand('agy')
    });

    // Verify Session 2 picked up folder 2
    assert.strictEqual(monitor2.getPromptsLogPath(), path.join(folder2, 'prompts.log'), 'Session 2 must use folder 2');
    assert.strictEqual(monitor2.getSnapshotsPath(), path.join(folder2, 'screen-snapshots.txt'), 'Session 2 snapshots must be in folder 2');

    // Session 1 is STILL using folder 1
    assert.strictEqual(monitor1.getPromptsLogPath(), path.join(folder1, 'prompts.log'), 'Session 1 must remain on folder 1');

    monitor1.cleanup();
    monitor2.cleanup();

    fs.rmSync(tempCfgDir, { recursive: true, force: true });
    fs.rmSync(folder1, { recursive: true, force: true });
    fs.rmSync(folder2, { recursive: true, force: true });
    fs.rmSync(workDir1, { recursive: true, force: true });
    fs.rmSync(workDir2, { recursive: true, force: true });
    console.log('  ✓ Wrapper uses the new folder for new sessions only');
  }

  // =========================================================================
  // Test Group 11: Config File Does Not Revert After a Refresh Tick
  // =========================================================================
  console.log('\n--- Test Group 11: Config File Does Not Revert After a Refresh Tick ---');
  {
    const tempCfgDir = createTempDir('aw-refresh-cfg-');
    const configPath = path.join(tempCfgDir, 'config.json');
    const customDir = createTempDir('aw-refresh-target-');

    // Save custom logDir
    const setRes = setSetting({ key: 'logDir', value: customDir }, { fromPicker: true, configPath });
    assert.strictEqual(setRes.success, true);
    assert.strictEqual(loadConfig(configPath).logDir, customDir);

    // Simulate 5 periodic dashboard refresh ticks
    for (let tick = 0; tick < 5; tick++) {
      const data = getDashboardData({ configPath });
      assert.strictEqual(data.config.logDir, customDir, `Tick ${tick + 1}: dashboard data config must contain logDir`);
    }

    // Read config fresh from disk to verify it never reverted
    const reloaded = loadConfig(configPath);
    assert.strictEqual(reloaded.logDir, customDir, 'Config file on disk must not revert after refresh ticks');

    fs.rmSync(tempCfgDir, { recursive: true, force: true });
    fs.rmSync(customDir, { recursive: true, force: true });
    console.log('  ✓ Config file does not revert after a refresh tick');
  }

  console.log('\n=========================================');
  console.log('All Custom Locations tests passed successfully!');
  console.log('=========================================\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
