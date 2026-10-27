const fs = require('fs');
const path = require('path');
const os = require('os');
const { maskText } = require('./masker');

const AGENTWATCH_DIR = process.env.AGENTWATCH_DIR || path.join(os.homedir(), '.agentwatch');
const HISTORY_FILE = path.join(AGENTWATCH_DIR, 'history.jsonl');

/**
 * Ensures the ~/.agentwatch directory exists.
 */
function ensureAgentwatchDir() {
  try {
    if (!fs.existsSync(AGENTWATCH_DIR)) {
      fs.mkdirSync(AGENTWATCH_DIR, { recursive: true });
    }
  } catch (err) {
    // Non-fatal
  }
}

/**
 * Recursively masks all strings in an object.
 */
function maskObject(obj) {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') {
    return maskText(obj);
  }
  if (Array.isArray(obj)) {
    return obj.map(item => maskObject(item));
  }
  if (typeof obj === 'object') {
    const res = {};
    for (const key of Object.keys(obj)) {
      res[key] = maskObject(obj[key]);
    }
    return res;
  }
  return obj;
}

/**
 * Writes an event to ~/.agentwatch/history.jsonl
 * One JSON object per line.
 */
function appendHistoryEvent(event, customFilePath) {
  const targetPath = customFilePath || HISTORY_FILE;
  const targetDir = path.dirname(targetPath);
  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    // Mask all fields before writing to disk
    const maskedEvent = maskObject(event);
    const line = JSON.stringify(maskedEvent) + '\n';

    fs.appendFileSync(targetPath, line, 'utf8');
  } catch (err) {
    // Non-fatal logging error
  }
}

/**
 * ONE fixed read function for history.jsonl:
 * Reads history.jsonl from the END of the file, returns the newest 200 events for a given key,
 * with a "load older" option. Never loads the whole file into memory.
 * Skips any malformed line without crashing.
 *
 * @param {Object} options
 * @param {string} [options.filePath] - Target history file path
 * @param {string} [options.key] - Stable sessionKey to filter for (or 'unassigned')
 * @param {number} [options.limit=200] - Max events to return
 * @param {number} [options.offset] - Byte offset from which to read backwards (for "load older")
 * @param {boolean} [options.scanAllAgents=true] - Whether to discover all agent keys
 * @returns {{ events: Array, hasOlder: boolean, nextOffset: number, knownAgents: Array }}
 */
