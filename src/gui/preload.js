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
   * Logs a rule change to rules-changes.log.
   */
  logRuleChange: (what) => {
    return ipcRenderer.invoke('log-rule-change', { what });
  },

  /**
   * Opens native folder picker in main process and saves selected folder.
   * Renderer never chooses or passes a path.
   */
  pickLogFolder: () => {
    return ipcRenderer.invoke('pick-log-folder');
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
  },

  /**
   * Triggers clearing all history events across all agents.
   */
  clearAllHistory: () => {
    return ipcRenderer.invoke('clear-all-history');
  },

  /**
   * Reads active rules and list of available backups.
   */
  getRules: () => {
    return ipcRenderer.invoke('get-rules');
  },

  /**
   * The ONE fixed function for saving rules through the main process
   */
  saveRules: (payload) => {
    return ipcRenderer.invoke('save-rules', payload);
  },

  /**
   * Restores a timestamped backup of rules.
   */
  restoreRules: (backupName) => {
    return ipcRenderer.invoke('restore-rules', { backupName });
  },

  /**
   * Resets the danger list to factory defaults.
   */
  resetDangerRules: () => {
    return ipcRenderer.invoke('reset-danger-rules');
  },

  /**
   * Evaluates a prompt against rules in the main process (Try-It tester).
   * Completely safe simulation: never sends any child input.
   */
  evaluatePromptTest: (payload) => {
    return ipcRenderer.invoke('evaluate-prompt-test', payload);
  },

  /**
   * Returns list of known folders with active sessions, custom rules, or history.
   */
  getRulesFolders: () => {
    return ipcRenderer.invoke('get-rules-folders');
  },

  /**
   * Reads rules and backups for a specific folder key.
   */
  getFolderRules: (folderKey) => {
    return ipcRenderer.invoke('get-folder-rules', { folderKey });
  },

  /**
   * Saves rules for a specific folder key.
   */
  saveFolderRules: (payload) => {
    return ipcRenderer.invoke('save-folder-rules', payload);
  },

  /**
   * Deletes custom rules for a folder key (resets to defaults).
   */
  deleteFolderRules: (folderKey) => {
    return ipcRenderer.invoke('delete-folder-rules', { folderKey });
  },

  /**
   * Copies rules from an ancestor folder (snapshot, skipping allowPersist).
   */
  copyAncestorRules: (folderKey, ancestorKey) => {
    return ipcRenderer.invoke('copy-ancestor-rules', { folderKey, ancestorKey });
  },

  /**
   * Saves user's choice for folder rules question (e.g. declined).
   */
  setFolderChoice: (folderKey, choice, ancestorKey) => {
    return ipcRenderer.invoke('set-folder-choice', { folderKey, choice, ancestorKey });
  },

  /**
   * Dismisses folder question banner (stops asking after 2 dismissals).
   */
  dismissFolderQuestion: (folderKey) => {
    return ipcRenderer.invoke('dismiss-folder-question', { folderKey });
  },

  /**
   * Turns auto-accept on or off for a specific session (Stage 6).
   */
  setSessionAuto: (payload) => {
    return ipcRenderer.invoke('set-session-auto', payload);
  }
});
