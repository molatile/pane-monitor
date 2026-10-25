const fs = require('fs');
const path = require('path');
const os = require('os');
const { getSessionStatusList, SESSIONS_DIR } = require('./status');
const {
  CONFIG_PATH,
  loadConfig,
  saveConfig,
  getSessionKey,
  getDisplayName,
  setSessionName,
  orderSessions,
  reorderSession,
  acquireNotificationLock,
  EMPTY_STATE_MESSAGE
} = require('./config');
const { NotificationManager } = require('./notifier');

/**
 * Formats duration in state (e.g. "2m 10s", "45s", "1h 15m").
 */
function formatDuration(sinceIso, nowMs = Date.now()) {
  if (!sinceIso) return '0s';
  const t = new Date(sinceIso).getTime();
  if (isNaN(t)) return '0s';
  const elapsedSecs = Math.max(0, Math.floor((nowMs - t) / 1000));
  if (elapsedSecs < 60) return `${elapsedSecs}s`;
  if (elapsedSecs < 3600) {
    const mins = Math.floor(elapsedSecs / 60);
    const secs = elapsedSecs % 60;
    return `${mins}m ${secs}s`;
  }
  const hours = Math.floor(elapsedSecs / 3600);
  const mins = Math.floor((elapsedSecs % 3600) / 60);
  return `${hours}h ${mins}m`;
}

/**
 * Returns the state light representation.
 * Circle character + state word so it still reads without color.
 */
