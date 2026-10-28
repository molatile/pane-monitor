const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CANONICAL_RULES_PATH = path.resolve(__dirname, '..', 'rules.json');

/**
 * Resolves the rules.json file path:
 * 1. customPath if explicitly provided
 * 2. rules.json in cwd
 * 3. Walk up ancestor directories from cwd to find rules.json
 * 4. CANONICAL_RULES_PATH (project root)
 * 5. Fallback to cwd rules.json
 */
function resolveRulesPath(customPath, cwd) {
  if (customPath) {
    return path.resolve(customPath);
  }
  const rawCwd = cwd || process.cwd();
  const cwdRules = path.resolve(rawCwd, 'rules.json');
  if (fs.existsSync(cwdRules)) {
    return cwdRules;
  }

  // Walk up ancestor directories
  let curr = path.resolve(rawCwd);
  while (true) {
    const candidate = path.join(curr, 'rules.json');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const parent = path.dirname(curr);
    if (!parent || parent === curr) {
      break;
    }
    curr = parent;
  }

  if (fs.existsSync(CANONICAL_RULES_PATH)) {
    return CANONICAL_RULES_PATH;
  }

  return cwdRules;
}

function getAgentwatchDir() {
  return process.env.AGENTWATCH_DIR || path.join(os.homedir(), '.agentwatch');
}

function getRulesBackupsDir() {
  return path.join(getAgentwatchDir(), 'rules-backups');
}

function getRulesChangesLogPath() {
  return path.join(getAgentwatchDir(), 'rules-changes.log');
}

function getFolderRulesDir() {
  return process.env.AGENTWATCH_FOLDER_RULES_DIR || path.join(getAgentwatchDir(), 'folder-rules');
}

function getFolderChoicesPath() {
  return process.env.AGENTWATCH_FOLDER_CHOICES_PATH || path.join(getAgentwatchDir(), 'folder-choices.json');
}

