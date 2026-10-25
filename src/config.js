/**
 * Configuration module for agentwatch.
 * Re-exports shared config utilities from src/shared.js to maintain 100% backward compatibility.
 */
const shared = require('./shared');

module.exports = {
  CONFIG_DIR: shared.CONFIG_DIR,
  CONFIG_PATH: shared.CONFIG_PATH,
  loadConfig: shared.loadConfig,
  saveConfig: shared.saveConfig,
  getSessionKey: shared.getSessionKey,
  getDisplayName: shared.getDisplayName,
  setSessionName: shared.setSessionName,
  setSessionOrder: shared.setSessionOrder,
  setNotifications: shared.setNotifications,
  setAlwaysOnTop: shared.setAlwaysOnTop,
  setWindowBounds: shared.setWindowBounds,
  setAutoOpenWindow: shared.setAutoOpenWindow,
  setAutoPaused: shared.setAutoPaused,
  setAutoAcceptDefault: shared.setAutoAcceptDefault,
  setTimeFormat: shared.setTimeFormat,
  isGuiRunning: shared.isGuiRunning,
  orderSessions: shared.orderSessions,
  reorderSession: shared.reorderSession,
  acquireNotificationLock: shared.acquireNotificationLock,
  EXAMPLE_AGENTS: shared.EXAMPLE_AGENTS,
  formatEmptyStateMessage: shared.formatEmptyStateMessage,
  EMPTY_STATE_MESSAGE: shared.EMPTY_STATE_MESSAGE
};
