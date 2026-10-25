const fs = require('fs');
const path = require('path');

const DEFAULT_DANGER_LIST = [
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
  danger: DEFAULT_DANGER_LIST,
  allow: [
    // Tier 1 (enabled)
    {
      name: 'git-readonly',
      pattern: '^(?:git\\s+status(?:\\s+(?:--[a-zA-Z0-9_-]+(?:=[a-zA-Z0-9_.-]+)?|-[a-zA-Z0-9]+|\\d+|[a-zA-Z0-9_./@~-]+))*|git\\s+branch(?:\\s+(?:-a|-r|--list|-v))*|git\\s+(?:diff|log)(?!\\s*.*(?:^|\\s)(?:--[a-zA-Z0-9_-]*(?:output|out\\b|file)[a-zA-Z0-9_-]*|-[oO]\\b|-[oO]=|-[oO]\\S|--[a-zA-Z0-9_-]+=[^\\s]*[\\\\/.]))(?:\\s+(?:--[a-zA-Z0-9_-]+(?:=[a-zA-Z0-9_.-]+)?|-[a-zA-Z0-9]+|\\d+|[a-zA-Z0-9_./@~-]+))*)$',
      delay: 3
    },
    {
      name: 'file-list',
      pattern: '^(?:pwd|Get-Location|(?:ls|dir|Get-ChildItem)(?:\\s+(?!.*\\.\\.)(?![\\/\\\\]|[a-zA-Z]:)(?:-[a-zA-Z0-9]+|[\'"]?(?:\\.[\\/\\\\])?[a-zA-Z0-9_@~.-]+(?:[\\/\\\\][a-zA-Z0-9_@~.-]+)*[\'"]?))*)$',
      delay: 3
    },
    {
      name: 'version-check',
      pattern: '^(?:npm|node)\\s+(?:--version|-v)$',
      delay: 3
    },
    {
      name: 'echo-safe',
      pattern: '^echo(?:\\s+[^;&|><`$()\\r\\n]+)?$',
      delay: 3
    },
    // Tier 2 (disabled): npm run build, npm run lint, npm run dev, npm test
    {
      name: 'npm-build',
      pattern: '^npm run build$',
      delay: 3,
      enabled: false
    },
    {
      name: 'npm-lint',
      pattern: '^npm run lint$',
      delay: 3,
      enabled: false
    },
    {
      name: 'npm-dev',
      pattern: '^npm run dev$',
      delay: 3,
      enabled: false
    },
    {
      name: 'npm-test',
      pattern: '^npm test$',
      delay: 3,
      enabled: false
    }
  ],
  optionRules: []
};

/**
 * Validates an optionRules list.
 * Ignores invalid rules with a clear warning:
 * - missing startsWith
 * - empty strings
 * - unknown fields
 * - startsWith shorter than 3 characters is rejected as too broad
 * Never crashes on a bad file.
 */
