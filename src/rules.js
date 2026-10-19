const fs = require('fs');
const path = require('path');

const DEFAULT_RULES = {
  defaultDelaySeconds: 3,
  deny: [
    'rm -rf',
    'rmdir /s',
    'del /f',
    'Remove-Item -Recurse',
    'format',
    'git push --force',
    'git reset --hard',
    'curl.*\\|.*(?:sh|bash|zsh|powershell|cmd|pwsh)',
    'wget.*\\|.*(?:sh|bash|zsh|powershell|cmd|pwsh)',
    'powershell -enc',
    'sudo',
    'chmod 777',
    '.env',
    'settings.json',
    '.ssh',
    'credentials'
  ],
  allow: [
    {
      name: 'node-safe',
      pattern: '^(?:node|npm|npx|git status|git diff|git log|ls|dir)\\b',
      delay: 3
    }
  ]
};

/**
 * Loads rules from rules.json (in cwd or project root) with fallback to DEFAULT_RULES.
 */
function loadRules(rulesPath) {
  const candidatePaths = [
    rulesPath,
    path.resolve(process.cwd(), 'rules.json'),
    path.resolve(__dirname, '..', 'rules.json')
  ].filter(Boolean);

  for (const p of candidatePaths) {
    if (fs.existsSync(p)) {
      try {
        const raw = fs.readFileSync(p, 'utf8');
        return JSON.parse(raw);
      } catch (e) {
        // continue to next or fallback
      }
    }
  }

  return DEFAULT_RULES;
}

/**
 * Checks if a deny rule matches a command in either spaced or compact form.
 * Deny matching MUST be checked against both the spaced and compact forms.
 */
function checkDenyRule(rule, commandSpaced, commandCompact) {
  const isRegexPattern = rule.includes('.*') || rule.includes('\\|') || rule.includes('(');

  if (isRegexPattern) {
    try {
      const regSpaced = new RegExp(rule, 'i');
      if (regSpaced.test(commandSpaced)) return true;

      const compactPattern = rule
        .replace(/\\s\+/g, '')
        .replace(/\\s\*/g, '')
        .replace(/\s+/g, '');
      const regCompact = new RegExp(compactPattern, 'i');
      if (regCompact.test(commandCompact)) return true;
    } catch (e) {
      // Fallback to literal check
    }
  }

  // Literal check on spaced form
  const lowerSpaced = commandSpaced.toLowerCase();
  const lowerRule = rule.toLowerCase();
  if (lowerSpaced.includes(lowerRule)) {
    return true;
  }

  // Literal check on compact form (all whitespace removed from command and rule)
  const compactRule = lowerRule.replace(/\s+/g, '');
  const lowerCompact = commandCompact.toLowerCase();
  if (lowerCompact.includes(compactRule)) {
    return true;
  }

  return false;
}

/**
 * Evaluates a prompt against rules in dry-run mode.
 * Returns decision object:
 * - { action: 'blocked', rule, log }
 * - { action: 'would_approve', delay, rule, optionKey, log }
 * - { action: 'needs_user', reason, log }
 */
function evaluatePrompt(prompt, customRules) {
  const rules = customRules || loadRules();

  if (!prompt || !prompt.options || prompt.options.length < 2) {
    return {
      action: 'needs_user',
      reason: 'unknown prompt layout',
      log: 'Dry-run: needs_user (unknown prompt layout)'
    };
  }

  const cmdSpaced = prompt.commandSpaced || prompt.command || '';
  const cmdCompact = prompt.commandCompact || cmdSpaced.replace(/\s+/g, '');

  // 1. Deny list ALWAYS wins
  const denyList = rules.deny || DEFAULT_RULES.deny;
  for (const denyRule of denyList) {
    if (checkDenyRule(denyRule, cmdSpaced, cmdCompact)) {
      return {
        action: 'blocked',
        rule: denyRule,
        log: `Dry-run: blocked command by deny rule "${denyRule}"`
      };
    }
  }

  // 2. Option eligibility: only "yes_once" is eligible; "yes_session" and "yes_persist" are never eligible
  const eligibleOption = prompt.options.find(opt => opt.classification === 'yes_once');
  if (!eligibleOption) {
    return {
      action: 'needs_user',
      reason: 'no eligible yes_once option',
      log: 'Dry-run: needs_user (no eligible yes_once option)'
    };
  }

  // 3. Allow rules matching
  const allowRules = rules.allow || DEFAULT_RULES.allow;
  for (const allowRule of allowRules) {
    if (allowRule.pattern) {
      const reg = new RegExp(allowRule.pattern, 'i');
      if (reg.test(cmdSpaced)) {
        const delay = allowRule.delay !== undefined
          ? allowRule.delay
          : (rules.defaultDelaySeconds || 3);
        const optionKey = eligibleOption.key || String(eligibleOption.number);
        return {
          action: 'would_approve',
          delay,
          rule: allowRule.name,
          optionKey,
          log: `Dry-run: would approve option ${optionKey} after ${delay}s (rule: ${allowRule.name})`
        };
      }
    }
  }

  // 4. No allow rule matched
  return {
    action: 'needs_user',
    reason: 'no allow rule matched',
    log: 'Dry-run: needs_user (no allow rule matched)'
  };
}

module.exports = {
  loadRules,
  checkDenyRule,
  evaluatePrompt,
  DEFAULT_RULES
};
