const { spawn } = require('child_process');

/**
 * Triggers a native OS desktop notification.
 * Windows: PowerShell toast notification.
 * macOS: osascript notification.
 */
function sendDesktopNotification(title, message) {
  if (process.platform === 'win32') {
    const escapedTitle = title.replace(/'/g, "''");
    const escapedMsg = message.replace(/'/g, "''");
    const ps = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
$template = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$nodes = $template.GetElementsByTagName('text')
$nodes.Item(0).AppendChild($template.CreateTextNode('${escapedTitle}')) | Out-Null
$nodes.Item(1).AppendChild($template.CreateTextNode('${escapedMsg}')) | Out-Null
$toast = [Windows.UI.Notifications.ToastNotification]::new($template)
$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe')
$notifier.Show($toast)
`;
    const b64 = Buffer.from(ps, 'utf16le').toString('base64');
    try {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], {
        windowsHide: true,
        stdio: 'ignore'
      });
      child.on('error', () => {});
      if (child.unref) child.unref();
    } catch (e) {}
  } else if (process.platform === 'darwin') {
    const escapedTitle = title.replace(/"/g, '\\"');
    const escapedMsg = message.replace(/"/g, '\\"');
    try {
      const script = `display notification "${escapedMsg}" with title "${escapedTitle}"`;
      const child = spawn('osascript', ['-e', script], {
        stdio: 'ignore'
      });
      child.on('error', () => {});
      if (child.unref) child.unref();
    } catch (e) {}
  } else {
    // Linux fallback
    try {
      const child = spawn('notify-send', [title, message], {
        stdio: 'ignore'
      });
      child.on('error', () => {});
      if (child.unref) child.unref();
    } catch (e) {}
  }
}

/**
 * Manages notification lifecycle across session state changes.
 * Ensures notifications are emitted ONCE per state change with a 5-second per-session cooldown.
 */
class NotificationManager {
  constructor(options = {}) {
    this.stdout = options.stdout || process.stdout;
    this.desktopNotifier = options.desktopNotifier || sendDesktopNotification;
    this.bellSender = options.bellSender || (() => {
      try {
        this.stdout['write']('\x07');
      } catch (e) {}
    });
    this.onNotification = options.onNotification || null;
    this.cooldownMs = options.cooldownMs !== undefined ? options.cooldownMs : 5000;
    this.quiet = Boolean(options.quiet);
    this.enabled = options.enabled !== undefined ? Boolean(options.enabled) : (options.notifications !== false);
    this.lockAcquirer = options.lockAcquirer || null;
    this.previousStates = new Map();
    this.lastNotificationTimes = new Map();
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
  }

  setQuiet(quiet) {
    this.quiet = Boolean(quiet);
  }

  /**
   * Evaluates current sessions against recorded previous states.
   * Fires bell and desktop notification when:
   * - Session transitions to 'asking' ("<name> needs you")
   * - Session transitions from 'busy' to 'idle' ("<name> finished")
   * Respects 5-second per-session cooldown, quiet mode, and config toggle.
   * Notification text NEVER contains any command text.
   */
  checkSessions(sessions, getDisplayNameFn, nowMs = Date.now()) {
    if (!Array.isArray(sessions)) return [];
    const triggered = [];
    const isSilenced = this.quiet || !this.enabled;

    for (const session of sessions) {
      const id = session.sessionId;
      const currentState = session.state;
      const prevState = this.previousStates.get(id);

      if (prevState === undefined) {
        // Initial state observation for this session: register without firing
        this.previousStates.set(id, currentState);
        continue;
      }

      if (prevState !== currentState) {
        this.previousStates.set(id, currentState);
        const name = getDisplayNameFn ? getDisplayNameFn(session) : (session.folder || session.agent);

        let event = null;
        if (currentState === 'asking') {
          event = {
            type: 'asking',
            sessionId: id,
            title: 'agentwatch',
            message: `${name} needs you`,
            text: `${name} needs you`
          };
        } else if (prevState === 'busy' && currentState === 'idle') {
          event = {
            type: 'idle',
            sessionId: id,
            title: 'agentwatch',
            message: `${name} finished`,
            text: `${name} finished`
          };
        }

        if (event) {
          // If silenced via --quiet or config notifications: false, do not fire
          if (isSilenced) {
            continue;
          }

          // Check inter-viewer notification lock if configured
          if (this.lockAcquirer && !this.lockAcquirer(id, currentState, nowMs)) {
            continue;
          }

          // 5-second per-session cooldown
          const lastNotify = this.lastNotificationTimes.get(id) || 0;
          if (nowMs - lastNotify < this.cooldownMs) {
            continue;
          }

          this.lastNotificationTimes.set(id, nowMs);
          this.triggerNotification(event);
          triggered.push(event);
        }
      }
    }

    // Clean up stale sessions that disappeared
    const currentIds = new Set(sessions.map(s => s.sessionId));
    for (const id of this.previousStates.keys()) {
      if (!currentIds.has(id)) {
        this.previousStates.delete(id);
        this.lastNotificationTimes.delete(id);
      }
    }

    return triggered;
  }

  triggerNotification(event) {
    if (this.quiet || !this.enabled) {
      return;
    }

    try {
      this.bellSender();
    } catch (e) {}

    try {
      this.desktopNotifier(event.title, event.message);
    } catch (e) {}

    if (this.onNotification) {
      try {
        this.onNotification(event);
      } catch (e) {}
    }
  }
}

module.exports = {
  sendDesktopNotification,
  NotificationManager
};