function readHistory(options = {}) {
  const targetPath = options.filePath || HISTORY_FILE;
  const key = options.key || null;
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : 200;
  const offset = options.offset;
  const scanAllAgents = options.scanAllAgents !== false;

  if (!fs.existsSync(targetPath)) {
    return {
      events: [],
      hasOlder: false,
      nextOffset: 0,
      knownAgents: []
    };
  }

  let fd = null;
  try {
    fd = fs.openSync(targetPath, 'r');
    const stat = fs.fstatSync(fd);
    const fileSize = stat.size;

    if (fileSize === 0) {
      fs.closeSync(fd);
      return {
        events: [],
        hasOlder: false,
        nextOffset: 0,
        knownAgents: []
      };
    }

    const CHUNK_SIZE = 64 * 1024; // 64 KB
    let currentEnd = (typeof offset === 'number' && offset >= 0 && offset <= fileSize)
      ? offset
      : fileSize;

    let remainder = '';
    const matchingEvents = [];
    const knownAgentsMap = new Map();
    let hasOlder = false;
    let nextOffset = 0;

    while (currentEnd > 0) {
      const start = Math.max(0, currentEnd - CHUNK_SIZE);
      const bytesToRead = currentEnd - start;
      const buf = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buf, 0, bytesToRead, start);
      currentEnd = start;

      const text = buf.toString('utf8') + remainder;
      const lines = text.split('\n');

      if (start > 0) {
        remainder = lines.shift() || '';
      } else {
        remainder = '';
      }

      for (let i = lines.length - 1; i >= 0; i--) {
        const rawLine = lines[i].trim();
        if (!rawLine) continue;

        let event;
        try {
          event = JSON.parse(rawLine);
        } catch (e) {
          // Skip any malformed line without crashing
          continue;
        }

        // Track known agents
        if (event.sessionKey) {
          if (!knownAgentsMap.has(event.sessionKey)) {
            knownAgentsMap.set(event.sessionKey, {
              sessionKey: event.sessionKey,
              folder: event.folder || 'agent',
              agent: event.agent || 'agent',
              displayName: event.folder || event.agent || event.sessionKey
            });
          }
        } else {
          if (!knownAgentsMap.has('unassigned')) {
            knownAgentsMap.set('unassigned', {
              sessionKey: 'unassigned',
              folder: 'Unassigned (older)',
              agent: 'older',
              displayName: 'Unassigned (older)'
            });
          }
        }

        // Check key match
        let isMatch = false;
        if (!key) {
          isMatch = false;
        } else if (key === 'unassigned' || key === '__unassigned__') {
          isMatch = !event.sessionKey;
        } else {
          isMatch = (event.sessionKey === key);
        }

        if (isMatch && matchingEvents.length < limit) {
          matchingEvents.push(event);
          if (matchingEvents.length >= limit) {
            hasOlder = (currentEnd > 0 || i > 0 || remainder.length > 0);
            const unreadLines = lines.slice(0, i);
            const unreadText = (remainder ? remainder : '') + unreadLines.join('\n') + (unreadLines.length > 0 ? '\n' : '');
            nextOffset = start + Buffer.byteLength(unreadText, 'utf8');

            if (!scanAllAgents) {
              break;
            }
          }
        }
      }

      if (matchingEvents.length >= limit && !scanAllAgents) {
        break;
      }
    }

    // Process leftover beginning remainder if start === 0
    if (currentEnd === 0 && remainder) {
      const rawLine = remainder.trim();
      if (rawLine) {
        try {
          const event = JSON.parse(rawLine);
          if (event.sessionKey) {
            if (!knownAgentsMap.has(event.sessionKey)) {
              knownAgentsMap.set(event.sessionKey, {
                sessionKey: event.sessionKey,
                folder: event.folder || 'agent',
                agent: event.agent || 'agent',
                displayName: event.folder || event.agent || event.sessionKey
              });
            }
          } else {
            if (!knownAgentsMap.has('unassigned')) {
              knownAgentsMap.set('unassigned', {
                sessionKey: 'unassigned',
                folder: 'Unassigned (older)',
                agent: 'older',
                displayName: 'Unassigned (older)'
              });
            }
          }

          let isMatch = false;
          if (!key) isMatch = false;
          else if (key === 'unassigned' || key === '__unassigned__') isMatch = !event.sessionKey;
          else isMatch = (event.sessionKey === key);

          if (isMatch && matchingEvents.length < limit) {
            matchingEvents.push(event);
          }
        } catch (e) {}
      }
      hasOlder = false;
      nextOffset = 0;
    }

    fs.closeSync(fd);
    fd = null;

    return {
      events: matchingEvents,
      hasOlder,
      nextOffset,
      knownAgents: Array.from(knownAgentsMap.values())
    };
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (_) {}
    }
    return {
      events: [],
      hasOlder: false,
      nextOffset: 0,
      knownAgents: []
    };
  }
}

/**
 * Rewrites history.jsonl without a given key's events, atomically.
 * This is the ONLY write allowed to history.jsonl besides append.
 *
 * @param {string} key - SessionKey to clear (or 'unassigned')
 * @param {string} [customFilePath] - Target history file path
 * @returns {{ success: boolean, removedCount: number }}
 */
function clearAgentHistory(key, customFilePath) {
  const targetPath = customFilePath || HISTORY_FILE;
  if (!fs.existsSync(targetPath)) {
    return { success: true, removedCount: 0 };
  }

  const dir = path.dirname(targetPath);
  const tempPath = path.join(
    dir,
    `.history.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`
  );

  let removedCount = 0;

  try {
    const raw = fs.readFileSync(targetPath, 'utf8');
    const lines = raw.split('\n');
    const keptLines = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event;
      try {
        event = JSON.parse(trimmed);
      } catch (e) {
        // Keep unparseable lines so we don't corrupt unrelated data
        keptLines.push(trimmed);
        continue;
      }

      let shouldRemove = false;
      if (key === 'unassigned' || key === '__unassigned__') {
        shouldRemove = !event.sessionKey;
      } else {
        shouldRemove = (event.sessionKey === key);
      }

      if (shouldRemove) {
        removedCount++;
      } else {
        keptLines.push(trimmed);
      }
    }

    const newContent = keptLines.length > 0 ? keptLines.join('\n') + '\n' : '';
    fs.writeFileSync(tempPath, newContent, 'utf8');

    try {
      fs.renameSync(tempPath, targetPath);
    } catch (renameErr) {
      if (process.platform === 'win32' && (renameErr.code === 'EPERM' || renameErr.code === 'EEXIST')) {
        try { fs.unlinkSync(targetPath); } catch (_) {}
        fs.renameSync(tempPath, targetPath);
      } else {
        throw renameErr;
      }
    }

    return { success: true, removedCount };
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    } catch (_) {}
    return { success: false, removedCount: 0, error: err.message };
  }
}

