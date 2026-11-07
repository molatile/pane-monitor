const { contextBridge, ipcRenderer } = require('electron');

/**
 * Preload script exposing a minimal, secure API to the floating notch window.
 * Strictly complies with Electron security best practices:
 * - contextIsolation: true
 * - nodeIntegration: false
 * - sandbox: true
 */
contextBridge.exposeInMainWorld('notchApi', {
  /**
   * Subscribes to dashboard updates pushed from main process.
   */
  onUpdate: (callback) => {
    if (typeof callback !== 'function') return;
    const subscription = (event, data) => callback(data);
    ipcRenderer.on('notch-update', subscription);
    return () => {
      ipcRenderer.removeListener('notch-update', subscription);
    };
  },

  /**
   * Requests dynamic auto-adjustment of window size and centering.
   */
  resize: (dimensions) => {
    return ipcRenderer.invoke('notch-resize', dimensions);
  },

  /**
   * Focuses and opens the main AgentWatch window.
   */
  openMainApp: () => {
    return ipcRenderer.invoke('notch-open-app');
  },

  /**
   * Reports desired window visibility (show/hide).
   */
  setVisibility: (visible) => {
    return ipcRenderer.invoke('notch-visibility', { visible });
  }
});
