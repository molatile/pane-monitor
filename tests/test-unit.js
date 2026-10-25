const assert = require('assert');
const { extractPromptFromScreen } = require('../src/parser');
const { resolveExecutable } = require('../src/resolver');

console.log('Running unit tests...\n');

// Test 1: Real Antigravity CLI permission prompt with hard wrapping, column-0 continuations, and '...' truncation
{
  const lines = [
    { text: 'Requesting permission for:', isWrapped: false },
    { text: '   echo', isWrapped: false },
    {
      text: 'this-is-a-long-test-message-to-check-how-wrapping-works-in-the-permission-prompt-one-two-three-four-five-six',
      isWrapped: false
    },
    {
      text: '-seven-eight-nine-ten-eleven-twelve-thirteen-fourteen-fifteen',
      isWrapped: false
    },
    { text: '', isWrapped: false },
    { text: 'Run this command?', isWrapped: false },
    { text: '> 1. Yes, run command', isWrapped: false },
    {
      text: "  2. Yes, and always allow in this conversation for commands that start with 'echo",
      isWrapped: false
    },
    { text: 'this-is-a-long-test-message-to-', isWrapped: false },
    {
      text: "  check-how-wrapping-works-in-the-permission-p...'",
      isWrapped: false
    },
    {
      text: "  3. Yes, and always allow for commands that start with 'echo",
      isWrapped: false
    },
    {
      text: 'this-is-a-long-test-message-to-check-how-wrapping-',
      isWrapped: false
    },
    {
      text: "  works-in-the-permission-p...' (Persist to settings.json)",
      isWrapped: false
    },
    { text: '  4. No, cancel', isWrapped: false },
    { text: '', isWrapped: false },
    {
      text: '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command',
      isWrapped: false
    },
    {
      text: 'esc to cancel                         Gemini 3.8 Flash · high',
      isWrapped: false
    }
  ];

  const result = extractPromptFromScreen(lines);
  assert(result !== null, 'Test 1 failed: Result should not be null');
  assert.strictEqual(
    result.commandSpaced,
    'echo this-is-a-long-test-message-to-check-how-wrapping-works-in-the-permission-prompt-one-two-three-four-five-six -seven-eight-nine-ten-eleven-twelve-thirteen-fourteen-fifteen'
  );
  assert.strictEqual(
    result.commandCompact,
    'echothis-is-a-long-test-message-to-check-how-wrapping-works-in-the-permission-prompt-one-two-three-four-five-six-seven-eight-nine-ten-eleven-twelve-thirteen-fourteen-fifteen'
  );
  assert.strictEqual(result.question, 'Run this command?');
  assert.strictEqual(result.options.length, 4);
  assert.strictEqual(result.options[0].number, 1);
  assert.strictEqual(result.options[0].text, 'Yes, run command');
  assert.strictEqual(result.options[1].number, 2);
  assert.strictEqual(
    result.options[1].text,
    "Yes, and always allow in this conversation for commands that start with 'echo this-is-a-long-test-message-to- check-how-wrapping-works-in-the-permission-p...'"
  );
  assert.strictEqual(result.options[2].number, 3);
  assert.strictEqual(
    result.options[2].text,
    "Yes, and always allow for commands that start with 'echo this-is-a-long-test-message-to-check-how-wrapping- works-in-the-permission-p...' (Persist to settings.json)"
  );
  assert.strictEqual(result.options[3].number, 4);
  assert.strictEqual(result.options[3].text, 'No, cancel');
  assert.strictEqual(result.footerSeen, true);
  console.log('✓ Test 1: Real Antigravity permission prompt passed');
}

// Test 2: Command split inside a word
{
  const lines = [
    { text: 'Requesting permission for:', isWrapped: false },
    { text: '   docker container exec -it my-running-con', isWrapped: false },
    { text: 'tainer /bin/sh', isWrapped: false },
    { text: 'Run this command?', isWrapped: false },
    { text: '> 1. Yes, run command', isWrapped: false },
    { text: '  2. No, cancel', isWrapped: false },
    { text: '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command', isWrapped: false }
  ];

  const result = extractPromptFromScreen(lines);
  assert(result !== null, 'Test 2 failed: Result should not be null');
  assert.strictEqual(
    result.commandSpaced,
    'docker container exec -it my-running-con tainer /bin/sh'
  );
  assert.strictEqual(
    result.commandCompact,
    'dockercontainerexec-itmy-running-container/bin/sh'
  );
  assert.strictEqual(result.options.length, 2);
  assert.strictEqual(result.options[0].text, 'Yes, run command');
  assert.strictEqual(result.options[1].text, 'No, cancel');
  console.log('✓ Test 2: Command split inside a word passed');
}

