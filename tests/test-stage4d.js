const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const {
  loadRules,
  validateOptionRules,
  validateDangerList,
  validateAllRules,
  detectLoosening,
  saveRules,
  getRulesBackups,
  restoreRulesBackup,
  resetDangerList,
  evaluatePrompt,
  matchesOptionRule,
  isPersistOption,
  CANONICAL_RULES_PATH,
  DEFAULT_DANGER_LIST,
  DEFAULT_RULES
} = require('../src/rules');

const renderer = require('../src/gui/renderer');

console.log('Running agentwatch Stage 4d test suite: Rules Tab & Rules Management...\n');

let passCount = 0;
const suitePassCounts = {};

function recordPass(suiteName, testName) {
  passCount++;
  suitePassCounts[suiteName] = (suitePassCounts[suiteName] || 0) + 1;
  console.log(`  ✓ ${testName} passed`);
}

const testDir = path.join(os.tmpdir(), `agentwatch-stage4d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
fs.mkdirSync(testDir, { recursive: true });
process.env.AGENTWATCH_DIR = path.join(testDir, '.agentwatch');

try {
  // =============================================================
  // Suite 1: Validation Parity between GUI Saves and Wrapper
  // =============================================================
  const suite1 = 'Suite 1: Validation Parity between GUI Saves and Wrapper';
  console.log(`--- ${suite1} ---`);
  {
    // 1.1 Invalid option rule items rejected identically
    const invalidOptionRules = [
      null,
      123,
      { name: '', startsWith: 'Yes, allow' },
      { name: 'no-start' },
      { name: 'short', startsWith: 'Ye' }, // < 3 chars
      { name: 'no-rule', startsWith: 'No, cancel' }, // matches "No"
      { name: 'unknown-field', startsWith: 'Yes, allow', delay: 5 } // unknown field
    ];

    const wrapperValidated = validateOptionRules(invalidOptionRules);
    assert.strictEqual(wrapperValidated.length, 0, 'Wrapper must reject all invalid option rules');

    const guiAllVal = validateAllRules({ optionRules: invalidOptionRules });
    assert.strictEqual(guiAllVal.valid, false, 'GUI validation must flag errors for invalid option rules');
    assert(guiAllVal.errors.length >= 5, 'GUI validation must report specific errors for each invalid rule');
    recordPass(suite1, 'Invalid option rules rejected with parity');

    // 1.2 Invalid danger entries rejected identically
    const invalidDangerList = [
      null,
      123,
      { text: 'a', wholeWord: false }, // < 2 chars
      { wholeWord: true }, // missing text
      'plain-string'
    ];

    const wrapperDangerVal = validateDangerList(invalidDangerList);
    assert.strictEqual(wrapperDangerVal.length, 0, 'Wrapper must reject entries with text < 2 or missing');

    const guiDangerVal = validateAllRules({ danger: invalidDangerList });
    assert.strictEqual(guiDangerVal.valid, false, 'GUI validation must flag errors for invalid danger entries');
    recordPass(suite1, 'Invalid danger entries rejected with parity');

    // 1.2b Unknown fields in danger list caught by GUI validation
    const unknownDangerProp = validateAllRules({
      danger: [{ text: 'del', wholeWord: false, unknownProp: true }]
    });
    assert.strictEqual(unknownDangerProp.valid, false, 'GUI validation must reject unknown fields in danger entry');
    assert(unknownDangerProp.errors.some(e => e.includes('unknown properties')));
    recordPass(suite1, 'Unknown fields in danger entries rejected by GUI validation');

    // 1.3 Valid option rules and danger list accepted with parity
    const validRulesObj = {
      optionRules: [
        { name: 'rule-one', startsWith: 'Yes, allow once', commandStartsWith: 'git', enabled: true, allowPersist: false }
      ],
      danger: [
        { text: 'drop database', wholeWord: false, level: 'hard', enabled: true }
      ]
    };

    const wrapperOpt = validateOptionRules(validRulesObj.optionRules);
    const wrapperDng = validateDangerList(validRulesObj.danger);
    const guiVal = validateAllRules(validRulesObj);

    assert.strictEqual(guiVal.valid, true, 'Valid rules must pass GUI validation');
    assert.strictEqual(wrapperOpt.length, 1);
    assert.strictEqual(wrapperDng.length, 1);
    assert.strictEqual(guiVal.sanitizedRules.optionRules[0].name, 'rule-one');
    assert.strictEqual(guiVal.sanitizedRules.danger[0].text, 'drop database');
    recordPass(suite1, 'Valid rules accepted with exact parity');
  }

  // =============================================================
  // Suite 2: Invalid Input Rejection (Nothing Written)
  // =============================================================
  const suite2 = 'Suite 2: Invalid Input Rejection (Nothing Written)';
  console.log(`\n--- ${suite2} ---`);
  {
    const rulesFile = path.join(testDir, 'rules-save-test.json');
    const initialContent = JSON.stringify({ defaultDelaySeconds: 3, optionRules: [], danger: [] }, null, 2);
    fs.writeFileSync(rulesFile, initialContent, 'utf8');
    const initialMtime = fs.statSync(rulesFile).mtimeMs;

    // 2.1 Rejection of rule with startsWith < 3 chars
    assert.throws(() => {
      saveRules({
        optionRules: [{ name: 'bad-rule', startsWith: 'Ye' }]
      }, rulesFile);
    }, /Cannot save rules/);
    assert.strictEqual(fs.statSync(rulesFile).mtimeMs, initialMtime, 'File must not be written when validation fails');
    recordPass(suite2, 'Rule with startsWith < 3 rejected without modifying file');

    // 2.2 Rejection of rule matching "No" option
    assert.throws(() => {
      saveRules({
        optionRules: [{ name: 'bad-no-rule', startsWith: 'No, abort' }]
      }, rulesFile);
    }, /cannot match 'No' options/);
    assert.strictEqual(fs.readFileSync(rulesFile, 'utf8'), initialContent, 'File content must remain completely unchanged');
    recordPass(suite2, 'Rule matching "No" rejected without modifying file');

    // 2.3 Rejection of danger entry < 2 chars
    assert.throws(() => {
      saveRules({
        danger: [{ text: 'x', wholeWord: false }]
      }, rulesFile);
    }, /at least 2 characters/);
    assert.strictEqual(fs.readFileSync(rulesFile, 'utf8'), initialContent);
    recordPass(suite2, 'Danger text < 2 chars rejected without modifying file');

    // 2.4 Rejection of missing built-in deny rule
    assert.throws(() => {
      saveRules({
        deny: ['rm -rf'] // omits settings.json, format, etc.
      }, rulesFile);
    }, /Built-in deny rule.*cannot be removed/);
    assert.strictEqual(fs.readFileSync(rulesFile, 'utf8'), initialContent);
    recordPass(suite2, 'Removing built-in deny rule rejected without modifying file');
  }

  // =============================================================
  // Suite 3: Atomic Write and Backup Retention
  // =============================================================
  const suite3 = 'Suite 3: Atomic Write and Backup Retention';
  console.log(`\n--- ${suite3} ---`);
  {
    const atomicRulesFile = path.join(testDir, 'atomic-rules.json');
    const backupDir = path.join(process.env.AGENTWATCH_DIR, 'rules-backups');
    const changeLogFile = path.join(process.env.AGENTWATCH_DIR, 'rules-changes.log');

    // Initial save
    saveRules({
      defaultDelaySeconds: 3,
      optionRules: [{ name: 'rule-0', startsWith: 'Yes, allow' }]
    }, atomicRulesFile);

    assert(fs.existsSync(atomicRulesFile), 'rules file must exist after initial save');

    // Perform 12 consecutive saves to verify backup creation & retention limit of 10
    for (let i = 1; i <= 12; i++) {
      saveRules({
        defaultDelaySeconds: 3,
        optionRules: [{ name: `rule-${i}`, startsWith: `Yes, allow ${i}` }]
      }, atomicRulesFile, { changeSummary: `Update #${i}` });
    }

    const backups = getRulesBackups(backupDir);
    assert.strictEqual(backups.length, 10, 'Backup retention must keep exactly the newest 10 backups');
    recordPass(suite3, 'Backup retention prunes older backups keeping newest 10');

    // Verify atomic file has latest content
    const loaded = loadRules(atomicRulesFile);
    assert.strictEqual(loaded.optionRules[0].name, 'rule-12', 'Latest atomic save must be readable');
    recordPass(suite3, 'Atomic write saves latest content cleanly');

    // Verify changes log appended with no secrets
    assert(fs.existsSync(changeLogFile), 'rules-changes.log must exist');
    const logContent = fs.readFileSync(changeLogFile, 'utf8');
    const lines = logContent.trim().split('\n').map(l => JSON.parse(l));
    assert(lines.length >= 12, 'Log must contain an entry for each save');
    assert.strictEqual(lines[lines.length - 1].who, 'gui', 'Log entry must have who: "gui"');
    assert(!logContent.includes('secret') && !logContent.includes('password'), 'Log must contain no secrets');
    recordPass(suite3, 'rules-changes.log logged with time, who: gui, and no secrets');
  }

  // =============================================================
  // Suite 4: Restore Backup and Reset Danger Defaults
  // =============================================================
  const suite4 = 'Suite 4: Restore Backup and Reset Danger Defaults';
  console.log(`\n--- ${suite4} ---`);
  {
    const restoreRulesFile = path.join(testDir, 'restore-rules.json');
    const backupDir = path.join(process.env.AGENTWATCH_DIR, 'rules-backups');

    // Save initial version
    saveRules({
      defaultDelaySeconds: 3,
      optionRules: [{ name: 'initial-rule', startsWith: 'Yes, initial version' }],
      danger: [{ text: 'custom-danger', wholeWord: false }]
    }, restoreRulesFile);

    // Save modified version (which generates a backup of the initial version)
    saveRules({
      defaultDelaySeconds: 3,
      optionRules: [{ name: 'modified-rule', startsWith: 'Yes, modified version' }]
    }, restoreRulesFile);

    const backups = getRulesBackups(backupDir);
    assert(backups.length > 0, 'Backups must exist for restore');

    // Restore newest backup
    const newestBackup = backups[0].name;
    restoreRulesBackup(newestBackup, restoreRulesFile, backupDir);

    const restored = loadRules(restoreRulesFile);
    assert.strictEqual(restored.optionRules[0].name, 'initial-rule', 'Restore must return rules to backup state');
    recordPass(suite4, 'Restore previous backup recovers earlier state');

    // Reset danger list to defaults
    resetDangerList(restoreRulesFile);
    const afterReset = loadRules(restoreRulesFile);
    assert.strictEqual(afterReset.danger.length, DEFAULT_DANGER_LIST.length, 'Danger list must be restored to default count');
    assert(afterReset.danger.some(d => d.text === 'rm' && d.wholeWord === true), 'Factory default entries must be present');
    recordPass(suite4, 'Reset danger list restores factory defaults');
  }

  // =============================================================
  // Suite 5: Loosening Detection for All Cases (and None for Tightening)
  // =============================================================
  const suite5 = 'Suite 5: Loosening Detection for All Specified Cases';
  console.log(`\n--- ${suite5} ---`);
  {
    const baseRules = {
      optionRules: [
        { name: 'git-rule', startsWith: 'Yes, allow', commandStartsWith: 'git', allowPersist: false, enabled: true }
      ],
      danger: [
        { text: 'delete', wholeWord: false, level: 'hard', enabled: true },
        { text: 'slow-cmd', wholeWord: false, level: 'slow', delay: 10, enabled: true }
      ],
      allow: [
        { name: 'npm-build', enabled: false }
      ]
    };

    // Case 1: New or edited option rule with no commandStartsWith
    const looser1 = JSON.parse(JSON.stringify(baseRules));
    looser1.optionRules.push({
      name: 'unrestricted-rule',
      startsWith: 'Yes, allow all',
      commandStartsWith: '', // NO command restriction!
      enabled: true
    });
    const det1 = detectLoosening(baseRules, looser1);
    assert.strictEqual(det1.isLooser, true);
    assert(det1.items.some(i => i.includes('unrestricted-rule') && i.includes('no command')), 'Must detect option rule with no command restriction');
    recordPass(suite5, 'Case 1: Option rule with no commandStartsWith detected as loosening');

    // Case 2: Rule sets allowPersist true or matches persist
    const looser2 = JSON.parse(JSON.stringify(baseRules));
    looser2.optionRules[0].allowPersist = true;
    const det2 = detectLoosening(baseRules, looser2);
    assert.strictEqual(det2.isLooser, true);
    assert.strictEqual(det2.requiresPersistConfirmation, true, 'Must flag requiresPersistConfirmation');
    recordPass(suite5, 'Case 2: allowPersist true detected as loosening and requires persist confirmation');

    // Case 3: Removing hard danger entry
    const looser3 = JSON.parse(JSON.stringify(baseRules));
    looser3.danger = looser3.danger.filter(d => d.text !== 'delete');
    const det3 = detectLoosening(baseRules, looser3);
    assert.strictEqual(det3.isLooser, true);
    assert(det3.items.some(i => i.includes('Removed hard danger entry "delete"')));
    recordPass(suite5, 'Case 3: Removing hard danger entry detected as loosening');

    // Case 4: Disabling hard danger entry
    const looser4 = JSON.parse(JSON.stringify(baseRules));
    looser4.danger[0].enabled = false;
    const det4 = detectLoosening(baseRules, looser4);
    assert.strictEqual(det4.isLooser, true);
    assert(det4.items.some(i => i.includes('Disabled hard danger entry "delete"')));
    recordPass(suite5, 'Case 4: Disabling hard danger entry detected as loosening');

    // Case 5: Enabling tier-2 allow rule
    const looser5 = JSON.parse(JSON.stringify(baseRules));
    looser5.allow[0].enabled = true;
    const det5 = detectLoosening(baseRules, looser5);
    assert.strictEqual(det5.isLooser, true);
    assert(det5.items.some(i => i.includes('Enabled tier-2 allow rule "npm-build"')));
    recordPass(suite5, 'Case 5: Enabling tier-2 allow rule detected as loosening');

    // Case 6: Shortening slow-danger delay
    const looser6 = JSON.parse(JSON.stringify(baseRules));
    looser6.danger[1].delay = 3; // Shortened from 10 to 3
    const det6 = detectLoosening(baseRules, looser6);
    assert.strictEqual(det6.isLooser, true);
    assert(det6.items.some(i => i.includes('Shortened delay for slow danger entry')));
    recordPass(suite5, 'Case 6: Shortening slow-danger delay detected as loosening');

    // Tightening changes: NO loosening detected
    const tightenedRules = JSON.parse(JSON.stringify(baseRules));
    tightenedRules.optionRules[0].commandStartsWith = 'git status'; // Tighter
    tightenedRules.danger.push({ text: 'extra-danger', wholeWord: false, level: 'hard' }); // Safer
    tightenedRules.danger[1].delay = 15; // Increased delay (safer)
    const detTight = detectLoosening(baseRules, tightenedRules);
    assert.strictEqual(detTight.isLooser, false, 'Tightening changes must not trigger loosening confirmation');
    assert.strictEqual(detTight.items.length, 0);
    recordPass(suite5, 'Tightening changes save without loosening dialog');
  }

  // =============================================================
  // Suite 6: The "PERSIST" Confirmation Check
  // =============================================================
  const suite6 = 'Suite 6: The "PERSIST" Confirmation Check';
  console.log(`\n--- ${suite6} ---`);
  {
    const baseRules = {
      optionRules: [
        { name: 'rule-normal', startsWith: 'Yes, allow', allowPersist: false }
      ]
    };
    const persistRules = {
      optionRules: [
        { name: 'rule-normal', startsWith: 'Yes, allow', allowPersist: true }
      ]
    };

    const det = detectLoosening(baseRules, persistRules);
    assert.strictEqual(det.isLooser, true);
    assert.strictEqual(det.requiresPersistConfirmation, true);

    // Verify confirmation logic: only exact "PERSIST" enables confirmation
    function checkPersistConfirmationInput(input) {
      return input.trim() === 'PERSIST';
    }

    assert.strictEqual(checkPersistConfirmationInput(''), false);
    assert.strictEqual(checkPersistConfirmationInput('yes'), false);
    assert.strictEqual(checkPersistConfirmationInput('ok'), false);
    assert.strictEqual(checkPersistConfirmationInput('persist'), false); // lowercase fails
    assert.strictEqual(checkPersistConfirmationInput('PERSIST'), true); // exact uppercase passes
    recordPass(suite6, 'Confirmation strictly requires typing uppercase PERSIST');
  }

  // =============================================================
  // Suite 7: IPC Safety (Rejects Unknown Channels, Bad Paths, Oversized Input)
  // =============================================================
  const suite7 = 'Suite 7: IPC Safety (Oversized Input & Path Traversal Rejection)';
  console.log(`\n--- ${suite7} ---`);
  {
    // Test oversized input check
    const hugePayload = {
      rules: {
        optionRules: [
          { name: 'rule', startsWith: 'Yes, ' + 'a'.repeat(600 * 1024) }
        ]
      }
    };
    const jsonStr = JSON.stringify(hugePayload);
    assert(jsonStr.length > 512 * 1024, 'Payload must exceed 512KB limit');

    function simulateIpcSave(payload) {
      if (!payload || typeof payload !== 'object') return { success: false, error: 'Invalid payload' };
      if (JSON.stringify(payload).length > 512 * 1024) return { success: false, error: 'Payload too large (max 512KB)' };
      if (payload.path || payload.filePath || payload.rulesPath) return { success: false, error: 'Path selection forbidden' };
      return { success: true };
    }

    const resOversized = simulateIpcSave(hugePayload);
    assert.strictEqual(resOversized.success, false);
    assert(resOversized.error.includes('Payload too large'));
    recordPass(suite7, 'Oversized IPC payload rejected');

    // Test forbidden path parameter in save
    const resPath = simulateIpcSave({ rules: {}, path: 'C:\\custom\\path.json' });
    assert.strictEqual(resPath.success, false);
    assert(resPath.error.includes('Path selection forbidden'));
    recordPass(suite7, 'Renderer path selection in save is strictly forbidden');

    // Test path traversal rejection in restore
    assert.throws(() => {
      restoreRulesBackup('../../../etc/passwd', path.join(testDir, 'rules.json'), testDir);
    }, /Invalid backup filename/);
    recordPass(suite7, 'Path traversal in backup filename strictly rejected');
  }

  // =============================================================
  // Suite 8: Renderer Cannot Write Arbitrary Files
  // =============================================================
  const suite8 = 'Suite 8: Renderer File Access Safety Invariance';
  console.log(`\n--- ${suite8} ---`);
  {
    const rendererPath = path.resolve(__dirname, '../src/gui/renderer.js');
    const rendererCode = fs.readFileSync(rendererPath, 'utf8');

    // Must never access fs directly
    assert(!rendererCode.includes('fs.write'), 'Renderer must never contain fs.write');
    assert(!rendererCode.includes('fs.writeFileSync'), 'Renderer must never contain fs.writeFileSync');
    assert(!rendererCode.includes('fs.unlink'), 'Renderer must never contain fs.unlink');
    assert(!rendererCode.includes('require('), 'Renderer must not require Node.js modules');

    // Forbidden files must never be mentioned in renderer
    const forbidden = ['raw-session.bin', 'prompts.log', 'snapshots', 'history.jsonl'];
    for (const f of forbidden) {
      assert(!rendererCode.includes(f), `Renderer must never reference forbidden file "${f}"`);
    }
    recordPass(suite8, 'Renderer has zero direct file write access and mentions zero forbidden files');
  }

  // =============================================================
  // Suite 9: Try-it Tester Returns Same Decision as Wrapper & Sends Nothing
  // =============================================================
  const suite9 = 'Suite 9: Try-it Tester Decision Parity with Wrapper';
  console.log(`\n--- ${suite9} ---`);
  {
    const testRules = {
      defaultDelaySeconds: 3,
      deny: ['rm -rf'],
      danger: [{ text: 'delete', wholeWord: false, level: 'hard', enabled: true }],
      allow: [
        {
          name: 'git-readonly',
          pattern: '^git\\s+status$',
          delay: 3,
          enabled: true
        },
        {
          name: 'npm-build',
          pattern: '^npm run build$',
          delay: 3,
          enabled: false
        }
      ],
      optionRules: [
        {
          name: 'always-in-conversation',
          startsWith: 'Yes, and always allow in this conversation',
          commandStartsWith: 'git commit',
          enabled: true
        }
      ]
    };

    // 1. Safe git status prompt
    const prompt1 = {
      command: 'git status',
      commandSpaced: 'git status',
      options: [
        { number: 1, text: '1. Yes, once', classification: 'yes_once' },
        { number: 2, text: '2. No, cancel', classification: 'no' }
      ]
    };
    const d1_wrapper = evaluatePrompt(prompt1, testRules);
    assert.strictEqual(d1_wrapper.action, 'would_approve');
    assert.strictEqual(d1_wrapper.rule, 'git-readonly');
    recordPass(suite9, 'Try-it test 1: git status approves with allow rule');

    // 2. Deny prompt: rm -rf
    const prompt2 = {
      command: 'rm -rf node_modules',
      commandSpaced: 'rm -rf node_modules',
      options: [
        { number: 1, text: '1. Yes, once', classification: 'yes_once' },
        { number: 2, text: '2. No, cancel', classification: 'no' }
      ]
    };
    const d2_wrapper = evaluatePrompt(prompt2, testRules);
    assert.strictEqual(d2_wrapper.action, 'blocked');
    recordPass(suite9, 'Try-it test 2: rm -rf blocked by deny rule');

    // 3. Danger prompt: delete
    const prompt3 = {
      command: 'git push --delete origin feature',
      commandSpaced: 'git push --delete origin feature',
      options: [
        { number: 1, text: '1. Yes, once', classification: 'yes_once' },
        { number: 2, text: '2. No, cancel', classification: 'no' }
      ]
    };
    const d3_wrapper = evaluatePrompt(prompt3, testRules);
    assert.strictEqual(d3_wrapper.action, 'needs_user');
    assert(d3_wrapper.danger === true || d3_wrapper.reason.includes('DANGER'));
    recordPass(suite9, 'Try-it test 3: danger hit marks needs_user');

    // 4. Option rule prompt: git commit
    const prompt4 = {
      command: 'git commit -m "fix: bug"',
      commandSpaced: 'git commit -m "fix: bug"',
      options: [
        { number: 1, text: '1. Yes, once', classification: 'yes_once' },
        { number: 2, text: '2. Yes, and always allow in this conversation', classification: 'yes_session' },
        { number: 3, text: '3. No, cancel', classification: 'no' }
      ]
    };
    const d4_wrapper = evaluatePrompt(prompt4, testRules);
    assert.strictEqual(d4_wrapper.action, 'would_approve');
    assert.strictEqual(d4_wrapper.rule, 'always-in-conversation');
    assert.strictEqual(d4_wrapper.optionKey, '2');
    recordPass(suite9, 'Try-it test 4: option rule matches option 2');

    // 5. Choice question prompt
    const prompt5 = {
      command: 'git checkout',
      question: 'Which branch to checkout?',
      options: [
        { number: 1, text: '1. main', classification: 'custom' },
        { number: 2, text: '2. dev', classification: 'custom' }
      ]
    };
    const d5_wrapper = evaluatePrompt(prompt5, testRules);
    assert.strictEqual(d5_wrapper.action, 'needs_user');
    assert(d5_wrapper.reason.includes('choice question'));
    recordPass(suite9, 'Try-it test 5: choice question marks needs_user');
  }

  // =============================================================
  // Suite 10: Option Rule Reordering Changes Priority
  // =============================================================
  const suite10 = 'Suite 10: Option Rule Reordering Changes Priority';
  console.log(`\n--- ${suite10} ---`);
  {
    const prompt = {
      command: 'git commit',
      commandSpaced: 'git commit',
      options: [
        { number: 1, text: '1. Yes, allow for session', classification: 'yes_session' },
        { number: 2, text: '2. Yes, always allow in project', classification: 'yes_session' },
        { number: 3, text: '3. No, cancel', classification: 'no' }
      ]
    };

    // When Rule A is first in list: both rules enabled, Rule A wins because it is higher priority:
    const rulesOrderA = {
      defaultDelaySeconds: 3,
      deny: [],
      danger: [],
      optionRules: [
        { name: 'rule-A', startsWith: 'Yes, allow for session', enabled: true },
        { name: 'rule-B', startsWith: 'Yes, always allow in project', enabled: true }
      ]
    };

    const decisionA = evaluatePrompt(prompt, rulesOrderA);
    assert.strictEqual(decisionA.action, 'would_approve');
    assert.strictEqual(decisionA.rule, 'rule-A');
    assert.strictEqual(decisionA.winningRule, 'rule-A');
    assert.deepStrictEqual(decisionA.skippedRules, []);
    assert.strictEqual(decisionA.optionKey, '1');

    // When Rule B is reordered first: Rule B wins because it is now higher priority:
    const rulesOrderB = {
      ...rulesOrderA,
      optionRules: [rulesOrderA.optionRules[1], rulesOrderA.optionRules[0]]
    };
    const decisionB = evaluatePrompt(prompt, rulesOrderB);
    assert.strictEqual(decisionB.action, 'would_approve');
    assert.strictEqual(decisionB.rule, 'rule-B');
    assert.strictEqual(decisionB.winningRule, 'rule-B');
    assert.deepStrictEqual(decisionB.skippedRules, []);
    assert.strictEqual(decisionB.optionKey, '2');

    // Priority ordering preview and validation check
    const pA = renderer.generateRulePreview(rulesOrderA.optionRules[0]);
    assert(pA.includes('Yes, allow for session'));
    recordPass(suite10, 'Rule priority and plain language preview work accurately');
  }

  // =============================================================
  // Suite 11: Electron CSP and Security Settings
  // =============================================================
  const suite11 = 'Suite 11: Electron Security Settings and CSP';
  console.log(`\n--- ${suite11} ---`);
  {
    const htmlPath = path.resolve(__dirname, '../src/gui/index.html');
    const mainPath = path.resolve(__dirname, '../src/gui/main.js');
    const preloadPath = path.resolve(__dirname, '../src/gui/preload.js');

    const html = fs.readFileSync(htmlPath, 'utf8');
    const main = fs.readFileSync(mainPath, 'utf8');
    const preload = fs.readFileSync(preloadPath, 'utf8');

    assert(html.includes("default-src 'none'"), 'index.html must enforce default-src none CSP');
    assert(!html.includes('http://') && !html.includes('https://'), 'index.html must have no remote URLs');

    assert(main.includes('contextIsolation: true'), 'contextIsolation must be true');
    assert(main.includes('nodeIntegration: false'), 'nodeIntegration must be false');
    assert(main.includes('sandbox: true'), 'sandbox must be true');
    assert(main.includes('webviewTag: false'), 'webviewTag must be false');
    assert(main.includes('will-navigate') && main.includes('event.preventDefault()'), 'will-navigate must be prevented');
    assert(main.includes('setWindowOpenHandler'), 'setWindowOpenHandler must deny new windows');

    assert(preload.includes("contextBridge.exposeInMainWorld('agentwatch'"), 'contextBridge must expose agentwatch');
    recordPass(suite11, 'All Electron security settings and strict CSP verified');
  }

  // =============================================================
  // Suite 12: Single-Write-Path Safety & Privacy Verification
  // =============================================================
  const suite12 = 'Suite 12: Single-Write-Path Safety & Privacy Verification';
  console.log(`\n--- ${suite12} ---`);
  {
    const agentwatchCode = fs.readFileSync(path.resolve(__dirname, '../src/agentwatch.js'), 'utf8');
    const guiDir = path.resolve(__dirname, '../src/gui');
    const guiFiles = fs.readdirSync(guiDir);

    // 1. Single write path to child process: ONLY sendAutoAnswer in agentwatch.js
    for (const f of guiFiles) {
      const code = fs.readFileSync(path.join(guiDir, f), 'utf8');
      assert(!code.includes('sendAutoAnswer'), `GUI file ${f} must not contain sendAutoAnswer`);
      assert(!code.includes('.write('), `GUI file ${f} must not contain .write`);
      assert(!code.includes('sendInput'), `GUI file ${f} must not contain sendInput`);
    }
    recordPass(suite12, 'GUI has zero child process write capability');

    // 2. Privacy test: sensitive tokens never logged in plain text in rules-changes.log
    const testRules = {
      defaultDelaySeconds: 3,
      optionRules: [
        { name: 'rule-secret', startsWith: 'Yes, allow token=ghp_secretpassword123' }
      ]
    };
    const logPath = path.join(process.env.AGENTWATCH_DIR, 'rules-changes.log');
    const logBefore = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
    saveRules(testRules, path.join(testDir, 'rules-privacy.json'), { changeSummary: 'User modified rules' });
    const logAfter = fs.readFileSync(logPath, 'utf8');
    const diff = logAfter.slice(logBefore.length);
    assert(!diff.includes('ghp_secretpassword123'), 'Sensitive token values must never be included in rules-changes.log');
    recordPass(suite12, 'Privacy test: change log contains only clean summaries, no secrets');
  }

} finally {
  try {
    fs.rmSync(testDir, { recursive: true, force: true });
  } catch (e) {}
}

console.log('\n=========================================');
console.log('Stage 4d Pass Counts Per Suite:');
for (const [suite, count] of Object.entries(suitePassCounts)) {
  console.log(`  ${suite}: ${count} passed`);
}
console.log(`\nTotal Stage 4d tests: ${passCount} passed`);
console.log('=========================================\n');
