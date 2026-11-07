const assert = require('assert');
const {
  evaluatePrompt,
  loadRules,
  matchesOptionRule,
  countLeadingMatchingWords,
  normalizeOptionText,
  normalizeRuleText
} = require('../src/rules');

console.log('Running test-option-hierarchy.js tests...\n');

let passCount = 0;
function test(name, fn) {
  try {
    fn();
    passCount++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name} failed:`, err);
    throw err;
  }
}

// 1. countLeadingMatchingWords tests
test('countLeadingMatchingWords accurately counts word matches', () => {
  const r1 = countLeadingMatchingWords('Yes, and always allow in this conversation', '2. Yes, and always allow in this conversation for git commands');
  assert.strictEqual(r1.matchCount, 7);

  const r2 = countLeadingMatchingWords('Yes, run command', '1. Yes, run command now');
  assert.strictEqual(r2.matchCount, 3);

  const r3 = countLeadingMatchingWords('Yes, allow creation', '1. Yes, allow creation of file.txt');
  assert.strictEqual(r3.matchCount, 3);

  const r4 = countLeadingMatchingWords('Yes, accept this change', '1. Yes, accept this change to package.json');
  assert.strictEqual(r4.matchCount, 4);

  const r5 = countLeadingMatchingWords('Yes, accept', '1. Yes, accept this change');
  assert.strictEqual(r5.matchCount, 2);

  const r6 = countLeadingMatchingWords('Yes, and always allow in this conversation', '1. Yes, run command');
  assert.strictEqual(r6.matchCount, 1);
});

// 2. 3-4 or 5 words matching without needing full option text to match
test('3-4 or 5 words matches option without requiring full option or command to match', () => {
  const prompt = {
    promptType: 'command',
    commandSpaced: 'node -e "some very long command with lots of code"',
    question: 'Run this command?',
    options: [
      { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
      {
        key: '2',
        number: 2,
        text: "Yes, and always allow in this conversation for commands that start with 'node -e \"const fs = require(\\'fs\\'); const list = JSON.parse(fs.readFileSync(\\'rep...\\')'",
        classification: 'yes_session'
      },
      {
        key: '3',
        number: 3,
        text: "Yes, and always allow for commands that start with 'node -e \"...' (Persist to settings.json)",
        classification: 'yes_persist'
      },
      { key: '4', number: 4, text: 'No, cancel', classification: 'no' }
    ]
  };

  // Rule with 7 words: "Yes, and always allow in this conversation"
  const ruleSession = {
    name: 'always-in-conversation',
    startsWith: 'Yes, and always allow in this conversation',
    enabled: true,
    allowTruncatedCommand: true
  };
  assert(matchesOptionRule(ruleSession, prompt.options[1], prompt));
  assert(!matchesOptionRule(ruleSession, prompt.options[0], prompt));

  // Rule with 14 words: even if rule text differs slightly after 5 words, it matches
  const ruleLong = {
    name: 'long-rule',
    startsWith: 'Yes, and always allow in this conversation for commands that start with "node -e \'',
    enabled: true,
    allowTruncatedCommand: true
  };
  assert(matchesOptionRule(ruleLong, prompt.options[1], prompt));
});

// 3. Hierarchy: Session/Conversation beats Once in evaluation
test('Hierarchy: always-in-conversation beats run-command when both exist', () => {
  const prompt = {
    promptType: 'command',
    commandSpaced: 'cargo test',
    question: 'Run this command?',
    options: [
      { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
      { key: '2', number: 2, text: 'Yes, and always allow in this conversation for commands that start with \'cargo test\'', classification: 'yes_session' },
      { key: '3', number: 3, text: 'Yes, and always allow for commands that start with \'cargo test\' (Persist to settings.json)', classification: 'yes_persist' },
      { key: '4', number: 4, text: 'No, cancel', classification: 'no' }
    ]
  };

  const rules = {
    optionRules: [
      { name: 'always-in-conversation', startsWith: 'Yes, and always allow in this conversation', enabled: true, allowTruncatedCommand: true },
      { name: 'run-command', startsWith: 'Yes, run command', enabled: true, allowTruncatedCommand: true }
    ]
  };

  const dec = evaluatePrompt(prompt, rules);
  assert.strictEqual(dec.action, 'would_approve');
  assert.strictEqual(dec.optionKey, '2', 'Option 2 (always in conversation) must win following hierarchy');
  assert.strictEqual(dec.rule, 'always-in-conversation');
});

// 4. Hierarchy: When only 2 options exist (no conversation option), once option wins
test('Hierarchy: when only 2 options exist, once option wins', () => {
  const prompt = {
    promptType: 'command',
    commandSpaced: 'npm run custom-script',
    question: 'Run this command?',
    options: [
      { key: '1', number: 1, text: 'Yes, run command', classification: 'yes_once' },
      { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
    ]
  };

  const rules = {
    optionRules: [
      { name: 'always-in-conversation', startsWith: 'Yes, and always allow in this conversation', enabled: true, allowTruncatedCommand: true },
      { name: 'run-command', startsWith: 'Yes, run command', enabled: true, allowTruncatedCommand: true }
    ]
  };

  const dec = evaluatePrompt(prompt, rules);
  assert.strictEqual(dec.action, 'would_approve');
  assert.strictEqual(dec.optionKey, '1', 'Option 1 (run command) must win when session option is absent');
  assert.strictEqual(dec.rule, 'run-command');
});

// 5. File creation prompt matches 3-word rule: Yes, allow creation
test('File creation prompt matches 3-word rule "Yes, allow creation"', () => {
  const prompt = {
    promptType: 'file_create',
    commandSpaced: 'src/new-feature.js',
    question: 'Allow creation of this file?',
    options: [
      { key: '1', number: 1, text: 'Yes, allow creation of this file', classification: 'yes_once' },
      { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
    ]
  };

  const rules = {
    optionRules: [
      { name: 'always-in-conversation', startsWith: 'Yes, and always allow in this conversation', enabled: true, allowTruncatedCommand: true },
      { name: 'custom-rule-2', startsWith: 'Yes, allow creation', enabled: true, allowTruncatedCommand: true }
    ]
  };

  const dec = evaluatePrompt(prompt, rules);
  assert.strictEqual(dec.action, 'would_approve');
  assert.strictEqual(dec.optionKey, '1');
  assert.strictEqual(dec.rule, 'custom-rule-2');
});

// 6. Accidental option text in commandStartsWith does not block the command
test('Accidental option text in commandStartsWith does not block option rule', () => {
  const prompt = {
    promptType: 'command',
    commandSpaced: 'touch temp.txt',
    question: 'Run this command?',
    options: [
      { key: '1', number: 1, text: 'Yes, allow creation', classification: 'yes_once' },
      { key: '2', number: 2, text: 'No, cancel', classification: 'no' }
    ]
  };

  const rulesWithAccidental = {
    optionRules: [
      {
        name: 'custom-rule-2',
        startsWith: 'Yes, allow creation',
        commandStartsWith: 'Yes, allow creation', // accidental option text!
        enabled: true,
        allowTruncatedCommand: true
      }
    ]
  };

  const dec = evaluatePrompt(prompt, rulesWithAccidental);
  assert.strictEqual(dec.action, 'would_approve');
  assert.strictEqual(dec.optionKey, '1');
});

console.log(`\nAll ${passCount} test-option-hierarchy tests passed successfully!`);
