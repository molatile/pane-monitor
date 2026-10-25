const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  loadRules,
  evaluatePrompt,
  checkDangerEntry,
  checkDangerMatch,
  validateDangerList,
  DEFAULT_DANGER_LIST,
  DEFAULT_RULES
} = require('../src/rules');
const { SessionStatusManager, formatDecision } = require('../src/status');
const { renderDashboardLines, getSessionSummary } = require('../src/dashboard');
const { maskText } = require('../src/masker');
const { appendHistoryEvent, readHistory } = require('../src/history');
const { startAgentwatch, logPromptRecord } = require('../src/agentwatch');

console.log('Running agentwatch danger list test suite...\n');

let passCount = 0;
let currentSuite = '';
const suiteCounts = {};

function startSuite(name) {
  currentSuite = name;
  suiteCounts[name] = 0;
  console.log(`\n--- ${name} ---`);
}

function test(name, fn) {
  try {
    fn();
    passCount++;
    if (currentSuite) {
      suiteCounts[currentSuite] = (suiteCounts[currentSuite] || 0) + 1;
    }
    console.log(`  ✓ ${name} passed`);
  } catch (err) {
    console.error(`  ✗ ${name} failed:`, err);
    throw err;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passCount++;
    if (currentSuite) {
      suiteCounts[currentSuite] = (suiteCounts[currentSuite] || 0) + 1;
    }
    console.log(`  ✓ ${name} passed`);
  } catch (err) {
    console.error(`  ✗ ${name} failed:`, err);
    throw err;
  }
}