// Test 3: Simple single-line command
{
  const lines = [
    { text: 'Requesting permission for:', isWrapped: false },
    { text: '   echo hello', isWrapped: false },
    { text: 'Run this command?', isWrapped: false },
    { text: '> 1. Yes, run command', isWrapped: false },
    { text: "  2. Yes, and always allow in this conversation for commands that start with 'echo hello'", isWrapped: false },
    { text: "  3. Yes, and always allow for commands that start with 'echo hello' (Persist to settings.json)", isWrapped: false },
    { text: '  4. No, cancel', isWrapped: false },
    { text: '', isWrapped: false },
    { text: '  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command', isWrapped: false },
    { text: 'esc to cancel', isWrapped: false }
  ];

  const result = extractPromptFromScreen(lines);
  assert(result !== null, 'Test 3 failed: Result should not be null');
  assert.strictEqual(result.commandSpaced, 'echo hello');
  assert.strictEqual(result.commandCompact, 'echohello');
  assert.strictEqual(result.options.length, 4);
  console.log('✓ Test 3: Simple single-line command passed');
}

// Test 4: Trailing padding spaces on every line trimmed
{
  const lines = [
    { text: 'Requesting permission for:           ', isWrapped: false },
    { text: '   git checkout                      ', isWrapped: false },
    { text: '   -b feature-branch                 ', isWrapped: false },
    { text: 'Run this command?                    ', isWrapped: false },
    { text: '> 1. Yes, run command                ', isWrapped: false },
    { text: '  2. No, cancel                      ', isWrapped: false },
    { text: '  ↑/↓ Navigate · tab Amend           ', isWrapped: false }
  ];

  const result = extractPromptFromScreen(lines);
  assert(result !== null, 'Test 4 failed: Result should not be null');
  assert.strictEqual(result.commandSpaced, 'git checkout -b feature-branch');
  assert.strictEqual(result.commandCompact, 'gitcheckout-bfeature-branch');
  assert.strictEqual(result.options[0].text, 'Yes, run command');
  assert.strictEqual(result.options[1].text, 'No, cancel');
  console.log('✓ Test 4: Trailing padding spaces trimming passed');
}

// Test 5: Footer immediately follows option without empty line
{
  const lines = [
    { text: 'Requesting permission for:', isWrapped: false },
    { text: '   echo test', isWrapped: false },
    { text: 'Run this command?', isWrapped: false },
    { text: '  1. Yes, run command', isWrapped: false },
    { text: '> 2. No, cancel', isWrapped: false },
    { text: '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command', isWrapped: false }
  ];

  const result = extractPromptFromScreen(lines);
  assert(result !== null, 'Test 5 failed: Result should not be null');
  assert.strictEqual(result.commandSpaced, 'echo test');
  assert.strictEqual(result.options.length, 2);
  assert.strictEqual(result.options[1].text, 'No, cancel');
  console.log('✓ Test 5: Footer immediately following option passed');
}

// Test 6: Incomplete prompt rejected when footer line has not been seen
{
  const lines = [
    { text: 'Requesting permission for:', isWrapped: false },
    { text: '   echo test', isWrapped: false },
    { text: 'Run this command?', isWrapped: false },
    { text: '> 1. Yes, run command', isWrapped: false },
    { text: '  2. No, cancel', isWrapped: false }
    // Footer line not present
  ];

  const result = extractPromptFromScreen(lines);
  assert.strictEqual(result, null, 'Test 6 failed: Prompt without footer must return null');
  console.log('✓ Test 6: Prompt without footer rejected as incomplete');
}

// Test 7: Incomplete prompt rejected when fewer than 2 options
{
  const lines = [
    { text: 'Requesting permission for:', isWrapped: false },
    { text: '   echo test', isWrapped: false },
    { text: 'Run this command?', isWrapped: false },
    { text: '> 1. Yes, run command', isWrapped: false },
    { text: '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command', isWrapped: false }
  ];

  const result = extractPromptFromScreen(lines);
  assert.strictEqual(result, null, 'Test 7 failed: Prompt with < 2 options must return null');
  console.log('✓ Test 7: Prompt with < 2 options rejected as incomplete');
}

