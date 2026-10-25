const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const { startAgentwatch } = require('../src/agentwatch');
const { getProfileForCommand } = require('../src/profile');
const { getSelectedOptionNumberFromScreen, extractPromptFromScreen } = require('../src/parser');
const {
  computeAgreement,
  formatPromptAnswer,
  groupHistoryBySession,
  appendHistoryEvent
} = require('../src/history');
const { evaluatePrompt } = require('../src/rules');

console.log('Running agentwatch Stage 3b test suite...\n');

// Helper to create a temp directory
function createTempDir(prefix = 'agentwatch-stage3b-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Helper to write to terminal and wait for headless buffer to update
function writeTerm(term, text) {
  return new Promise(resolve => term.write(text, resolve));
}

async function runStage3bTests() {
  // -------------------------------------------------------------
  // Test Group 1: Digit Answers (1 to 4)
  // -------------------------------------------------------------
  console.log('--- Test Group 1: Digit Answers (1 to 4) ---');
  {
    const tmpDir = createTempDir();
    const historyPath = path.join(tmpDir, 'history.jsonl');
    const promptsLogPath = path.join(tmpDir, 'prompts.log');
    const snapshotsPath = path.join(tmpDir, 'screen-snapshots.txt');
    const sessionsDir = path.join(tmpDir, 'sessions');

    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};
    stdinMock.resume = () => {};
    stdinMock.pause = () => {};

    const stdoutMock = {
      columns: 100,
      rows: 30,
      write: () => {},
      on: () => {},
      removeListener: () => {}
    };

    const ptyMock = {
      write: () => {},
      resize: () => {},
      onData: () => {},
      onExit: () => {}
    };

    const monitor = startAgentwatch({
      command: 'agy',
      stdin: stdinMock,
      stdout: stdoutMock,
      ptyProcess: ptyMock,
      historyPath,
      promptsLogPath,
      snapshotsPath,
      sessionsDir,
      profile: getProfileForCommand('agy')
    });

    const screenPrompt =
      'Requesting permission for:\r\n' +
      '   echo stage3b-test\r\n' +
      'Run this command?\r\n' +
      '> 1. Yes, run command\r\n' +
      '  2. Yes, and always allow in this conversation for commands that start with \'echo\'\r\n' +
      '  3. Yes, and always allow for commands that start with \'echo\' (Persist to settings.json)\r\n' +
      '  4. No, cancel\r\n' +
      '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
      'esc to cancel\r\n';

    // 1. Digit '1'
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());
    assert(monitor.getActivePrompt() !== null, 'Active prompt must be detected');

    stdinMock.emit('data', Buffer.from('1'));
    monitor.closeActivePrompt('answered');

    let historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv1 = historyLines.find(e => e.type === 'prompt_closed');
    assert(closedEv1, 'Must record prompt_closed event');
    assert.strictEqual(closedEv1.answer_key, 1, 'answer_key must be 1');
    assert.strictEqual(closedEv1.answer_option_text, 'Yes, run command');
    assert.strictEqual(closedEv1.answer_class, 'yes_once');
    assert(typeof closedEv1.durationSeconds === 'number', 'durationSeconds must be a number');

    // 2. Digit '2'
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());
    stdinMock.emit('data', Buffer.from('2'));
    monitor.closeActivePrompt('answered');

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv2 = historyLines.filter(e => e.type === 'prompt_closed')[1];
    assert.strictEqual(closedEv2.answer_key, 2);
    assert(closedEv2.answer_option_text.includes('always allow in this conversation'));
    assert.strictEqual(closedEv2.answer_class, 'yes_session');

    // 3. Digit '3'
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());
    stdinMock.emit('data', Buffer.from('3'));
    monitor.closeActivePrompt('answered');

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv3 = historyLines.filter(e => e.type === 'prompt_closed')[2];
    assert.strictEqual(closedEv3.answer_key, 3);
    assert(closedEv3.answer_option_text.includes('Persist to settings.json'));
    assert.strictEqual(closedEv3.answer_class, 'yes_persist');

    // 4. Digit '4'
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());
    stdinMock.emit('data', Buffer.from('4'));
    monitor.closeActivePrompt('answered');

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv4 = historyLines.filter(e => e.type === 'prompt_closed')[3];
    assert.strictEqual(closedEv4.answer_key, 4);
    assert.strictEqual(closedEv4.answer_option_text, 'No, cancel');
    assert.strictEqual(closedEv4.answer_class, 'no');

    // 5. Invalid digit (e.g. '9') does not record an answer
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());
    stdinMock.emit('data', Buffer.from('9'));
    monitor.closeActivePrompt('answered');

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv5 = historyLines.filter(e => e.type === 'prompt_closed')[4];
    assert.strictEqual(closedEv5.answer_key, 'unknown', 'Invalid digit must yield unknown answer');
    assert.strictEqual(closedEv5.answer_option_text, null);
    assert.strictEqual(closedEv5.answer_class, 'unknown');
    assert.strictEqual(closedEv5.agreement, 'n/a');

    monitor.cleanup();
    console.log('✓ Test Group 1 passed: All digit answers (1-4) and out-of-range rejection verified');
  }

  // -------------------------------------------------------------
  // Test Group 2: Enter on Selected Option (reads marker from screen)
  // -------------------------------------------------------------
  console.log('\n--- Test Group 2: Enter on Selected Option ---');
  {
    const tmpDir = createTempDir();
    const historyPath = path.join(tmpDir, 'history.jsonl');

    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};
    stdinMock.resume = () => {};
    stdinMock.pause = () => {};

    const stdoutMock = { columns: 100, rows: 30, write: () => {}, on: () => {}, removeListener: () => {} };
    const ptyMock = { write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {} };

    const monitor = startAgentwatch({
      command: 'agy',
      stdin: stdinMock,
      stdout: stdoutMock,
      ptyProcess: ptyMock,
      historyPath,
      sessionsDir: path.join(tmpDir, 'sessions'),
      profile: getProfileForCommand('agy')
    });

    // Prompt with '>' on option 1
    const screenOpt1 =
      'Requesting permission for:\r\n' +
      '   git status\r\n' +
      'Run this command?\r\n' +
      '> 1. Yes, run command\r\n' +
      '  2. No, cancel\r\n' +
      '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
      'esc to cancel\r\n';

    await writeTerm(monitor.term, screenOpt1);
    monitor.inspectScreenForPrompts(Date.now());

    // Enter pressed on option 1
    stdinMock.emit('data', Buffer.from('\r'));
    monitor.closeActivePrompt('answered');

    let historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv1 = historyLines.find(e => e.type === 'prompt_closed');
    assert.strictEqual(closedEv1.answer_key, 'enter');
    assert.strictEqual(closedEv1.answer_option_text, 'Yes, run command');
    assert.strictEqual(closedEv1.answer_class, 'yes_once');

    // Prompt with '>' on option 2
    const screenOpt2 =
      '\x1b[2J\x1b[H' +
      'Requesting permission for:\r\n' +
      '   git status\r\n' +
      'Run this command?\r\n' +
      '  1. Yes, run command\r\n' +
      '> 2. No, cancel\r\n' +
      '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
      'esc to cancel\r\n';

    await writeTerm(monitor.term, screenOpt2);
    monitor.inspectScreenForPrompts(Date.now());

    // Enter pressed on option 2
    stdinMock.emit('data', Buffer.from('\n'));
    monitor.closeActivePrompt('answered');

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv2 = historyLines.filter(e => e.type === 'prompt_closed')[1];
    assert.strictEqual(closedEv2.answer_key, 'enter');
    assert.strictEqual(closedEv2.answer_option_text, 'No, cancel');
    assert.strictEqual(closedEv2.answer_class, 'no');

    // Verify helper getSelectedOptionNumberFromScreen directly
    const lines1 = [{ text: '> 1. Yes' }, { text: '  2. No' }];
    assert.strictEqual(getSelectedOptionNumberFromScreen(lines1), 1);
    const lines2 = [{ text: '  1. Yes' }, { text: '  > 2. No' }];
    assert.strictEqual(getSelectedOptionNumberFromScreen(lines2), 2);
    const linesNone = [{ text: '  1. Yes' }, { text: '  2. No' }];
    assert.strictEqual(getSelectedOptionNumberFromScreen(linesNone), 1, 'Defaults to 1 if no marker');

    monitor.cleanup();
    console.log('✓ Test Group 2 passed: Enter on selected option read dynamically from screen');
  }

  // -------------------------------------------------------------
  // Test Group 3: Esc ("cancelled")
  // -------------------------------------------------------------
  console.log('\n--- Test Group 3: Esc ("cancelled") ---');
  {
    const tmpDir = createTempDir();
    const historyPath = path.join(tmpDir, 'history.jsonl');

    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};
    stdinMock.resume = () => {};
    stdinMock.pause = () => {};

    const stdoutMock = { columns: 100, rows: 30, write: () => {}, on: () => {}, removeListener: () => {} };
    const ptyMock = { write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {} };

    const monitor = startAgentwatch({
      command: 'agy',
      stdin: stdinMock,
      stdout: stdoutMock,
      ptyProcess: ptyMock,
      historyPath,
      sessionsDir: path.join(tmpDir, 'sessions'),
      profile: getProfileForCommand('agy')
    });

    const screenPrompt =
      'Requesting permission for:\r\n' +
      '   npm test\r\n' +
      'Run this command?\r\n' +
      '> 1. Yes, run command\r\n' +
      '  2. No, cancel\r\n' +
      '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
      'esc to cancel\r\n';

    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());

    // User presses Esc (0x1b)
    stdinMock.emit('data', Buffer.from([0x1b]));
    monitor.closeActivePrompt('answered');

    const historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const closedEv = historyLines.find(e => e.type === 'prompt_closed');
    assert.strictEqual(closedEv.answer_key, 'esc');
    assert.strictEqual(closedEv.answer_option_text, null);
    assert.strictEqual(closedEv.answer_class, 'no');

    monitor.cleanup();
    console.log('✓ Test Group 3 passed: Esc records cancelled with answer_key esc and class no');
  }

  // -------------------------------------------------------------
  // Test Group 4: Tab-Amend & Ctrl+G ("amended")
  // -------------------------------------------------------------
  console.log('\n--- Test Group 4: Tab-Amend & Ctrl+G ---');
  {
    const tmpDir = createTempDir();
    const historyPath = path.join(tmpDir, 'history.jsonl');

    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};
    stdinMock.resume = () => {};
    stdinMock.pause = () => {};

    const stdoutMock = { columns: 100, rows: 30, write: () => {}, on: () => {}, removeListener: () => {} };
    const ptyMock = { write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {} };

    const monitor = startAgentwatch({
      command: 'agy',
      stdin: stdinMock,
      stdout: stdoutMock,
      ptyProcess: ptyMock,
      historyPath,
      sessionsDir: path.join(tmpDir, 'sessions'),
      profile: getProfileForCommand('agy')
    });

    const screenPrompt =
      'Requesting permission for:\r\n' +
      '   npm test\r\n' +
      'Run this command?\r\n' +
      '> 1. Yes, run command\r\n' +
      '  2. No, cancel\r\n' +
      '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
      'esc to cancel\r\n';

    // 1. Tab to amend
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());

    // Press Tab
    stdinMock.emit('data', Buffer.from('\t'));
    // Type characters while amending (none should be stored)
    stdinMock.emit('data', Buffer.from(' --coverage'));
    // Press Enter to submit amendment
    stdinMock.emit('data', Buffer.from('\r'));
    monitor.closeActivePrompt('answered');

    let historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv1 = historyLines.find(e => e.type === 'prompt_closed');
    assert.strictEqual(closedEv1.answer_key, 'amended');
    assert.strictEqual(closedEv1.answer_option_text, null);
    assert.strictEqual(closedEv1.answer_class, 'unknown');

    // 2. Ctrl+G to edit/expand
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());

    // Press Ctrl+G (0x07)
    stdinMock.emit('data', Buffer.from([0x07]));
    stdinMock.emit('data', Buffer.from('\r'));
    monitor.closeActivePrompt('answered');

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv2 = historyLines.filter(e => e.type === 'prompt_closed')[1];
    assert.strictEqual(closedEv2.answer_key, 'amended');
    assert.strictEqual(closedEv2.answer_option_text, null);
    assert.strictEqual(closedEv2.answer_class, 'unknown');

    monitor.cleanup();
    console.log('✓ Test Group 4 passed: Tab-amend and Ctrl+G recorded as amended without typed text');
  }

  // -------------------------------------------------------------
  // Test Group 5: Answer Unknown (no signal seen)
  // -------------------------------------------------------------
  console.log('\n--- Test Group 5: Answer Unknown ---');
  {
    const tmpDir = createTempDir();
    const historyPath = path.join(tmpDir, 'history.jsonl');

    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};
    stdinMock.resume = () => {};
    stdinMock.pause = () => {};

    const stdoutMock = { columns: 100, rows: 30, write: () => {}, on: () => {}, removeListener: () => {} };
    const ptyMock = { write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {} };

    const monitor = startAgentwatch({
      command: 'agy',
      stdin: stdinMock,
      stdout: stdoutMock,
      ptyProcess: ptyMock,
      historyPath,
      sessionsDir: path.join(tmpDir, 'sessions'),
      profile: getProfileForCommand('agy')
    });

    const screenPrompt =
      'Requesting permission for:\r\n' +
      '   npm test\r\n' +
      'Run this command?\r\n' +
      '> 1. Yes, run command\r\n' +
      '  2. No, cancel\r\n' +
      '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
      'esc to cancel\r\n';

    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());

    // Prompt closes with zero keyboard input (e.g. process moves on)
    monitor.closeActivePrompt('screen_cleared');

    const historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const closedEv = historyLines.find(e => e.type === 'prompt_closed');
    assert.strictEqual(closedEv.answer_key, 'unknown');
    assert.strictEqual(closedEv.answer_option_text, null);
    assert.strictEqual(closedEv.answer_class, 'unknown');
    assert.strictEqual(closedEv.agreement, 'n/a');

    monitor.cleanup();
    console.log('✓ Test Group 5 passed: Prompt closed without signal records answer = unknown and agreement = n/a');
  }

  // -------------------------------------------------------------
  // Test Group 6: Final Answer Signals & Timing Rules
  // -------------------------------------------------------------
  console.log('\n--- Test Group 6: Final Answer Signals & Timing Rules ---');
  {
    const tmpDir = createTempDir();
    const historyPath = path.join(tmpDir, 'history.jsonl');

    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};
    stdinMock.resume = () => {};
    stdinMock.pause = () => {};

    const stdoutMock = { columns: 100, rows: 30, write: () => {}, on: () => {}, removeListener: () => {} };
    const ptyMock = { write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {} };

    const monitor = startAgentwatch({
      command: 'agy',
      stdin: stdinMock,
      stdout: stdoutMock,
      ptyProcess: ptyMock,
      historyPath,
      sessionsDir: path.join(tmpDir, 'sessions'),
      profile: getProfileForCommand('agy')
    });

    const screenPrompt =
      '\x1b[2J\x1b[H' +
      'Requesting permission for:\r\n' +
      '   echo multi\r\n' +
      'Run this command?\r\n' +
      '> 1. Yes, run command\r\n' +
      '  2. No, cancel\r\n' +
      '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
      'esc to cancel\r\n';

    // 1. digit then Enter (answer = the digit)
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());
    stdinMock.emit('data', Buffer.from('1'));
    stdinMock.emit('data', Buffer.from('\r'));
    monitor.closeActivePrompt('answered');

    let historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv1 = historyLines.find(e => e.type === 'prompt_closed');
    assert.strictEqual(closedEv1.answer_key, 1, 'Digit then Enter must record answer as the digit');
    assert.strictEqual(closedEv1.answer_class, 'yes_once');
    assert.strictEqual(closedEv1.answer_option_text, 'Yes, run command');

    // 2. digit then Enter within 100 ms (answer = the digit)
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());
    stdinMock.emit('data', Buffer.from('2'));
    await new Promise(r => setTimeout(r, 50)); // 50 ms is within 100 ms
    stdinMock.emit('data', Buffer.from('\r'));
    monitor.closeActivePrompt('answered');

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv2 = historyLines.filter(e => e.type === 'prompt_closed')[1];
    assert.strictEqual(closedEv2.answer_key, 2, 'Digit then Enter within 100 ms must record answer as the digit');
    assert.strictEqual(closedEv2.answer_class, 'no');
    assert.strictEqual(closedEv2.answer_option_text, 'No, cancel');

    // 3. arrows then Enter (answer = highlighted option)
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());
    stdinMock.emit('data', Buffer.from('\x1b[B')); // Down arrow (never an answer)
    const screenPromptArrow =
      '\x1b[2J\x1b[H' +
      'Requesting permission for:\r\n' +
      '   echo multi\r\n' +
      'Run this command?\r\n' +
      '  1. Yes, run command\r\n' +
      '> 2. No, cancel\r\n' +
      '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
      'esc to cancel\r\n';
    await writeTerm(monitor.term, screenPromptArrow);
    monitor.inspectScreenForPrompts(Date.now());
    stdinMock.emit('data', Buffer.from('\r')); // Enter
    monitor.closeActivePrompt('answered');

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv3 = historyLines.filter(e => e.type === 'prompt_closed')[2];
    assert.strictEqual(closedEv3.answer_key, 'enter', 'Enter after arrows records answer_key enter');
    assert.strictEqual(closedEv3.answer_option_text, 'No, cancel', 'Highlighted option must be recorded');
    assert.strictEqual(closedEv3.answer_class, 'no');

    // 4. Esc alone
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());
    stdinMock.emit('data', Buffer.from([0x1b]));
    monitor.closeActivePrompt('answered');

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv4 = historyLines.filter(e => e.type === 'prompt_closed')[3];
    assert.strictEqual(closedEv4.answer_key, 'esc', 'Esc alone records esc');
    assert.strictEqual(closedEv4.answer_class, 'no');
    assert.strictEqual(closedEv4.answer_option_text, null);

    // 5. Enter alone
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());
    stdinMock.emit('data', Buffer.from('\r'));
    monitor.closeActivePrompt('answered');

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv5 = historyLines.filter(e => e.type === 'prompt_closed')[4];
    assert.strictEqual(closedEv5.answer_key, 'enter', 'Enter alone records enter');
    assert.strictEqual(closedEv5.answer_option_text, 'Yes, run command');
    assert.strictEqual(closedEv5.answer_class, 'yes_once');

    // 6. a digit that does not match any option (ignored)
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());
    stdinMock.emit('data', Buffer.from('9')); // 9 does not match options (1 and 2)
    monitor.closeActivePrompt('answered');

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv6 = historyLines.filter(e => e.type === 'prompt_closed')[5];
    assert.strictEqual(closedEv6.answer_key, 'unknown', 'Non-matching digit must be ignored and yield unknown');
    assert.strictEqual(closedEv6.answer_class, 'unknown');
    assert.strictEqual(closedEv6.answer_option_text, null);

    // 6b. Non-matching digit followed by valid digit 2 -> 2 is accepted
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());
    stdinMock.emit('data', Buffer.from('8')); // ignored
    stdinMock.emit('data', Buffer.from('2')); // valid final answer
    monitor.closeActivePrompt('answered');

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEv6b = historyLines.filter(e => e.type === 'prompt_closed')[6];
    assert.strictEqual(closedEv6b.answer_key, 2, 'Non-matching digit ignored, subsequent valid digit accepted');
    assert.strictEqual(closedEv6b.answer_class, 'no');

    // 7. two prompts in a row where the second prompt's answer must not be affected by a late key from the first
    const screenPrompt1 =
      '\x1b[2J\x1b[H' +
      'Requesting permission for:\r\n' +
      '   echo prompt-one\r\n' +
      'Run this command?\r\n' +
      '> 1. Yes, run command\r\n' +
      '  2. No, cancel\r\n' +
      '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
      'esc to cancel\r\n';

    const screenPrompt2 =
      '\x1b[2J\x1b[H' +
      'Requesting permission for:\r\n' +
      '   echo prompt-two\r\n' +
      'Run this command?\r\n' +
      '> 1. Yes, run command\r\n' +
      '  2. No, cancel\r\n' +
      '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
      'esc to cancel\r\n';

    await writeTerm(monitor.term, screenPrompt1);
    monitor.inspectScreenForPrompts(Date.now());
    stdinMock.emit('data', Buffer.from('1'));
    monitor.closeActivePrompt('answered');
    // Late Enter from first prompt arrives
    stdinMock.emit('data', Buffer.from('\r'));

    // Second prompt appears
    await writeTerm(monitor.term, screenPrompt2);
    monitor.inspectScreenForPrompts(Date.now());
    const prompt2Active = monitor.getActivePrompt();
    assert(prompt2Active !== null, 'Prompt 2 must be detected');
    assert.strictEqual(prompt2Active.lastAnswerSignal, null, 'Prompt 2 must not be affected by late key from prompt 1');
    assert.strictEqual(prompt2Active.hasFinalAnswer, false, 'Prompt 2 hasFinalAnswer must be false initially');

    stdinMock.emit('data', Buffer.from('2'));
    monitor.closeActivePrompt('answered');

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    const closedEvs = historyLines.filter(e => e.type === 'prompt_closed');
    const p1Closed = closedEvs[closedEvs.length - 2];
    const p2Closed = closedEvs[closedEvs.length - 1];

    assert(p1Closed.command.spaced.includes('prompt-one'), 'First prompt closed event matches prompt 1');
    assert.strictEqual(p1Closed.answer_key, 1, 'First prompt answer must be 1');
    assert(p2Closed.command.spaced.includes('prompt-two'), 'Second prompt closed event matches prompt 2');
    assert.strictEqual(p2Closed.answer_key, 2, 'Second prompt answer must be 2');

    // 8. Amend mode cancelled by Esc (amend is not final, Esc is final)
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());
    stdinMock.emit('data', Buffer.from('\t'));
    stdinMock.emit('data', Buffer.from('amended text'));
    stdinMock.emit('data', Buffer.from([0x1b]));
    monitor.closeActivePrompt('answered');

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEvAmend = historyLines.filter(e => e.type === 'prompt_closed')[historyLines.filter(e => e.type === 'prompt_closed').length - 1];
    assert.strictEqual(closedEvAmend.answer_key, 'esc', 'Esc must win over amend mode');

    // 9. Timing rule: Key within 300 ms after disappearing counts, key after 300 ms ignored
    // 9a. Disappears with no answer, key arrives within 300 ms (e.g. at 50 ms)
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());
    monitor.closeActivePrompt('screen_cleared'); // prompt left screen with no answer
    await new Promise(r => setTimeout(r, 50)); // 50 ms <= 300 ms
    stdinMock.emit('data', Buffer.from('1')); // arrives within 300 ms

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEvLate = historyLines.filter(e => e.type === 'prompt_closed')[historyLines.filter(e => e.type === 'prompt_closed').length - 1];
    assert.strictEqual(closedEvLate.answer_key, 1, 'Key arriving within 300 ms after disappearing must be recorded');
    assert.strictEqual(closedEvLate.answer_class, 'yes_once');

    // 9b. Disappears with no answer, key arrives after 300 ms (e.g. at 350 ms) -> ignored
    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());
    monitor.closeActivePrompt('screen_cleared');
    await new Promise(r => setTimeout(r, 350)); // > 300 ms
    stdinMock.emit('data', Buffer.from('1')); // arrives too late

    historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    let closedEvTooLate = historyLines.filter(e => e.type === 'prompt_closed')[historyLines.filter(e => e.type === 'prompt_closed').length - 1];
    assert.strictEqual(closedEvTooLate.answer_key, 'unknown', 'Key arriving after 300 ms must be ignored');

    monitor.cleanup();
    console.log('✓ Test Group 6 passed: Final answer signals and timing rules verified');
  }

  // -------------------------------------------------------------
  // Test Group 7: Agreement Logic for Each Combination
  // -------------------------------------------------------------
  console.log('\n--- Test Group 7: Agreement Logic for Each Combination ---');
  {
    const wouldApprove = { action: 'would_approve' };
    const blocked = { action: 'blocked' };
    const needsUser = { action: 'needs_user' };

    // 1. would_approve + yes_once -> agrees
    assert.strictEqual(computeAgreement(wouldApprove, 1, 'yes_once'), 'agrees');
    assert.strictEqual(computeAgreement(wouldApprove, 'enter', 'yes_once'), 'agrees');

    // 2. would_approve + others -> differs
    assert.strictEqual(computeAgreement(wouldApprove, 2, 'yes_session'), 'differs');
    assert.strictEqual(computeAgreement(wouldApprove, 3, 'yes_persist'), 'differs');
    assert.strictEqual(computeAgreement(wouldApprove, 4, 'no'), 'differs');
    assert.strictEqual(computeAgreement(wouldApprove, 'esc', 'no'), 'differs');
    assert.strictEqual(computeAgreement(wouldApprove, 'amended', 'unknown'), 'differs');

    // 3. blocked + yes_once -> differs
    assert.strictEqual(computeAgreement(blocked, 1, 'yes_once'), 'differs');
    assert.strictEqual(computeAgreement(blocked, 'enter', 'yes_once'), 'differs');

    // 4. blocked + others -> agrees
    assert.strictEqual(computeAgreement(blocked, 2, 'yes_session'), 'agrees');
    assert.strictEqual(computeAgreement(blocked, 3, 'yes_persist'), 'agrees');
    assert.strictEqual(computeAgreement(blocked, 4, 'no'), 'agrees');
    assert.strictEqual(computeAgreement(blocked, 'esc', 'no'), 'agrees');
    assert.strictEqual(computeAgreement(blocked, 'amended', 'unknown'), 'agrees');

    // 5. needs_user + yes_once -> differs
    assert.strictEqual(computeAgreement(needsUser, 1, 'yes_once'), 'differs');
    assert.strictEqual(computeAgreement(needsUser, 'enter', 'yes_once'), 'differs');

    // 6. needs_user + others -> agrees
    assert.strictEqual(computeAgreement(needsUser, 2, 'yes_session'), 'agrees');
    assert.strictEqual(computeAgreement(needsUser, 3, 'yes_persist'), 'agrees');
    assert.strictEqual(computeAgreement(needsUser, 4, 'no'), 'agrees');
    assert.strictEqual(computeAgreement(needsUser, 'esc', 'no'), 'agrees');
    assert.strictEqual(computeAgreement(needsUser, 'amended', 'unknown'), 'agrees');

    // 7. unknown answer -> n/a
    assert.strictEqual(computeAgreement(wouldApprove, 'unknown', 'unknown'), 'n/a');
    assert.strictEqual(computeAgreement(blocked, 'unknown', 'unknown'), 'n/a');
    assert.strictEqual(computeAgreement(needsUser, 'unknown', 'unknown'), 'n/a');
    assert.strictEqual(computeAgreement(needsUser, null, 'unknown'), 'n/a');

    console.log('✓ Test Group 7 passed: Agreement logic verified for all combinations');
  }

  // -------------------------------------------------------------
  // Test Group 8: Privacy Rule - Fake Password & Keystroke Scan
  // -------------------------------------------------------------
  console.log('\n--- Test Group 8: Privacy Rule - Keystroke Text Leak Prevention ---');
  {
    const tmpDir = createTempDir();
    const historyPath = path.join(tmpDir, 'history.jsonl');
    const promptsLogPath = path.join(tmpDir, 'prompts.log');
    const snapshotsPath = path.join(tmpDir, 'screen-snapshots.txt');
    const sessionsDir = path.join(tmpDir, 'sessions');

    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};
    stdinMock.resume = () => {};
    stdinMock.pause = () => {};

    const stdoutMock = { columns: 100, rows: 30, write: () => {}, on: () => {}, removeListener: () => {} };
    const forwardedChunks = [];
    const ptyMock = {
      write: (chunk) => { forwardedChunks.push(chunk); },
      resize: () => {},
      onData: () => {},
      onExit: () => {}
    };

    const monitor = startAgentwatch({
      command: 'agy',
      stdin: stdinMock,
      stdout: stdoutMock,
      ptyProcess: ptyMock,
      historyPath,
      promptsLogPath,
      snapshotsPath,
      sessionsDir,
      profile: getProfileForCommand('agy')
    });

    const screenPrompt =
      'Requesting permission for:\r\n' +
      '   echo privacy-test\r\n' +
      'Run this command?\r\n' +
      '> 1. Yes, run command\r\n' +
      '  2. No, cancel\r\n' +
      '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
      'esc to cancel\r\n';

    await writeTerm(monitor.term, screenPrompt);
    monitor.inspectScreenForPrompts(Date.now());

    // Feed sensitive typed characters and fake password while prompt is on screen
    const fakePassword = 'SuperSecretPassword!987654321';
    const randomChars = 'XYZ_Random_Secret_Token_ABCD_1234';

    stdinMock.emit('data', Buffer.from(fakePassword));
    stdinMock.emit('data', Buffer.from(randomChars));
    // Then user answers with option 1
    stdinMock.emit('data', Buffer.from('1'));

    // Confirm input was strictly forwarded to child
    const totalForwarded = Buffer.concat(forwardedChunks.map(c => Buffer.isBuffer(c) ? c : Buffer.from(c))).toString();
    assert(totalForwarded.includes(fakePassword), 'Safety rule: child process MUST receive raw user keyboard input');
    assert(totalForwarded.includes(randomChars), 'Safety rule: child process MUST receive raw user keyboard input');

    monitor.closeActivePrompt('answered');
    monitor.cleanup();

    // Scan EVERY output file in tmpDir for the sensitive strings
    function scanDirForLeaks(dir) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const ent of entries) {
        const fullPath = path.join(dir, ent.name);
        if (ent.isDirectory()) {
          scanDirForLeaks(fullPath);
        } else {
          const fileContent = fs.readFileSync(fullPath, 'utf8');
          assert(!fileContent.includes(fakePassword), `LEAK DETECTED in ${fullPath}: fakePassword was written to disk!`);
          assert(!fileContent.includes(randomChars), `LEAK DETECTED in ${fullPath}: randomChars were written to disk!`);
        }
      }
    }

    scanDirForLeaks(tmpDir);
    console.log('✓ Test Group 8 passed: Zero keystroke text leaked to any output file (scanned history, prompts, snapshots, sessions)');
  }

  // -------------------------------------------------------------
  // Test Group 9: Child Process Hard Safety Rule Re-run
  // -------------------------------------------------------------
  console.log('\n--- Test Group 9: Child Process Input Safety Rule ---');
  {
    const srcDir = path.resolve(__dirname, '..', 'src');
    const srcFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));

    for (const file of srcFiles) {
      if (file === 'agentwatch.js') continue;
      const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
      assert(!content.includes('.write('), `File src/${file} must never contain .write() calls!`);
    }

    const agentwatchCode = fs.readFileSync(path.join(srcDir, 'agentwatch.js'), 'utf8');
    const writeMatches = agentwatchCode.match(/ptyProcess\.write\(/g) || [];
    assert(writeMatches.length > 0 && writeMatches.length <= 3,
      `ptyProcess.write must only be called in stdin handler or sendAutoAnswer, found ${writeMatches.length} occurrences`);
    assert(agentwatchCode.includes('function sendAutoAnswer('),
      'agentwatch.js must contain exactly one sendAutoAnswer function');

    console.log('✓ Test Group 9 passed: Hard safety rule verified (only user input and sendAutoAnswer single option key allowed)');
  }

  // -------------------------------------------------------------
  // Test Group 10: GUI History Cards & Top Summary Line Formatting
  // -------------------------------------------------------------
  console.log('\n--- Test Group 10: GUI History Cards & Top Summary Line ---');
  {
    // 1. formatPromptAnswer checks
    const p1 = {
      answer_key: 1,
      answer_class: 'yes_once',
      answer_option_text: 'Yes, run command',
      options: [{ number: 1, text: 'Yes, run command', classification: 'yes_once', label: 'yes once' }]
    };
    assert.strictEqual(formatPromptAnswer(p1), 'You chose: 1. Yes, run command (yes once)');

    const pEnter = {
      answer_key: 'enter',
      answer_class: 'yes_persist',
      answer_option_text: 'Yes, save',
      options: [{ number: 3, text: 'Yes, save', classification: 'yes_persist', label: 'yes and save' }]
    };
    assert.strictEqual(formatPromptAnswer(pEnter), 'You chose: 3. Yes, save (yes and save)');

    const pEsc = { answer_key: 'esc', answer_class: 'no' };
    assert.strictEqual(formatPromptAnswer(pEsc), 'You cancelled');

    const pAmended = { answer_key: 'amended', answer_class: 'unknown' };
    assert.strictEqual(formatPromptAnswer(pAmended), 'You amended');

    const pUnknown = { answer_key: 'unknown', answer_class: 'unknown' };
    assert.strictEqual(formatPromptAnswer(pUnknown), 'Answer: not detected');

    const pLegacy = {};
    assert.strictEqual(formatPromptAnswer(pLegacy), 'Answer: not recorded');

    // 2. groupHistoryBySession with answer and agreement
    const testEvents = [
      {
        type: 'session_started',
        time: '2026-07-02T10:00:00.000Z',
        sessionId: 'sess-stage3b',
        sessionKey: 'agy:default',
        folder: 'my-project',
        agent: 'agy'
      },
      {
        type: 'prompt',
        time: '2026-07-02T10:01:00.000Z',
        sessionId: 'sess-stage3b',
        sessionKey: 'agy:default',
        question: 'Run test?',
        command: { spaced: 'npm test', compact: 'npmtest' },
        options: [
          { number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { number: 2, text: 'No, cancel', classification: 'no' }
        ],
        decision: { action: 'would_approve', delay: 3 }
      },
      {
        type: 'prompt_closed',
        time: '2026-07-02T10:01:04.000Z',
        sessionId: 'sess-stage3b',
        sessionKey: 'agy:default',
        question: 'Run test?',
        command: { spaced: 'npm test', compact: 'npmtest' },
        options: [
          { number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { number: 2, text: 'No, cancel', classification: 'no' }
        ],
        decision: { action: 'would_approve', delay: 3 },
        answer_key: 1,
        answer_option_text: 'Yes, run command',
        answer_class: 'yes_once',
        agreement: 'agrees',
        durationSeconds: 4
      },
      {
        type: 'prompt',
        time: '2026-07-02T10:05:00.000Z',
        sessionId: 'sess-stage3b',
        sessionKey: 'agy:default',
        question: 'Delete files?',
        command: { spaced: 'rm -rf /tmp/foo', compact: 'rm-rf/tmp/foo' },
        options: [
          { number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { number: 2, text: 'No, cancel', classification: 'no' }
        ],
        decision: { action: 'blocked', rule: 'rm -rf' }
      },
      {
        type: 'prompt_closed',
        time: '2026-07-02T10:05:02.000Z',
        sessionId: 'sess-stage3b',
        sessionKey: 'agy:default',
        question: 'Delete files?',
        command: { spaced: 'rm -rf /tmp/foo', compact: 'rm-rf/tmp/foo' },
        options: [
          { number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { number: 2, text: 'No, cancel', classification: 'no' }
        ],
        decision: { action: 'blocked', rule: 'rm -rf' },
        answer_key: 2,
        answer_option_text: 'No, cancel',
        answer_class: 'no',
        agreement: 'agrees',
        durationSeconds: 2
      },
      {
        type: 'session_ended',
        time: '2026-07-02T10:10:00.000Z',
        sessionId: 'sess-stage3b',
        sessionKey: 'agy:default',
        durationSeconds: 600,
        exitCode: 0
      }
    ];

    const groups = groupHistoryBySession(testEvents);
    assert.strictEqual(groups.length, 1);
    assert.strictEqual(groups[0].prompts.length, 2);

    const promptCard1 = groups[0].prompts[0];
    assert.strictEqual(promptCard1.answer, 'You chose: 1. Yes, run command (yes once)');
    assert.strictEqual(promptCard1.agreement, 'agrees');

    const promptCard2 = groups[0].prompts[1];
    assert.strictEqual(promptCard2.answer, 'You chose: 2. No, cancel (no)');
    assert.strictEqual(promptCard2.agreement, 'agrees');

    // 3. Top Summary Line counting logic
    let knownAnswerCount = 0;
    let agreedCount = 0;
    let persistCount = 0;
    let needsYouCount = 0;

    groups.forEach(group => {
      (group.prompts || []).forEach(p => {
        const isKnown = p.answer_key !== undefined && p.answer_key !== null && p.answer_key !== 'unknown';
        if (isKnown) {
          knownAnswerCount++;
          if (p.agreement === 'agrees') {
            agreedCount++;
          }
        }
        if (p.answer_class === 'yes_persist') {
          persistCount++;
        }
        const isNeedsUser = (p.decision && p.decision.action === 'needs_user') ||
                            (typeof p.plainDecision === 'string' && p.plainDecision.toLowerCase().includes('needs you'));
        if (isNeedsUser) {
          needsYouCount++;
        }
      });
    });

    const summaryText = `Out of ${knownAnswerCount} prompts, the dry run would have handled ${agreedCount} the same way you did. Persist options chosen: ${persistCount} · Needs you prompts: ${needsYouCount}`;
    assert.strictEqual(summaryText, 'Out of 2 prompts, the dry run would have handled 2 the same way you did. Persist options chosen: 0 · Needs you prompts: 0');

    console.log('✓ Test Group 10 passed: History card answer formatting and top summary line calculation verified');
  }

  console.log('\n=========================================');
  console.log('All agentwatch Stage 3b tests passed successfully!');
  console.log('=========================================\n');
}

runStage3bTests().catch(err => {
  console.error('\nStage 3b tests failed:', err);
  process.exit(1);
});
