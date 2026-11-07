const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { maskText } = require('./masker');
const { computeFolderAncestors } = require('./rules');

const SESSIONS_DIR = process.env.AGENTWATCH_SESSIONS_DIR || path.join(os.homedir(), '.agentwatch', 'sessions');
const CONTROL_DIR = process.env.AGENTWATCH_CONTROL_DIR || path.join(os.homedir(), '.agentwatch', 'control');
const HEARTBEAT_INTERVAL_MS = 2000;
const DEAD_SESSION_TIMEOUT_MS = 6000;
const REMOVE_SESSION_TIMEOUT_MS = 60000;

function getControlDir() {
  return process.env.AGENTWATCH_CONTROL_DIR || path.join(os.homedir(), '.agentwatch', 'control');
}

function getControlFilePath(sessionId, controlDir = getControlDir()) {
  return path.join(controlDir, `${sessionId}.json`);
}

/**
 * Formats a dry-run decision into a human-readable string.
 */
function formatDecision(decision) {
  if (!decision) return 'needs you';
  if (typeof decision === 'string') return decision;
  if (typeof decision === 'object') {
    if (decision.reason && decision.reason.startsWith('DANGER:')) {
      return decision.reason;
    }
    if (decision.slowDanger) {
      return `SLOW: matched '${decision.slowDanger}'`;
    }
    if (decision.reason && decision.reason.startsWith('SLOW:')) {
      return decision.reason;
    }
    if (decision.action === 'would_approve') {
      const opt = decision.optionKey || '1';
      const delay = decision.delay !== undefined ? decision.delay : 3;
      return `would approve option ${opt} after ${delay}s`;
    }
    if (decision.action === 'blocked') {
      return `blocked by rule: ${decision.rule || 'deny'}`;
    }
    if (decision.action === 'needs_user') {
      if (!decision.reason) {
        return 'needs you';
      }
      let r = decision.reason;
      if (r === 'no option rule matched for file edit') {
        r = 'no rule matched';
      }
      if (typeof r === 'string' && r.startsWith('needs you because:')) {
        return r;
      }
      return `needs you because: ${r}`;
    }
    if (decision.log) {
      return decision.log.replace(/^Dry-run:\s*/i, '');
    }
  }
  return 'needs you';
}

class SessionStatusManager {
  constructor(options = {}) {
    this.sessionId = options.sessionId || `session-${Date.now()}-${process.pid}`;
    this.agent = options.agent || 'agy';

    // Folder name only, not full path
    const rawCwd = options.cwd || process.cwd();
    this.folder = path.basename(rawCwd);
    this.pid = options.pid || process.pid;

    // Stable folder hash and session key (never store raw folder path in file)
    const normalizedCwd = path.resolve(rawCwd);
    const canonicalCwd = process.platform === 'win32' ? normalizedCwd.toLowerCase() : normalizedCwd;
    this.folderHash = crypto.createHash('sha256').update(canonicalCwd).digest('hex').slice(0, 16);
    this.sessionKey = options.sessionKey || `${this.agent}:${this.folderHash}`;

    // Session token for secure control communication
    this.token = options.token || crypto.randomBytes(16).toString('hex');

    // Compute ancestor hashes and display names at session start (never raw paths)
    this.ancestors = options.ancestors || computeFolderAncestors(rawCwd, this.agent);
    this.pendingQuestion = options.pendingQuestion || null;

    this.sessionsDir = options.sessionsDir || SESSIONS_DIR;
    this.filePath = path.join(this.sessionsDir, `${this.sessionId}.json`);
    this.controlFilePath = options.controlFilePath || getControlFilePath(this.sessionId, options.controlDir);

    this.state = options.initialState || 'idle';
    this.stateSince = new Date().toISOString();
    this.hasProfile = options.hasProfile !== undefined ? Boolean(options.hasProfile) : true;
    this.auto = options.auto !== undefined ? Boolean(options.auto) : false;
    this.allowPersist = options.allowPersist !== undefined ? Boolean(options.allowPersist) : false;
    this.countdown = typeof options.countdown === 'number' ? options.countdown : null;
    this.rule = options.rule || null;
    this.prompt = null;
    this.heartbeatTimer = null;
    this.backgroundTasks = options.backgroundTasks || 0;
  }

