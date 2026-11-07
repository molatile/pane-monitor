const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const {
  extractPromptFromScreen,
  isPromptLive,
  isFooterLine
} = require('../src/parser');

const {
  evaluatePrompt,
  loadRules,
  matchesOptionRule,
  normalizeOptionText,
  normalizeRuleText,
  explainOptionMatches,
  isPersistOption,
  checkDangerMatch,
  detectLoosening,
  DEFAULT_DANGER_LIST
} = require('../src/rules');

const { getProfileForCommand } = require('../src/profile');
const { formatDecision } = require('../src/status');
const { maskText } = require('../src/masker');

const suitePassCounts = {
  'Suite 1: Prompt Recognition for Example 1 & Example 2': 0,
  'Suite 2: Truncated-Command Policy & Rule Evaluation': 0,
  'Suite 3: Script Danger Words (Hard & Slow Countdown)': 0,
  'Suite 4: Column 0 Code Continuations & Non-Prompt Rejection': 0,
  'Suite 5: Dashboard and Window Specific Row Reasons': 0,
  'Suite 6: Loosening Detection & Typed Word TRUNCATED': 0,
  'Suite 7: Single-Write-Path Safety & Keystroke Invariants': 0,
  'Suite 8: Masking & Privacy Safety on Truncated Screens': 0
};

