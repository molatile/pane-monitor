const { app, BrowserWindow, ipcMain, session } = require('electron');
const path = require('path');
const {
  CONFIG_PATH,
  loadConfig,
  saveConfig,
  setSessionName,
  setSessionOrder,
  setAlwaysOnTop,
  setWindowBounds,
  acquireNotificationLock,
  getDashboardData
} = require('../shared');
const { SESSIONS_DIR, getSessionStatusList } = require('../status');
const { NotificationManager } = require('../notifier');
const { readHistory, clearAgentHistory } = require('../history');

// Parse CLI flags passed to electron
const args = process.argv.slice(2);
const quiet = args.includes('--quiet') || args.includes('-q');
const shouldFocus = args.includes('--focus');
const sessionsDir = SESSIONS_DIR;
const configPath = CONFIG_PATH;

let mainWindow = null;
let updateInterval = null;
let saveBoundsTimeout = null;

// Electron Single-Instance Lock
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', (event, commandLine) => {
    // Focus existing window on second launch (or explicit agentwatch gui)
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      if (commandLine.some(arg => arg.includes('--focus') || arg === 'gui')) {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  // App lifecycle
  app.whenReady().then(createWindow);

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('will-quit', () => {
    try {
      const cfg = loadConfig(configPath);
      if (cfg.guiPid === process.pid) {
        delete cfg.guiPid;
        saveConfig(cfg, configPath);
      }
    } catch (e) {}
  });

  app.on('activate', () => {
    if (mainWindow === null) {
      createWindow();
    }
  });
}

// Notification Manager reusing identical rules and coordination lock
const notificationManager = new NotificationManager({
  quiet,
  lockAcquirer: (sessionId, state, nowMs) => acquireNotificationLock(sessionId, state, nowMs, configPath)
});

function createWindow() {
  const config = loadConfig(configPath);
  config.guiPid = process.pid;
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

  mainWindow.on('closed', () => {
    mainWindow = null;
    if (updateInterval) {
      clearInterval(updateInterval);
      updateInterval = null;
    }
  });

  // Start periodic 1-second update
  startUpdateLoop();
}

function sendDashboardUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  try {
    const data = getDashboardData({ sessionsDir, configPath });

    // Check notifications
    const cfg = data.config;
    const notificationsAllowed = !quiet && cfg.notifications !== false;
    notificationManager.setEnabled(notificationsAllowed);

    // Pass session list for notification checks
    const rawSessions = getSessionStatusList(sessionsDir);
    notificationManager.checkSessions(rawSessions, s => s.folder || s.agent);

    // Send data to renderer
    mainWindow.webContents.send('dashboard-update', data);
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

// Settings tab update IPC
ipcMain.handle('set-setting', (event, { key, value }) => {
  const cfg = loadConfig(configPath);
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
  }
  saveConfig(cfg, configPath);
  sendDashboardUpdate();
  return { success: true, config: cfg };
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

module.exports = {
  createWindow,
  sendDashboardUpdate
};