function validateOptionRules(rawList) {
  if (!Array.isArray(rawList)) {
    if (rawList !== undefined && rawList !== null) {
      console.warn('agentwatch: warning: optionRules must be an array, ignoring invalid optionRules property');
    }
    return (DEFAULT_RULES.optionRules || []).slice();
  }

  const ALLOWED_OPTION_RULE_KEYS = new Set(['name', 'startsWith', 'endsWith', 'commandStartsWith', 'enabled', 'allowPersist']);
  const validEntries = [];

  for (const item of rawList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      console.warn(`agentwatch: warning: invalid option rule ignored: ${JSON.stringify(item)}`);
      continue;
    }

    const itemKeys = Object.keys(item);
    const unknownKeys = itemKeys.filter(k => !ALLOWED_OPTION_RULE_KEYS.has(k));
    if (unknownKeys.length > 0) {
      console.warn(`agentwatch: warning: option rule contains unknown fields (${unknownKeys.join(', ')}), ignored: ${JSON.stringify(item)}`);
      continue;
    }

    if (typeof item.name !== 'string' || item.name.trim() === '') {
      console.warn(`agentwatch: warning: option rule missing or empty name, ignored: ${JSON.stringify(item)}`);
      continue;
    }

    if (typeof item.startsWith !== 'string') {
      console.warn(`agentwatch: warning: option rule missing startsWith string, ignored: ${JSON.stringify(item)}`);
      continue;
    }

    const trimmedStarts = item.startsWith.trim();
    if (trimmedStarts === '') {
      console.warn(`agentwatch: warning: option rule startsWith cannot be empty, ignored: ${JSON.stringify(item)}`);
      continue;
    }

    if (trimmedStarts.length < 3) {
      console.warn(`agentwatch: warning: option rule startsWith shorter than 3 characters rejected as too broad: "${item.startsWith}"`);
      continue;
    }

    if (item.endsWith !== undefined) {
      if (typeof item.endsWith !== 'string') {
        console.warn(`agentwatch: warning: option rule endsWith must be a string, ignored: ${JSON.stringify(item)}`);
        continue;
      }
      if (item.endsWith.trim() === '') {
        console.warn(`agentwatch: warning: option rule endsWith cannot be empty, ignored: ${JSON.stringify(item)}`);
        continue;
      }
    }

    if (item.commandStartsWith !== undefined) {
      if (typeof item.commandStartsWith !== 'string') {
        console.warn(`agentwatch: warning: option rule commandStartsWith must be a string, ignored: ${JSON.stringify(item)}`);
        continue;
      }
      if (item.commandStartsWith.trim() === '') {
        console.warn(`agentwatch: warning: option rule commandStartsWith cannot be empty, ignored: ${JSON.stringify(item)}`);
        continue;
      }
    }

    validEntries.push({
      name: item.name.trim(),
      startsWith: item.startsWith.trim(),
      endsWith: item.endsWith !== undefined ? item.endsWith.trim() : undefined,
      commandStartsWith: item.commandStartsWith !== undefined ? item.commandStartsWith.trim() : undefined,
      enabled: item.enabled !== undefined ? Boolean(item.enabled) : true,
      allowPersist: item.allowPersist !== undefined ? Boolean(item.allowPersist) : false
    });
  }

  return validEntries;
}

/**
 * Checks whether an option is classified as yes_persist
 * (it mentions persist or settings.json).
 */
function isPersistOption(option) {
  if (!option) return false;
  if (option.classification === 'yes_persist') return true;
  const text = (option.text || '').toLowerCase();
  return text.includes('persist') || text.includes('settings.json');
}

/**
 * Checks if a specific option matches an enabled option rule:
 * - Option is NOT a "no" option
 * - If rule has commandStartsWith, spaced command must start with it
 * - Matching is case-insensitive, trims whitespace, and compares against option text only (not number prefix)
 * - If rule has endsWith, option text must end with it
 */
function matchesOptionRule(rule, option, cmdSpaced) {
  if (!rule || rule.enabled === false) return false;
  if (!option || typeof option.text !== 'string') return false;

  // "No" options are NEVER pressed
  if (option.classification === 'no' || /^(?:no\b|cancel\b|abort\b|reject\b)/i.test((option.text || '').trim())) {
    return false;
  }

  // If the rule has commandStartsWith, the spaced command must start with it
  if (rule.commandStartsWith) {
    const cmd = (cmdSpaced || '').trim().toLowerCase();
    const prefix = rule.commandStartsWith.trim().toLowerCase();
    if (!cmd.startsWith(prefix)) {
      return false;
    }
  }

  // Compare against the option text only (not the number prefix)
  const cleanOptionText = option.text
    .replace(/^\s*(?:>\s*)?\d+\.\s*/, '')
    .trim()
    .toLowerCase();

  const startsWith = (rule.startsWith || '').trim().toLowerCase();
  if (!cleanOptionText.startsWith(startsWith)) {
    return false;
  }

  if (rule.endsWith) {
    const endsWith = rule.endsWith.trim().toLowerCase();
    if (!cleanOptionText.endsWith(endsWith)) {
      return false;
    }
  }

  return true;
}

/**
 * Escapes regex special characters.
 */