function safeFolderKeyBase(folderKey) {
  return String(folderKey || '').replace(/[:\\/*?"<>|]/g, '_');
}

function safeFolderKeyFilename(folderKey) {
  return safeFolderKeyBase(folderKey) + '.json';
}

function getFolderRulesBackupsDir(folderKey) {
  return path.join(getRulesBackupsDir(), 'folders', safeFolderKeyBase(folderKey));
}

function getFolderRulesPath(folderKey, customDir) {
  const dir = customDir || getFolderRulesDir();
  const direct = path.join(dir, `${folderKey}.json`);
  const safe = path.join(dir, safeFolderKeyFilename(folderKey));
  if (process.platform !== 'win32' && fs.existsSync(direct)) {
    return direct;
  }
  if (fs.existsSync(safe)) {
    return safe;
  }
  return process.platform === 'win32' ? safe : direct;
}

/**
 * Computes ancestors of a folder path as hashes and display names.
 * NEVER returns or stores raw folder paths.
 * Returns array of { hash, name, key }, nearest ancestor first (ancestors[0]).
 */
function computeFolderAncestors(cwd, agent = 'agy') {
  const ancestors = [];
  let current = path.resolve(cwd || process.cwd());
  while (true) {
    const parent = path.dirname(current);
    if (!parent || parent === current) {
      break;
    }
    const normParent = path.resolve(parent);
    const canonical = process.platform === 'win32' ? normParent.toLowerCase() : normParent;
    const hash = crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 16);
    const name = path.basename(normParent) || normParent;
    const key = `${agent}:${hash}`;
    ancestors.push({ hash, name, key });
    current = parent;
  }
  return ancestors;
}

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
  optionRules: [
    {
      name: 'accept-file-edit',
      startsWith: 'Yes, accept',
      promptTypes: ['file_edit'],
      enabled: false
    }
  ]
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

  const ALLOWED_OPTION_RULE_KEYS = new Set(['name', 'startsWith', 'endsWith', 'commandStartsWith', 'enabled', 'allowPersist', 'promptTypes']);
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

    if (/^(?:no\b|cancel\b|abort\b|reject\b)/i.test(trimmedStarts)) {
      console.warn(`agentwatch: warning: option rule startsWith cannot match "No" options, rejected: "${item.startsWith}"`);
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

    let promptTypes = undefined;
    if (item.promptTypes !== undefined) {
      if (Array.isArray(item.promptTypes)) {
        promptTypes = item.promptTypes.map(p => String(p).trim()).filter(Boolean);
      } else if (typeof item.promptTypes === 'string' && item.promptTypes.trim() !== '') {
        promptTypes = [item.promptTypes.trim()];
      } else {
        console.warn(`agentwatch: warning: option rule promptTypes must be an array or string, ignored: ${JSON.stringify(item)}`);
      }
    }

    validEntries.push({
      name: item.name.trim(),
      startsWith: item.startsWith.trim(),
      endsWith: item.endsWith !== undefined ? item.endsWith.trim() : undefined,
      commandStartsWith: item.commandStartsWith !== undefined ? item.commandStartsWith.trim() : undefined,
      promptTypes: promptTypes,
      enabled: item.enabled !== undefined ? Boolean(item.enabled) : true,
      allowPersist: item.allowPersist !== undefined ? Boolean(item.allowPersist) : false
    });
  }

  return validEntries;
}

/**
 * Extracts target file path from context lines for file_edit prompts.
 * Prefers lines containing: edit, file, update, write.
 * Returns normalized path string or null.
 */
function extractTargetFilePath(contextLines) {
  if (!contextLines || !Array.isArray(contextLines) || contextLines.length === 0) {
    return null;
  }

  const fileExtRegex = /\.(?:[a-zA-Z0-9_-]{1,10})$/i;

  function extractTokenFromLine(line) {
    if (!line || typeof line !== 'string') return null;
    const str = line.trim();

    // Check diff header lines: --- a/path or +++ b/path
    const diffMatch = str.match(/^(?:---|\+\+\+)\s+[ab][/\\]([^\s\t]+)/);
    if (diffMatch && diffMatch[1]) {
      const p = diffMatch[1].trim();
      if (p !== '/dev/null') {
        return p;
      }
    }

    const gitDiffMatch = str.match(/^diff --git\s+[ab][/\\]([^\s\t]+)\s+[ab][/\\]([^\s\t]+)/);
    if (gitDiffMatch && gitDiffMatch[2]) {
      return gitDiffMatch[2].trim();
    }

    // Split into tokens by whitespace, quotes, parentheses, brackets
    const tokens = str.split(/[\s,;]+/).map(t => t.trim()).filter(Boolean);
    for (const rawToken of tokens) {
      let t = rawToken.replace(/^['"`(<[]+/, '').replace(/['"`):>\]]+$/, '');
      if (t.startsWith('a/') || t.startsWith('b/') || t.startsWith('a\\') || t.startsWith('b\\')) {
        t = t.slice(2);
      }
      t = t.replace(/:+$/, '');
      if (!t) continue;
      if (t.includes('://')) continue; // Skip URLs
      if (/^\d+\.\d+(?:\.\d+)?$/.test(t)) continue; // Skip numbers/versions
      if (/^\d+\.?\d*s$/.test(t)) continue; // Skip times

      // Must have file extension or start with .env
      const base = path.basename(t.replace(/\\/g, '/'));
      if (base.startsWith('.env') || (fileExtRegex.test(base) && base.includes('.'))) {
        return t;
      }
    }

    return null;
  }

  // 1. Prefer lines containing edit, file, update, write
  const preferredRegex = /\b(?:edit|file|update|write)\b/i;
  for (let i = contextLines.length - 1; i >= 0; i--) {
    const line = typeof contextLines[i] === 'string' ? contextLines[i] : (contextLines[i]?.text || '');
    if (preferredRegex.test(line)) {
      const token = extractTokenFromLine(line);
      if (token) return token;
    }
  }

  // 2. Fallback: check all context lines searching bottom-up
  for (let i = contextLines.length - 1; i >= 0; i--) {
    const line = typeof contextLines[i] === 'string' ? contextLines[i] : (contextLines[i]?.text || '');
    const token = extractTokenFromLine(line);
    if (token) return token;
  }

  return null;
}

/**
 * Checks whether a target file path resolves strictly INSIDE the startFolder.
 * Rejects ".." traversal, absolute path outside, or symlink escapes.
 */
function isPathSafelyInside(targetPath, startFolder) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const rawPath = targetPath.trim();
  if (!rawPath) return false;

  // Reject any ".." path segment in raw path
  const normalizedSeparators = rawPath.replace(/\\/g, '/');
  const segments = normalizedSeparators.split('/');
  if (segments.includes('..')) {
    return false;
  }

  const baseFolder = path.resolve(startFolder || process.cwd());
  const resolved = path.resolve(baseFolder, rawPath);
  const rel = path.relative(baseFolder, resolved);

  if (rel.startsWith('..') || path.isAbsolute(rel) || rel === '') {
    return false;
  }

  if (process.platform === 'win32') {
    if (!resolved.toLowerCase().startsWith(baseFolder.toLowerCase())) {
      return false;
    }
  }

  // Check symlink escape if file exists
  try {
    if (fs.existsSync(resolved)) {
      const real = fs.realpathSync(resolved);
      const realRel = path.relative(baseFolder, real);
      if (realRel.startsWith('..') || path.isAbsolute(realRel) || realRel === '') {
        return false;
      }
      if (process.platform === 'win32') {
        if (!real.toLowerCase().startsWith(baseFolder.toLowerCase())) {
          return false;
        }
      }
    }
  } catch (e) {
    // Rely on resolved path check if realpathSync throws
  }

  return true;
}

/**
 * Checks whether a target file is sensitive:
 * .env*, settings.json, config files containing secrets, .ssh, credentials, private keys, .git internals,
 * and any file matching the existing deny list or sensitive words.
 */
function isSensitiveFile(targetPath, denyList = []) {
  if (!targetPath || typeof targetPath !== 'string') return true;
  const norm = targetPath.replace(/\\/g, '/');
  const baseName = path.basename(norm);
  const lowerBase = baseName.toLowerCase();
  const lowerNorm = norm.toLowerCase();

  // 1. .env* (.env, .env.local, .env.production, etc.)
  if (lowerBase.startsWith('.env') || /(?:^|\/)\.env(?:[.-]|$)/i.test(norm)) {
    return true;
  }

  // 2. settings.json
  if (lowerBase === 'settings.json') {
    return true;
  }

  // 3. config files containing secrets, password, token, credential, private key
  if (/(?:secret|token|password|credential|private[_-]?key)/i.test(lowerBase)) {
    return true;
  }

  // 4. .ssh
  if (/(?:^|\/)\.ssh(?:[\\/]|$)/i.test(norm) || lowerBase.includes('.ssh')) {
    return true;
  }

  // 5. credentials
  if (lowerNorm.includes('credential')) {
    return true;
  }

  // 6. private keys (*.pem, *.key, id_rsa, id_ed25519, private key)
  if (/\.(?:pem|key|pkcs12|pfx|p12)$/i.test(lowerBase) || /^id_(?:rsa|dsa|ecdsa|ed25519)/i.test(lowerBase) || lowerNorm.includes('private key') || lowerNorm.includes('private_key')) {
    return true;
  }

  // 7. .git internals
  if (/(?:^|\/)\.git(?:[\\/]|$)/i.test(norm)) {
    return true;
  }

  // 8. Sensitive words and deny list
  const sensitiveWords = ['secret', 'password', 'token', 'credential', 'private key', '.env', 'settings.json', '.ssh'];
  for (const word of sensitiveWords) {
    if (lowerNorm.includes(word)) {
      return true;
    }
  }

  if (Array.isArray(denyList)) {
    for (const rule of denyList) {
      if (typeof rule === 'string' && rule.trim()) {
        const r = rule.trim().toLowerCase();
        if (lowerNorm.includes(r) || lowerBase.includes(r)) {
          return true;
        }
      }
    }
  }

  return false;
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
 * - If rule has promptTypes, prompt.promptType must match one of them
 */
function matchesOptionRule(rule, option, cmdSpacedOrPrompt, promptObj) {
  if (!rule || rule.enabled === false) return false;
  if (!option || typeof option.text !== 'string') return false;

  const prompt = (cmdSpacedOrPrompt && typeof cmdSpacedOrPrompt === 'object') ? cmdSpacedOrPrompt : promptObj;
  const cmdSpaced = typeof cmdSpacedOrPrompt === 'string' ? cmdSpacedOrPrompt : (prompt ? (prompt.commandSpaced || prompt.command || '') : '');

  // "No" options are NEVER pressed
  if (option.classification === 'no' || /^(?:no\b|cancel\b|abort\b|reject\b|skip\b|exit\b|quit\b|dismiss\b|don'?t\b)/i.test((option.text || '').trim())) {
    return false;
  }

  // Check promptTypes restriction (default: all types)
  if (rule.promptTypes && Array.isArray(rule.promptTypes) && rule.promptTypes.length > 0) {
    const currentType = (prompt && prompt.promptType) || 'command';
    const normCurrent = String(currentType).toLowerCase().replace(/[\s_-]+/g, '');
    const matchedType = rule.promptTypes.some(t => {
      const normRule = String(t).toLowerCase().replace(/[\s_-]+/g, '');
      return normRule === normCurrent;
    });
    if (!matchedType) {
      return false;
    }
  }

  // If the rule has commandStartsWith, the spaced command must start with it
  if (rule.commandStartsWith) {
    if (prompt && prompt.promptType === 'file_edit') {
      let prefix = rule.commandStartsWith.trim();
      const extracted = prefix.match(/for commands that start with ['"]([^'"]+)['"]/i);
      if (extracted) prefix = extracted[1];
      const target = (prompt.targetFile || cmdSpaced || '').trim().toLowerCase();
      if (!target.startsWith(prefix.toLowerCase())) {
        return false;
      }
    } else {
      let prefix = rule.commandStartsWith.trim();
      // Intelligent extraction if full prompt option text was pasted into commandStartsWith:
      const extracted = prefix.match(/for commands that start with ['"]([^'"]+)['"]/i);
      if (extracted) {
        prefix = extracted[1];
      }
      const cmd = (cmdSpaced || '').trim().toLowerCase();
      if (!cmd.startsWith(prefix.toLowerCase())) {
        return false;
      }
    }
  }

  // Compare against the option text only (not the number prefix)
  const cleanOptionText = option.text
    .replace(/^\s*(?:>\s*)?\d+[\.\)\-]?\s*/, '')
    .trim()
    .toLowerCase();

  let startsWith = (rule.startsWith || '').trim().toLowerCase();
  const extractedStarts = startsWith.match(/^(yes,\s+and\s+always\s+allow\s+in\s+this\s+conversation)/i);
  if (extractedStarts && cleanOptionText.startsWith(extractedStarts[1])) {
    // Matched the standard conversation option prefix
  } else if (!cleanOptionText.startsWith(startsWith)) {
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
    return DEFAULT_DANGER_LIST.map(e => ({
      text: e.text,
      wholeWord: Boolean(e.wholeWord),
      level: 'hard',
      enabled: true
    }));
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
    const trimmedText = item.text.trim();
    if (trimmedText.length < 2) {
      console.warn(`agentwatch: warning: danger entry shorter than 2 characters ignored: "${item.text}"`);
      continue;
    }
    const entry = {
      text: trimmedText,
      wholeWord: Boolean(item.wholeWord)
    };
    if (item.level === 'slow') {
      entry.level = 'slow';
      entry.delay = typeof item.delay === 'number' && item.delay > 0 ? item.delay : 10;
    } else {
      entry.level = 'hard';
    }
    if (item.enabled !== undefined) {
      entry.enabled = Boolean(item.enabled);
    } else {
      entry.enabled = true;
    }
    validEntries.push(entry);
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

  let cmdSpaced = '';
  let cmdCompact = '';
  const question = prompt.question || '';

  if (prompt.promptType === 'file_edit') {
    // For file_edit prompts, check danger-list words against the file path and the question only,
    // not against the diff or code lines.
    const targetFile = prompt.targetFile || '';
    cmdSpaced = targetFile;
    cmdCompact = targetFile.replace(/\s+/g, '');
  } else {
    cmdSpaced = prompt.commandSpaced || prompt.command || '';
    cmdCompact = (prompt.commandCompact || cmdSpaced.replace(/\s+/g, '')).replace(/\s+/g, '');
  }

  const matched = [];
  for (const entry of list) {
    if (entry && entry.enabled === false) continue;
    if (checkDangerEntry(entry, cmdSpaced, cmdCompact, question)) {
      matched.push(entry);
    }
  }

  if (matched.length === 0) return null;

  // Hard stop always wins over slow down
  const hardMatch = matched.find(e => e.level !== 'slow');
  if (hardMatch) {
    return hardMatch;
  }
  return matched[0];
}

/**
 * Loads rules from rules.json (in cwd or project root) with fallback to DEFAULT_RULES.
 * Strips single-line (//) and multi-line comments before parsing JSON.
 */
function loadRules(rulesPath) {
  if (rulesPath && fs.existsSync(rulesPath)) {
    try {
      const raw = fs.readFileSync(rulesPath, 'utf8');
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
      console.warn(`agentwatch: warning: could not load rules from "${rulesPath}": ${e.message}`);
      return {
        ...DEFAULT_RULES,
        danger: DEFAULT_DANGER_LIST.slice(),
        optionRules: (DEFAULT_RULES.optionRules || []).slice()
      };
    }
  }

  const resolved = resolveRulesPath(rulesPath);
  const candidatePaths = [
    resolved,
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

  // Anchored / whole-word matching for built-in command "format"
  // Blocks "format c:", "format" as a command, but does not block "information", "formatted", "npm run format", or "Format-Table"
  if (lowerRule === 'format') {
    const regSpaced = /(?:^\s*|[;&|`]\s*)(?:[\w.-]+[/\\])?format(?:\.exe|\.com)?(?:\s+.*|$)/i;
    if (regSpaced.test(commandSpaced)) return true;
    const regCompact = /(?:^|[;&|`])(?:[\w.-]+[/\\])?format(?:\.exe|\.com)?(?:[a-zA-Z]:|\s|$)/i;
    if (commandCompact && regCompact.test(commandCompact)) return true;
    return false;
  }

  // Whole-word matching for "sudo" command to avoid false positives on "pseudo", "pseudocode", "pseudorandom"
  if (lowerRule === 'sudo') {
    const regSpaced = /(?<![a-zA-Z0-9_-])sudo(?![a-zA-Z0-9_-])/i;
    if (regSpaced.test(commandSpaced)) return true;
    const regCompact = /(?:^|[;&|`])sudo(?:\s|$|[a-zA-Z0-9_-])/i;
    if (commandCompact && regCompact.test(commandCompact)) return true;
    return false;
  }

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
    opt.classification === 'no' || /^(?:no\b|cancel\b|abort\b|reject\b|skip\b|exit\b|quit\b|dismiss\b|don'?t\b)/i.test((opt.text || '').replace(/^\s*(?:>\s*)?\d+[\.\)\-]?\s*/, '').trim())
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
  if (customRules && customRules._inFlightPrompt && customRules._oldRules) {
    const newDecision = evaluatePrompt(prompt, { ...customRules, _inFlightPrompt: false, _oldRules: null });
    const oldDecision = evaluatePrompt(prompt, customRules._oldRules);
    // Tightening applies immediately (more restrictive action wins)
    if (newDecision.action !== 'would_approve') {
      return newDecision;
    }
    // Loosening applies only to prompts after save (in-flight prompt cannot auto-approve via loosened rule)
    if (oldDecision.action !== 'would_approve') {
      return oldDecision;
    }
    return newDecision;
  }

  const rules = customRules || loadRules();

  if (!prompt || !prompt.options || prompt.options.length < 2) {
    return {
      action: 'needs_user',
      reason: 'unknown prompt layout',
      log: 'Dry-run: needs_user (unknown prompt layout)'
    };
  }

  const promptType = prompt.promptType || 'command';

  // Unknown prompts never auto-answer
  if (promptType === 'unrecognized') {
    return {
      action: 'needs_user',
      reason: 'unrecognized prompt',
      log: 'Dry-run: needs_user (unrecognized prompt)'
    };
  }

  const isFolder = Boolean(rules.isFolderRuleSet);
  const ruleListType = isFolder ? 'folder' : 'default';
  const rulePrefix = isFolder ? 'folder rule: ' : 'rule: ';

  // Handle file_edit prompt safety and evaluation
  if (promptType === 'file_edit') {
    const startFolder = prompt.startFolder || prompt.cwd || (customRules && customRules.cwd) || process.cwd();
    const targetFile = prompt.targetFile || extractTargetFilePath(prompt.contextLines || []);
    prompt.targetFile = targetFile;

    // 1. Identify path
    if (!targetFile) {
      return {
        action: 'needs_user',
        ruleList: ruleListType,
        reason: 'unidentifiable target file path',
        log: 'Dry-run: needs_user (unidentifiable target file path)'
      };
    }

    // 2. Safe inside folder
    if (!isPathSafelyInside(targetFile, startFolder)) {
      return {
        action: 'needs_user',
        ruleList: ruleListType,
        reason: 'target file path resolves outside session folder',
        log: 'Dry-run: needs_user (target file path resolves outside session folder)'
      };
    }

    // 3. Sensitive file check
    if (isSensitiveFile(targetFile, rules.deny)) {
      return {
        action: 'needs_user',
        ruleList: ruleListType,
        reason: `sensitive target file: ${path.basename(targetFile)}`,
        log: `Dry-run: needs_user (sensitive target file: ${path.basename(targetFile)})`
      };
    }

    // 4. Deny list check
    const denyList = rules.deny || DEFAULT_RULES.deny;
    for (const denyRule of denyList) {
      if (checkDenyRule(denyRule, targetFile, targetFile.replace(/\s+/g, ''))) {
        return {
          action: 'blocked',
          rule: denyRule,
          ruleList: ruleListType,
          log: `Dry-run: blocked command by deny rule "${denyRule}"`
        };
      }
    }

    // 5. Danger list check (path and question only)
    const dangerList = rules.danger !== undefined ? rules.danger : DEFAULT_DANGER_LIST;
    const dangerMatch = checkDangerMatch(prompt, dangerList);
    if (dangerMatch && dangerMatch.level !== 'slow') {
      const matchedText = dangerMatch.text;
      return {
        action: 'needs_user',
        danger: true,
        entry: matchedText,
        ruleList: ruleListType,
        reason: `DANGER: matched '${matchedText}'`,
        log: `Dry-run: needs_user (DANGER: matched '${matchedText}')`
      };
    }

    // 6. Choice question check
    if (isChoiceQuestion(prompt)) {
      return {
        action: 'needs_user',
        ruleList: ruleListType,
        reason: 'choice question (no clear yes/no meaning)',
        log: 'Dry-run: needs_user (choice question (no clear yes/no meaning))'
      };
    }

    // 7. Option rules matching
    const optionRules = Array.isArray(rules.optionRules) ? rules.optionRules : [];
    const enabledOptionRules = optionRules.filter(r => r && r.enabled !== false);

    if (enabledOptionRules.length > 0) {
      const skippedRules = [];
      let winningRule = null;
      let candidateMatches = null;

      for (const rule of enabledOptionRules) {
        const matches = [];
        for (const opt of prompt.options) {
          if (matchesOptionRule(rule, opt, prompt)) {
            matches.push(opt);
          }
        }

        if (matches.length === 0) {
          skippedRules.push(rule.name);
          continue;
        }

        winningRule = rule;
        candidateMatches = matches;
        break;
      }

      if (winningRule) {
        if (candidateMatches.length > 1) {
          const reason = `multiple options matched winning rule "${winningRule.name}"`;
          const skippedInfo = skippedRules.length > 0 ? `, skipped: ${skippedRules.join(', ')}` : '';
          return {
            action: 'needs_user',
            rule: winningRule.name,
            winningRule: winningRule.name,
            ruleList: ruleListType,
            skippedRules: skippedRules.slice(),
            reason,
            log: `Dry-run: needs_user (${reason}${skippedInfo})`
          };
        }

        const matchedOption = candidateMatches[0];

        if (isPersistOption(matchedOption) && !winningRule.allowPersist) {
          const reason = `persist option blocked (rule "${winningRule.name}" has allowPersist: false)`;
          const skippedInfo = skippedRules.length > 0 ? `, skipped: ${skippedRules.join(', ')}` : '';
          return {
            action: 'needs_user',
            rule: winningRule.name,
            winningRule: winningRule.name,
            ruleList: ruleListType,
            skippedRules: skippedRules.slice(),
            reason,
            log: `Dry-run: needs_user (${reason}${skippedInfo})`
          };
        }

        let delay = winningRule.delay !== undefined
          ? winningRule.delay
          : (rules.defaultDelaySeconds || 3);
        if (dangerMatch && dangerMatch.level === 'slow') {
          const slowDelay = typeof dangerMatch.delay === 'number' && dangerMatch.delay > 0 ? dangerMatch.delay : 10;
          delay = Math.max(delay, slowDelay);
        }
        const optionKey = matchedOption.key || String(matchedOption.number);
        const skippedInfo = skippedRules.length > 0 ? `, skipped: ${skippedRules.join(', ')}` : '';
        return {
          action: 'would_approve',
          delay,
          rule: winningRule.name,
          winningRule: winningRule.name,
          ruleList: ruleListType,
          skippedRules: skippedRules.slice(),
          ruleType: 'optionRule',
          optionKey,
          optionText: matchedOption.text,
          matchedOption,
          slowDanger: dangerMatch ? dangerMatch.text : undefined,
          log: `Dry-run: would approve option ${optionKey} after ${delay}s (${rulePrefix}${winningRule.name}${skippedInfo})`
        };
      }
    }

    return {
      action: 'needs_user',
      ruleList: ruleListType,
      reason: 'no option rule matched for file edit',
      log: 'Dry-run: needs_user (no option rule matched for file edit)'
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
        ruleList: ruleListType,
        log: `Dry-run: blocked command by deny rule "${denyRule}"`
      };
    }
  }

  // 2. Danger list WINS over allow list, option rules, and countdown
  const dangerList = rules.danger !== undefined ? rules.danger : DEFAULT_RULES.danger;
  const dangerMatch = checkDangerMatch(prompt, dangerList);
  if (dangerMatch && dangerMatch.level !== 'slow') {
    const matchedText = dangerMatch.text;
    return {
      action: 'needs_user',
      danger: true,
      entry: matchedText,
      ruleList: ruleListType,
      reason: `DANGER: matched '${matchedText}'`,
      log: `Dry-run: needs_user (DANGER: matched '${matchedText}')`
    };
  }

  // 3. Choice question check (no clear yes/no meaning)
  if (isChoiceQuestion(prompt)) {
    return {
      action: 'needs_user',
      ruleList: ruleListType,
      reason: 'choice question (no clear yes/no meaning)',
      log: 'Dry-run: needs_user (choice question (no clear yes/no meaning))'
    };
  }

  // 4. Option rules matching (ordered list; earlier rules have higher priority)
  // Test enabled rules in order; the FIRST rule that matches at least one option wins.
  // If the winning rule matches exactly one option, that option is the candidate (subject to guards).
  // If it matches more than one option, press nothing and mark needs_user.
  // If it matches none, continue to the next rule.
  const optionRules = Array.isArray(rules.optionRules) ? rules.optionRules : [];
  const enabledOptionRules = optionRules.filter(r => r && r.enabled !== false);

  if (enabledOptionRules.length > 0) {
    const skippedRules = [];
    let winningRule = null;
    let candidateMatches = null;

    for (const rule of enabledOptionRules) {
      const matches = [];
      for (const opt of prompt.options) {
        if (matchesOptionRule(rule, opt, prompt)) {
          matches.push(opt);
        }
      }

      if (matches.length === 0) {
        // No option matched this rule; record as skipped higher-priority rule
        skippedRules.push(rule.name);
        continue;
      }

      // First rule that matches at least one option wins!
      winningRule = rule;
      candidateMatches = matches;
      break;
    }

    if (winningRule) {
      if (candidateMatches.length > 1) {
        // Winning rule matches more than one option: press nothing and mark needs_user
        const reason = `multiple options matched winning rule "${winningRule.name}"`;
        const skippedInfo = skippedRules.length > 0 ? `, skipped: ${skippedRules.join(', ')}` : '';
        return {
          action: 'needs_user',
          rule: winningRule.name,
          winningRule: winningRule.name,
          ruleList: ruleListType,
          skippedRules: skippedRules.slice(),
          reason,
          log: `Dry-run: needs_user (${reason}${skippedInfo})`
        };
      }

      // Exactly ONE option matched the winning rule
      const matchedOption = candidateMatches[0];

      // Persist protection: if matched option is classified yes_persist,
      // require the winning rule to have allowPersist true.
      if (isPersistOption(matchedOption) && !winningRule.allowPersist) {
        const reason = `persist option blocked (rule "${winningRule.name}" has allowPersist: false)`;
        const skippedInfo = skippedRules.length > 0 ? `, skipped: ${skippedRules.join(', ')}` : '';
        return {
          action: 'needs_user',
          rule: winningRule.name,
          winningRule: winningRule.name,
          ruleList: ruleListType,
          skippedRules: skippedRules.slice(),
          reason,
          log: `Dry-run: needs_user (${reason}${skippedInfo})`
        };
      }

      let delay = winningRule.delay !== undefined
        ? winningRule.delay
        : (rules.defaultDelaySeconds || 3);
      if (dangerMatch && dangerMatch.level === 'slow') {
        const slowDelay = typeof dangerMatch.delay === 'number' && dangerMatch.delay > 0 ? dangerMatch.delay : 10;
        delay = Math.max(delay, slowDelay);
      }
      const optionKey = matchedOption.key || String(matchedOption.number);
      const skippedInfo = skippedRules.length > 0 ? `, skipped: ${skippedRules.join(', ')}` : '';
      return {
        action: 'would_approve',
        delay,
        rule: winningRule.name,
        winningRule: winningRule.name,
        ruleList: ruleListType,
        skippedRules: skippedRules.slice(),
        ruleType: 'optionRule',
        optionKey,
        optionText: matchedOption.text,
        matchedOption,
        slowDanger: dangerMatch ? dangerMatch.text : undefined,
        log: `Dry-run: would approve option ${optionKey} after ${delay}s (${rulePrefix}${winningRule.name}${skippedInfo})`
      };
    }
  }

  // Priority rule: if folder has its own list, test its rules in order then nothing else
  if (isFolder) {
    const allOptionRulesSkipped = enabledOptionRules.map(r => r.name);
    return {
      action: 'needs_user',
      ruleList: 'folder',
      winningRule: null,
      skippedRules: allOptionRulesSkipped,
      reason: 'no rule matched in folder list',
      log: 'Dry-run: needs_user (no rule matched in folder list)'
    };
  }

  // 5. Existing command allow list keeps working alongside option rules
  // Option eligibility: exactly ONE option must be classified yes_once.
  // Works for 2, 4, 8, or any number of options.
  // Never eligible for yes_session, yes_persist, or no options.
  let yesOnceOptions = prompt.options.filter(opt => opt.classification === 'yes_once');
  if (yesOnceOptions.length === 0) {
    yesOnceOptions = prompt.options.filter(opt =>
      opt.classification !== 'no' &&
      opt.classification !== 'yes_persist' &&
      opt.classification !== 'yes_session' &&
      !isPersistOption(opt) &&
      !/^(?:no\b|cancel\b|abort\b|reject\b|skip\b|exit\b|quit\b|dismiss\b|don'?t\b)/i.test((opt.text || '').replace(/^\s*(?:>\s*)?\d+[\.\)\-]?\s*/, '').trim()) &&
      /^(?:yes\b|allow\b|proceed\b|confirm\b|run\b|continue\b|execute\b|accept\b|ok\b)/i.test((opt.text || '').replace(/^\s*(?:>\s*)?\d+[\.\)\-]?\s*/, '').trim())
    );
  }
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
          let delay = allowRule.delay !== undefined
            ? allowRule.delay
            : (rules.defaultDelaySeconds || 3);
          if (dangerMatch && dangerMatch.level === 'slow') {
            const slowDelay = typeof dangerMatch.delay === 'number' && dangerMatch.delay > 0 ? dangerMatch.delay : 10;
            delay = Math.max(delay, slowDelay);
          }
          const optionKey = eligibleOption.key || String(eligibleOption.number);
          const allOptionRulesSkipped = enabledOptionRules.map(r => r.name);
          return {
            action: 'would_approve',
            delay,
            rule: allowRule.name,
            winningRule: allowRule.name,
            ruleList: ruleListType,
            skippedRules: allOptionRulesSkipped,
            ruleType: 'allowRule',
            optionKey,
            optionText: eligibleOption.text,
            slowDanger: dangerMatch ? dangerMatch.text : undefined,
            log: `Dry-run: would approve option ${optionKey} after ${delay}s (rule: ${allowRule.name})`
          };
        }
      }
    }
  }

  // 7. No allow rule matched or forbidden shell syntax
  const allOptionRulesSkipped = enabledOptionRules.map(r => r.name);
  return {
    action: 'needs_user',
    winningRule: null,
    ruleList: ruleListType,
    skippedRules: allOptionRulesSkipped,
    reason: hasForbiddenSyntax ? 'forbidden shell syntax' : 'no allow rule matched',
    log: hasForbiddenSyntax
      ? 'Dry-run: needs_user (forbidden shell syntax)'
      : 'Dry-run: needs_user (no allow rule matched)'
  };
}

/**
 * Validates the complete rules structure.
 * Returns { valid: boolean, errors: string[], sanitizedRules: object }.
 */
function validateAllRules(rules, options = {}) {
  const errors = [];
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
    return { valid: false, errors: ['Rules must be a JSON object'], sanitizedRules: null };
  }

  const sanitized = {
    defaultDelaySeconds: typeof rules.defaultDelaySeconds === 'number' && rules.defaultDelaySeconds > 0
      ? rules.defaultDelaySeconds
      : 3,
    deny: [],
    danger: [],
    allow: [],
    optionRules: []
  };

  // Deny list
  if (rules.deny !== undefined) {
    if (!Array.isArray(rules.deny)) {
      errors.push('deny must be an array of pattern strings');
    } else {
      // Must include all built-in deny rules unless unlockBuiltinDenyRules is enabled
      const unlockAllowed = Boolean(options && (options.unlockBuiltinDenyRules || options.allowUnlockBuiltin));
      if (!unlockAllowed) {
        for (const builtin of DEFAULT_RULES.deny) {
          if (!rules.deny.includes(builtin)) {
            errors.push(`Built-in deny rule "${builtin}" cannot be removed without enabling "Unlock built-in deny rules" in Settings. Built-in entries are locked to protect against critical or destructive operations. If the rule is too broad, it can be switched to whole-word matching or a narrow allow rule can be added for a specific command.`);
          }
        }
      }
      for (const item of rules.deny) {
        if (typeof item !== 'string' || item.trim().length < 2) {
          errors.push(`Invalid deny rule: "${item}" (must be at least 2 characters)`);
        } else {
          sanitized.deny.push(item.trim());
        }
      }
    }
  } else {
    sanitized.deny = DEFAULT_RULES.deny.slice();
  }

  // Danger list
  if (rules.danger !== undefined) {
    if (!Array.isArray(rules.danger)) {
      errors.push('danger must be an array of danger entries');
    } else {
      const ALLOWED_DANGER_KEYS = new Set(['text', 'wholeWord', 'level', 'delay', 'enabled']);
      for (let i = 0; i < rules.danger.length; i++) {
        const item = rules.danger[i];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          errors.push(`Danger entry #${i + 1} must be an object`);
          continue;
        }
        const unknownKeys = Object.keys(item).filter(k => !ALLOWED_DANGER_KEYS.has(k));
        if (unknownKeys.length > 0) {
          errors.push(`Danger entry #${i + 1} contains unknown properties: ${unknownKeys.join(', ')}`);
        }
        if (typeof item.text !== 'string' || item.text.trim().length < 2) {
          errors.push(`Danger entry #${i + 1} text must be at least 2 characters`);
        }
        if (item.level !== undefined && item.level !== 'hard' && item.level !== 'slow') {
          errors.push(`Danger entry #${i + 1} level must be either "hard" or "slow"`);
        }
        if (item.level === 'slow' && item.delay !== undefined && (typeof item.delay !== 'number' || item.delay <= 0)) {
          errors.push(`Danger entry #${i + 1} delay must be a positive number`);
        }
      }
      sanitized.danger = validateDangerList(rules.danger);
    }
  } else {
    sanitized.danger = DEFAULT_DANGER_LIST.map(e => ({ text: e.text, wholeWord: Boolean(e.wholeWord), level: 'hard', enabled: true }));
  }

  // Allow list
  if (rules.allow !== undefined) {
    if (!Array.isArray(rules.allow)) {
      errors.push('allow must be an array of allow rules');
    } else {
      sanitized.allow = rules.allow.slice();
    }
  } else {
    sanitized.allow = DEFAULT_RULES.allow.slice();
  }

  // Option rules
  if (rules.optionRules !== undefined) {
    if (!Array.isArray(rules.optionRules)) {
      errors.push('optionRules must be an array');
    } else {
      const ALLOWED_OPTION_KEYS = new Set(['name', 'startsWith', 'endsWith', 'commandStartsWith', 'enabled', 'allowPersist', 'promptTypes']);
      for (let i = 0; i < rules.optionRules.length; i++) {
        const item = rules.optionRules[i];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          errors.push(`Option rule #${i + 1} must be an object`);
          continue;
        }
        const unknownKeys = Object.keys(item).filter(k => !ALLOWED_OPTION_KEYS.has(k));
        if (unknownKeys.length > 0) {
          errors.push(`Option rule #${i + 1} contains unknown fields (${unknownKeys.join(', ')})`);
        }
        if (typeof item.name !== 'string' || item.name.trim() === '') {
          errors.push(`Option rule #${i + 1} name cannot be empty`);
        }
        if (typeof item.startsWith !== 'string' || item.startsWith.trim().length < 3) {
          errors.push(`Option rule "${item.name || i + 1}" startsWith must be at least 3 characters`);
        } else if (/^(?:no\b|cancel\b|abort\b|reject\b)/i.test(item.startsWith.trim())) {
          errors.push(`Option rule "${item.name || i + 1}" cannot match 'No' options`);
        }
        if (item.endsWith !== undefined && (typeof item.endsWith !== 'string' || item.endsWith.trim() === '')) {
          errors.push(`Option rule "${item.name || i + 1}" endsWith cannot be empty`);
        }
        if (item.commandStartsWith !== undefined && (typeof item.commandStartsWith !== 'string' || item.commandStartsWith.trim() === '')) {
          errors.push(`Option rule "${item.name || i + 1}" commandStartsWith cannot be empty`);
        }
      }
      sanitized.optionRules = validateOptionRules(rules.optionRules);
    }
  } else {
    sanitized.optionRules = (DEFAULT_RULES.optionRules || []).slice();
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitizedRules: sanitized
  };
}

/**
 * Detects whether newRules loosens safety compared to oldRules:
 * 1. A new or edited option rule with no commandStartsWith
 * 2. A rule that matches a persist option or sets allowPersist true (requires typing "PERSIST")
 * 3. Removing or disabling a hard danger entry
 * 4. Enabling a tier-2 allow rule
 * 5. Shortening a slow-danger delay
 */
function detectLoosening(oldRules, newRules) {
  const oldOptionRules = Array.isArray(oldRules?.optionRules) ? oldRules.optionRules : [];
  const newOptionRules = Array.isArray(newRules?.optionRules) ? newRules.optionRules : [];
  const oldDanger = Array.isArray(oldRules?.danger) ? oldRules.danger : DEFAULT_DANGER_LIST;
  const newDanger = Array.isArray(newRules?.danger) ? newRules.danger : [];
  const oldAllow = Array.isArray(oldRules?.allow) ? oldRules.allow : DEFAULT_RULES.allow;
  const newAllow = Array.isArray(newRules?.allow) ? newRules.allow : [];

  const items = [];
  let requiresPersistConfirmation = false;

  // 1. New or edited option rule with no commandStartsWith
  const oldRuleMap = new Map();
  for (const r of oldOptionRules) {
    if (r && r.name) oldRuleMap.set(r.name, r);
  }

  for (const newRule of newOptionRules) {
    if (!newRule || newRule.enabled === false) continue;
    const oldRule = oldRuleMap.get(newRule.name);
    const isNew = !oldRule;
    const isEdited = oldRule && (
      oldRule.startsWith !== newRule.startsWith ||
      oldRule.endsWith !== newRule.endsWith ||
      oldRule.commandStartsWith !== newRule.commandStartsWith ||
      Boolean(oldRule.allowPersist) !== Boolean(newRule.allowPersist)
    );

    const hasCommandScope = !newRule.promptTypes || newRule.promptTypes.includes('command') || newRule.promptTypes.includes('run_command');
    if ((isNew || isEdited) && hasCommandScope && (!newRule.commandStartsWith || newRule.commandStartsWith.trim() === '')) {
      items.push(`Option rule "${newRule.name}" has no command prefix restriction (applies to all commands)`);
    }

    // 2. A rule that matches a persist option or sets allowPersist true
    const setsPersist = newRule.allowPersist === true && (!oldRule || !oldRule.allowPersist);
    const matchesPersist = isPersistOption({ text: newRule.startsWith });
    if (setsPersist || matchesPersist) {
      items.push(`Option rule "${newRule.name}" allows persisting permissions or matches persist options`);
      requiresPersistConfirmation = true;
    }
  }

  // 3. Removing or disabling a hard danger entry
  for (const oldEntry of oldDanger) {
    if (!oldEntry || oldEntry.enabled === false || oldEntry.level === 'slow') continue;
    const matchingNew = newDanger.find(e => e && e.text.toLowerCase() === oldEntry.text.toLowerCase());
    if (!matchingNew) {
      items.push(`Removed hard danger entry "${oldEntry.text}"`);
    } else if (matchingNew.enabled === false) {
      items.push(`Disabled hard danger entry "${oldEntry.text}"`);
    } else if (matchingNew.level === 'slow') {
      items.push(`Downgraded danger entry "${oldEntry.text}" from hard stop to slow down`);
    }
  }

  // 4. Enabling a tier-2 allow rule
  const oldAllowMap = new Map();
  for (const a of oldAllow) {
    if (a && a.name) oldAllowMap.set(a.name, a);
  }

  for (const newA of newAllow) {
    if (!newA || newA.enabled !== true) continue;
    const oldA = oldAllowMap.get(newA.name);
    if (!oldA || oldA.enabled === false) {
      items.push(`Enabled tier-2 allow rule "${newA.name}"`);
    }
  }

  // 5. Shortening a slow-danger delay
  for (const oldEntry of oldDanger) {
    if (!oldEntry || oldEntry.level !== 'slow' || oldEntry.enabled === false) continue;
    const matchingNew = newDanger.find(e => e && e.text.toLowerCase() === oldEntry.text.toLowerCase());
    if (matchingNew && matchingNew.level === 'slow' && matchingNew.enabled !== false) {
      const oldDelay = typeof oldEntry.delay === 'number' ? oldEntry.delay : 10;
      const newDelay = typeof matchingNew.delay === 'number' ? matchingNew.delay : 10;
      if (newDelay < oldDelay) {
        items.push(`Shortened delay for slow danger entry "${oldEntry.text}" from ${oldDelay}s to ${newDelay}s`);
      }
    }
  }

  // 6. Removing a deny rule
  if (Array.isArray(oldRules?.deny) && Array.isArray(newRules?.deny)) {
    for (const oldD of oldRules.deny) {
      if (!newRules.deny.includes(oldD)) {
        items.push(`Removed deny rule "${oldD}"`);
      }
    }
  }

  return {
    isLooser: items.length > 0,
    items,
    requiresPersistConfirmation
  };
}

/**
 * Saves rules atomically: writes to temp file then renames.
 * Retains up to 10 newest timestamped backups.
 * Appends change summary to rules-changes.log.
 */
function saveRules(newRules, customPath, options = {}) {
  const targetPath = customPath || CANONICAL_RULES_PATH;
  const changeSummary = typeof options === 'string' ? options : (options && options.changeSummary);
  const unlockBuiltinDenyRules = typeof options === 'object' && Boolean(options.unlockBuiltinDenyRules || options.allowUnlockBuiltin);
  const validation = validateAllRules(newRules, { strict: true, unlockBuiltinDenyRules });
  if (!validation.valid) {
    const err = new Error(`Cannot save rules: ${validation.errors.join('; ')}`);
    err.validationErrors = validation.errors;
    throw err;
  }

  const backupsDir = getRulesBackupsDir();
  try {
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }
  } catch (e) {}

  // 1. Keep timestamped backup if target file exists
  if (fs.existsSync(targetPath)) {
    try {
      const currentContent = fs.readFileSync(targetPath, 'utf8');
      const backupFilename = `rules-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      const backupFilePath = path.join(backupsDir, backupFilename);
      fs.writeFileSync(backupFilePath, currentContent, 'utf8');

      // Keep only newest 10 backups
      const allBackups = fs.readdirSync(backupsDir)
        .filter(f => f.startsWith('rules-') && f.endsWith('.json'))
        .sort((a, b) => b.localeCompare(a));

      if (allBackups.length > 10) {
        for (let i = 10; i < allBackups.length; i++) {
          try {
            fs.unlinkSync(path.join(backupsDir, allBackups[i]));
          } catch (e) {}
        }
      }
    } catch (e) {
      console.warn(`agentwatch: warning: could not create rules backup: ${e.message}`);
    }
  }

  // 2. Atomic write
  const targetDir = path.dirname(targetPath);
  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
  } catch (e) {}

  const tempFilePath = path.join(targetDir, `.rules.${Date.now()}.${process.pid}.tmp`);
  fs.writeFileSync(tempFilePath, JSON.stringify(validation.sanitizedRules, null, 2), 'utf8');
  fs.renameSync(tempFilePath, targetPath);

  // 3. Append to ~/.agentwatch/rules-changes.log with no secrets
  try {
    const logPath = getRulesChangesLogPath();
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logEntry = JSON.stringify({
      time: new Date().toISOString(),
      what: changeSummary || 'rules saved via gui',
      who: (typeof options === 'object' && options.who) || 'gui'
    }) + '\n';
    fs.appendFileSync(logPath, logEntry, 'utf8');
  } catch (e) {}

  return { success: true, path: targetPath };
}

/**
 * Returns available timestamped rules backups sorted newest first.
 */
function getRulesBackups(customBackupDir) {
  const dir = customBackupDir || getRulesBackupsDir();
  if (!fs.existsSync(dir)) return [];
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith('rules-') && f.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a));
    return files.map(name => {
      try {
        const stat = fs.statSync(path.join(dir, name));
        return {
          name,
          time: stat.mtime.toISOString(),
          size: stat.size
        };
      } catch (e) {
        return { name, time: new Date().toISOString(), size: 0 };
      }
    });
  } catch (e) {
    return [];
  }
}

/**
 * Restores a previous backup atomically.
 */
function restoreRulesBackup(backupName, customPath, customBackupDir) {
  if (!backupName || typeof backupName !== 'string') {
    throw new Error('Invalid backup name');
  }
  const safeName = path.basename(backupName);
  if (safeName !== backupName || !safeName.endsWith('.json')) {
    throw new Error('Invalid backup filename');
  }
  const dir = customBackupDir || getRulesBackupsDir();
  const backupFile = path.join(dir, safeName);
  if (!fs.existsSync(backupFile)) {
    throw new Error(`Backup file not found: ${safeName}`);
  }
  const raw = fs.readFileSync(backupFile, 'utf8');
  const parsed = JSON.parse(raw);
  return saveRules(parsed, customPath, { changeSummary: `Restored backup: ${safeName}` });
}

/**
 * Resets the danger list to factory defaults.
 */
function resetDangerList(customPath) {
  const current = loadRules(customPath);
  current.danger = DEFAULT_DANGER_LIST.map(e => ({
    text: e.text,
    wholeWord: Boolean(e.wholeWord),
    level: 'hard',
    enabled: true
  }));
  return saveRules(current, customPath, { changeSummary: 'Reset danger list to defaults' });
}

/**
 * Resets the deny list to factory defaults.
 */
function resetDenyList(customPath) {
  const current = loadRules(customPath);
  current.deny = DEFAULT_RULES.deny.slice();
  return saveRules(current, customPath, { changeSummary: 'Reset deny list to defaults' });
}

/**
 * Resets all rules to factory defaults.
 */
function resetAllRules(customPath) {
  const defaults = {
    defaultDelaySeconds: 3,
    deny: DEFAULT_RULES.deny.slice(),
    danger: DEFAULT_DANGER_LIST.map(e => ({ text: e.text, wholeWord: Boolean(e.wholeWord), level: 'hard', enabled: true })),
    allow: DEFAULT_RULES.allow.slice(),
    optionRules: (DEFAULT_RULES.optionRules || []).slice()
  };
  return saveRules(defaults, customPath, { changeSummary: 'Reset all rules to defaults' });
}

/**
 * Validates folder rules structure.
 * Global danger and deny rules can never be weakened or removed.
 */
function validateFolderRules(rules, globalRules, options = {}) {
  const baseRules = globalRules || loadRules();
  const errors = [];
  if (!rules || typeof rules !== 'object' || Array.isArray(rules)) {
    return { valid: false, errors: ['Folder rules must be a JSON object'], sanitizedRules: null };
  }

  const ALLOWED_TOP_KEYS = new Set(['optionRules', 'danger', 'deny']);
  for (const k of Object.keys(rules)) {
    if (!ALLOWED_TOP_KEYS.has(k)) {
      errors.push(`Folder rules contains unknown property "${k}"`);
    }
  }

  const sanitized = {
    optionRules: []
  };

  // Option rules
  if (rules.optionRules !== undefined) {
    if (!Array.isArray(rules.optionRules)) {
      errors.push('optionRules must be an array');
    } else {
      const ALLOWED_OPTION_KEYS = new Set(['name', 'startsWith', 'endsWith', 'commandStartsWith', 'enabled', 'allowPersist', 'promptTypes']);
      for (let i = 0; i < rules.optionRules.length; i++) {
        const item = rules.optionRules[i];
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
          errors.push(`Option rule #${i + 1} must be an object`);
          continue;
        }
        const unknownKeys = Object.keys(item).filter(k => !ALLOWED_OPTION_KEYS.has(k));
        if (unknownKeys.length > 0) {
          errors.push(`Option rule #${i + 1} contains unknown fields (${unknownKeys.join(', ')})`);
        }
        if (typeof item.name !== 'string' || item.name.trim() === '') {
          errors.push(`Option rule #${i + 1} name cannot be empty`);
        }
        if (typeof item.startsWith !== 'string' || item.startsWith.trim().length < 3) {
          errors.push(`Option rule "${item.name || i + 1}" startsWith must be at least 3 characters`);
        } else if (/^(?:no\b|cancel\b|abort\b|reject\b)/i.test(item.startsWith.trim())) {
          errors.push(`Option rule "${item.name || i + 1}" cannot match 'No' options`);
        }
        if (item.endsWith !== undefined && (typeof item.endsWith !== 'string' || item.endsWith.trim() === '')) {
          errors.push(`Option rule "${item.name || i + 1}" endsWith cannot be empty`);
        }
        if (item.commandStartsWith !== undefined && (typeof item.commandStartsWith !== 'string' || item.commandStartsWith.trim() === '')) {
          errors.push(`Option rule "${item.name || i + 1}" commandStartsWith cannot be empty`);
        }
      }
      sanitized.optionRules = validateOptionRules(rules.optionRules);
    }
  } else {
    sanitized.optionRules = [];
  }

  // Deny list
  if (rules.deny !== undefined) {
    if (!Array.isArray(rules.deny)) {
      errors.push('deny must be an array');
    } else {
      const globalDeny = baseRules.deny || DEFAULT_RULES.deny;
      const unlockAllowed = Boolean(options && (options.unlockBuiltinDenyRules || options.allowUnlockBuiltin));
      if (!unlockAllowed) {
        for (const b of globalDeny) {
          if (!rules.deny.includes(b)) {
            errors.push(`Folder rules cannot remove global deny rule "${b}" without enabling "Unlock built-in deny rules" in Settings`);
          }
        }
      }
      sanitized.deny = rules.deny.slice();
    }
  }

  // Danger list
  if (rules.danger !== undefined) {
    if (!Array.isArray(rules.danger)) {
      errors.push('danger must be an array');
    } else {
      const validatedDanger = validateDangerList(rules.danger);
      const globalDanger = baseRules.danger || DEFAULT_DANGER_LIST;
      for (const gd of globalDanger) {
        if (!gd || gd.enabled === false) continue;
        const matching = validatedDanger.find(e => e.text.toLowerCase() === gd.text.toLowerCase());
        if (!matching) {
          errors.push(`Folder rules cannot remove global danger entry "${gd.text}"`);
        } else if (matching.enabled === false) {
          errors.push(`Folder rules cannot disable global danger entry "${gd.text}"`);
        } else if (gd.level !== 'slow' && matching.level === 'slow') {
          errors.push(`Folder rules cannot weaken global danger entry "${gd.text}" from hard stop to slow down`);
        } else if (gd.level === 'slow' && matching.level === 'slow') {
          const gdDelay = typeof gd.delay === 'number' ? gd.delay : 10;
          const fdDelay = typeof matching.delay === 'number' ? matching.delay : 10;
          if (fdDelay < gdDelay) {
            errors.push(`Folder rules cannot shorten delay for global danger entry "${gd.text}" below ${gdDelay}s`);
          }
        }
      }
      sanitized.danger = validatedDanger;
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitizedRules: sanitized
  };
}

/**
 * Loads folder choices map from disk.
 */
function loadFolderChoices(customPath) {
  const p = customPath || getFolderChoicesPath();
  if (fs.existsSync(p)) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      return JSON.parse(raw) || {};
    } catch (e) {
      return {};
    }
  }
  return {};
}

