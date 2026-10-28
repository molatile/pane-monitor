const fs = require('fs');
const path = require('path');

const PROFILES_DIR = path.resolve(__dirname, '..', 'profiles');

let cachedProfiles = null;

/**
 * Loads all profiles from profiles/ directory.
 */
function loadAllProfiles() {
  if (cachedProfiles) return cachedProfiles;
  const profiles = {};
  if (fs.existsSync(PROFILES_DIR)) {
    const files = fs.readdirSync(PROFILES_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        try {
          const content = fs.readFileSync(path.join(PROFILES_DIR, file), 'utf8');
          const profile = JSON.parse(content);
          profiles[profile.id || path.basename(file, '.json')] = profile;
        } catch (e) {
          // ignore malformed profile files
        }
      }
    }
  }
  cachedProfiles = profiles;
  return profiles;
}

/**
 * Finds matching profile for a given command string or returns null if no matching profile exists.
 */
function getProfileForCommand(commandName) {
  if (!commandName) return null;
  const profiles = loadAllProfiles();
  const baseName = path.basename(commandName).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
  for (const profile of Object.values(profiles)) {
    if (profile.commandNames && profile.commandNames.map(c => c.toLowerCase()).includes(baseName)) {
      return profile;
    }
  }
  // Also check direct profile id match
  if (profiles[baseName]) {
    return profiles[baseName];
  }
  return null;
}

/**
 * Returns formatted notice when an agent has no matching profile.
 */
function getNoProfileNotice(agentName) {
  return `No profile for ${agentName}: prompts won't be detected. Profiles can be added in profiles/`;
}

/**
 * Rule-based option classification according to specification:
 * - "yes_once" = starts with "Yes" and contains neither "always" nor "persist"
 * - "yes_session" = starts with "Yes" and contains "always allow in this conversation"
 * - "yes_persist" = contains "persist" or "settings.json"
 * - "no" = starts with "No"
 * - Any option that fits none is "unknown"
 */
function classifyOption(optionText, profile) {
  if (!optionText || typeof optionText !== 'string') {
    return 'unknown';
  }

  const text = optionText.trim();
  const lower = text.toLowerCase();

  // "yes_persist" = contains "persist" or "settings.json"
  if (lower.includes('persist') || lower.includes('settings.json')) {
    return 'yes_persist';
  }

  // "yes_session" = starts with "Yes" and contains "always allow in this conversation"
  if ((/^yes\b/i.test(text) || lower.startsWith('always')) && (lower.includes('always allow in this conversation') || lower.includes('for this session'))) {
    return 'yes_session';
  }

  // "yes_once" = starts with affirmative word and contains neither "always" nor "persist"
  if (/^(?:yes|allow|proceed|confirm|run|continue|execute|accept|ok)\b/i.test(text) && !lower.includes('always') && !lower.includes('persist')) {
    return 'yes_once';
  }

  // "no" = starts with negative word
  if (/^(?:no|cancel|abort|reject|skip|exit|quit|dismiss|don'?t)\b/i.test(text)) {
    return 'no';
  }

  return 'unknown';
}

module.exports = {
  loadAllProfiles,
  getProfileForCommand,
  getNoProfileNotice,
  classifyOption
};
