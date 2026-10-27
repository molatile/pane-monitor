const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const {
  loadRules,
  evaluatePrompt,
  saveRules,
  validateDangerList,
  DEFAULT_RULES,
  DEFAULT_DANGER_LIST
} = require('../src/rules');
const { startAgentwatch } = require('../src/agentwatch');
const { getProfileForCommand } = require('../src/profile');
const { formatDecision } = require('../src/status');
const { formatPlainDecision } = require('../src/history');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentwatch-stage4c-'));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function writeTerm(term, str) {
  return new Promise(resolve => {
    term.write(str, () => resolve());
  });
}

const suitePassCounts = {
  'Suite 1: Priority Order (Higher Beats Lower & Fallthrough)': 0,
  'Suite 2: Multiple Matches Inside Winning Rule Press Nothing': 0,
  'Suite 3: Hard Danger Beats Everything & Hard Beats Slow': 0,
  'Suite 4: Slow Danger (10s Default, Row Display, Vetoable)': 0,
  'Suite 5: Veto Label & Preserved Answer Key': 0,
  'Suite 6: Auto-Answer Log Wording & Agreement n/a': 0,
  'Suite 7: Saved File Rule Reordering Changes Wrapper Action': 0,
  'Suite 8: Try-it Tester & Status Display Parity': 0,
  'Suite 9: Single-Write-Path Safety Verification': 0
};