/**
 * Saves a choice for a folder key atomically.
 */
function saveFolderChoice(folderKey, data, customPath) {
  const p = customPath || getFolderChoicesPath();
  const choices = loadFolderChoices(p);
  choices[folderKey] = {
    ...(choices[folderKey] || {}),
    ...data,
    time: new Date().toISOString()
  };
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = path.join(dir, `.choices.${Date.now()}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(choices, null, 2), 'utf8');
  try {
    fs.renameSync(tmp, p);
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EEXIST')) {
      try { fs.unlinkSync(p); } catch (_) {}
      fs.renameSync(tmp, p);
    } else {
      throw err;
    }
  }
  return choices[folderKey];
}

/**
 * Increments dismissal count for folder question.
 * Stops asking after 2 dismissals (leaves defaults).
 */
function dismissFolderQuestion(folderKey, customPath) {
  const p = customPath || getFolderChoicesPath();
  const choices = loadFolderChoices(p);
  const current = choices[folderKey] || {};
  const dismissCount = (current.dismissCount || 0) + 1;
  const update = {
    ...current,
    dismissCount,
    time: new Date().toISOString()
  };
  if (dismissCount >= 2) {
    update.choice = 'declined';
  }
  return saveFolderChoice(folderKey, update, p);
}

/**
 * Checks whether a folder has its own rule file.
 */
function hasFolderRules(folderKey, customDir) {
  if (!folderKey) return false;
  const p = getFolderRulesPath(folderKey, customDir);
  return fs.existsSync(p);
}

/**
 * Loads raw rules object from folder-rules/<folderKey>.json.
 */
function loadFolderRules(folderKey, customDir) {
  const p = getFolderRulesPath(folderKey, customDir);
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const stripped = raw.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === 'object') {
      if (parsed.optionRules !== undefined) {
        parsed.optionRules = validateOptionRules(parsed.optionRules);
      } else {
        parsed.optionRules = [];
      }
      if (parsed.danger !== undefined) {
        parsed.danger = validateDangerList(parsed.danger);
      }
      return parsed;
    }
  } catch (e) {
    console.warn(`agentwatch: warning: could not load folder rules from "${p}": ${e.message}`);
  }
  return null;
}

/**
 * Deletes folder rules file (resetting folder to default rules).
 */
function deleteFolderRules(folderKey, customDir) {
  const p = getFolderRulesPath(folderKey, customDir);
  if (fs.existsSync(p)) {
    try {
      fs.unlinkSync(p);
    } catch (e) {
      console.warn(`agentwatch: warning: could not delete folder rules "${p}": ${e.message}`);
    }
  }
  try {
    const logPath = getRulesChangesLogPath();
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logEntry = JSON.stringify({
      time: new Date().toISOString(),
      what: `Reset folder rules to default rules for ${folderKey}`,
      who: 'gui',
      folderKey: folderKey
    }) + '\n';
    fs.appendFileSync(logPath, logEntry, 'utf8');
  } catch (e) {}

  return { success: true };
}

/**
 * Returns timestamped backups for a folder rules file.
 */
function getFolderRulesBackups(folderKey, customBackupDir) {
  const dir = customBackupDir || getFolderRulesBackupsDir(folderKey);
  if (!fs.existsSync(dir)) return [];
  try {
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith('rules-') && f.endsWith('.json'))
      .sort((a, b) => b.localeCompare(a));
    return files.map(name => {
      try {
        const stat = fs.statSync(path.join(dir, name));
        return { name, time: stat.mtime.toISOString(), size: stat.size };
      } catch (e) {
        return { name, time: new Date().toISOString(), size: 0 };
      }
    });
  } catch (e) {
    return [];
  }
}

/**
 * Restores a folder rules backup atomically.
 */
function restoreFolderRulesBackup(folderKey, backupName, customDir, customBackupDir) {
  if (!backupName || typeof backupName !== 'string') {
    throw new Error('Invalid backup name');
  }
  const safeName = path.basename(backupName);
  if (safeName !== backupName || !safeName.endsWith('.json')) {
    throw new Error('Invalid backup filename');
  }
  const dir = customBackupDir || getFolderRulesBackupsDir(folderKey);
  const backupFile = path.join(dir, safeName);
  if (!fs.existsSync(backupFile)) {
    throw new Error(`Backup file not found: ${safeName}`);
  }
  const raw = fs.readFileSync(backupFile, 'utf8');
  const parsed = JSON.parse(raw);
  return saveFolderRules(folderKey, parsed, {
    customDir,
    changeSummary: `Restored backup: ${safeName}`
  });
}

/**
 * Saves folder rules atomically: writes to temp file then renames.
 * Retains up to 10 newest timestamped backups.
 * Appends change summary to rules-changes.log with folderKey (never raw path).
 */
function saveFolderRules(folderKey, newRules, options = {}) {
  const customDir = options.customDir || getFolderRulesDir();
  const targetPath = options.customPath || getFolderRulesPath(folderKey, customDir);
  const globalRules = options.globalRules || loadRules(options.globalRulesPath);

  const validation = validateFolderRules(newRules, globalRules, {
    unlockBuiltinDenyRules: Boolean(options.unlockBuiltinDenyRules || options.allowUnlockBuiltin)
  });
  if (!validation.valid) {
    const err = new Error(`Cannot save folder rules: ${validation.errors.join('; ')}`);
    err.validationErrors = validation.errors;
    throw err;
  }

  const targetDir = path.dirname(targetPath);
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Backup previous file if it existed
  const backupsDir = options.customBackupDir || getFolderRulesBackupsDir(folderKey);
  if (fs.existsSync(targetPath)) {
    try {
      if (!fs.existsSync(backupsDir)) {
        fs.mkdirSync(backupsDir, { recursive: true });
      }
      const currentContent = fs.readFileSync(targetPath, 'utf8');
      const backupFilename = `rules-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      fs.writeFileSync(path.join(backupsDir, backupFilename), currentContent, 'utf8');

      const allBackups = fs.readdirSync(backupsDir)
        .filter(f => f.startsWith('rules-') && f.endsWith('.json'))
        .sort((a, b) => b.localeCompare(a));
      if (allBackups.length > 10) {
        for (let i = 10; i < allBackups.length; i++) {
          try { fs.unlinkSync(path.join(backupsDir, allBackups[i])); } catch (e) {}
        }
      }
    } catch (e) {
      console.warn(`agentwatch: warning: could not create folder rules backup: ${e.message}`);
    }
  }

  // Atomic write
  const tempFilePath = path.join(targetDir, `.rules.${safeFolderKeyBase(folderKey)}.${Date.now()}.${process.pid}.tmp`);
  fs.writeFileSync(tempFilePath, JSON.stringify(validation.sanitizedRules, null, 2), 'utf8');
  try {
    fs.renameSync(tempFilePath, targetPath);
  } catch (err) {
    if (process.platform === 'win32' && (err.code === 'EPERM' || err.code === 'EEXIST')) {
      try { fs.unlinkSync(targetPath); } catch (_) {}
      fs.renameSync(tempFilePath, targetPath);
    } else {
      throw err;
    }
  }

  // Append to rules-changes.log with folderKey (NEVER raw path!)
  try {
    const logPath = getRulesChangesLogPath();
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logEntry = JSON.stringify({
      time: new Date().toISOString(),
      what: options.changeSummary || `folder rules saved for ${folderKey}`,
      who: options.who || 'gui',
      folderKey: folderKey
    }) + '\n';
    fs.appendFileSync(logPath, logEntry, 'utf8');
  } catch (e) {}

  return { success: true, path: targetPath };
}

