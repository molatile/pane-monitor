const electron = require('electron');
const { app, BrowserWindow, ipcMain, session, dialog, screen } = (typeof electron === 'object' && electron !== null) ? electron : {};
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  CONFIG_PATH,
  loadConfig,
  saveConfig,
  setSessionName,
  setSessionOrder,
  setAlwaysOnTop,
  setWindowBounds,
  setKeepAcceptingWhenNoWindow,
  getViewersDir,
  acquireNotificationLock,
  getDashboardData,
  validateLogDir
} = require('../shared');
const { SESSIONS_DIR, getSessionStatusList } = require('../status');
const { NotificationManager } = require('../notifier');
const { readHistory, clearAgentHistory, clearAllHistory } = require('../history');
const {
  CANONICAL_RULES_PATH,
  loadRules,
  saveRules,
  getRulesBackups,
  restoreRulesBackup,
  resetDangerList,
  detectLoosening,
  evaluatePrompt,
  explainOptionMatches,
  logRulesChange,
  getFolderRulesDir,
  hasFolderRules,
  loadFolderRules,
  saveFolderRules,
  deleteFolderRules,
  getFolderRulesBackups,
  restoreFolderRulesBackup,
  copyAncestorRules,
  saveFolderChoice,
  dismissFolderQuestion,
  loadFolderChoices
} = require('../rules');

// Parse CLI flags passed to electron
const args = process.argv.slice(2);
const quiet = args.includes('--quiet') || args.includes('-q');
const shouldFocus = args.includes('--focus');
const sessionsDir = SESSIONS_DIR;
const configPath = CONFIG_PATH;

let mainWindow = null;
let notchWindow = null;
let updateInterval = null;
let saveBoundsTimeout = null;

// Electron Single-Instance Lock
if (app && typeof app.requestSingleInstanceLock === 'function') {
  const gotTheLock = app.requestSingleInstanceLock();
  if (!gotTheLock) {
    app.quit();
    process.exit(0);
  } else {
    app.on('second-instance', (event, commandLine) => {
      if (commandLine.some(arg => arg.includes('--restart'))) {
        app.quit();
        return;
      }
      // Focus existing window on second launch (or explicit agentwatch gui)
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (commandLine.some(arg => arg.includes('--focus') || arg === 'gui')) {
          mainWindow.show();
          mainWindow.focus();
        }
      } else {
        createWindow();
      }
    });

    // App lifecycle
    app.whenReady().then(createWindow);

    app.on('window-all-closed', () => {
      quitAppFully();
    });

    app.on('will-quit', () => {
      quitAppFully();
    });

    app.on('activate', () => {
      if (mainWindow === null) {
        createWindow();
      }
    });
  }
}

const viewersDir = getViewersDir();
try { fs.mkdirSync(viewersDir, { recursive: true }); } catch (e) {}
const guiHeartbeatFile = path.join(viewersDir, `viewer-gui-${process.pid}.json`);
let guiHeartbeatInterval = null;

function writeGuiHeartbeat() {
  try {
    const filePath = guiHeartbeatFile;
    fs.writeFileSync(filePath, JSON.stringify({ pid: process.pid, type: 'gui', time: Date.now() }), 'utf8');
  } catch (e) {}
}

function cleanupGuiHeartbeat() {
  try {
    if (fs.existsSync(guiHeartbeatFile)) {
      fs.unlinkSync(guiHeartbeatFile);
    }
  } catch (e) {}
}

process.on('exit', cleanupGuiHeartbeat);

function quitAppFully() {
  cleanupGuiHeartbeat();
  if (guiHeartbeatInterval) {
    clearInterval(guiHeartbeatInterval);
    guiHeartbeatInterval = null;
  }
  if (updateInterval) {
    clearInterval(updateInterval);
    updateInterval = null;
  }
  if (saveBoundsTimeout) {
    clearTimeout(saveBoundsTimeout);
    saveBoundsTimeout = null;
  }
  if (notchWindow && !notchWindow.isDestroyed()) {
    try {
      notchWindow.destroy();
    } catch (e) {}
    notchWindow = null;
  }
  try {
    if (app && typeof app.releaseSingleInstanceLock === 'function') {
      app.releaseSingleInstanceLock();
    }
  } catch (e) {}
  try {
    const cfg = loadConfig(configPath);
    if (cfg.guiPid === process.pid) {
      delete cfg.guiPid;
      delete cfg.guiStartTime;
      saveConfig(cfg, configPath);
    }
  } catch (e) {}
  try {
    if (app && typeof app.exit === 'function') {
      app.exit(0);
    }
  } catch (e) {}
  try {
    process.exit(0);
  } catch (e) {}
}