function escapeRegExp(string) {
  return String(string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validates a danger list.
 * Ignores invalid entries with a warning.
 * Rejects entries shorter than 2 characters with a warning.
 * Returns array of { text: string, wholeWord: boolean }.
 */
function validateDangerList(rawList) {
  if (!Array.isArray(rawList)) {
    if (rawList !== undefined && rawList !== null) {
      console.warn('agentwatch: warning: danger list must be an array, ignoring invalid danger property');
    }
    return DEFAULT_DANGER_LIST.slice();
  }

  const validEntries = [];
  for (const item of rawList) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      console.warn(`agentwatch: warning: invalid danger list entry ignored: ${JSON.stringify(item)}`);
      continue;
    }
    if (typeof item.text !== 'string') {
      console.warn(`agentwatch: warning: danger entry missing text string ignored: ${JSON.stringify(item)}`);
      continue;
    }
    if (item.text.length < 2) {
      console.warn(`agentwatch: warning: danger entry shorter than 2 characters ignored: "${item.text}"`);
      continue;
    }
    validEntries.push({
      text: item.text,
      wholeWord: Boolean(item.wholeWord)
    });
  }

  return validEntries;
}

/**
 * Checks a single danger entry against:
 * 1. Spaced command
 * 2. Compact command (whitespace removed from both command and entry)
 * 3. Question text
 * Never against options.
 *
 * Case-insensitive.
 * wholeWord true matches only as a separate word; false matches as a substring.
 */
function checkDangerEntry(entry, cmdSpaced, cmdCompact, question) {
  if (!entry || typeof entry.text !== 'string' || entry.text.length < 2) {
    return false;
  }

  const entryText = entry.text;
  const entryCompact = entryText.replace(/\s+/g, '');

  if (entry.wholeWord) {
    const wordPattern = new RegExp(`(?<![a-zA-Z0-9_])${escapeRegExp(entryText)}(?![a-zA-Z0-9_])`, 'i');
    if (cmdSpaced && wordPattern.test(cmdSpaced)) return true;
    if (question && wordPattern.test(question)) return true;

    // Compact command check for wholeWord:
    // When a command word was split across wrapped lines,
    // check entryCompact with word boundaries in cmdCompact.
    if (cmdCompact && entryCompact.length >= 2) {
      const compactWordPattern = new RegExp(`(?<![a-zA-Z0-9_])${escapeRegExp(entryCompact)}(?![a-zA-Z0-9_])`, 'i');
      if (compactWordPattern.test(cmdCompact)) return true;
    }
  } else {
    // Substring matching (case-insensitive)
    const lowerEntry = entryText.toLowerCase();
    if (cmdSpaced && cmdSpaced.toLowerCase().includes(lowerEntry)) return true;
    if (question && question.toLowerCase().includes(lowerEntry)) return true;

    const lowerCompactEntry = entryCompact.toLowerCase();
    if (cmdCompact && lowerCompactEntry.length > 0 && cmdCompact.toLowerCase().includes(lowerCompactEntry)) {
      return true;
    }
  }

  return false;
}

/**
 * Checks if a prompt matches any entry in the danger list.
 * Returns the matching danger entry or null.
 */
function checkDangerMatch(prompt, dangerList) {
  if (!prompt) return null;
  const list = Array.isArray(dangerList) ? dangerList : DEFAULT_DANGER_LIST;
  if (list.length === 0) return null;

  const cmdSpaced = prompt.commandSpaced || prompt.command || '';
  const cmdCompact = (prompt.commandCompact || cmdSpaced.replace(/\s+/g, '')).replace(/\s+/g, '');
  const question = prompt.question || '';

  for (const entry of list) {
    if (checkDangerEntry(entry, cmdSpaced, cmdCompact, question)) {
      return entry;
    }
  }

  return null;
}

/**
 * Loads rules from rules.json (in cwd or project root) with fallback to DEFAULT_RULES.
 * Strips single-line (//) and multi-line comments before parsing JSON.
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
        const stripped = raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        const parsed = JSON.parse(stripped);
        if (parsed && typeof parsed === 'object') {
          if (parsed.danger !== undefined) {
            parsed.danger = validateDangerList(parsed.danger);
          } else {
            parsed.danger = DEFAULT_DANGER_LIST.slice();
          }
          if (parsed.optionRules !== undefined) {
            parsed.optionRules = validateOptionRules(parsed.optionRules);
          } else {
            parsed.optionRules = (DEFAULT_RULES.optionRules || []).slice();
          }
          return parsed;
        }
      } catch (e) {
        console.warn(`agentwatch: warning: could not load rules from "${p}": ${e.message}`);
        // continue to next or fallback
      }
    }
  }

  return {
    ...DEFAULT_RULES,
    danger: DEFAULT_DANGER_LIST.slice(),
    optionRules: (DEFAULT_RULES.optionRules || []).slice()
  };
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
 * Checks whether a command contains forbidden shell syntax or characters.
 * If command contains ANY of these, it is never allowed:
 * ; & && || | > >> < ` $( ) $env: Invoke-Expression, iex, and any newline.
 */
