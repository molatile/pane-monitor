const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const assert = require('assert');

const rootDir = path.resolve(__dirname, '..');
const rawSessionPath = path.join(rootDir, 'raw-session.bin');
const promptsLogPath = path.join(rootDir, 'prompts.log');
const snapshotsPath = path.join(rootDir, 'screen-snapshots.txt');

// Preserve existing raw-session.bin so it remains unchanged
const originalRawSession = fs.existsSync(rawSessionPath) ? fs.readFileSync(rawSessionPath) : null;
const originalSnapshots = fs.existsSync(snapshotsPath) ? fs.readFileSync(snapshotsPath, 'utf8') : null;

function runSpike(appScript, callback) {
  if (fs.existsSync(promptsLogPath)) fs.unlinkSync(promptsLogPath);

  const spikeProcess = spawn(
    process.execPath,
    [path.join(rootDir, 'spike.js'), 'node', appScript],
    {
      cwd: rootDir,
      stdio: 'inherit'
    }
  );

  spikeProcess.on('close', (code) => {
    callback(code);
  });
}

console.log('Running integration test 1: spike with standard mock-prompt-app...\n');

runSpike(path.join(rootDir, 'tests', 'mock-prompt-app.js'), (code) => {
  console.log(`\nChild process exited with code ${code}`);
  assert.strictEqual(code, 0, 'Integration test failed: spike exited with non-zero code');

  // Verify raw-session.bin exists and has content
  assert(fs.existsSync(rawSessionPath), 'raw-session.bin should exist');
  const rawBytes = fs.readFileSync(rawSessionPath);
  console.log(`✓ raw-session.bin verified (${rawBytes.length} bytes)`);
  assert(rawBytes.length > 0, 'raw-session.bin should not be empty');

  // Verify prompts.log exists and contains the parsed prompt
  assert(fs.existsSync(promptsLogPath), 'prompts.log should exist');
  const logContent = fs.readFileSync(promptsLogPath, 'utf8');
  console.log('\n--- Content of prompts.log ---');
  console.log(logContent);
  console.log('------------------------------\n');

  assert(logContent.includes('Command (spaced):'), 'prompts.log must include Command (spaced)');
  assert(
    logContent.includes(
      'Command (spaced): echo this-is-a-long-test-message-to-check-how-wrapping-works-in-the-permission-prompt-one-two-three-four-five-six -seven-eight-nine-ten-eleven-twelve-thirteen-fourteen-fifteen'
    ),
    'Command (spaced) content must match'
  );

  assert(!logContent.includes('Command (compact):'), 'prompts.log must not include Command (compact)');

  assert(logContent.includes('Question: Run this command?'), 'Question text must match');
  assert(logContent.includes('1: Yes, run command'), 'Option 1 must match');
  assert(
    logContent.includes(
      "2: Yes, and always allow in this conversation for commands that start with 'echo this-is-a-long-test-message-to- check-how-wrapping-works-in-the-permission-p...'"
    ),
    'Option 2 must match'
  );
  assert(
    logContent.includes(
      "3: Yes, and always allow for commands that start with 'echo this-is-a-long-test-message-to-check-how-wrapping- works-in-the-permission-p...' (Persist to settings.json)"
    ),
    'Option 3 must match'
  );
  assert(logContent.includes('4: No, cancel'), 'Option 4 must match');
  assert(!logContent.includes('Navigate'), 'Option 4 must not include footer Navigate text');
  assert(!logContent.includes('esc to cancel'), 'Option 4 must not include esc to cancel text');
  assert(!logContent.includes('Gemini 3.8 Flash'), 'Must not include Gemini footer text');

  // Verify Outcome: shown and Prompt closed at
  assert(logContent.includes('Outcome: shown'), 'Must include Outcome: shown');
  assert(logContent.includes('Prompt closed at '), 'Must include Prompt closed at');

  // Verify prompt was logged only once
  const questionMatches = logContent.match(/Question: Run this command\?/g) || [];
  assert.strictEqual(questionMatches.length, 1, 'Standard prompt must be logged exactly once');

  console.log('✓ Test 1: Standard prompt logging verified successfully!\n');

  // Run Test 2: Fast prompt that appears and disappears within 500 ms
  console.log('Running integration test 2: spike with fast mock-prompt-app (< 500 ms)...\n');

  runSpike(path.join(rootDir, 'tests', 'mock-fast-prompt-app.js'), (fastCode) => {
    console.log(`\nChild process exited with code ${fastCode}`);
    assert.strictEqual(fastCode, 0, 'Fast prompt integration test failed: non-zero exit code');

    assert(fs.existsSync(promptsLogPath), 'prompts.log should exist for fast prompt');
    const fastLogContent = fs.readFileSync(promptsLogPath, 'utf8');
    console.log('\n--- Content of fast prompts.log ---');
    console.log(fastLogContent);
    console.log('-----------------------------------\n');

    assert(fastLogContent.includes('Question: Run this command?'), 'Must include Question');
    assert(fastLogContent.includes('Command (spaced): echo fast-test-command'), 'Command spaced must match');
    assert(!fastLogContent.includes('Command (compact):'), 'fast prompts.log must not include Command (compact)');
    assert(fastLogContent.includes('1: Yes, run command'), 'Option 1 must match');
    assert(fastLogContent.includes('2: No, cancel'), 'Option 2 must match');
    assert(fastLogContent.includes('Outcome: shown'), 'Must include Outcome: shown');
    assert(fastLogContent.includes('Prompt closed at '), 'Must include Prompt closed at');

    // Verify fast prompt was logged exactly once
    const fastQuestionMatches = fastLogContent.match(/Question: Run this command\?/g) || [];
    assert.strictEqual(fastQuestionMatches.length, 1, 'Fast prompt must be logged exactly once');

    // Verify snapshot was taken
    assert(fs.existsSync(snapshotsPath), 'screen-snapshots.txt should exist');
    const snapshotsContent = fs.readFileSync(snapshotsPath, 'utf8');
    assert(snapshotsContent.includes('echo fast-test-command'), 'Snapshot must contain fast prompt');

    // Restore original files
    if (originalRawSession !== null) {
      fs.writeFileSync(rawSessionPath, originalRawSession);
    }
    if (originalSnapshots !== null) {
      fs.writeFileSync(snapshotsPath, originalSnapshots);
    }

    console.log('✓ Test 2: Fast prompt (< 500 ms) verified successfully!');
    console.log('\n✓ All integration test assertions passed successfully!');
  });
});
