const assert = require('assert');
const { evaluatePrompt, loadRules, containsForbiddenShellSyntax, checkDenyRule } = require('../src/rules');

console.log('Running agentwatch starter allow list and strict matching test suite...\n');

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

startSuite('Suite 1: Tier 1 Allowed Commands & Names');
const tier1Allowed = [
  // Git readonly
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
  // File listing
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
  // Version checks
  { cmd: 'npm --version', rule: 'version-check' },
  { cmd: 'node --version', rule: 'version-check' },
  { cmd: 'npm -v', rule: 'version-check' },
  { cmd: 'node -v', rule: 'version-check' },
  // Echo
  { cmd: 'echo hello', rule: 'echo-safe' },
  { cmd: 'echo "hello world"', rule: 'echo-safe' },
  { cmd: 'echo fast-test-command', rule: 'echo-safe' }
];

for (const { cmd, rule } of tier1Allowed) {
  test(`Tier 1 allowed: "${cmd}" -> ${rule}`, () => {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.strictEqual(d.action, 'would_approve');
    assert.strictEqual(d.rule, rule);
    assert.strictEqual(d.delay, 3);
    assert.strictEqual(d.optionKey, '1');
    assert.strictEqual(d.log, `Dry-run: would approve option 1 after 3s (rule: ${rule})`);
  });
}

startSuite('Suite 2: Shell Syntax Injections Rejection');
const injections = ['; rm -rf x', '&& whoami', '| sh', '> file', '$(whoami)'];
for (const { cmd } of tier1Allowed) {
  for (const inj of injections) {
    const malicious = `${cmd} ${inj}`;
    test(`Reject shell syntax injection: "${malicious}"`, () => {
      const d = evaluatePrompt(makePrompt(malicious));
      assert.notStrictEqual(d.action, 'would_approve');
      assert(d.action === 'blocked' || d.action === 'needs_user');
    });
  }
}

startSuite('Suite 3: Echo and Environment Variables');
test('echo hello is allowed', () => {
  const d = evaluatePrompt(makePrompt('echo hello'));
  assert.strictEqual(d.action, 'would_approve');
  assert.strictEqual(d.rule, 'echo-safe');
});

test('echo hello >> .env is blocked by deny list', () => {
  const d = evaluatePrompt(makePrompt('echo hello >> .env'));
  assert.strictEqual(d.action, 'blocked');
  assert.strictEqual(d.rule, '.env');
});

test('echo $env:USERPROFILE is rejected (forbidden shell syntax)', () => {
  const d = evaluatePrompt(makePrompt('echo $env:USERPROFILE'));
  assert.strictEqual(d.action, 'needs_user');
  assert.strictEqual(d.reason, 'forbidden shell syntax');
});

startSuite('Suite 4: Git Status Allowed vs Git Push Blocked');
test('git status is allowed', () => {
  const d = evaluatePrompt(makePrompt('git status'));
  assert.strictEqual(d.action, 'would_approve');
  assert.strictEqual(d.rule, 'git-readonly');
});

test('git push --force is blocked by deny list', () => {
  const d = evaluatePrompt(makePrompt('git push --force'));
  assert.strictEqual(d.action, 'blocked');
  assert.strictEqual(d.rule, 'git push --force');
});

startSuite('Suite 5: Compacted-only Commands Rejection');
const compactedCommands = [
  { spaced: 'g i t s t a t u s', compact: 'gitstatus' },
  { spaced: 'l s', compact: 'ls' },
  { spaced: 'd i r', compact: 'dir' },
  { spaced: 'n p m - - v e r s i o n', compact: 'npm--version' },
  { spaced: 'e c h o h e l l o', compact: 'echohello' }
];

for (const { spaced, compact } of compactedCommands) {
  test(`Reject compact-only match: "${spaced}"`, () => {
    const d = evaluatePrompt(makePrompt(spaced, compact));
    assert.strictEqual(d.action, 'needs_user');
  });
}

startSuite('Suite 6: Tier 2 Commands Disabled');
const tier2List = ['npm run build', 'npm run lint', 'npm run dev', 'npm test'];
for (const cmd of tier2List) {
  test(`Tier 2 disabled command needs_user: "${cmd}"`, () => {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.strictEqual(d.action, 'needs_user');
    assert.strictEqual(d.reason, 'no allow rule matched');
  });
}

startSuite('Suite 7: Sensitive Targets Blocked by Deny List');
const sensitiveCases = [
  { cmd: 'git diff .env', rule: '.env' },
  { cmd: 'ls settings.json', rule: 'settings.json' },
  { cmd: 'cat ~/.ssh/id_rsa', rule: '.ssh' },
  { cmd: 'echo credentials', rule: 'credentials' }
];
for (const { cmd, rule } of sensitiveCases) {
  test(`Sensitive target blocked: "${cmd}" -> rule: ${rule}`, () => {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.strictEqual(d.action, 'blocked');
    assert.strictEqual(d.rule, rule);
  });
}