/**
 * Copies option rules from ancestor folder into folder's own list.
 * Snapshot copy (deep clone, not link).
 * Rules with allowPersist: true are skipped and counted.
 */
function copyAncestorRules(folderKey, ancestorKey, options = {}) {
  const ancestorRules = loadFolderRules(ancestorKey, options.customDir);
  if (!ancestorRules) {
    throw new Error(`Ancestor rules not found for key: ${ancestorKey}`);
  }
  const rawRules = ancestorRules.optionRules || [];
  let skippedPersistCount = 0;
  const copiedRules = [];

  for (const r of rawRules) {
    if (r.allowPersist === true) {
      skippedPersistCount++;
    } else {
      // Deep snapshot clone
      copiedRules.push({ ...r });
    }
  }

  const newFolderRules = {
    optionRules: copiedRules
  };
  if (ancestorRules.danger && Array.isArray(ancestorRules.danger)) {
    newFolderRules.danger = ancestorRules.danger.map(d => ({ ...d }));
  }

  saveFolderRules(folderKey, newFolderRules, {
    customDir: options.customDir,
    changeSummary: `Copied ${copiedRules.length} rules from ancestor ${ancestorKey} (skipped ${skippedPersistCount} allowPersist rules)`
  });

  saveFolderChoice(folderKey, {
    choice: 'copied',
    ancestorKey,
    copiedCount: copiedRules.length,
    skippedPersistCount
  }, options.customChoicesPath);

  return {
    success: true,
    copiedCount: copiedRules.length,
    skippedPersistCount,
    rules: newFolderRules
  };
}