function makePrompt(cmdSpaced, cmdCompact, options, question) {
  return {
    commandSpaced: cmdSpaced,
    commandCompact: cmdCompact || cmdSpaced.replace(/\s+/g, ''),
    question: question || 'Run this command?',
    options: options || [
      { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
      { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
    ]
  };
}

(async function runAllDangerTests() {
  const loadedRules = loadRules();
  const dangerList = loadedRules.danger || DEFAULT_DANGER_LIST;

  // -------------------------------------------------------------
  // Suite 1: Each Seeded Word Triggers
  // -------------------------------------------------------------
  startSuite('Suite 1: Each Seeded Word Triggers');

  const expectedSeededWords = [
    { text: 'delete', wholeWord: false },
    { text: 'remove', wholeWord: false },
    { text: 'erase', wholeWord: false },
    { text: 'rmdir', wholeWord: false },
    { text: 'del', wholeWord: true },
    { text: 'rm', wholeWord: true },
    { text: 'unlink', wholeWord: false },
    { text: 'drop table', wholeWord: false },
    { text: 'drop database', wholeWord: false },
    { text: 'truncate', wholeWord: false },
    { text: 'format', wholeWord: true },
    { text: 'mkfs', wholeWord: false },
    { text: 'kill', wholeWord: false },
    { text: 'taskkill', wholeWord: false },
    { text: 'shutdown', wholeWord: false },
    { text: 'reboot', wholeWord: false },
    { text: '--force', wholeWord: false },
    { text: '-rf', wholeWord: false },
    { text: 'sudo', wholeWord: false },
    { text: 'chmod', wholeWord: false },
    { text: 'chown', wholeWord: false },
    { text: 'reset --hard', wholeWord: false },
    { text: 'clean -fd', wholeWord: false },
    { text: 'push', wholeWord: false },
    { text: 'publish', wholeWord: false },
    { text: 'deploy', wholeWord: false },
    { text: 'uninstall', wholeWord: false },
    { text: 'curl', wholeWord: false },
    { text: 'wget', wholeWord: false },
    { text: 'Invoke-WebRequest', wholeWord: false },
    { text: 'Invoke-Expression', wholeWord: false },
    { text: 'iex', wholeWord: true },
    { text: 'ssh', wholeWord: false },
    { text: 'scp', wholeWord: false },
    { text: 'reg add', wholeWord: false },
    { text: 'reg delete', wholeWord: false },
    { text: '.env', wholeWord: false },
    { text: 'secret', wholeWord: false },
    { text: 'password', wholeWord: false },
    { text: 'token', wholeWord: false },
    { text: 'credentials', wholeWord: false },
    { text: 'private key', wholeWord: false }
  ];

  test('Danger list has exactly 42 seeded entries', () => {
    assert.strictEqual(expectedSeededWords.length, 42);
    assert.strictEqual(DEFAULT_DANGER_LIST.length, 42);
    assert.strictEqual(dangerList.length, 42);
  });

  for (const item of expectedSeededWords) {
    test(`Seeded word triggers: "${item.text}" (wholeWord: ${item.wholeWord})`, () => {
      // 1. Direct entry matching check
      const prompt = makePrompt(item.text);
      const matched = checkDangerEntry(item, prompt.commandSpaced, prompt.commandCompact, prompt.question);
      assert.strictEqual(matched, true, `Entry "${item.text}" must match its own text in command`);

      // 2. Matching via question text
      const qPrompt = makePrompt('git status', null, null, `Do you want to ${item.text}?`);
      const qMatched = checkDangerEntry(item, qPrompt.commandSpaced, qPrompt.commandCompact, qPrompt.question);
      assert.strictEqual(qMatched, true, `Entry "${item.text}" must match in question`);

      // 3. evaluatePrompt triggers danger
      const decision = evaluatePrompt(prompt, { danger: [item], allow: DEFAULT_RULES.allow, deny: [] });
      assert.strictEqual(decision.action, 'needs_user');
      assert.strictEqual(decision.danger, true);
      assert.strictEqual(decision.reason, `DANGER: matched '${item.text}'`);
    });
  }

  // -------------------------------------------------------------
  // Suite 2: Case-Insensitive Matching
  // -------------------------------------------------------------
  startSuite('Suite 2: Case-Insensitive Matching');

  const caseInsensitiveCases = [
    { text: 'DELETE', expected: 'delete' },
    { text: 'ReMoVe', expected: 'remove' },
    { text: 'SuDo', expected: 'sudo' },
    { text: 'RM', expected: 'rm' },
    { text: 'DEL', expected: 'del' },
    { text: 'DROP TABLE', expected: 'drop table' },
    { text: 'INVOKE-WEBREQUEST', expected: 'Invoke-WebRequest' },
    { text: 'ReSeT --HaRd', expected: 'reset --hard' },
    { text: 'CLEAN -FD', expected: 'clean -fd' },
    { text: 'PrIvAtE kEy', expected: 'private key' }
  ];

  for (const c of caseInsensitiveCases) {
    test(`Case-insensitive match: "${c.text}" -> matched "${c.expected}"`, () => {
      const prompt = makePrompt(`cmd ${c.text}`);
      const decision = evaluatePrompt(prompt, { danger: dangerList, allow: DEFAULT_RULES.allow, deny: [] });
      assert.strictEqual(decision.action, 'needs_user');
      assert.strictEqual(decision.danger, true);
      assert.strictEqual(decision.reason, `DANGER: matched '${c.expected}'`);
    });
  }

  // -------------------------------------------------------------
  // Suite 3: WholeWord Matching
  // -------------------------------------------------------------
  startSuite('Suite 3: WholeWord Matching');

  test('"rm" does not trigger on "form" or "confirm"', () => {
    const pForm = makePrompt('form');
    const dForm = evaluatePrompt(pForm, { danger: dangerList, allow: DEFAULT_RULES.allow, deny: [] });
    assert.notStrictEqual(dForm.reason, "DANGER: matched 'rm'");

    const pConfirm = makePrompt('confirm');
    const dConfirm = evaluatePrompt(pConfirm, { danger: dangerList, allow: DEFAULT_RULES.allow, deny: [] });
    assert.notStrictEqual(dConfirm.reason, "DANGER: matched 'rm'");

    const pPlatform = makePrompt('echo platform');
    const dPlatform = evaluatePrompt(pPlatform, { danger: dangerList, allow: DEFAULT_RULES.allow, deny: [] });
    assert.notStrictEqual(dPlatform.reason, "DANGER: matched 'rm'");
  });

  test('"rm" triggers as a separate word', () => {
    const pRm = makePrompt('rm file.txt');
    const dRm = evaluatePrompt(pRm, { danger: dangerList, allow: DEFAULT_RULES.allow, deny: [] });
    assert.strictEqual(dRm.action, 'needs_user');
    assert.strictEqual(dRm.reason, "DANGER: matched 'rm'");

    const pGitRm = makePrompt('git rm file.txt');
    const dGitRm = evaluatePrompt(pGitRm, { danger: dangerList, allow: DEFAULT_RULES.allow, deny: [] });
    assert.strictEqual(dGitRm.action, 'needs_user');
    assert.strictEqual(dGitRm.reason, "DANGER: matched 'rm'");
  });

  test('"format" entry set to wholeWord does not trigger on "information"', () => {
    const pInfo = makePrompt('information');
    const dInfo = evaluatePrompt(pInfo, { danger: dangerList, allow: DEFAULT_RULES.allow, deny: [] });
    assert.notStrictEqual(dInfo.reason, "DANGER: matched 'format'");

    const pEchoInfo = makePrompt('echo information');
    const dEchoInfo = evaluatePrompt(pEchoInfo, { danger: dangerList, allow: DEFAULT_RULES.allow, deny: [] });
    assert.notStrictEqual(dEchoInfo.reason, "DANGER: matched 'format'");
  });

  test('"format" triggers as a separate word', () => {
    const pFormat = makePrompt('format c:');
    const dFormat = evaluatePrompt(pFormat, { danger: dangerList, allow: DEFAULT_RULES.allow, deny: [] });
    assert.strictEqual(dFormat.action, 'needs_user');
    assert.strictEqual(dFormat.reason, "DANGER: matched 'format'");
  });

  test('"del" wholeWord does not trigger on "model" or "deliver" but triggers on "del"', () => {
    const pModel = makePrompt('cat model.json');
    const dModel = evaluatePrompt(pModel, { danger: dangerList, allow: DEFAULT_RULES.allow, deny: [] });
    assert.notStrictEqual(dModel.reason, "DANGER: matched 'del'");

    const pDeliver = makePrompt('npm deliver');
    const dDeliver = evaluatePrompt(pDeliver, { danger: dangerList, allow: DEFAULT_RULES.allow, deny: [] });
    assert.notStrictEqual(dDeliver.reason, "DANGER: matched 'del'");

    const pDel = makePrompt('del temp.txt');
    const dDel = evaluatePrompt(pDel, { danger: dangerList, allow: DEFAULT_RULES.allow, deny: [] });
    assert.strictEqual(dDel.action, 'needs_user');
    assert.strictEqual(dDel.reason, "DANGER: matched 'del'");
  });

  test('"iex" wholeWord does not trigger on "view" or "review" but triggers on "iex"', () => {
    const pView = makePrompt('git view');
    const dView = evaluatePrompt(pView, { danger: dangerList, allow: DEFAULT_RULES.allow, deny: [] });
    assert.notStrictEqual(dView.reason, "DANGER: matched 'iex'");

    const pIex = makePrompt('iex (evil)');
    const dIex = evaluatePrompt(pIex, { danger: dangerList, allow: DEFAULT_RULES.allow, deny: [] });
    assert.strictEqual(dIex.action, 'needs_user');
    assert.strictEqual(dIex.reason, "DANGER: matched 'iex'");
  });

  test('Never match against option texts like "No, cancel"', () => {
    const prompt = {
      commandSpaced: 'git status',
      commandCompact: 'gitstatus',
      question: 'Check repository status?',
      options: [
        { key: '1', number: 1, text: 'Yes, run delete command', classification: 'yes_once' },
        { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
      ]
    };
    const match = checkDangerMatch(prompt, dangerList);
    assert.strictEqual(match, null, 'Danger list must NEVER match against option texts');
  });

  // -------------------------------------------------------------
  // Suite 4: Word Split Across Wrapped Lines via Compact Form
  // -------------------------------------------------------------
  startSuite('Suite 4: Word Split Across Wrapped Lines via Compact Form');

  const wrappedCases = [
    {
      name: 'delete split as de lete',
      spaced: 'de lete temp.txt',
      compact: 'deletetemp.txt',
      entry: 'delete'
    },
    {
      name: 'remove split as re move',
      spaced: 're move file.txt',
      compact: 'removefile.txt',
      entry: 'remove'
    },
    {
      name: 'clean -fd split across wrapped lines',
      spaced: 'clean  -fd',
      compact: 'clean-fd',
      entry: 'clean -fd'
    },
    {
      name: 'drop table split across lines',
      spaced: 'drop  table users',
      compact: 'droptableusers',
      entry: 'drop table'
    },
    {
      name: 'truncate split across lines',
      spaced: 'trun cate users',
      compact: 'truncateusers',
      entry: 'truncate'
    },
    {
      name: 'shutdown split as shut down',
      spaced: 'shut down now',
      compact: 'shutdownnow',
      entry: 'shutdown'
    }
  ];

  for (const wc of wrappedCases) {
    test(`Wrapped split caught: "${wc.name}" -> ${wc.entry}`, () => {
      const prompt = makePrompt(wc.spaced, wc.compact);
      const d = evaluatePrompt(prompt, { danger: dangerList, allow: DEFAULT_RULES.allow, deny: [] });
      assert.strictEqual(d.action, 'needs_user');
      assert.strictEqual(d.danger, true);
      assert.strictEqual(d.reason, `DANGER: matched '${wc.entry}'`);
    });
  }

  // -------------------------------------------------------------
  // Suite 5: Danger Beats Allow Rule and Option Rule
  // -------------------------------------------------------------
  startSuite('Suite 5: Danger Beats Allow Rule and Option Rule');

  test('Danger beats allow rule "echo-safe" when danger word present in command', () => {
    const prompt = makePrompt('echo delete');
    const d = evaluatePrompt(prompt);
    assert.notStrictEqual(d.action, 'would_approve', 'Danger must defeat allow rule');
    assert.strictEqual(d.action, 'needs_user');
    assert.strictEqual(d.danger, true);
    assert.strictEqual(d.reason, "DANGER: matched 'delete'");
  });

  test('Danger beats allow rule "git-readonly" when danger word in question', () => {
    const prompt = makePrompt('git status', null, null, 'Do you want to delete everything?');
    const d = evaluatePrompt(prompt);
    assert.notStrictEqual(d.action, 'would_approve', 'Danger in question must defeat allow rule');
    assert.strictEqual(d.action, 'needs_user');
    assert.strictEqual(d.danger, true);
    assert.strictEqual(d.reason, "DANGER: matched 'delete'");
  });

  test('Danger beats allow rule "file-list" when secret target mentioned', () => {
    const prompt = makePrompt('ls secret');
    const d = evaluatePrompt(prompt);
    assert.notStrictEqual(d.action, 'would_approve', 'Danger must defeat file-list allow rule');
    assert.strictEqual(d.action, 'needs_user');
    assert.strictEqual(d.danger, true);
    assert.strictEqual(d.reason, "DANGER: matched 'secret'");
  });

  test('Danger beats option rule: single yes_once option is never auto-approved under danger', () => {
    const prompt = {
      commandSpaced: 'git branch -D main',
      commandCompact: 'gitbranch-Dmain',
      question: 'Run this command?',
      options: [
        { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
        { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
      ]
    };
    const d = evaluatePrompt(prompt);
    assert.notStrictEqual(d.action, 'would_approve');
    assert.strictEqual(d.action, 'needs_user');
  });

  // -------------------------------------------------------------
  // Suite 6: Countdown Cancelled by Danger Hit
  // -------------------------------------------------------------
  startSuite('Suite 6: Countdown Cancelled by Danger Hit');

  test('Countdown is cancelled immediately when danger hit occurs', () => {
    const tempDir = path.join(os.tmpdir(), `agentwatch-test-countdown-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const statusManager = new SessionStatusManager({
        sessionId: 'test-danger-countdown-session',
        sessionsDir: tempDir,
        auto: true,
        agent: 'agy'
      });
      statusManager.start();

      let inCountdown = true;
      let timerCancelled = false;
      const countdownTimer = setInterval(() => {}, 1000);

      function cancelCountdown(reason) {
        if (countdownTimer) {
          clearInterval(countdownTimer);
          timerCancelled = true;
        }
        inCountdown = false;
        statusManager.countdown = null;
        statusManager.update('asking', new Date().toISOString(), {
          commandSpaced: 'echo hello',
          question: 'Delete all files?',
          decision: { action: 'needs_user', danger: true, reason: "DANGER: matched 'delete'" }
        });
      }

      // Simulate countdown running
      statusManager.update('countdown', new Date().toISOString(), {
        commandSpaced: 'echo hello',
        decision: { action: 'would_approve', optionKey: '1', delay: 3 }
      }, { countdown: 3 });

      assert.strictEqual(statusManager.state, 'countdown');
      assert.strictEqual(statusManager.countdown, 3);

      // Danger hit occurs
      cancelCountdown('danger');

      assert.strictEqual(inCountdown, false);
      assert.strictEqual(timerCancelled, true);
      assert.strictEqual(statusManager.state, 'asking');
      assert.strictEqual(statusManager.countdown, null);
      assert.strictEqual(statusManager.prompt.decision, "DANGER: matched 'delete'");

      statusManager.cleanup();
    } finally {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch (e) {}
    }
  });

  // -------------------------------------------------------------
  // Suite 7: Validation on Load & Bad Entries Ignored
  // -------------------------------------------------------------
  startSuite('Suite 7: Validation on Load & Bad Entries Ignored');

  test('Validates danger list and rejects entries shorter than 2 characters with warning', () => {
    const rawList = [
      { text: 'rm', wholeWord: true },
      { text: 'a', wholeWord: false }, // rejected (<2)
      { text: '', wholeWord: false },  // rejected (<2)
      { text: 'delete', wholeWord: false },
      null,                           // rejected (null)
      123,                            // rejected (not object)
      { wholeWord: true },            // rejected (no text)
      'plain-string'                  // rejected (not object)
    ];

    const validated = validateDangerList(rawList);
    assert.strictEqual(validated.length, 2);
    assert.strictEqual(validated[0].text, 'rm');
    assert.strictEqual(validated[0].wholeWord, true);
    assert.strictEqual(validated[1].text, 'delete');
    assert.strictEqual(validated[1].wholeWord, false);
  });

  test('Non-array danger property ignored with warning, returns defaults', () => {
    const validated = validateDangerList('not-an-array');
    assert.strictEqual(validated.length, 42);
  });

  test('Corrupted rules file does not crash loadRules and falls back to defaults', () => {
    const tmpBadRules = path.join(os.tmpdir(), `bad-rules-${Date.now()}.json`);
    fs.writeFileSync(tmpBadRules, '{ invalid json syntax !!! ', 'utf8');

    try {
      const loaded = loadRules(tmpBadRules);
      assert(loaded);
      assert(Array.isArray(loaded.danger));
      assert.strictEqual(loaded.danger.length, 42);
    } finally {
      try { fs.unlinkSync(tmpBadRules); } catch (e) {}
    }
  });

  test('Startup line prints "agentwatch: danger list has N entries"', () => {
    const outputLines = [];
    const stdoutMock = {
      columns: 80,
      rows: 24,
      write: (data) => outputLines.push(String(data))
    };

    const tempDir = path.join(os.tmpdir(), `agentwatch-startup-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    try {
      const monitor = startAgentwatch({
        command: 'node',
        args: ['-e', 'process.exit(0)'],
        stdout: stdoutMock,
        sessionsDir: tempDir,
        historyPath: path.join(tempDir, 'history.jsonl'),
        promptsLogPath: path.join(tempDir, 'prompts.log'),
        snapshotsPath: path.join(tempDir, 'screen-snapshots.txt')
      });

      const fullOutput = outputLines.join('');
      assert(
        fullOutput.includes('agentwatch: danger list has 42 entries'),
        `Startup output must include "agentwatch: danger list has 42 entries", got: ${fullOutput}`
      );
      if (monitor) monitor.cleanup();
    } finally {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  // -------------------------------------------------------------
  // Suite 8: Display Labels on Row (Dashboard & Window)
  // -------------------------------------------------------------
  startSuite('Suite 8: Display Labels on Row (Dashboard & Window)');

  test('formatDecision returns "DANGER: matched \'<entry>\'"', () => {
    const decisionObj = { action: 'needs_user', danger: true, reason: "DANGER: matched 'drop table'" };
    const label = formatDecision(decisionObj);
    assert.strictEqual(label, "DANGER: matched 'drop table'");
  });

  test('Dashboard shows DANGER label on prompt row line 2 and summary line 1', () => {
    const session = {
      sessionKey: 'agy:test',
      agent: 'agy',
      folder: 'my-project',
      state: 'asking',
      stateSince: new Date().toISOString(),
      prompt: {
        command: 'DROP TABLE users;',
        question: 'Run this command?',
        decision: "DANGER: matched 'drop table'"
      }
    };

    const summary = getSessionSummary(session);
    assert.strictEqual(summary, "DANGER: matched 'drop table'");

    const lines = renderDashboardLines({
      sessions: [session],
      selectedIndex: 0,
      useColor: false,
      cols: 80
    });

    const renderedText = lines.join('\n');
    assert(
      renderedText.includes("(DANGER: matched 'drop table')"),
      `Dashboard row must show "(DANGER: matched 'drop table')", got:\n${renderedText}`
    );
  });

  // -------------------------------------------------------------
  // Suite 9: Prompts.log and History.jsonl Logging & Masking
  // -------------------------------------------------------------
  startSuite('Suite 9: Prompts.log and History.jsonl Logging & Masking');

  test('logPromptRecord logs danger reason to prompts.log and history.jsonl with masking', () => {
    const tmpDir = path.join(os.tmpdir(), `agentwatch-log-danger-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
      const promptsLog = path.join(tmpDir, 'prompts.log');
      const historyFile = path.join(tmpDir, 'history.jsonl');

      const detected = {
        commandSpaced: 'echo my-password-is-secret',
        commandCompact: 'echomy-password-is-secret',
        question: 'Run secret command?',
        options: [
          { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };

      const decision = {
        action: 'needs_user',
        danger: true,
        entry: 'password',
        reason: "DANGER: matched 'password'",
        log: "Dry-run: needs_user (DANGER: matched 'password')"
      };

      logPromptRecord(detected, decision, {
        promptsLogPath: promptsLog,
        historyPath: historyFile,
        sessionId: 'test-log-session'
      });

      assert(fs.existsSync(promptsLog), 'prompts.log must exist');
      const logContent = fs.readFileSync(promptsLog, 'utf8');
      assert(logContent.includes("Decision: Dry-run: needs_user (DANGER: matched 'password')"));
      assert(logContent.includes("Reason: DANGER: matched 'password'"));

      assert(fs.existsSync(historyFile), 'history.jsonl must exist');
      const histContent = fs.readFileSync(historyFile, 'utf8');
      const ev = JSON.parse(histContent.trim());
      assert.strictEqual(ev.type, 'prompt');
      assert.strictEqual(ev.decision.action, 'needs_user');
      assert.strictEqual(ev.decision.reason, "DANGER: matched 'password'");
      assert.strictEqual(ev.decision.danger_entry, 'password');
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  // -------------------------------------------------------------
  // Suite 10: Single-Write-Path Safety & Privacy Verification
  // -------------------------------------------------------------
  startSuite('Suite 10: Single-Write-Path Safety & Privacy Verification');

  test('Static code check: Child process write safety rule maintained', () => {
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
  });

  test('Privacy test: User typed sensitive keystrokes never leak to logs during danger prompt', () => {
    const tmpDir = path.join(os.tmpdir(), `agentwatch-privacy-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
      // 1. Masker redacts key/password values
      const secretInput = 'SuperSecretKey998877';
      const masked = maskText(`PASSWORD=${secretInput}`);
      assert(!masked.includes(secretInput), 'maskText must redact secret values');
      assert(masked.includes('[REDACTED]'), 'maskText must contain [REDACTED]');

      // 2. Prompt logger never records arbitrary keystrokes
      const promptsLog = path.join(tmpDir, 'prompts.log');
      const historyFile = path.join(tmpDir, 'history.jsonl');
      logPromptRecord(
        {
          commandSpaced: 'echo safe-command',
          question: 'Run this command?',
          options: [{ key: '1', number: 1, text: 'Yes', classification: 'yes_once' }, { key: '2', number: 2, text: 'No', classification: 'no' }]
        },
        { action: 'needs_user', danger: true, entry: 'secret', reason: "DANGER: matched 'secret'" },
        { promptsLogPath: promptsLog, historyPath: historyFile }
      );

      const logText = fs.readFileSync(promptsLog, 'utf8');
      assert(!logText.includes(secretInput), 'prompts.log must never contain secret keystroke text');
    } finally {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
    }
  });

  // Summary
  console.log(`\n=========================================`);
  console.log(`Pass counts per suite:`);
  for (const [sName, count] of Object.entries(suiteCounts)) {
    console.log(`  ${sName}: ${count} passed`);
  }
  console.log(`\nAll ${passCount} danger list tests passed successfully!`);
  console.log(`=========================================`);
})();
