const fs = require('fs');
const path = require('path');
const os = require('os');
const { getProfileForCommand, classifyOption } = require('./profile');
const { maskText } = require('./masker');
const { extractTargetFilePath } = require('./rules');

/**
 * Checks if a string line is a separator line (composed of 3+ separator characters).
 */
function isSeparatorLine(line) {
  if (!line) return false;
  const text = typeof line === 'string' ? line : (line && line.text ? line.text : '');
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  return /^[─\-_=~*—\s]+$/.test(trimmed) && trimmed.replace(/\s+/g, '').length >= 3;
}

/**
 * Checks if a string line is a navigation or status footer line.
 * Matches standard Antigravity navigation footers, arrows, "/ Navigate",
 * status indicators (accept-edits, Gemini model, etc.), and shortcuts.
 */
function isFooterLine(line, footerPrefix) {
  if (!line) return false;
  const text = typeof line === 'string' ? line : (line && line.text ? line.text : '');
  const trimmed = text.trim();
  if (!trimmed) return false;

  if (footerPrefix) {
    if (trimmed.startsWith(footerPrefix) || new RegExp(footerPrefix, 'i').test(trimmed)) {
      return true;
    }
  }

  // Navigation commands & shortcuts
  if (/^(?:[↑^]?\/[↓v]?\s*Navigate|\bnavigate\b|use\s+arrow\s+keys|press\s+enter|esc\s+to\s+cancel|tab\s+amend|ctrl\+[a-z]\s+edit|\? for shortcuts)/i.test(trimmed)) {
    return true;
  }

  if (/\bNavigate\b/i.test(trimmed) && (/\bAmend\b/i.test(trimmed) || /\bctrl\+[a-z]\b/i.test(trimmed) || /\/ Navigate\b/i.test(trimmed))) {
    return true;
  }

  if (/^esc\s+to\s+cancel/i.test(trimmed)) {
    return true;
  }

  return false;
}

const loggedUnknownSignatures = new Set();

/**
 * Appends a masked sample of an unrecognized prompt to ~/.agentwatch/unknown-prompts.log.
 * At most once per distinct sample, keeping the file under 200 KB.
 */