// Notification Manager reusing identical rules and coordination lock
const notificationManager = new NotificationManager({
  quiet,
  lockAcquirer: (sessionId, state, nowMs) => acquireNotificationLock(sessionId, state, nowMs, configPath)
});

function createWindow() {
  const config = loadConfig(configPath);
  config.guiPid = process.pid;
  config.guiStartTime = Date.now();
  saveConfig(config, configPath);

  const bounds = config.window || { width: 420, height: 360 };

  // Strict CSP via webRequest headers
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;"
        ]
      }
    });
  });

  mainWindow = new BrowserWindow({
    width: typeof bounds.width === 'number' ? bounds.width : 420,
    height: typeof bounds.height === 'number' ? bounds.height : 360,
    x: typeof bounds.x === 'number' ? bounds.x : undefined,
    y: typeof bounds.y === 'number' ? bounds.y : undefined,
    minWidth: 360,
    minHeight: 240,
    resizable: true,
    title: 'agentwatch',
    show: false, // Do not show until ready; showInactive if auto-open, focus only if --focus
    focusable: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.js'),
      webviewTag: false,
      allowRunningInsecureContent: false
    }
  });

  // Apply always-on-top setting from config
  if (config.alwaysOnTop) {
    mainWindow.setAlwaysOnTop(true);
  }

  // HARD SAFETY RULE:
  // Block all navigation attempts
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  // HARD SAFETY RULE:
  // Block all new window creations
  mainWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  // Opening by wrapper uses showInactive so it never steals focus;
  // Opening by explicit agentwatch gui may focus it.
  mainWindow.once('ready-to-show', () => {
    if (shouldFocus) {
      mainWindow.show();
      mainWindow.focus();
    } else {
      mainWindow.showInactive();
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // Save window size and position (debounced)
  const onSaveBounds = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (saveBoundsTimeout) clearTimeout(saveBoundsTimeout);
    saveBoundsTimeout = setTimeout(() => {
      try {
        if (mainWindow && !mainWindow.isDestroyed()) {
          const currentBounds = mainWindow.getBounds();
          const cfg = loadConfig(configPath);
          setWindowBounds(cfg, currentBounds, configPath);
        }
      } catch (e) {}
    }, 500);
  };

  mainWindow.on('resize', onSaveBounds);
  mainWindow.on('move', onSaveBounds);

  writeGuiHeartbeat();
  if (guiHeartbeatInterval) clearInterval(guiHeartbeatInterval);
  guiHeartbeatInterval = setInterval(writeGuiHeartbeat, 2000);
  if (guiHeartbeatInterval.unref) guiHeartbeatInterval.unref();

  mainWindow.on('close', () => {
    quitAppFully();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
    quitAppFully();
  });

  // Create floating dynamic island notch window
  createNotchWindow();

  // Start periodic 1-second update
  startUpdateLoop();
}

function createNotchWindow() {
  if (notchWindow && !notchWindow.isDestroyed()) return notchWindow;
  if (!BrowserWindow) return null;

  const primaryDisplay = (screen && typeof screen.getPrimaryDisplay === 'function')
    ? screen.getPrimaryDisplay()
    : { bounds: { x: 0, y: 0, width: 1920, height: 1080 } };

  const initialWidth = 240;
  const initialHeight = 44;
  const x = Math.round(primaryDisplay.bounds.x + (primaryDisplay.bounds.width - initialWidth) / 2);
  const y = primaryDisplay.bounds.y;

  notchWindow = new BrowserWindow({
    width: initialWidth,
    height: initialHeight,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    hasShadow: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'notch-preload.js'),
      webviewTag: false,
      allowRunningInsecureContent: false
    }
  });

  try {
    notchWindow.setAlwaysOnTop(true, 'screen-saver');
  } catch (e) {
    try { notchWindow.setAlwaysOnTop(true); } catch (err) {}
  }

  // Safety rules
  notchWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });
  notchWindow.webContents.setWindowOpenHandler(() => {
    return { action: 'deny' };
  });

  notchWindow.loadFile(path.join(__dirname, 'notch.html'));

  notchWindow.on('closed', () => {
    notchWindow = null;
  });

  return notchWindow;
}