/**
 * Formats a UTC ISO string to local time with the real weekday computed from the date.
 * Example 24-hour: "Thursday, 2 July 2026 · 22:00"
 * Example 12-hour: "Thursday, 2 July 2026 · 10:00 PM"
 * If includeDate is false, returns only the time part: "22:00" or "10:00 PM".
 *
 * @param {string} isoString - UTC ISO 8601 string
 * @param {string} [timeFormat='24-hour'] - '24-hour' or '12-hour'
 * @param {boolean} [includeDate=true] - Whether to include weekday, day, month, year
 * @returns {string} Formatted display string
 */
function formatDisplayTime(isoString, timeFormat = '24-hour', includeDate = true) {
  if (!isoString) return 'unknown';
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return 'unknown';

  const weekdays = [
    'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'
  ];
  const months = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];

  const weekday = weekdays[d.getDay()];
  const day = d.getDate();
  const month = months[d.getMonth()];
  const year = d.getFullYear();

  let timePart = '';
  const is12Hour = timeFormat === '12-hour' || timeFormat === '12h';

  if (is12Hour) {
    const rawH = d.getHours();
    const h = rawH % 12 || 12;
    const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = rawH >= 12 ? 'PM' : 'AM';
    timePart = `${h}:${m} ${ampm}`;
  } else {
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    timePart = `${h}:${m}`;
  }

  if (!includeDate) {
    return timePart;
  }

  return `${weekday}, ${day} ${month} ${year} · ${timePart}`;
}

/**
 * Formats duration in seconds to plain length string like "1h 12m", "45s", or "unknown".
 *
 * @param {number|string} durationSeconds
 * @returns {string}
 */
function formatSessionLength(durationSeconds) {
  if (durationSeconds === null || durationSeconds === undefined || durationSeconds === 'unknown') {
    return 'unknown';
  }
  const s = typeof durationSeconds === 'number' ? Math.round(durationSeconds) : parseInt(durationSeconds, 10);
  if (isNaN(s) || s < 0) return 'unknown';

  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remainingSecs = s % 60;
  if (s < 3600) {
    return remainingSecs > 0 ? `${m}m ${remainingSecs}s` : `${m}m`;
  }
  const h = Math.floor(s / 3600);
  const remainingMins = Math.floor((s % 3600) / 60);
  return remainingMins > 0 ? `${h}h ${remainingMins}m` : `${h}h`;
}

/**
 * Returns plain words for dry-run decision.
 * E.g. "Would approve option 1 after 3 s" or "Blocked by rule: rm -rf" or "Needs you".
 */
function formatPlainDecision(decision) {
  if (!decision) return 'Needs you';
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
    if (decision.log && decision.log.startsWith('Auto-approved')) {
      return decision.log;
    }
    if (decision.action === 'would_approve') {
      const opt = decision.optionKey || '1';
      const delay = decision.delay !== undefined ? decision.delay : 3;
      return `Would approve option ${opt} after ${delay} s`;
    }
    if (decision.action === 'blocked') {
      return `Blocked by rule: ${decision.rule || 'deny'}`;
    }
    if (decision.action === 'needs_user') {
      return 'Needs you';
    }
    if (decision.log) {
      return decision.log.replace(/^Dry-run:\s*/i, '');
    }
  }
  return 'Needs you';
}

/**
 * Returns small label for option classification.
 * "yes once", "yes this conversation", "yes and save", "no"
 */
function getClassificationLabel(classification) {
  switch (classification) {
    case 'yes_once':
      return 'yes once';
    case 'yes_session':
      return 'yes this conversation';
    case 'yes_persist':
      return 'yes and save';
    case 'no':
      return 'no';
    default:
      return classification || 'unknown';
  }
}

/**
 * Computes agreement between dry-run decision and user answer:
 * - "agrees" if the dry-run decision would_approve and the user chose yes_once,
 *   or if the decision was blocked or needs_user and the user chose no or did not choose yes_once
 * - "differs" otherwise
 * - "n/a" if answer unknown
 *
 * @param {Object|string} decision
 * @param {string|number} answerKey
 * @param {string} answerClass
 * @returns {'agrees'|'differs'|'n/a'}
 */
