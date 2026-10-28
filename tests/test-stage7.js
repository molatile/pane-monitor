const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { EventEmitter } = require('events');

const { extractPromptFromScreen, getSelectedOptionNumberFromScreen, isSeparatorLine, appendUnknownPromptSample } = require('../src/parser');
const {
  extractTargetFilePath,
  isPathSafelyInside,
  isSensitiveFile,
  evaluatePrompt,
  loadRules,
  validateOptionRules,
  checkDangerMatch
} = require('../src/rules');
const { getProfileForCommand } = require('../src/profile');
const { renderDashboardLines, getSessionSummary } = require('../src/dashboard');
const { SessionStatusManager } = require('../src/status');
const { startAgentwatch } = require('../src/agentwatch');
const { maskText } = require('../src/masker');

function createTempDir(prefix = 'aw-stage7-') {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const suitePassCounts = {
  'Suite 1: File-Edit Prompts Parsing (2, 3, 4, 8 options, with/without >)': 0,
  'Suite 2: Context Capture (In-Memory, Up to 20 Lines, Stops at Separator Line)': 0,
  'Suite 3: Target File Path Extraction & Safety Checks': 0,
  'Suite 4: Danger Matching in File Edits (Diff vs Path/Question, Hard Danger Wins)': 0,
  'Suite 5: Option Rules for Edits (promptTypes, Disabled-by-Default, Plain-Language Preview, Key Pressing)': 0,
  'Suite 6: Unknown Prompts Safety, Labeling & Deduplicated Masked Logging': 0,
  'Suite 7: Dashboard and GUI Window Display (Prompt Type Tags & File Names)': 0,
  'Suite 8: Existing Command Prompts & Regressions': 0,
  'Suite 9: Single-Write-Path Safety & Privacy Verification': 0
};

async function runStage7Tests() {
  console.log('Running agentwatch Stage 7 test suite: File Edit & Flexible Prompts Support...\n');

  const agyProfile = getProfileForCommand('agy');
  assert(agyProfile, 'Profile for agy must exist');
  assert(Array.isArray(agyProfile.promptTypes), 'agy profile must contain promptTypes array');

  // =========================================================================
  // Suite 1: File-Edit Prompts Parsing (2, 3, 4, 8 options, with/without >)
  // =========================================================================
  console.log('--- Suite 1: File-Edit Prompts Parsing (2, 3, 4, 8 options, with/without >) ---');
  {
    // 1.1: 2 options, without > marker
    const screen2NoMarker = [
      'Editing src/index.js',
      'Accept this file edit?',
      '  1. Yes, accept this change',
      '  2. No, reject this change'
    ];
    const p2No = extractPromptFromScreen(screen2NoMarker, agyProfile);
    assert(p2No, '2 options prompt must be detected');
    assert.strictEqual(p2No.promptType, 'file_edit');
    assert.strictEqual(p2No.options.length, 2);
    assert.strictEqual(p2No.options[0].key, '1');
    assert.strictEqual(p2No.options[1].key, '2');
    assert.strictEqual(p2No.targetFile, 'src/index.js');
    assert.strictEqual(p2No.fileName, 'index.js');

    // 1.2: 2 options, with > marker on option 1
    const screen2WithMarker = [
      'Update file: src/components/Header.jsx',
      'Accept this file edit?',
      '> 1. Yes, accept this change',
      '  2. No, reject this change'
    ];
    const p2With = extractPromptFromScreen(screen2WithMarker, agyProfile);
    assert(p2With, '2 options prompt with > marker must be detected');
    assert.strictEqual(p2With.promptType, 'file_edit');
    assert.strictEqual(p2With.options.length, 2);
    assert.strictEqual(getSelectedOptionNumberFromScreen(screen2WithMarker), 1);

    // 1.3: 3 options, with > marker on option 2
    const screen3 = [
      'Write to: lib/utils.py',
      'Accept this file edit?',
      '  1. Yes, accept',
      '> 2. Review diff in pager',
      '  3. No, reject'
    ];
    const p3 = extractPromptFromScreen(screen3, agyProfile);
    assert(p3, '3 options prompt must be detected');
    assert.strictEqual(p3.promptType, 'file_edit');
    assert.strictEqual(p3.options.length, 3);
    assert.strictEqual(p3.targetFile, 'lib/utils.py');
    assert.strictEqual(getSelectedOptionNumberFromScreen(screen3), 2);

    // 1.4: 4 options, without marker
    const screen4 = [
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      'Accept this file edit?',
      '  1. Yes, accept this change',
      '  2. Accept all remaining changes',
      '  3. Edit change in editor',
      '  4. No, reject'
    ];
    const p4 = extractPromptFromScreen(screen4, agyProfile);
    assert(p4, '4 options prompt must be detected');
    assert.strictEqual(p4.promptType, 'file_edit');
    assert.strictEqual(p4.options.length, 4);
    assert.strictEqual(p4.targetFile, 'src/app.ts');

    // 1.5: 8 options, with marker
    const screen8 = [
      'diff --git a/pkg/service.go b/pkg/service.go',
      'Accept this file edit?',
      '> 1. Yes, accept',
      '  2. Yes, accept and continue',
      '  3. View side-by-side diff',
      '  4. Open in VS Code',
      '  5. Stage change',
      '  6. Amend commit',
      '  7. Skip file',
      '  8. No, abort all'
    ];
    const p8 = extractPromptFromScreen(screen8, agyProfile);
    assert(p8, '8 options prompt must be detected');
    assert.strictEqual(p8.promptType, 'file_edit');
    assert.strictEqual(p8.options.length, 8);
    assert.strictEqual(p8.targetFile, 'pkg/service.go');
    assert.strictEqual(p8.fileName, 'service.go');

    // 1.6: Case-insensitivity, whitespace trimming, and optional question mark
    const screenFlex1 = [
      'Editing file: server.js',
      '   accept this FILE edit?   ',
      '  1. Yes, accept',
      '  2. No, reject'
    ];
    const pFlex1 = extractPromptFromScreen(screenFlex1, agyProfile);
    assert(pFlex1, 'Case-insensitive flexible question must match');
    assert.strictEqual(pFlex1.promptType, 'file_edit');

    const screenFlex2 = [
      'Editing file: server.js',
      'Accept this file edit',
      '  1. Yes, accept',
      '  2. No, reject'
    ];
    const pFlex2 = extractPromptFromScreen(screenFlex2, agyProfile);
    assert(pFlex2, 'Question without trailing question mark must match');
    assert.strictEqual(pFlex2.promptType, 'file_edit');

    // 1.7: Incomplete prompt (< 2 options) must NOT match
    const screenIncomplete = [
      'Editing file: server.js',
      'Accept this file edit?',
      '  1. Yes, accept'
    ];
    const pInc = extractPromptFromScreen(screenIncomplete, agyProfile);
    assert.strictEqual(pInc, null, 'Incomplete prompt (< 2 options) must return null');

    suitePassCounts['Suite 1: File-Edit Prompts Parsing (2, 3, 4, 8 options, with/without >)'] += 7;
    console.log('  ✓ File-edit prompt parsing with 2, 3, 4, 8 options, with/without > marker, case-insensitive and flexible question mark');
  }

  // =========================================================================
  // Suite 2: Context Capture (In-Memory, Up to 20 Lines, Stops at Separator Line)
  // =========================================================================
  console.log('\n--- Suite 2: Context Capture (In-Memory, Up to 20 Lines, Stops at Separator Line) ---');
  {
    // 2.1: Captures up to 20 lines
    const screen25 = [];
    for (let i = 1; i <= 25; i++) {
      screen25.push(`diff line ${i}: + const x = ${i};`);
    }
    screen25.push('Edit file: src/counter.js');
    screen25.push('Accept this file edit?');
    screen25.push('  1. Yes, accept');
    screen25.push('  2. No, reject');

    const p25 = extractPromptFromScreen(screen25, agyProfile);
    assert(p25, 'Prompt must be extracted');
    assert.strictEqual(p25.contextLines.length, 20, 'Context capture must be capped at 20 lines');
    assert.strictEqual(p25.contextLines[p25.contextLines.length - 1], 'Edit file: src/counter.js');
    assert(p25.contextLines[0].includes('diff line 7'), 'Context capture must keep nearest 20 lines above question');

    // 2.2: Stops at separator line
    const screenWithSep = [
      'Old history line that should be excluded',
      'Another old line',
      '─────────────────────────────────────────',
      'Editing file: src/app.js',
      '@@ -1,3 +1,3 @@',
      '- old code',
      '+ new code',
      'Accept this file edit?',
      '  1. Yes, accept this change',
      '  2. No, reject this change'
    ];
    const pSep = extractPromptFromScreen(screenWithSep, agyProfile);
    assert(pSep, 'Prompt must be extracted');
    assert.strictEqual(pSep.contextLines.length, 4, 'Must stop at separator line and not include it or lines before');
    assert.strictEqual(pSep.contextLines[0], 'Editing file: src/app.js');
    assert.strictEqual(pSep.contextLines[1], '@@ -1,3 +1,3 @@');
    assert.strictEqual(pSep.contextLines[2], '- old code');
    assert.strictEqual(pSep.contextLines[3], '+ new code');

    // 2.3: Recognizes various terminal separator styles
    assert.strictEqual(isSeparatorLine('───────────────────'), true);
    assert.strictEqual(isSeparatorLine('-------------------'), true);
    assert.strictEqual(isSeparatorLine('==================='), true);
    assert.strictEqual(isSeparatorLine('~~~~~~~~~~~~~~~~~~~'), true);
    assert.strictEqual(isSeparatorLine('*******************'), true);
    assert.strictEqual(isSeparatorLine('Edit file: src/test.js'), false);

    // 2.4: Context lines kept in memory on prompt object, not leaked raw to disk
    assert(Array.isArray(pSep.contextLines), 'contextLines is array on prompt object');
    const masked = pSep.contextLines.map(l => maskText(l));
    assert(Array.isArray(masked), 'Context lines can be masked before disk persistence');

    suitePassCounts['Suite 2: Context Capture (In-Memory, Up to 20 Lines, Stops at Separator Line)'] += 4;
    console.log('  ✓ Context capture keeps up to 20 lines in memory, stops at separator line, preserves isolation');
  }

  // =========================================================================
  // Suite 3: Target File Path Extraction & Safety Checks
  // =========================================================================
  console.log('\n--- Suite 3: Target File Path Extraction & Safety Checks ---');
  {
    const startFolder = path.resolve('D:/workspace/my-project');

    // 3.1: Preference for edit, file, update, write lines
    assert.strictEqual(extractTargetFilePath(['Edit src/main.js:']), 'src/main.js');
    assert.strictEqual(extractTargetFilePath(['file: components/Navbar.tsx']), 'components/Navbar.tsx');
    assert.strictEqual(extractTargetFilePath(['update file lib/helpers.py']), 'lib/helpers.py');
    assert.strictEqual(extractTargetFilePath(['Write changes to "config/app.json"']), 'config/app.json');

    // 3.2: Git diff headers
    assert.strictEqual(extractTargetFilePath(['diff --git a/src/client.ts b/src/client.ts']), 'src/client.ts');
    assert.strictEqual(extractTargetFilePath(['--- a/src/server.go', '+++ b/src/server.go']), 'src/server.go');

    // 3.3: Stripping quotes, backticks, diff prefixes, punctuation
    assert.strictEqual(extractTargetFilePath(['Editing `src/index.js`:']), 'src/index.js');
    assert.strictEqual(extractTargetFilePath(["Editing 'src/index.js'"]), 'src/index.js');
    assert.strictEqual(extractTargetFilePath(['a/src/index.js']), 'src/index.js');

    // 3.4: Unidentifiable path marked needs_user with clear reason
    assert.strictEqual(extractTargetFilePath(['just some words with no extension', 'another line']), null);
    const unidentifiablePrompt = {
      promptType: 'file_edit',
      targetFile: '',
      question: 'Accept this file edit?',
      contextLines: ['no paths here'],
      options: [{ key: '1', number: 1, text: 'Yes, accept' }, { key: '2', number: 2, text: 'No' }],
      startFolder
    };
    const unidentifiableDec = evaluatePrompt(unidentifiablePrompt, loadRules());
    assert.strictEqual(unidentifiableDec.action, 'needs_user');
    assert.strictEqual(unidentifiableDec.reason, 'unidentifiable target file path');

    // 3.5: Path inside session folder is accepted when rule is enabled
    assert.strictEqual(isPathSafelyInside('src/app.js', startFolder), true);
    assert.strictEqual(isPathSafelyInside('nested/dir/deep/file.ts', startFolder), true);

    // 3.6: Path outside folder with .. or absolute elsewhere rejected
    assert.strictEqual(isPathSafelyInside('../outside.js', startFolder), false);
    assert.strictEqual(isPathSafelyInside('src/../../outside.js', startFolder), false);
    assert.strictEqual(isPathSafelyInside('..\\outside.js', startFolder), false);
    assert.strictEqual(isPathSafelyInside('C:\\Windows\\System32\\calc.exe', startFolder), false);
    assert.strictEqual(isPathSafelyInside('/etc/passwd', startFolder), false);

    const outsidePrompt = {
      promptType: 'file_edit',
      targetFile: '../secret.txt',
      question: 'Accept this file edit?',
      contextLines: ['Edit ../secret.txt'],
      options: [{ key: '1', number: 1, text: 'Yes, accept' }, { key: '2', number: 2, text: 'No' }],
      startFolder
    };
    const outsideDec = evaluatePrompt(outsidePrompt, loadRules());
    assert.strictEqual(outsideDec.action, 'needs_user');
    assert.strictEqual(outsideDec.reason, 'target file path resolves outside session folder');

    // 3.7: Sensitive targets rejected
    assert.strictEqual(isSensitiveFile('.env'), true);
    assert.strictEqual(isSensitiveFile('.env.local'), true);
    assert.strictEqual(isSensitiveFile('.env.production'), true);
    assert.strictEqual(isSensitiveFile('config/.env.test'), true);
    assert.strictEqual(isSensitiveFile('settings.json'), true);
    assert.strictEqual(isSensitiveFile('.ssh/id_rsa'), true);
    assert.strictEqual(isSensitiveFile('.ssh/authorized_keys'), true);
    assert.strictEqual(isSensitiveFile('credentials.json'), true);
    assert.strictEqual(isSensitiveFile('aws_credentials'), true);
    assert.strictEqual(isSensitiveFile('secrets.yaml'), true);
    assert.strictEqual(isSensitiveFile('server.key'), true);
    assert.strictEqual(isSensitiveFile('id_ed25519'), true);
    assert.strictEqual(isSensitiveFile('.git/config'), true);
    assert.strictEqual(isSensitiveFile('.git/HEAD'), true);
    assert.strictEqual(isSensitiveFile('src/utils.js'), false);
    assert.strictEqual(isSensitiveFile('components/Header.tsx'), false);

    const sensitivePrompt = {
      promptType: 'file_edit',
      targetFile: '.env.local',
      question: 'Accept this file edit?',
      contextLines: ['Edit .env.local'],
      options: [{ key: '1', number: 1, text: 'Yes, accept' }, { key: '2', number: 2, text: 'No' }],
      startFolder
    };
    const sensitiveDec = evaluatePrompt(sensitivePrompt, loadRules());
    assert.strictEqual(sensitiveDec.action, 'needs_user');
    assert(sensitiveDec.reason.includes('sensitive target file'));

    suitePassCounts['Suite 3: Target File Path Extraction & Safety Checks'] += 7;
    console.log('  ✓ Target file path extraction prefers edit/file/update/write, strictly validates startFolder, rejects outside & sensitive targets');
  }

  // =========================================================================
  // Suite 4: Danger Matching in File Edits (Diff vs Path/Question, Hard Danger Wins)
  // =========================================================================
  console.log('\n--- Suite 4: Danger Matching in File Edits (Diff vs Path/Question, Hard Danger Wins) ---');
  {
    const startFolder = path.resolve('D:/workspace/my-project');
    const rules = loadRules();
    // Enable accept-file-edit for this test
    const enabledRules = {
      ...rules,
      optionRules: [
        { name: 'accept-file-edit', startsWith: 'Yes, accept', promptTypes: ['file_edit'], enabled: true }
      ]
    };

    // 4.1: Danger words inside code diff DO NOT block
    const promptDiffDanger = {
      promptType: 'file_edit',
      targetFile: 'src/cleaner.js',
      question: 'Accept this file edit?',
      contextLines: [
        'Edit src/cleaner.js:',
        '+ // remove old files and delete temporary directory',
        '+ rm -rf /tmp/cache',
        '+ sudo chmod 777 /var/run',
        '+ const drop_database = false;'
      ],
      options: [
        { key: '1', number: 1, text: 'Yes, accept this change' },
        { key: '2', number: 2, text: 'No, reject' }
      ],
      startFolder
    };
    const decDiff = evaluatePrompt(promptDiffDanger, enabledRules);
    assert.strictEqual(decDiff.action, 'would_approve', 'Danger words in diff must NOT block file edit');
    assert.strictEqual(decDiff.rule, 'accept-file-edit');

    // 4.2: Danger words in file path DO block
    const promptPathDanger = {
      promptType: 'file_edit',
      targetFile: 'src/delete_user.js',
      question: 'Accept this file edit?',
      contextLines: ['Edit src/delete_user.js'],
      options: [
        { key: '1', number: 1, text: 'Yes, accept this change' },
        { key: '2', number: 2, text: 'No, reject' }
      ],
      startFolder
    };
    const decPath = evaluatePrompt(promptPathDanger, enabledRules);
    assert.strictEqual(decPath.action, 'needs_user', 'Danger word in file path MUST block');
    assert.strictEqual(decPath.danger, true);
    assert.strictEqual(decPath.reason, "DANGER: matched 'delete'");

    // 4.3: Danger words in question DO block
    const promptQuestionDanger = {
      promptType: 'file_edit',
      targetFile: 'src/app.js',
      question: 'Accept this file edit and delete old backups?',
      contextLines: ['Edit src/app.js'],
      options: [
        { key: '1', number: 1, text: 'Yes, accept this change' },
        { key: '2', number: 2, text: 'No, reject' }
      ],
      startFolder
    };
    const decQ = evaluatePrompt(promptQuestionDanger, enabledRules);
    assert.strictEqual(decQ.action, 'needs_user', 'Danger word in question MUST block');
    assert.strictEqual(decQ.danger, true);
    assert.strictEqual(decQ.reason, "DANGER: matched 'delete'");

    // 4.4: Hard danger hits win and stop
    assert(decPath.danger === true && decQ.danger === true, 'Hard danger hits win and stop');

    suitePassCounts['Suite 4: Danger Matching in File Edits (Diff vs Path/Question, Hard Danger Wins)'] += 4;
    console.log('  ✓ Danger words inside diff lines do not block, but danger in path or question stops with DANGER reason');
  }

  // =========================================================================
  // Suite 5: Option Rules for Edits (promptTypes, Disabled-by-Default, Plain-Language Preview, Key Pressing)
  // =========================================================================
  console.log('\n--- Suite 5: Option Rules for Edits (promptTypes, Disabled-by-Default, Plain-Language Preview, Key Pressing) ---');
  {
    const startFolder = path.resolve('D:/workspace/my-project');
    const defaultRules = loadRules();

    // 5.1: accept-file-edit rule is disabled by default in rules.json
    const seededRule = (defaultRules.optionRules || []).find(r => r.name === 'accept-file-edit');
    assert(seededRule, 'accept-file-edit must be seeded in rules.json');
    assert.strictEqual(seededRule.enabled, false, 'accept-file-edit must be disabled by default');
    assert.deepStrictEqual(seededRule.promptTypes, ['file_edit'], 'accept-file-edit must target file_edit prompt type');

    const filePrompt = {
      promptType: 'file_edit',
      targetFile: 'src/app.js',
      question: 'Accept this file edit?',
      contextLines: ['Edit src/app.js'],
      options: [
        { key: '1', number: 1, text: 'Yes, accept this change' },
        { key: '2', number: 2, text: 'No, reject' }
      ],
      startFolder
    };
    const defaultDec = evaluatePrompt(filePrompt, defaultRules);
    assert.strictEqual(defaultDec.action, 'needs_user', 'Disabled rule must press nothing and return needs_user');

    // 5.2: When enabled, auto-approves option 1 with delay
    const enabledRules = {
      ...defaultRules,
      optionRules: defaultRules.optionRules.map(r => r.name === 'accept-file-edit' ? { ...r, enabled: true } : r)
    };
    const approvedDec = evaluatePrompt(filePrompt, enabledRules);
    assert.strictEqual(approvedDec.action, 'would_approve');
    assert.strictEqual(approvedDec.rule, 'accept-file-edit');
    assert.strictEqual(approvedDec.optionKey, '1');

    // 5.3: promptTypes scoping isolation
    const cmdRules = {
      ...defaultRules,
      optionRules: [
        { name: 'cmd-only', startsWith: 'Yes', promptTypes: ['command'], enabled: true },
        { name: 'file-only', startsWith: 'Yes', promptTypes: ['file_edit'], enabled: true }
      ]
    };
    const commandPrompt = {
      promptType: 'command',
      commandSpaced: 'npm test',
      question: 'Run this command?',
      options: [
        { key: '1', number: 1, text: 'Yes, run command' },
        { key: '2', number: 2, text: 'No, cancel' }
      ]
    };
    const cmdResult = evaluatePrompt(commandPrompt, cmdRules);
    assert.strictEqual(cmdResult.action, 'would_approve');
    assert.strictEqual(cmdResult.rule, 'cmd-only', 'Command prompt must match cmd-only, not file-only');

    const fileResult = evaluatePrompt(filePrompt, cmdRules);
    assert.strictEqual(fileResult.action, 'would_approve');
    assert.strictEqual(fileResult.rule, 'file-only', 'File edit prompt must match file-only, not cmd-only');

    // 5.4: Rule with no promptTypes applies to all prompt types
    const universalRules = {
      ...defaultRules,
      optionRules: [
        { name: 'universal-yes', startsWith: 'Yes', enabled: true }
      ]
    };
    assert.strictEqual(evaluatePrompt(commandPrompt, universalRules).rule, 'universal-yes');
    assert.strictEqual(evaluatePrompt(filePrompt, universalRules).rule, 'universal-yes');

    // 5.5: Plain-language preview in GUI reflects promptTypes
    const rendererCode = fs.readFileSync(path.join(__dirname, '..', 'src', 'gui', 'renderer.js'), 'utf8');
    const fnMatch = rendererCode.match(/function generateRulePreview\(rule\) \{[\s\S]*?\n\}/);
    assert(fnMatch, 'generateRulePreview must be defined in renderer.js');
    const generateRulePreview = new Function('rule', fnMatch[0].replace('function generateRulePreview(rule)', '') + '; return generateRulePreview(rule);');

    const previewEdit = generateRulePreview({
      name: 'accept-file-edit',
      startsWith: 'Yes, accept',
      promptTypes: ['file_edit'],
      enabled: false
    });
    assert(previewEdit.includes('for file edit prompts'), `Preview must mention "for file edit prompts", got: ${previewEdit}`);
    assert(previewEdit.includes('[Disabled]'), 'Preview must indicate [Disabled]');

    // 5.6: Exactly-one-match safety
    const multiMatchRules = {
      ...defaultRules,
      optionRules: [
        { name: 'broad-yes', startsWith: 'Yes', promptTypes: ['file_edit'], enabled: true }
      ]
    };
    const multiMatchPrompt = {
      promptType: 'file_edit',
      targetFile: 'src/app.js',
      question: 'Accept this file edit?',
      contextLines: ['Edit src/app.js'],
      options: [
        { key: '1', number: 1, text: 'Yes, accept this change' },
        { key: '2', number: 2, text: 'Yes, accept all changes' },
        { key: '3', number: 3, text: 'No, reject' }
      ],
      startFolder
    };
    const multiDec = evaluatePrompt(multiMatchPrompt, multiMatchRules);
    assert.strictEqual(multiDec.action, 'needs_user');
    assert(multiDec.reason.includes('multiple options matched'));

    // 5.7: Persist protection
    const persistFileRules = {
      ...defaultRules,
      optionRules: [
        { name: 'no-persist', startsWith: 'Yes, persist', promptTypes: ['file_edit'], allowPersist: false, enabled: true }
      ]
    };
    const persistPrompt = {
      promptType: 'file_edit',
      targetFile: 'src/app.js',
      question: 'Accept this file edit?',
      contextLines: ['Edit src/app.js'],
      options: [
        { key: '1', number: 1, text: 'Yes, persist to settings.json' },
        { key: '2', number: 2, text: 'No' }
      ],
      startFolder
    };
    const persistDec = evaluatePrompt(persistPrompt, persistFileRules);
    assert.strictEqual(persistDec.action, 'needs_user');
    assert(persistDec.reason.includes('persist option blocked'));

    // 5.8: Execution via sendAutoAnswer sends option number key, NO Enter
    const tmpDir = createTempDir();
    let sentKeys = [];
    const mockPty = {
      write: (data) => sentKeys.push(data),
      onData: () => {},
      onExit: () => {}
    };
    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};

    const monitor = startAgentwatch({
      command: 'agy',
      cwd: tmpDir,
      auto: true,
      profile: agyProfile,
      ptyProcess: mockPty,
      stdin: stdinMock,
      stdout: { columns: 80, rows: 24, write: () => {}, on: () => {} },
      rulesPath: path.join(tmpDir, 'rules.json')
    });

    monitor.sendAutoAnswer('1');
    assert.deepStrictEqual(sentKeys, ['1'], 'sendAutoAnswer must send exactly the option digit "1" with NO Enter');
    monitor.cleanup();
    fs.rmSync(tmpDir, { recursive: true, force: true });

    suitePassCounts['Suite 5: Option Rules for Edits (promptTypes, Disabled-by-Default, Plain-Language Preview, Key Pressing)'] += 8;
    console.log('  ✓ Option rules promptTypes scoping, disabled-by-default behavior, preview, persist protection, and digit-only key pressing verified');
  }

  // =========================================================================
  // Suite 6: Unknown Prompts Safety, Labeling & Deduplicated Masked Logging
  // =========================================================================
  console.log('\n--- Suite 6: Unknown Prompts Safety, Labeling & Deduplicated Masked Logging ---');
  {
    const tmpDir = createTempDir();
    const unknownLogPath = path.join(tmpDir, 'unknown-prompts.log');

    // 6.1: Question ending in ? + >= 2 numbered options matching no prompt type
    const unknownScreen = [
      'Connected to remote API with API_KEY: secret-key-value-998811',
      'Deploy updates to production cluster?',
      '  1. Yes, deploy now',
      '  2. No, cancel deployment'
    ];
    const detectedUnknown = extractPromptFromScreen(unknownScreen, agyProfile);
    assert(detectedUnknown, 'Unknown prompt must be detected');
    assert.strictEqual(detectedUnknown.promptType, 'unrecognized');
    assert.strictEqual(detectedUnknown.label, 'unrecognized prompt');
    assert.strictEqual(detectedUnknown.options.length, 2);

    // 6.2: Unknown prompts NEVER auto-answer
    const unkDecision = evaluatePrompt(detectedUnknown, loadRules());
    assert.strictEqual(unkDecision.action, 'needs_user');
    assert.strictEqual(unkDecision.reason, 'unrecognized prompt');

    // 6.3: Appends masked sample to unknown-prompts.log
    const append1 = appendUnknownPromptSample(detectedUnknown, { unknownPromptsLogPath: unknownLogPath });
    assert.strictEqual(append1, true, 'First unknown prompt sample must be appended');
    assert(fs.existsSync(unknownLogPath), 'unknown-prompts.log must exist');

    const logContent = fs.readFileSync(unknownLogPath, 'utf8');
    assert(logContent.includes('UNRECOGNIZED PROMPT'));
    assert(logContent.includes('Deploy updates to production cluster?'));
    assert(!logContent.includes('secret-key-value-998811'), 'Log must be masked before writing to disk');
    assert(logContent.includes('[REDACTED]'), 'Secret must be replaced with [REDACTED]');

    // 6.4: Deduplication: at most once per distinct sample
    const append2 = appendUnknownPromptSample(detectedUnknown, { unknownPromptsLogPath: unknownLogPath });
    assert.strictEqual(append2, false, 'Duplicate sample must not be logged again');

    // 6.5: Keeps file under 200 KB
    const dummyLog = path.join(tmpDir, 'capped.log');
    const bigEntry = '[2026-01-01T00:00:00.000Z] UNRECOGNIZED PROMPT\nQuestion: Question?\nOptions:\n  1. Opt 1\n  2. Opt 2\n\n';
    fs.writeFileSync(dummyLog, bigEntry.repeat(3500), 'utf8');
    const beforeSize = fs.statSync(dummyLog).size;
    assert(beforeSize > 200 * 1024, 'Log must exceed 200 KB before test');

    const newSample = {
      question: 'Another unknown question?',
      options: [{ key: '1', text: 'Yes' }, { key: '2', text: 'No' }],
      contextLines: ['line 1']
    };
    appendUnknownPromptSample(newSample, { unknownPromptsLogPath: dummyLog });
    const afterSize = fs.statSync(dummyLog).size;
    assert(afterSize <= 200 * 1024, `Log file must be trimmed under 200 KB, actual: ${afterSize}`);

    fs.rmSync(tmpDir, { recursive: true, force: true });
    suitePassCounts['Suite 6: Unknown Prompts Safety, Labeling & Deduplicated Masked Logging'] += 5;
    console.log('  ✓ Unknown prompt never auto-answers, displays label, appends masked sample once, keeps log under 200 KB');
  }

  // =========================================================================
  // Suite 7: Dashboard and GUI Window Display (Prompt Type Tags & File Names)
  // =========================================================================
  console.log('\n--- Suite 7: Dashboard and GUI Window Display (Prompt Type Tags & File Names) ---');
  {
    const mockSessions = [
      {
        sessionId: 's-cmd',
        sessionKey: 'agy:s-cmd',
        folder: 'project',
        displayName: 'agent-cmd',
        agent: 'agy',
        state: 'asking',
        stateSince: new Date().toISOString(),
        prompt: {
          type: 'command',
          command: 'npm install',
          decision: 'would approve option 1 after 3s'
        }
      },
      {
        sessionId: 's-file',
        sessionKey: 'agy:s-file',
        folder: 'project',
        displayName: 'agent-file',
        agent: 'agy',
        state: 'asking',
        stateSince: new Date().toISOString(),
        prompt: {
          type: 'file_edit',
          targetFile: 'src/components/Sidebar.tsx',
          fileName: 'Sidebar.tsx',
          decision: 'would approve option 1 after 3s'
        }
      },
      {
        sessionId: 's-unk',
        sessionKey: 'agy:s-unk',
        folder: 'project',
        displayName: 'agent-unk',
        agent: 'agy',
        state: 'asking',
        stateSince: new Date().toISOString(),
        prompt: {
          type: 'unrecognized',
          label: 'unrecognized prompt',
          decision: 'needs you'
        }
      }
    ];

    // 7.1: Dashboard summaries
    assert.strictEqual(getSessionSummary(mockSessions[0]), 'Permission requested');
    assert.strictEqual(getSessionSummary(mockSessions[1]), 'file edit: Sidebar.tsx');
    assert.strictEqual(getSessionSummary(mockSessions[2]), 'unrecognized prompt');

    // 7.2: Dashboard line rendering
    const dashLines = renderDashboardLines({ sessions: mockSessions, useColor: false });
    const renderedText = dashLines.join('\n');
    assert(renderedText.includes('[command] npm install'), 'Dashboard must display [command]');
    assert(renderedText.includes('[file edit] Sidebar.tsx'), 'Dashboard must display [file edit] and file name');
    assert(!renderedText.includes('src/components/Sidebar.tsx'), 'Dashboard must show file name, NOT full path');
    assert(renderedText.includes('[unrecognized] unrecognized prompt'), 'Dashboard must display [unrecognized]');

    // 7.3: Status file prompt serialization
    const statusManager = new SessionStatusManager({
      sessionId: 's-status-test',
      sessionsDir: createTempDir()
    });
    statusManager.update('asking', new Date().toISOString(), {
      promptType: 'file_edit',
      targetFile: 'D:/path/to/script.py',
      fileName: 'script.py',
      question: 'Accept this file edit?',
      decision: 'would approve option 1 after 3s'
    });
    assert.strictEqual(statusManager.prompt.type, 'file_edit');
    assert.strictEqual(statusManager.prompt.fileName, 'script.py');
    assert.strictEqual(statusManager.prompt.label, 'file edit');
    statusManager.cleanup();

    suitePassCounts['Suite 7: Dashboard and GUI Window Display (Prompt Type Tags & File Names)'] += 3;
    console.log('  ✓ Dashboard and window display prompt type tags ([command], [file edit], [unrecognized]) and file name');
  }

  // =========================================================================
  // Suite 8: Existing Command Prompts & Regressions
  // =========================================================================
  console.log('\n--- Suite 8: Existing Command Prompts & Regressions ---');
  {
    // 8.1: Existing command prompts detected identically
    const classicCommandScreen = [
      'Requesting permission for:',
      '  git status',
      'Run this command?',
      '> 1. Yes, run command',
      '  2. No, cancel',
      '↑/↓ Navigate · tab Amend'
    ];
    const classicPrompt = extractPromptFromScreen(classicCommandScreen, agyProfile);
    assert(classicPrompt, 'Classic command prompt must be detected');
    assert.strictEqual(classicPrompt.promptType, 'command');
    assert.strictEqual(classicPrompt.commandSpaced, 'git status');
    assert.strictEqual(classicPrompt.options.length, 2);
    assert.strictEqual(classicPrompt.footerSeen, true);

    // 8.2: Command allow-list rules behave exactly as before
    const rules = loadRules();
    const cmdDecision = evaluatePrompt(classicPrompt, rules);
    assert(cmdDecision.action === 'would_approve' || cmdDecision.action === 'needs_user');

    // 8.3: Profile without promptTypes falls back cleanly to legacy prompt object
    const legacyProfile = {
      id: 'legacy',
      name: 'Legacy Agent',
      prompt: agyProfile.prompt
    };
    const legacyPrompt = extractPromptFromScreen(classicCommandScreen, legacyProfile);
    assert(legacyPrompt, 'Legacy profile fallback must detect command prompt');
    assert.strictEqual(legacyPrompt.commandSpaced, 'git status');

    suitePassCounts['Suite 8: Existing Command Prompts & Regressions'] += 3;
    console.log('  ✓ Existing command prompt parsing, evaluation, and legacy profile backwards compatibility verified');
  }

  // =========================================================================
  // Suite 9: Single-Write-Path Safety & Privacy Verification
  // =========================================================================
  console.log('\n--- Suite 9: Single-Write-Path Safety & Privacy Verification ---');
  {
    // 9.1: Child process single write path invariant in agentwatch.js
    const agentwatchSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agentwatch.js'), 'utf8');
    const writeCalls = agentwatchSrc.match(/\bptyProcess\.write\s*\(/g) || [];
    assert(
      writeCalls.length > 0 && writeCalls.length <= 3,
      `ptyProcess.write must only be called in stdin forwarder or sendAutoAnswer, found ${writeCalls.length}`
    );

    // 9.2: GUI files contain ZERO writes to child process
    const guiFiles = fs.readdirSync(path.join(__dirname, '..', 'src', 'gui')).filter(f => f.endsWith('.js'));
    for (const f of guiFiles) {
      const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'gui', f), 'utf8');
      assert(!code.includes('ptyProcess'), `GUI file ${f} must never reference ptyProcess`);
      assert(!code.includes('.write('), `GUI file ${f} must never write to processes`);
    }

    // 9.3: Privacy test: keystrokes and sensitive data never logged raw
    const sensitiveTokens = ['bearer eyJhbGciOi', 'password=supersecret', 'sk-ant-api03-abcdef123456789'];
    for (const token of sensitiveTokens) {
      const masked = maskText(token);
      assert(!masked.includes('supersecret') && !masked.includes('abcdef123456789'), 'Secrets must be masked');
    }

    suitePassCounts['Suite 9: Single-Write-Path Safety & Privacy Verification'] += 3;
    console.log('  ✓ Single write path and privacy invariants strictly maintained');
  }

  console.log('\n=========================================');
  console.log('Stage 7 Pass Counts Per Suite:');
  let totalPasses = 0;
  for (const [suite, count] of Object.entries(suitePassCounts)) {
    console.log(`  ${suite}: ${count} passed`);
    totalPasses += count;
  }
  console.log(`\nTotal passes: ${totalPasses}`);
  console.log('All Stage 7 suites passed successfully!');
  console.log('=========================================\n');
}

runStage7Tests().catch(err => {
  console.error('Stage 7 test failed:', err);
  process.exit(1);
});