function recenterNotch(targetWidth, targetHeight) {
  if (!notchWindow || notchWindow.isDestroyed()) return;
  if (!screen || typeof screen.getPrimaryDisplay !== 'function') return;

  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    const currentBounds = notchWindow.getBounds();
    const w = typeof targetWidth === 'number' ? targetWidth : currentBounds.width;
    const h = typeof targetHeight === 'number' ? targetHeight : currentBounds.height;
    const x = Math.round(primaryDisplay.bounds.x + (primaryDisplay.bounds.width - w) / 2);
    const y = primaryDisplay.bounds.y;
    notchWindow.setBounds({ x, y, width: w, height: h });
  } catch (e) {}
}

if (app && typeof app.whenReady === 'function') {
  app.whenReady().then(() => {
    if (screen && typeof screen.on === 'function') {
      screen.on('display-metrics-changed', () => recenterNotch());
      screen.on('display-added', () => recenterNotch());
      screen.on('display-removed', () => recenterNotch());
    }
  });
}

function sendDashboardUpdate() {
  const hasMainWindow = mainWindow && !mainWindow.isDestroyed();
  const hasNotchWindow = notchWindow && !notchWindow.isDestroyed();
  if (!hasMainWindow && !hasNotchWindow) return;

  try {
    const data = getDashboardData({ sessionsDir, configPath });

    // Check notifications
    const cfg = data.config || {};
    const notificationsAllowed = !quiet && cfg.notifications !== false;
    notificationManager.setEnabled(notificationsAllowed);

    // Pass session list for notification checks
    const rawSessions = getSessionStatusList(sessionsDir);
    notificationManager.checkSessions(rawSessions, s => s.folder || s.agent);

    // Send data to main window renderer
    if (hasMainWindow) {
      mainWindow.webContents.send('dashboard-update', data);
    }

    // Send data to notch island renderer
    if (hasNotchWindow) {
      notchWindow.webContents.send('notch-update', data);
    }
  } catch (e) {
    // Non-fatal error during update
  }
}

function startUpdateLoop() {
  if (updateInterval) clearInterval(updateInterval);
  updateInterval = setInterval(sendDashboardUpdate, 1000);
  if (updateInterval.unref) updateInterval.unref();
}

// IPC Handlers
if (ipcMain && typeof ipcMain.handle === 'function') {
ipcMain.handle('get-state', () => {
  return getDashboardData({ sessionsDir, configPath });
});

ipcMain.handle('rename-session', (event, { sessionKey, newName }) => {
  const cfg = loadConfig(configPath);
  setSessionName(cfg, sessionKey, newName, configPath);
  sendDashboardUpdate();
  return { success: true };
});

ipcMain.handle('reorder-sessions', (event, { newOrder }) => {
  const cfg = loadConfig(configPath);
  setSessionOrder(cfg, newOrder, configPath);
  sendDashboardUpdate();
  return { success: true };
});

ipcMain.handle('set-always-on-top', (event, { enabled }) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setAlwaysOnTop(Boolean(enabled));
  }
  const cfg = loadConfig(configPath);
  setAlwaysOnTop(cfg, Boolean(enabled), configPath);
  return { success: true };
});

// Floating Notch Island IPC Handlers
ipcMain.handle('notch-resize', (event, { width, height } = {}) => {
  if (!notchWindow || notchWindow.isDestroyed()) return { success: false };
  const w = Math.max(160, Math.min(600, Math.round(width || 240)));
  const h = Math.max(28, Math.min(140, Math.round(height || 44)));
  recenterNotch(w, h);
  return { success: true };
});

ipcMain.handle('notch-open-app', (event, { sessionKey, pid } = {}) => {
  let opened = false;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    if (sessionKey) {
      mainWindow.webContents.send('jump-to-agent', { sessionKey });
    }
    opened = true;
  }

  // Safely attempt to activate the console/terminal window for the agent if on Windows
  if (pid && typeof pid === 'number' && pid > 0 && process.platform === 'win32') {
    try {
      const cp = require('child_process');
      cp.exec(
        `powershell -NoProfile -NonInteractive -WindowStyle Hidden -Command "(New-Object -ComObject WScript.Shell).AppActivate(${pid})"`,
        { timeout: 1500, windowsHide: true },
        () => {}
      );
    } catch (e) {}
  }

  return { success: opened };
});

ipcMain.handle('notch-visibility', (event, { visible } = {}) => {
  if (!notchWindow || notchWindow.isDestroyed()) return { success: false };
  try {
    if (visible) {
      if (!notchWindow.isVisible()) {
        notchWindow.showInactive();
      }
    } else {
      if (notchWindow.isVisible()) {
        notchWindow.hide();
      }
    }
  } catch (e) {}
  return { success: true };
});