function computeAgreement(decision, answerKey, answerClass) {
  if (answerKey === 'unknown' || !answerKey) {
    return 'n/a';
  }

  const action = (decision && typeof decision === 'object') ? decision.action : (typeof decision === 'string' ? decision : null);

  if (action === 'would_approve') {
    return answerClass === 'yes_once' ? 'agrees' : 'differs';
  }

  if (action === 'blocked' || action === 'needs_user') {
    if (answerClass === 'no' || answerClass !== 'yes_once') {
      return 'agrees';
    }
    return 'differs';
  }

  return 'n/a';
}

/**
 * Formats user answer for history card display.
 * E.g.: "You chose: 1. Yes, run command (yes once)" or "You cancelled" or "You amended" or "Answer: not detected"
 * If answer_key is undefined (older pre-Stage-3b events), returns "Answer: not recorded".
 *
 * @param {Object} prompt
 * @returns {string}
 */
function formatPromptAnswer(prompt) {
  if (!prompt || (prompt.answer_key === undefined && !prompt.answered_by)) {
    return 'Answer: not recorded';
  }
  if (prompt.answered_by === 'vetoed' || prompt.answeredBy === 'vetoed') {
    return 'Cancelled (vetoed)';
  }
  if (prompt.answer_key === 'unknown') {
    return 'Answer: not detected';
  }
  if (prompt.answer_key === 'esc') {
    return 'You cancelled';
  }
  if (prompt.answer_key === 'amended') {
    return 'You amended';
  }

  const prefix = (prompt.answered_by === 'auto' || prompt.answeredBy === 'auto')
    ? 'Auto-accepted'
    : 'You chose';

  // Digit or Enter: an option was chosen
  let chosenOpt = null;
  if (Array.isArray(prompt.options)) {
    if (typeof prompt.answer_key === 'number' || (typeof prompt.answer_key === 'string' && /^\d+$/.test(prompt.answer_key))) {
      chosenOpt = prompt.options.find(o => String(o.number) === String(prompt.answer_key) || String(o.key) === String(prompt.answer_key));
    } else if (prompt.answer_key === 'enter') {
      if (prompt.answer_option_text) {
        chosenOpt = prompt.options.find(o => o.text === prompt.answer_option_text);
      }
      if (!chosenOpt && prompt.answer_class) {
        chosenOpt = prompt.options.find(o => o.classification === prompt.answer_class);
      }
      if (!chosenOpt) {
        chosenOpt = prompt.options[0];
      }
    }
  }

  if (chosenOpt) {
    const num = chosenOpt.number || chosenOpt.key || '1';
    const text = chosenOpt.text || prompt.answer_option_text || '';
    const label = chosenOpt.label || getClassificationLabel(chosenOpt.classification || prompt.answer_class);
    return `${prefix}: ${num}. ${text} (${label})`;
  }

  if (prompt.answer_option_text) {
    const label = getClassificationLabel(prompt.answer_class);
    return `${prefix}: ${prompt.answer_option_text} (${label})`;
  }

  return 'Answer: not detected';
}

/**
 * Groups events by session, newest first, with start stamp as heading.
 *
 * @param {Array} events - History events array
 * @param {Set<string>} [activeSessionIds=new Set()] - Currently running sessionIds
 * @returns {Array<Object>} Grouped sessions array
 */
