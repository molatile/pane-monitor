/**
 * State Classifier module for agentwatch sessions.
 * Manages states:
 * - "asking": Complete permission prompt is on screen
 * - "busy": Output changed in the last ~1.5s
 * - "idle": Input box is visible and output has been quiet for ~3s
 */

class SessionStateTracker {
  constructor(profile, onStateChange) {
    this.profile = profile || null;
    this.hasProfile = Boolean(profile);
    const thresholds = (this.profile && this.profile.stateThresholds) || {};
    this.busyThresholdMs = thresholds.busyThresholdMs || 1500;
    this.idleThresholdMs = thresholds.idleThresholdMs || 3000;

    const pattern = (this.profile && this.profile.inputBoxPattern) || '(?:^[›❯>\\$]|Type a message|Enter a prompt|What would you like|What should we do|Send a message|\\? )';
    this.inputBoxRegex = new RegExp(pattern, 'i');

    this.onStateChange = onStateChange || (() => {});

    this.currentState = 'idle';
    this.stateSince = new Date().toISOString();
    this.lastOutputTime = 0;
    this.lastChangeTime = 0;
    this.lastVisibleText = null;
    this.backgroundTasks = 0;
  }

  /**
   * Retrieves compiled RegExp patterns for background tasks from profile.
   */
  getBackgroundTaskPatterns() {
    if (!this.hasProfile) return [];
    let raw = this.profile && (this.profile.background_task_patterns || this.profile.backgroundTaskPatterns);
    if (!raw) {
      try {
        const { getProfileForCommand } = require('./profile');
        const defaultProfile = getProfileForCommand('agy');
        if (defaultProfile) {
          raw = defaultProfile.background_task_patterns || defaultProfile.backgroundTaskPatterns;
        }
      } catch (e) {}
    }
    if (!raw) return [];
    const list = Array.isArray(raw) ? raw : [raw];
    return list.map(p => (p instanceof RegExp ? p : new RegExp(p)));
  }