// Settings tab update IPC
ipcMain.handle('set-setting', (event, payload) => {
  return setSetting(payload);
});

// Log rule change IPC
ipcMain.handle('log-rule-change', (event, payload = {}) => {
  const what = payload && payload.what;
  if (what && typeof what === 'string') {
    logRulesChange(what, { who: 'gui' });
  }
  return { success: true };
});

// Native folder picker IPC
  ipcMain.handle('pick-log-folder', async () => {
    return pickLogFolder();
  });

// The ONE fixed function for reading history
ipcMain.handle('read-history', (event, options = {}) => {
  return readHistory({
    key: options.key,
    limit: options.limit || 200,
    offset: options.offset,
    scanAllAgents: options.scanAllAgents !== false
  });
});

// Clear history action (atomic rewrite omitting that key's events)
ipcMain.handle('clear-agent-history', (event, { sessionKey }) => {
  const res = clearAgentHistory(sessionKey);
  sendDashboardUpdate();
  return res;
});

// Clear all history action
ipcMain.handle('clear-all-history', () => {
  const res = clearAllHistory();
  sendDashboardUpdate();
  return res;
});

// Rules management IPC: The ONE fixed function for reading rules
ipcMain.handle('get-rules', () => {
  try {
    const rules = loadRules(CANONICAL_RULES_PATH);
    const backups = getRulesBackups();
    return { success: true, rules, backups };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Rules management IPC: The ONE fixed function for saving rules
ipcMain.handle('save-rules', (event, payload = {}) => {
  if (!payload || typeof payload !== 'object') {
    return { success: false, error: 'Invalid payload: expected object' };
  }
  // Size limit: reject oversized input (> 512KB)
  const jsonStr = JSON.stringify(payload);
  if (jsonStr.length > 512 * 1024) {
    return { success: false, error: 'Payload too large (max 512KB)' };
  }
  // Reject any attempts by renderer to specify paths
  if (payload.path || payload.filePath || payload.rulesPath) {
    return { success: false, error: 'Path selection forbidden' };
  }

  const newRules = payload.rules;
  if (!newRules || typeof newRules !== 'object') {
    return { success: false, error: 'Missing or invalid rules object' };
  }

  try {
    const currentRules = loadRules(CANONICAL_RULES_PATH);
    const loosening = detectLoosening(currentRules, newRules);

    // If loosening detected and not explicitly confirmed by user, request confirmation
    if (loosening.isLooser && !payload.confirmedLoosening) {
      return {
        success: false,
        needsConfirmation: true,
        loosening
      };
    }

    const cfg = loadConfig(configPath);
    const unlockBuiltin = Boolean(cfg.unlockBuiltinDenyRules);

    // Save atomically via fixed CANONICAL_RULES_PATH
    saveRules(newRules, CANONICAL_RULES_PATH, {
      changeSummary: payload.changeSummary || 'Rules saved via GUI',
      unlockBuiltinDenyRules: unlockBuiltin
    });

    sendDashboardUpdate();
    return {
      success: true,
      rules: loadRules(CANONICAL_RULES_PATH),
      backups: getRulesBackups()
    };
  } catch (e) {
    return {
      success: false,
      error: e.message,
      errors: e.validationErrors || [e.message]
    };
  }
});

// Rules management IPC: Restore previous backup
ipcMain.handle('restore-rules', (event, payload = {}) => {
  const backupName = payload && payload.backupName;
  if (!backupName || typeof backupName !== 'string') {
    return { success: false, error: 'Invalid backup name' };
  }
  // Check for path traversal or oversized input
  if (backupName.length > 256 || backupName.includes('/') || backupName.includes('\\') || backupName.includes('..')) {
    return { success: false, error: 'Invalid backup filename or path traversal detected' };
  }

  try {
    restoreRulesBackup(backupName, CANONICAL_RULES_PATH);
    sendDashboardUpdate();
    return {
      success: true,
      rules: loadRules(CANONICAL_RULES_PATH),
      backups: getRulesBackups()
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Rules management IPC: Reset danger list to defaults
ipcMain.handle('reset-danger-rules', () => {
  try {
    resetDangerList(CANONICAL_RULES_PATH);
    sendDashboardUpdate();
    return {
      success: true,
      rules: loadRules(CANONICAL_RULES_PATH),
      backups: getRulesBackups()
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Try-it tester IPC: purely evaluates prompt using the SAME evaluation code. Zero child writes.
ipcMain.handle('evaluate-prompt-test', (event, payload = {}) => {
  if (!payload || typeof payload !== 'object') {
    return { success: false, error: 'Invalid payload' };
  }
  const jsonStr = JSON.stringify(payload);
  if (jsonStr.length > 512 * 1024) {
    return { success: false, error: 'Payload too large' };
  }
  const prompt = payload.prompt;
  const customRules = payload.customRules || payload.rules;
  if (!prompt || typeof prompt !== 'object') {
    return { success: false, error: 'Missing prompt object' };
  }

  try {
    const rulesToUse = customRules || loadRules(CANONICAL_RULES_PATH);
    const decision = evaluatePrompt(prompt, rulesToUse);
    const optionExplanations = explainOptionMatches(prompt, rulesToUse);
    return {
      success: true,
      decision,
      optionExplanations
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('set-keep-accepting-no-window', (event, enabled) => {
  try {
    const cfg = loadConfig(configPath);
    setKeepAcceptingWhenNoWindow(cfg, enabled, configPath);
    return { success: true, keepAcceptingWhenNoWindow: cfg.keepAcceptingWhenNoWindow };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

function clearSessionPendingQuestion(folderKey) {
  try {
    const list = fs.readdirSync(sessionsDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    for (const file of list) {
      const p = path.join(sessionsDir, file);
      try {
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (data.sessionKey === folderKey && data.pendingQuestion) {
          data.pendingQuestion = null;
          fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
        }
      } catch (e) {}
    }
  } catch (e) {}
}

function isValidFolderKey(key) {
  if (!key || typeof key !== 'string') return false;
  if (key.length > 128) return false;
  if (key.includes('/') || key.includes('\\') || key.includes('..') || key.includes('\0')) return false;
  return /^[a-zA-Z0-9_-]+:[a-f0-9]+$/i.test(key) || /^[a-zA-Z0-9_:-]+$/i.test(key);
}

// Per-folder rules: Get list of known folders
ipcMain.handle('get-rules-folders', () => {
  try {
    const knownMap = new Map();

    // 1. From active sessions
    const active = getSessionStatusList(sessionsDir);
    for (const s of active) {
      if (s.sessionKey) {
        knownMap.set(s.sessionKey, {
          folderKey: s.sessionKey,
          agent: s.agent || 'agy',
          folderName: s.folder || 'folder',
          hasOwnRules: hasFolderRules(s.sessionKey)
        });
      }
    }

    // 2. From folder-rules directory
    const folderRulesDir = getFolderRulesDir();
    if (fs.existsSync(folderRulesDir)) {
      try {
        const files = fs.readdirSync(folderRulesDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
        for (const file of files) {
          const rawName = file.replace(/\.json$/i, '');
          // reconstruct key or check if direct
          const fKey = rawName.includes('_') ? rawName.replace('_', ':') : rawName;
          if (!knownMap.has(fKey)) {
            const agentPart = fKey.split(':')[0] || 'agent';
            knownMap.set(fKey, {
              folderKey: fKey,
              agent: agentPart,
              folderName: agentPart,
              hasOwnRules: true
            });
          }
        }
      } catch (e) {}
    }

    // 3. From folder-choices.json
    try {
      const choices = loadFolderChoices();
      for (const [k, v] of Object.entries(choices)) {
        if (!knownMap.has(k)) {
          const agentPart = k.split(':')[0] || 'agent';
          knownMap.set(k, {
            folderKey: k,
            agent: agentPart,
            folderName: v.folderName || agentPart,
            hasOwnRules: hasFolderRules(k)
          });
        }
      }
    } catch (e) {}

    // 4. From history
    try {
      const hist = readHistory({ limit: 100 });
      if (hist && Array.isArray(hist.events)) {
        for (const ev of hist.events) {
          if (ev.sessionKey && !knownMap.has(ev.sessionKey)) {
            knownMap.set(ev.sessionKey, {
              folderKey: ev.sessionKey,
              agent: ev.agent || 'agent',
              folderName: ev.folder || 'folder',
              hasOwnRules: hasFolderRules(ev.sessionKey)
            });
          }
        }
      }
    } catch (e) {}

    return {
      success: true,
      folders: Array.from(knownMap.values())
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Per-folder rules: Get rules for specific folder
ipcMain.handle('get-folder-rules', (event, payload = {}) => {
  const folderKey = payload && payload.folderKey;
  if (!isValidFolderKey(folderKey)) {
    return { success: false, error: 'Invalid folderKey' };
  }

  try {
    const hasOwn = hasFolderRules(folderKey);
    if (hasOwn) {
      const rules = loadFolderRules(folderKey);
      const backups = getFolderRulesBackups(folderKey);
      return { success: true, folderKey, rules, hasOwnRules: true, backups };
    } else {
      const defaultRules = loadRules(CANONICAL_RULES_PATH);
      return { success: true, folderKey, rules: defaultRules, hasOwnRules: false, backups: [] };
    }
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Per-folder rules: Save rules for a specific folder
ipcMain.handle('save-folder-rules', (event, payload = {}) => {
  if (!payload || typeof payload !== 'object') {
    return { success: false, error: 'Invalid payload: expected object' };
  }
  const jsonStr = JSON.stringify(payload);
  if (jsonStr.length > 512 * 1024) {
    return { success: false, error: 'Payload too large (max 512KB)' };
  }
  if (payload.path || payload.filePath || payload.rulesPath) {
    return { success: false, error: 'Path selection forbidden' };
  }
  const folderKey = payload.folderKey;
  if (!isValidFolderKey(folderKey)) {
    return { success: false, error: 'Invalid folderKey' };
  }
  const newRules = payload.rules;
  if (!newRules || typeof newRules !== 'object') {
    return { success: false, error: 'Missing or invalid rules object' };
  }

  try {
    const existingRules = hasFolderRules(folderKey)
      ? loadFolderRules(folderKey)
      : loadRules(CANONICAL_RULES_PATH);
    const loosening = detectLoosening(existingRules, newRules);

    if (loosening.isLooser && !payload.confirmedLoosening) {
      return {
        success: false,
        needsConfirmation: true,
        loosening
      };
    }

    const cfg = loadConfig(configPath);
    const unlockBuiltin = Boolean(cfg.unlockBuiltinDenyRules);

    saveFolderRules(folderKey, newRules, {
      changeSummary: payload.changeSummary || `Folder rules saved for ${folderKey}`,
      unlockBuiltinDenyRules: unlockBuiltin
    });

    sendDashboardUpdate();
    return {
      success: true,
      folderKey,
      rules: loadFolderRules(folderKey),
      hasOwnRules: true,
      backups: getFolderRulesBackups(folderKey)
    };
  } catch (e) {
    return {
      success: false,
      error: e.message,
      errors: e.validationErrors || [e.message]
    };
  }
});

// Per-folder rules: Delete folder rules (reset to default)
ipcMain.handle('delete-folder-rules', (event, payload = {}) => {
  const folderKey = payload && payload.folderKey;
  if (!isValidFolderKey(folderKey)) {
    return { success: false, error: 'Invalid folderKey' };
  }

  try {
    deleteFolderRules(folderKey);
    sendDashboardUpdate();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Nested-folder question: Copy ancestor rules
ipcMain.handle('copy-ancestor-rules', (event, payload = {}) => {
  if (!payload || typeof payload !== 'object') {
    return { success: false, error: 'Invalid payload' };
  }
  const jsonStr = JSON.stringify(payload);
  if (jsonStr.length > 512 * 1024) {
    return { success: false, error: 'Payload too large' };
  }
  if (payload.path || payload.filePath || payload.rulesPath) {
    return { success: false, error: 'Path selection forbidden' };
  }

  const { folderKey, ancestorKey } = payload;
  if (!isValidFolderKey(folderKey) || !isValidFolderKey(ancestorKey)) {
    return { success: false, error: 'Invalid folderKey or ancestorKey' };
  }

  try {
    const res = copyAncestorRules(folderKey, ancestorKey);
    clearSessionPendingQuestion(folderKey);
    sendDashboardUpdate();
    return {
      success: true,
      copiedCount: res.copiedCount,
      skippedPersistCount: res.skippedPersistCount
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Nested-folder question: Set choice (e.g. declined)
ipcMain.handle('set-folder-choice', (event, payload = {}) => {
  const { folderKey, choice, ancestorKey } = payload || {};
  if (!isValidFolderKey(folderKey)) {
    return { success: false, error: 'Invalid folderKey' };
  }

  try {
    saveFolderChoice(folderKey, {
      choice: choice || 'declined',
      ancestorKey: ancestorKey || null
    });
    clearSessionPendingQuestion(folderKey);
    sendDashboardUpdate();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

// Nested-folder question: Dismiss banner (stop asking after 2 dismissals)
ipcMain.handle('dismiss-folder-question', (event, payload = {}) => {
  const folderKey = payload && payload.folderKey;
  if (!isValidFolderKey(folderKey)) {
    return { success: false, error: 'Invalid folderKey' };
  }

  try {
    dismissFolderQuestion(folderKey);
    clearSessionPendingQuestion(folderKey);
    sendDashboardUpdate();
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
});
}

// The ONE fixed IPC function for updating settings (Stage 6)
function setSetting(payload = {}, options = {}) {
  const targetConfigPath = options.configPath || configPath;
  const { key, value } = payload;
  if (!key || typeof key !== 'string') {
    return { success: false, error: 'Setting key is required' };
  }
  const cfg = loadConfig(targetConfigPath);
  if (key === 'autoOpenWindow') {
    cfg.autoOpenWindow = Boolean(value);
  } else if (key === 'alwaysOnTop') {
    cfg.alwaysOnTop = Boolean(value);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.setAlwaysOnTop(cfg.alwaysOnTop);
    }
  } else if (key === 'notifications') {
    cfg.notifications = Boolean(value);
    notificationManager.setEnabled(cfg.notifications);
  } else if (key === 'timeFormat') {
    cfg.timeFormat = (value === '12-hour' || value === '12h') ? '12-hour' : '24-hour';
  } else if (key === 'autoPaused') {
    cfg.autoPaused = Boolean(value);
  } else if (key === 'autoAcceptDefault') {
    cfg.autoAcceptDefault = Boolean(value);
  } else if (key === 'allowTurnOnFromWindow') {
    cfg.allowTurnOnFromWindow = Boolean(value);
  } else if (key === 'unlockBuiltinDenyRules') {
    cfg.unlockBuiltinDenyRules = Boolean(value);
  } else if (key === 'cameraNotch') {
    cfg.cameraNotch = Boolean(value);
  } else if (key === 'floatingNotch') {
    cfg.floatingNotch = Boolean(value);
    if (!cfg.floatingNotch && notchWindow && !notchWindow.isDestroyed()) {
      notchWindow.hide();
    }
  } else if (key === 'logDir' || key === 'outputDir') {
    if (!value || typeof value !== 'string' || value.trim() === '') {
      cfg.logDir = '';
      delete cfg.outputDir;
    } else {
      if (!options.fromPicker) {
        return { success: false, error: 'Direct or typed log paths are rejected; use Browse to select a folder' };
      }
      const val = validateLogDir(value);
      if (!val.valid) {
        return { success: false, error: val.error };
      }
      cfg.logDir = val.path;
      delete cfg.outputDir;
    }
  } else {
    return { success: false, error: `Unknown setting: ${key}` };
  }
  const saved = saveConfig(cfg, targetConfigPath);
  if (saved === false) {
    return { success: false, error: 'Failed to write config file' };
  }
  sendDashboardUpdate();
  return { success: true, config: cfg, logDir: cfg.logDir };
}

// The ONE fixed IPC function for setting session auto state (Stage 6)
function setSessionAuto(payload = {}, options = {}) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { success: false, error: 'Expected object payload' };
  }

  // Size limit: reject oversized input (> 64KB)
  const jsonStr = JSON.stringify(payload);
  if (jsonStr.length > 64 * 1024) {
    return { success: false, error: 'Payload too large (max 64KB)' };
  }

  // Path selection forbidden
  if (payload.path || payload.filePath || payload.rulesPath || payload.controlPath) {
    return { success: false, error: 'Path selection forbidden' };
  }

  // Reject unknown fields
  const allowedKeys = new Set(['sessionId', 'state', 'desiredState']);
  for (const k of Object.keys(payload)) {
    if (!allowedKeys.has(k)) {
      return { success: false, error: `Unknown field forbidden: ${k}` };
    }
  }

  const sessionId = payload.sessionId;
  if (!sessionId || typeof sessionId !== 'string' || sessionId.length > 128) {
    return { success: false, error: 'Invalid sessionId' };
  }
  if (sessionId.includes('/') || sessionId.includes('\\') || sessionId.includes('..') || sessionId.includes('\0')) {
    return { success: false, error: 'Path traversal forbidden' };
  }
  if (!/^[a-zA-Z0-9_\-]+$/.test(sessionId)) {
    return { success: false, error: 'Invalid sessionId format' };
  }

  const rawState = payload.state !== undefined ? payload.state : payload.desiredState;
  if (typeof rawState !== 'string') {
    return { success: false, error: 'Invalid state' };
  }
  const state = rawState.trim().toLowerCase();
  if (state !== 'on' && state !== 'off') {
    return { success: false, error: 'State must be "on" or "off"' };
  }

  const targetSessionsDir = options.sessionsDir || sessionsDir;
  const targetConfigPath = options.configPath || configPath;
  const targetControlDir = options.controlDir || process.env.AGENTWATCH_CONTROL_DIR || path.join(os.homedir(), '.agentwatch', 'control');
  const targetLogPath = options.rulesChangesLogPath || path.join(os.homedir(), '.agentwatch', 'rules-changes.log');

  const sessionPath = path.join(targetSessionsDir, `${sessionId}.json`);
  if (!fs.existsSync(sessionPath)) {
    return { success: false, error: 'Session not found' };
  }

  let sessionData;
  try {
    sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
  } catch (e) {
    return { success: false, error: 'Could not read session status file' };
  }

  if (!sessionData || sessionData.sessionId !== sessionId) {
    return { success: false, error: 'Session ID mismatch in status file' };
  }

  const token = sessionData.token;
  if (!token || typeof token !== 'string') {
    return { success: false, error: 'Missing token in session status file' };
  }

  const cfg = loadConfig(targetConfigPath);
  const allowTurnOnFromWindow = Boolean(cfg.allowTurnOnFromWindow);

  const nowIso = new Date().toISOString();
  const controlData = {
    sessionId,
    state,
    timestamp: nowIso,
    token,
    allowTurnOnFromWindow
  };

  try {
    if (!fs.existsSync(targetControlDir)) {
      fs.mkdirSync(targetControlDir, { recursive: true });
    }
  } catch (e) {}

  const controlPath = path.join(targetControlDir, `${sessionId}.json`);
  const tempPath = path.join(targetControlDir, `.${sessionId}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`);

  try {
    fs.writeFileSync(tempPath, JSON.stringify(controlData, null, 2), 'utf8');
    try {
      fs.renameSync(tempPath, controlPath);
    } catch (renameErr) {
      if (process.platform === 'win32' && (renameErr.code === 'EPERM' || renameErr.code === 'EEXIST')) {
        try { fs.unlinkSync(controlPath); } catch (_) {}
        fs.renameSync(tempPath, controlPath);
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
    return { success: false, error: `Failed to write control file: ${err.message}` };
  }

  // Log on/off change to ~/.agentwatch/rules-changes.log (no secrets)
  const fromState = sessionData.auto ? 'on' : 'off';
  const folderName = sessionData.folder || 'folder';
  try {
    const logDir = path.dirname(targetLogPath);
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logEntry = JSON.stringify({
      time: nowIso,
      folder: folderName,
      who: 'gui',
      from: fromState,
      to: state,
      what: `Auto-accept turned ${state} for ${folderName}`
    }) + '\n';
    fs.appendFileSync(targetLogPath, logEntry, 'utf8');
  } catch (e) {}

  // Update session status file directly so GUI reflects new state immediately
  try {
    if (state === 'off') {
      sessionData.auto = false;
      if (sessionData.state === 'countdown') {
        sessionData.state = 'asking';
        sessionData.countdown = null;
      }
      fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2), 'utf8');
    } else if (state === 'on' && allowTurnOnFromWindow && sessionData.hasProfile !== false) {
      sessionData.auto = true;
      fs.writeFileSync(sessionPath, JSON.stringify(sessionData, null, 2), 'utf8');
    }
  } catch (e) {}

  sendDashboardUpdate();

  return {
    success: true,
    sessionId,
    state,
    folder: folderName,
    from: fromState
  };
}

// Stage 6 IPC Handler
if (ipcMain && typeof ipcMain.handle === 'function') {
  ipcMain.handle('set-session-auto', (event, payload) => {
    return setSessionAuto(payload);
  });
}

// Opens native folder picker and saves through setSetting
async function pickLogFolder(options = {}) {
  const targetConfigPath = options.configPath || configPath;
  const dialogModule = options.dialog || dialog;
  if (!dialogModule || typeof dialogModule.showOpenDialog !== 'function') {
    return { success: false, error: 'Native folder picker dialog is not available' };
  }
  try {
    const parent = (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
    const dialogOpts = {
      title: 'Select Log Folder',
      properties: ['openDirectory', 'createDirectory']
    };
    const result = parent ? await dialogModule.showOpenDialog(parent, dialogOpts) : await dialogModule.showOpenDialog(dialogOpts);
    if (!result || result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return { canceled: true };
    }
    const chosenPath = result.filePaths[0];
    return setSetting({ key: 'logDir', value: chosenPath }, { fromPicker: true, configPath: targetConfigPath });
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = {
  createWindow,
  createNotchWindow,
  recenterNotch,
  getNotchWindow: () => notchWindow,
  sendDashboardUpdate,
  setSessionAuto,
  setSetting,
  pickLogFolder,
  validateLogDir
};
