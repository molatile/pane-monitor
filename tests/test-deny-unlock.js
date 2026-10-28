const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const {
  loadRules,
  saveRules,
  checkDenyRule,
  evaluatePrompt,
  validateAllRules,
  resetDenyList,
  resetAllRules,
  getRulesBackups,
  getRulesChangesLogPath,
  isBuiltinDenyRule,
  getLockedDenyExplanation,
  DEFAULT_RULES,
  DEFAULT_DANGER_LIST
} = require('../src/rules');

const { loadConfig, saveConfig, getDashboardData } = require('../src/shared');
const { setSetting } = require('../src/gui/main');
const rendererModule = require('../src/gui/renderer');

console.log('Running agentwatch Deny List Handling & Unlock Flow Tests...\n');

let totalPasses = 0;
const suitePassCounts = {
  'Suite 1: "format" Whole-Word & Anchored Matching': 0,
  'Suite 2: Other Built-in Entries (sudo, credentials, .env)': 0,
  'Suite 3: Locked Entries Rejection & Explanatory Message': 0,
  'Suite 4: Unlock Flow Requires Typing UNLOCK': 0,
  'Suite 5: Changes Logged to rules-changes.log & Backed Up': 0,
  'Suite 6: Reset to Defaults Restores Deny List': 0,
  'Suite 7: Hard Danger List Behavior Invariance': 0,
  'Suite 8: Single-Write-Path Safety & Privacy Verification': 0
};

function recordPass(suiteName, desc) {
  totalPasses++;
  suitePassCounts[suiteName] = (suitePassCounts[suiteName] || 0) + 1;
  console.log(`  ✓ ${desc}`);
}

