const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const rootDir = path.resolve(__dirname, '..');
const rawSessionPath = path.join(rootDir, 'raw-session.bin');
const promptsLogPath = path.join(rootDir, 'prompts.log');
const snapshotsPath = path.join(rootDir, 'screen-snapshots.txt');

// Preserve existing raw-session.bin and screen-snapshots.txt
const originalRawSession = fs.existsSync(rawSessionPath) ? fs.readFileSync(rawSessionPath) : null;
const originalSnapshots = fs.existsSync(snapshotsPath) ? fs.readFileSync(snapshotsPath, 'utf8') : null;

// Clean up prior prompts log
if (fs.existsSync(promptsLogPath)) fs.unlinkSync(promptsLogPath);

console.log('Running test: prompt appearing and disappearing within 500 ms...\n');

const startTime = Date.now();
const spikeProcess = spawn(
  process.execPath,
  [path.join(rootDir, 'spike.js'), 'node', path.join(rootDir, 'tests', 'mock-fast-prompt-app.js')],
  {
    cwd: rootDir,
    stdio: 'inherit',
    env: { ...process.env, AGENTWATCH_LOG_DIR: rootDir }
  }
);

spikeProcess.on('close', (code) => {
  const duration = Date.now() - startTime;
  console.log(`\nChild process exited with code ${code} in ${duration}ms`);
  assert.strictEqual(code, 0, 'Spike process should exit with code 0');

  // Verify prompts.log exists
  assert(fs.existsSync(promptsLogPath), 'prompts.log should exist');
  const logContent = fs.readFileSync(promptsLogPath, 'utf8');

  console.log('\n--- Content of prompts.log ---');
  console.log(logContent);
  console.log('------------------------------\n');

  // Verify prompt content was captured
  assert(logContent.includes('Question: Run this command?'), 'prompts.log must include Question: Run this command?');
  assert(logContent.includes('Command (spaced): echo fast-test-command'), 'Command spaced must match');
  assert(!logContent.includes('Command (compact):'), 'Command compact must not be logged');
  assert(logContent.includes('1: Yes, run command'), 'Option 1 must match');
  assert(logContent.includes('2: No, cancel'), 'Option 2 must match');

  // Verify outcome and closing line
  assert(logContent.includes('Outcome: shown'), 'prompts.log must include Outcome: shown');
  assert(logContent.includes('Prompt closed at '), 'prompts.log must include Prompt closed at');

  // Verify prompt was logged EXACTLY ONCE
  const questionMatches = logContent.match(/Question: Run this command\?/g) || [];
  assert.strictEqual(questionMatches.length, 1, `Prompt must be logged exactly once, but found ${questionMatches.length}`);

  const outcomeMatches = logContent.match(/Outcome: shown/g) || [];
  assert.strictEqual(outcomeMatches.length, 1, `Outcome: shown must appear exactly once, but found ${outcomeMatches.length}`);

  const closedMatches = logContent.match(/Prompt closed at /g) || [];
  assert.strictEqual(closedMatches.length, 1, `Prompt closed at must appear exactly once, but found ${closedMatches.length}`);

  // Verify screen snapshot was saved
  assert(fs.existsSync(snapshotsPath), 'screen-snapshots.txt should exist');
  const snapshotsContent = fs.readFileSync(snapshotsPath, 'utf8');
  assert(snapshotsContent.includes('echo fast-test-command'), 'Snapshot must contain the prompt');

  // Restore preserved files
  if (originalRawSession !== null) {
    fs.writeFileSync(rawSessionPath, originalRawSession);
  }
  if (originalSnapshots !== null) {
    fs.writeFileSync(snapshotsPath, originalSnapshots);
  }

  console.log('✓ Fast prompt (< 500 ms) test passed successfully: logged once with Outcome: shown and Prompt closed at');
});