function appendUnknownPromptSample(sample, options = {}) {
  if (!sample || !sample.question || !Array.isArray(sample.options)) return false;

  const agentwatchDir = process.env.AGENTWATCH_DIR || path.join(os.homedir(), '.agentwatch');
  const logFilePath = options.unknownPromptsLogPath ||
    process.env.AGENTWATCH_UNKNOWN_PROMPTS_LOG ||
    path.join(agentwatchDir, 'unknown-prompts.log');

  const maskedQuestion = maskText(sample.question || '');
  const maskedContext = (sample.contextLines || []).slice(-10).map(l => maskText(typeof l === 'string' ? l : (l?.text || '')));
  const maskedOptions = (sample.options || []).map(o => {
    const num = o.key || o.number || '';
    const txt = typeof o === 'string' ? o : (o.text || '');
    return `${num ? num + '. ' : ''}${maskText(txt)}`;
  });

  const distinctSignature = `${maskedQuestion.trim()}:::${maskedOptions.map(o => o.trim()).join('|')}`;
  if (loggedUnknownSignatures.has(distinctSignature)) {
    return false;
  }

  try {
    const dir = path.dirname(logFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let existingContent = '';
    if (fs.existsSync(logFilePath)) {
      existingContent = fs.readFileSync(logFilePath, 'utf8');
      if (existingContent.includes(distinctSignature)) {
        loggedUnknownSignatures.add(distinctSignature);
        return false;
      }
    }

    const timestamp = new Date().toISOString();
    let entry = `[${timestamp}] UNRECOGNIZED PROMPT\n`;
    entry += `Signature: ${distinctSignature}\n`;
    entry += `Question: ${maskedQuestion}\n`;
    if (maskedContext.length > 0) {
      entry += `Context:\n`;
      for (const cl of maskedContext) {
        entry += `  ${cl}\n`;
      }
    }
    entry += `Options:\n`;
    for (const opt of maskedOptions) {
      entry += `  ${opt}\n`;
    }
    entry += `\n`;

    const MAX_SIZE = 200 * 1024; // 200 KB
    let combined = existingContent + entry;
    let buf = Buffer.from(combined, 'utf8');

    if (buf.length > MAX_SIZE) {
      // Trim oldest entries from beginning to keep under 200 KB
      while (buf.length > MAX_SIZE - 2048 && combined.includes('\n\n')) {
        const nextSep = combined.indexOf('\n[', 1);
        if (nextSep === -1) {
          combined = combined.slice(-Math.floor(MAX_SIZE * 0.75));
          break;
        }
        combined = combined.slice(nextSep + 1);
        buf = Buffer.from(combined, 'utf8');
      }
    }

    fs.writeFileSync(logFilePath, combined, 'utf8');
    loggedUnknownSignatures.add(distinctSignature);
    return true;
  } catch (err) {
    return false;
  }
}

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
  const lineTexts = screenLines.map(l => (typeof l === 'string' ? l : (l && l.text ? l.text : '')));

  // Resolve prompt types list from profile
  const defaultPromptTypes = [
    {
      name: 'command',
      contextStart: 'Requesting permission for:',
      questionPattern: 'Run this command\\??',
      footerPattern: '↑/↓ Navigate',
      optionLinePattern: '^\\s*>?\\s*(\\d+)\\.\\s+(.*)$',
      minOptions: 2
    },
    {
      name: 'file_edit',
      questionPattern: 'Accept this file edit\\??',
      optionLinePattern: '^\\s*>?\\s*(\\d+)\\.\\s+(.*)$',
      minOptions: 2
    }
  ];

  let promptTypes = [];
  if (activeProfile && Array.isArray(activeProfile.promptTypes) && activeProfile.promptTypes.length > 0) {
    promptTypes = activeProfile.promptTypes;
  } else if (activeProfile && activeProfile.prompt) {
    promptTypes = [
      {
        name: 'command',
        contextStart: activeProfile.prompt.commandBlockStart || activeProfile.prompt.contextStart,
        questionPattern: activeProfile.prompt.questionPattern,
        footerPattern: activeProfile.prompt.footerPrefix || activeProfile.prompt.footerPattern,
        optionLinePattern: activeProfile.prompt.optionLinePattern,
        minOptions: activeProfile.prompt.minOptions
      }
    ];
  } else {
    promptTypes = defaultPromptTypes;
  }

  let matchedConfiguredQuestion = false;

  // Try each configured prompt type in order
  for (const pt of promptTypes) {
    const rawQPattern = pt.questionPattern || pt.question;
    if (!rawQPattern) continue;

    // Allow the question to end with optional "?"
    const baseQPattern = rawQPattern.replace(/(?:\\\\\?|\\\?|\?)+$/, '');
    const qPatternStr = baseQPattern + '\\??';
    const questionRegex = new RegExp(qPatternStr, 'i');

    const contextStartPattern = pt.contextStart || pt.contextStartPattern || pt.contextStartLine || pt.contextBlockStart || pt.commandBlockStart;
    const optionRegex = new RegExp(pt.optionLinePattern || pt.optionPattern || '^\\s*>?\\s*(\\d+)\\.\\s+(.*)$');
    const footerPrefix = pt.footerPattern || pt.footerPrefix;
    const minOptions = pt.minOptions !== undefined ? pt.minOptions : 2;

    // Locate question line
    let qIndex = -1;
    let reqIndex = -1;

    for (let i = lineTexts.length - 1; i >= 0; i--) {
      const tr = lineTexts[i].trim();
      // Agent reply text never counts (e.g. lines starting with markdown bullets/lists)
      if (/^[*•\-+#]/.test(tr)) {
        continue;
      }
      if (questionRegex.test(tr)) {
        qIndex = i;
        break;
      }
    }

    if (qIndex === -1) {
      continue;
    }

    if (contextStartPattern) {
      const csRegex = new RegExp(contextStartPattern, 'i');
      for (let i = qIndex - 1; i >= Math.max(0, qIndex - 40); i--) {
        if (isSeparatorLine(lineTexts[i])) break;
        if (csRegex.test(lineTexts[i])) {
          reqIndex = i;
          break;
        }
      }
    }

    // A configured question was found on screen!
    matchedConfiguredQuestion = true;

    // Capture context lines above question (up to 20 lines, stopping at previous separator line)
    const contextLines = [];
    const minLine = Math.max(0, qIndex - 20);
    for (let j = qIndex - 1; j >= minLine; j--) {
      const l = lineTexts[j];
      if (isSeparatorLine(l)) {
        break;
      }
      contextLines.unshift(l);
    }

    // Command lines (for command type with context start or visible command block)
    let commandSpaced = '';
    let commandCompact = '';
    let hasVisibleCommandBlock = false;
    let rawCmdLines = [];

    const promptTypeName = pt.name || 'command';

    if (reqIndex !== -1) {
      rawCmdLines = lineTexts.slice(reqIndex + 1, qIndex);
      hasVisibleCommandBlock = true;
    } else if (promptTypeName === 'command') {
      // Check if there are command lines above qIndex (e.g. when context start is scrolled off)
      for (let i = qIndex - 1; i >= 0; i--) {
        const lt = lineTexts[i];
        const tr = lt.trim();
        if (isSeparatorLine(tr) || /^Command\b/i.test(tr) || /^[○●]\s+(?:Thought|Ran|Explored)\b/i.test(tr)) {
          break;
        }
        rawCmdLines.unshift(lt);
      }
      if (rawCmdLines.some(l => l.trim() !== '')) {
        hasVisibleCommandBlock = true;
      }
    }

    const qLine = lineTexts[qIndex];
    const match = qLine.match(questionRegex);
    if (match && match.index > 0) {
      rawCmdLines.push(qLine.slice(0, match.index));
    }

    const cmdLineTexts = rawCmdLines
      .map(l => (typeof l === 'string' ? l.trimEnd() : ''))
      .filter(t => t.trim() !== '');

    if (cmdLineTexts.length > 0) {
      commandSpaced = cmdLineTexts
        .map(t => t.trim())
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      commandCompact = cmdLineTexts
        .map(t => t.replace(/\s+/g, ''))
        .join('');
    }

    const question = match ? qLine.slice(match.index).trim() : qLine.trim();

    // Option parsing
    const rawOptions = [];
    let currentOption = null;
    let footerSeen = false;
    let hasSelectionMarker = false;

    for (let i = qIndex + 1; i < lineTexts.length; i++) {
      const lineText = lineTexts[i].trimEnd();
      const trimmed = lineText.trim();

      if (/^\s*>\s*\d+\./.test(lineText) || /^\s*>\s*\[/.test(lineText)) {
        hasSelectionMarker = true;
      }

      if (isFooterLine(trimmed, footerPrefix)) {
        footerSeen = true;
        break;
      }

      if (isSeparatorLine(trimmed)) {
        break;
      }

      const optMatch = lineText.match(optionRegex);
      const num = optMatch ? parseInt(optMatch[1], 10) : NaN;
      const isSequential = currentOption ? (num === currentOption.number + 1) : (num === 1);
      // Code lines at column 0 inside options never create fake options
      const isColumnZeroCode = optMatch && currentOption !== null && !/^\s+/.test(lineText) && !/^\s*>/.test(lineText);

      if (optMatch && isSequential && !isColumnZeroCode) {
        const key = optMatch[1];
        const hasMarker = /^\s*>\s*/.test(lineText);
        const optText = optMatch[2] ? optMatch[2].trim() : '';
        currentOption = { key, number: num, text: optText, hasMarker };
        rawOptions.push(currentOption);
      } else if (currentOption) {
        if (trimmed === '') {
          // Lookahead: if remaining lines are footer or separator or end of screen, don't append blank line
          let nextNonEmpty = '';
          for (let k = i + 1; k < lineTexts.length; k++) {
            const kt = lineTexts[k].trim();
            if (kt !== '') { nextNonEmpty = kt; break; }
          }
          if (!nextNonEmpty || isFooterLine(nextNonEmpty, footerPrefix) || isSeparatorLine(nextNonEmpty)) {
            continue;
          }
          continue;
        }
        currentOption.text += ' ' + trimmed;
      }
    }

    // If footer pattern is configured, footerSeen must be true
    if (footerPrefix && !footerSeen) {
      continue;
    }

    // Must have at least minOptions
    if (rawOptions.length < minOptions) {
      continue;
    }

    // If command block was not visible above question, extract command text from option texts
    if (!commandSpaced && promptTypeName === 'command') {
      for (const opt of rawOptions) {
        const optText = opt.text || '';
        const m = optText.match(/commands that start with (['"])([\s\S]*)/i);
        if (m) {
          const quoteChar = m[1];
          let inner = m[2];
          inner = inner.replace(/\s*\(Persist to settings\.json\)\s*$/i, '');
          if (inner.endsWith(quoteChar)) {
            inner = inner.slice(0, -quoteChar.length);
          }
          inner = inner.trim();
          if (inner) {
            commandSpaced = inner.replace(/\s+/g, ' ');
            commandCompact = inner.replace(/\s+/g, '');
            break;
          }
        }
      }
    }

    // Check command completeness (Requirement 3)
    let commandComplete = true;
    if (promptTypeName === 'command') {
      if (!hasVisibleCommandBlock) {
        commandComplete = false; // Missing command block above question
      }
      if (
        commandSpaced.includes('...') ||
        commandSpaced.includes('{...') ||
        commandSpaced.includes('…') ||
        rawCmdLines.some(l => l.includes('...') || l.includes('{...') || l.includes('…'))
      ) {
        commandComplete = false;
      }
      for (const opt of rawOptions) {
        const t = opt.text || '';
        if (
          /\.\.\.['"](?:\s*\(Persist to settings\.json\))?\s*$/i.test(t) ||
          /…['"](?:\s*\(Persist to settings\.json\))?\s*$/i.test(t) ||
          /\.\.\.\s*$/i.test(t) ||
          /…\s*$/i.test(t)
        ) {
          commandComplete = false;
        }
      }
    }

    // Consecutive numbering normalization
    let isStrictConsecutive = true;
    for (let idx = 0; idx < rawOptions.length; idx++) {
      if (rawOptions[idx].number !== idx + 1) {
        isStrictConsecutive = false;
        break;
      }
    }
    if (!isStrictConsecutive) {
      for (let idx = 0; idx < rawOptions.length; idx++) {
        if (isNaN(rawOptions[idx].number)) {
          rawOptions[idx].number = idx + 1;
          rawOptions[idx].key = String(idx + 1);
        }
      }
    }

    // Classify options
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

    if (promptTypeName === 'file_edit') {
      const targetFile = extractTargetFilePath(contextLines);
      const fileName = targetFile ? path.basename(targetFile.replace(/\\/g, '/')) : null;
      return {
        promptType: 'file_edit',
        targetFile: targetFile || '',
        fileName: fileName || '',
        command: targetFile || '',
        commandSpaced: targetFile || '',
        commandCompact: targetFile ? targetFile.replace(/\s+/g, '') : '',
        commandComplete: true,
        question,
        options,
        contextLines,
        footerSeen: true,
        hasSelectionMarker: Boolean(hasSelectionMarker)
      };
    }

    return {
      promptType: promptTypeName,
      command: commandSpaced,
      commandSpaced,
      commandCompact,
      commandComplete,
      question,
      options,
      contextLines,
      footerSeen: true,
      hasSelectionMarker: Boolean(hasSelectionMarker)
    };
  }

  // If a configured prompt type question was present but prompt was incomplete, do NOT treat as unknown
  if (matchedConfiguredQuestion) {
    return null;
  }

  // Check for unknown prompts (Requirement 5):
  // Question line ending with '?' followed by at least 2 numbered options
  for (let i = lineTexts.length - 1; i >= 0; i--) {
    const trimmed = lineTexts[i].trim();
    if (trimmed.length >= 3 && trimmed.endsWith('?') && !isSeparatorLine(trimmed)) {
      // Agent reply text never counts (e.g. lines starting with markdown bullets/lists)
      if (/^[*•\-+#]/.test(trimmed)) {
        continue;
      }
      const unkOptions = [];
      let curOpt = null;
      let unkHasSelectionMarker = false;
      let unkFooterSeen = false;
      for (let j = i + 1; j < lineTexts.length; j++) {
        const lText = lineTexts[j].trimEnd();
        const tr = lText.trim();
        if (/^\s*>\s*\d+\./.test(lText) || /^\s*>\s*\[/.test(lText)) {
          unkHasSelectionMarker = true;
        }
        if (isSeparatorLine(tr)) break;
        if (isFooterLine(tr)) {
          unkFooterSeen = true;
          break;
        }
        const optM = lText.match(/^\s*>?\s*(\d+)\.\s+(.*)$/);
        const num = optM ? parseInt(optM[1], 10) : NaN;
        const isSeq = curOpt ? (num === curOpt.number + 1) : (num === 1);
        const isCol0 = optM && curOpt !== null && !/^\s+/.test(lText) && !/^\s*>/.test(lText);

        if (optM && isSeq && !isCol0) {
          curOpt = { key: optM[1], number: num, text: optM[2].trim() };
          unkOptions.push(curOpt);
        } else if (curOpt) {
          if (tr === '') {
            let nextNonEmpty = '';
            for (let k = j + 1; k < lineTexts.length; k++) {
              const kt = lineTexts[k].trim();
              if (kt !== '') { nextNonEmpty = kt; break; }
            }
            if (!nextNonEmpty || isFooterLine(nextNonEmpty) || isSeparatorLine(nextNonEmpty)) {
              continue;
            }
            continue;
          }
          curOpt.text += ' ' + tr;
        }
      }

      if (unkOptions.length >= 2) {
        // Capture up to 10 context lines above question (stopping at separator line)
        const contextLines = [];
        for (let j = i - 1; j >= Math.max(0, i - 10); j--) {
          if (isSeparatorLine(lineTexts[j])) break;
          contextLines.unshift(lineTexts[j]);
        }
        const options = unkOptions.map(o => {
          const cleanedText = o.text.replace(/\s+/g, ' ').trim();
          return {
            key: o.key || String(o.number),
            number: o.number,
            text: cleanedText,
            classification: classifyOption(cleanedText, activeProfile)
          };
        });

        return {
          promptType: 'unrecognized',
          label: 'unrecognized prompt',
          question: trimmed,
          options,
          contextLines,
          footerSeen: Boolean(unkFooterSeen),
          hasSelectionMarker: Boolean(unkHasSelectionMarker),
          command: '',
          commandSpaced: '',
          commandCompact: '',
          commandComplete: false
        };
      }
    }
  }

  return null;
}

/**
 * Detects which option currently has the ">" selection marker from screen lines.
 * Returns the 1-based option number, defaulting to 1 if no marker is found.
 */
function getSelectedOptionNumberFromScreen(screenLines) {
  if (!screenLines || screenLines.length === 0) return 1;
  for (const lineObj of screenLines) {
    const text = typeof lineObj === 'string' ? lineObj : (lineObj && lineObj.text ? lineObj.text : '');
    if (!text) continue;
    const match = text.match(/^\s*>\s*(\d+)\./);
    if (match) {
      return parseInt(match[1], 10);
    }
  }
  return 1;
}

/**
 * Determines whether a detected prompt (recognized or unrecognized) is currently live.
 * A prompt is live only if:
 * 1. It is not agent reply text (e.g. question starts with markdown bullet *,-,+,#,•).
 * 2. It shows a live-prompt marker: a '>' selection marker on an option, or the navigation footer line as defined in the profile.
 * 3. It is in the live area at the bottom of the screen (all lines after the prompt must be blank/empty).
 */
function isPromptLive(detected, screenLines, profile) {
  if (!detected || !screenLines || screenLines.length === 0) return false;

  const lineTexts = screenLines.map(l => (typeof l === 'string' ? l : (l && l.text ? l.text : '')));

  // 1. Text in the agent's reply never counts
  const q = (detected.question || '').trim();
  if (/^[*•\-+#]/.test(q)) {
    return false;
  }

  // 2. Shows a live-prompt marker:
  // (a '>' selection marker on an option, or the navigation footer line, as defined in the profile)
  let hasSelectionMarker = false;
  let hasFooterLine = false;

  const footerPattern = (profile && (profile.footerPattern || (profile.prompt && (profile.prompt.footerPattern || profile.prompt.footerPrefix)))) || '↑/↓ Navigate';

  let lastPromptLineIndex = -1;

  for (let i = 0; i < lineTexts.length; i++) {
    const text = lineTexts[i];
    const trimmed = text.trim();

    if (/^\s*>\s*\d+\./.test(text) || /^\s*>\s*\[/.test(text)) {
      hasSelectionMarker = true;
    }

    if (isFooterLine(trimmed, footerPattern)) {
      hasFooterLine = true;
      lastPromptLineIndex = Math.max(lastPromptLineIndex, i);
    }
  }

  // If the line immediately following the footer line carries extra status words (e.g. "accept-edits", model name)
  if (lastPromptLineIndex !== -1 && lastPromptLineIndex + 1 < lineTexts.length) {
    const nextTrimmed = lineTexts[lastPromptLineIndex + 1].trim();
    if (
      /^(?:esc\s+to\s+cancel|accept-edits|\? for shortcuts)/i.test(nextTrimmed) ||
      /(?:accept-edits|Gemini|Flash|high|low|pro)/i.test(nextTrimmed)
    ) {
      lastPromptLineIndex = lastPromptLineIndex + 1;
    }
  }

  if (!hasSelectionMarker && !hasFooterLine) {
    return false;
  }

  // 3. Live area at the bottom of the screen:
  // Find where the prompt ends. All lines after it must be blank/empty.
  let promptEndLineIndex = -1;
  if (hasFooterLine && lastPromptLineIndex !== -1) {
    promptEndLineIndex = lastPromptLineIndex;
  } else if (detected.options && detected.options.length > 0) {
    const lastOpt = detected.options[detected.options.length - 1];
    const lastOptKey = lastOpt.key || String(lastOpt.number);
    const lastOptTextNorm = String(lastOpt.text || '').toLowerCase().replace(/\s+/g, '');

    for (let i = lineTexts.length - 1; i >= 0; i--) {
      const optMatch = lineTexts[i].match(/^\s*>?\s*(\d+)\./);
      if (optMatch && optMatch[1] === lastOptKey) {
        promptEndLineIndex = i;
        let accumulated = lineTexts[i].replace(/^\s*>?\s*\d+\./, '').toLowerCase().replace(/\s+/g, '');
        for (let k = i + 1; k < lineTexts.length; k++) {
          const kTrim = lineTexts[k].trim();
          if (kTrim === '') break;
          if (/^\s*>?\s*\d+\./.test(lineTexts[k])) break;
          if (isFooterLine(kTrim, footerPattern)) {
            promptEndLineIndex = k;
            break;
          }
          const nextAcc = accumulated + kTrim.toLowerCase().replace(/\s+/g, '');
          if (accumulated !== lastOptTextNorm && lastOptTextNorm.startsWith(nextAcc)) {
            accumulated = nextAcc;
            promptEndLineIndex = k;
          } else {
            break;
          }
        }
        break;
      }
    }
  }

  if (promptEndLineIndex !== -1) {
    for (let i = promptEndLineIndex + 1; i < lineTexts.length; i++) {
      if (lineTexts[i].trim() !== '') {
        return false;
      }
    }
  }

  return true;
}

module.exports = {
  extractPromptFromScreen,
  getSelectedOptionNumberFromScreen,
  isPromptLive,
  isSeparatorLine,
  isFooterLine,
  extractTargetFilePath,
  appendUnknownPromptSample
};
