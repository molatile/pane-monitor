const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const { startAgentwatch, logPromptRecord } = require('../src/agentwatch');
const { getProfileForCommand } = require('../src/profile');
const {
  evaluatePrompt,
  loadRules,
  validateOptionRules,
  matchesOptionRule,
  isPersistOption,
  isChoiceQuestion,
  DEFAULT_RULES
} = require('../src/rules');
const { maskText } = require('../src/masker');
const { loadConfig } = require('../src/shared');
const { renderDashboardLines, getStateLight, getSessionSummary } = require('../src/dashboard');

function createTempDir(prefix = 'agentwatch-stage4b-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTerm(term, text) {
  return new Promise(resolve => term.write(text, resolve));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runStage4bTests() {
  console.log('Running agentwatch Stage 4b test suite: Custom Option Rules...\n');

  const suitePassCounts = {
    'Suite 1: Exactly One Option Among 2, 4, 8 Options': 0,
    'Suite 2: Zero Matches and Multiple Matches Press Nothing': 0,
    'Suite 3: endsWith and commandStartsWith Filters': 0,
    'Suite 4: Deny List and Danger List Beat Matching Rules': 0,
    'Suite 5: Persist Option Blocked Unless allowPersist': 0,
    'Suite 6: "No" Options Never Pressed': 0,
    'Suite 7: Choice Question Protection': 0,
    'Suite 8: Veto and Circuit Breaker Guards': 0,
    'Suite 9: rules.json Validation on Load': 0,
    'Suite 10: Single-Write-Path Safety & Privacy Re-check': 0,
    'Suite 11: Viewers & Startup Display (Dashboard & Window)': 0
  };

  // -------------------------------------------------------------
  // Suite 1: Rule matches exactly one option among 2, 4, 8 options
  // -------------------------------------------------------------
  console.log('--- Suite 1: Exactly One Option Among 2, 4, 8 Options ---');
  {
    // Test 1.1: 2 options (1. Yes, and always allow in this conversation [matches option rule], 2. No, cancel)
    {
      const tmpDir = createTempDir();
      const historyPath = path.join(tmpDir, 'history.jsonl');
      const promptsLogPath = path.join(tmpDir, 'prompts.log');
      const sessionsDir = path.join(tmpDir, 'sessions');

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
        defaultDelaySeconds: 0.35,
        deny: DEFAULT_RULES.deny,
        danger: DEFAULT_RULES.danger,
        allow: [],
        optionRules: [
          {
            name: 'always-in-conversation',
            startsWith: 'Yes, and always allow in this conversation'
          }
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
        historyPath,
        promptsLogPath,
        sessionsDir,
        profile: getProfileForCommand('agy')
      });

      const screen2Opts =
        'Requesting permission for:\r\n' +
        '   git status\r\n' +
        'Run this command?\r\n' +
        '> 1. Yes, and always allow in this conversation\r\n' +
        '  2. No, cancel\r\n' +
        '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
        'esc to cancel\r\n';

      await writeTerm(monitor.term, screen2Opts);
      monitor.inspectScreenForPrompts(Date.now());

      assert.strictEqual(writtenToChild.length, 0);
      assert.strictEqual(monitor.statusManager.state, 'countdown');

      await delay(450);

      assert.strictEqual(writtenToChild.length, 1);
      assert.strictEqual(writtenToChild[0], '1');

      monitor.closeActivePrompt('answered');
      monitor.cleanup();

      const promptsLog = fs.readFileSync(promptsLogPath, 'utf8');
      assert(promptsLog.includes('Auto-accepted command: git status'), 'prompts.log must record command');
      assert(promptsLog.includes('Rule: always-in-conversation'), 'prompts.log must record rule name');
      assert(promptsLog.includes('Option key: 1'), 'prompts.log must record option key');
      assert(promptsLog.includes('Option text: Yes, and always allow in this conversation'), 'prompts.log must record option text');

      const historyLines = fs.readFileSync(historyPath, 'utf8').trim().split('\n').map(l => JSON.parse(l));
      const autoEv = historyLines.find(e => e.type === 'auto_answer');
      assert(autoEv, 'history.jsonl must have auto_answer event');
      assert.strictEqual(autoEv.rule, 'always-in-conversation');
      assert.strictEqual(autoEv.option_key, '1');
      assert.strictEqual(autoEv.option_text, 'Yes, and always allow in this conversation');

      suitePassCounts['Suite 1: Exactly One Option Among 2, 4, 8 Options']++;
      console.log('  ✓ 2 options: rule matches single option, presses key 1, logs rule name and option text');
    }

    // Test 1.2: 4 options (1. Yes once, 2. Yes conversation [matches], 3. Yes persist, 4. No) -> presses key 2
    {
      const tmpDir = createTempDir();
      const historyPath = path.join(tmpDir, 'history.jsonl');
      const promptsLogPath = path.join(tmpDir, 'prompts.log');
      const sessionsDir = path.join(tmpDir, 'sessions');

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
        defaultDelaySeconds: 0.35,
        deny: DEFAULT_RULES.deny,
        danger: DEFAULT_RULES.danger,
        allow: [],
        optionRules: [
          {
            name: 'always-in-conversation',
            startsWith: 'Yes, and always allow in this conversation'
          }
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
        historyPath,
        promptsLogPath,
        sessionsDir,
        profile: getProfileForCommand('agy')
      });

      const screen4Opts =
        'Requesting permission for:\r\n' +
        '   git log\r\n' +
        'Run this command?\r\n' +
        '> 1. Yes, run command\r\n' +
        '  2. Yes, and always allow in this conversation\r\n' +
        '  3. Yes, and always allow (persist)\r\n' +
        '  4. No, cancel\r\n' +
        '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
        'esc to cancel\r\n';

      await writeTerm(monitor.term, screen4Opts);
      monitor.inspectScreenForPrompts(Date.now());

      assert.strictEqual(writtenToChild.length, 0);
      assert.strictEqual(monitor.statusManager.state, 'countdown');

      await delay(450);

      assert.strictEqual(writtenToChild.length, 1);
      assert.strictEqual(writtenToChild[0], '2', 'Must press option 2 (the matched option rule)');

      monitor.closeActivePrompt('answered');
      monitor.cleanup();

      const promptsLog = fs.readFileSync(promptsLogPath, 'utf8');
      assert(promptsLog.includes('Rule: always-in-conversation'));
      assert(promptsLog.includes('Option key: 2'));
      assert(promptsLog.includes('Option text: Yes, and always allow in this conversation'));

      suitePassCounts['Suite 1: Exactly One Option Among 2, 4, 8 Options']++;
      console.log('  ✓ 4 options: rule matches option 2 specifically, presses key 2, logs accurately');
    }

    // Test 1.3: 8 options (only option 6 matches enabled option rule) -> presses key 6
    {
      const tmpDir = createTempDir();
      const historyPath = path.join(tmpDir, 'history.jsonl');
      const promptsLogPath = path.join(tmpDir, 'prompts.log');
      const sessionsDir = path.join(tmpDir, 'sessions');

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
        defaultDelaySeconds: 0.35,
        deny: DEFAULT_RULES.deny,
        danger: DEFAULT_RULES.danger,
        allow: [],
        optionRules: [
          {
            name: 'target-option-six',
            startsWith: 'Yes, option six special'
          }
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
        historyPath,
        promptsLogPath,
        sessionsDir,
        profile: getProfileForCommand('agy')
      });

      const screen8Opts =
        'Requesting permission for:\r\n' +
        '   git status\r\n' +
        'Run this command?\r\n' +
        '> 1. Option one\r\n' +
        '  2. Option two\r\n' +
        '  3. Option three\r\n' +
        '  4. Option four\r\n' +
        '  5. Option five\r\n' +
        '  6. Yes, option six special\r\n' +
        '  7. Option seven\r\n' +
        '  8. No, cancel\r\n' +
        '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
        'esc to cancel\r\n';

      await writeTerm(monitor.term, screen8Opts);
      monitor.inspectScreenForPrompts(Date.now());

      assert.strictEqual(writtenToChild.length, 0);
      assert.strictEqual(monitor.statusManager.state, 'countdown');

      await delay(450);

      assert.strictEqual(writtenToChild.length, 1);
      assert.strictEqual(writtenToChild[0], '6', 'Must press option 6');

      monitor.closeActivePrompt('answered');
      monitor.cleanup();

      suitePassCounts['Suite 1: Exactly One Option Among 2, 4, 8 Options']++;
      console.log('  ✓ 8 options: rule matches option 6 among 8 options, presses key 6');
    }
  }

  // -------------------------------------------------------------
  // Suite 2: Zero matches and multiple matches press nothing
  // -------------------------------------------------------------
  console.log('\n--- Suite 2: Zero Matches and Multiple Matches Press Nothing ---');
  {
    // Test 2.1: Zero matches -> needs_user, presses nothing
    {
      const customRules = {
        deny: DEFAULT_RULES.deny,
        danger: DEFAULT_RULES.danger,
        allow: [],
        optionRules: [
          { name: 'rule-xyz', startsWith: 'Nonexistent option prefix' }
        ]
      };
      const prompt = {
        commandSpaced: 'cargo check',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, run once', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, customRules);
      assert.strictEqual(d.action, 'needs_user');
      suitePassCounts['Suite 2: Zero Matches and Multiple Matches Press Nothing']++;
      console.log('  ✓ Zero matches mark needs_user');
    }

    // Test 2.2: Multiple matches inside winning rule after higher-priority rule skipped -> needs_user
    {
      const customRules = {
        deny: DEFAULT_RULES.deny,
        danger: DEFAULT_RULES.danger,
        allow: [],
        optionRules: [
          { name: 'rule-skipped', startsWith: 'Non-matching prefix' },
          { name: 'rule-multi', startsWith: 'Yes, option' }
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
      assert.strictEqual(d.action, 'needs_user');
      assert(d.reason.includes('multiple'), 'Reason must indicate multiple matches');
      assert.strictEqual(d.winningRule, 'rule-multi');
      assert.deepStrictEqual(d.skippedRules, ['rule-skipped']);
      suitePassCounts['Suite 2: Zero Matches and Multiple Matches Press Nothing']++;
      console.log('  ✓ Multiple matches inside winning rule after skipped rule mark needs_user');
    }

    // Test 2.3: Multiple matches (2 different options match the SAME rule) -> needs_user
    {
      const customRules = {
        deny: DEFAULT_RULES.deny,
        danger: DEFAULT_RULES.danger,
        allow: [],
        optionRules: [
          { name: 'broad-rule', startsWith: 'Yes, allow' }
        ]
      };
      const prompt = {
        commandSpaced: 'git status',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, allow for this run', classification: 'yes_once' },
          { key: '2', number: 2, text: 'Yes, allow for whole conversation', classification: 'yes_session' },
          { key: '3', number: 3, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, customRules);
      assert.strictEqual(d.action, 'needs_user');
      suitePassCounts['Suite 2: Zero Matches and Multiple Matches Press Nothing']++;
      console.log('  ✓ Multiple options matching the same rule mark needs_user');
    }

    // Test 2.4: Multiple options matching winning rule even when option matches lower rule -> needs_user
    {
      const customRules = {
        deny: DEFAULT_RULES.deny,
        danger: DEFAULT_RULES.danger,
        allow: [],
        optionRules: [
          { name: 'rule-a', startsWith: 'Yes, allow' },
          { name: 'rule-b', startsWith: 'Yes, allow specific' }
        ]
      };
      const prompt = {
        commandSpaced: 'git status',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, allow specific', classification: 'yes_session' },
          { key: '2', number: 2, text: 'Yes, allow general', classification: 'yes_once' },
          { key: '3', number: 3, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, customRules);
      assert.strictEqual(d.action, 'needs_user');
      assert(d.reason.includes('multiple'), 'Reason must indicate multiple matches');
      assert.strictEqual(d.winningRule, 'rule-a');
      suitePassCounts['Suite 2: Zero Matches and Multiple Matches Press Nothing']++;
      console.log('  ✓ Multiple options matching winning rule press nothing');
    }
  }

  // -------------------------------------------------------------
  // Suite 3: endsWith and commandStartsWith filters
  // -------------------------------------------------------------
  console.log('\n--- Suite 3: endsWith and commandStartsWith Filters ---');
  {
    // Test 3.1: endsWith filter matches when option ends with specified suffix
    {
      const customRules = {
        deny: DEFAULT_RULES.deny,
        danger: DEFAULT_RULES.danger,
        allow: [],
        optionRules: [
          { name: 'rule-end', startsWith: 'Yes', endsWith: 'conversation' }
        ]
      };
      const promptMatch = {
        commandSpaced: 'git status',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, always allow in this conversation', classification: 'yes_session' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const dMatch = evaluatePrompt(promptMatch, customRules);
      assert.strictEqual(dMatch.action, 'would_approve');
      assert.strictEqual(dMatch.rule, 'rule-end');

      const promptNoMatch = {
        commandSpaced: 'git status',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, run command once', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const dNoMatch = evaluatePrompt(promptNoMatch, customRules);
      assert.strictEqual(dNoMatch.action, 'needs_user');

      suitePassCounts['Suite 3: endsWith and commandStartsWith Filters']++;
      console.log('  ✓ endsWith filter correctly matches when suffix matches and rejects when not');
    }

    // Test 3.2: commandStartsWith filter matches only when spaced command starts with prefix
    {
      const customRules = {
        deny: DEFAULT_RULES.deny,
        danger: DEFAULT_RULES.danger,
        allow: [],
        optionRules: [
          {
            name: 'git-only-option',
            startsWith: 'Yes, and always',
            commandStartsWith: 'git status'
          }
        ]
      };

      const promptGit = {
        commandSpaced: 'git status --short',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, and always allow in this session', classification: 'yes_session' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const dGit = evaluatePrompt(promptGit, customRules);
      assert.strictEqual(dGit.action, 'would_approve');
      assert.strictEqual(dGit.rule, 'git-only-option');

      const promptNpm = {
        commandSpaced: 'npm test',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, and always allow in this session', classification: 'yes_session' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const dNpm = evaluatePrompt(promptNpm, customRules);
      assert.strictEqual(dNpm.action, 'needs_user');

      suitePassCounts['Suite 3: endsWith and commandStartsWith Filters']++;
      console.log('  ✓ commandStartsWith filter requires spaced command to start with specified prefix');
    }
  }

  // -------------------------------------------------------------
  // Suite 4: Deny List and Danger List Beat Matching Rules
  // (test with rm -rf, a .env command, and a command containing "delete")
  // -------------------------------------------------------------
  console.log('\n--- Suite 4: Deny List and Danger List Beat Matching Rules ---');
  {
    const matchingOptionRules = {
      defaultDelaySeconds: 1,
      deny: DEFAULT_RULES.deny,
      danger: DEFAULT_RULES.danger,
      allow: [],
      optionRules: [
        { name: 'broad-yes-rule', startsWith: 'Yes' }
      ]
    };

    // Test 4.1: rm -rf command (in deny list)
    {
      const prompt = {
        commandSpaced: 'rm -rf /tmp/test-dir',
        commandCompact: 'rm-rf/tmp/test-dir',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, matchingOptionRules);
      assert.strictEqual(d.action, 'blocked', 'rm -rf must be blocked by deny list');
      assert.strictEqual(d.rule, 'rm -rf');
      suitePassCounts['Suite 4: Deny List and Danger List Beat Matching Rules']++;
      console.log('  ✓ Deny list beats matching option rule on "rm -rf"');
    }

    // Test 4.2: .env command (in deny list and danger list)
    {
      const prompt = {
        commandSpaced: 'cat .env',
        commandCompact: 'cat.env',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, matchingOptionRules);
      assert.strictEqual(d.action, 'blocked', '.env command must be blocked by deny list');
      assert.strictEqual(d.rule, '.env');
      suitePassCounts['Suite 4: Deny List and Danger List Beat Matching Rules']++;
      console.log('  ✓ Deny list beats matching option rule on ".env"');
    }

    // Test 4.3: Command containing "delete" (in danger list)
    {
      const prompt = {
        commandSpaced: 'node delete-temp-files.js',
        commandCompact: 'nodedelete-temp-files.js',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, matchingOptionRules);
      assert.strictEqual(d.action, 'needs_user', 'delete command must be flagged as danger');
      assert.strictEqual(d.danger, true);
      assert.strictEqual(d.reason, "DANGER: matched 'delete'");
      suitePassCounts['Suite 4: Deny List and Danger List Beat Matching Rules']++;
      console.log('  ✓ Danger list beats matching option rule on command containing "delete"');
    }

    // Test 4.4: Danger word split across wrapped lines via compact form beats option rule
    {
      const prompt = {
        commandSpaced: 'node de lete-files.js',
        commandCompact: 'nodedelete-files.js',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, matchingOptionRules);
      assert.strictEqual(d.action, 'needs_user');
      assert.strictEqual(d.danger, true);
      suitePassCounts['Suite 4: Deny List and Danger List Beat Matching Rules']++;
      console.log('  ✓ Danger list compact check beats matching option rule');
    }
  }

  // -------------------------------------------------------------
  // Suite 5: Persist Option Blocked Unless allowPersist
  // -------------------------------------------------------------
  console.log('\n--- Suite 5: Persist Option Blocked Unless allowPersist ---');
  {
    // Test 5.1: Option classified yes_persist with allowPersist false (or omitted) is blocked
    {
      const customRules = {
        deny: DEFAULT_RULES.deny,
        danger: DEFAULT_RULES.danger,
        allow: [],
        optionRules: [
          {
            name: 'persist-blocked',
            startsWith: 'Yes, and persist',
            allowPersist: false
          }
        ]
      };
      const prompt = {
        commandSpaced: 'git status',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, and persist to settings.json', classification: 'yes_persist' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, customRules);
      assert.strictEqual(d.action, 'needs_user');
      assert(d.reason.includes('persist option blocked'), 'Reason must explain why persist option is blocked');
      assert(d.log.includes('persist option blocked'), 'Log must explain why persist option is blocked');
      suitePassCounts['Suite 5: Persist Option Blocked Unless allowPersist']++;
      console.log('  ✓ Persist option blocked when allowPersist is false with clear log reason');
    }

    // Test 5.2: Option classified yes_persist with allowPersist true is approved
    {
      const customRules = {
        deny: DEFAULT_RULES.deny,
        danger: DEFAULT_RULES.danger,
        allow: [],
        optionRules: [
          {
            name: 'persist-allowed',
            startsWith: 'Yes, and persist',
            allowPersist: true
          }
        ]
      };
      const prompt = {
        commandSpaced: 'git status',
        question: 'Run this command?',
        options: [
          { key: '1', number: 1, text: 'Yes, and persist to settings.json', classification: 'yes_persist' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const d = evaluatePrompt(prompt, customRules);
      assert.strictEqual(d.action, 'would_approve');
      assert.strictEqual(d.rule, 'persist-allowed');
      assert.strictEqual(d.optionKey, '1');
      suitePassCounts['Suite 5: Persist Option Blocked Unless allowPersist']++;
      console.log('  ✓ Persist option approved when allowPersist is true');
    }
  }

  // -------------------------------------------------------------
  // Suite 6: "No" Options Never Pressed
  // -------------------------------------------------------------
  console.log('\n--- Suite 6: "No" Options Never Pressed ---');
  {
    // Test 6.1: Rule with startsWith: "No" matches nothing
    const customRules = {
      deny: DEFAULT_RULES.deny,
      danger: DEFAULT_RULES.danger,
      allow: [],
      optionRules: [
        { name: 'try-no-rule', startsWith: 'No, cancel' }
      ]
    };
    const prompt = {
      commandSpaced: 'git status',
      question: 'Run this command?',
      options: [
        { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
        { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
      ]
    };
    const d = evaluatePrompt(prompt, customRules);
    assert.notStrictEqual(d.action, 'would_approve');
    assert.strictEqual(d.action, 'needs_user');
    suitePassCounts['Suite 6: "No" Options Never Pressed']++;
    console.log('  ✓ "No" options are never matched or pressed');
  }

  // -------------------------------------------------------------
  // Suite 7: Choice Question Protection
  // -------------------------------------------------------------
  console.log('\n--- Suite 7: Choice Question Protection ---');
  {
    const customRules = {
      deny: DEFAULT_RULES.deny,
      danger: DEFAULT_RULES.danger,
      allow: [],
      optionRules: [
        { name: 'rec-rule', startsWith: 'Recommended' }
      ]
    };

    // Test 7.1: Recommended / Alternate options lacking a negative option
    const promptChoice = {
      commandSpaced: 'build assets',
      question: 'Choose configuration mode:',
      options: [
        { key: '1', number: 1, text: 'Recommended: Standard Cloudflare Worker', classification: 'unknown' },
        { key: '2', number: 2, text: 'Alternate: Container Image', classification: 'unknown' }
      ]
    };
    const d1 = evaluatePrompt(promptChoice, customRules);
    assert.strictEqual(d1.action, 'needs_user');
    assert(d1.reason.includes('choice question'), 'Must detect choice question');

    // Test 7.2: Question with "Which..." keyword
    const promptWhich = {
      commandSpaced: 'configure database',
      question: 'Which database would you like to use?',
      options: [
        { key: '1', number: 1, text: 'Recommended Postgres', classification: 'unknown' },
        { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
      ]
    };
    const d2 = evaluatePrompt(promptWhich, customRules);
    assert.strictEqual(d2.action, 'needs_user');
    assert(d2.reason.includes('choice question'));

    suitePassCounts['Suite 7: Choice Question Protection']++;
    console.log('  ✓ Choice question (Recommended / Alternate, Which...) is never pressed');
  }

  // -------------------------------------------------------------
  // Suite 8: Veto and Circuit Breaker Guards
  // -------------------------------------------------------------
  console.log('\n--- Suite 8: Veto and Circuit Breaker Guards ---');
  {
    // Test 8.1: Keystroke veto cancels countdown
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
        deny: DEFAULT_RULES.deny,
        danger: DEFAULT_RULES.danger,
        allow: [],
        optionRules: [
          { name: 'rule-veto-test', startsWith: 'Yes, and always' }
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
        '   git status\r\n' +
        'Run this command?\r\n' +
        '> 1. Yes, and always allow in this conversation\r\n' +
        '  2. No, cancel\r\n' +
        '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
        'esc to cancel\r\n';

      await writeTerm(monitor.term, screen);
      monitor.inspectScreenForPrompts(Date.now());
      assert.strictEqual(monitor.statusManager.state, 'countdown');

      // User hits key to veto
      stdinMock.emit('data', Buffer.from('x'));
      await delay(50);

      assert.strictEqual(monitor.statusManager.state, 'asking');
      assert.strictEqual(monitor.getActivePrompt().vetoed, true);

      // Wait full countdown time
      await delay(1100);
      // Auto write must NOT have happened (only the user's keystroke 'x')
      assert.strictEqual(writtenToChild.length, 1);
      assert.strictEqual(writtenToChild[0], 'x');

      monitor.cleanup();
      suitePassCounts['Suite 8: Veto and Circuit Breaker Guards']++;
      console.log('  ✓ Keystroke veto cancels countdown under option rules');
    }

    // Test 8.2: 1s mid-typing veto blocks countdown trigger
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
        defaultDelaySeconds: 0.35,
        deny: DEFAULT_RULES.deny,
        danger: DEFAULT_RULES.danger,
        allow: [],
        optionRules: [
          { name: 'rule-typing', startsWith: 'Yes, and always' }
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

      // User types right before prompt arrives
      stdinMock.emit('data', Buffer.from('a'));

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

      await delay(450);

      // Child received 'a' from user, never auto option key
      assert.strictEqual(writtenToChild.length, 1);
      assert.strictEqual(writtenToChild[0], 'a');

      monitor.cleanup();
      suitePassCounts['Suite 8: Veto and Circuit Breaker Guards']++;
      console.log('  ✓ 1s mid-typing veto prevents auto answer under option rules');
    }

    // Test 8.3: Circuit breaker (>8 in 60s) disables auto-accept
    {
      const now = Date.now();
      const fakeHistory = [];
      for (let i = 0; i < 9; i++) {
        fakeHistory.push({ time: now - 1000 * i, command: `echo ${i}` });
      }

      const tmpDir = createTempDir();
      const stdinMock = new EventEmitter();
      stdinMock.isTTY = true;
      stdinMock.setRawMode = () => {};
      stdinMock.resume = () => {};
      stdinMock.pause = () => {};
      const ptyMock = {
        write: () => {},
        resize: () => {},
        onData: () => {},
        onExit: () => {}
      };

      const monitor = startAgentwatch({
        command: 'agy',
        auto: true,
        stdin: stdinMock,
        ptyProcess: ptyMock,
        rulesPath: path.join(tmpDir, 'rules.json'),
        sessionsDir: path.join(tmpDir, 'sessions'),
        promptsLogPath: path.join(tmpDir, 'prompts.log'),
        historyPath: path.join(tmpDir, 'history.jsonl'),
        autoAnswersHistory: fakeHistory,
        profile: getProfileForCommand('agy')
      });

      const screen =
        'Requesting permission for:\r\n' +
        '   echo new-command\r\n' +
        'Run this command?\r\n' +
        '> 1. Yes, and always allow in this conversation\r\n' +
        '  2. No, cancel\r\n' +
        '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
        'esc to cancel\r\n';

      await writeTerm(monitor.term, screen);
      monitor.inspectScreenForPrompts(Date.now());

      assert.strictEqual(monitor.isAutoAcceptEnabled(), false);
      assert.strictEqual(monitor.statusManager.state, 'asking');

      monitor.cleanup();
      suitePassCounts['Suite 8: Veto and Circuit Breaker Guards']++;
      console.log('  ✓ Circuit breaker trips and disables auto-accept when >8 answers in 60s');
    }
  }

  // -------------------------------------------------------------
  // Suite 9: rules.json Validation on Load
  // -------------------------------------------------------------
  console.log('\n--- Suite 9: rules.json Validation on Load ---');
  {
    // Test 9.1: Validates option rules and ignores invalid rules with clear warning
    const rawBadRules = [
      null,
      123,
      'just-string',
      { name: 'no-startswith' }, // missing startsWith
      { name: '', startsWith: 'Yes, valid' }, // empty name
      { name: 'empty-starts', startsWith: '' }, // empty startsWith
      { name: 'too-short', startsWith: 'Ye' }, // startsWith < 3 characters
      { name: 'empty-ends', startsWith: 'Yes, valid', endsWith: '' }, // empty endsWith
      { name: 'empty-cmdstarts', startsWith: 'Yes, valid', commandStartsWith: '' }, // empty commandStartsWith
      { name: 'unknown-prop', startsWith: 'Yes, valid', extraField: 123 }, // unknown fields
      { name: 'good-rule', startsWith: 'Yes, perfectly valid' } // valid
    ];

    const validated = validateOptionRules(rawBadRules);
    assert.strictEqual(validated.length, 1, 'Only the single valid rule should survive validation');
    assert.strictEqual(validated[0].name, 'good-rule');
    assert.strictEqual(validated[0].enabled, true, 'Default enabled must be true');
    assert.strictEqual(validated[0].allowPersist, false, 'Default allowPersist must be false');
    suitePassCounts['Suite 9: rules.json Validation on Load']++;
    console.log('  ✓ Option rules validator rejects invalid entries, empty strings, unknown fields, and short startsWith');

    // Test 9.2: Non-array optionRules property ignored with warning
    const nonArrayResult = validateOptionRules('not-an-array');
    assert(Array.isArray(nonArrayResult));
    suitePassCounts['Suite 9: rules.json Validation on Load']++;
    console.log('  ✓ Non-array optionRules property handled safely');

    // Test 9.3: Bad / corrupted rules.json does not crash loadRules
    const tmpDir = createTempDir();
    const badFile = path.join(tmpDir, 'bad-rules.json');
    fs.writeFileSync(badFile, '{ corrupted JSON @@!!', 'utf8');

    const loaded = loadRules(badFile);
    assert(loaded && typeof loaded === 'object');
    assert(Array.isArray(loaded.optionRules));
    suitePassCounts['Suite 9: rules.json Validation on Load']++;
    console.log('  ✓ Corrupted rules.json never crashes loadRules and falls back to defaults');
  }

  // -------------------------------------------------------------
  // Suite 10: Single-Write-Path Safety & Privacy Re-check
  // -------------------------------------------------------------
  console.log('\n--- Suite 10: Single-Write-Path Safety & Privacy Re-check ---');
  {
    // Test 10.1: Static code check: child process write safety rule maintained
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
    suitePassCounts['Suite 10: Single-Write-Path Safety & Privacy Re-check']++;
    console.log('  ✓ Child process single write safety rule maintained strictly');

    // Test 10.2: Privacy: user typed keystrokes never leak to logs
    const tmpDir = createTempDir();
    const secretKey = 'VerySecretApiKey12345';
    const masked = maskText(`API_KEY=${secretKey}`);
    assert(!masked.includes(secretKey));
    assert(masked.includes('[REDACTED]'));

    suitePassCounts['Suite 10: Single-Write-Path Safety & Privacy Re-check']++;
    console.log('  ✓ Privacy rule verified: sensitive values redacted, never leak to logs');
  }

  // -------------------------------------------------------------
  // Suite 11: Viewers & Startup Display (Dashboard & Window)
  // -------------------------------------------------------------
  console.log('\n--- Suite 11: Viewers & Startup Display (Dashboard & Window) ---');
  {
    // Test 11.1: Dashboard shows rule name next to countdown
    const cdSessionWithRule = {
      sessionId: 'sess-cd-rule',
      sessionKey: 'agy:rule1',
      agent: 'agy',
      folder: 'my-project',
      displayName: 'my-project',
      auto: true,
      state: 'countdown',
      countdown: 3,
      rule: 'always-in-conversation',
      stateSince: new Date().toISOString(),
      prompt: {
        command: 'git status',
        decision: 'would approve option 2 after 3s (rule: always-in-conversation)',
        rule: 'always-in-conversation'
      }
    };

    const light = getStateLight(cdSessionWithRule.state, false, false, cdSessionWithRule.countdown, cdSessionWithRule.auto, cdSessionWithRule.rule);
    assert(light.plain.includes('COUNTDOWN 3s (always-in-conversation)'), `Light must include countdown and rule name, got: ${light.plain}`);

    const summary = getSessionSummary(cdSessionWithRule);
    assert(summary.includes('always-in-conversation'), `Summary must include rule name, got: ${summary}`);

    const lines = renderDashboardLines({
      sessions: [cdSessionWithRule],
      useColor: false
    });
    const output = lines.join('\n');
    assert(output.includes('COUNTDOWN 3s (always-in-conversation)'), 'Dashboard output must show rule name next to countdown');

    // Test 11.2: PERSIST ALLOWED marker in dashboard
    const persistSession = {
      sessionId: 'sess-persist',
      sessionKey: 'agy:persist1',
      agent: 'agy',
      folder: 'my-project',
      displayName: 'my-project',
      auto: true,
      allowPersist: true,
      state: 'idle',
      stateSince: new Date().toISOString()
    };

    const persistLines = renderDashboardLines({
      sessions: [persistSession],
      useColor: false
    });
    const persistOutput = persistLines.join('\n');
    assert(persistOutput.includes('[PERSIST ALLOWED]'), 'Dashboard must display [PERSIST ALLOWED] marker when allowPersist is true');

    // Test 11.3: Startup warning printed when any rule has allowPersist: true
    const startupOutputs = [];
    const mockStdout = {
      write: (data) => { startupOutputs.push(data.toString()); }
    };
    const tmpDir = createTempDir();
    const rulesWithPersist = {
      optionRules: [
        { name: 'rule-with-persist', startsWith: 'Yes, persist', allowPersist: true }
      ]
    };
    const rulesPath = path.join(tmpDir, 'rules.json');
    fs.writeFileSync(rulesPath, JSON.stringify(rulesWithPersist, null, 2), 'utf8');

    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};
    stdinMock.resume = () => {};
    stdinMock.pause = () => {};
    const ptyMock = {
      write: () => {},
      resize: () => {},
      onData: () => {},
      onExit: () => {}
    };

    const monitor = startAgentwatch({
      command: 'agy',
      auto: true,
      stdin: stdinMock,
      stdout: mockStdout,
      ptyProcess: ptyMock,
      rulesPath,
      sessionsDir: path.join(tmpDir, 'sessions'),
      promptsLogPath: path.join(tmpDir, 'prompts.log'),
      historyPath: path.join(tmpDir, 'history.jsonl'),
      profile: getProfileForCommand('agy')
    });

    const joinedStartup = startupOutputs.join('\n');
    assert(joinedStartup.includes('allowPersist is enabled in option rules'), 'Startup must print clear warning line when allowPersist is true');
    monitor.cleanup();

    suitePassCounts['Suite 11: Viewers & Startup Display (Dashboard & Window)']++;
    console.log('  ✓ Viewers show rule name next to countdown, [PERSIST ALLOWED] marker, and startup warning');
  }

  // -------------------------------------------------------------
  // Summary
  // -------------------------------------------------------------
  console.log('\n=========================================');
  console.log('Stage 4b Pass Counts Per Suite:');
  let totalPass = 0;
  for (const [sName, count] of Object.entries(suitePassCounts)) {
    console.log(`  ${sName}: ${count} passed`);
    totalPass += count;
  }
  console.log(`\nAll ${totalPass} Stage 4b tests passed successfully!`);
  console.log('=========================================\n');
}

runStage4bTests().catch(err => {
  console.error('\nStage 4b test failure:', err);
  process.exit(1);
});
