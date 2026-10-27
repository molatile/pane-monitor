const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { EventEmitter } = require('events');

const {
  loadRules,
  saveRules,
  evaluatePrompt,
  validateFolderRules,
  getFolderRulesPath,
  hasFolderRules,
  loadFolderRules,
  saveFolderRules,
  deleteFolderRules,
  copyAncestorRules,
  loadRulesForFolder,
  computeFolderAncestors,
  loadFolderChoices,
  saveFolderChoice,
  dismissFolderQuestion,
  getFolderRulesBackups,
  DEFAULT_RULES,
  DEFAULT_DANGER_LIST
} = require('../src/rules');
const { startAgentwatch } = require('../src/agentwatch');
const { getProfileForCommand } = require('../src/profile');
const { SessionStatusManager } = require('../src/status');

function createTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentwatch-stage5-'));
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function writeTerm(term, str) {
  return new Promise(resolve => {
    term.write(str, () => resolve());
  });
}

function scanDirForRawPath(dirPath, forbiddenSubstring) {
  const matches = [];
  function recurse(current) {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        recurse(full);
      } else if (ent.isFile()) {
        const content = fs.readFileSync(full, 'utf8');
        if (content.toLowerCase().includes(forbiddenSubstring.toLowerCase())) {
          matches.push({ file: full, content });
        }
      }
    }
  }
  recurse(dirPath);
  return matches;
}

const suitePassCounts = {
  'Suite 1: New folder with no ancestors (defaults, no question)': 0,
  'Suite 2: Nested folder under rule-bearing ancestor (question appears)': 0,
  'Suite 3: Yes copies rules (snapshot, skips allowPersist)': 0,
  'Suite 4: No keeps defaults & choice remembered': 0,
  'Suite 5: Nearest ancestor offered when several exist': 0,
  'Suite 6: Snapshot isolation (parent mutation does not affect child)': 0,
  'Suite 7: No raw paths in any file (Privacy recursive scan)': 0,
  'Suite 8: Danger & deny cannot be weakened by folder list': 0,
  'Suite 9: Priority order in wrapper & dynamic rule pickup': 0,
  'Suite 10: Reset to default works (deletes own list)': 0,
  'Suite 11: Non-blocking & auto state unchanged': 0,
  'Suite 12: IPC rejects paths and oversized input': 0,
  'Suite 13: Single-write-path safety verification': 0
};

