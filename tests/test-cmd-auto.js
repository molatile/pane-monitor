const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawn } = require('child_process');

function createTempDir(prefix = 'aw-cmd-test-') {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForSessionFile(sessionsDir, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(sessionsDir)) {
      const files = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
      for (const file of files) {
        try {
          const raw = fs.readFileSync(path.join(sessionsDir, file), 'utf8');
          const data = JSON.parse(raw);
          if (data && typeof data.auto === 'boolean') {
            return data;
          }
        } catch (e) {
          // File might be mid-write; retry
        }
      }
    }
    await delay(100);
  }
  throw new Error(`Timeout waiting for session status file in ${sessionsDir}`);
}

async function runCliTest({ useCmd, cliArgs, expectedAuto, testLabel }) {
  const tmpDir = createTempDir();
  const sessionsDir = path.join(tmpDir, 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const argsFile = path.join(tmpDir, 'received-args.json');

  const cmdPath = path.resolve(__dirname, '../agentwatch.cmd');
  const binScriptPath = 'bin/agentwatch.js';
  const mockAgentPath = 'tests/mock-auto-app.js';

  // Replace placeholder 'MOCK_AGENT' in cliArgs with relative path to mock agent
  const finalArgs = cliArgs.map(arg => (arg === 'MOCK_AGENT' ? mockAgentPath : arg));

  const child = useCmd
    ? spawn(`"${cmdPath}"`, finalArgs, {
        shell: true,
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          AGENTWATCH_TEST: '1',
          AGENTWATCH_CONFIG_PATH: path.join(tmpDir, 'empty-config.json'),
          AGENTWATCH_SESSIONS_DIR: sessionsDir,
          MOCK_AGENT_ARGS_FILE: argsFile
        }
      })
    : spawn(process.execPath, [binScriptPath, ...finalArgs], {
        cwd: path.resolve(__dirname, '..'),
        env: {
          ...process.env,
          AGENTWATCH_TEST: '1',
          AGENTWATCH_CONFIG_PATH: path.join(tmpDir, 'empty-config.json'),
          AGENTWATCH_SESSIONS_DIR: sessionsDir,
          MOCK_AGENT_ARGS_FILE: argsFile
        }
      });

  let stdoutText = '';
  let stderrText = '';
  child.stdout.on('data', d => { stdoutText += d.toString(); });
  child.stderr.on('data', d => { stderrText += d.toString(); });

  try {
    // 1. Wait for session file to be written by SessionStatusManager
    const sessionData = await waitForSessionFile(sessionsDir, 6000);
    assert.strictEqual(
      sessionData.auto,
      expectedAuto,
      `[${testLabel}] Status file auto must be ${expectedAuto}, got ${sessionData.auto}`
    );

    // 2. Wait up to 3s for mock agent to run and write received args
    const startArgsWait = Date.now();
    let receivedArgs = null;
    while (Date.now() - startArgsWait < 3000) {
      if (fs.existsSync(argsFile)) {
        try {
          receivedArgs = JSON.parse(fs.readFileSync(argsFile, 'utf8'));
          break;
        } catch (e) {}
      }
      await delay(100);
    }

    assert(receivedArgs !== null, `[${testLabel}] Child mock agent must write received arguments`);
    assert(
      !receivedArgs.includes('--auto'),
      `[${testLabel}] Child mock agent must NEVER receive --auto argument! Received: ${JSON.stringify(receivedArgs)}`
    );

    // 3. Check startup announcement output
    const expectedStartupLine = `agentwatch: auto-accept is ${expectedAuto ? 'ON' : 'OFF'} for this session`;
    const combinedOutput = stdoutText + '\n' + stderrText;
    assert(
      combinedOutput.includes(expectedStartupLine),
      `[${testLabel}] Output must include "${expectedStartupLine}". Got:\n${combinedOutput}`
    );

    console.log(`  ✓ ${testLabel} passed: status auto=${expectedAuto}, child never received --auto, startup announced ${expectedAuto ? 'ON' : 'OFF'}`);
  } finally {
    try {
      child.kill();
    } catch (e) {}
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}
  }
}

async function runAllCmdTests() {
  console.log('Running REAL agentwatch.cmd and node bin/agentwatch.js CLI tests...\n');
  let passCount = 0;

  // --- Tests via REAL agentwatch.cmd ---
  console.log('--- Suite: agentwatch.cmd ---');
  await runCliTest({
    useCmd: true,
    cliArgs: ['--auto', 'node', 'MOCK_AGENT', 'customArg1', 'customArg2'],
    expectedAuto: true,
    testLabel: 'agentwatch.cmd --auto node mock-agent customArg1 customArg2'
  });
  passCount++;

  await runCliTest({
    useCmd: true,
    cliArgs: ['node', 'MOCK_AGENT', 'customArg1'],
    expectedAuto: false,
    testLabel: 'agentwatch.cmd node mock-agent customArg1 (without --auto)'
  });
  passCount++;

  await runCliTest({
    useCmd: true,
    cliArgs: ['node', 'MOCK_AGENT', '--auto', 'customArg1'],
    expectedAuto: true,
    testLabel: 'agentwatch.cmd node mock-agent --auto customArg1 (flag after command)'
  });
  passCount++;

  // --- Tests via node bin/agentwatch.js ---
  console.log('\n--- Suite: node bin/agentwatch.js ---');
  await runCliTest({
    useCmd: false,
    cliArgs: ['--auto', 'node', 'MOCK_AGENT', 'customArg1', 'customArg2'],
    expectedAuto: true,
    testLabel: 'node bin/agentwatch.js --auto node mock-agent customArg1 customArg2'
  });
  passCount++;

  await runCliTest({
    useCmd: false,
    cliArgs: ['node', 'MOCK_AGENT', 'customArg1'],
    expectedAuto: false,
    testLabel: 'node bin/agentwatch.js node mock-agent customArg1 (without --auto)'
  });
  passCount++;

  await runCliTest({
    useCmd: false,
    cliArgs: ['node', 'MOCK_AGENT', '--auto', 'customArg1'],
    expectedAuto: true,
    testLabel: 'node bin/agentwatch.js node mock-agent --auto customArg1 (flag after command)'
  });
  passCount++;

  console.log(`\nAll ${passCount} REAL agentwatch.cmd and bin/agentwatch.js tests passed successfully!`);
  return passCount;
}

if (require.main === module) {
  runAllCmdTests().catch(err => {
    console.error('\nTest failed:', err);
    process.exit(1);
  });
}

module.exports = {
  runAllCmdTests,
  runCliTest
};
