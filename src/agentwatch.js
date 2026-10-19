#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
let pty;
try {
  pty = require('node-pty');
} catch (e) {
  pty = require('@lydell/node-pty');
}
const { Terminal } = require('@xterm/headless');
const { extractPromptFromScreen } = require('./parser');
const { resolveExecutable } = require('./resolver');
const { getProfileForCommand, getNoProfileNotice } = require('./profile');
const { evaluatePrompt, loadRules } = require('./rules');
const { maskText, maskScreenLines } = require('./masker');
const { appendHistoryEvent } = require('./history');
const { SessionStatusManager } = require('./status');
const { SessionStateTracker } = require('./state');
const { loadConfig, isGuiRunning } = require('./shared');
const { startGui } = require('./gui');

/**
 * Runs the agentwatch monitor around a child process.
 */
function startAgentwatch(options = {}) {
  const command = options.command;
  const commandArgs = options.args || [];
  const record = Boolean(options.record);
  const rules = loadRules(options.rulesPath);
  const profile = options.profile !== undefined ? options.profile : getProfileForCommand(command);
  const hasProfile = Boolean(profile);
  const commandBaseName = command
    ? path.basename(command).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase()
    : 'agent';
  const agentName = (profile && profile.id) || commandBaseName;

  let notice = null;
  if (!hasProfile) {
    notice = getNoProfileNotice(agentName);
    if (typeof options.onNotice === 'function') {
      options.onNotice(notice);
    }
    console.warn(notice);
    if (options.stderr && options.stderr.write && options.stderr !== process.stderr) {
      options.stderr.write(notice + '\n');
    }
  }

  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;

  const resolvedCommand = resolveExecutable(command);
  if (!resolvedCommand) {
    console.error(`Error: Command not found: ${command}`);
    if (options.onExit) {
      options.onExit(1);
      return null;
    }
    process.exit(1);
  }

  // Handle .cmd and .bat on Windows
  let spawnFile = resolvedCommand;
  let spawnArgs = commandArgs;
  if (process.platform === 'win32') {
    const ext = path.extname(resolvedCommand).toLowerCase();
    if (ext === '.cmd' || ext === '.bat') {
      spawnFile = process.env.ComSpec || 'cmd.exe';
      spawnArgs = ['/c', resolvedCommand, ...commandArgs];
    }
  }

  // Terminal dimensions
  const cols = stdout.columns || 120;
  const rows = stdout.rows || 30;

  // Headless terminal emulator
  const term = new Terminal({
    cols,
    rows,
    allowProposedApi: true
  });

  const sessionStartTime = Date.now();

  // Check auto-open window
  const config = loadConfig(options.configPath);
  const shouldAutoOpen = options.autoOpenWindow !== undefined
    ? Boolean(options.autoOpenWindow)
    : (config.autoOpenWindow !== false && !options.stdin && !process.env.AGENTWATCH_TEST);

  if (shouldAutoOpen && !isGuiRunning(config)) {
    try {
      const res = startGui({
        detached: true,
        stdio: 'ignore',
        autoOpen: true,
        electronPath: options.electronPath,
        args: options.guiArgs,
        onLaunchError: (err) => {
          console.error(`Note: Could not open agentwatch window: ${err.message}`);
        }
      });
      if (!res) {
        console.error('Note: Could not open agentwatch window: Electron is not installed.');
      }
    } catch (err) {
      console.error(`Note: Could not open agentwatch window: ${err.message}`);
    }
  }

  // Session ID & Status Manager
  const sessionId = options.sessionId || `session-${Date.now()}-${process.pid}`;
  const statusManager = new SessionStatusManager({
    sessionId,
    agent: agentName,
    hasProfile,
    cwd: options.cwd || process.cwd(),
    pid: process.pid,
    sessionsDir: options.sessionsDir
  });
  statusManager.start();

  // History path & Prompts log path
  const historyPath = options.historyPath;

  // Log session_started event
  appendHistoryEvent({
    type: 'session_started',
    time: new Date(sessionStartTime).toISOString(),
    sessionId,
    sessionKey: statusManager.sessionKey,
    folder: statusManager.folder,
    agent: agentName
  }, historyPath);

  const promptsLogPath = options.promptsLogPath || path.resolve(process.cwd(), 'prompts.log');
  const snapshotsPath = options.snapshotsPath || path.resolve(process.cwd(), 'screen-snapshots.txt');

  // Raw session recording stream (OFF by default, only enabled with --record)
  let rawStream = null;
  if (record) {
    const rawSessionPath = options.rawSessionPath || path.resolve(process.cwd(), 'raw-session.bin');
    rawStream = fs.createWriteStream(rawSessionPath, { flags: 'a' });
  }

  // State Classifier
  const stateTracker = new SessionStateTracker(profile, (oldState, newState, stateSince, extra = {}) => {
    // Log state change with timestamp to the session log for later tuning
    const timestamp = new Date().toISOString();
    const logLine = `[${timestamp}] State changed: ${oldState} -> ${newState}\n`;
    try {
      fs.appendFileSync(promptsLogPath, logLine, 'utf8');
    } catch (e) {}

    // Update status file
    const promptSummary = activePrompt
      ? { ...activePrompt.detected, decision: activePrompt.decision }
      : null;
    const bgTasks = extra && extra.backgroundTasks !== undefined ? extra.backgroundTasks : (stateTracker.backgroundTasks || 0);
    statusManager.update(newState, stateSince, promptSummary, { backgroundTasks: bgTasks });
  });

  let lastScreenText = null;
  let activePrompt = null;
  let promptDebounceTimer = null;
  let quietTimer = null;
  let lastSnapshotText = null;

  function getPromptFingerprint(detected) {
    if (!detected) return '';
    const cmd = detected.commandSpaced || detected.command || '';
    const q = detected.question || '';
    const opts = (detected.options || []).map(o => `${o.key || o.number}:${o.text}`).join('|');
    return `${cmd}:::${q}:::${opts}`;
  }

  function getScreenLines() {
    const buf = term.buffer.active;
    const lines = [];
    for (let i = 0; i < term.rows; i++) {
      const line = buf.getLine(buf.baseY + i);
      if (line) {
        lines.push({
          text: line.translateToString(true),
          isWrapped: line.isWrapped
        });
      }
    }
    return lines;
  }

  function saveScreenSnapshot() {
    const buf = term.buffer.active;
    const end = buf.baseY + term.rows;
    const start = Math.max(0, end - 30);
    const screenRows = [];
    for (let i = start; i < end; i++) {
      const line = buf.getLine(i);
      screenRows.push(line ? line.translateToString(true) : '');
    }

    // Mask secrets and remove Google account email lines
    const maskedRows = maskScreenLines(screenRows);
    const snapshotText = maskedRows.join('\n');
    if (lastSnapshotText !== null && snapshotText === lastSnapshotText) {
      return;
    }
    lastSnapshotText = snapshotText;

    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}]\n${snapshotText}\n\n`;
    try {
      fs.appendFileSync(snapshotsPath, entry, 'utf8');
    } catch (err) {}
  }

  function handleLogPromptRecord(detected, decision) {
    return logPromptRecord(detected, decision, {
      promptsLogPath,
      historyPath,
      sessionId,
      sessionKey: statusManager.sessionKey,
      folder: statusManager.folder,
      profile
    });
  }

  function closeActivePrompt(reason) {
    if (!activePrompt) return;
    const now = Date.now();
    const timestamp = new Date(now).toISOString();

    let durationSeconds;
    let durationLogStr;

    if (reason === 'exit_unclosed') {
      // Prompt was still on screen when process exited; moment it left screen cannot be determined
      durationSeconds = 'closed: unknown';
      durationLogStr = 'unknown (closed: unknown)';
    } else {
      // Prompt actually left the screen while running
      durationSeconds = (now - activePrompt.shownTime) / 1000;
      durationLogStr = `${timestamp}`;
    }

    const entry = `Prompt closed at ${durationLogStr}\n\n`;
    try {
      fs.appendFileSync(promptsLogPath, entry, 'utf8');
    } catch (err) {}

    // Write closed event to history.jsonl
    const closedEvent = {
      type: 'prompt_closed',
      time: timestamp,
      sessionId,
      sessionKey: statusManager.sessionKey,
      folder: statusManager.folder,
      agent: (profile && profile.id) || 'agy',
      question: maskText(activePrompt.detected.question),
      command: {
        spaced: maskText(activePrompt.detected.commandSpaced),
        compact: maskText(activePrompt.detected.commandCompact)
      },
      options: activePrompt.detected.options.map(o => ({
        key: o.key || String(o.number),
        number: o.number,
        text: maskText(o.text),
        classification: o.classification
      })),
      decision: activePrompt.decision,
      rule: (activePrompt.decision && activePrompt.decision.rule) || null,
      outcome: 'closed',
      durationSeconds
    };
    appendHistoryEvent(closedEvent, historyPath);

    activePrompt = null;
  }

  function inspectScreenForPrompts(nowMs) {
    const screenLines = getScreenLines();

    if (!hasProfile) {
      // Unprofiled agents: NEVER show ASKING, NEVER evaluate approval decisions
      stateTracker.evaluateState({
        isPromptActive: false,
        isInputBoxVisible: false,
        screenLines,
        nowMs
      });
      return;
    }

    const detected = extractPromptFromScreen(screenLines, profile);

    const isComplete = detected !== null &&
      detected.question &&
      Array.isArray(detected.options) &&
      detected.options.length >= (profile && profile.prompt && profile.prompt.minOptions !== undefined ? profile.prompt.minOptions : 2) &&
      detected.footerSeen === true;

    // Check if input box is visible
    const isInputBoxVisible = stateTracker.isInputBoxOnScreen(screenLines);

    if (isComplete) {
      const fingerprint = getPromptFingerprint(detected);
      if (!activePrompt) {
        const decision = evaluatePrompt(detected, rules);
        activePrompt = {
          detected,
          fingerprint,
          decision,
          shownTime: Date.now()
        };
        handleLogPromptRecord(detected, decision);
        saveScreenSnapshot();
      } else if (activePrompt.fingerprint !== fingerprint) {
        closeActivePrompt('new_prompt');
        const decision = evaluatePrompt(detected, rules);
        activePrompt = {
          detected,
          fingerprint,
          decision,
          shownTime: Date.now()
        };
        handleLogPromptRecord(detected, decision);
        saveScreenSnapshot();
        if (stateTracker.currentState === 'asking') {
          statusManager.update('asking', stateTracker.stateSince, { ...detected, decision });
        }
      }
    } else {
      if (activePrompt) {
        // Prompt actually left the screen!
        closeActivePrompt('screen_cleared');
      }
    }

    // Update state classification
    stateTracker.evaluateState({
      isPromptActive: Boolean(activePrompt),
      isInputBoxVisible,
      screenLines,
      nowMs
    });

    const currentBgTasks = stateTracker.backgroundTasks || 0;
    if (statusManager.backgroundTasks !== currentBgTasks) {
      statusManager.backgroundTasks = currentBgTasks;
      statusManager.writeStatus();
    }
  }

  // Periodic 1-second check of the rebuilt screen
  const checkInterval = setInterval(inspectScreenForPrompts, 1000);
  if (checkInterval.unref) {
    checkInterval.unref();
  }

  // Launch child process inside PTY
  let ptyProcess;
  if (options.ptyProcess) {
    ptyProcess = options.ptyProcess;
  } else {
    try {
      ptyProcess = pty.spawn(spawnFile, spawnArgs, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: options.cwd || process.cwd(),
        env: options.env || process.env,
        useConptyDll: false
      });
    } catch (err) {
      console.error(`Failed to launch child process: ${err.message}`);
      if (promptDebounceTimer) clearTimeout(promptDebounceTimer);
      clearInterval(checkInterval);
      statusManager.cleanup();
      if (options.onExit) {
        options.onExit(1);
        return null;
      }
      process.exit(1);
    }
  }

  // Handle output stream
  ptyProcess.onData((data) => {
    // Pass-through to stdout
    stdout.write(data);

    // Record raw stream if enabled
    if (rawStream) {
      rawStream.write(Buffer.isBuffer(data) ? data : Buffer.from(data));
    }

    // Rebuild screen in headless emulator
    term.write(data);

    // Check screen debounced to ~100ms
    if (promptDebounceTimer) {
      clearTimeout(promptDebounceTimer);
    }
    promptDebounceTimer = setTimeout(() => {
      promptDebounceTimer = null;
      inspectScreenForPrompts();
    }, 100);

    // Save snapshot after 2 seconds of quiet
    if (quietTimer) {
      clearTimeout(quietTimer);
    }
    quietTimer = setTimeout(saveScreenSnapshot, 2000);
  });

  // Handle resize
  function onResize() {
    const newCols = stdout.columns || 80;
    const newRows = stdout.rows || 24;
    try {
      ptyProcess.resize(newCols, newRows);
    } catch (e) {}
    try {
      term.resize(newCols, newRows);
    } catch (e) {}
  }
  if (stdout.on) {
    stdout.on('resize', onResize);
  }

  // HARD SAFETY RULE:
  // The only data ever written to the child process is the user's own keyboard input.
  // Do not implement any other code path that writes to the child.
  if (stdin.isTTY && stdin.setRawMode) {
    stdin.setRawMode(true);
  }
  if (stdin.resume) {
    stdin.resume();
  }

  const onStdinData = (chunk) => {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.includes(0x1d)) {
      saveScreenSnapshot();
      const remaining = buf.filter((b) => b !== 0x1d);
      if (remaining.length > 0) {
        ptyProcess.write(remaining);
      }
      return;
    }
    // Strictly forward only what the user typed
    ptyProcess.write(chunk);
  };
  stdin.on('data', onStdinData);

  // Clean exit handling
  ptyProcess.onExit(({ exitCode }) => {
    if (quietTimer) clearTimeout(quietTimer);
    if (promptDebounceTimer) clearTimeout(promptDebounceTimer);
    clearInterval(checkInterval);

    term.write('', () => {
      if (hasProfile) {
        // Check if prompt left screen before exiting
        const finalLines = getScreenLines();
        const detected = extractPromptFromScreen(finalLines, profile);
        if (!detected && activePrompt) {
          closeActivePrompt('screen_cleared');
        } else if (activePrompt) {
          // Was still on screen at process exit
          closeActivePrompt('exit_unclosed');
        }
      }

      if (stdin.isTTY && stdin.setRawMode) {
        try {
          stdin.setRawMode(false);
        } catch (e) {}
      }
      if (stdin.pause) stdin.pause();
      stdin.removeListener('data', onStdinData);
      if (stdout.removeListener) {
        stdout.removeListener('resize', onResize);
      }

      // Delete status file on clean exit
      statusManager.cleanup();

      // Log session_ended event on clean exit
      const sessionDurationSeconds = Math.max(0, Math.round((Date.now() - sessionStartTime) / 1000));
      appendHistoryEvent({
        type: 'session_ended',
        time: new Date().toISOString(),
        sessionId,
        sessionKey: statusManager.sessionKey,
        folder: statusManager.folder,
        agent: agentName,
        durationSeconds: sessionDurationSeconds,
        exitCode: exitCode ?? 0
      }, historyPath);

      const finishExit = () => {
        if (options.onExit) {
          options.onExit(exitCode ?? 0);
        } else {
          process.exit(exitCode ?? 0);
        }
      };

      if (rawStream) {
        rawStream.end(() => {
          finishExit();
        });
      } else {
        finishExit();
      }
    });
  });

  return {
    ptyProcess,
    term,
    statusManager,
    stateTracker,
    sessionId,
    agentName,
    hasProfile,
    notice,
    saveScreenSnapshot,
    inspectScreenForPrompts,
    cleanup: () => {
      if (quietTimer) clearTimeout(quietTimer);
      if (promptDebounceTimer) clearTimeout(promptDebounceTimer);
      clearInterval(checkInterval);
      statusManager.cleanup();
    }
  };
}

/**
 * Formats and logs a prompt record to prompts.log and history.jsonl.
 * Masking applies only at the moment of writing to disk.
 */
function logPromptRecord(detected, decision, options = {}) {
  const timestamp = options.timestamp || new Date().toISOString();
  const promptsLogPath = options.promptsLogPath || path.resolve(process.cwd(), 'prompts.log');
  const historyPath = options.historyPath;
  const sessionId = options.sessionId || `session-${Date.now()}`;
  const profile = options.profile;

  const cmdSpaced = detected.commandSpaced !== undefined ? detected.commandSpaced : (detected.command || '');
  const maskedSpaced = maskText(cmdSpaced);
  const cmdCompact = detected.commandCompact !== undefined ? detected.commandCompact : cmdSpaced.replace(/\s+/g, '');
  const maskedCompact = maskText(cmdCompact);
  const maskedQuestion = maskText(detected.question || '');

  let entry = `[${timestamp}]\n`;
  entry += `Command (spaced): ${maskedSpaced}\n`;
  entry += `Question: ${maskedQuestion}\n`;
  entry += `Options:\n`;
  for (const opt of (detected.options || [])) {
    entry += `  ${opt.key || opt.number}: ${maskText(opt.text)}\n`;
  }

  // Log dry-run decision
  if (decision && decision.log) {
    entry += `Decision: ${decision.log}\n`;
  }
  // Record matched deny rule name for blocked commands
  if (decision && decision.action === 'blocked' && decision.rule) {
    entry += `Rule: ${decision.rule}\n`;
  }
  entry += `Outcome: shown\n`;

  try {
    fs.appendFileSync(promptsLogPath, entry, 'utf8');
  } catch (err) {}

  // Write to history.jsonl
  const sessionKey = options.sessionKey || (profile ? `${(profile.id || 'agy')}:${options.folderHash || 'default'}` : null);
  const folder = options.folder || path.basename(options.cwd || process.cwd());

  const historyEvent = {
    type: 'prompt',
    time: timestamp,
    sessionId,
    sessionKey,
    folder,
    agent: (profile && profile.id) || 'agy',
    question: maskedQuestion,
    command: {
      spaced: maskedSpaced,
      compact: maskedCompact
    },
    options: (detected.options || []).map(o => ({
      key: o.key || String(o.number),
      number: o.number,
      text: maskText(o.text),
      classification: o.classification
    })),
    decision: {
      action: decision.action,
      rule: decision.rule || null,
      delay: decision.delay !== undefined ? decision.delay : null,
      optionKey: decision.optionKey || null,
      reason: decision.reason || null
    },
    rule: (decision && decision.rule) || null,
    outcome: 'shown'
  };
  appendHistoryEvent(historyEvent, historyPath);

  return { entry, historyEvent };
}

module.exports = {
  startAgentwatch,
  logPromptRecord
};