async function runStage9Tests() {
  console.log('Running agentwatch Stage 9 test suite: Long Multi-Line Commands & Truncation Guard...\n');

  const agyProfile = getProfileForCommand('agy');
  assert(agyProfile, 'Profile for agy must exist');

  // Exact screen from Example 1
  const example1Screen = [
    "node -e '",
    '  const fs = require("fs");',
    '  const list = JSON.parse(fs.readFileSync("reports/all-verified-matches.json", "utf8"));',
    '  const filtered = list.filter(item => { ...',
    '',
    'Run this command?',
    '> 1. Yes, run command',
    "  2. Yes, and always allow in this conversation for commands that start with 'node -e '",
    'const fs = require("fs");',
    'const list = JSON.parse(fs.readFileSync("rep...\'',
    "  3. Yes, and always allow for commands that start with 'node -e '",
    'const fs = require("fs");',
    'const list = JSON.parse(fs.readFileSync("rep...\' (Persist to settings.json)',
    '  4. No, cancel',
    '',
    '    /   Navigate     tab Amend     ctrl+g edit/expand command',
    'esc to cancel                         Gemini 3.8 Flash     high'
  ];

  // Exact screen from Example 2
  const example2Screen = [
    'Run this command?',
    '> 1. Yes, run command',
    '  2. Yes, and always allow in this conversation for commands that start with \'node -e "',
    "const fs = require('fs');",
    "const path = require('path');",
    '',
    "function scan...'",
    '  3. Yes, and always allow for commands that start with \'node -e "',
    "const fs = require('fs');",
    "const path = require('path');",
    '',
    "function scan...' (Persist to settings.json)",
    '  4. No, cancel',
    '',
    '    /   Navigate     tab Amend     ctrl+g edit/expand command',
    'esc to cancel                        accept-edits      Gemini 3.8 Flash     high'
  ];

  // =========================================================================
  // Suite 1: Prompt Recognition for Example 1 & Example 2
  // =========================================================================
  console.log('--- Suite 1: Prompt Recognition for Example 1 & Example 2 ---');
  {
    // 1.1: Example 1 recognized as command prompt (NOT unrecognized)
    const p1 = extractPromptFromScreen(example1Screen, agyProfile);
    assert(p1 !== null, 'Example 1 must be parsed as a prompt');
    assert.strictEqual(p1.promptType, 'command', 'Example 1 must be classified as promptType: command');
    assert.notStrictEqual(p1.promptType, 'unrecognized', 'Example 1 must not be classified as unrecognized');
    suitePassCounts['Suite 1: Prompt Recognition for Example 1 & Example 2']++;

    // 1.2: Example 1 command complete is false due to cut off ... and {...
    assert.strictEqual(p1.commandComplete, false, 'Example 1 commandComplete must be false');
    assert(p1.commandSpaced.includes('node -e'), 'Example 1 commandSpaced should include command prefix');
    suitePassCounts['Suite 1: Prompt Recognition for Example 1 & Example 2']++;

    // 1.3: Example 1 options count and continuations
    assert.strictEqual(p1.options.length, 4, 'Example 1 must have exactly 4 numbered options');
    assert.strictEqual(p1.options[0].text, 'Yes, run command');
    assert(p1.options[1].text.includes('const fs = require("fs");'), 'Option 2 continuation lines must belong to option 2');
    assert(p1.options[2].text.includes('(Persist to settings.json)'), 'Option 3 continuation must include persist marker');
    assert.strictEqual(p1.options[3].text, 'No, cancel');
    suitePassCounts['Suite 1: Prompt Recognition for Example 1 & Example 2']++;

    // 1.4: Example 1 isPromptLive is true
    assert.strictEqual(isPromptLive(p1, example1Screen, agyProfile), true, 'Example 1 must be live with footer and > marker');
    suitePassCounts['Suite 1: Prompt Recognition for Example 1 & Example 2']++;

    // 1.5: Example 2 recognized as command prompt without "Requesting permission for:" block
    const p2 = extractPromptFromScreen(example2Screen, agyProfile);
    assert(p2 !== null, 'Example 2 must be parsed as a prompt');
    assert.strictEqual(p2.promptType, 'command', 'Example 2 must be classified as promptType: command');
    assert.notStrictEqual(p2.promptType, 'unrecognized', 'Example 2 must not be classified as unrecognized');
    suitePassCounts['Suite 1: Prompt Recognition for Example 1 & Example 2']++;

    // 1.6: Example 2 extracts command from options and commandComplete is false
    assert.strictEqual(p2.commandComplete, false, 'Example 2 commandComplete must be false');
    assert(p2.commandSpaced.includes('node -e "'), 'Example 2 command must be extracted from options');
    suitePassCounts['Suite 1: Prompt Recognition for Example 1 & Example 2']++;

    // 1.7: Example 2 options count and blank lines in option continuation
    assert.strictEqual(p2.options.length, 4, 'Example 2 must have exactly 4 numbered options');
    assert(p2.options[1].text.includes('function scan'), 'Option 2 continuation must include text after blank line');
    assert.strictEqual(p2.options[3].text, 'No, cancel');
    suitePassCounts['Suite 1: Prompt Recognition for Example 1 & Example 2']++;

    // 1.8: Example 2 isPromptLive is true with extra status words in footer (accept-edits, model)
    assert.strictEqual(isPromptLive(p2, example2Screen, agyProfile), true, 'Example 2 must be live with accept-edits footer');
    suitePassCounts['Suite 1: Prompt Recognition for Example 1 & Example 2']++;

    console.log('  ✓ Example 1 and Example 2 recognized as live command prompts with 4 options and commandComplete: false');
  }

  // =========================================================================
  // Suite 2: Truncated-Command Policy & Rule Evaluation
  // =========================================================================
  console.log('\n--- Suite 2: Truncated-Command Policy & Rule Evaluation ---');
  {
    const p1 = extractPromptFromScreen(example1Screen, agyProfile);
    const p2 = extractPromptFromScreen(example2Screen, agyProfile);

    const safeRuleWithoutTruncated = {
      name: 'node-always-conversation',
      startsWith: "Yes, and always allow in this conversation for commands that start with 'node -e",
      allowTruncatedCommand: false,
      enabled: true
    };

    // 2.1: Example 1 with allowTruncatedCommand: false presses nothing
    const dec1 = evaluatePrompt(p1, { optionRules: [safeRuleWithoutTruncated] });
    assert.strictEqual(dec1.action, 'needs_user', 'Must not press option when command is cut off and allowTruncatedCommand is false');
    assert.strictEqual(dec1.reason, "the command is cut off on screen, so it can't be fully checked");
    assert.strictEqual(dec1.optionKey, undefined, 'Must not specify any option key');
    suitePassCounts['Suite 2: Truncated-Command Policy & Rule Evaluation']++;

    // 2.2: Example 2 with allowTruncatedCommand: false presses nothing
    const dec2 = evaluatePrompt(p2, { optionRules: [safeRuleWithoutTruncated] });
    assert.strictEqual(dec2.action, 'needs_user', 'Must not press option when command is cut off and allowTruncatedCommand is false');
    assert.strictEqual(dec2.reason, "the command is cut off on screen, so it can't be fully checked");
    assert.strictEqual(dec2.optionKey, undefined, 'Must not specify any option key');
    suitePassCounts['Suite 2: Truncated-Command Policy & Rule Evaluation']++;

    // 2.3: Example 1 with allowTruncatedCommand: true approves option 2
    const safeRuleWithTruncated = {
      name: 'node-always-conversation-trunc',
      startsWith: "Yes, and always allow in this conversation for commands that start with 'node -e",
      allowTruncatedCommand: true,
      enabled: true
    };
    const dec1Trunc = evaluatePrompt(p1, { optionRules: [safeRuleWithTruncated] });
    assert.strictEqual(dec1Trunc.action, 'would_approve', 'Must approve when allowTruncatedCommand is true');
    assert.strictEqual(dec1Trunc.optionKey, '2', 'Must select Option 2');
    suitePassCounts['Suite 2: Truncated-Command Policy & Rule Evaluation']++;

    // 2.4: Example 2 with allowTruncatedCommand: true approves option 2
    const dec2Trunc = evaluatePrompt(p2, { optionRules: [safeRuleWithTruncated] });
    assert.strictEqual(dec2Trunc.action, 'would_approve', 'Must approve when allowTruncatedCommand is true');
    assert.strictEqual(dec2Trunc.optionKey, '2', 'Must select Option 2');
    suitePassCounts['Suite 2: Truncated-Command Policy & Rule Evaluation']++;

    // 2.5: explainOptionMatches explains cut-off refusal
    const explanation = explainOptionMatches(p1, { optionRules: [safeRuleWithoutTruncated] });
    assert(explanation.length > 0);
    assert.strictEqual(explanation[1].matched, false);
    assert(explanation[1].reasons.some(r => r.includes('cut off on screen')));
    suitePassCounts['Suite 2: Truncated-Command Policy & Rule Evaluation']++;

    console.log('  ✓ Truncated command policy correctly halts execution without flag and approves option 2 with flag');
  }

  // =========================================================================
  // Suite 3: Script Danger Words (Hard & Slow Countdown)
  // =========================================================================
  console.log('\n--- Suite 3: Script Danger Words (Hard & Slow Countdown) ---');
  {
    const ruleWithTruncated = {
      name: 'node-allow-trunc',
      startsWith: "Yes, and always allow in this conversation for commands that start with 'node -e",
      allowTruncatedCommand: true,
      enabled: true
    };

    // 3.1: Seed defaults include the 5 hard and 4 slow danger entries
    const hardScriptEntries = ['rmSync', 'child_process', 'execSync', 'spawn', 'eval('];
    const slowScriptEntries = ['writeFileSync', 'appendFileSync', 'renameSync', 'copyFileSync'];

    for (const word of hardScriptEntries) {
      const match = DEFAULT_DANGER_LIST.find(e => e.text === word && e.level === 'hard');
      assert(match, `Seed danger list must include hard entry '${word}'`);
    }
    suitePassCounts['Suite 3: Script Danger Words (Hard & Slow Countdown)']++;

    for (const word of slowScriptEntries) {
      const match = DEFAULT_DANGER_LIST.find(e => e.text === word && e.level === 'slow' && e.delay === 10);
      assert(match, `Seed danger list must include slow entry '${word}' with delay 10s`);
    }
    suitePassCounts['Suite 3: Script Danger Words (Hard & Slow Countdown)']++;

    // 3.2: Hard danger word (child_process) in visible text halts execution and hides rule approval
    const dangerHardScreen = [
      "node -e '",
      '  const { execSync } = require("child_process");',
      '  execSync("echo hi"); ...',
      '',
      'Run this command?',
      '> 1. Yes, run command',
      "  2. Yes, and always allow in this conversation for commands that start with 'node -e '",
      '  3. Yes, and always allow for commands that start with \'node -e \' (Persist to settings.json)',
      '  4. No, cancel',
      '',
      '    /   Navigate     tab Amend     ctrl+g edit/expand command',
      'esc to cancel                         Gemini 3.8 Flash     high'
    ];
    const pHard = extractPromptFromScreen(dangerHardScreen, agyProfile);
    const decHard = evaluatePrompt(pHard, { optionRules: [ruleWithTruncated] });
    assert.strictEqual(decHard.action, 'needs_user', 'Hard danger word must stop execution');
    assert.strictEqual(decHard.danger, true, 'danger flag must be true');
    assert(decHard.reason.includes('DANGER: matched'), `Reason must indicate danger match, got: ${decHard.reason}`);
    suitePassCounts['Suite 3: Script Danger Words (Hard & Slow Countdown)']++;

    // 3.3: Hard danger word (rmSync) in visible option text halts execution
    const dangerRmSyncScreen = [
      'Run this command?',
      '> 1. Yes, run command',
      "  2. Yes, and always allow in this conversation for commands that start with 'node -e \"const fs=require(\\'fs\\'); fs.rmSync(...)'",
      '  3. Yes, and always allow for commands that start with \'node -e \' (Persist to settings.json)',
      '  4. No, cancel',
      '',
      '    /   Navigate     tab Amend     ctrl+g edit/expand command',
      'esc to cancel                         Gemini 3.8 Flash     high'
    ];
    const pRm = extractPromptFromScreen(dangerRmSyncScreen, agyProfile);
    const decRm = evaluatePrompt(pRm, { optionRules: [ruleWithTruncated] });
    assert.strictEqual(decRm.action, 'needs_user');
    assert.strictEqual(decRm.danger, true);
    assert(decRm.reason.includes('rmSync'));
    suitePassCounts['Suite 3: Script Danger Words (Hard & Slow Countdown)']++;

    // 3.4: Slow danger word (writeFileSync) lengthens countdown to 10s and is vetoable
    const slowDangerScreen = [
      "node -e '",
      '  const fs = require("fs");',
      '  fs.writeFileSync("output.txt", "done"); ...',
      '',
      'Run this command?',
      '> 1. Yes, run command',
      "  2. Yes, and always allow in this conversation for commands that start with 'node -e '",
      '  3. Yes, and always allow for commands that start with \'node -e \' (Persist to settings.json)',
      '  4. No, cancel',
      '',
      '    /   Navigate     tab Amend     ctrl+g edit/expand command',
      'esc to cancel                         Gemini 3.8 Flash     high'
    ];
    const pSlow = extractPromptFromScreen(slowDangerScreen, agyProfile);
    const decSlow = evaluatePrompt(pSlow, { optionRules: [ruleWithTruncated] });
    assert.strictEqual(decSlow.action, 'would_approve', 'Slow danger word allows approval with delay');
    assert.strictEqual(decSlow.optionKey, '2');
    assert.strictEqual(decSlow.delay, 10, 'Slow danger word must enforce 10s delay');
    assert.strictEqual(decSlow.slowDanger, 'writeFileSync');
    suitePassCounts['Suite 3: Script Danger Words (Hard & Slow Countdown)']++;

    // 3.5: Compact matching catches split danger words like c h i l d _ p r o c e s s
    const splitPrompt = {
      promptType: 'command',
      commandSpaced: 'node -e "c h i l d _ p r o c e s s . spawn()"',
      commandCompact: 'node-e"child_process.spawn()"',
      question: 'Run this command?',
      options: [
        { key: '1', number: 1, text: 'Yes, run command' },
        { key: '2', number: 2, text: 'No, cancel' }
      ]
    };
    const splitCheck = checkDangerMatch(splitPrompt, DEFAULT_DANGER_LIST);
    assert(splitCheck !== null, 'Split danger text must match via compact matching');
    suitePassCounts['Suite 3: Script Danger Words (Hard & Slow Countdown)']++;

    console.log('  ✓ Hard script danger words stop execution; slow danger words enforce 10s delay');
  }

  // =========================================================================
  // Suite 4: Column 0 Code Continuations & Non-Prompt Rejection
  // =========================================================================
  console.log('\n--- Suite 4: Column 0 Code Continuations & Non-Prompt Rejection ---');
  {
    // 4.1: Code lines starting with numbers or identifiers at col 0 inside options do not create fake options
    const codeWithNumbersScreen = [
      'Run this command?',
      '> 1. Yes, run command',
      "  2. Yes, and always allow in this conversation for commands that start with 'node -e \"",
      '123.456 + 789; // number at col 0',
      'const x = 1;',
      'return x;',
      "function scan...' ",
      '  3. Yes, and always allow for commands that start with \'node -e \' (Persist to settings.json)',
      '  4. No, cancel',
      '',
      '    /   Navigate     tab Amend     ctrl+g edit/expand command',
      'esc to cancel                         Gemini 3.8 Flash     high'
    ];
    const pCode = extractPromptFromScreen(codeWithNumbersScreen, agyProfile);
    assert(pCode !== null);
    assert.strictEqual(pCode.options.length, 4, 'Must have exactly 4 options; code line starting with 123.456 must not create fake option');
    assert(pCode.options[1].text.includes('123.456'), 'Code line must be preserved in option 2');
    suitePassCounts['Suite 4: Column 0 Code Continuations & Non-Prompt Rejection']++;

    // 4.2: Agent reply text with numbered list is never detected as a prompt
    const agentReplyScreen = [
      'I evaluated the results and completed the task.',
      'Here are the details:',
      '  1. Extracted all verified matches from reports/all-verified-matches.json',
      '  2. Filtered items using the predicate',
      '  3. Saved 42 clean matches to the destination folder',
      'Done!'
    ];
    const pReply = extractPromptFromScreen(agentReplyScreen, agyProfile);
    assert.strictEqual(pReply, null, 'Agent reply text with numbered list must not be recognized as a prompt');
    suitePassCounts['Suite 4: Column 0 Code Continuations & Non-Prompt Rejection']++;

    // 4.3: Agent reply ending with a question mark but no prompt markers is not live
    const agentQuestionReply = [
      'The tests passed successfully.',
      'Would you like me to proceed with deployment?',
      '  1. Yes, deploy to staging',
      '  2. No, wait for review'
    ];
    const pQuestion = extractPromptFromScreen(agentQuestionReply, agyProfile);
    const isLive = pQuestion ? isPromptLive(pQuestion, agentQuestionReply, agyProfile) : false;
    assert.strictEqual(isLive, false, 'Agent reply without live prompt markers is not live');
    suitePassCounts['Suite 4: Column 0 Code Continuations & Non-Prompt Rejection']++;

    console.log('  ✓ Column 0 code lines properly attached to parent options; agent replies never parsed as prompts');
  }

  // =========================================================================
  // Suite 5: Dashboard and Window Specific Row Reasons
  // =========================================================================
  console.log('\n--- Suite 5: Dashboard and Window Specific Row Reasons ---');
  {
    // 5.1: Cut-off command formatted decision is specific
    const cutOffDecision = {
      action: 'needs_user',
      reason: "the command is cut off on screen, so it can't be fully checked"
    };
    const rowCutOff = formatDecision(cutOffDecision);
    assert(rowCutOff.includes("the command is cut off on screen, so it can't be fully checked"),
      `Row reason must specify cut off reason, got: ${rowCutOff}`);
    assert(!rowCutOff.includes('unrecognized prompt'), 'Command prompt must not report unrecognized prompt');
    suitePassCounts['Suite 5: Dashboard and Window Specific Row Reasons']++;

    // 5.2: Danger word formatted decision is specific
    const dangerDecision = {
      action: 'needs_user',
      danger: true,
      reason: "DANGER: matched 'rmSync'"
    };
    const rowDanger = formatDecision(dangerDecision);
    assert(rowDanger.includes("DANGER: matched 'rmSync'"), `Row reason must specify danger word, got: ${rowDanger}`);
    assert(!rowDanger.includes('unrecognized prompt'), 'Danger hit must not report unrecognized prompt');
    suitePassCounts['Suite 5: Dashboard and Window Specific Row Reasons']++;

    // 5.3: Tie between options formatted decision is specific
    const tieDecision = {
      action: 'needs_user',
      reason: 'tie between options 1 and 2 (both have 10 chars extra text)'
    };
    const rowTie = formatDecision(tieDecision);
    assert(rowTie.includes('tie between options 1 and 2'), `Row reason must specify tie, got: ${rowTie}`);
    suitePassCounts['Suite 5: Dashboard and Window Specific Row Reasons']++;

    // 5.4: Truly unrecognized prompt formatted decision
    const unrecDecision = {
      action: 'needs_user',
      reason: 'unrecognized prompt'
    };
    const rowUnrec = formatDecision(unrecDecision);
    assert(rowUnrec.includes('unrecognized prompt'), `Truly unrecognized prompt formats as unrecognized prompt, got: ${rowUnrec}`);
    suitePassCounts['Suite 5: Dashboard and Window Specific Row Reasons']++;

    // 5.5: Dashboard rendering shows specific reason and not unrecognized prompt
    const { renderDashboardLines } = require('../src/dashboard');
    const mockSessions = [{
      sessionId: 's-trunc-test',
      sessionKey: 'agy:s-trunc-test',
      displayName: 'test-agent',
      state: 'asking',
      stateAgeMs: 500,
      hasProfile: true,
      prompt: {
        type: 'command',
        label: 'command',
        command: 'node -e "const fs = require(\'fs\'); ..."',
        decision: rowCutOff
      }
    }];
    const dashLines = renderDashboardLines({ sessions: mockSessions, selectedIndex: 0, useColor: false });
    const dashOutput = dashLines.join('\n');
    assert(dashOutput.includes('[command]'), 'Dashboard must display [command]');
    assert(dashOutput.includes("the command is cut off on screen, so it can't be fully checked"), 'Dashboard must show cut off reason');
    assert(!dashOutput.includes('unrecognized prompt'), 'Dashboard must NOT show unrecognized prompt for command prompt');
    suitePassCounts['Suite 5: Dashboard and Window Specific Row Reasons']++;

    console.log('  ✓ Specific row reasons for cut-off command, danger word, tie, and unrecognized prompts verified in dashboard');
  }

  // =========================================================================
  // Suite 6: Loosening Detection & Typed Word TRUNCATED
  // =========================================================================
  console.log('\n--- Suite 6: Loosening Detection & Typed Word TRUNCATED ---');
  {
    const oldRules = {
      optionRules: [
        {
          name: 'rule-node',
          startsWith: 'Yes, allow',
          commandStartsWith: 'node -e',
          allowTruncatedCommand: false,
          allowPersist: false,
          enabled: true
        }
      ]
    };

    // 6.1: Setting allowTruncatedCommand: true triggers loosening
    const newRulesWithTrunc = {
      optionRules: [
        {
          name: 'rule-node',
          startsWith: 'Yes, allow',
          commandStartsWith: 'node -e',
          allowTruncatedCommand: true,
          allowPersist: false,
          enabled: true
        }
      ]
    };
    const looseningTrunc = detectLoosening(oldRules, newRulesWithTrunc);
    assert.strictEqual(looseningTrunc.isLooser, true, 'Enabling allowTruncatedCommand must be detected as loosening');
    assert.strictEqual(looseningTrunc.requiresTruncatedConfirmation, true, 'Must require truncated confirmation');
    assert.strictEqual(looseningTrunc.requiredWord, 'TRUNCATED', 'requiredWord must be TRUNCATED');
    assert(looseningTrunc.items.some(i => i.includes('allows truncated/cut-off commands')), 'Item list must describe truncated command loosening');
    suitePassCounts['Suite 6: Loosening Detection & Typed Word TRUNCATED']++;

    // 6.2: When both allowPersist and allowTruncatedCommand are enabled, PERSIST takes priority
    const newRulesBoth = {
      optionRules: [
        {
          name: 'rule-node',
          startsWith: 'Yes, allow',
          commandStartsWith: 'node -e',
          allowTruncatedCommand: true,
          allowPersist: true,
          enabled: true
        }
      ]
    };
    const looseningBoth = detectLoosening(oldRules, newRulesBoth);
    assert.strictEqual(looseningBoth.isLooser, true);
    assert.strictEqual(looseningBoth.requiresPersistConfirmation, true);
    assert.strictEqual(looseningBoth.requiresTruncatedConfirmation, true);
    assert.strictEqual(looseningBoth.requiredWord, 'PERSIST', 'PERSIST confirmation word must take precedence');
    suitePassCounts['Suite 6: Loosening Detection & Typed Word TRUNCATED']++;

    // 6.3: No loosening when allowTruncatedCommand remains false
    const looseningNone = detectLoosening(oldRules, oldRules);
    assert.strictEqual(looseningNone.isLooser, false);
    assert.strictEqual(looseningNone.requiredWord, null);
    suitePassCounts['Suite 6: Loosening Detection & Typed Word TRUNCATED']++;

    console.log('  ✓ Loosening detector flags allowTruncatedCommand and requires typed confirmation TRUNCATED');
  }

  // =========================================================================
  // Suite 7: Single-Write-Path Safety & Keystroke Invariants
  // =========================================================================
  console.log('\n--- Suite 7: Single-Write-Path Safety & Keystroke Invariants ---');
  {
    // 7.1: Static audit of entire repository: Only sendAutoAnswer in src/agentwatch.js writes to child stdin
    const agentwatchSrc = fs.readFileSync(path.join(__dirname, '../src/agentwatch.js'), 'utf8');
    const guiFiles = fs.readdirSync(path.join(__dirname, '../src/gui')).filter(f => f.endsWith('.js'));

    // GUI must NEVER write to child processes
    for (const f of guiFiles) {
      const code = fs.readFileSync(path.join(__dirname, '../src/gui', f), 'utf8');
      assert(!code.includes('ptyProcess'), `GUI file ${f} must never reference ptyProcess`);
      assert(!code.includes('.write('), `GUI file ${f} must never call .write(`);
    }
    suitePassCounts['Suite 7: Single-Write-Path Safety & Keystroke Invariants']++;

    // 7.2: In src/agentwatch.js, ptyProcess.write is ONLY called inside sendAutoAnswer or stdin forwarder
    const ptyWrites = agentwatchSrc.match(/\bptyProcess\.write\s*\(/g) || [];
    assert(ptyWrites.length > 0 && ptyWrites.length <= 3, `ptyProcess.write must only be called in stdin forwarder or sendAutoAnswer, found ${ptyWrites.length}`);
    assert(agentwatchSrc.includes('function sendAutoAnswer('), 'sendAutoAnswer must be defined');

    // 7.3: Keystroke restrictions: only option number keys are ever written
    // Never send Shift+Tab, Ctrl+G, Tab or any key except an option number
    assert(!agentwatchSrc.includes('\\x07'), 'agentwatch must never send Ctrl+G (\\x07)');
    assert(!agentwatchSrc.includes('\\t'), 'agentwatch must never send Tab (\\t)');
    assert(!agentwatchSrc.includes('\\x1b[Z'), 'agentwatch must never send Shift+Tab (\\x1b[Z)');
    suitePassCounts['Suite 7: Single-Write-Path Safety & Keystroke Invariants']++;

    // 7.4: Persist protection: Option with "Persist to settings.json" is never chosen unless allowPersist is true
    const persistRule = {
      name: 'deny-persist-rule',
      startsWith: 'Yes, and always allow for commands',
      allowPersist: false,
      enabled: true
    };
    const p1 = extractPromptFromScreen(example1Screen, agyProfile);
    const decPersist = evaluatePrompt(p1, { optionRules: [persistRule] });
    assert.notStrictEqual(decPersist.optionKey, '3', 'Option 3 (Persist) must NEVER be auto-approved without allowPersist: true');
    suitePassCounts['Suite 7: Single-Write-Path Safety & Keystroke Invariants']++;

    // 7.5: "No" options are NEVER pressed
    const noRule = {
      name: 'try-no-rule',
      startsWith: 'No, cancel',
      enabled: true
    };
    const decNo = evaluatePrompt(p1, { optionRules: [noRule] });
    assert.strictEqual(decNo.action, 'needs_user', 'Rules matching "No" must be ignored');
    assert.strictEqual(decNo.optionKey, undefined, 'Option 4 ("No, cancel") must NEVER be pressed');
    suitePassCounts['Suite 7: Single-Write-Path Safety & Keystroke Invariants']++;

    console.log('  ✓ Single write path verified, GUI sends zero keys, no forbidden keystrokes, persist & No guards intact');
  }

  // =========================================================================
  // Suite 8: Masking & Privacy Safety on Truncated Screens
  // =========================================================================
  console.log('\n--- Suite 8: Masking & Privacy Safety on Truncated Screens ---');
  {
    // 8.1: Secret tokens in cut off commands or options are masked before disk writes
    const rawSecretCmd = 'node -e "const token=\'ghp_1234567890abcdefghijklmnopqrstuvwxyz\'; ...';
    const maskedCmd = maskText(rawSecretCmd);
    assert(!maskedCmd.includes('ghp_1234567890abcdefghijklmnopqrstuvwxyz'), 'Secret token must be masked');
    assert(maskedCmd.includes('[REDACTED]'), 'Masked token should show [REDACTED]');
    suitePassCounts['Suite 8: Masking & Privacy Safety on Truncated Screens']++;

    // 8.2: Masking preserves benign paths and parameters
    const benignText = 'reports/all-verified-matches.json';
    const maskedBenign = maskText(benignText);
    assert.strictEqual(maskedBenign, benignText, 'Benign file path must be preserved without distortion');
    suitePassCounts['Suite 8: Masking & Privacy Safety on Truncated Screens']++;

    console.log('  ✓ Masking and privacy safety correctly protect secrets in truncated command text');
  }

  // =========================================================================
  // Summary
  // =========================================================================
  console.log('\n=========================================');
  console.log('Stage 9 Pass Counts Per Suite:');
  let totalPasses = 0;
  for (const [suiteName, count] of Object.entries(suitePassCounts)) {
    console.log(`  ${suiteName}: ${count} passed`);
    totalPasses += count;
  }
  console.log(`\nTotal passes: ${totalPasses}`);
  console.log('All Stage 9 suites passed successfully!');
  console.log('=========================================\n');
}

runStage9Tests().catch(err => {
  console.error('Stage 9 test failure:', err);
  process.exit(1);
});