function containsForbiddenShellSyntax(command) {
  if (!command || typeof command !== 'string') return false;

  // Characters: ; & | > < ` newline \r \n (covers &&, ||, >>)
  if (/[;&|><`\r\n]/.test(command)) return true;

  // Sequences: $( and )
  if (command.includes('$(') || command.includes(')')) return true;

  // Sequence: $env: (case-insensitive)
  if (/\$env:/i.test(command)) return true;

  // Sequence: Invoke-Expression (case-insensitive)
  if (/Invoke-Expression/i.test(command)) return true;

  // Sequence: iex (case-insensitive)
  if (/\biex\b/i.test(command) || command.toLowerCase().includes('iex')) return true;

  return false;
}

/**
 * Checks whether a prompt appears to be a choice question without clear yes/no meaning.
 * Prompts with questions like "Which...", "Choose...", "Select...", or options lacking
 * any negative/cancel option are treated as choice questions.
 */
function isChoiceQuestion(prompt) {
  if (!prompt) return true;
  const q = (prompt.question || '').trim().toLowerCase();
  if (/\b(?:which|choose|choice|select|pick)\b/i.test(q)) {
    return true;
  }
  // Must have at least one option with negative/cancel meaning ('no')
  const hasNoOption = (prompt.options || []).some(opt =>
    opt.classification === 'no' || /^(?:no\b|cancel\b|abort\b|reject\b)/i.test(opt.text || '')
  );
  if (!hasNoOption) {
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
 *
 * STRICT MATCHING:
 * 1. Allow rule matches WHOLE command, anchored at both ends.
 * 2. Allow matching runs ONLY on real spaced command, NEVER on compact form.
 * 3. Forbidden shell characters/sequences are never allowed.
 * 4. Mentions of sensitive targets (.env, etc.) still blocked by existing deny list.
 * 5. Rule name appears in dry-run decision log.
 * 6. Exactly ONE option (yes_once) must be eligible; never session, persist, or no.
 * 7. Prompts that look like choice questions are marked needs_user.
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

  // 1. Deny list ALWAYS wins (checked on both spaced and compact forms)
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

  // 2. Danger list WINS over allow list, option rules, and countdown
  const dangerList = rules.danger !== undefined ? rules.danger : DEFAULT_RULES.danger;
  const dangerMatch = checkDangerMatch(prompt, dangerList);
  if (dangerMatch) {
    const matchedText = dangerMatch.text;
    return {
      action: 'needs_user',
      danger: true,
      entry: matchedText,
      reason: `DANGER: matched '${matchedText}'`,
      log: `Dry-run: needs_user (DANGER: matched '${matchedText}')`
    };
  }

  // 3. Choice question check (no clear yes/no meaning)
  if (isChoiceQuestion(prompt)) {
    return {
      action: 'needs_user',
      reason: 'choice question (no clear yes/no meaning)',
      log: 'Dry-run: needs_user (choice question (no clear yes/no meaning))'
    };
  }

  // 4. Option rules matching:
  // EXACTLY ONE option on screen must match an enabled rule.
  // If zero or more than one match, press nothing and mark needs_user.
  const optionRules = Array.isArray(rules.optionRules) ? rules.optionRules : [];
  const enabledOptionRules = optionRules.filter(r => r && r.enabled !== false);

  if (enabledOptionRules.length > 0) {
    const matchedOptionRulePairs = [];
    for (const opt of prompt.options) {
      for (const rule of enabledOptionRules) {
        if (matchesOptionRule(rule, opt, cmdSpaced)) {
          matchedOptionRulePairs.push({ option: opt, rule });
        }
      }
    }

    if (matchedOptionRulePairs.length > 0) {
      // Collect unique options that matched
      const uniqueMatchedOptions = [];
      for (const pair of matchedOptionRulePairs) {
        if (!uniqueMatchedOptions.some(o => (o.key && o.key === pair.option.key) || o.number === pair.option.number)) {
          uniqueMatchedOptions.push(pair.option);
        }
      }

      if (uniqueMatchedOptions.length > 1 || matchedOptionRulePairs.length > 1) {
        const reason = uniqueMatchedOptions.length > 1
          ? 'multiple options matched enabled option rules'
          : 'multiple option rules matched single option';
        return {
          action: 'needs_user',
          reason,
          log: `Dry-run: needs_user (${reason})`
        };
      }

      // Exactly ONE option matched exactly ONE enabled rule!
      const { option: matchedOption, rule: matchedRule } = matchedOptionRulePairs[0];

      // Persist protection: if matched option is classified yes_persist,
      // require the rule to have allowPersist true.
      if (isPersistOption(matchedOption) && !matchedRule.allowPersist) {
        const reason = `persist option blocked (rule "${matchedRule.name}" has allowPersist: false)`;
        return {
          action: 'needs_user',
          rule: matchedRule.name,
          reason,
          log: `Dry-run: needs_user (${reason})`
        };
      }

      const delay = matchedRule.delay !== undefined
        ? matchedRule.delay
        : (rules.defaultDelaySeconds || 3);
      const optionKey = matchedOption.key || String(matchedOption.number);
      return {
        action: 'would_approve',
        delay,
        rule: matchedRule.name,
        ruleType: 'optionRule',
        optionKey,
        optionText: matchedOption.text,
        matchedOption,
        log: `Dry-run: would approve option ${optionKey} after ${delay}s (rule: ${matchedRule.name})`
      };
    }
  }

  // 5. Existing command allow list keeps working alongside option rules
  // Option eligibility: exactly ONE option must be classified yes_once.
  // Works for 2, 4, 8, or any number of options.
  // Never eligible for yes_session, yes_persist, or no options.
  const yesOnceOptions = prompt.options.filter(opt => opt.classification === 'yes_once');
  if (yesOnceOptions.length !== 1) {
    const reason = yesOnceOptions.length === 0 ? 'no eligible yes_once option' : 'multiple yes_once options';
    return {
      action: 'needs_user',
      reason,
      log: `Dry-run: needs_user (${reason})`
    };
  }
  const eligibleOption = yesOnceOptions[0];

  // 6. Allow rules matching: STRICT MATCHING
  // Allow matching runs ONLY on real spaced command, never on compact form.
  const hasForbiddenSyntax = containsForbiddenShellSyntax(cmdSpaced);
  const cmdToMatch = cmdSpaced.trim();

  if (!hasForbiddenSyntax && cmdToMatch.length > 0) {
    const allowRules = rules.allow || DEFAULT_RULES.allow;
    for (const allowRule of allowRules) {
      if (allowRule.enabled === false) continue;
      if (allowRule.pattern) {
        const reg = new RegExp(allowRule.pattern, 'i');
        if (reg.test(cmdToMatch)) {
          const delay = allowRule.delay !== undefined
            ? allowRule.delay
            : (rules.defaultDelaySeconds || 3);
          const optionKey = eligibleOption.key || String(eligibleOption.number);
          return {
            action: 'would_approve',
            delay,
            rule: allowRule.name,
            ruleType: 'allowRule',
            optionKey,
            optionText: eligibleOption.text,
            log: `Dry-run: would approve option ${optionKey} after ${delay}s (rule: ${allowRule.name})`
          };
        }
      }
    }
  }

  // 7. No allow rule matched or forbidden shell syntax
  return {
    action: 'needs_user',
    reason: hasForbiddenSyntax ? 'forbidden shell syntax' : 'no allow rule matched',
    log: hasForbiddenSyntax
      ? 'Dry-run: needs_user (forbidden shell syntax)'
      : 'Dry-run: needs_user (no allow rule matched)'
  };
}

module.exports = {
  loadRules,
  checkDenyRule,
  containsForbiddenShellSyntax,
  isChoiceQuestion,
  evaluatePrompt,
  checkDangerEntry,
  checkDangerMatch,
  validateDangerList,
  validateOptionRules,
  matchesOptionRule,
  isPersistOption,
  DEFAULT_DANGER_LIST,
  DEFAULT_RULES
};