// Test 8: Normal terminal output that is NOT a permission prompt
{
  const lines = [
    { text: 'Compiling project...', isWrapped: false },
    { text: '1. Building core module', isWrapped: false },
    { text: 'Build completed successfully in 1.4s', isWrapped: false }
  ];

  const result = extractPromptFromScreen(lines);
  assert.strictEqual(result, null, 'Test 8 failed: Non-prompt should return null');
  console.log('✓ Test 8: Non-prompt rejection passed');
}

// Test 9: Executable resolver
{
  const agy = resolveExecutable('agy');
  assert(agy && agy.toLowerCase().includes('agy'), 'Test 9 failed: Failed to resolve agy');
  const cmd = resolveExecutable('cmd');
  assert(cmd && cmd.toLowerCase().includes('cmd'), 'Test 9 failed: Failed to resolve cmd');
  console.log('✓ Test 9: Executable resolver passed (agy -> ' + agy + ')');
}

// Test 10: Selection arrow movement does not alter extracted prompt options
{
  const linesOption1 = [
    { text: 'Requesting permission for:', isWrapped: false },
    { text: '   echo test', isWrapped: false },
    { text: 'Run this command?', isWrapped: false },
    { text: '> 1. Yes, run command', isWrapped: false },
    { text: '  2. No, cancel', isWrapped: false },
    { text: '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command', isWrapped: false }
  ];
  const linesOption2 = [
    { text: 'Requesting permission for:', isWrapped: false },
    { text: '   echo test', isWrapped: false },
    { text: 'Run this command?', isWrapped: false },
    { text: '  1. Yes, run command', isWrapped: false },
    { text: '> 2. No, cancel', isWrapped: false },
    { text: '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command', isWrapped: false }
  ];

  const res1 = extractPromptFromScreen(linesOption1);
  const res2 = extractPromptFromScreen(linesOption2);
  assert(res1 !== null && res2 !== null, 'Test 10 failed: Both prompts should be valid');
  assert.deepStrictEqual(res1.options, res2.options, 'Test 10 failed: Options must match regardless of arrow position');
  assert.strictEqual(res1.question, res2.question);
  assert.strictEqual(res1.commandSpaced, res2.commandSpaced);
  console.log('✓ Test 10: Selection arrow movement invariance passed');
}

// Test 11: background_task_patterns in profiles/agy.json
{
  const agyProfile = require('../profiles/agy.json');
  assert(Array.isArray(agyProfile.background_task_patterns), 'Test 11 failed: background_task_patterns must be an array in profiles/agy.json');
  assert(agyProfile.background_task_patterns.length > 0, 'Test 11 failed: background_task_patterns must have at least one pattern');

  const bgRegex = new RegExp(agyProfile.background_task_patterns[0]);
  const liveScreenLine = '  ● [15:36:34] Start-Sleep -Seconds 90 running';
  assert(bgRegex.test(liveScreenLine), `Test 11 failed: pattern must match "${liveScreenLine}"`);

  // Non-matching lines
  assert(!bgRegex.test('  ● Ran (Start-Sleep -Seconds 90)'), 'Must not match finished tool call');
  assert(!bgRegex.test('  ○ Running (Start-Sleep -Seconds 90)'), 'Must not match tool call line');
  assert(!bgRegex.test('? for shortcuts                     Gemini 3.8 Flash · high  12:00:00'), 'Must not match status line');
  console.log('✓ Test 11: background_task_patterns in profiles/agy.json passed');
}