/**
 * Loads effective rules for a folder key:
 * If folder has own list: uses folder's optionRules, merges danger/deny with global rules,
 * marks isFolderRuleSet: true.
 * If folder has NO own list: uses default rules directly (isFolderRuleSet: false).
 */
function loadRulesForFolder(folderKey, defaultRulesPath, folderRulesDir) {
  const globalRules = loadRules(defaultRulesPath);
  if (!folderKey) {
    return globalRules;
  }
  if (!hasFolderRules(folderKey, folderRulesDir)) {
    return globalRules;
  }
  const folderRules = loadFolderRules(folderKey, folderRulesDir);
  if (!folderRules) {
    return globalRules;
  }

  // Merge danger: global danger cannot be weakened
  const mergedDanger = (globalRules.danger || DEFAULT_DANGER_LIST).map(d => ({ ...d }));
  if (Array.isArray(folderRules.danger)) {
    for (const fd of folderRules.danger) {
      if (!fd || typeof fd.text !== 'string') continue;
      const existing = mergedDanger.find(g => g.text.toLowerCase() === fd.text.toLowerCase());
      if (!existing) {
        mergedDanger.push({ ...fd });
      }
    }
  }

  return {
    ...globalRules,
    optionRules: (folderRules.optionRules || []).slice(),
    danger: mergedDanger,
    isFolderRuleSet: true,
    folderKey
  };
}

