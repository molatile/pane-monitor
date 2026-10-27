const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const { resolveRulesPath, loadRules, loadRulesForFolder } = require('../src/rules');
const { clearAgentHistory, clearAllHistory, readHistory, appendHistoryEvent } = require('../src/history');
const { startAgentwatch } = require('../src/agentwatch');
const { getProfileForCommand } = require('../src/profile');

function createTempDir(prefix = 'agentwatch-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('Running Rules Hot-Reload and History Management tests...\n');

  // Test 1: resolveRulesPath walks up to find parent rules.json
  {
    console.log('--- Test 1: resolveRulesPath ancestor directory walk ---');
    const rootDir = createTempDir('aw-root-');
    const subDir = path.join(rootDir, 'nested', 'deep', 'dustbin');
    fs.mkdirSync(subDir, { recursive: true });

    const rootRulesPath = path.join(rootDir, 'rules.json');
    fs.writeFileSync(rootRulesPath, JSON.stringify({ defaultDelaySeconds: 5 }), 'utf8');

    // From deep subDir, resolveRulesPath should find rootRulesPath
    const resolved = resolveRulesPath(undefined, subDir);
    assert.strictEqual(path.resolve(resolved), path.resolve(rootRulesPath), 'Must resolve ancestor rules.json');
    console.log('  ✓ Ancestor rules.json found from deep subdirectory');

    // Explicit custom path takes precedence
    const customPath = path.join(subDir, 'custom.json');
    fs.writeFileSync(customPath, JSON.stringify({ defaultDelaySeconds: 2 }), 'utf8');
    assert.strictEqual(resolveRulesPath(customPath, subDir), path.resolve(customPath), 'Explicit custom path takes precedence');
    console.log('  ✓ Explicit customPath takes precedence');
  }

  // Test 2: Rules hot-reload inside a subfolder without restarting
  {
    console.log('\n--- Test 2: Rules hot-reload inside a subfolder without restarting ---');
    const rootDir = createTempDir('aw-workspace-');
    const childDir = path.join(rootDir, 'dustbin');
    fs.mkdirSync(childDir, { recursive: true });

    const rootRulesPath = path.join(rootDir, 'rules.json');
    const initialRules = {
      defaultDelaySeconds: 0.1,
      deny: ['rm -rf'],
      danger: [{ text: 'delete', wholeWord: false }],
      allow: [],
      optionRules: [
        {
          name: 'rule-v1',
          startsWith: 'Yes, option one'
        }
      ]
    };
    fs.writeFileSync(rootRulesPath, JSON.stringify(initialRules, null, 2), 'utf8');

    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};
    stdinMock.resume = () => {};
    stdinMock.pause = () => {};

    const stdoutMock = { columns: 100, rows: 30, write: () => {}, on: () => {}, removeListener: () => {} };
    const writtenToChild = [];
    const ptyMock = {
      write: (d) => { writtenToChild.push(d.toString()); },
      resize: () => {},
      onData: () => {},
      onExit: () => {}
    };

    const monitor = startAgentwatch({
      command: 'agy',
      auto: true,
      stdin: stdinMock,
      stdout: stdoutMock,
      ptyProcess: ptyMock,
      cwd: childDir,
      profile: getProfileForCommand('agy'),
      sessionsDir: path.join(childDir, 'sessions'),
      historyPath: path.join(childDir, 'history.jsonl'),
      promptsLogPath: path.join(childDir, 'prompts.log')
    });

    // Verify initial rules
    const screen1 =
      'Requesting permission for:\r\n' +
      '   git status\r\n' +
      'Run this command?\r\n' +
      '> 1. Yes, option one\r\n' +
      '  2. No, cancel\r\n' +
      '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
      'esc to cancel\r\n';

    await new Promise(r => monitor.term.write(screen1, r));
    monitor.inspectScreenForPrompts(Date.now());
    assert.strictEqual(monitor.statusManager.state, 'countdown', 'Should start countdown with rule-v1');
    console.log('  ✓ Initial rule-v1 matched and triggered countdown');

    // Allow countdown to finish and close active prompt
    await delay(300);
    monitor.closeActivePrompt('answered');
    monitor.term.reset();

    // Update rules.json in rootDir (simulating user editing rules while agent runs in dustbin)
    await delay(100);
    const updatedRules = {
      defaultDelaySeconds: 0.1,
      deny: ['rm -rf'],
      danger: [{ text: 'delete', wholeWord: false }],
      allow: [],
      optionRules: [
        {
          name: 'rule-v2',
          startsWith: 'Yes, option two updated'
        }
      ]
    };
    fs.writeFileSync(rootRulesPath, JSON.stringify(updatedRules, null, 2), 'utf8');

    // Wait slightly so mtime is strictly greater
    await delay(100);

    // New screen offering option 2 updated
    const screen2 =
      'Requesting permission for:\r\n' +
      '   git status\r\n' +
      'Run this command?\r\n' +
      '> 1. Yes, option one\r\n' +
      '  2. Yes, option two updated\r\n' +
      '  3. No, cancel\r\n' +
      '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
      'esc to cancel\r\n';

    await new Promise(r => monitor.term.write(screen2, r));
    monitor.inspectScreenForPrompts(Date.now());

    assert.strictEqual(monitor.statusManager.state, 'countdown', 'Should start countdown with hot-reloaded rule-v2');
    assert.strictEqual(monitor.statusManager.prompt.rule, 'rule-v2', 'Active prompt must use rule-v2');
    console.log('  ✓ Process running in dustbin hot-reloaded rules.json from parent directory without restart!');

    monitor.statusManager.cleanup();
  }

  // Test 3: Ancestor history deletion does not break child history or rules
  {
    console.log('\n--- Test 3: Ancestor history deletion isolation ---');
    const tmpDir = createTempDir('aw-hist-');
    const histPath = path.join(tmpDir, 'history.jsonl');

    const ancestorKey = 'agy:ancestor_folder_111';
    const childKey = 'agy:child_folder_222';

    // Append ancestor and child events
    appendHistoryEvent({ sessionKey: ancestorKey, type: 'session_started', folder: 'workspace' }, histPath);
    appendHistoryEvent({ sessionKey: ancestorKey, type: 'prompt', question: 'Run git status?', command: 'git status' }, histPath);
    appendHistoryEvent({ sessionKey: childKey, type: 'session_started', folder: 'dustbin' }, histPath);
    appendHistoryEvent({ sessionKey: childKey, type: 'prompt', question: 'Run build?', command: 'npm run build' }, histPath);

    // Read history before deletion
    const beforeAncestor = readHistory({ filePath: histPath, key: ancestorKey });
    const beforeChild = readHistory({ filePath: histPath, key: childKey });
    assert.strictEqual(beforeAncestor.events.length, 2);
    assert.strictEqual(beforeChild.events.length, 2);

    // Clear ancestor history
    const res = clearAgentHistory(ancestorKey, histPath);
    assert.strictEqual(res.success, true);
    assert.strictEqual(res.removedCount, 2);

    // Ancestor events gone
    const afterAncestor = readHistory({ filePath: histPath, key: ancestorKey });
    assert.strictEqual(afterAncestor.events.length, 0);

    // Child events completely preserved!
    const afterChild = readHistory({ filePath: histPath, key: childKey });
    assert.strictEqual(afterChild.events.length, 2);
    assert.strictEqual(afterChild.events[0].command, 'npm run build');
    console.log('  ✓ Deleting ancestor history removed ancestor events and kept child events intact');

    // Clear all history
    const resAll = clearAllHistory(histPath);
    assert.strictEqual(resAll.success, true);
    assert.strictEqual(resAll.removedCount, 2);

    const afterAll = readHistory({ filePath: histPath });
    assert.strictEqual(afterAll.events.length, 0);
    console.log('  ✓ clearAllHistory cleared all events cleanly without breaking file structure');
  }

  // Test 4: CLI agentwatch clear-history
  {
    console.log('\n--- Test 4: CLI clear-history command ---');
    const { execSync } = require('child_process');
    const output = execSync('node bin/agentwatch.js clear-history --help', { encoding: 'utf8' }).trim();
    assert(output.includes('clear-history') || output.includes('cleared'), 'CLI must respond to clear-history');
    console.log('  ✓ CLI clear-history command recognized');
  }

  console.log('\nAll Rules Hot-Reload and History Management tests passed!\n');
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