startSuite('Suite 8: File Listing Path Traversal & Absolute Paths');
const invalidPaths = [
  'ls ..',
  'ls ../',
  'ls ..\\src',
  'ls /',
  'ls /etc',
  'ls \\Windows',
  'ls C:\\Users',
  'dir D:\\temp'
];
for (const cmd of invalidPaths) {
  test(`Invalid path rejected: "${cmd}"`, () => {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.strictEqual(d.action, 'needs_user');
  });
}

startSuite('Suite 9: Option Eligibility Rules');
test('Only option 1 (yes_once) is eligible', () => {
  const dOnce = evaluatePrompt(makePrompt('git status', null, [
    { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
    { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
  ]));
  assert.strictEqual(dOnce.action, 'would_approve');
});

test('Option 2 (yes_session) is never eligible', () => {
  const dSession = evaluatePrompt(makePrompt('git status', null, [
    { key: '2', number: 2, text: 'Yes, allow for session', classification: 'yes_session' },
    { key: '4', number: 4, text: 'No, cancel', classification: 'no' }
  ]));
  assert.strictEqual(dSession.action, 'needs_user');
  assert.strictEqual(dSession.reason, 'no eligible yes_once option');
});

test('Option 3 (yes_persist) is never eligible', () => {
  const dPersist = evaluatePrompt(makePrompt('git status', null, [
    { key: '3', number: 3, text: 'Yes, persist', classification: 'yes_persist' },
    { key: '4', number: 4, text: 'No, cancel', classification: 'no' }
  ]));
  assert.strictEqual(dPersist.action, 'needs_user');
  assert.strictEqual(dPersist.reason, 'no eligible yes_once option');
});

startSuite('Suite 10: Disallowed and Sensitive Commands Safety Review');
const reviewDisallowedCommands = [
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

for (const cmd of reviewDisallowedCommands) {
  test(`Safety review decision: "${cmd}" must be needs_user or blocked (never would_approve)`, () => {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.notStrictEqual(d.action, 'would_approve', `Command "${cmd}" was would_approve, expected needs_user or blocked`);
    assert(d.action === 'needs_user' || d.action === 'blocked', `Command "${cmd}" got unexpected action "${d.action}"`);
  });
}

startSuite('Suite 11: Git Branch Listing-Only Restriction');
const allowedGitBranchCommands = [
  'git branch',
  'git branch -a',
  'git branch -r',
  'git branch --list',
  'git branch -v',
  'git branch -a -r',
  'git branch -a -v',
  'git branch --list -v'
];

for (const cmd of allowedGitBranchCommands) {
  test(`Listing form allowed: "${cmd}"`, () => {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.strictEqual(d.action, 'would_approve');
    assert.strictEqual(d.rule, 'git-readonly');
  });
}

const rejectedGitBranchCommands = [
  'git branch -D main',
  'git branch -d feature',
  'git branch newbranch',
  'git branch -m old new',
  'git branch -M old new',
  'git branch -c old new',
  'git branch -C old new',
  'git branch --delete feature',
  'git branch -u origin/main',
  'git branch --set-upstream-to origin/main',
  'git branch --edit-description',
  'git branch foo'
];

for (const cmd of rejectedGitBranchCommands) {
  test(`Non-listing branch argument rejected: "${cmd}"`, () => {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.notStrictEqual(d.action, 'would_approve');
    assert.strictEqual(d.action, 'needs_user');
  });
}

startSuite('Suite 12: Git Diff and Git Log Output & File-Path Flags Rejection');
const rejectedGitDiffLogCommands = [
  'git diff --output=out.txt',
  'git diff --output out.txt',
  'git diff -o out.txt',
  'git diff -o=out.txt',
  'git diff -O orderfile',
  'git diff -Oorderfile',
  'git diff --output-directory=out',
  'git diff --output-directory out',
  'git diff --file=out.txt',
  'git log --output=x.txt',
  'git log --output x.txt',
  'git log -o x.txt',
  'git log -o=x.txt',
  'git log -O x.txt',
  'git log -Ox.txt',
  'git log --output-directory=out',
  'git log --output-directory out',
  'git log --mailmap-file=map.txt',
  'git log --mailmap-file map.txt'
];

for (const cmd of rejectedGitDiffLogCommands) {
  test(`Output or file-path flag rejected: "${cmd}"`, () => {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.notStrictEqual(d.action, 'would_approve');
    assert.strictEqual(d.action, 'needs_user');
  });
}

const allowedGitDiffLogCommands = [
  'git diff',
  'git diff --stat',
  'git diff HEAD~1',
  'git log',
  'git log --oneline',
  'git log -n 5'
];

for (const cmd of allowedGitDiffLogCommands) {
  test(`Readonly git diff/log form allowed: "${cmd}"`, () => {
    const d = evaluatePrompt(makePrompt(cmd));
    assert.strictEqual(d.action, 'would_approve');
    assert.strictEqual(d.rule, 'git-readonly');
  });
}

console.log(`\n=========================================`);
console.log(`Pass counts per suite:`);
for (const [sName, count] of Object.entries(suiteCounts)) {
  console.log(`  ${sName}: ${count} passed`);
}
console.log(`\nAll ${passCount} allow list and strict matching tests passed successfully!`);
console.log(`=========================================`);
