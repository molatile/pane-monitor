const fs = require('fs');
const path = require('path');
const os = require('os');
const { getSessionStatusList, SESSIONS_DIR, formatDecision } = require('./status');
const { hasFolderRules } = require('./rules');

const CONFIG_DIR = path.join(os.homedir(), '.agentwatch');
const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');

const EXAMPLE_AGENTS = ['agy'];

function formatEmptyStateMessage(examples = EXAMPLE_AGENTS) {
  const exampleStr = examples.map(name => `agentwatch ${name}`).join(', ');
  return `No agents running. Start one with: agentwatch <agent>  (for example: ${exampleStr})`;
}

const EMPTY_STATE_MESSAGE = formatEmptyStateMessage(EXAMPLE_AGENTS);

/**
 * Loads configuration from ~/.agentwatch/config.json.
 * Returns default configuration if file is missing or corrupted.
 */
function loadConfig(configPath = CONFIG_PATH) {
  try {
    if (!fs.existsSync(configPath)) {
      return {
        order: [],
        names: {},
        notifications: true,
        alwaysOnTop: false,
        autoOpenWindow: true,
        autoPaused: false,
        autoAcceptDefault: false,
        allowTurnOnFromWindow: false,
        timeFormat: '24-hour',
        window: { width: 420, height: 360 },
        notified: {}
      };
    }
    const raw = fs.readFileSync(configPath, 'utf8').trim();
    if (!raw) {
      return {
        order: [],
        names: {},
        notifications: true,
        alwaysOnTop: false,
        autoOpenWindow: true,
        autoPaused: false,
        autoAcceptDefault: false,
        allowTurnOnFromWindow: false,
        timeFormat: '24-hour',
        window: { width: 420, height: 360 },
        notified: {}
      };
    }
    const parsed = JSON.parse(raw);
    return {
      order: Array.isArray(parsed.order) ? parsed.order : [],
      names: (parsed.names && typeof parsed.names === 'object') ? parsed.names : {},
      notifications: parsed.notifications !== undefined ? Boolean(parsed.notifications) : true,
      alwaysOnTop: Boolean(parsed.alwaysOnTop),
      autoOpenWindow: parsed.autoOpenWindow !== undefined ? Boolean(parsed.autoOpenWindow) : true,
      autoPaused: Boolean(parsed.autoPaused),
      autoAcceptDefault: Boolean(parsed.autoAcceptDefault),
      allowTurnOnFromWindow: Boolean(parsed.allowTurnOnFromWindow),
      timeFormat: (parsed.timeFormat === '12-hour' || parsed.timeFormat === '12h') ? '12-hour' : '24-hour',
      guiPid: typeof parsed.guiPid === 'number' ? parsed.guiPid : undefined,
      guiStartTime: typeof parsed.guiStartTime === 'number' ? parsed.guiStartTime : undefined,
      window: (parsed.window && typeof parsed.window === 'object')
        ? {
            width: typeof parsed.window.width === 'number' ? parsed.window.width : 420,
            height: typeof parsed.window.height === 'number' ? parsed.window.height : 360,
            x: typeof parsed.window.x === 'number' ? parsed.window.x : undefined,
            y: typeof parsed.window.y === 'number' ? parsed.window.y : undefined
          }
        : { width: 420, height: 360 },
      notified: (parsed.notified && typeof parsed.notified === 'object') ? parsed.notified : {}
    };
  } catch (e) {
    return {
      order: [],
      names: {},
      notifications: true,
      alwaysOnTop: false,
      autoOpenWindow: true,
      autoPaused: false,
      autoAcceptDefault: false,
      allowTurnOnFromWindow: false,
      timeFormat: '24-hour',
      window: { width: 420, height: 360 },
      notified: {}
    };
  }
}

/**
 * Atomically saves configuration to config.json.
 * Strictly adheres to rule: never contains raw folder paths.
 */