function createTempDir(prefix = 'agentwatch-test-deny-') {
  const dir = path.join(os.tmpdir(), `${prefix}${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

async function runTests() {
  const tmpDir = createTempDir();
  const originalAgentwatchDir = process.env.AGENTWATCH_DIR;
  process.env.AGENTWATCH_DIR = path.join(tmpDir, '.agentwatch');

  try {
    // =========================================================================
    // Suite 1: "format" Whole-Word & Anchored Matching
    // =========================================================================
    const s1 = 'Suite 1: "format" Whole-Word & Anchored Matching';
    console.log(`--- ${s1} ---`);
    {
      // 1.1 Blocks "format c:"
      assert.strictEqual(
        checkDenyRule('format', 'format c:', 'formatc:'),
        true,
        'Must block "format c:"'
      );
      recordPass(s1, 'Blocks "format c:"');

      // 1.2 Blocks "format" as a command alone
      assert.strictEqual(
        checkDenyRule('format', 'format', 'format'),
        true,
        'Must block "format" as a bare command'
      );
      recordPass(s1, 'Blocks bare "format" command');

      // 1.3 Blocks "format" with leading spaces
      assert.strictEqual(
        checkDenyRule('format', '  format c:', 'formatc:'),
        true,
        'Must block "  format c:" with leading spaces'
      );
      recordPass(s1, 'Blocks "  format c:" with leading spaces');

      // 1.4 Blocks "format" in a pipeline or compound command
      assert.strictEqual(
        checkDenyRule('format', 'echo y | format c:', 'echoy|formatc:'),
        true,
        'Must block "format" after pipe'
      );
      assert.strictEqual(
        checkDenyRule('format', 'dir && format d:', 'dir&&formatd:'),
        true,
        'Must block "format" after &&'
      );
      recordPass(s1, 'Blocks "format" in chained commands (pipe, &&)');

      // 1.5 Blocks "format" with switches like /fs:ntfs
      assert.strictEqual(
        checkDenyRule('format', 'format /fs:ntfs d:', 'format/fs:ntfsd:'),
        true,
        'Must block "format /fs:ntfs d:"'
      );
      recordPass(s1, 'Blocks "format /fs:ntfs d:"');

      // 1.6 Does NOT block "information"
      assert.strictEqual(
        checkDenyRule('format', 'information', 'information'),
        false,
        'Must NOT block "information"'
      );
      assert.strictEqual(
        checkDenyRule('format', 'cat information.txt', 'catinformation.txt'),
        false,
        'Must NOT block "cat information.txt"'
      );
      recordPass(s1, 'Does not block "information"');

      // 1.7 Does NOT block "formatted"
      assert.strictEqual(
        checkDenyRule('format', 'formatted', 'formatted'),
        false,
        'Must NOT block "formatted"'
      );
      assert.strictEqual(
        checkDenyRule('format', 'echo formatted output', 'echoformattedoutput'),
        false,
        'Must NOT block "echo formatted output"'
      );
      recordPass(s1, 'Does not block "formatted"');

      // 1.8 Does NOT block "npm run format"
      assert.strictEqual(
        checkDenyRule('format', 'npm run format', 'npmrunformat'),
        false,
        'Must NOT block "npm run format"'
      );
      assert.strictEqual(
        checkDenyRule('format', 'yarn format', 'yarnformat'),
        false,
        'Must NOT block "yarn format"'
      );
      recordPass(s1, 'Does not block "npm run format" or "yarn format"');

      // 1.9 Does NOT block "Format-Table"
      assert.strictEqual(
        checkDenyRule('format', 'Get-ChildItem | Format-Table -AutoSize', 'get-childitem|format-table-autosize'),
        false,
        'Must NOT block "Format-Table"'
      );
      recordPass(s1, 'Does not block "Format-Table" in PowerShell');

      // 1.10 Prompt evaluation integration
      const promptFormat = {
        commandSpaced: 'format c:',
        commandCompact: 'formatc:',
        options: [
          { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const decBlocked = evaluatePrompt(promptFormat);
      assert.strictEqual(decBlocked.action, 'blocked');
      assert.strictEqual(decBlocked.rule, 'format');

      const promptNpm = {
        commandSpaced: 'npm run format',
        commandCompact: 'npmrunformat',
        options: [
          { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const decNpm = evaluatePrompt(promptNpm);
      assert.notStrictEqual(decNpm.action, 'blocked', '"npm run format" must not be blocked by deny rule');
      recordPass(s1, 'evaluatePrompt blocks "format c:" and does not block "npm run format"');
    }

    // =========================================================================
    // Suite 2: Other Built-in Entries (sudo, credentials, .env)
    // =========================================================================
    const s2 = 'Suite 2: Other Built-in Entries (sudo, credentials, .env)';
    console.log(`\n--- ${s2} ---`);
    {
      // 2.1 "sudo" blocks genuine sudo commands
      assert.strictEqual(checkDenyRule('sudo', 'sudo rm -rf /', 'sudorm-rf/'), true);
      assert.strictEqual(checkDenyRule('sudo', 'sudo apt-get update', 'sudoapt-getupdate'), true);
      assert.strictEqual(checkDenyRule('sudo', 'echo test | sudo tee /file', 'echotest|sudotee/file'), true);
      recordPass(s2, 'Blocks genuine "sudo" invocations');

      // 2.2 "sudo" does NOT block "pseudo", "pseudocode", "pseudorandom"
      assert.strictEqual(checkDenyRule('sudo', 'echo pseudo', 'echopseudo'), false);
      assert.strictEqual(checkDenyRule('sudo', 'cat pseudocode.txt', 'catpseudocode.txt'), false);
      assert.strictEqual(checkDenyRule('sudo', 'generate --pseudorandom', 'generate--pseudorandom'), false);
      recordPass(s2, 'Does not block "pseudo", "pseudocode", "pseudorandom"');

      // 2.3 "credentials" blocks sensitive credentials text
      assert.strictEqual(checkDenyRule('credentials', 'echo my credentials', 'echomycredentials'), true);
      assert.strictEqual(checkDenyRule('credentials', 'cat credentials_FAKE0123', 'catcredentials_fake0123'), true);
      recordPass(s2, 'Blocks sensitive "credentials" invocations');

      // 2.4 ".env" blocks environment file accesses
      assert.strictEqual(checkDenyRule('.env', 'cat .env', 'cat.env'), true);
      assert.strictEqual(checkDenyRule('.env', 'echo SECRET=1 >> .env.production', 'echosecret=1>>.env.production'), true);
      assert.strictEqual(checkDenyRule('.env', 'cat . env.production', 'cat.env.production'), true);
      recordPass(s2, 'Blocks ".env" accesses including split forms');
    }

    // =========================================================================
    // Suite 3: Locked Entries Rejection & Explanatory Message
    // =========================================================================
    const s3 = 'Suite 3: Locked Entries Rejection & Explanatory Message';
    console.log(`\n--- ${s3} ---`);
    {
      // 3.1 isBuiltinDenyRule recognizes all built-in deny entries
      for (const builtin of DEFAULT_RULES.deny) {
        assert.strictEqual(isBuiltinDenyRule(builtin), true, `Must recognize "${builtin}" as built-in deny rule`);
        assert.strictEqual(rendererModule.isBuiltinDenyRule(builtin), true, `Renderer must recognize "${builtin}" as built-in`);
      }
      assert.strictEqual(isBuiltinDenyRule('my-custom-rule'), false);
      assert.strictEqual(rendererModule.isBuiltinDenyRule('my-custom-rule'), false);
      recordPass(s3, 'isBuiltinDenyRule correctly classifies all built-in and custom entries');

      // 3.2 Explanatory message content
      const explanation = getLockedDenyExplanation('format');
      assert(explanation.includes('locked'), 'Explanation must mention rule is locked');
      assert(explanation.includes('whole-word matching'), 'Explanation must suggest alternative 1: whole-word matching');
      assert(explanation.includes('narrow allow rule'), 'Explanation must suggest alternative 2: narrow allow rule');
      assert(explanation.includes('Unlock built-in deny rules'), 'Explanation must mention settings toggle');
      recordPass(s3, 'getLockedDenyExplanation contains why it is locked and both alternatives');

      // 3.3 validateAllRules rejects removing built-in deny rule when unlockBuiltinDenyRules is off
      const rulesWithoutFormat = {
        defaultDelaySeconds: 3,
        deny: DEFAULT_RULES.deny.filter(r => r !== 'format'),
        danger: DEFAULT_DANGER_LIST,
        allow: DEFAULT_RULES.allow,
        optionRules: []
      };

      const valDefaultOff = validateAllRules(rulesWithoutFormat);
      assert.strictEqual(valDefaultOff.valid, false, 'Validation must fail when built-in rule is removed and setting is off');
      assert(valDefaultOff.errors.some(e => e.includes('format') && e.includes('whole-word matching') && e.includes('narrow allow rule')),
        'Error must be the clear explanatory message instead of bare error');
      recordPass(s3, 'validateAllRules returns explanatory message with both alternatives when setting is off');

      // 3.4 saveRules throws and does not modify disk when setting is off
      const rulesFilePath = path.join(tmpDir, 'test-locked-rules.json');
      fs.writeFileSync(rulesFilePath, JSON.stringify(DEFAULT_RULES, null, 2), 'utf8');
      const beforeContent = fs.readFileSync(rulesFilePath, 'utf8');

      assert.throws(() => {
        saveRules(rulesWithoutFormat, rulesFilePath, { unlockBuiltinDenyRules: false });
      }, /Built-in deny rule.*cannot be removed/);

      assert.strictEqual(fs.readFileSync(rulesFilePath, 'utf8'), beforeContent, 'File must not be modified when locked removal is rejected');
      recordPass(s3, 'saveRules prevents removing locked built-in entries and preserves file on disk');
    }

    // =========================================================================
    // Suite 4: Unlock Flow Requires Typing UNLOCK
    // =========================================================================
    const s4 = 'Suite 4: Unlock Flow Requires Typing UNLOCK';
    console.log(`\n--- ${s4} ---`);
    {
      // 4.1 Setting "unlockBuiltinDenyRules" in config starts false
      const configPath = path.join(tmpDir, 'config.json');
      saveConfig({}, configPath);
      let cfg = loadConfig(configPath);
      assert.strictEqual(cfg.unlockBuiltinDenyRules, false, 'unlockBuiltinDenyRules must be false by default');
      recordPass(s4, 'unlockBuiltinDenyRules is false by default in config');

      // 4.2 setSetting persists unlockBuiltinDenyRules: true
      const setRes = setSetting({ key: 'unlockBuiltinDenyRules', value: true }, { configPath });
      assert.strictEqual(setRes.success, true);
      cfg = loadConfig(configPath);
      assert.strictEqual(cfg.unlockBuiltinDenyRules, true, 'Setting must persist to true in config.json');
      recordPass(s4, 'setSetting successfully persists unlockBuiltinDenyRules: true');

      // 4.3 Unlock confirmation typing logic: requires exact "UNLOCK"
      function checkUnlockConfirm(input) {
        return (input.trim() === 'UNLOCK');
      }

      assert.strictEqual(checkUnlockConfirm(''), false, 'Empty input must not enable unlock');
      assert.strictEqual(checkUnlockConfirm('unlock'), false, 'Lowercase "unlock" must not enable unlock');
      assert.strictEqual(checkUnlockConfirm('UNLOC'), false, 'Partial match must not enable unlock');
      assert.strictEqual(checkUnlockConfirm('UNLOCK!'), false, 'Extra characters must not enable unlock');
      assert.strictEqual(checkUnlockConfirm('UNLOCK'), true, 'Exact "UNLOCK" must enable confirm');
      assert.strictEqual(checkUnlockConfirm('  UNLOCK  '), true, 'Trimmed "UNLOCK" must enable confirm');
      recordPass(s4, 'Confirmation requires typing exact "UNLOCK"');

      // 4.4 Simulated GUI Deny List Interaction
      // Create mock DOM structure to test renderer deny list interaction
      const mockElements = new Map();
      function createMockEl(id, tag = 'div') {
        const el = {
          id,
          tagName: tag.toUpperCase(),
          children: [],
          classList: {
            classes: new Set(),
            add(c) { this.classes.add(c); },
            remove(c) { this.classes.delete(c); },
            contains(c) { return this.classes.has(c); },
            toggle(c, force) {
              if (force === undefined) {
                if (this.classes.has(c)) this.classes.delete(c); else this.classes.add(c);
              } else if (force) {
                this.classes.add(c);
              } else {
                this.classes.delete(c);
              }
            }
          },
          listeners: {},
          addEventListener(event, fn) {
            this.listeners[event] = this.listeners[event] || [];
            this.listeners[event].push(fn);
          },
          dispatchEvent(event) {
            const handlers = this.listeners[event.type] || [];
            for (const h of handlers) h(event);
          },
          appendChild(child) {
            this.children.push(child);
            child.parentNode = this;
            return child;
          },
          innerHTML: '',
          textContent: '',
          value: '',
          disabled: false,
          style: {}
        };
        mockElements.set(id, el);
        return el;
      }

      global.document = {
        getElementById: (id) => mockElements.get(id) || null,
        createElement: (tag) => createMockEl(`el-${Math.random()}`, tag)
      };

      const denyContainer = createMockEl('deny-list-container');
      const lockedModal = createMockEl('locked-deny-modal');
      lockedModal.classList.add('hidden');
      const lockedRuleName = createMockEl('locked-deny-rule-name');
      const lockedCloseBtn = createMockEl('locked-deny-close-btn');

      const unlockModal = createMockEl('unlock-deny-modal');
      unlockModal.classList.add('hidden');
      const unlockEntryName = createMockEl('unlock-deny-entry-name');
      const unlockInput = createMockEl('unlock-deny-input');
      const unlockConfirmBtn = createMockEl('unlock-deny-confirm-btn');
      unlockConfirmBtn.disabled = true;
      const unlockCancelBtn = createMockEl('unlock-deny-cancel-btn');

      delete require.cache[require.resolve('../src/gui/renderer')];
      const liveRenderer = require('../src/gui/renderer');

      // Test renderer with unlockBuiltinDenyRules = false
      liveRenderer.getCurrentConfig().unlockBuiltinDenyRules = false;
      liveRenderer.setWorkingRules({
        defaultDelaySeconds: 3,
        deny: ['rm -rf', 'format', 'custom-pattern'],
        danger: DEFAULT_DANGER_LIST,
        allow: DEFAULT_RULES.allow,
        optionRules: []
      });

      // Show locked dialog for 'format'
      liveRenderer.showLockedDenyDialog('format');
      assert.strictEqual(lockedRuleName.textContent, '"format"');
      assert.strictEqual(lockedModal.classList.contains('hidden'), false, 'Locked modal must be visible');
      lockedCloseBtn.dispatchEvent({ type: 'click' });
      assert.strictEqual(lockedModal.classList.contains('hidden'), true, 'Locked modal closes on close button');
      recordPass(s4, 'Locked modal appears and lists locked rule when setting is off');

      // Test unlock dialog when unlockBuiltinDenyRules = true
      liveRenderer.getCurrentConfig().unlockBuiltinDenyRules = true;
      liveRenderer.showUnlockConfirmationDialog('format', 1);
      assert.strictEqual(unlockEntryName.textContent, '"format"', 'Unlock dialog must list the entry being removed');
      assert.strictEqual(unlockModal.classList.contains('hidden'), false, 'Unlock modal must be visible');
      assert.strictEqual(unlockConfirmBtn.disabled, true, 'Confirm button must be initially disabled');

      // Simulate user typing wrong text
      unlockInput.value = 'NOPE';
      unlockInput.dispatchEvent({ type: 'input' });
      assert.strictEqual(unlockConfirmBtn.disabled, true, 'Wrong input keeps button disabled');

      // Simulate user typing UNLOCK
      unlockInput.value = 'UNLOCK';
      unlockInput.dispatchEvent({ type: 'input' });
      assert.strictEqual(unlockConfirmBtn.disabled, false, 'Exact "UNLOCK" enables confirm button');

      // Click confirm: entry is removed
      unlockConfirmBtn.dispatchEvent({ type: 'click' });
      const currentWorking = liveRenderer.getWorkingRules();
      assert(!currentWorking.deny.includes('format'), 'format must be removed from working deny rules');
      assert.strictEqual(currentWorking.deny.includes('custom-pattern'), true, 'Other rules remain');
      assert.strictEqual(unlockModal.classList.contains('hidden'), true, 'Modal closes on confirm');
      recordPass(s4, 'Unlock confirmation dialog requires typing UNLOCK and removes the entry when confirmed');
    }

    // =========================================================================
    // Suite 5: Changes Logged to rules-changes.log & Backed Up
    // =========================================================================
    const s5 = 'Suite 5: Changes Logged to rules-changes.log & Backed Up';
    console.log(`\n--- ${s5} ---`);
    {
      const rulesFilePath = path.join(tmpDir, 'rules.json');
      fs.writeFileSync(rulesFilePath, JSON.stringify(DEFAULT_RULES, null, 2), 'utf8');

      const logPath = getRulesChangesLogPath();
      const backupsDir = path.join(process.env.AGENTWATCH_DIR, 'rules-backups');

      // Save a modified ruleset with format removed (allowed because unlockBuiltinDenyRules: true)
      const modifiedRules = {
        defaultDelaySeconds: 3,
        deny: DEFAULT_RULES.deny.filter(r => r !== 'format'),
        danger: DEFAULT_DANGER_LIST,
        allow: DEFAULT_RULES.allow,
        optionRules: []
      };

      const saveRes = saveRules(modifiedRules, rulesFilePath, {
        unlockBuiltinDenyRules: true,
        changeSummary: 'Removed built-in deny rule "format" (unlocked)'
      });

      assert.strictEqual(saveRes.success, true);
      const onDisk = JSON.parse(fs.readFileSync(rulesFilePath, 'utf8'));
      assert(!onDisk.deny.includes('format'), 'Saved rules on disk must omit format');
      recordPass(s5, 'saveRules succeeds when unlockBuiltinDenyRules is true');

      // Verify log file exists and contains change summary
      assert(fs.existsSync(logPath), 'rules-changes.log must exist');
      const logContent = fs.readFileSync(logPath, 'utf8');
      const parsedLog = JSON.parse(logContent.trim().split('\n')[0]);
      assert.strictEqual(parsedLog.what, 'Removed built-in deny rule "format" (unlocked)');
      recordPass(s5, 'Change is logged to ~/.agentwatch/rules-changes.log');

      // Verify backups created
      assert(fs.existsSync(backupsDir), 'rules-backups directory must exist');
      const backups = getRulesBackups(backupsDir);
      assert(backups.length >= 1, 'At least one backup must exist');
      assert(backups[0].name.startsWith('rules-') && backups[0].name.endsWith('.json'));
      recordPass(s5, 'Timestamped backup is created in rules-backups');

      // Verify backup retention: newest 10 backups retained
      for (let i = 0; i < 12; i++) {
        saveRules(modifiedRules, rulesFilePath, {
          unlockBuiltinDenyRules: true,
          changeSummary: `Change test ${i}`
        });
      }
      const updatedBackups = getRulesBackups(backupsDir);
      assert(updatedBackups.length <= 10, 'Must keep at most newest 10 backups');
      recordPass(s5, 'Backups retention enforces newest 10 backups limit');
    }

    // =========================================================================
    // Suite 6: Reset to Defaults Restores Deny List
    // =========================================================================
    const s6 = 'Suite 6: Reset to Defaults Restores Deny List';
    console.log(`\n--- ${s6} ---`);
    {
      const rulesFilePath = path.join(tmpDir, 'rules.json');

      // Verify file currently has format removed
      let currentRules = loadRules(rulesFilePath);
      assert(!currentRules.deny.includes('format'), 'File currently missing format');

      // Execute resetDenyList
      const resetRes = resetDenyList(rulesFilePath);
      assert.strictEqual(resetRes.success, true);

      // Verify defaults restored
      const restored = loadRules(rulesFilePath);
      assert(restored.deny.includes('format'), 'Restored deny list must contain format');
      assert(restored.deny.includes('sudo'), 'Restored deny list must contain sudo');
      assert(restored.deny.includes('rm -rf'), 'Restored deny list must contain rm -rf');
      assert.strictEqual(restored.deny.length, DEFAULT_RULES.deny.length);
      recordPass(s6, 'resetDenyList restores factory default deny list including "format"');

      // Verify resetAllRules
      const resetAllRes = resetAllRules(rulesFilePath);
      assert.strictEqual(resetAllRes.success, true);
      const allRestored = loadRules(rulesFilePath);
      assert(allRestored.deny.includes('format'));
      assert.strictEqual(allRestored.danger.length, DEFAULT_DANGER_LIST.length);
      recordPass(s6, 'resetAllRules restores all default deny, danger, and allow rules');

      // Verify reset was logged
      const logContent = fs.readFileSync(getRulesChangesLogPath(), 'utf8');
      assert(logContent.includes('Reset deny list to defaults'));
      assert(logContent.includes('Reset all rules to defaults'));
      recordPass(s6, 'Reset actions logged to rules-changes.log');
    }

    // =========================================================================
    // Suite 7: Hard Danger List Behavior Invariance
    // =========================================================================
    const s7 = 'Suite 7: Hard Danger List Behavior Invariance';
    console.log(`\n--- ${s7} ---`);
    {
      // 7.1 Danger words trigger hard stop (needs_user) even if allow rule matches
      const promptDanger = {
        commandSpaced: 'echo delete safe-file',
        commandCompact: 'echodeletesafe-file',
        options: [
          { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const decDanger = evaluatePrompt(promptDanger);
      assert.strictEqual(decDanger.action, 'needs_user');
      assert.strictEqual(decDanger.danger, true);
      assert.strictEqual(decDanger.entry, 'delete');
      recordPass(s7, 'Hard danger entry triggers needs_user and beats allow rules');

      // 7.2 Hard danger entry beats option rules
      const promptOptionDanger = {
        commandSpaced: 'git push origin main --force',
        commandCompact: 'gitpushoriginmain--force',
        options: [
          { key: '1', number: 1, text: 'Yes, and always allow in this conversation', classification: 'yes_session' },
          { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
        ]
      };
      const decOptionDanger = evaluatePrompt(promptOptionDanger);
      assert.strictEqual(decOptionDanger.action, 'needs_user', 'Danger beats option rules');
      assert.strictEqual(decOptionDanger.danger, true);
      recordPass(s7, 'Hard danger entry beats option rules');

      // 7.3 Folder rules cannot weaken global danger list
      const { validateFolderRules } = require('../src/rules');
      const weakenedFolderDanger = {
        danger: [
          { text: 'delete', wholeWord: false, level: 'slow', delay: 5 } // Weakened hard to slow!
        ]
      };
      const valWeak = validateFolderRules(weakenedFolderDanger, DEFAULT_RULES);
      assert.strictEqual(valWeak.valid, false, 'Folder rules cannot weaken hard danger stop');
      assert(valWeak.errors.some(e => e.includes('cannot weaken global danger entry')));
      recordPass(s7, 'Folder rules cannot weaken hard danger rules');
    }

    // =========================================================================
    // Suite 8: Single-Write-Path Safety & Privacy Verification
    // =========================================================================
    const s8 = 'Suite 8: Single-Write-Path Safety & Privacy Verification';
    console.log(`\n--- ${s8} ---`);
    {
      // 8.1 Static code analysis: ensure GUI never writes to pty/child process
      const rendererCode = fs.readFileSync(path.resolve(__dirname, '../src/gui/renderer.js'), 'utf8');
      assert(!rendererCode.includes('pty.write'), 'Renderer must never call pty.write');
      assert(!rendererCode.includes('child.stdin.write'), 'Renderer must never call child.stdin.write');
      assert(!rendererCode.includes('fs.write'), 'Renderer must never call fs.write');
      assert(!rendererCode.includes('require('), 'Renderer must never require Node modules');
      recordPass(s8, 'GUI renderer strictly adheres to single-write-path: zero child key sends');

      // 8.2 Privacy scan: sensitive tokens never appear unmasked in logs
      const { maskText } = require('../src/masker');
      const secretCommand = 'cat .env.production && echo TOKEN="my_secret_token_12345"';
      const masked = maskText(secretCommand);
      assert(!masked.includes('my_secret_token_12345'), 'Sensitive token must be masked');
      assert(masked.includes('[REDACTED]'), 'Secret token must be replaced by [REDACTED]');
      recordPass(s8, 'Privacy verification: secret tokens are masked before disk writes');
    }

    console.log('\n=========================================');
    console.log('Pass counts per suite:');
    for (const [suite, count] of Object.entries(suitePassCounts)) {
      console.log(`  ${suite}: ${count} passed`);
    }
    console.log(`\nAll ${totalPasses} deny list handling & unlock flow tests passed successfully!`);
    console.log('=========================================\n');

  } finally {
    process.env.AGENTWATCH_DIR = originalAgentwatchDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
}

runTests().catch(err => {
  console.error('\nTest failure:', err);
  process.exit(1);
});