function groupHistoryBySession(events = [], activeSessionIds = new Set()) {
  if (!Array.isArray(events) || events.length === 0) return [];

  const sessionBuckets = new Map();

  for (const event of events) {
    const sId = event.sessionId || 'unassigned-session';
    if (!sessionBuckets.has(sId)) {
      sessionBuckets.set(sId, {
        sessionId: sId,
        sessionKey: event.sessionKey || 'unassigned',
        folder: event.folder || 'agent',
        agent: event.agent || 'agent',
        startedTime: null,
        endedTime: null,
        durationSeconds: null,
        isEndedUnknown: false,
        events: []
      });
    }
    const bucket = sessionBuckets.get(sId);
    bucket.events.push(event);

    if (event.type === 'session_started') {
      bucket.startedTime = event.time;
    } else if (event.type === 'session_ended') {
      bucket.endedTime = event.time;
      if (typeof event.durationSeconds === 'number') {
        bucket.durationSeconds = event.durationSeconds;
      }
    }
  }

  const groups = [];

  for (const bucket of sessionBuckets.values()) {
    // Determine start timestamp
    let startTime = bucket.startedTime;
    if (!startTime && bucket.events.length > 0) {
      // Find earliest event time
      const times = bucket.events.map(e => e.time).filter(Boolean).sort();
      startTime = times[0] || null;
    }

    // Determine end status & duration
    let isEnded = Boolean(bucket.endedTime);
    let sessionLength = 'unknown';

    if (bucket.durationSeconds !== null && bucket.durationSeconds !== undefined) {
      sessionLength = formatSessionLength(bucket.durationSeconds);
    } else if (bucket.startedTime && bucket.endedTime) {
      const startMs = new Date(bucket.startedTime).getTime();
      const endMs = new Date(bucket.endedTime).getTime();
      if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
        sessionLength = formatSessionLength(Math.round((endMs - startMs) / 1000));
      }
    } else if (activeSessionIds.has(bucket.sessionId)) {
      sessionLength = 'running';
    } else {
      bucket.isEndedUnknown = true;
      sessionLength = 'unknown';
    }

    // Extract prompt cards
    // Pair shown and closed events by question & command
    const promptsMap = new Map();
    for (const ev of bucket.events) {
      if (ev.question || ev.command || ev.options) {
        const cmd = typeof ev.command === 'object' ? (ev.command.spaced || ev.command.compact || '') : String(ev.command || '');
        const pKey = `${ev.question || ''}:::${cmd}`;
        if (!promptsMap.has(pKey)) {
          promptsMap.set(pKey, {
            time: ev.time,
            question: ev.question || '',
            command: cmd,
            options: (ev.options || []).map(o => ({
              number: o.number || o.key,
              text: o.text,
              classification: o.classification,
              label: getClassificationLabel(o.classification)
            })),
            decision: ev.decision,
            plainDecision: formatPlainDecision(ev.decision),
            durationSeconds: (ev.durationSeconds !== undefined && ev.durationSeconds !== 'closed: unknown') ? ev.durationSeconds : null,
            answer: 'Answer: not recorded',
            answer_key: ev.answer_key !== undefined ? ev.answer_key : undefined,
            answer_option_text: ev.answer_option_text !== undefined ? ev.answer_option_text : null,
            answer_class: ev.answer_class !== undefined ? ev.answer_class : undefined,
            agreement: ev.agreement !== undefined ? ev.agreement : undefined
          });
        } else {
          const existing = promptsMap.get(pKey);
          if (ev.durationSeconds !== undefined && ev.durationSeconds !== 'closed: unknown') {
            existing.durationSeconds = ev.durationSeconds;
          }
          if (ev.type === 'prompt' && ev.time) {
            existing.time = ev.time;
          }
          if (ev.answer_key !== undefined) {
            existing.answer_key = ev.answer_key;
          }
          if (ev.answer_option_text !== undefined) {
            existing.answer_option_text = ev.answer_option_text;
          }
          if (ev.answer_class !== undefined) {
            existing.answer_class = ev.answer_class;
          }
          if (ev.agreement !== undefined) {
            existing.agreement = ev.agreement;
          }
        }
      }
    }

    const prompts = Array.from(promptsMap.values()).map(p => {
      let durationStr = 'unknown';
      if (typeof p.durationSeconds === 'number') {
        durationStr = `${p.durationSeconds} s`;
      } else if (p.durationSeconds) {
        durationStr = String(p.durationSeconds);
      }
      return {
        ...p,
        durationStr,
        answer: formatPromptAnswer(p)
      };
    });

    groups.push({
      sessionId: bucket.sessionId,
      sessionKey: bucket.sessionKey,
      folder: bucket.folder,
      agent: bucket.agent,
      startTime,
      endedTime: bucket.endedTime,
      sessionLength,
      isEndedUnknown: bucket.isEndedUnknown,
      prompts
    });
  }

  // Sort groups newest first by startTime
  groups.sort((a, b) => {
    const tA = a.startTime ? new Date(a.startTime).getTime() : 0;
    const tB = b.startTime ? new Date(b.startTime).getTime() : 0;
    return tB - tA;
  });

  return groups;
}

module.exports = {
  AGENTWATCH_DIR,
  HISTORY_FILE,
  ensureAgentwatchDir,
  appendHistoryEvent,
  maskObject,
  readHistory,
  clearAgentHistory,
  formatDisplayTime,
  formatSessionLength,
  formatPlainDecision,
  getClassificationLabel,
  groupHistoryBySession,
  computeAgreement,
  formatPromptAnswer
};
