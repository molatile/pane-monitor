const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script exposing a minimal, fixed, secure API to the renderer.
 * Strictly complies with Electron security rules:
 * - contextIsolation: true
 * - nodeIntegration: false
 * - No exposure of Node.js modules or arbitrary IPC.
 */
contextBridge.exposeInMainWorld('agentwatch', {
  /**
   * Subscribes to dashboard state updates pushed from the main application.
   */
  onUpdate: (callback) => {
    if (typeof callback !== 'function') return;
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('dashboard-update', subscription);
    return () => {
      ipcRenderer.removeListener('dashboard-update', subscription);
    };
  },

  /**
   * Requests initial dashboard state.
   */
  getState: () => ipcRenderer.invoke('get-state'),

  /**
   * Sets custom name for a session.
   */
  renameSession: (sessionKey, newName) => {
    return ipcRenderer.invoke('rename-session', { sessionKey, newName });
  },

  /**
   * Saves reordered session keys (from drag-and-drop).
   */
  reorderSessions: (newOrder) => {
    return ipcRenderer.invoke('reorder-sessions', { newOrder });
  },

  /**
   * Toggles the always-on-top window setting.
   */
  setAlwaysOnTop: (enabled) => {
    return ipcRenderer.invoke('set-always-on-top', { enabled });
  },

  /**
   * Sets a configuration setting (autoOpenWindow, notifications, alwaysOnTop, timeFormat).
   */
  setSetting: (key, value) => {
    return ipcRenderer.invoke('set-setting', { key, value });
  },

  /**
   * Calls the ONE fixed read function for history.
   */
  readHistory: (options) => {
    return ipcRenderer.invoke('read-history', options);
  },

  /**
   * Triggers the clear history write action for an agent.
   */
  clearAgentHistory: (sessionKey) => {
    return ipcRenderer.invoke('clear-agent-history', { sessionKey });
  }
});