  /**
   * Initializes the session directory and writes initial status file.
   */
  start() {
    try {
      if (!fs.existsSync(this.sessionsDir)) {
        fs.mkdirSync(this.sessionsDir, { recursive: true });
      }
      this.writeStatus();
    } catch (e) {
      // Non-fatal if sessions directory is not writable
    }

    // Start 2-second heartbeat
    this.heartbeatTimer = setInterval(() => {
      this.writeStatus();
    }, HEARTBEAT_INTERVAL_MS);
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  /**
   * Updates current state, prompt summary, and running background task count.
   */
  update(state, stateSince, promptSummary, options = {}) {
    if (state !== undefined) {
      this.state = (!this.hasProfile && (state === 'asking' || state === 'countdown')) ? 'busy' : state;
    }
    if (stateSince !== undefined) this.stateSince = stateSince;

    if (this.hasProfile && (this.state === 'asking' || this.state === 'countdown') && promptSummary) {
      const decisionText = promptSummary.decision
        ? formatDecision(promptSummary.decision)
        : 'needs you';

      const ruleName = (options && options.rule) ||
        (promptSummary.decision && typeof promptSummary.decision === 'object' && promptSummary.decision.rule) ||
        this.rule ||
        null;

      const promptType = promptSummary.promptType || promptSummary.type || 'command';
      const label = promptSummary.label || (promptType === 'unrecognized' ? 'unrecognized prompt' : (promptType === 'file_edit' ? 'file edit' : 'command'));
      const targetFile = promptSummary.targetFile ? maskText(promptSummary.targetFile) : undefined;
      const fileName = promptSummary.fileName ? maskText(promptSummary.fileName) : (promptSummary.targetFile ? maskText(path.basename(promptSummary.targetFile.replace(/\\/g, '/'))) : undefined);

      this.prompt = {
        type: promptType,
        label,
        targetFile,
        fileName,
        question: maskText(promptSummary.question || ''),
        command: maskText(promptSummary.commandSpaced || promptSummary.command || ''),
        decision: decisionText,
        rule: ruleName
      };
      this.rule = ruleName;
    } else {
      this.prompt = null;
      this.rule = null;
    }

    if (options && typeof options === 'object') {
      if (options.backgroundTasks !== undefined) {
        this.backgroundTasks = options.backgroundTasks;
      }
      if (options.countdown !== undefined) {
        this.countdown = options.countdown;
      } else if (this.state !== 'countdown') {
        this.countdown = null;
      }
      if (options.auto !== undefined) {
        this.auto = Boolean(options.auto);
      }
      if (options.allowPersist !== undefined) {
        this.allowPersist = Boolean(options.allowPersist);
      }
      if (options.rule !== undefined) {
        this.rule = options.rule;
      }
      if (options.pendingQuestion !== undefined) {
        this.pendingQuestion = options.pendingQuestion;
      }
    } else if (typeof options === 'number') {
      this.backgroundTasks = options;
      if (this.state !== 'countdown') {
        this.countdown = null;
      }
    } else if (this.state !== 'countdown') {
      this.countdown = null;
    }

    this.writeStatus();
  }

  /**
   * Writes the current status to disk with updated heartbeat atomically.
   * Writes to a temporary file first, then renames to target file.
   */
  writeStatus() {
    const data = {
      sessionId: this.sessionId,
      sessionKey: this.sessionKey,
      token: this.token,
      folderHash: this.folderHash,
      agent: this.agent,
      ancestors: this.ancestors || [],
      pendingQuestion: this.pendingQuestion || null,
      hasProfile: this.hasProfile,
      auto: Boolean(this.auto),
      autoPaused: Boolean(this.autoPaused),
      autoPausedReason: this.autoPausedReason || null,
      allowPersist: Boolean(this.allowPersist),
      countdown: (this.countdown !== undefined && this.countdown !== null) ? this.countdown : null,
      rule: this.rule || null,
      folder: this.folder,
      state: this.state,
      stateSince: this.stateSince,
      pid: this.pid,
      heartbeat: new Date().toISOString(),
      prompt: this.prompt,
      backgroundTasks: this.backgroundTasks || 0
    };

    const tempPath = path.join(
      this.sessionsDir,
      `.${this.sessionId}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
    );

    try {
      fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf8');
      try {
        fs.renameSync(tempPath, this.filePath);
      } catch (renameErr) {
        if (process.platform === 'win32' && (renameErr.code === 'EPERM' || renameErr.code === 'EEXIST')) {
          try {
            fs.unlinkSync(this.filePath);
          } catch (_) {}
          fs.renameSync(tempPath, this.filePath);
        } else {
          throw renameErr;
        }
      }
    } catch (err) {
      // Non-fatal write error
      try {
        if (fs.existsSync(tempPath)) {
          fs.unlinkSync(tempPath);
        }
      } catch (_) {}
    }
  }

  /**
   * Cleans up status file on clean exit.
   */
  cleanup() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    try {
      if (fs.existsSync(this.filePath)) {
        fs.unlinkSync(this.filePath);
      }
    } catch (err) {
      // Non-fatal cleanup error
    }
    try {
      if (this.controlFilePath && fs.existsSync(this.controlFilePath)) {
        fs.unlinkSync(this.controlFilePath);
      }
    } catch (err) {
      // Non-fatal cleanup error
    }
  }
}

/**
 * Checks if a session data object has an active (alive) heartbeat.
 */
function isSessionAlive(sessionData, maxAgeMs = DEAD_SESSION_TIMEOUT_MS) {
  if (!sessionData || !sessionData.heartbeat) return false;
  const heartbeatTime = new Date(sessionData.heartbeat).getTime();
  if (isNaN(heartbeatTime)) return false;
  return (Date.now() - heartbeatTime) < maxAgeMs;
}

/**
 * Safely reads and parses a session JSON file.
 * Returns null if file is missing, empty, or half-written (never crashes).
 */
function readSessionFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf8').trim();
    if (!content) return null;
    const session = JSON.parse(content);
    if (!session || typeof session !== 'object' || !session.sessionId) return null;
    return session;
  } catch (e) {
    // Missing, empty, or half-written file: skip it
    return null;
  }
}

/**
 * Retrieves all sessions from the sessions directory.
 * - Heartbeat > 6s is marked as dead.
 * - Heartbeat > 60s is removed from disk.
 * - Corrupted / half-written files are skipped.
 */
function getSessionStatusList(sessionsDir = SESSIONS_DIR, nowMs = Date.now()) {
  if (!fs.existsSync(sessionsDir)) return [];
  let files;
  try {
    files = fs.readdirSync(sessionsDir);
  } catch (e) {
    return [];
  }

  const sessions = [];
  for (const file of files) {
    // Only process non-temp .json files
    if (!file.endsWith('.json') || file.startsWith('.')) continue;

    const fullPath = path.join(sessionsDir, file);
    const session = readSessionFile(fullPath);
    if (!session) continue;

    const heartbeatTime = session.heartbeat ? new Date(session.heartbeat).getTime() : 0;
    const ageMs = isNaN(heartbeatTime) ? Infinity : (nowMs - heartbeatTime);

    // Remove file if older than 60 seconds
    if (ageMs > REMOVE_SESSION_TIMEOUT_MS) {
      try {
        fs.unlinkSync(fullPath);
      } catch (err) {}
      continue;
    }

    // Mark as dead if heartbeat is older than ~6 seconds
    if (ageMs > DEAD_SESSION_TIMEOUT_MS) {
      session.state = 'dead';
      session.isDead = true;
    } else {
      session.isDead = false;
    }

    // Ensure stable session key is present
    if (!session.sessionKey) {
      if (session.folderHash) {
        session.sessionKey = `${session.agent}:${session.folderHash}`;
      } else {
        session.sessionKey = `${session.agent}:${session.folder || session.sessionId}`;
      }
    }

    if (session.hasProfile === undefined) {
      const { getProfileForCommand } = require('./profile');
      session.hasProfile = Boolean(getProfileForCommand(session.agent));
    }

    sessions.push(session);
  }

  return sessions;
}

/**
 * Lists all active (non-dead) session files in the sessions directory.
 */
function getActiveSessions(sessionsDir = SESSIONS_DIR) {
  return getSessionStatusList(sessionsDir).filter(s => !s.isDead);
}

module.exports = {
  SESSIONS_DIR,
  CONTROL_DIR,
  getControlDir,
  getControlFilePath,
  DEAD_SESSION_TIMEOUT_MS,
  REMOVE_SESSION_TIMEOUT_MS,
  SessionStatusManager,
  formatDecision,
  isSessionAlive,
  readSessionFile,
  getSessionStatusList,
  getActiveSessions
};
