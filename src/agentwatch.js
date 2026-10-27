#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
let pty;
try {
  pty = require('node-pty');
} catch (e) {
  pty = require('@lydell/node-pty');
}
const { Terminal } = require('@xterm/headless');
const { extractPromptFromScreen, getSelectedOptionNumberFromScreen } = require('./parser');
const { resolveExecutable } = require('./resolver');
const { getProfileForCommand, getNoProfileNotice } = require('./profile');
const {
  evaluatePrompt,
  loadRules,
  loadRulesForFolder,
  resolveRulesPath,
  getFolderRulesPath,
  hasFolderRules,
  loadFolderRules,
  loadFolderChoices,
  computeFolderAncestors,
  isChoiceQuestion
} = require('./rules');
const { maskText, maskScreenLines } = require('./masker');
const { appendHistoryEvent, computeAgreement } = require('./history');
const { SessionStatusManager } = require('./status');
const { SessionStateTracker } = require('./state');
const { loadConfig, isGuiRunning, isGuiStale, stopGui } = require('./shared');
const { startGui } = require('./gui');

/**
 * Runs the agentwatch monitor around a child process.
 */
function startAgentwatch(options = {}) {
  const command = options.command;
  const commandArgs = options.args || [];
  const record = Boolean(options.record);

  const profile = options.profile !== undefined ? options.profile : getProfileForCommand(command);
  const hasProfile = Boolean(profile);
  const commandBaseName = command
    ? path.basename(command).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase()
    : 'agent';
  const agentName = (profile && profile.id) || commandBaseName;

  const rawCwd = options.cwd || process.cwd();
  const normalizedCwd = path.resolve(rawCwd);
  const canonicalCwd = process.platform === 'win32' ? normalizedCwd.toLowerCase() : normalizedCwd;
  const folderHash = crypto.createHash('sha256').update(canonicalCwd).digest('hex').slice(0, 16);
  const folderKey = options.sessionKey || `${agentName}:${folderHash}`;
  const folderRulesDir = options.folderRulesDir;
  const choicesPath = options.choicesPath;
  const ancestors = options.ancestors || computeFolderAncestors(rawCwd, agentName);

  // Check for nested folder question at startup
  let initialPendingQuestion = null;
  const choices = loadFolderChoices(choicesPath);
  const savedChoice = choices[folderKey];
  const hasOwnRules = hasFolderRules(folderKey, folderRulesDir);

  if (!hasOwnRules && (!savedChoice || (!savedChoice.choice && (savedChoice.dismissCount || 0) < 2))) {
    for (const anc of ancestors) {
      if (hasFolderRules(anc.key, folderRulesDir)) {
        const ancRules = loadFolderRules(anc.key, folderRulesDir);
        const ruleCount = (ancRules && ancRules.optionRules) ? ancRules.optionRules.length : 0;
        initialPendingQuestion = {
          type: 'nested_folder_rules',
          folderKey,
          folderName: path.basename(rawCwd),
          ancestorKey: anc.key,
          ancestorName: anc.name,
          ruleCount
        };
        break;
      }
    }
  }

  const targetRulesPath = resolveRulesPath(options.rulesPath, rawCwd);
  const folderRulesPath = getFolderRulesPath(folderKey, folderRulesDir);

  let lastDefaultRulesMtime = 0;
  let lastFolderRulesMtime = 0;
  let lastRulesReloadTime = Date.now();
  try {
    if (fs.existsSync(targetRulesPath)) {
      lastDefaultRulesMtime = fs.statSync(targetRulesPath).mtimeMs;
    }
    if (fs.existsSync(folderRulesPath)) {
      lastFolderRulesMtime = fs.statSync(folderRulesPath).mtimeMs;
    }
  } catch (e) {}

  let rules = loadRulesForFolder(folderKey, targetRulesPath, folderRulesDir);
  let previousRules = null;

  function getEffectiveRules(promptShownTime) {
    try {
      let defMtime = 0;
      let folMtime = 0;
      if (fs.existsSync(targetRulesPath)) {
        defMtime = fs.statSync(targetRulesPath).mtimeMs;
      }
      if (fs.existsSync(folderRulesPath)) {
        folMtime = fs.statSync(folderRulesPath).mtimeMs;
      }
      if (defMtime > lastDefaultRulesMtime || folMtime > lastFolderRulesMtime) {
        previousRules = rules;
        rules = loadRulesForFolder(folderKey, targetRulesPath, folderRulesDir);
        lastDefaultRulesMtime = defMtime;
        lastFolderRulesMtime = folMtime;
        lastRulesReloadTime = Date.now();
      }
    } catch (e) {}

    if (promptShownTime && promptShownTime < lastRulesReloadTime && previousRules) {
      return {
        ...rules,
        _inFlightPrompt: true,
        _oldRules: previousRules
      };
    }
    return rules;
  }

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

  // Auto-accept configuration (OFF by default, enabled via --auto or config.autoAcceptDefault)
  const config = loadConfig(options.configPath);
  const initialAutoAccept = options.auto !== undefined
    ? Boolean(options.auto)
    : (options.autoAccept !== undefined ? Boolean(options.autoAccept) : Boolean(config.autoAcceptDefault));
  let autoAcceptEnabled = initialAutoAccept;
  let autoOnTimestamp = initialAutoAccept ? sessionStartTime : null;

  // Session ID & Control directory
  const sessionId = options.sessionId || `session-${Date.now()}-${process.pid}`;
  const controlDir = options.controlDir || process.env.AGENTWATCH_CONTROL_DIR || path.join(os.homedir(), '.agentwatch', 'control');
  const controlFilePath = path.join(controlDir, `${sessionId}.json`);

  // Check auto-open window
  const shouldAutoOpen = options.autoOpenWindow !== undefined
    ? Boolean(options.autoOpenWindow)
    : (config.autoOpenWindow !== false && !options.stdin && !process.env.AGENTWATCH_TEST);

  if (shouldAutoOpen) {
    const isRunning = isGuiRunning(config);
    if (isRunning && isGuiStale(config)) {
      stopGui(config, options.configPath);
    }
    if (!isGuiRunning(config)) {
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
  }

  const hasAllowPersist = Boolean(
    rules &&
    Array.isArray(rules.optionRules) &&
    rules.optionRules.some(r => r && r.allowPersist === true)
  );

  // Session ID & Status Manager
  const statusManager = new SessionStatusManager({
    sessionId,
    agent: agentName,
    hasProfile,
    auto: autoAcceptEnabled,
    token: options.token,
    controlFilePath,
    allowPersist: hasAllowPersist,
    cwd: options.cwd || process.cwd(),
    sessionKey: folderKey,
    ancestors,
    pendingQuestion: initialPendingQuestion,
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
    try {
      rawStream = fs.createWriteStream(rawSessionPath, { flags: 'a' });
      rawStream.on('error', () => {});
    } catch (e) {}
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
    const effectiveState = (activePrompt && activePrompt.inCountdown) ? 'countdown' : newState;
    const countdownVal = (activePrompt && activePrompt.inCountdown) ? activePrompt.countdownSeconds : null;
    statusManager.update(effectiveState, stateSince, promptSummary, { backgroundTasks: bgTasks, countdown: countdownVal });
  });

  let lastScreenText = null;
  let activePrompt = null;
  let recentlyClosedPrompt = null;
  let promptDebounceTimer = null;
  let quietTimer = null;
  let lastSnapshotText = null;
  let countdownTimer = null;
  let currentCountdownPrompt = null;
  let circuitBreakerTripped = false;
  let lastUserKeystrokeTime = 0;
  let lastChildDataReceivedTime = Date.now();
  const autoAnswersHistory = options.autoAnswersHistory || [];

  function checkCircuitBreaker(cmd, now = Date.now()) {
    if (!autoAcceptEnabled) {
      return { tripped: true, reason: 'auto-accept disabled for this session' };
    }
    const last60s = autoAnswersHistory.filter(e => now - e.time <= 60000);
    if (last60s.length >= 8) {
      return { tripped: true, reason: `more than 8 auto answers in 60 seconds (${last60s.length} in last 60s)` };
    }
    return { tripped: false };
  }

  function checkCircuitBreakerAfterSend(cmd, now = Date.now()) {
    const last60s = autoAnswersHistory.filter(e => now - e.time <= 60000);
    const last3 = autoAnswersHistory.slice(-3);
    const is3SameIn30s = last3.length === 3 && last3.every(e => e.command === cmd && (now - e.time <= 30000));
    const isMoreThan8In60s = last60s.length > 8;

    if (isMoreThan8In60s || is3SameIn30s) {
      const reason = isMoreThan8In60s
        ? `more than 8 auto answers in 60 seconds (${last60s.length} in last 60s)`
        : `same command auto-answered 3 times in a row within 30 seconds ("${cmd}")`;
      return { tripped: true, reason };
    }
    return { tripped: false };
  }

  function applyCircuitBreakerTrip(reason) {
    circuitBreakerTripped = true;
    autoAcceptEnabled = false;
    statusManager.auto = false;
    const now = Date.now();
    const timestamp = new Date(now).toISOString();
    const logLine = `[${timestamp}] Circuit breaker tripped: ${reason}. Auto-accept disabled for this session.\n`;
    try {
      fs.appendFileSync(promptsLogPath, logLine, 'utf8');
    } catch (e) {}

    appendHistoryEvent({
      type: 'circuit_breaker',
      time: timestamp,
      sessionId,
      sessionKey: statusManager.sessionKey,
      folder: statusManager.folder,
      agent: (profile && profile.id) || 'agy',
      reason,
      outcome: 'disabled'
    }, historyPath);

    statusManager.countdown = null;
    if (activePrompt) {
      statusManager.update('asking', timestamp, {
        ...activePrompt.detected,
        decision: activePrompt.decision
      });
    }
  }

  // HARD SAFETY RULE:
  // Exactly ONE function (sendAutoAnswer) may write anything to the child other than the user's own keystrokes.
  // It sends exactly one key: the option's key from the profile (for the Antigravity profile, the single digit; no Enter).
  // It can only be called from the auto-accept decision path.
  function sendAutoAnswer(optionKey) {
    const keyToSend = String(optionKey);
    ptyProcess.write(keyToSend);

    const now = Date.now();
    const countdownDuration = activePrompt ? Math.max(0, Math.round((now - activePrompt.shownTime) / 1000)) : 3;

    if (activePrompt && activePrompt.detected) {
      const cmd = activePrompt.detected.commandSpaced || activePrompt.detected.command || '';
      autoAnswersHistory.push({ time: now, command: cmd });
      const cb = checkCircuitBreakerAfterSend(cmd, now);
      if (cb.tripped) {
        applyCircuitBreakerTrip(cb.reason);
      }
    }

    if (activePrompt) {
      activePrompt.autoAnswered = true;
      activePrompt.answeredBy = 'auto';
      activePrompt.hasFinalAnswer = true;
      const matchedOpt = (activePrompt.detected.options || []).find(o => o.key === keyToSend || String(o.number) === keyToSend);
      activePrompt.lastAnswerSignal = {
        type: 'digit',
        key: keyToSend,
        option: matchedOpt,
        optionNumber: matchedOpt ? matchedOpt.number : parseInt(keyToSend, 10) || 1
      };
      if (activePrompt.decision) {
        const rName = (activePrompt.decision && activePrompt.decision.rule) || 'unknown';
        const isFolderRule = (activePrompt.decision && activePrompt.decision.ruleList === 'folder');
        const rPrefix = isFolderRule ? 'folder rule: ' : 'rule: ';
        activePrompt.decision.log = `Auto-approved option ${keyToSend} (${rPrefix}${rName})`;
      }
      onFinalAnswerSeen(activePrompt);
    }

    const timestamp = new Date(now).toISOString();
    const ruleName = (activePrompt && activePrompt.decision && activePrompt.decision.rule) || 'unknown';
    const isFolderRule = (activePrompt && activePrompt.decision && activePrompt.decision.ruleList === 'folder');
    const rPrefix = isFolderRule ? 'folder rule: ' : 'rule: ';
    const maskedSpaced = activePrompt && activePrompt.detected ? maskText(activePrompt.detected.commandSpaced || activePrompt.detected.command || '') : '';
    const maskedCompact = activePrompt && activePrompt.detected ? maskText(activePrompt.detected.commandCompact || '') : '';

    const matchedOpt = (activePrompt && activePrompt.detected && activePrompt.detected.options)
      ? activePrompt.detected.options.find(o => o.key === keyToSend || String(o.number) === keyToSend)
      : null;
    const rawOptionText = (matchedOpt && matchedOpt.text)
      ? matchedOpt.text
      : ((activePrompt && activePrompt.decision && activePrompt.decision.optionText) || '');
    const maskedOptionText = maskText(rawOptionText);

    const autoApproveMsg = `Auto-approved option ${keyToSend} (${rPrefix}${ruleName})`;
    const logLine = `[${timestamp}]\n${autoApproveMsg}\nAuto-accepted command: ${maskedSpaced}\nRule: ${ruleName}\nOption key: ${keyToSend}\nOption text: ${maskedOptionText}\nCountdown: ${countdownDuration}s\nAnswered by: auto\n\n`;
    try {
      fs.appendFileSync(promptsLogPath, logLine, 'utf8');
    } catch (e) {}

    if (activePrompt && activePrompt.detected) {
      appendHistoryEvent({
        type: 'auto_answer',
        time: timestamp,
        sessionId,
        sessionKey: statusManager.sessionKey,
        folder: statusManager.folder,
        agent: (profile && profile.id) || 'agy',
        command: {
          spaced: maskedSpaced,
          compact: maskedCompact
        },
        rule: ruleName,
        rule_list: isFolderRule ? 'folder' : 'default',
        winning_rule: (activePrompt && activePrompt.decision && (activePrompt.decision.winningRule || activePrompt.decision.rule)) || ruleName,
        skipped_rules: (activePrompt && activePrompt.decision && activePrompt.decision.skippedRules) || [],
        option_key: keyToSend,
        option_text: maskedOptionText,
        countdown_duration: countdownDuration,
        answered_by: 'auto',
        agreement: 'n/a'
      }, historyPath);
    }

    statusManager.countdown = null;
  }

  function cancelCountdown(reason = 'vetoed', promptObj = null) {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    statusManager.countdown = null;
    const targetPrompt = promptObj || activePrompt || currentCountdownPrompt;
    if (targetPrompt) {
      targetPrompt.inCountdown = false;
      const timestamp = new Date().toISOString();
      const ruleName = (targetPrompt.decision && targetPrompt.decision.rule) || 'unknown';
      const cmdSpaced = targetPrompt.detected ? (targetPrompt.detected.commandSpaced || targetPrompt.detected.command || '') : '';
      const cmdCompact = targetPrompt.detected ? (targetPrompt.detected.commandCompact || '') : '';

      if (reason === 'vetoed') {
        targetPrompt.vetoed = true;
        targetPrompt.answeredBy = 'vetoed';
        const logLine = `[${timestamp}] Auto-accept cancelled (vetoed by user)\n`;
        try {
          fs.appendFileSync(promptsLogPath, logLine, 'utf8');
        } catch (e) {}
        appendHistoryEvent({
          type: 'auto_vetoed',
          time: timestamp,
          sessionId,
          sessionKey: statusManager.sessionKey,
          folder: statusManager.folder,
          agent: (profile && profile.id) || 'agy',
          command: {
            spaced: maskText(cmdSpaced),
            compact: maskText(cmdCompact)
          },
          rule: ruleName,
          answered_by: 'vetoed',
          outcome: 'vetoed'
        }, historyPath);
      } else if (reason === 'auto_paused') {
        const logLine = `[${timestamp}] Auto-accept cancelled (autoPaused is true)\n`;
        try {
          fs.appendFileSync(promptsLogPath, logLine, 'utf8');
        } catch (e) {}
      } else if (reason === 'screen_changed') {
        const logLine = `[${timestamp}] Auto-accept cancelled (screen changed during countdown)\n`;
        try {
          fs.appendFileSync(promptsLogPath, logLine, 'utf8');
        } catch (e) {}
      } else if (reason === 'danger') {
        const matchedEntry = (targetPrompt.decision && (targetPrompt.decision.entry || targetPrompt.decision.reason)) || 'danger';
        const logLine = `[${timestamp}] Auto-accept cancelled (DANGER: ${maskText(matchedEntry)})\n`;
        try {
          fs.appendFileSync(promptsLogPath, logLine, 'utf8');
        } catch (e) {}
      } else if (reason === 'turned_off') {
        const logLine = `[${timestamp}] Auto-accept cancelled (turned off via GUI)\n`;
        try {
          fs.appendFileSync(promptsLogPath, logLine, 'utf8');
        } catch (e) {}
      }

      statusManager.update('asking', timestamp, {
        ...targetPrompt.detected,
        decision: targetPrompt.decision
      });
    }
    if (activePrompt && activePrompt !== targetPrompt) {
      activePrompt.inCountdown = false;
    }
    currentCountdownPrompt = null;
  }

  function readControlFile() {
    try {
      if (!fs.existsSync(controlFilePath)) {
        return null;
      }
      const raw = fs.readFileSync(controlFilePath, 'utf8').trim();
      if (!raw) return null;
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        return null; // Malformed JSON -> ignored
      }
      if (!data || typeof data !== 'object') return null;
      if (data.sessionId !== sessionId) return null;
      if (data.token !== statusManager.token) return null;
      const ts = new Date(data.timestamp).getTime();
      if (isNaN(ts) || ts < sessionStartTime) return null;
      const desired = String(data.state || data.desiredState || '').trim().toLowerCase();
      if (desired !== 'on' && desired !== 'off') return null;

      if (desired === 'on') {
        // "on" is honored only if Settings checkbox was enabled when written and real profiled session
        if (data.allowTurnOnFromWindow !== true) return null;
        if (!hasProfile) return null;
      }

      return {
        state: desired,
        timestamp: ts,
        data
      };
    } catch (e) {
      return null;
    }
  }

  function syncControlState() {
    if (circuitBreakerTripped) {
      autoAcceptEnabled = false;
      statusManager.auto = false;
      return false;
    }

    const ctrl = readControlFile();
    let newAutoState = initialAutoAccept;
    if (ctrl) {
      if (ctrl.state === 'off') {
        newAutoState = false;
      } else if (ctrl.state === 'on') {
        newAutoState = true;
        if (!autoOnTimestamp || ctrl.timestamp > autoOnTimestamp) {
          autoOnTimestamp = ctrl.timestamp;
        }
      }
    }

    if (autoAcceptEnabled && !newAutoState) {
      autoAcceptEnabled = false;
      statusManager.auto = false;
      cancelCountdown('turned_off');
    } else if (!autoAcceptEnabled && newAutoState) {
      autoAcceptEnabled = true;
      statusManager.auto = true;
      statusManager.writeStatus();
    }
    return autoAcceptEnabled;
  }

  function isPromptEligibleForAuto(detected, decision) {
    syncControlState();
    if (!autoAcceptEnabled) return false;
    if (!hasProfile) return false;
    if (!detected || !detected.footerSeen) return false;
    if (!decision || decision.action !== 'would_approve') return false;

    // A prompt already on screen when "on" was clicked is not auto-answered
    if (activePrompt && autoOnTimestamp && activePrompt.shownTime <= autoOnTimestamp) {
      return false;
    }

    // Must not look like a choice question (no clear yes/no meaning)
    if (isChoiceQuestion(detected)) return false;

    // Option eligibility:
    if (decision.ruleType === 'optionRule') {
      const chosenOpt = (detected.options || []).find(o => o.key === decision.optionKey || String(o.number) === decision.optionKey);
      if (!chosenOpt) return false;
      // Option must not be a "no" option
      if (chosenOpt.classification === 'no' || /^(?:no\b|cancel\b|abort\b|reject\b)/i.test((chosenOpt.text || '').trim())) {
        return false;
      }
      // If persist option, rule must have allowPersist true
      const isPersist = chosenOpt.classification === 'yes_persist' ||
        /\b(?:persist|settings\.json)\b/i.test(chosenOpt.text || '') ||
        (chosenOpt.text || '').toLowerCase().includes('persist') ||
        (chosenOpt.text || '').toLowerCase().includes('settings.json');
      if (isPersist) {
        const optionRules = Array.isArray(rules.optionRules) ? rules.optionRules : [];
        const ruleObj = optionRules.find(r => r && r.name === decision.rule);
        if (!ruleObj || !ruleObj.allowPersist) {
          return false;
        }
      }
    } else {
      // Existing command allow list requirements:
      // Exactly ONE option on screen must be yes_once
      const yesOnceOpts = (detected.options || []).filter(o => o.classification === 'yes_once');
      if (yesOnceOpts.length !== 1) return false;

      // Chosen option must be classified yes_once (never yes_session, yes_persist, or no)
      const chosen = yesOnceOpts[0];
      if (chosen.classification !== 'yes_once') return false;
    }

    // Check circuit breaker
    const cmd = detected.commandSpaced || detected.command || '';
    const cb = checkCircuitBreaker(cmd);
    if (cb.tripped) {
      applyCircuitBreakerTrip(cb.reason);
      return false;
    }

    // Check config autoPaused
    const liveCfg = loadConfig(options.configPath);
    if (liveCfg.autoPaused) {
      return false;
    }

    return true;
  }

  function triggerAutoAnswer(promptObj) {
    if (!promptObj || activePrompt !== promptObj) return;

    syncControlState();
    if (!autoAcceptEnabled) {
      cancelCountdown('turned_off');
      return;
    }

    if (promptObj && autoOnTimestamp && promptObj.shownTime <= autoOnTimestamp) {
      cancelCountdown('turned_off');
      return;
    }

    if (Date.now() - lastUserKeystrokeTime < 1000) {
      cancelCountdown('vetoed');
      return;
    }

    const liveCfg = loadConfig(options.configPath);
    if (liveCfg.autoPaused) {
      cancelCountdown('auto_paused');
      return;
    }

    const cmd = promptObj.detected.commandSpaced || promptObj.detected.command || '';
    const cb = checkCircuitBreaker(cmd);
    if (cb.tripped) {
      cancelCountdown('circuit_breaker');
      applyCircuitBreakerTrip(cb.reason);
      return;
    }

    // Re-evaluate right before sending (Requirement 3):
    // re-read live in-memory screen and confirm SAME prompt is still on screen
    // with same command and same options, unchanged for at least 300 ms.
    const now = Date.now();
    const currentLines = getScreenLines();
    const currentDetected = extractPromptFromScreen(currentLines, profile);

    if (!currentDetected) {
      cancelCountdown('screen_changed');
      promptObj.decision = { action: 'needs_user', reason: 'prompt left screen' };
      statusManager.update('asking', new Date().toISOString(), { decision: promptObj.decision });
      return;
    }

    const curCmd = currentDetected.commandSpaced || currentDetected.command || '';
    const origCmd = promptObj.detected.commandSpaced || promptObj.detected.command || '';
    if (curCmd !== origCmd) {
      cancelCountdown('screen_changed');
      promptObj.decision = { action: 'needs_user', reason: 'command changed on screen' };
      statusManager.update('asking', new Date().toISOString(), { ...currentDetected, decision: promptObj.decision });
      return;
    }

    if (!currentDetected.options || currentDetected.options.length !== promptObj.detected.options.length) {
      cancelCountdown('screen_changed');
      promptObj.decision = { action: 'needs_user', reason: 'options changed on screen' };
      statusManager.update('asking', new Date().toISOString(), { ...currentDetected, decision: promptObj.decision });
      return;
    }

    for (let i = 0; i < currentDetected.options.length; i++) {
      const co = currentDetected.options[i];
      const oo = promptObj.detected.options[i];
      if (!oo || co.key !== oo.key || co.text !== oo.text) {
        cancelCountdown('screen_changed');
        promptObj.decision = { action: 'needs_user', reason: 'options changed on screen' };
        statusManager.update('asking', new Date().toISOString(), { ...currentDetected, decision: promptObj.decision });
        return;
      }
    }

    // Unchanged for at least 300 ms
    if (now - lastChildDataReceivedTime < 300 || now - promptObj.shownTime < 300) {
      cancelCountdown('screen_changed');
      promptObj.decision = { action: 'needs_user', reason: 'screen changed within 300ms' };
      statusManager.update('asking', new Date().toISOString(), { ...currentDetected, decision: promptObj.decision });
      return;
    }

    // Check danger list right before sending - danger WINS over everything and cancels countdown
    const currentRules = getEffectiveRules(promptObj ? promptObj.shownTime : Date.now());
    const currentDecision = evaluatePrompt(currentDetected, currentRules);
    if (currentDecision && (currentDecision.danger || (currentDecision.reason && currentDecision.reason.startsWith('DANGER:')))) {
      promptObj.decision = currentDecision;
      cancelCountdown('danger');
      return;
    }

    if (!currentDecision || currentDecision.action !== 'would_approve') {
      promptObj.decision = currentDecision || { action: 'needs_user', reason: 'decision changed' };
      cancelCountdown('screen_changed');
      statusManager.update('asking', new Date().toISOString(), { ...currentDetected, decision: promptObj.decision });
      return;
    }

    promptObj.inCountdown = false;
    syncControlState();
    if (!autoAcceptEnabled) {
      cancelCountdown('turned_off');
      return;
    }
    if (promptObj && autoOnTimestamp && promptObj.shownTime <= autoOnTimestamp) {
      cancelCountdown('turned_off');
      return;
    }
    const optionKey = promptObj.decision.optionKey || currentDecision.optionKey || '1';
    sendAutoAnswer(optionKey);
  }

  function startPromptCountdown(promptObj) {
    syncControlState();
    if (!autoAcceptEnabled) return;
    if (promptObj && autoOnTimestamp && promptObj.shownTime <= autoOnTimestamp) return;

    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }

    const delay = (promptObj.decision && promptObj.decision.delay !== undefined)
      ? promptObj.decision.delay
      : 3;
    const delayMs = Math.max(0, Math.round(delay * 1000));
    const initialSecs = Math.max(1, Math.ceil(delay));

    promptObj.inCountdown = true;
    currentCountdownPrompt = promptObj;
    promptObj.countdownSeconds = initialSecs;
    promptObj.countdownStart = Date.now();
    statusManager.countdown = initialSecs;
    statusManager.update('countdown', new Date().toISOString(), {
      ...promptObj.detected,
      decision: promptObj.decision
    }, { countdown: initialSecs, rule: promptObj.decision && promptObj.decision.rule });

    if (delayMs <= 0) {
      triggerAutoAnswer(promptObj);
      return;
    }

    const intervalMs = delayMs < 1000 ? 50 : 1000;
    const startTime = Date.now();

    countdownTimer = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remainingMs = delayMs - elapsed;
      const remainingSecs = Math.max(0, Math.ceil(remainingMs / 1000));

      if (!activePrompt || activePrompt !== promptObj || !promptObj.inCountdown) {
        if (countdownTimer) clearInterval(countdownTimer);
        countdownTimer = null;
        return;
      }

      syncControlState();
      if (!autoAcceptEnabled) {
        cancelCountdown('turned_off');
        return;
      }

      if (Date.now() - lastUserKeystrokeTime < 1000) {
        cancelCountdown('vetoed');
        return;
      }

      if (remainingMs > 0) {
        promptObj.countdownSeconds = remainingSecs;
        statusManager.countdown = remainingSecs;
        statusManager.update('countdown', new Date().toISOString(), {
          ...promptObj.detected,
          decision: promptObj.decision
        }, { countdown: remainingSecs, rule: promptObj.decision && promptObj.decision.rule });
      } else {
        if (countdownTimer) clearInterval(countdownTimer);
        countdownTimer = null;
        triggerAutoAnswer(promptObj);
      }
    }, intervalMs);

    if (countdownTimer.unref) {
      countdownTimer.unref();
    }
  }

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

  function onFinalAnswerSeen(targetPrompt) {
    if (targetPrompt === recentlyClosedPrompt && targetPrompt.closedEvent) {
      const signal = targetPrompt.lastAnswerSignal;
      let answerKey = 'unknown';
      let answerOptionText = null;
      let answerClass = 'unknown';
      let agreement = 'n/a';

      if (signal) {
        if (signal.type === 'digit') {
          answerKey = signal.key;
          answerOptionText = signal.option ? maskText(signal.option.text) : null;
          answerClass = (signal.option && signal.option.classification) || 'unknown';
          agreement = computeAgreement(targetPrompt.decision, answerKey, answerClass);
        } else if (signal.type === 'enter') {
          answerKey = 'enter';
          answerOptionText = signal.option ? maskText(signal.option.text) : null;
          answerClass = (signal.option && signal.option.classification) || 'unknown';
          agreement = computeAgreement(targetPrompt.decision, answerKey, answerClass);
        } else if (signal.type === 'esc') {
          answerKey = 'esc';
          answerOptionText = null;
          answerClass = 'no';
          agreement = computeAgreement(targetPrompt.decision, answerKey, answerClass);
        } else if (signal.type === 'amended') {
          answerKey = 'amended';
          answerOptionText = null;
          answerClass = 'unknown';
          agreement = computeAgreement(targetPrompt.decision, answerKey, answerClass);
        }
      }

      if (targetPrompt.autoAnswered) {
        agreement = 'n/a';
      }
      targetPrompt.closedEvent.answer_key = answerKey;
      targetPrompt.closedEvent.answer_option_text = answerOptionText;
      targetPrompt.closedEvent.answer_class = answerClass;
      targetPrompt.closedEvent.agreement = agreement;
      const answeredBy = targetPrompt.autoAnswered ? 'auto' : (targetPrompt.vetoed ? 'vetoed' : (signal ? 'user' : 'unknown'));
      targetPrompt.closedEvent.answered_by = answeredBy;

      // Update in historyPath
      const targetHistoryPath = historyPath || path.join(os.homedir(), '.agentwatch', 'history.jsonl');
      if (fs.existsSync(targetHistoryPath)) {
        try {
          const content = fs.readFileSync(targetHistoryPath, 'utf8');
          const lines = content.trim().split('\n');
          for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].trim()) continue;
            try {
              const ev = JSON.parse(lines[i]);
              if (ev.type === 'prompt_closed' && ev.time === targetPrompt.closedEvent.time) {
                targetPrompt.closedEvent.sessionId = ev.sessionId;
                lines[i] = JSON.stringify(targetPrompt.closedEvent);
                fs.writeFileSync(targetHistoryPath, lines.join('\n') + '\n', 'utf8');
                break;
              }
            } catch (e) {}
          }
        } catch (e) {}
      }
    }
  }

  function handlePromptKeystroke(buf, now = Date.now()) {
    let targetPrompt = null;
    if (activePrompt) {
      targetPrompt = activePrompt;
    } else if (recentlyClosedPrompt) {
      const elapsed = now - (recentlyClosedPrompt.disappearedAt || recentlyClosedPrompt.closedAt || 0);
      if (elapsed <= 300) {
        targetPrompt = recentlyClosedPrompt;
      } else {
        recentlyClosedPrompt = null;
      }
    }

    if (!targetPrompt) return;

    // Fix 1: Once a final answer signal is seen for a prompt, record it and ignore
    // any further keystrokes for that prompt, including Enter, Esc and other digits.
    // Do not let a later key overwrite it.
    if (targetPrompt.hasFinalAnswer) {
      return;
    }

    // 1. Tab (0x09) or Ctrl+G (0x07): Enter amend/edit mode
    if (buf.includes(0x09) || buf.includes(0x07)) {
      targetPrompt.isAmending = true;
      targetPrompt.lastAnswerSignal = {
        type: 'amended',
        key: 'amended',
        option: null,
        optionNumber: null
      };
      // Amend is NOT final yet - user may type then hit Enter or Esc
      return;
    }

    // 2. Esc key alone (0x1b, length 1)
    // "Enter and Esc are final only when no digit answer was seen first."
    if (buf.length === 1 && buf[0] === 0x1b) {
      targetPrompt.isAmending = false;
      targetPrompt.lastAnswerSignal = {
        type: 'esc',
        key: 'esc',
        option: null,
        optionNumber: null
      };
      targetPrompt.hasFinalAnswer = true;
      onFinalAnswerSeen(targetPrompt);
      return;
    }

    // 3. Arrow keys and other multi-byte escape sequences (e.g. \x1b[A, \x1b[B):
    // "Arrow keys still only move the selection and are never answers."
    if (buf.length > 1 && buf[0] === 0x1b) {
      return;
    }

    // 4. Enter key (0x0d or 0x0a)
    // "Enter and Esc are final only when no digit answer was seen first."
    const isEnter = (buf.length === 1 && (buf[0] === 0x0d || buf[0] === 0x0a)) ||
                    (buf.length === 2 && buf[0] === 0x0d && buf[1] === 0x0a);
    if (isEnter) {
      if (targetPrompt.isAmending) {
        targetPrompt.lastAnswerSignal = {
          type: 'amended',
          key: 'amended',
          option: null,
          optionNumber: null
        };
      } else {
        const lines = getScreenLines();
        const selectedNum = getSelectedOptionNumberFromScreen(lines) || targetPrompt.lastSelectedOptionNumber || 1;
        const chosenOption = (targetPrompt.detected.options || []).find(o => o.number === selectedNum) ||
                             (targetPrompt.detected.options && targetPrompt.detected.options[0]) ||
                             null;
        targetPrompt.lastAnswerSignal = {
          type: 'enter',
          key: 'enter',
          option: chosenOption,
          optionNumber: selectedNum
        };
      }
      targetPrompt.hasFinalAnswer = true;
      onFinalAnswerSeen(targetPrompt);
      return;
    }

    // 5. Single digit key matching an option number shown on screen (1 to 4)
    // "A digit that matches an option number shown on screen is a FINAL answer signal."
    // "a digit that does not match any option (ignored)"
    if (!targetPrompt.isAmending && buf.length === 1 && buf[0] >= 0x30 && buf[0] <= 0x39) {
      const digit = buf[0] - 0x30;
      const matchedOption = (targetPrompt.detected.options || []).find(o => o.number === digit || o.key === String(digit));
      if (matchedOption) {
        targetPrompt.lastAnswerSignal = {
          type: 'digit',
          key: digit,
          option: matchedOption,
          optionNumber: digit
        };
        targetPrompt.hasFinalAnswer = true;
        onFinalAnswerSeen(targetPrompt);
        return;
      }
      // Out-of-range or non-matching digit: ignored!
      return;
    }

    // 6. Anything else: letters, pasted text, symbols, spaces
    // PRIVACY RULE: Do NOT store the key itself. Never store, log or display any other keystroke.
  }

  function closeActivePrompt(reason) {
    if (!activePrompt) return;
    const now = Date.now();
    const timestamp = new Date(now).toISOString();

    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
    statusManager.countdown = null;

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

    let answerKey = 'unknown';
    let answerOptionText = null;
    let answerClass = 'unknown';
    let agreement = 'n/a';

    const signal = activePrompt.lastAnswerSignal;
    if (signal) {
      if (signal.type === 'digit') {
        answerKey = signal.key;
        answerOptionText = signal.option ? maskText(signal.option.text) : null;
        answerClass = (signal.option && signal.option.classification) || 'unknown';
        agreement = computeAgreement(activePrompt.decision, answerKey, answerClass);
      } else if (signal.type === 'enter') {
        answerKey = 'enter';
        answerOptionText = signal.option ? maskText(signal.option.text) : null;
        answerClass = (signal.option && signal.option.classification) || 'unknown';
        agreement = computeAgreement(activePrompt.decision, answerKey, answerClass);
      } else if (signal.type === 'esc') {
        answerKey = 'esc';
        answerOptionText = null;
        answerClass = 'no';
        agreement = computeAgreement(activePrompt.decision, answerKey, answerClass);
      } else if (signal.type === 'amended') {
        answerKey = 'amended';
        answerOptionText = null;
        answerClass = 'unknown';
        agreement = computeAgreement(activePrompt.decision, answerKey, answerClass);
      }
    }

    let answeredBy = 'unknown';
    if (activePrompt.autoAnswered) {
      answeredBy = 'auto';
      agreement = 'n/a';
      if (activePrompt.decision) {
        const rName = (activePrompt.decision && activePrompt.decision.rule) || 'unknown';
        const isFolderRule = (activePrompt.decision && activePrompt.decision.ruleList === 'folder');
        const rPrefix = isFolderRule ? 'folder rule: ' : 'rule: ';
        activePrompt.decision.log = `Auto-approved option ${answerKey} (${rPrefix}${rName})`;
      }
    } else if (activePrompt.vetoed) {
      answeredBy = 'vetoed';
    } else if (signal) {
      answeredBy = 'user';
    }

    const entry = `Prompt closed at ${durationLogStr}\nAnswered by: ${answeredBy}\n\n`;
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
      rule_list: (activePrompt.decision && activePrompt.decision.ruleList) || 'default',
      winning_rule: (activePrompt.decision && (activePrompt.decision.winningRule || activePrompt.decision.rule)) || null,
      skipped_rules: (activePrompt.decision && activePrompt.decision.skippedRules) || [],
      outcome: 'closed',
      durationSeconds,
      answer_key: answerKey,
      answer_option_text: answerOptionText,
      answer_class: answerClass,
      agreement: activePrompt.autoAnswered ? 'n/a' : agreement,
      answered_by: answeredBy
    };
    appendHistoryEvent(closedEvent, historyPath);

    activePrompt.closedAt = now;
    if (!activePrompt.disappearedAt) {
      activePrompt.disappearedAt = now;
    }
    activePrompt.closedEvent = closedEvent;
    recentlyClosedPrompt = activePrompt;
    activePrompt = null;
  }

  function inspectScreenForPrompts(nowMs) {
    syncControlState();
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
        recentlyClosedPrompt = null;
        const promptRules = getEffectiveRules(Date.now());
        const decision = evaluatePrompt(detected, promptRules);
        activePrompt = {
          detected,
          fingerprint,
          decision,
          shownTime: Date.now(),
          lastAnswerSignal: null,
          hasFinalAnswer: false,
          disappearedAt: null,
          lastSelectedOptionNumber: getSelectedOptionNumberFromScreen(screenLines),
          isAmending: false,
          inCountdown: false,
          vetoed: false,
          autoAnswered: false,
          answeredBy: null
        };
        handleLogPromptRecord(detected, decision);
        saveScreenSnapshot();

        if (isPromptEligibleForAuto(detected, decision)) {
          startPromptCountdown(activePrompt);
        } else if (stateTracker.currentState === 'asking') {
          statusManager.update('asking', stateTracker.stateSince, { ...detected, decision });
        }
      } else if (activePrompt.fingerprint !== fingerprint) {
        if (countdownTimer) {
          clearInterval(countdownTimer);
          countdownTimer = null;
        }
        closeActivePrompt('new_prompt');
        recentlyClosedPrompt = null;
        const promptRules = getEffectiveRules(Date.now());
        const decision = evaluatePrompt(detected, promptRules);
        activePrompt = {
          detected,
          fingerprint,
          decision,
          shownTime: Date.now(),
          lastAnswerSignal: null,
          hasFinalAnswer: false,
          disappearedAt: null,
          lastSelectedOptionNumber: getSelectedOptionNumberFromScreen(screenLines),
          isAmending: false,
          inCountdown: false,
          vetoed: false,
          autoAnswered: false,
          answeredBy: null
        };
        handleLogPromptRecord(detected, decision);
        saveScreenSnapshot();
        if (isPromptEligibleForAuto(detected, decision)) {
          startPromptCountdown(activePrompt);
        } else if (stateTracker.currentState === 'asking') {
          statusManager.update('asking', stateTracker.stateSince, { ...detected, decision });
        }
      } else {
        activePrompt.lastSelectedOptionNumber = getSelectedOptionNumberFromScreen(screenLines);
        // If countdown is active, verify danger hasn't hit
        if (activePrompt.inCountdown) {
          const checkRules = getEffectiveRules(activePrompt.shownTime);
          const currentDecision = evaluatePrompt(detected, checkRules);
          if (currentDecision && (currentDecision.danger || (currentDecision.reason && currentDecision.reason.startsWith('DANGER:')))) {
            activePrompt.decision = currentDecision;
            cancelCountdown('danger');
          }
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

  // Print startup auto-accept status line before the agent starts
  const autoAcceptStatusMsg = `agentwatch: auto-accept is ${autoAcceptEnabled ? 'ON' : 'OFF'} for this session`;
  console.log(autoAcceptStatusMsg);
  if (options.stdout && options.stdout.write && options.stdout !== process.stdout) {
    options.stdout.write(autoAcceptStatusMsg + '\n');
  }

  // Print startup danger list entries count
  const dangerCount = (rules && Array.isArray(rules.danger)) ? rules.danger.length : 0;
  const dangerStatusMsg = `agentwatch: danger list has ${dangerCount} entries`;
  console.log(dangerStatusMsg);
  if (options.stdout && options.stdout.write && options.stdout !== process.stdout) {
    options.stdout.write(dangerStatusMsg + '\n');
  }

  // Print startup warning if any option rule has allowPersist true
  if (hasAllowPersist) {
    const persistWarningMsg = 'agentwatch: warning: allowPersist is enabled in option rules';
    console.warn(persistWarningMsg);
    if (options.stdout && options.stdout.write && options.stdout !== process.stdout) {
      options.stdout.write(persistWarningMsg + '\n');
    }
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
    lastChildDataReceivedTime = Date.now();
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
  // Exactly ONE function (sendAutoAnswer) may write anything to the child other than
  // the user's own keystrokes. It sends exactly one key: the option's key from the profile.
  // It can only be called from the auto-accept decision path.
  if (stdin.isTTY && stdin.setRawMode) {
    stdin.setRawMode(true);
  }
  if (stdin.resume) {
    stdin.resume();
  }

  const onStdinData = (chunk) => {
    lastUserKeystrokeTime = Date.now();
    if (activePrompt && activePrompt.inCountdown) {
      cancelCountdown('vetoed');
    }
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

    // PRIVACY RULE:
    // Extract only discrete answer signals while a complete prompt is on screen,
    // or within 300 ms after it disappears.
    // NEVER store, log, or display any other keystroke. Keystroke text must never reach any file.
    handlePromptKeystroke(buf, Date.now());
  };
  stdin.on('data', onStdinData);

  // Clean exit handling
  ptyProcess.onExit(({ exitCode }) => {
    if (countdownTimer) clearInterval(countdownTimer);
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
      try {
        if (fs.existsSync(controlFilePath)) {
          fs.unlinkSync(controlFilePath);
        }
      } catch (e) {}

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
    handlePromptKeystroke,
    closeActivePrompt,
    sendAutoAnswer,
    cancelCountdown,
    isPromptEligibleForAuto,
    checkCircuitBreaker,
    applyCircuitBreakerTrip,
    triggerAutoAnswer,
    startPromptCountdown,
    getActivePrompt: () => activePrompt,
    getAutoAnswersHistory: () => autoAnswersHistory,
    isAutoAcceptEnabled: () => autoAcceptEnabled,
    setAutoAcceptEnabled: (val) => { autoAcceptEnabled = Boolean(val); statusManager.auto = autoAcceptEnabled; },
    readControlFile,
    syncControlState,
    getControlFilePath: () => controlFilePath,
    getAutoOnTimestamp: () => autoOnTimestamp,
    setAutoOnTimestamp: (ts) => { autoOnTimestamp = ts; },
    cleanup: () => {
      if (countdownTimer) clearInterval(countdownTimer);
      if (quietTimer) clearTimeout(quietTimer);
      if (promptDebounceTimer) clearTimeout(promptDebounceTimer);
      clearInterval(checkInterval);
      try {
        if (fs.existsSync(controlFilePath)) {
          fs.unlinkSync(controlFilePath);
        }
      } catch (e) {}
      statusManager.cleanup();
      recentlyClosedPrompt = null;
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
  // Record matched rule name and option text for would_approve decisions
  if (decision && decision.action === 'would_approve' && decision.rule) {
    entry += `Rule: ${decision.rule}\n`;
    if (decision.winningRule) {
      entry += `Winning rule: ${decision.winningRule}\n`;
    }
    if (decision.skippedRules && decision.skippedRules.length > 0) {
      entry += `Skipped rules: ${decision.skippedRules.join(', ')}\n`;
    }
    if (decision.optionText) {
      entry += `Option text: ${maskText(decision.optionText)}\n`;
    }
  }
  // Record matched danger entry if danger hit
  if (decision && (decision.danger || (decision.reason && decision.reason.startsWith('DANGER:')))) {
    const matchedEntry = decision.entry || (decision.reason.match(/DANGER:\s*matched\s*'([^']+)'/i) || [])[1] || '';
    const maskedMatchedEntry = maskText(matchedEntry);
    entry += `Reason: DANGER: matched '${maskedMatchedEntry}'\n`;
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
      optionText: decision.optionText ? maskText(decision.optionText) : null,
      reason: decision.reason ? maskText(decision.reason) : null,
      danger_entry: decision.entry ? maskText(decision.entry) : null
    },
    rule: (decision && decision.rule) || null,
    option_text: (decision && decision.optionText) ? maskText(decision.optionText) : null,
    reason: decision.reason ? maskText(decision.reason) : null,
    danger_entry: decision.entry ? maskText(decision.entry) : null,
    outcome: 'shown'
  };
  appendHistoryEvent(historyEvent, historyPath);

  return { entry, historyEvent };
}

module.exports = {
  startAgentwatch,
  logPromptRecord
};