/**
 * Appends an entry to ~/.agentwatch/rules-changes.log.
 */
function logRulesChange(what, options = {}) {
  try {
    const logPath = options.logPath || getRulesChangesLogPath();
    const logDir = path.dirname(logPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logEntry = JSON.stringify({
      time: new Date().toISOString(),
      what: String(what || 'rules change'),
      who: options.who || 'gui',
      ...(options.entry ? { entry: options.entry } : {}),
      ...(options.folderKey ? { folderKey: options.folderKey } : {})
    }) + '\n';
    fs.appendFileSync(logPath, logEntry, 'utf8');
    return true;
  } catch (e) {
    return false;
  }
}

const BUILTIN_DENY_PATTERNS = new Set(DEFAULT_RULES.deny.map(p => p.toLowerCase()));

function isBuiltinDenyRule(pattern) {
  if (!pattern || typeof pattern !== 'string') return false;
  return BUILTIN_DENY_PATTERNS.has(pattern.trim().toLowerCase());
}

function getLockedDenyExplanation(pattern) {
  return `Built-in deny rule "${pattern}" is locked to protect against critical or destructive operations. If it is too broad, the entry can be switched to whole-word matching or a narrow allow rule can be added for a specific command. To remove or edit built-in deny rules, turn on "Unlock built-in deny rules" in Settings.`;
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
  validateAllRules,
  validateFolderRules,
  matchesOptionRule,
  isPersistOption,
  detectLoosening,
  saveRules,
  getRulesBackups,
  restoreRulesBackup,
  resetDangerList,
  resetDenyList,
  resetAllRules,
  logRulesChange,
  isBuiltinDenyRule,
  getLockedDenyExplanation,
  getRulesBackupsDir,
  getRulesChangesLogPath,
  getFolderRulesDir,
  getFolderChoicesPath,
  safeFolderKeyBase,
  safeFolderKeyFilename,
  getFolderRulesPath,
  getFolderRulesBackupsDir,
  computeFolderAncestors,
  loadFolderChoices,
  saveFolderChoice,
  dismissFolderQuestion,
  hasFolderRules,
  loadFolderRules,
  deleteFolderRules,
  getFolderRulesBackups,
  restoreFolderRulesBackup,
  saveFolderRules,
  copyAncestorRules,
  loadRulesForFolder,
  resolveRulesPath,
  extractTargetFilePath,
  isPathSafelyInside,
  isSensitiveFile,
  getAgentwatchDir,
  CANONICAL_RULES_PATH,
  DEFAULT_DANGER_LIST,
  DEFAULT_RULES
};