// Test 12: State classifier with exact live Antigravity CLI screen:
// BUSY while background line is present even after 60 quiet seconds, IDLE after it disappears,
// and bracketed clock text changes not counted as text change
{
  const { SessionStateTracker } = require('../src/state');
  const agyProfile = require('../profiles/agy.json');
  const tracker = new SessionStateTracker(agyProfile);

  const exactScreen = [
    '────────────────────────',
    '>',
    '────────────────────────',
    '  ● [15:36:34] Start-Sleep -Seconds 90 running',
    '────────────────────────'
  ];

  let simTime = 10000;
  // 1. Initial screen: background task running
  tracker.evaluateState({
    isPromptActive: false,
    isInputBoxVisible: true,
    screenLines: exactScreen,
    nowMs: simTime
  });
  assert.strictEqual(tracker.currentState, 'busy', 'Test 12 failed: Must be BUSY with background task on screen');
  assert.strictEqual(tracker.backgroundTasks, 1, 'Test 12 failed: Exactly 1 background task running');

  const initialChangeTime = tracker.lastChangeTime;

  // 2. Advance 60 quiet seconds with clock text inside brackets updating:
  // Must remain BUSY, and changing clock text inside brackets must NOT count as a text change
  for (let sec = 1; sec <= 60; sec++) {
    simTime += 1000;
    const secStr = String(34 + sec).padStart(2, '0');
    const screenTick = [
      '────────────────────────',
      '>',
      '────────────────────────',
      `  ● [15:36:${secStr}] Start-Sleep -Seconds 90 running`,
      '────────────────────────'
    ];
    tracker.evaluateState({
      isPromptActive: false,
      isInputBoxVisible: true,
      screenLines: screenTick,
      nowMs: simTime
    });
    assert.strictEqual(tracker.currentState, 'busy', `Test 12 failed: Must remain BUSY at second ${sec}`);
    assert.strictEqual(
      tracker.lastChangeTime,
      initialChangeTime,
      'Test 12 failed: Changing clock text inside brackets must NOT update lastChangeTime'
    );
  }

  // 3. Task finishes: background line disappears
  simTime += 100;
  const screenAfterDisappear = [
    '────────────────────────',
    '>',
    '────────────────────────',
    '────────────────────────'
  ];
  tracker.evaluateState({
    isPromptActive: false,
    isInputBoxVisible: true,
    screenLines: screenAfterDisappear,
    nowMs: simTime
  });
  assert.strictEqual(tracker.currentState, 'idle', 'Test 12 failed: Must transition to IDLE after background line disappears');
  assert.strictEqual(tracker.backgroundTasks, 0, 'Test 12 failed: Background tasks count must be 0 after disappearing');

  // 4. Tool-call line starting with "○ Running (" is BUSY while on screen
  const toolScreen = [
    '────────────────────────',
    '>',
    '────────────────────────',
    '○ Running (Start-Sleep -Seconds 90) (ctrl+o to expand)',
    '────────────────────────'
  ];
  tracker.evaluateState({
    isPromptActive: false,
    isInputBoxVisible: true,
    screenLines: toolScreen,
    nowMs: simTime + 1000
  });
  assert.strictEqual(tracker.currentState, 'busy', 'Test 12 failed: Tool-call line starting with "○ Running (" must be BUSY');

  console.log('✓ Test 12: Exact screen BUSY after 60 quiet seconds, IDLE after disappearing, and clock change invariance passed');
}

// Test 13: Multiple background lines counted correctly and dashboard summary
{
  const { SessionStateTracker } = require('../src/state');
  const { getSessionSummary } = require('../src/dashboard');
  const agyProfile = require('../profiles/agy.json');
  const tracker = new SessionStateTracker(agyProfile);

  const multiScreen = [
    '────────────────────────',
    '>',
    '────────────────────────',
    '  ● [15:36:34] Start-Sleep -Seconds 90 running',
    '  ● [15:36:40] python -m worker running',
    '────────────────────────'
  ];

  tracker.evaluateState({
    isPromptActive: false,
    isInputBoxVisible: true,
    screenLines: multiScreen,
    nowMs: 10000
  });
  assert.strictEqual(tracker.currentState, 'busy');
  assert.strictEqual(tracker.backgroundTasks, 2, 'Test 13 failed: Must count 2 background tasks');
  assert.strictEqual(
    getSessionSummary({ state: 'busy', backgroundTasks: tracker.backgroundTasks }),
    '2 background tasks running',
    'Test 13 failed: Dashboard summary must show "2 background tasks running"'
  );

  // Single background task summary
  assert.strictEqual(
    getSessionSummary({ state: 'busy', backgroundTasks: 1 }),
    '1 background task running',
    'Test 13 failed: Dashboard summary must show "1 background task running"'
  );

  console.log('✓ Test 13: Multiple background lines counted correctly and dashboard summary display passed');
}

