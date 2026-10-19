const { getProfileForCommand, classifyOption } = require('./profile');

/**
 * Parses visible terminal screen lines to detect permission prompts
 * using patterns and classification rules defined in the agent profile.
 *
 * @param {Array<{text: string, isWrapped?: boolean}>} screenLines
 * @param {Object} [profile] - Optional agent profile, defaults to agy
 */
function extractPromptFromScreen(screenLines, profile) {
  if (!screenLines || screenLines.length === 0) return null;

  const activeProfile = profile || getProfileForCommand('agy');
  const promptConfig = (activeProfile && activeProfile.prompt) ? activeProfile.prompt : {
    commandBlockStart: 'Requesting permission for:',
    questionPattern: 'Run this command\\?',
    footerPrefix: '↑/↓ Navigate',
    optionLinePattern: '^\\s*>?\\s*(\\d+)\\.\\s+(.*)$',
    minOptions: 2
  };

  const blockStartRegex = new RegExp(promptConfig.commandBlockStart, 'i');
  const questionRegex = new RegExp(promptConfig.questionPattern, 'i');
  const optionRegex = new RegExp(promptConfig.optionLinePattern || '^\\s*>?\\s*(\\d+)\\.\\s+(.*)$');
  const footerPrefix = promptConfig.footerPrefix || '↑/↓ Navigate';
  const minOptions = promptConfig.minOptions !== undefined ? promptConfig.minOptions : 2;

  // 1. Locate command block start (e.g. "Requesting permission for:") searching bottom-up
  let reqIndex = -1;
  for (let i = screenLines.length - 1; i >= 0; i--) {
    if (screenLines[i] && blockStartRegex.test(screenLines[i].text)) {
      reqIndex = i;
      break;
    }
  }
  if (reqIndex === -1) return null;

  // 2. Locate question line (e.g. "Run this command?") after command block start
  let qIndex = -1;
  for (let i = reqIndex + 1; i < screenLines.length; i++) {
    if (screenLines[i] && questionRegex.test(screenLines[i].text)) {
      qIndex = i;
      break;
    }
  }
  if (qIndex === -1) return null;

  // 3. Command field: lines between command block start and question
  const rawCmdLines = screenLines.slice(reqIndex + 1, qIndex);
  const cmdLineTexts = rawCmdLines
    .map(l => (l && l.text ? l.text.trimEnd() : ''))
    .filter(t => t.trim() !== '');

  // "Command (spaced):" joins wrapped lines with a single space
  const commandSpaced = cmdLineTexts
    .map(t => t.trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();

  // "Command (compact):" joins them with all whitespace removed
  const commandCompact = cmdLineTexts
    .map(t => t.replace(/\s+/g, ''))
    .join('');

  const question = screenLines[qIndex].text.trimEnd().trim();

  // 4. Option parsing:
  // An option starts at a line matching optionRegex (number and text).
  // Following lines belong to that option until next option or footer.
  const rawOptions = [];
  let currentOption = null;
  let footerSeen = false;

  for (let i = qIndex + 1; i < screenLines.length; i++) {
    const lineObj = screenLines[i];
    if (!lineObj) continue;
    const lineText = lineObj.text.trimEnd();
    const trimmed = lineText.trim();

    // Check footer prefix: e.g. "↑/↓ Navigate" or regex
    if (
      trimmed.startsWith(footerPrefix) ||
      (footerPrefix.includes('Navigate') && /^[↑^]\/[↓v]?\s*Navigate/i.test(trimmed))
    ) {
      footerSeen = true;
      break;
    }

    if (trimmed.startsWith('esc to cancel')) {
      continue;
    }

    const match = lineText.match(optionRegex);
    if (match) {
      const key = match[1];
      const num = parseInt(key, 10);
      const optText = match[2] ? match[2].trim() : '';
      currentOption = { key, number: num, text: optText };
      rawOptions.push(currentOption);
    } else if (currentOption) {
      if (trimmed === '') {
        continue;
      }
      currentOption.text += ' ' + trimmed;
    }
  }

  // Only complete if footer line was seen and at least minOptions exist
  if (!footerSeen || rawOptions.length < minOptions) {
    return null;
  }

  // Ensure consecutive option numbering 1..N
  for (let idx = 0; idx < rawOptions.length; idx++) {
    if (rawOptions[idx].number !== idx + 1) {
      return null;
    }
  }

  // Classify each option using profile rules
  const options = rawOptions.map(o => {
    const cleanedText = o.text.replace(/\s+/g, ' ').trim();
    const classification = classifyOption(cleanedText, activeProfile);
    return {
      key: o.key || String(o.number),
      number: o.number,
      text: cleanedText,
      classification
    };
  });

  return {
    command: commandSpaced,
    commandSpaced,
    commandCompact,
    question,
    options,
    footerSeen: true
  };
}

module.exports = {
  extractPromptFromScreen
};