function getStateLight(state, isDead, useColor = true, countdown = null, isAuto = false, rule = null) {
  if (isDead || state === 'dead') {
    return {
      plain: '● DEAD  ',
      formatted: useColor ? '\x1b[90m● DEAD  \x1b[0m' : '● DEAD  '
    };
  }
  switch (state) {
    case 'idle':
      return {
        plain: '● IDLE  ',
        formatted: useColor ? '\x1b[32m● IDLE  \x1b[0m' : '● IDLE  '
      };
    case 'busy':
      return {
        plain: '● BUSY  ',
        formatted: useColor ? '\x1b[33m● BUSY  \x1b[0m' : '● BUSY  '
      };
    case 'asking':
      return {
        plain: '● ASKING',
        formatted: useColor ? '\x1b[31;1m● ASKING\x1b[0m' : '● ASKING'
      };
    case 'countdown': {
      const secs = (countdown !== null && countdown !== undefined) ? `${countdown}s` : '';
      const ruleLabel = rule ? ` (${rule})` : '';
      const autoLabel = isAuto ? ' (auto)' : '';
      const plain = `● COUNTDOWN ${secs}${ruleLabel}${autoLabel}`.trim();
      const formatted = useColor
        ? `\x1b[35;1m● COUNTDOWN ${secs}\x1b[0m${rule ? ` \x1b[33m(${rule})\x1b[0m` : ''}${isAuto ? ' \x1b[36m(auto)\x1b[0m' : ''}`.trim()
        : plain;
      return { plain, formatted };
    }
    default:
      return {
        plain: '● UNKNOWN',
        formatted: useColor ? '\x1b[90m● UNKNOWN\x1b[0m' : '● UNKNOWN'
      };
  }
}

/**
 * Returns one-line summary for a session.
 */
function getSessionSummary(session) {
  if (session.isDead || session.state === 'dead') {
    return 'Session inactive (heartbeat lost)';
  }
  if (session.hasProfile === false) {
    return 'no profile';
  }
  if (session.state === 'countdown') {
    const secs = (session.countdown !== undefined && session.countdown !== null) ? `${session.countdown}s` : '';
    const rule = session.rule || (session.prompt && session.prompt.rule);
    const ruleSuffix = rule ? ` (${rule})` : '';
    return `Auto-accepting in ${secs || '3s'}${ruleSuffix}`;
  }
  if (session.state === 'asking') {
    if (session.prompt && session.prompt.decision && session.prompt.decision.startsWith('DANGER:')) {
      return session.prompt.decision;
    }
    return (session.prompt && session.prompt.question) || 'Permission requested';
  }
  const bgCount = session.backgroundTasks || session.backgroundTaskCount || 0;
  if (bgCount > 0) {
    return `${bgCount} background task${bgCount === 1 ? '' : 's'} running`;
  }
  if (session.state === 'busy') {
    return 'Working...';
  }
  if (session.state === 'idle') {
    return 'Waiting for user';
  }
  return '';
}

function padRight(str, len) {
  const s = String(str || '');
  if (s.length >= len) return s.slice(0, len);
  return s + ' '.repeat(len - s.length);
}

/**
 * Pure rendering function for dashboard screen.
 */
function renderDashboardLines(options = {}) {
  const {
    sessions = [],
    selectedIndex = 0,
    isRenaming = false,
    renameBuffer = '',
    config = {},
    nowMs = Date.now(),
    useColor = true,
    cols = 80
  } = options;

  const lines = [];

  // Header
  const activeCount = sessions.filter(s => !s.isDead && s.state !== 'dead').length;
  const countStr = activeCount === 1 ? '1 agent active' : `${activeCount} agents active`;
  const headerTitle = `agentwatch dashboard · ${countStr}`;
  lines.push(useColor ? `\x1b[1;37m  ${headerTitle}\x1b[0m` : `  ${headerTitle}`);
  lines.push('  ' + '─'.repeat(Math.max(40, Math.min(cols - 4, 76))));

  // Sessions list or empty state
  if (sessions.length === 0) {
    lines.push('');
    lines.push(`  ${EMPTY_STATE_MESSAGE}`);
    lines.push('');
  } else {
    sessions.forEach((session, idx) => {
      const isSelected = idx === selectedIndex;
      const isAsking = session.state === 'asking' && !session.isDead;
      const isCountdown = session.state === 'countdown' && !session.isDead;
      const isPromptActive = (isAsking || isCountdown) && !session.isDead;

      // Selection marker
      const selStr = isSelected
        ? (useColor ? '\x1b[1;36m>\x1b[0m ' : '> ')
        : '  ';

      // Alert marker: [!] for asking, [~] for countdown
      const alertMarker = isAsking
        ? (useColor ? '\x1b[1;31m[!]\x1b[0m ' : '[!] ')
        : (isCountdown ? (useColor ? '\x1b[1;35m[~]\x1b[0m ' : '[~] ') : '    ');

      // Light + State word
      const ruleName = session.rule || (session.prompt && session.prompt.rule);
      const light = getStateLight(session.state, session.isDead, useColor, session.countdown, session.auto, ruleName);

      // Clear AUTO ON marker
      const autoMarker = session.auto
        ? (useColor ? '\x1b[1;36m[AUTO ON]\x1b[0m ' : '[AUTO ON] ')
        : '';

      // PERSIST ALLOWED marker
      const persistMarker = session.allowPersist
        ? (useColor ? '\x1b[1;31m[PERSIST ALLOWED]\x1b[0m ' : '[PERSIST ALLOWED] ')
        : '';

      // Name, Agent, Folder, Duration, Summary
      const name = padRight(getDisplayName(config, session), 16);
      const agent = padRight(session.agent + (session.auto ? ' (auto)' : ''), 10);
      const folder = padRight(session.folder, 16);
      const duration = padRight(formatDuration(session.stateSince, nowMs), 10);
      const summary = getSessionSummary(session);

      const rowText = `${selStr}${alertMarker}${light.formatted}  ${autoMarker}${persistMarker}${name}  ${agent}  ${folder}  ${duration}  ${summary}`;
      lines.push(rowText);

      // Second line for ASKING or COUNTDOWN state: masked command and dry-run decision
      if (isPromptActive && session.prompt) {
        const cmd = session.prompt.command || 'unknown command';
        const decision = session.prompt.decision || 'needs you';
        const line2 = useColor
          ? `      ↳ \x1b[1;37m${cmd}\x1b[0m \x1b[33m(${decision})\x1b[0m`
          : `      ↳ ${cmd} (${decision})`;
        lines.push(line2);
      }
    });
  }

  // Footer / Status Line
  lines.push('  ' + '─'.repeat(Math.max(40, Math.min(cols - 4, 76))));
  if (isRenaming) {
    const currentName = sessions[selectedIndex] ? getDisplayName(config, sessions[selectedIndex]) : '';
    const renamePrompt = `Rename "${currentName}" to: ${renameBuffer}█  (Enter to save, Esc to cancel)`;
    lines.push(useColor ? `\x1b[1;33m  ${renamePrompt}\x1b[0m` : `  ${renamePrompt}`);
  } else {
    lines.push('  ↑/↓: select · r: rename · u/d: move · q: quit');
  }

  return lines;
}

/**
 * Starts the live full-screen dashboard.
 */
function startDashboard(options = {}) {
  const sessionsDir = options.sessionsDir || SESSIONS_DIR;
  const configPath = options.configPath || CONFIG_PATH;
  const refreshIntervalMs = options.refreshIntervalMs || 1000;
  const stdin = options.stdin || process.stdin;
  const stdout = options.stdout || process.stdout;
  const useColor = options.useColor !== undefined ? options.useColor : (stdout.isTTY && !process.env.NO_COLOR);
  const onExitCallback = options.onExit || null;

  const quiet = Boolean(options.quiet);
  const notificationsOption = options.notifications !== false;

  let config = loadConfig(configPath);
  let sessions = [];
  let selectedIndex = 0;
  let isRenaming = false;
  let renameBuffer = '';
  let isRunning = true;

  const notificationsAllowed = !quiet && notificationsOption && config.notifications !== false;

  const notificationManager = new NotificationManager({
    stdout,
    desktopNotifier: options.desktopNotifier,
    bellSender: options.bellSender,
    onNotification: options.onNotification,
    quiet,
    enabled: notificationsAllowed,
    cooldownMs: options.cooldownMs,
    lockAcquirer: (sessionId, state, nowMs) => acquireNotificationLock(sessionId, state, nowMs, configPath)
  });

  // Setup terminal
  if (stdout.isTTY) {
    stdout['write']('\x1b[?1049h\x1b[?25l'); // Alternate screen, hide cursor
  }
  if (stdin.isTTY && stdin.setRawMode) {
    try {
      stdin.setRawMode(true);
      stdin.resume();
    } catch (e) {}
  }

  function cleanup() {
    if (!isRunning) return;
    isRunning = false;

    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }

    if (stdout.isTTY) {
      stdout['write']('\x1b[?25h\x1b[?1049l'); // Show cursor, exit alternate screen
    }

    if (stdin.isTTY && stdin.setRawMode) {
      try {
        stdin.setRawMode(false);
      } catch (e) {}
    }
    if (stdin.pause) {
      stdin.pause();
    }
    stdin.removeListener('data', onKeyData);
    process.removeListener('SIGINT', sigintHandler);
    process.removeListener('SIGTERM', sigintHandler);

    if (onExitCallback) {
      onExitCallback(0);
    } else {
      process.exit(0);
    }
  }

  function refresh() {
    if (!isRunning) return;

    // Reload config & session list
    config = loadConfig(configPath);
    const rawSessions = getSessionStatusList(sessionsDir);
    sessions = orderSessions(rawSessions, config);

    // Keep selection within bounds
    if (sessions.length === 0) {
      selectedIndex = 0;
    } else if (selectedIndex >= sessions.length) {
      selectedIndex = sessions.length - 1;
    }

    // Check notifications
    const allowed = !quiet && notificationsOption && config.notifications !== false;
    notificationManager.setEnabled(allowed);
    notificationManager.checkSessions(sessions, s => getDisplayName(config, s));

    // Render screen
    render();
  }

  function render() {
    if (!isRunning) return;
    const cols = stdout.columns || 80;
    const rows = stdout.rows || 24;
    const lines = renderDashboardLines({
      sessions,
      selectedIndex,
      isRenaming,
      renameBuffer,
      config,
      nowMs: Date.now(),
      useColor,
      cols
    });

    const output = '\x1b[H' + lines.map(line => line + '\x1b[K').join('\r\n') + '\x1b[J';
    stdout['write'](output);
  }

  function onKeyData(chunk) {
    const str = chunk.toString();

    // Ctrl+C is always exit
    if (str === '\x03') {
      cleanup();
      return;
    }

    if (isRenaming) {
      if (str === '\x1b') {
        // Esc: cancel rename
        isRenaming = false;
        renameBuffer = '';
        render();
        return;
      }
      if (str === '\r' || str === '\n') {
        // Enter: save rename
        const selected = sessions[selectedIndex];
        if (selected) {
          const key = getSessionKey(selected);
          setSessionName(config, key, renameBuffer, configPath);
        }
        isRenaming = false;
        renameBuffer = '';
        render();
        return;
      }
      if (str === '\x08' || str === '\x7f') {
        // Backspace
        renameBuffer = renameBuffer.slice(0, -1);
        render();
        return;
      }
      // Printable characters (handles single keystrokes, rapid typing, and pasted text)
      if (!str.startsWith('\x1b')) {
        let clean = '';
        for (const char of str) {
          if (char.charCodeAt(0) >= 32) {
            clean += char;
          }
        }
        if (clean.length > 0) {
          renameBuffer += clean;
          render();
          return;
        }
      }
      return;
    }

    // Non-renaming navigation keys
    if (str === 'q' || str === 'Q') {
      cleanup();
      return;
    }

    // Up Arrow: \x1b[A or \x1bOA
    if (str === '\x1b[A' || str === '\x1bOA') {
      if (selectedIndex > 0) {
        selectedIndex--;
        render();
      }
      return;
    }

    // Down Arrow: \x1b[B or \x1bOB
    if (str === '\x1b[B' || str === '\x1bOB') {
      if (selectedIndex < sessions.length - 1) {
        selectedIndex++;
        render();
      }
      return;
    }

    // 'r': Rename selected session
    if (str === 'r' || str === 'R') {
      if (sessions.length > 0 && sessions[selectedIndex]) {
        isRenaming = true;
        renameBuffer = '';
        render();
      }
      return;
    }

    // 'u': Move selected session up in order
    if (str === 'u' || str === 'U') {
      if (sessions.length > 0 && selectedIndex > 0) {
        const liveKeys = sessions.map(s => getSessionKey(s));
        const key = liveKeys[selectedIndex];
        reorderSession(config, key, -1, liveKeys, configPath);
        selectedIndex--;
        refresh();
      }
      return;
    }

    // 'd': Move selected session down in order
    if (str === 'd' || str === 'D') {
      if (sessions.length > 0 && selectedIndex < sessions.length - 1) {
        const liveKeys = sessions.map(s => getSessionKey(s));
        const key = liveKeys[selectedIndex];
        reorderSession(config, key, 1, liveKeys, configPath);
        selectedIndex++;
        refresh();
      }
      return;
    }
  }

  stdin.on('data', onKeyData);

  // Initial refresh and periodic interval
  refresh();
  let refreshTimer = setInterval(refresh, refreshIntervalMs);
  if (refreshTimer.unref) refreshTimer.unref();

  // Clean exit listeners
  function sigintHandler() { cleanup(); }
  function exitHandler() { cleanup(); }
  process.on('SIGINT', sigintHandler);
  process.on('SIGTERM', sigintHandler);

  return {
    refresh,
    render,
    cleanup,
    getState: () => ({
      sessions,
      selectedIndex,
      isRenaming,
      renameBuffer,
      config
    })
  };
}

module.exports = {
  formatDuration,
  getStateLight,
  getSessionSummary,
  renderDashboardLines,
  startDashboard
};