  /**
   * Checks if a line matches any background task pattern.
   */
  isBackgroundTaskLine(line) {
    if (!line) return false;
    const text = typeof line === 'string' ? line : (line && line.text ? line.text : '');
    const trimmed = text.trim();
    if (!trimmed) return false;
    const trimmedEnd = text.trimEnd();
    const patterns = this.getBackgroundTaskPatterns();
    for (const p of patterns) {
      if (p.test(text) || p.test(trimmedEnd) || p.test(trimmed)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Checks if a line is a tool-call line starting with "○ Running (".
   */
  isToolCallRunningLine(line) {
    if (!this.hasProfile) return false;
    if (!line) return false;
    const text = typeof line === 'string' ? line : (line && line.text ? line.text : '');
    const trimmed = text.trim();
    return trimmed.startsWith('○ Running (') || /^\s*○\s*Running\s*\(/.test(text);
  }

  /**
   * Counts the number of lines matching background task patterns.
   */
  countBackgroundTasks(screenLines) {
    if (!screenLines || screenLines.length === 0) return 0;
    let count = 0;
    for (const l of screenLines) {
      if (this.isBackgroundTaskLine(l)) {
        count++;
      }
    }
    return count;
  }

  /**
   * Checks if any line is a running tool-call line.
   */
  hasRunningToolCall(screenLines) {
    if (!screenLines || screenLines.length === 0) return false;
    for (const l of screenLines) {
      if (this.isToolCallRunningLine(l)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Sanitizes bracketed clock-like text such as [HH:MM:SS], [HH:MM], etc.
   */
  sanitizeBracketedClock(text) {
    if (!text) return '';
    return text.replace(/\[\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\s*\]/gi, '[]');
  }

  /**
   * Checks if a line matches typical bottom status-line content:
   * model names, clock-like text, shortcuts or hints.
   */
  isStatusLine(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (!trimmed) return false;

    // Model name pattern (e.g. Gemini 3.8 Flash, Claude 3.5, GPT-4o, etc.)
    const modelPattern = /\b(?:Gemini|Claude|GPT|DeepSeek|Llama|qwen|o1|o3|Opus|Sonnet|Haiku)\b/i;

    // Clock-like text (e.g. 12:34:56, 12:34, 12:34 PM, [12:34])
    const clockPattern = /\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\b/i;

    // Shortcuts or footer action text
    const shortcutPattern = /(?:\? for shortcuts|for shortcuts|shortcuts|press ctrl\+|esc to |ctrl\+[a-z] to)/i;

    return modelPattern.test(trimmed) || clockPattern.test(trimmed) || shortcutPattern.test(trimmed);
  }

  /**
   * Strips clock-like text and model names from a line.
   */
  sanitizeStatusArtifacts(line) {
    if (!line) return '';
    return line
      .replace(/\[\s*\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\s*\]/gi, '[]')
      .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\s*[AP]M)?\b/gi, '')
      .replace(/\b(?:Gemini|Claude|GPT|DeepSeek|Llama|qwen|o1|o3)\b[^\s]*/gi, '')
      .trimEnd();
  }

  /**
   * Extracts visible screen text, ignoring cursor moves (handled by emulator),
   * background task lines, bracketed clock changes, and the status line at the bottom.
   */
  getVisibleScreenText(screenLines) {
    if (!screenLines || screenLines.length === 0) return '';

    if (!this.hasProfile) {
      const lines = screenLines.map(l => {
        const text = typeof l === 'string' ? l : (l && l.text ? l.text : '');
        return text.trimEnd();
      });
      while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
        lines.pop();
      }
      return lines.join('\n');
    }

    const lines = screenLines
      .filter(l => !this.isBackgroundTaskLine(l))
      .map(l => {
        const text = typeof l === 'string' ? l : (l && l.text ? l.text : '');
        return this.sanitizeBracketedClock(text.trimEnd());
      });

    // Remove trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
      lines.pop();
    }

    if (lines.length === 0) return '';

    // Search for input box in bottom 10 lines
    let inputBoxIdx = -1;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 10); i--) {
      const line = lines[i].trim();
      if (/^>?\s*\d+\./.test(line)) continue;
      if (this.inputBoxRegex.test(line)) {
        inputBoxIdx = i;
        break;
      }
    }

    if (inputBoxIdx !== -1) {
      // Status line, separators and shortcuts below the input box are ignored
      lines.splice(inputBoxIdx + 1);
    } else {
      // Input box is not on screen, remove any trailing status lines / separators
      while (lines.length > 0) {
        const last = lines[lines.length - 1].trim();
        if (this.isStatusLine(last) || /^[─\-_=\s]+$/.test(last)) {
          lines.pop();
        } else {
          break;
        }
      }
    }

    // Sanitize any remaining bottom lines for clock-like text and model names
    return lines.map((line, idx) => {
      if (idx >= lines.length - 2) {
        return this.sanitizeStatusArtifacts(line);
      }
      return line;
    }).join('\n');
  }

  /**
   * Called when output is received from child process (fallback / compatibility).
   */
  recordOutput() {
    this.lastOutputTime = Date.now();
  }

  /**
   * Helper to check if the input box is visible in the bottom rows of the screen buffer.
   */
  isInputBoxOnScreen(screenLines) {
    if (!screenLines || screenLines.length === 0) return false;
    // Filter non-empty lines first, then check the bottom 10 non-empty lines
    const nonEmpties = screenLines
      .map(l => (typeof l === 'string' ? l : (l && l.text ? l.text : '')).trim())
      .filter(Boolean);

    const bottomLines = nonEmpties.slice(-10);

    for (const line of bottomLines) {
      // Ignore prompt menu options like "> 1. Yes, run command"
      if (/^>?\s*\d+\./.test(line)) {
        continue;
      }
      if (this.inputBoxRegex.test(line)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Evaluates and updates current state based on prompt visibility, visible text change recency,
   * background tasks, running tool calls, and input box.
   * Returns current state.
   */
  evaluateState({ isPromptActive, isInputBoxVisible, screenLines, nowMs }) {
    const now = typeof nowMs === 'number' ? nowMs : Date.now();
    const isInputBox = isInputBoxVisible !== undefined
      ? Boolean(isInputBoxVisible)
      : this.isInputBoxOnScreen(screenLines);

    // If screenLines is provided, track visible screen text changes
    if (screenLines) {
      const visibleText = this.getVisibleScreenText(screenLines);
      if (this.lastVisibleText === null) {
        this.lastVisibleText = visibleText;
        // If input box is already visible on the first frame, consider it quiet (lastChangeTime = 0)
        // Otherwise, mark it as having changed at 'now'
        this.lastChangeTime = isInputBox ? 0 : (visibleText ? now : 0);
      } else if (visibleText !== this.lastVisibleText) {
        this.lastVisibleText = visibleText;
        this.lastChangeTime = now;
      }
    }

    const effectiveTime = this.lastChangeTime !== 0 ? this.lastChangeTime : (this.lastVisibleText !== null ? 0 : this.lastOutputTime);
    const timeSinceChange = effectiveTime === 0 ? Infinity : (now - effectiveTime);

    const bgTaskCount = this.countBackgroundTasks(screenLines);
    this.backgroundTasks = bgTaskCount;
    const hasBgTask = bgTaskCount > 0;
    const hasToolCall = this.hasRunningToolCall(screenLines);
    const hasRunningTasks = hasBgTask || hasToolCall;

    let nextState = this.currentState;

    if (!this.hasProfile) {
      if (timeSinceChange < this.busyThresholdMs) {
        nextState = 'busy';
      } else if (timeSinceChange >= this.idleThresholdMs) {
        nextState = 'idle';
      }
    } else {
      if (isPromptActive) {
        nextState = 'asking';
      } else if (hasRunningTasks) {
        nextState = 'busy';
      } else if (timeSinceChange < this.busyThresholdMs) {
        nextState = 'busy';
      } else if (timeSinceChange >= this.idleThresholdMs && isInputBox) {
        nextState = 'idle';
      } else if (this.currentState === 'asking') {
        // Transitioning away from asking: if quiet for >= idle threshold and input box visible, go to idle; else busy
        if (timeSinceChange >= this.idleThresholdMs && isInputBox) {
          nextState = 'idle';
        } else {
          nextState = 'busy';
        }
      } else if (this.currentState === 'busy' && timeSinceChange >= this.idleThresholdMs && !isInputBox) {
        if (!hasRunningTasks && timeSinceChange >= 5000) {
          nextState = 'idle';
        } else {
          nextState = 'busy';
        }
      }
    }

    if (nextState !== this.currentState) {
      const oldState = this.currentState;
      this.currentState = nextState;
      this.stateSince = new Date(now).toISOString();
      this.onStateChange(oldState, nextState, this.stateSince, { backgroundTasks: this.backgroundTasks });
    }

    return this.currentState;
  }

  getState() {
    return {
      state: this.currentState,
      stateSince: this.stateSince,
      backgroundTasks: this.backgroundTasks || 0
    };
  }
}

module.exports = {
  SessionStateTracker
};