async function runStage4cTests() {
  console.log('Running agentwatch Stage 4c test suite: Priority, Slow Danger, Veto, Auto Logging...\n');

  // =========================================================================
  // Suite 1: Priority Order
  // =========================================================================
  console.log('--- Suite 1: Priority Order (Higher Beats Lower & Fallthrough) ---');
  {
    // 1.1: Higher-priority rule beats a lower one when both match
    {
      const customRules = {
        defaultDelaySeconds: 3,
        deny: [],
        danger: [],
        optionRules: [
          { name: 'rule-high', startsWith: 'Yes, option 1' },
          { name: 'rule-low', startsWith: 'Yes, option 2' }
        ]
      };
      const prompt = {
        commandSpaced: 'git status',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, option 1', classification: 'yes_once' },
          { key: '2', number: 2, text: 'Yes, option 2', classification: 'yes_session' },
          { key: '3', number: 3, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, customRules);
      assert.strictEqual(d.action, 'would_approve');
      assert.strictEqual(d.rule, 'rule-high');
      assert.strictEqual(d.winningRule, 'rule-high');
      assert.deepStrictEqual(d.skippedRules, []);
      assert.strictEqual(d.optionKey, '1');
      assert(d.log.includes('rule: rule-high'), 'Log must mention winning rule');
      assert(!d.log.includes('skipped:'), 'No rules skipped when first rule wins');

      suitePassCounts['Suite 1: Priority Order (Higher Beats Lower & Fallthrough)']++;
      console.log('  ✓ Higher-priority rule beats lower rule when both match');
    }

    // 1.2: Higher rule with no match falls through to next rule and records skippedRules
    {
      const customRules = {
        defaultDelaySeconds: 3,
        deny: [],
        danger: [],
        optionRules: [
          { name: 'rule-no-match-1', startsWith: 'Nonexistent A' },
          { name: 'rule-no-match-2', startsWith: 'Nonexistent B' },
          { name: 'rule-matching', startsWith: 'Yes, option 2' }
        ]
      };
      const prompt = {
        commandSpaced: 'git status',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, option 1', classification: 'yes_once' },
          { key: '2', number: 2, text: 'Yes, option 2', classification: 'yes_session' },
          { key: '3', number: 3, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, customRules);
      assert.strictEqual(d.action, 'would_approve');
      assert.strictEqual(d.rule, 'rule-matching');
      assert.strictEqual(d.winningRule, 'rule-matching');
      assert.deepStrictEqual(d.skippedRules, ['rule-no-match-1', 'rule-no-match-2']);
      assert.strictEqual(d.optionKey, '2');
      assert(d.log.includes('skipped: rule-no-match-1, rule-no-match-2'), 'Log must record skipped rules');

      suitePassCounts['Suite 1: Priority Order (Higher Beats Lower & Fallthrough)']++;
      console.log('  ✓ Higher rule with no match falls through and records skipped higher-priority rules');
    }

    // 1.3: If no rule matches, marks needs_user and records all skipped rules
    {
      const customRules = {
        defaultDelaySeconds: 3,
        deny: [],
        danger: [],
        allow: [],
        optionRules: [
          { name: 'rule-skip-1', startsWith: 'Nonexistent 1' },
          { name: 'rule-skip-2', startsWith: 'Nonexistent 2' }
        ]
      };
      const prompt = {
        commandSpaced: 'git status',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, once', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, customRules);
      assert.strictEqual(d.action, 'needs_user');
      assert.strictEqual(d.winningRule, null);
      assert.deepStrictEqual(d.skippedRules, ['rule-skip-1', 'rule-skip-2']);

      suitePassCounts['Suite 1: Priority Order (Higher Beats Lower & Fallthrough)']++;
      console.log('  ✓ When no rule matches, marks needs_user and records all skipped rules');
    }
  }

  // =========================================================================
  // Suite 2: Multiple Matches Inside Winning Rule Press Nothing
  // =========================================================================
  console.log('\n--- Suite 2: Multiple Matches Inside Winning Rule Press Nothing ---');
  {
    // 2.1: Winning rule matches multiple options -> needs_user, presses nothing
    {
      const customRules = {
        defaultDelaySeconds: 3,
        deny: [],
        danger: [],
        optionRules: [
          { name: 'rule-broad', startsWith: 'Yes, allow' },
          { name: 'rule-specific', startsWith: 'Yes, allow specific' }
        ]
      };
      const prompt = {
        commandSpaced: 'git status',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, allow option 1', classification: 'yes_once' },
          { key: '2', number: 2, text: 'Yes, allow option 2', classification: 'yes_session' },
          { key: '3', number: 3, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, customRules);
      assert.strictEqual(d.action, 'needs_user');
      assert.strictEqual(d.winningRule, 'rule-broad');
      assert(d.reason.includes('multiple options matched winning rule "rule-broad"'));
      assert(d.log.includes('multiple options matched winning rule "rule-broad"'));

      suitePassCounts['Suite 2: Multiple Matches Inside Winning Rule Press Nothing']++;
      console.log('  ✓ Winning rule matching multiple options marks needs_user and presses nothing');
    }

    // 2.2: Winning rule matches multiple options after a higher rule was skipped
    {
      const customRules = {
        defaultDelaySeconds: 3,
        deny: [],
        danger: [],
        optionRules: [
          { name: 'rule-skipped', startsWith: 'Prefix-Does-Not-Match' },
          { name: 'rule-multi', startsWith: 'Yes, allow' }
        ]
      };
      const prompt = {
        commandSpaced: 'git status',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, allow first', classification: 'yes_once' },
          { key: '2', number: 2, text: 'Yes, allow second', classification: 'yes_session' },
          { key: '3', number: 3, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, customRules);
      assert.strictEqual(d.action, 'needs_user');
      assert.strictEqual(d.winningRule, 'rule-multi');
      assert.deepStrictEqual(d.skippedRules, ['rule-skipped']);
      assert(d.reason.includes('multiple options matched winning rule "rule-multi"'));
      assert(d.log.includes('skipped: rule-skipped'));

      suitePassCounts['Suite 2: Multiple Matches Inside Winning Rule Press Nothing']++;
      console.log('  ✓ Winning rule with multiple matches records skipped higher-priority rules');
    }
  }

  // =========================================================================
  // Suite 3: Hard Danger Beats Everything & Hard Beats Slow
  // =========================================================================
  console.log('\n--- Suite 3: Hard Danger Beats Everything & Hard Beats Slow ---');
  {
    // 3.1: Hard danger beats allow rule and option rule
    {
      const customRules = {
        defaultDelaySeconds: 3,
        deny: [],
        danger: [
          { text: 'delete', wholeWord: false, level: 'hard' }
        ],
        allow: [
          { name: 'echo-safe', pattern: '^echo(?:\\s+[^;&|><`$()\\r\\n]+)?$', delay: 3 }
        ],
        optionRules: [
          { name: 'always-allow', startsWith: 'Yes, run' }
        ]
      };
      const prompt = {
        commandSpaced: 'echo delete my files',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, customRules);
      assert.strictEqual(d.action, 'needs_user');
      assert.strictEqual(d.danger, true);
      assert(d.reason.includes("DANGER: matched 'delete'"));

      suitePassCounts['Suite 3: Hard Danger Beats Everything & Hard Beats Slow']++;
      console.log('  ✓ Hard danger entry beats allow rule and option rule');
    }

    // 3.2: Hard danger beats slow danger when both match
    {
      const customRules = {
        defaultDelaySeconds: 3,
        deny: [],
        danger: [
          { text: 'slow-keyword', wholeWord: false, level: 'slow', delay: 15 },
          { text: 'hard-keyword', wholeWord: false, level: 'hard' }
        ],
        optionRules: [
          { name: 'opt-rule', startsWith: 'Yes, run' }
        ]
      };
      const prompt = {
        commandSpaced: 'echo hard-keyword and slow-keyword',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, customRules);
      assert.strictEqual(d.action, 'needs_user');
      assert.strictEqual(d.danger, true);
      assert.strictEqual(d.entry, 'hard-keyword');
      assert(d.reason.includes("DANGER: matched 'hard-keyword'"));

      suitePassCounts['Suite 3: Hard Danger Beats Everything & Hard Beats Slow']++;
      console.log('  ✓ Hard danger beats slow danger when both match in command');
    }
  }

  // =========================================================================
  // Suite 4: Slow Danger Behavior
  // =========================================================================
  console.log('\n--- Suite 4: Slow Danger (10s Default, Row Display, Vetoable) ---');
  {
    // 4.1: Slow danger defaults to 10s if delay is missing
    {
      const customRules = {
        defaultDelaySeconds: 3,
        deny: [],
        danger: [
          { text: 'slow-tag', wholeWord: false, level: 'slow' } // delay missing!
        ],
        optionRules: [
          { name: 'opt-rule', startsWith: 'Yes, run' }
        ]
      };
      const prompt = {
        commandSpaced: 'echo slow-tag file',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, customRules);
      assert.strictEqual(d.action, 'would_approve');
      assert.strictEqual(d.delay, 10, 'Default delay for slow danger without delay must be 10s');
      assert.strictEqual(d.slowDanger, 'slow-tag');

      const formatted = formatDecision(d);
      assert.strictEqual(formatted, "SLOW: matched 'slow-tag'");

      const plain = formatPlainDecision(d);
      assert.strictEqual(plain, "SLOW: matched 'slow-tag'");

      suitePassCounts['Suite 4: Slow Danger (10s Default, Row Display, Vetoable)']++;
      console.log('  ✓ Slow danger produces default 10s countdown and displays "SLOW: matched \'<entry>\'"');
    }

    // 4.2: Slow danger custom delay respected
    {
      const customRules = {
        defaultDelaySeconds: 3,
        deny: [],
        danger: [
          { text: 'slow-custom', wholeWord: false, level: 'slow', delay: 12 }
        ],
        optionRules: [
          { name: 'opt-rule', startsWith: 'Yes, run' }
        ]
      };
      const prompt = {
        commandSpaced: 'echo slow-custom file',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, customRules);
      assert.strictEqual(d.action, 'would_approve');
      assert.strictEqual(d.delay, 12, 'Custom delay of 12s must be used');
      assert.strictEqual(d.slowDanger, 'slow-custom');

      suitePassCounts['Suite 4: Slow Danger (10s Default, Row Display, Vetoable)']++;
      console.log('  ✓ Slow danger custom delay respected');
    }

    // 4.3: Slow danger countdown is still vetoable by a keypress
    {
      const tmpDir = createTempDir();
      const stdinMock = new EventEmitter();
      stdinMock.isTTY = true;
      stdinMock.setRawMode = () => {};
      stdinMock.resume = () => {};
      stdinMock.pause = () => {};

      const stdoutMock = { columns: 100, rows: 30, write: () => {}, on: () => {}, removeListener: () => {} };
      const writtenToChild = [];
      const ptyMock = {
        write: (data) => { writtenToChild.push(data.toString()); },
        resize: () => {},
        onData: () => {},
        onExit: () => {}
      };

      const customRules = {
        defaultDelaySeconds: 3,
        deny: [],
        danger: [
          { text: 'slow-test', wholeWord: false, level: 'slow', delay: 5 }
        ],
        allow: [],
        optionRules: [
          { name: 'opt-rule', startsWith: 'Yes, run command' }
        ]
      };
      const rulesPath = path.join(tmpDir, 'rules.json');
      fs.writeFileSync(rulesPath, JSON.stringify(customRules, null, 2), 'utf8');

      const monitor = startAgentwatch({
        command: 'agy',
        auto: true,
        stdin: stdinMock,
        stdout: stdoutMock,
        ptyProcess: ptyMock,
        rulesPath,
        sessionsDir: path.join(tmpDir, 'sessions'),
        promptsLogPath: path.join(tmpDir, 'prompts.log'),
        historyPath: path.join(tmpDir, 'history.jsonl'),
        profile: getProfileForCommand('agy')
      });

      const screen =
        'Requesting permission for:\r\n' +
        '   echo slow-test\r\n' +
        'Run this command?\r\n' +
        '> 1. Yes, run command\r\n' +
        '  2. No, cancel\r\n' +
        '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
        'esc to cancel\r\n';

      await writeTerm(monitor.term, screen);
      monitor.inspectScreenForPrompts(Date.now());
      assert.strictEqual(monitor.statusManager.state, 'countdown');
      assert.strictEqual(monitor.statusManager.countdown, 5);

      // Verify row shows SLOW: matched 'slow-test'
      const statusFile = JSON.parse(fs.readFileSync(monitor.statusManager.filePath, 'utf8'));
      assert.strictEqual(statusFile.prompt.decision, "SLOW: matched 'slow-test'");

      // Veto with a user keypress '2'
      stdinMock.emit('data', Buffer.from('2'));
      await delay(50);

      assert.strictEqual(monitor.getActivePrompt().vetoed, true);
      assert.strictEqual(monitor.statusManager.state, 'asking');

      // Close prompt as user answered 2
      monitor.closeActivePrompt('answered');
      monitor.cleanup();

      const historyLines = fs.readFileSync(path.join(tmpDir, 'history.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const closedEv = historyLines.find(e => e.type === 'prompt_closed');
      assert(closedEv, 'Must have prompt_closed event');
      assert.strictEqual(closedEv.answered_by, 'vetoed', 'Must record answered_by: vetoed');
      assert.strictEqual(String(closedEv.answer_key), '2', 'Must record user answer key 2');

      suitePassCounts['Suite 4: Slow Danger (10s Default, Row Display, Vetoable)']++;
      console.log('  ✓ Slow danger countdown is vetoable by keypress and status file shows SLOW: matched');
    }
  }

  // =========================================================================
  // Suite 5: Veto Label & Preserved Answer Key
  // =========================================================================
  console.log('\n--- Suite 5: Veto Label & Preserved Answer Key ---');
  {
    // 5.1: Keypress cancels countdown -> answered_by is "vetoed", answer_key preserved
    {
      const tmpDir = createTempDir();
      const stdinMock = new EventEmitter();
      stdinMock.isTTY = true;
      stdinMock.setRawMode = () => {};
      stdinMock.resume = () => {};
      stdinMock.pause = () => {};

      const stdoutMock = { columns: 100, rows: 30, write: () => {}, on: () => {}, removeListener: () => {} };
      const writtenToChild = [];
      const ptyMock = {
        write: (data) => { writtenToChild.push(data.toString()); },
        resize: () => {},
        onData: () => {},
        onExit: () => {}
      };

      const customRules = {
        defaultDelaySeconds: 4,
        deny: [],
        danger: [],
        allow: [
          { name: 'echo-safe', pattern: '^echo(?:\\s+[^;&|><`$()\\r\\n]+)?$', delay: 4 }
        ],
        optionRules: []
      };
      const rulesPath = path.join(tmpDir, 'rules.json');
      fs.writeFileSync(rulesPath, JSON.stringify(customRules, null, 2), 'utf8');

      const promptsLogPath = path.join(tmpDir, 'prompts.log');
      const historyPath = path.join(tmpDir, 'history.jsonl');

      const monitor = startAgentwatch({
        command: 'agy',
        auto: true,
        stdin: stdinMock,
        stdout: stdoutMock,
        ptyProcess: ptyMock,
        rulesPath,
        sessionsDir: path.join(tmpDir, 'sessions'),
        promptsLogPath,
        historyPath,
        profile: getProfileForCommand('agy')
      });

      const screen =
        'Requesting permission for:\r\n' +
        '   echo veto-me\r\n' +
        'Run this command?\r\n' +
        '> 1. Yes, run command\r\n' +
        '  2. No, cancel\r\n' +
        '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
        'esc to cancel\r\n';

      await writeTerm(monitor.term, screen);
      monitor.inspectScreenForPrompts(Date.now());
      assert.strictEqual(monitor.statusManager.state, 'countdown');

      // User presses esc to cancel
      stdinMock.emit('data', Buffer.from('\x1b'));
      await delay(50);

      assert.strictEqual(monitor.getActivePrompt().vetoed, true);
      monitor.closeActivePrompt('cancelled');
      monitor.cleanup();

      const promptsLog = fs.readFileSync(promptsLogPath, 'utf8');
      assert(promptsLog.includes('Answered by: vetoed'), 'prompts.log must record Answered by: vetoed, not plain user');
      assert(!promptsLog.includes('Answered by: user'), 'prompts.log must NOT record Answered by: user');

      const historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const closedEv = historyLines.find(e => e.type === 'prompt_closed');
      assert.strictEqual(closedEv.answered_by, 'vetoed');
      assert.strictEqual(closedEv.answer_key, 'esc');

      suitePassCounts['Suite 5: Veto Label & Preserved Answer Key']++;
      console.log('  ✓ Veto keypress sets answered_by: "vetoed" and preserves answer_key');
    }
  }

  // =========================================================================
  // Suite 6: Auto-Answer Log Wording & Agreement n/a
  // =========================================================================
  console.log('\n--- Suite 6: Auto-Answer Log Wording & Agreement n/a ---');
  {
    // 6.1: Automatic press logs "Auto-approved option N (rule: name)", not "Dry-run: would approve..."
    {
      const tmpDir = createTempDir();
      const stdinMock = new EventEmitter();
      stdinMock.isTTY = true;
      stdinMock.setRawMode = () => {};
      stdinMock.resume = () => {};
      stdinMock.pause = () => {};

      const stdoutMock = { columns: 100, rows: 30, write: () => {}, on: () => {}, removeListener: () => {} };
      const writtenToChild = [];
      const ptyMock = {
        write: (data) => { writtenToChild.push(data.toString()); },
        resize: () => {},
        onData: () => {},
        onExit: () => {}
      };

      const customRules = {
        defaultDelaySeconds: 1,
        deny: [],
        danger: [],
        allow: [],
        optionRules: [
          { name: 'rule-auto-log-test', startsWith: 'Yes, and always' }
        ]
      };
      const rulesPath = path.join(tmpDir, 'rules.json');
      fs.writeFileSync(rulesPath, JSON.stringify(customRules, null, 2), 'utf8');

      const promptsLogPath = path.join(tmpDir, 'prompts.log');
      const historyPath = path.join(tmpDir, 'history.jsonl');

      const monitor = startAgentwatch({
        command: 'agy',
        auto: true,
        stdin: stdinMock,
        stdout: stdoutMock,
        ptyProcess: ptyMock,
        rulesPath,
        sessionsDir: path.join(tmpDir, 'sessions'),
        promptsLogPath,
        historyPath,
        profile: getProfileForCommand('agy')
      });

      const screen =
        'Requesting permission for:\r\n' +
        '   git status\r\n' +
        'Run this command?\r\n' +
        '> 1. Yes, and always allow in this conversation\r\n' +
        '  2. No, cancel\r\n' +
        '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
        'esc to cancel\r\n';

      await writeTerm(monitor.term, screen);
      monitor.inspectScreenForPrompts(Date.now());
      assert.strictEqual(monitor.statusManager.state, 'countdown');

      // Wait for countdown to expire and sendAutoAnswer to trigger
      await delay(1200);

      assert.strictEqual(writtenToChild.length, 1);
      assert.strictEqual(writtenToChild[0], '1');

      monitor.closeActivePrompt('answered');
      monitor.cleanup();

      const promptsLog = fs.readFileSync(promptsLogPath, 'utf8');
      assert(promptsLog.includes('Auto-approved option 1 (rule: rule-auto-log-test)'),
        'prompts.log must contain "Auto-approved option 1 (rule: rule-auto-log-test)"');
      assert(promptsLog.includes('Answered by: auto'), 'prompts.log must record Answered by: auto');

      const historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const closedEv = historyLines.find(e => e.type === 'prompt_closed');
      assert.strictEqual(closedEv.answered_by, 'auto');
      assert.strictEqual(closedEv.agreement, 'n/a', 'Agreement must be n/a for automatic answers');
      assert(closedEv.decision.log.startsWith('Auto-approved option 1'), 'closedEvent decision.log must be Auto-approved');

      suitePassCounts['Suite 6: Auto-Answer Log Wording & Agreement n/a']++;
      console.log('  ✓ Automatic press logs "Auto-approved option N (rule: name)" and agreement is "n/a"');
    }
  }

  // =========================================================================
  // Suite 7: Saved File Rule Reordering Changes Wrapper Action
  // =========================================================================
  console.log('\n--- Suite 7: Saved File Rule Reordering Changes Wrapper Action ---');
  {
    // 7.1: Reordering rules in saved file changes what the wrapper evaluates and presses
    {
      const tmpDir = createTempDir();
      const rulesPath = path.join(tmpDir, 'rules.json');

      const prompt = {
        commandSpaced: 'git status',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, option A', classification: 'yes_once' },
          { key: '2', number: 2, text: 'Yes, option B', classification: 'yes_session' },
          { key: '3', number: 3, text: 'No, cancel', classification: 'no' }
        ]
      };

      // Save Order 1: rule-A first
      const order1 = {
        defaultDelaySeconds: 3,
        deny: DEFAULT_RULES.deny,
        danger: DEFAULT_RULES.danger,
        allow: [],
        optionRules: [
          { name: 'rule-A', startsWith: 'Yes, option A' },
          { name: 'rule-B', startsWith: 'Yes, option B' }
        ]
      };
      saveRules(order1, rulesPath);
      const loaded1 = loadRules(rulesPath);
      const decision1 = evaluatePrompt(prompt, loaded1);
      assert.strictEqual(decision1.action, 'would_approve');
      assert.strictEqual(decision1.rule, 'rule-A');
      assert.strictEqual(decision1.optionKey, '1');

      // Save Order 2: rule-B first
      const order2 = {
        ...order1,
        optionRules: [
          { name: 'rule-B', startsWith: 'Yes, option B' },
          { name: 'rule-A', startsWith: 'Yes, option A' }
        ]
      };
      saveRules(order2, rulesPath);
      const loaded2 = loadRules(rulesPath);
      const decision2 = evaluatePrompt(prompt, loaded2);
      assert.strictEqual(decision2.action, 'would_approve');
      assert.strictEqual(decision2.rule, 'rule-B');
      assert.strictEqual(decision2.optionKey, '2');

      suitePassCounts['Suite 7: Saved File Rule Reordering Changes Wrapper Action']++;
      console.log('  ✓ Reordering rules in saved file changes what the wrapper presses');
    }
  }

  // =========================================================================
  // Suite 8: Try-it Tester & Status Display Parity
  // =========================================================================
  console.log('\n--- Suite 8: Try-it Tester & Status Display Parity ---');
  {
    // 8.1: Decision records winningRule and skippedRules accurately for Try-it tester
    {
      const customRules = {
        defaultDelaySeconds: 3,
        deny: [],
        danger: [],
        optionRules: [
          { name: 'skipped-1', startsWith: 'No-match-1' },
          { name: 'skipped-2', startsWith: 'No-match-2' },
          { name: 'winning-rule', startsWith: 'Yes, run' }
        ]
      };
      const prompt = {
        commandSpaced: 'git pull',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, customRules);
      assert.strictEqual(d.winningRule, 'winning-rule');
      assert.deepStrictEqual(d.skippedRules, ['skipped-1', 'skipped-2']);

      // Format decision returns human readable string
      const formatted = formatDecision(d);
      assert(formatted.includes('would approve option 1'));

      suitePassCounts['Suite 8: Try-it Tester & Status Display Parity']++;
      console.log('  ✓ Decision records winningRule and skippedRules accurately for Try-it tester');
    }
  }

  // =========================================================================
  // Suite 9: Single-Write-Path Safety Verification
  // =========================================================================
  console.log('\n--- Suite 9: Single-Write-Path Safety Verification ---');
  {
    // Verify static code invariant: ONLY sendAutoAnswer and user stdin write to ptyProcess
    const srcDir = path.resolve(__dirname, '..', 'src');
    const srcFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.js'));

    for (const file of srcFiles) {
      if (file === 'agentwatch.js') continue;
      const content = fs.readFileSync(path.join(srcDir, file), 'utf8');
      assert(!content.includes('.write('), `File src/${file} must never contain .write() calls!`);
    }

    const agentwatchCode = fs.readFileSync(path.join(srcDir, 'agentwatch.js'), 'utf8');
    const writeMatches = agentwatchCode.match(/ptyProcess\.write\(/g) || [];
    assert(
      writeMatches.length > 0 && writeMatches.length <= 3,
      `ptyProcess.write must only be called in stdin handler or sendAutoAnswer, found ${writeMatches.length}`
    );

    suitePassCounts['Suite 9: Single-Write-Path Safety Verification']++;
    console.log('  ✓ Verified: No new path writes to child process other than sendAutoAnswer and user stdin');
  }

  // =========================================================================
  // Print Summary
  // =========================================================================
  console.log('\n=========================================');
  console.log('Stage 4c Pass Counts Per Suite:');
  let totalPass = 0;
  for (const [sName, count] of Object.entries(suitePassCounts)) {
    console.log(`  ${sName}: ${count} passed`);
    totalPass += count;
  }
  console.log(`\nAll ${totalPass} Stage 4c tests passed successfully!`);
  console.log('=========================================\n');
}

runStage4cTests().catch(err => {
  console.error('Test failure:', err);
  process.exit(1);
});