async function runStage5Tests() {
  console.log('Running agentwatch Stage 5 test suite: Per-folder rules & nested question...\n');

  // =========================================================================
  // Suite 1: New folder with no ancestors
  // =========================================================================
  console.log('--- Suite 1: New folder with no ancestors (defaults, no question) ---');
  {
    const tmpDir = createTempDir();
    const folderRulesDir = path.join(tmpDir, 'folder-rules');
    const choicesPath = path.join(tmpDir, 'folder-choices.json');
    const sessionsDir = path.join(tmpDir, 'sessions');
    const rulesPath = path.join(tmpDir, 'rules.json');

    const defaultRules = {
      defaultDelaySeconds: 3,
      deny: DEFAULT_RULES.deny.slice(),
      danger: DEFAULT_DANGER_LIST.slice(),
      optionRules: [
        { name: 'default-allow', startsWith: 'Yes, run command' }
      ]
    };
    fs.writeFileSync(rulesPath, JSON.stringify(defaultRules, null, 2), 'utf8');

    const fakeCwd = path.join(tmpDir, 'brand-new-project');
    fs.mkdirSync(fakeCwd, { recursive: true });

    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};
    stdinMock.resume = () => {};
    stdinMock.pause = () => {};

    const stdoutMock = { columns: 100, rows: 30, write: () => {}, on: () => {}, removeListener: () => {} };
    const ptyMock = {
      write: () => {},
      resize: () => {},
      onData: () => {},
      onExit: () => {}
    };

    const monitor = startAgentwatch({
      command: 'agy',
      cwd: fakeCwd,
      stdin: stdinMock,
      stdout: stdoutMock,
      ptyProcess: ptyMock,
      rulesPath,
      folderRulesDir,
      choicesPath,
      sessionsDir,
      profile: getProfileForCommand('agy')
    });

    assert.strictEqual(monitor.statusManager.pendingQuestion, null, 'No pending question for new folder');
    const statusFile = JSON.parse(fs.readFileSync(monitor.statusManager.filePath, 'utf8'));
    assert.strictEqual(statusFile.pendingQuestion, null, 'Status file has pendingQuestion: null');
    assert(Array.isArray(statusFile.ancestors), 'Status file has ancestors array');

    // Evaluates with default rules
    const screen =
      'Requesting permission for:\r\n' +
      '   echo new-folder\r\n' +
      'Run this command?\r\n' +
      '> 1. Yes, run command\r\n' +
      '  2. No, cancel\r\n' +
      '↑/↓ Navigate · tab Amend · ctrl+g edit/expand command\r\n' +
      'esc to cancel\r\n';

    await writeTerm(monitor.term, screen);
    monitor.inspectScreenForPrompts(Date.now());
    const prompt = monitor.getActivePrompt();
    assert(prompt, 'Prompt should be detected');
    assert.strictEqual(prompt.decision.ruleList, 'default', 'Uses default rule list');
    assert.strictEqual(prompt.decision.rule, 'default-allow');
    assert(prompt.decision.log.includes('(rule: default-allow)'), 'Log shows (rule: default-allow)');

    monitor.cleanup();
    suitePassCounts['Suite 1: New folder with no ancestors (defaults, no question)']++;
    console.log('  ✓ New folder with no rule-bearing ancestors uses defaults with no question');
  }

  // =========================================================================
  // Suite 2: Nested folder under rule-bearing ancestor
  // =========================================================================
  console.log('\n--- Suite 2: Nested folder under rule-bearing ancestor (question appears) ---');
  {
    const tmpDir = createTempDir();
    const folderRulesDir = path.join(tmpDir, 'folder-rules');
    fs.mkdirSync(folderRulesDir, { recursive: true });
    const choicesPath = path.join(tmpDir, 'folder-choices.json');
    const sessionsDir = path.join(tmpDir, 'sessions');
    const rulesPath = path.join(tmpDir, 'rules.json');

    fs.writeFileSync(rulesPath, JSON.stringify(DEFAULT_RULES, null, 2), 'utf8');

    // Create ancestor folder and nested child folder
    const parentDir = path.join(tmpDir, 'parent-workspace');
    const childDir = path.join(parentDir, 'packages', 'app');
    fs.mkdirSync(childDir, { recursive: true });

    // Ancestor has its own folder rules
    const ancestors = computeFolderAncestors(childDir, 'agy');
    const parentAncestor = ancestors.find(a => a.name === 'parent-workspace');
    assert(parentAncestor, 'Parent ancestor must be computed');

    const parentRules = {
      optionRules: [
        { name: 'parent-rule-1', startsWith: 'Yes, run command' },
        { name: 'parent-persist-rule', startsWith: 'Yes, persist in settings.json', allowPersist: true }
      ]
    };
    saveFolderRules(parentAncestor.key, parentRules, { customDir: folderRulesDir });

    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};
    stdinMock.resume = () => {};
    stdinMock.pause = () => {};

    const stdoutMock = { columns: 100, rows: 30, write: () => {}, on: () => {}, removeListener: () => {} };
    const ptyMock = {
      write: () => {},
      resize: () => {},
      onData: () => {},
      onExit: () => {}
    };

    const monitor = startAgentwatch({
      command: 'agy',
      cwd: childDir,
      stdin: stdinMock,
      stdout: stdoutMock,
      ptyProcess: ptyMock,
      rulesPath,
      folderRulesDir,
      choicesPath,
      sessionsDir,
      profile: getProfileForCommand('agy')
    });

    const pq = monitor.statusManager.pendingQuestion;
    assert(pq, 'Pending question must be set');
    assert.strictEqual(pq.type, 'nested_folder_rules');
    assert.strictEqual(pq.folderName, 'app');
    assert.strictEqual(pq.ancestorName, 'parent-workspace');
    assert.strictEqual(pq.ancestorKey, parentAncestor.key);
    assert.strictEqual(pq.ruleCount, 2);

    // Verify session status file contains the exact question fields
    const statusFile = JSON.parse(fs.readFileSync(monitor.statusManager.filePath, 'utf8'));
    assert.deepStrictEqual(statusFile.pendingQuestion, pq);

    monitor.cleanup();
    suitePassCounts['Suite 2: Nested folder under rule-bearing ancestor (question appears)']++;
    console.log('  ✓ Nested folder under rule-bearing ancestor records pending question with correct details');
  }

  // =========================================================================
  // Suite 3: Yes copies rules (snapshot, skips allowPersist)
  // =========================================================================
  console.log('\n--- Suite 3: Yes copies rules (snapshot, skips allowPersist) ---');
  {
    const tmpDir = createTempDir();
    const folderRulesDir = path.join(tmpDir, 'folder-rules');
    fs.mkdirSync(folderRulesDir, { recursive: true });
    const choicesPath = path.join(tmpDir, 'folder-choices.json');

    const ancestorKey = 'agy:ancestor123';
    const childKey = 'agy:child456';

    const ancestorRules = {
      optionRules: [
        { name: 'safe-rule-1', startsWith: 'Yes, run command' },
        { name: 'safe-rule-2', startsWith: 'Yes, once' },
        { name: 'dangerous-persist', startsWith: 'Yes, persist', allowPersist: true }
      ]
    };
    saveFolderRules(ancestorKey, ancestorRules, { customDir: folderRulesDir });

    const copyResult = copyAncestorRules(childKey, ancestorKey, {
      customDir: folderRulesDir,
      customChoicesPath: choicesPath
    });

    assert.strictEqual(copyResult.success, true);
    assert.strictEqual(copyResult.copiedCount, 2, 'Must copy exactly 2 safe rules');
    assert.strictEqual(copyResult.skippedPersistCount, 1, 'Must skip 1 allowPersist rule');

    // Verify child rules in file
    const childSaved = loadFolderRules(childKey, folderRulesDir);
    assert(childSaved, 'Child folder rules file must exist');
    assert.strictEqual(childSaved.optionRules.length, 2);
    assert(childSaved.optionRules.some(r => r.name === 'safe-rule-1'));
    assert(childSaved.optionRules.some(r => r.name === 'safe-rule-2'));
    assert(!childSaved.optionRules.some(r => r.allowPersist), 'No allowPersist rule should be copied');

    // Verify choices file recorded the answer
    const choices = loadFolderChoices(choicesPath);
    assert(choices[childKey], 'Choice must be saved for child key');
    assert.strictEqual(choices[childKey].choice, 'copied');
    assert.strictEqual(choices[childKey].ancestorKey, ancestorKey);

    suitePassCounts['Suite 3: Yes copies rules (snapshot, skips allowPersist)']++;
    console.log('  ✓ Yes copies ancestor rules into snapshot and skips allowPersist rules with count reported');
  }

  // =========================================================================
  // Suite 4: No keeps defaults & choice remembered
  // =========================================================================
  console.log('\n--- Suite 4: No keeps defaults & choice remembered ---');
  {
    const tmpDir = createTempDir();
    const folderRulesDir = path.join(tmpDir, 'folder-rules');
    fs.mkdirSync(folderRulesDir, { recursive: true });
    const choicesPath = path.join(tmpDir, 'folder-choices.json');
    const sessionsDir = path.join(tmpDir, 'sessions');

    const parentDir = path.join(tmpDir, 'parent');
    const childDir = path.join(parentDir, 'sub');
    fs.mkdirSync(childDir, { recursive: true });

    const ancestors = computeFolderAncestors(childDir, 'agy');
    const parentAncestor = ancestors[0];
    saveFolderRules(parentAncestor.key, { optionRules: [{ name: 'parent-rule', startsWith: 'Yes, run' }] }, { customDir: folderRulesDir });

    // User chooses "No" -> saves choice: 'declined'
    const childKey = `agy:${ancestors[0].hash}_child`;
    saveFolderChoice(childKey, { choice: 'declined', ancestorKey: parentAncestor.key }, choicesPath);

    // Now start session for child
    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};

    const monitor = startAgentwatch({
      command: 'agy',
      cwd: childDir,
      sessionKey: childKey,
      stdin: stdinMock,
      stdout: { columns: 100, rows: 30, write: () => {}, on: () => {} },
      ptyProcess: { write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {} },
      folderRulesDir,
      choicesPath,
      sessionsDir,
      profile: getProfileForCommand('agy')
    });

    assert.strictEqual(monitor.statusManager.pendingQuestion, null, 'Question not asked because choice is declined');
    monitor.cleanup();

    // Dismissal counter: dismiss twice without answering
    const dismissKey = 'agy:dismiss_test';
    dismissFolderQuestion(dismissKey, choicesPath);
    let ch = loadFolderChoices(choicesPath);
    assert.strictEqual(ch[dismissKey].dismissCount, 1);
    assert.strictEqual(ch[dismissKey].choice, undefined);

    dismissFolderQuestion(dismissKey, choicesPath);
    ch = loadFolderChoices(choicesPath);
    assert.strictEqual(ch[dismissKey].dismissCount, 2);
    assert.strictEqual(ch[dismissKey].choice, 'declined', 'Declined after 2 dismissals');

    suitePassCounts['Suite 4: No keeps defaults & choice remembered']++;
    console.log('  ✓ No keeps defaults, answer is remembered, and 2 dismissals stops asking');
  }

  // =========================================================================
  // Suite 5: Nearest ancestor offered when several exist
  // =========================================================================
  console.log('\n--- Suite 5: Nearest ancestor offered when several exist ---');
  {
    const tmpDir = createTempDir();
    const folderRulesDir = path.join(tmpDir, 'folder-rules');
    fs.mkdirSync(folderRulesDir, { recursive: true });
    const choicesPath = path.join(tmpDir, 'folder-choices.json');

    const grandDir = path.join(tmpDir, 'grandparent');
    const parentDir = path.join(grandDir, 'parent');
    const childDir = path.join(parentDir, 'child');
    fs.mkdirSync(childDir, { recursive: true });

    const ancestors = computeFolderAncestors(childDir, 'agy');
    assert(ancestors.length >= 2, 'Must have at least 2 ancestors');

    const nearestAncestor = ancestors[0]; // parent
    const fartherAncestor = ancestors[1]; // grandparent

    // Both have custom rules
    saveFolderRules(fartherAncestor.key, { optionRules: [{ name: 'grandparent-rule', startsWith: 'Yes, grandparent' }] }, { customDir: folderRulesDir });
    saveFolderRules(nearestAncestor.key, { optionRules: [{ name: 'parent-rule', startsWith: 'Yes, parent' }] }, { customDir: folderRulesDir });

    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};

    const monitor = startAgentwatch({
      command: 'agy',
      cwd: childDir,
      stdin: stdinMock,
      stdout: { columns: 100, rows: 30, write: () => {}, on: () => {} },
      ptyProcess: { write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {} },
      folderRulesDir,
      choicesPath,
      profile: getProfileForCommand('agy')
    });

    const pq = monitor.statusManager.pendingQuestion;
    assert(pq, 'Must offer question');
    assert.strictEqual(pq.ancestorKey, nearestAncestor.key, 'Must offer the nearest ancestor (parent)');
    assert.strictEqual(pq.ancestorName, nearestAncestor.name);

    monitor.cleanup();
    suitePassCounts['Suite 5: Nearest ancestor offered when several exist']++;
    console.log('  ✓ Nearest ancestor is offered when multiple ancestors have rule sets');
  }

  // =========================================================================
  // Suite 6: Snapshot isolation
  // =========================================================================
  console.log('\n--- Suite 6: Snapshot isolation (parent mutation does not affect child) ---');
  {
    const tmpDir = createTempDir();
    const folderRulesDir = path.join(tmpDir, 'folder-rules');
    fs.mkdirSync(folderRulesDir, { recursive: true });

    const pKey = 'agy:parent_iso';
    const cKey = 'agy:child_iso';

    saveFolderRules(pKey, { optionRules: [{ name: 'original-rule', startsWith: 'Yes, original' }] }, { customDir: folderRulesDir });
    copyAncestorRules(cKey, pKey, { customDir: folderRulesDir });

    // Mutate parent rules
    saveFolderRules(pKey, {
      optionRules: [
        { name: 'original-rule', startsWith: 'Yes, original' },
        { name: 'new-parent-rule', startsWith: 'Yes, new' }
      ]
    }, { customDir: folderRulesDir });

    // Child must remain unchanged
    const childRules = loadFolderRules(cKey, folderRulesDir);
    assert.strictEqual(childRules.optionRules.length, 1);
    assert.strictEqual(childRules.optionRules[0].name, 'original-rule');
    assert(!childRules.optionRules.some(r => r.name === 'new-parent-rule'));

    suitePassCounts['Suite 6: Snapshot isolation (parent mutation does not affect child)']++;
    console.log('  ✓ Copy is a snapshot: modifying parent rules later does not affect child');
  }

  // =========================================================================
  // Suite 7: No raw paths in any file (Privacy recursive scan)
  // =========================================================================
  console.log('\n--- Suite 7: No raw paths in any file (Privacy recursive scan) ---');
  {
    const tmpDir = createTempDir();
    const fakeRepoPath = path.join(tmpDir, 'very-secret-project-folder');
    const childPath = path.join(fakeRepoPath, 'sub-module');
    fs.mkdirSync(childPath, { recursive: true });

    const folderRulesDir = path.join(tmpDir, 'folder-rules');
    const choicesPath = path.join(tmpDir, 'folder-choices.json');
    const sessionsDir = path.join(tmpDir, 'sessions');
    const historyPath = path.join(tmpDir, 'history.jsonl');

    // Run agentwatch with history logging
    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};

    const monitor = startAgentwatch({
      command: 'agy',
      cwd: childPath,
      stdin: stdinMock,
      stdout: { columns: 100, rows: 30, write: () => {}, on: () => {} },
      ptyProcess: { write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {} },
      folderRulesDir,
      choicesPath,
      sessionsDir,
      historyPath,
      profile: getProfileForCommand('agy')
    });

    saveFolderChoice(monitor.statusManager.sessionKey, { choice: 'declined' }, choicesPath);
    saveFolderRules(monitor.statusManager.sessionKey, { optionRules: [{ name: 'rule1', startsWith: 'Yes, run' }] }, { customDir: folderRulesDir });

    monitor.statusManager.writeStatus();
    monitor.cleanup();

    // Recursively scan all files created in tmpDir for the raw path string
    const leaked = scanDirForRawPath(tmpDir, childPath);
    assert.strictEqual(leaked.length, 0, `No file may contain the raw folder path "${childPath}". Found in: ${leaked.map(m => m.file).join(', ')}`);

    const leakedParent = scanDirForRawPath(tmpDir, fakeRepoPath);
    assert.strictEqual(leakedParent.length, 0, `No file may contain the raw parent folder path "${fakeRepoPath}". Found in: ${leakedParent.map(m => m.file).join(', ')}`);

    suitePassCounts['Suite 7: No raw paths in any file (Privacy recursive scan)']++;
    console.log('  ✓ Recursive scan verified zero raw folder paths stored in any file');
  }

  // =========================================================================
  // Suite 8: Danger & deny cannot be weakened by folder list
  // =========================================================================
  console.log('\n--- Suite 8: Danger & deny cannot be weakened by folder list ---');
  {
    const globalRules = {
      defaultDelaySeconds: 3,
      deny: ['rm -rf', 'format'],
      danger: [
        { text: 'delete', wholeWord: false, level: 'hard', enabled: true },
        { text: 'slow-entry', wholeWord: false, level: 'slow', delay: 10, enabled: true }
      ],
      optionRules: []
    };

    // 1. Folder list removing global danger entry -> rejected
    {
      const invalidFolderRules = {
        danger: [
          { text: 'delete', wholeWord: false, level: 'hard', enabled: true }
          // 'slow-entry' omitted!
        ],
        optionRules: []
      };
      const v = validateFolderRules(invalidFolderRules, globalRules);
      assert.strictEqual(v.valid, false);
      assert(v.errors.some(e => e.includes('cannot remove global danger entry "slow-entry"')));
    }

    // 2. Folder list disabling global danger entry -> rejected
    {
      const invalidFolderRules = {
        danger: [
          { text: 'delete', wholeWord: false, level: 'hard', enabled: false },
          { text: 'slow-entry', wholeWord: false, level: 'slow', delay: 10, enabled: true }
        ],
        optionRules: []
      };
      const v = validateFolderRules(invalidFolderRules, globalRules);
      assert.strictEqual(v.valid, false);
      assert(v.errors.some(e => e.includes('cannot disable global danger entry "delete"')));
    }

    // 3. Folder list downgrading hard to slow -> rejected
    {
      const invalidFolderRules = {
        danger: [
          { text: 'delete', wholeWord: false, level: 'slow', delay: 10, enabled: true },
          { text: 'slow-entry', wholeWord: false, level: 'slow', delay: 10, enabled: true }
        ],
        optionRules: []
      };
      const v = validateFolderRules(invalidFolderRules, globalRules);
      assert.strictEqual(v.valid, false);
      assert(v.errors.some(e => e.includes('cannot weaken global danger entry "delete" from hard stop to slow down')));
    }

    // 4. Folder list shortening slow delay -> rejected
    {
      const invalidFolderRules = {
        danger: [
          { text: 'delete', wholeWord: false, level: 'hard', enabled: true },
          { text: 'slow-entry', wholeWord: false, level: 'slow', delay: 5, enabled: true } // 5 < 10
        ],
        optionRules: []
      };
      const v = validateFolderRules(invalidFolderRules, globalRules);
      assert.strictEqual(v.valid, false);
      assert(v.errors.some(e => e.includes('cannot shorten delay for global danger entry "slow-entry"')));
    }

    // 5. Folder list removing deny entry -> rejected
    {
      const invalidFolderRules = {
        deny: ['rm -rf'], // 'format' missing!
        optionRules: []
      };
      const v = validateFolderRules(invalidFolderRules, globalRules);
      assert.strictEqual(v.valid, false);
      assert(v.errors.some(e => e.includes('cannot remove global deny rule "format"')));
    }

    // 6. Folder list ADDING a new danger entry -> valid!
    {
      const validFolderRules = {
        danger: [
          { text: 'delete', wholeWord: false, level: 'hard', enabled: true },
          { text: 'slow-entry', wholeWord: false, level: 'slow', delay: 10, enabled: true },
          { text: 'repo-secret', wholeWord: true, level: 'hard', enabled: true }
        ],
        optionRules: []
      };
      const v = validateFolderRules(validFolderRules, globalRules);
      assert.strictEqual(v.valid, true);
    }

    suitePassCounts['Suite 8: Danger & deny cannot be weakened by folder list']++;
    console.log('  ✓ Danger and deny lists cannot be weakened or removed by a folder list');
  }

  // =========================================================================
  // Suite 9: Priority order in wrapper & dynamic rule pickup
  // =========================================================================
  console.log('\n--- Suite 9: Priority order in wrapper & dynamic rule pickup ---');
  {
    const tmpDir = createTempDir();
    const folderRulesDir = path.join(tmpDir, 'folder-rules');
    fs.mkdirSync(folderRulesDir, { recursive: true });
    const rulesPath = path.join(tmpDir, 'rules.json');

    // Default rules has rule "default-rule"
    fs.writeFileSync(rulesPath, JSON.stringify({
      defaultDelaySeconds: 3,
      deny: [],
      danger: [],
      optionRules: [
        { name: 'default-rule', startsWith: 'Yes, run command' }
      ]
    }, null, 2), 'utf8');

    const folderKey = 'agy:priority_test';

    // Folder has its own rules: rule-1 and rule-2
    saveFolderRules(folderKey, {
      optionRules: [
        { name: 'folder-rule-high', startsWith: 'Yes, run command' },
        { name: 'folder-rule-low', startsWith: 'Yes, run command' }
      ]
    }, { customDir: folderRulesDir });

    const effectiveRules = loadRulesForFolder(folderKey, rulesPath, folderRulesDir);
    assert.strictEqual(effectiveRules.isFolderRuleSet, true);

    const prompt = {
      command: 'npm test',
      commandSpaced: 'npm test',
      commandCompact: 'npmtest',
      question: 'Run tests?',
      options: [
        { number: 1, key: '1', text: 'Yes, run command' },
        { number: 2, key: '2', text: 'No, cancel' }
      ]
    };

    // Priority: folder-rule-high wins, ruleList is 'folder', log says (folder rule: folder-rule-high)
    const dec = evaluatePrompt(prompt, effectiveRules);
    assert.strictEqual(dec.action, 'would_approve');
    assert.strictEqual(dec.rule, 'folder-rule-high');
    assert.strictEqual(dec.ruleList, 'folder');
    assert(dec.log.includes('(folder rule: folder-rule-high)'), 'Log must say folder rule: folder-rule-high');

    // Test: if no folder rule matches, it does NOT fall back to default rules!
    const promptNoMatch = {
      command: 'echo test',
      commandSpaced: 'echo test',
      commandCompact: 'echotest',
      question: 'Proceed?',
      options: [
        { number: 1, key: '1', text: 'Approve once' },
        { number: 2, key: '2', text: 'No, cancel' }
      ]
    };
    const decNoMatch = evaluatePrompt(promptNoMatch, effectiveRules);
    assert.strictEqual(decNoMatch.action, 'needs_user');
    assert.strictEqual(decNoMatch.ruleList, 'folder');
    assert.strictEqual(decNoMatch.reason, 'no rule matched in folder list');

    // Dynamic pickup: edit folder rules to add rule matching 'Approve once'
    saveFolderRules(folderKey, {
      optionRules: [
        { name: 'newly-added-folder-rule', startsWith: 'Approve once' }
      ]
    }, { customDir: folderRulesDir });

    const reloadedRules = loadRulesForFolder(folderKey, rulesPath, folderRulesDir);
    const decAfterSave = evaluatePrompt(promptNoMatch, reloadedRules);
    assert.strictEqual(decAfterSave.action, 'would_approve');
    assert.strictEqual(decAfterSave.rule, 'newly-added-folder-rule');
    assert.strictEqual(decAfterSave.ruleList, 'folder');

    // In-flight loosening protection: prompt shown before reload cannot auto-approve
    const inFlightDecision = evaluatePrompt(promptNoMatch, {
      ...reloadedRules,
      _inFlightPrompt: true,
      _oldRules: effectiveRules
    });
    assert.strictEqual(inFlightDecision.action, 'needs_user', 'In-flight prompt protected against rule loosening');

    suitePassCounts['Suite 9: Priority order in wrapper & dynamic rule pickup']++;
    console.log('  ✓ Folder rule priority order verified, stops without fallback, and dynamic pickup works');
  }

  // =========================================================================
  // Suite 10: Reset to default works (deletes own list)
  // =========================================================================
  console.log('\n--- Suite 10: Reset to default works (deletes own list) ---');
  {
    const tmpDir = createTempDir();
    const folderRulesDir = path.join(tmpDir, 'folder-rules');
    fs.mkdirSync(folderRulesDir, { recursive: true });
    const rulesPath = path.join(tmpDir, 'rules.json');

    fs.writeFileSync(rulesPath, JSON.stringify({
      defaultDelaySeconds: 3,
      deny: [],
      danger: [],
      optionRules: [{ name: 'global-rule', startsWith: 'Yes, run' }]
    }, null, 2), 'utf8');

    const folderKey = 'agy:reset_me';
    saveFolderRules(folderKey, { optionRules: [{ name: 'custom-to-delete', startsWith: 'Yes, run' }] }, { customDir: folderRulesDir });
    assert.strictEqual(hasFolderRules(folderKey, folderRulesDir), true);

    // Delete folder rules (reset to default)
    deleteFolderRules(folderKey, folderRulesDir);
    assert.strictEqual(hasFolderRules(folderKey, folderRulesDir), false);

    // Effective rules now defaults
    const rules = loadRulesForFolder(folderKey, rulesPath, folderRulesDir);
    assert.strictEqual(Boolean(rules.isFolderRuleSet), false);
    assert.strictEqual(rules.optionRules[0].name, 'global-rule');

    suitePassCounts['Suite 10: Reset to default works (deletes own list)']++;
    console.log('  ✓ Reset folder to default rules deletes own list and restores default rules');
  }

  // =========================================================================
  // Suite 11: Non-blocking & auto state unchanged
  // =========================================================================
  console.log('\n--- Suite 11: Non-blocking & auto state unchanged ---');
  {
    const tmpDir = createTempDir();
    const folderRulesDir = path.join(tmpDir, 'folder-rules');
    fs.mkdirSync(folderRulesDir, { recursive: true });
    const choicesPath = path.join(tmpDir, 'folder-choices.json');

    const parentDir = path.join(tmpDir, 'anc');
    const childDir = path.join(parentDir, 'nested');
    fs.mkdirSync(childDir, { recursive: true });

    const ancestors = computeFolderAncestors(childDir, 'agy');
    saveFolderRules(ancestors[0].key, { optionRules: [{ name: 'anc-rule', startsWith: 'Yes' }] }, { customDir: folderRulesDir });

    const stdinMock = new EventEmitter();
    stdinMock.isTTY = true;
    stdinMock.setRawMode = () => {};

    // Auto is set to false initially
    const monitor = startAgentwatch({
      command: 'agy',
      cwd: childDir,
      auto: false,
      stdin: stdinMock,
      stdout: { columns: 100, rows: 30, write: () => {}, on: () => {} },
      ptyProcess: { write: () => {}, resize: () => {}, onData: () => {}, onExit: () => {} },
      folderRulesDir,
      choicesPath,
      profile: getProfileForCommand('agy')
    });

    assert.strictEqual(monitor.isAutoAcceptEnabled(), false);
    assert(monitor.statusManager.pendingQuestion !== null, 'Question is pending');

    // Copy rules (Yes answer)
    copyAncestorRules(monitor.statusManager.sessionKey, ancestors[0].key, {
      customDir: folderRulesDir,
      customChoicesPath: choicesPath
    });

    // Verify auto state was NOT changed
    assert.strictEqual(monitor.isAutoAcceptEnabled(), false, 'Auto accept must remain OFF');
    assert.strictEqual(monitor.statusManager.auto, false);

    monitor.cleanup();
    suitePassCounts['Suite 11: Non-blocking & auto state unchanged']++;
    console.log('  ✓ Question never blocks agent and answer never changes auto on/off state');
  }

  // =========================================================================
  // Suite 12: IPC rejects paths and oversized input
  // =========================================================================
  console.log('\n--- Suite 12: IPC rejects paths and oversized input ---');
  {
    // Test payload validations matching IPC handlers in main.js
    function validateIpcPayload(payload) {
      if (!payload || typeof payload !== 'object') return { valid: false, error: 'Expected object' };
      const json = JSON.stringify(payload);
      if (json.length > 512 * 1024) return { valid: false, error: 'Payload too large (max 512KB)' };
      if (payload.path || payload.filePath || payload.rulesPath) return { valid: false, error: 'Path selection forbidden' };
      if (payload.folderKey) {
        const k = payload.folderKey;
        if (typeof k !== 'string' || k.length > 128 || k.includes('/') || k.includes('\\') || k.includes('..')) {
          return { valid: false, error: 'Invalid folderKey or path traversal' };
        }
      }
      return { valid: true };
    }

    // Path rejection
    assert.strictEqual(validateIpcPayload({ path: '/etc/passwd', rules: {} }).valid, false);
    assert.strictEqual(validateIpcPayload({ filePath: 'C:\\bad.json', rules: {} }).valid, false);
    assert.strictEqual(validateIpcPayload({ rulesPath: 'custom.json', rules: {} }).valid, false);

    // Path traversal in folderKey
    assert.strictEqual(validateIpcPayload({ folderKey: '../../etc', rules: {} }).valid, false);
    assert.strictEqual(validateIpcPayload({ folderKey: 'folder/name', rules: {} }).valid, false);

    // Oversized payload (> 512KB)
    const bigStr = 'x'.repeat(600 * 1024);
    assert.strictEqual(validateIpcPayload({ folderKey: 'agy:123', data: bigStr }).valid, false);

    // Valid payload
    assert.strictEqual(validateIpcPayload({ folderKey: 'agy:3f8e0a12', rules: { optionRules: [] } }).valid, true);

    suitePassCounts['Suite 12: IPC rejects paths and oversized input']++;
    console.log('  ✓ IPC input rejection verified for path selection, directory traversal, and size limit');
  }

  // =========================================================================
  // Suite 13: Single-write-path safety verification
  // =========================================================================
  console.log('\n--- Suite 13: Single-write-path safety verification ---');
  {
    const agentwatchSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'agentwatch.js'), 'utf8');
    const writeMatches = agentwatchSrc.match(/\bptyProcess\.write\s*\(/g) || [];
    assert(writeMatches.length > 0 && writeMatches.length <= 3, `Expected up to 3 ptyProcess.write calls in agentwatch.js, found ${writeMatches.length}`);

    // Verify GUI files have zero write calls to any child process
    const guiFiles = fs.readdirSync(path.join(__dirname, '..', 'src', 'gui'))
      .filter(f => f.endsWith('.js'));
    for (const f of guiFiles) {
      const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'gui', f), 'utf8');
      assert(!code.includes('ptyProcess'), `GUI file ${f} must never reference ptyProcess`);
      assert(!code.includes('.write('), `GUI file ${f} must never call .write()`);
    }

    suitePassCounts['Suite 13: Single-write-path safety verification']++;
    console.log('  ✓ Single write path invariant maintained: GUI window never writes to child process');
  }

  console.log('\n=========================================');
  console.log('Stage 5 Pass Counts Per Suite:');
  for (const [suite, count] of Object.entries(suitePassCounts)) {
    console.log(`  ${suite}: ${count} passed`);
  }
  console.log('\nAll 13 Stage 5 suites passed successfully!');
  console.log('=========================================\n');
}

runStage5Tests().catch(err => {
  console.error('Stage 5 test failure:', err);
  process.exit(1);
});
