const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { EventEmitter } = require('events');
const { parseArgs } = require('../bin/agentwatch');
const { startAgentwatch, logPromptRecord } = require('../src/agentwatch');
const { loadConfig, saveConfig, setLogDir } = require('../src/shared');
const { getProfileForCommand } = require('../src/profile');

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

  console.log('\n=========================================');
  console.log('All Custom Locations tests passed successfully!');
  console.log('=========================================\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
