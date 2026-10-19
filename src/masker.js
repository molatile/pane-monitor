/**
 * Masking and redaction module for agentwatch.
 * Ensures secrets, tokens, credentials, and sensitive account headers are never written to disk.
 */

// Prefixes explicitly specified for redaction
const PREFIX_REGEX = /\b(?:sk-[a-zA-Z0-9_\-\.]*|AQ\.[a-zA-Z0-9_\-\.]*|AIza[a-zA-Z0-9_\-]*|ghp_[a-zA-Z0-9_]*|github_pat_[a-zA-Z0-9_]*|xox[baprs]?-[a-zA-Z0-9_\-]*)\b/g;

// Values after KEY=, TOKEN=, SECRET=, PASSWORD=, Bearer
const BEARER_REGEX = /(?<=\bBearer\s+)[^\s\r\n]+/gi;
const KEY_VALUE_EQUAL_REGEX = /(?<=\b[a-zA-Z0-9_\-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)\s*=\s*)(?:(['"])(?:(?!\1).)*\1|[^\s\r\n"';&#]+)/gi;
const KEY_VALUE_COLON_REGEX = /(?<=\b[a-zA-Z0-9_\-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)\s*:\s*)(?:(['"])(?:(?!\1).)*\1|[^\s\r\n"';,}&]+)/gi;

// JSON / JS object key-value pairs (e.g. {"apiKey": "..."}, {"password": "..."})
const JSON_KEY_VALUE_REGEX = /(["'])([a-zA-Z0-9_\-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL))\1(\s*:\s*)(["'])(?:(?!\4).)*\4/gi;
const JS_OBJ_KEY_VALUE_REGEX = /(?<=(?:^|[^\w'"])([a-zA-Z0-9_\-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL))\s*:\s*)(["'])(?:(?!\2).)*\2/gi;

// Google account email line pattern (for header lines)
const GOOGLE_EMAIL_LINE_REGEX = /^.*[a-zA-Z0-9._%+-]+@(?:gmail\.com|google\.com).*$/im;
const GOOGLE_EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@(?:gmail\.com|google\.com)/gi;

/**
 * Redacts secrets from echo commands redirecting into .env files
 */
function maskEchoEnv(text) {
  return text.replace(/\b(echo\s+)(['"]?)(?:([a-zA-Z0-9_\-]+)=)?(.*?)\2(\s*>{1,2}\s*\S*\.env[a-zA-Z0-9_\.-]*)/gi,
    (match, echoPart, quote, varName, value, redirectPart) => {
      if (varName) {
        return `${echoPart}${quote}${varName}=[REDACTED]${quote}${redirectPart}`;
      } else {
        return `${echoPart}${quote}[REDACTED]${quote}${redirectPart}`;
      }
    }
  );
}

/**
 * Calculates Shannon entropy of a string
 */
function calculateEntropy(str) {
  const len = str.length;
  if (len === 0) return 0;
  const frequencies = {};
  for (let i = 0; i < len; i++) {
    const char = str[i];
    frequencies[char] = (frequencies[char] || 0) + 1;
  }
  let entropy = 0;
  for (const char in frequencies) {
    const p = frequencies[char] / len;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * Checks if a string (24+ chars) is a secret / random-looking string
 * versus a readable hyphenated English sentence / slug.
 *
 * Rule: any token of 24 or more characters that mixes letters and digits (even with - or _)
 * is masked, EXCEPT ordinary hyphenated English words with no digits (for example
 * "this-is-a-long-test-message-to-check-how-wrapping-works" must survive). When unsure, mask.
 */
function isRandomLookingString(str) {
  if (!str || str.length < 24) return false;
  if (str === '[REDACTED]') return false;

  const hasLetters = /[a-zA-Z]/.test(str);
  const hasDigits = /[0-9]/.test(str);

  // Rule: any token of 24 or more characters that mixes letters and digits (even with - or _) is masked
  if (hasLetters && hasDigits) {
    return true;
  }

  // Pure digits of 24+ chars (e.g. numeric ID, hash)
  if (hasDigits && !hasLetters) {
    return true;
  }

  // Underscores do not appear in ordinary English words
  // Covers: secret containing hyphens or underscores, 40+ characters, with no known prefix
  if (str.includes('_')) {
    if (str.length >= 40 || calculateEntropy(str) > 2.8) {
      return true;
    }
  }

  // Check for ordinary hyphenated English words with no digits
  // Example: "this-is-a-long-test-message-to-check-how-wrapping-works" must survive
  if (/^[a-zA-Z\-]+$/.test(str) && str.includes('-')) {
    const segments = str.split('-').filter(Boolean);
    const allNormalWords = segments.every(s => s.length <= 25);
    if (allNormalWords && calculateEntropy(str) <= 4.2) {
      return false; // MUST SURVIVE
    }
  }

  // Pure letters with no hyphens or random letters
  const entropy = calculateEntropy(str);
  if (entropy > 3.3 || str.length >= 40) {
    return true;
  }

  // When unsure, mask
  return true;
}

/**
 * Redacts secrets from a given text string.
 */
function maskText(text) {
  if (text === null || text === undefined) return text;
  if (typeof text !== 'string') {
    text = String(text);
  }

  // 1. Remove Google account email lines if present
  let masked = text
    .split(/\r?\n/)
    .filter(line => !GOOGLE_EMAIL_LINE_REGEX.test(line))
    .join('\n');

  // If email was embedded in inline text without line break
  masked = masked.replace(GOOGLE_EMAIL_REGEX, '[REDACTED]');

  // 2. Redact known prefixes (sk-, AQ., AIza, ghp_, github_pat_, xox)
  masked = masked.replace(PREFIX_REGEX, '[REDACTED]');

  // 3. Mask echo ... >> .env commands
  masked = maskEchoEnv(masked);

  // 4. Mask JSON / JS object key-value pairs (e.g. {"apiKey": "..."}, {"password": "..."})
  masked = masked.replace(JSON_KEY_VALUE_REGEX, '$1$2$1$3$4[REDACTED]$4');
  masked = masked.replace(JS_OBJ_KEY_VALUE_REGEX, '$2[REDACTED]$2');

  // 5. Redact values after KEY=, TOKEN=, SECRET=, PASSWORD=, Bearer (including URL queries ?key=, &token=, &api_key=)
  masked = masked.replace(BEARER_REGEX, '[REDACTED]');
  masked = masked.replace(KEY_VALUE_EQUAL_REGEX, '[REDACTED]');
  masked = masked.replace(KEY_VALUE_COLON_REGEX, '[REDACTED]');

  // 6. Redact 24+ char tokens mixing letters and digits (or random-looking strings)
  masked = masked.replace(/(?<=[^A-Za-z0-9_\-]|^)[A-Za-z0-9_\-]{24,}(?=[^A-Za-z0-9_\-]|$)/g, (match) => {
    if (isRandomLookingString(match)) {
      return '[REDACTED]';
    }
    return match;
  });

  return masked;
}

/**
 * Redacts an array of screen lines (or objects with .text) and removes Google account email lines.
 */
function maskScreenLines(lines) {
  if (!lines || !Array.isArray(lines)) return [];
  const result = [];
  for (const item of lines) {
    const lineText = typeof item === 'string' ? item : (item && item.text ? item.text : '');
    // Never write the Google account email line from the Antigravity header into any file
    if (GOOGLE_EMAIL_LINE_REGEX.test(lineText)) {
      continue;
    }
    const maskedLine = maskText(lineText);
    if (typeof item === 'string') {
      result.push(maskedLine);
    } else {
      result.push(Object.assign({}, item, { text: maskedLine }));
    }
  }
  return result;
}

module.exports = {
  maskText,
  maskScreenLines,
  isRandomLookingString
};