function saveConfig(config, configPath = CONFIG_PATH) {
  const dir = path.dirname(configPath);
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const sanitized = {
      order: Array.isArray(config.order) ? config.order : [],
      names: {}
    };

    if (config.notifications !== undefined) {
      sanitized.notifications = Boolean(config.notifications);
    }
    if (config.alwaysOnTop !== undefined) {
      sanitized.alwaysOnTop = Boolean(config.alwaysOnTop);
    }
    if (config.autoOpenWindow !== undefined) {
      sanitized.autoOpenWindow = Boolean(config.autoOpenWindow);
    }
    if (config.autoPaused !== undefined) {
      sanitized.autoPaused = Boolean(config.autoPaused);
    }
    if (config.autoAcceptDefault !== undefined) {
      sanitized.autoAcceptDefault = Boolean(config.autoAcceptDefault);
    }
    if (config.allowTurnOnFromWindow !== undefined) {
      sanitized.allowTurnOnFromWindow = Boolean(config.allowTurnOnFromWindow);
    }
    if (config.timeFormat !== undefined) {
      sanitized.timeFormat = (config.timeFormat === '12-hour' || config.timeFormat === '12h') ? '12-hour' : '24-hour';
    }
    if (typeof config.guiPid === 'number') {
      sanitized.guiPid = config.guiPid;
    }
    if (typeof config.guiStartTime === 'number') {
      sanitized.guiStartTime = config.guiStartTime;
    }

    if (config.window && typeof config.window === 'object') {
      sanitized.window = {};
      if (typeof config.window.width === 'number') sanitized.window.width = config.window.width;
      if (typeof config.window.height === 'number') sanitized.window.height = config.window.height;
      if (typeof config.window.x === 'number') sanitized.window.x = config.window.x;
      if (typeof config.window.y === 'number') sanitized.window.y = config.window.y;
    }

    if (config.names && typeof config.names === 'object') {
      for (const [k, v] of Object.entries(config.names)) {
        if (typeof v === 'string') {
          sanitized.names[k] = v;
        }
      }
    }

    if (config.notified && typeof config.notified === 'object') {
      sanitized.notified = {};
      for (const [k, v] of Object.entries(config.notified)) {
        if (v && typeof v === 'object' && typeof v.at === 'number') {
          sanitized.notified[k] = {
            state: String(v.state),
            at: v.at
          };
        }
      }
    }

    const content = JSON.stringify(sanitized, null, 2);
    const tempPath = path.join(
      dir,
      `.config.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
    );

    fs.writeFileSync(tempPath, content, 'utf8');
    let renamed = false;
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.renameSync(tempPath, configPath);
        renamed = true;
        break;
      } catch (renameErr) {
        lastErr = renameErr;
        if (process.platform === 'win32' && (renameErr.code === 'EPERM' || renameErr.code === 'EEXIST' || renameErr.code === 'EBUSY' || renameErr.code === 'EACCES')) {
          try {
            fs.unlinkSync(configPath);
          } catch (_) {}
          try {
            fs.renameSync(tempPath, configPath);
            renamed = true;
            break;
          } catch (retryErr) {
            lastErr = retryErr;
          }
        }
        const waitUntil = Date.now() + 25;
        while (Date.now() < waitUntil) {}
      }
    }
    if (!renamed) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (_) {}
      return false;
    }
    return true;
  } catch (e) {
    // Non-fatal write error
    return false;
  }
}

/**
 * Derives the stable session key: agent + full folder path hash.
 */
function getSessionKey(session) {
  if (!session) return '';
  if (session.sessionKey) return session.sessionKey;
  if (session.folderHash) return `${session.agent}:${session.folderHash}`;
  return `${session.agent}:${session.folder || session.sessionId}`;
}

/**
 * Gets the display name for a session, checking saved custom name first.
 */
function getDisplayName(config, session) {
  const key = getSessionKey(session);
  if (config && config.names && config.names[key]) {
    return config.names[key];
  }
  return session.folder || session.agent || session.sessionId || 'agent';
}

/**
 * Sets a custom display name for a session and saves the configuration.
 */
function setSessionName(config, sessionKey, newName, configPath = CONFIG_PATH) {
  if (!config.names) config.names = {};
  config.names[sessionKey] = String(newName || '').trim();

  if (!config.order) config.order = [];
  if (!config.order.includes(sessionKey)) {
    config.order.push(sessionKey);
  }

  saveConfig(config, configPath);
  return config;
}

/**
 * Sorts sessions according to the user's saved order.
 * New sessions not in config.order are placed at the end without altering order.
 */
function orderSessions(sessions, config) {
  if (!sessions || sessions.length === 0) return [];
  const order = (config && Array.isArray(config.order)) ? config.order : [];

  return [...sessions].sort((a, b) => {
    const keyA = getSessionKey(a);
    const keyB = getSessionKey(b);
    const idxA = order.indexOf(keyA);
    const idxB = order.indexOf(keyB);

    if (idxA !== -1 && idxB !== -1) return idxA - idxB;
    if (idxA !== -1) return -1;
    if (idxB !== -1) return 1;
    return 0;
  });
}

/**
 * Moves a session up (direction = -1) or down (direction = 1) in the user order.
 * Updates and saves config.order.
 */
function reorderSession(config, sessionKey, direction, liveKeys, configPath = CONFIG_PATH) {
  if (!config.order) config.order = [];

  const updatedOrder = [...config.order];
  for (const k of liveKeys) {
    if (!updatedOrder.includes(k)) {
      updatedOrder.push(k);
    }
  }

  const liveIdx = liveKeys.indexOf(sessionKey);
  if (liveIdx === -1) return config;

  const targetLiveIdx = liveIdx + direction;
  if (targetLiveIdx < 0 || targetLiveIdx >= liveKeys.length) {
    return config;
  }

  const otherKey = liveKeys[targetLiveIdx];
  const idx1 = updatedOrder.indexOf(sessionKey);
  const idx2 = updatedOrder.indexOf(otherKey);

  if (idx1 !== -1 && idx2 !== -1) {
    updatedOrder[idx1] = otherKey;
    updatedOrder[idx2] = sessionKey;
  }

  config.order = updatedOrder;
  saveConfig(config, configPath);
  return config;
}

/**
 * Sets the explicit order of session keys (e.g. from drag-and-drop reordering).
 */
function setSessionOrder(config, newOrder, configPath = CONFIG_PATH) {
  if (Array.isArray(newOrder)) {
    config.order = [...newOrder];
    saveConfig(config, configPath);
  }
  return config;
}

/**
 * Toggles notifications setting and saves the configuration.
 */
function setNotifications(config, enabled, configPath = CONFIG_PATH) {
  config.notifications = Boolean(enabled);
  saveConfig(config, configPath);
  return config;
}

/**
 * Toggles always-on-top setting and saves the configuration.
 */
function setAlwaysOnTop(config, enabled, configPath = CONFIG_PATH) {
  config.alwaysOnTop = Boolean(enabled);
  saveConfig(config, configPath);
  return config;
}

/**
 * Saves window bounds (width, height, x, y) to config.
 */
function setWindowBounds(config, bounds = {}, configPath = CONFIG_PATH) {
  config.window = {
    width: bounds.width || 420,
    height: bounds.height || 360,
    x: bounds.x,
    y: bounds.y
  };
  saveConfig(config, configPath);
  return config;
}

/**
 * Toggles autoOpenWindow setting and saves the configuration.
 */
function setAutoOpenWindow(config, enabled, configPath = CONFIG_PATH) {
  config.autoOpenWindow = Boolean(enabled);
  saveConfig(config, configPath);
  return config;
}

function setAutoPaused(config, isPaused, configPath = CONFIG_PATH) {
  config.autoPaused = Boolean(isPaused);
  saveConfig(config, configPath);
  return config;
}

function setAutoAcceptDefault(config, enabled, configPath = CONFIG_PATH) {
  config.autoAcceptDefault = Boolean(enabled);
  saveConfig(config, configPath);
  return config;
}

function setAllowTurnOnFromWindow(config, enabled, configPath = CONFIG_PATH) {
  config.allowTurnOnFromWindow = Boolean(enabled);
  saveConfig(config, configPath);
  return config;
}

/**
 * Sets time format ('24-hour' or '12-hour') and saves the configuration.
 */
function setTimeFormat(config, format, configPath = CONFIG_PATH) {
  config.timeFormat = (format === '12-hour' || format === '12h') ? '12-hour' : '24-hour';
  saveConfig(config, configPath);
  return config;
}

/**
 * Checks whether the GUI window process is currently running.
 */
function isGuiRunning(config) {
  if (!config || typeof config.guiPid !== 'number') return false;
  try {
    process.kill(config.guiPid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

/**
 * Stops any running GUI window process and cleans up config.
 */
function stopGui(config, configPath = CONFIG_PATH) {
  if (!config || typeof config.guiPid !== 'number') return false;
  const pid = config.guiPid;
  let killed = false;
  try {
    process.kill(pid);
    killed = true;
  } catch (e) {}
  if (process.platform === 'win32') {
    try {
      require('child_process').execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
      killed = true;
    } catch (e) {}
  }
  delete config.guiPid;
  delete config.guiStartTime;
  try {
    saveConfig(config, configPath);
  } catch (e) {}

  // Wait briefly (up to 500ms) for the process to exit and release single-instance lock
  const startWait = Date.now();
  while (Date.now() - startWait < 500) {
    try {
      process.kill(pid, 0);
      const waitUntil = Date.now() + 50;
      while (Date.now() < waitUntil) {}
    } catch (e) {
      break;
    }
  }

  return killed;
}

/**
 * Returns the latest modification time (ms) among GUI source files.
 */
function getGuiSourceMtime(baseDir = __dirname) {
  const dirs = [
    baseDir,
    path.join(baseDir, 'gui'),
    path.join(baseDir, '..', 'bin')
  ];
  let latestMtime = 0;
  for (const dir of dirs) {
    try {
      if (!fs.existsSync(dir)) continue;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (['.js', '.html', '.css'].includes(ext)) {
            const stat = fs.statSync(path.join(dir, entry.name));
            if (stat.mtimeMs > latestMtime) {
              latestMtime = stat.mtimeMs;
            }
          }
        }
      }
    } catch (e) {}
  }
  return latestMtime;
}

/**
 * Checks if the running GUI is stale due to code changes made after its launch.
 */
function isGuiStale(config, baseDir = __dirname) {
  if (!config || typeof config.guiPid !== 'number') return false;
  if (!isGuiRunning(config)) return false;
  const startTime = config.guiStartTime;
  if (typeof startTime !== 'number') return true;
  const latestSourceMtime = getGuiSourceMtime(baseDir);
  return latestSourceMtime > startTime;
}


/**
 * Inter-viewer notification coordination:
 * Checks if a notification for this session and state was already triggered recently (< 5s).
 * If not, marks it as notified and returns true. If already notified by another viewer, returns false.
 */
function acquireNotificationLock(sessionId, state, nowMs = Date.now(), configPath = CONFIG_PATH) {
  try {
    const config = loadConfig(configPath);
    if (!config.notified) config.notified = {};

    const existing = config.notified[sessionId];
    if (existing && existing.state === state && (nowMs - existing.at < 5000)) {
      return false; // Already notified by another viewer
    }

    config.notified[sessionId] = {
      state,
      at: nowMs
    };
    saveConfig(config, configPath);
    return true;
  } catch (e) {
    return true;
  }
}

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
 */
function getStateLight(state, isDead, useColor = true) {
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
    case 'countdown':
      return {
        plain: '● COUNTDOWN',
        formatted: useColor ? '\x1b[35;1m● COUNTDOWN\x1b[0m' : '● COUNTDOWN'
      };
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
    return `Auto-answering ${secs ? 'in ' + secs : ''}`.trim();
  }
  if (session.state === 'asking') {
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

/**
 * Returns structured dashboard data representing current sessions, order, and config.
 * Shared between terminal dashboard and GUI window.
 */
function getDashboardData(options = {}) {
  const sessionsDir = options.sessionsDir || SESSIONS_DIR;
  const configPath = options.configPath || CONFIG_PATH;
  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();

  const config = loadConfig(configPath);
  const rawSessions = getSessionStatusList(sessionsDir, nowMs);
  const ordered = orderSessions(rawSessions, config);

  const sessions = ordered.map(session => {
    const key = getSessionKey(session);
    const isAsking = session.state === 'asking' && !session.isDead;
    const bgCount = session.backgroundTasks || session.backgroundTaskCount || 0;
    const hasOwn = hasFolderRules(key);
    return {
      sessionId: session.sessionId,
      sessionKey: key,
      token: session.token || null,
      agent: session.agent,
      hasProfile: session.hasProfile !== false,
      folder: session.folder,
      displayName: getDisplayName(config, session),
      state: session.isDead ? 'dead' : session.state,
      isDead: Boolean(session.isDead),
      stateSince: session.stateSince,
      duration: formatDuration(session.stateSince, nowMs),
      summary: getSessionSummary(session),
      backgroundTasks: bgCount,
      isAsking,
      prompt: session.prompt || null,
      auto: Boolean(session.auto),
      allowPersist: Boolean(session.allowPersist),
      hasOwnRules: hasOwn,
      ruleSet: hasOwn ? 'own rules' : 'default rules',
      countdown: (session.countdown !== undefined && session.countdown !== null) ? session.countdown : null
    };
  });

  return {
    config,
    sessions,
    emptyStateMessage: EMPTY_STATE_MESSAGE,
    nowMs
  };
}

module.exports = {
  CONFIG_DIR,
  CONFIG_PATH,
  EXAMPLE_AGENTS,
  formatEmptyStateMessage,
  EMPTY_STATE_MESSAGE,
  loadConfig,
  saveConfig,
  getSessionKey,
  getDisplayName,
  setSessionName,
  setSessionOrder,
  setNotifications,
  setAlwaysOnTop,
  setWindowBounds,
  setAutoOpenWindow,
  setAutoPaused,
  setAutoAcceptDefault,
  setAllowTurnOnFromWindow,
  setTimeFormat,
  isGuiRunning,
  stopGui,
  getGuiSourceMtime,
  isGuiStale,
  orderSessions,
  reorderSession,
  acquireNotificationLock,
  formatDuration,
  getStateLight,
  getSessionSummary,
  formatDecision,
  getDashboardData
};