// Test 14: Starter allow list & strict matching rules
{
  const { evaluatePrompt, containsForbiddenShellSyntax } = require('../src/rules');

  function makePrompt(cmdSpaced, cmdCompact, options) {
    return {
      commandSpaced: cmdSpaced,
      commandCompact: cmdCompact || cmdSpaced.replace(/\s+/g, ''),
      question: 'Run this command?',
      options: options || [
        { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
        { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
      ]
    };
  }

  // 1. Tier 1 allowed commands
  const allowedCommands = [
    { cmd: 'git status', rule: 'git-readonly' },
    { cmd: 'git diff', rule: 'git-readonly' },
    { cmd: 'git log', rule: 'git-readonly' },
    { cmd: 'git branch', rule: 'git-readonly' },
    { cmd: 'git log --oneline', rule: 'git-readonly' },
    { cmd: 'git log -n 5', rule: 'git-readonly' },
    { cmd: 'git diff --stat', rule: 'git-readonly' },
    { cmd: 'git branch -a', rule: 'git-readonly' },
    { cmd: 'git branch -r', rule: 'git-readonly' },
    { cmd: 'git diff HEAD~1', rule: 'git-readonly' },
    { cmd: 'ls', rule: 'file-list' },
    { cmd: 'dir', rule: 'file-list' },
    { cmd: 'Get-ChildItem', rule: 'file-list' },
    { cmd: 'pwd', rule: 'file-list' },
    { cmd: 'Get-Location', rule: 'file-list' },
    { cmd: 'ls src', rule: 'file-list' },
    { cmd: 'ls ./src', rule: 'file-list' },
    { cmd: 'dir src\\gui', rule: 'file-list' },
    { cmd: 'dir .\\src', rule: 'file-list' },
    { cmd: 'ls package.json', rule: 'file-list' },
    { cmd: 'ls -la', rule: 'file-list' },
    { cmd: 'npm --version', rule: 'version-check' },
    { cmd: 'node --version', rule: 'version-check' },
    { cmd: 'npm -v', rule: 'version-check' },
    { cmd: 'node -v', rule: 'version-check' },
    { cmd: 'echo hello', rule: 'echo-safe' },
    { cmd: 'echo "hello world"', rule: 'echo-safe' },
    { cmd: 'echo fast-test-command', rule: 'echo-safe' }
  ];

  for (const { cmd, rule } of allowedCommands) {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.strictEqual(d.action, 'would_approve', `Expected would_approve for "${cmd}", got "${d.action}"`);
    assert.strictEqual(d.rule, rule, `Expected rule "${rule}" for "${cmd}", got "${d.rule}"`);
    assert.strictEqual(d.delay, 3, `Expected delay 3 for "${cmd}"`);
    assert.strictEqual(d.optionKey, '1');
    assert.strictEqual(d.log, `Dry-run: would approve option 1 after 3s (rule: ${rule})`);
  }

  // 2. Commands with shell syntax appended are NOT allowed
  const injections = ['; rm -rf x', '&& whoami', '| sh', '> file', '$(whoami)'];
  for (const { cmd } of allowedCommands) {
    for (const inj of injections) {
      const maliciousCmd = `${cmd} ${inj}`;
      const d = evaluatePrompt(makePrompt(maliciousCmd));
      assert.notStrictEqual(d.action, 'would_approve', `Malicious command "${maliciousCmd}" must NOT be would_approve`);
      assert(d.action === 'blocked' || d.action === 'needs_user');
    }
  }

  // 3. Echo specific tests
  assert.strictEqual(evaluatePrompt(makePrompt('echo hello')).action, 'would_approve');
  const dEchoEnv = evaluatePrompt(makePrompt('echo hello >> .env'));
  assert.strictEqual(dEchoEnv.action, 'blocked');
  assert.strictEqual(dEchoEnv.rule, '.env');
  const dEchoVar = evaluatePrompt(makePrompt('echo $env:USERPROFILE'));
  assert.strictEqual(dEchoVar.action, 'needs_user');
  assert.strictEqual(dEchoVar.reason, 'forbidden shell syntax');

  // 4. Git status vs git push --force
  assert.strictEqual(evaluatePrompt(makePrompt('git status')).action, 'would_approve');
  const dPush = evaluatePrompt(makePrompt('git push --force'));
  assert.strictEqual(dPush.action, 'blocked');
  assert.strictEqual(dPush.rule, 'git push --force');

  // 5. Commands matching ONLY when compacted (whitespace removed) must NOT be allowed
  const compactOnly = [
    { spaced: 'g i t s t a t u s', compact: 'gitstatus' },
    { spaced: 'l s', compact: 'ls' },
    { spaced: 'd i r', compact: 'dir' },
    { spaced: 'n p m - - v e r s i o n', compact: 'npm--version' },
    { spaced: 'e c h o h e l l o', compact: 'echohello' }
  ];
  for (const c of compactOnly) {
    const d = evaluatePrompt(makePrompt(c.spaced, c.compact));
    assert.strictEqual(d.action, 'needs_user', `Spaced command "${c.spaced}" must NOT be approved`);
  }

  // 6. Tier 2 commands are needs_user while tier 2 is disabled
  const tier2Commands = ['npm run build', 'npm run lint', 'npm run dev', 'npm test'];
  for (const cmd of tier2Commands) {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.strictEqual(d.action, 'needs_user', `Tier 2 command "${cmd}" must be needs_user while disabled`);
    assert.strictEqual(d.reason, 'no allow rule matched');
  }

  // 7. Sensitive targets blocked by deny list
  const sensitiveCommands = [
    { cmd: 'git diff .env', expectedRule: '.env' },
    { cmd: 'ls settings.json', expectedRule: 'settings.json' },
    { cmd: 'cat ~/.ssh/id_rsa', expectedRule: '.ssh' },
    { cmd: 'echo my credentials', expectedRule: 'credentials' }
  ];
  for (const { cmd, expectedRule } of sensitiveCommands) {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.strictEqual(d.action, 'blocked', `Expected blocked for "${cmd}"`);
    assert.strictEqual(d.rule, expectedRule, `Expected rule "${expectedRule}" for "${cmd}"`);
  }

  // 8. Path traversal and absolute paths rejected
  const invalidPaths = ['ls ..', 'ls ../', 'ls ..\\src', 'ls /', 'ls /etc', 'ls \\Windows', 'ls C:\\Users', 'dir D:\\temp'];
  for (const cmd of invalidPaths) {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.strictEqual(d.action, 'needs_user', `Invalid path command "${cmd}" must NOT be approved`);
  }

  // 9. Option eligibility: options 2 and 3 never eligible
  const dSession = evaluatePrompt(makePrompt('git status', null, [
    { key: '2', number: 2, text: 'Yes, allow for session', classification: 'yes_session' },
    { key: '4', number: 4, text: 'No, cancel', classification: 'no' }
  ]));
  assert.strictEqual(dSession.action, 'needs_user');
  assert.strictEqual(dSession.reason, 'no eligible yes_once option');

  // 10. Safety review disallowed commands (never would_approve)
  const reviewDisallowed = [
    'node -e "console.log(1)"',
    'node script.js',
    'npm install lodash',
    'npx something',
    'npm run build',
    'git branch -D main',
    'git branch -d feature',
    'git branch newbranch',
    'git diff --output=out.txt',
    'git log --output=x.txt',
    'Get-ChildItem -Path . | Remove-Item',
    'dir > out.txt'
  ];
  for (const cmd of reviewDisallowed) {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.notStrictEqual(d.action, 'would_approve', `Command "${cmd}" must not be would_approve`);
    assert(d.action === 'needs_user' || d.action === 'blocked');
  }

  // 11. Git branch listing forms vs non-listing forms
  const allowedBranches = ['git branch', 'git branch -a', 'git branch -r', 'git branch --list', 'git branch -v'];
  for (const cmd of allowedBranches) {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.strictEqual(d.action, 'would_approve');
    assert.strictEqual(d.rule, 'git-readonly');
  }
  const rejectedBranches = ['git branch -D main', 'git branch -d feature', 'git branch newbranch', 'git branch -m old new', 'git branch --delete foo'];
  for (const cmd of rejectedBranches) {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.strictEqual(d.action, 'needs_user');
  }

  // 12. Git diff and git log reject --output, -o, -O, --output-directory
  const rejectedDiffLog = [
    'git diff --output=out.txt',
    'git diff --output out.txt',
    'git diff -o out.txt',
    'git diff -o=out.txt',
    'git diff -O orderfile',
    'git diff --output-directory=out',
    'git log --output=x.txt',
    'git log --output x.txt',
    'git log -o x.txt',
    'git log -o=x.txt',
    'git log -O x.txt',
    'git log --output-directory=out'
  ];
  for (const cmd of rejectedDiffLog) {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.strictEqual(d.action, 'needs_user');
  }

  console.log('✓ Test 14: Starter allow list & strict matching rules verified');
}

console.log('\nAll unit tests passed successfully!');
