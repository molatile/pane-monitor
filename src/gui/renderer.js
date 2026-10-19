// Agentwatch GUI Renderer
// Strictly read-only towards child processes and agents.

let currentSessions = [];
let editingSessionKey = null;
let draggedKey = null;
let pendingData = null;

let selectedAgentKey = null;
let currentConfig = {
  autoOpenWindow: true,
  alwaysOnTop: false,
  notifications: true,
  timeFormat: '24-hour'
};
let knownAgents = [];
let historyEvents = [];
let historyHasOlder = false;
let historyNextOffset = 0;

// DOM references
const countBadge = document.getElementById('agent-count-badge');
const pinCheckbox = document.getElementById('always-on-top-checkbox');
const container = document.getElementById('sessions-container');

// Tabs
const tabBtnAgents = document.getElementById('tab-btn-agents');
const tabBtnSettings = document.getElementById('tab-btn-settings');
const agentsView = document.getElementById('agents-view');
const settingsView = document.getElementById('settings-view');

// Past Agents
const pastAgentsDetails = document.getElementById('past-agents-details');
const pastAgentsCount = document.getElementById('past-agents-count');
const pastAgentsList = document.getElementById('past-agents-list');

// History Pane
const historyHeader = document.getElementById('history-header');
const historyAgentName = document.getElementById('history-agent-name');
const clearHistoryBtn = document.getElementById('clear-history-btn');
const historyPlaceholder = document.getElementById('history-placeholder');
const historyGroups = document.getElementById('history-groups');
const loadOlderContainer = document.getElementById('load-older-container');
const loadOlderBtn = document.getElementById('load-older-btn');

// Settings Controls
const settingAutoOpen = document.getElementById('setting-auto-open');
const settingPinTop = document.getElementById('setting-pin-top');
const settingNotifications = document.getElementById('setting-notifications');
const settingTimeFormat = document.getElementById('setting-time-format');

// Map of sessionKey -> cached DOM references for live rows
const rowCache = new Map();

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Formats a UTC ISO string to local time with real weekday computed from the date.
 * Example 24-hour: "Thursday, 2 July 2026 · 22:00"
 * Example 12-hour: "Thursday, 2 July 2026 · 10:00 PM"
 * If includeDate is false, returns "22:00" or "10:00 PM".
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
 */
function formatSessionLength(durationSeconds) {
  if (durationSeconds === 'running') {
    return 'running';
  }
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
 */
function formatPlainDecision(decision) {
  if (!decision) return 'Needs you';
  if (typeof decision === 'string') return decision;
  if (typeof decision === 'object') {
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
 * Groups events by session, newest first.
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

  // Identify the newest bucket for each sessionKey to avoid marking old abruptly terminated sessions as running
  const newestBucketForSessionKey = new Map();
  for (const bucket of sessionBuckets.values()) {
    let t = bucket.startedTime ? new Date(bucket.startedTime).getTime() : 0;
    if (!t && bucket.events.length > 0) {
      const times = bucket.events.map(e => e.time).filter(Boolean).sort();
      t = times[0] ? new Date(times[0]).getTime() : 0;
    }
    const current = newestBucketForSessionKey.get(bucket.sessionKey);
    if (!current || t > current.time) {
      newestBucketForSessionKey.set(bucket.sessionKey, { bucket, time: t });
    }
  }

  const groups = [];

  for (const bucket of sessionBuckets.values()) {
    let startTime = bucket.startedTime;
    if (!startTime && bucket.events.length > 0) {
      const times = bucket.events.map(e => e.time).filter(Boolean).sort();
      startTime = times[0] || null;
    }

    let sessionLength = 'unknown';
    if (bucket.durationSeconds !== null && bucket.durationSeconds !== undefined) {
      sessionLength = formatSessionLength(bucket.durationSeconds);
    } else if (bucket.startedTime && bucket.endedTime) {
      const startMs = new Date(bucket.startedTime).getTime();
      const endMs = new Date(bucket.endedTime).getTime();
      if (!isNaN(startMs) && !isNaN(endMs) && endMs >= startMs) {
        sessionLength = formatSessionLength(Math.round((endMs - startMs) / 1000));
      }
    } else if (
      activeSessionIds.has(bucket.sessionId) ||
      (activeSessionIds.has(bucket.sessionKey) && newestBucketForSessionKey.get(bucket.sessionKey)?.bucket === bucket)
    ) {
      sessionLength = 'running';
    } else {
      bucket.isEndedUnknown = true;
      sessionLength = 'unknown';
    }

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
            answer: 'Answer: not recorded'
          });
        } else {
          const existing = promptsMap.get(pKey);
          if (ev.durationSeconds !== undefined && ev.durationSeconds !== 'closed: unknown') {
            existing.durationSeconds = ev.durationSeconds;
          }
          if (ev.type === 'prompt' && ev.time) {
            existing.time = ev.time;
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
        durationStr
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

  groups.sort((a, b) => {
    const tA = a.startTime ? new Date(a.startTime).getTime() : 0;
    const tB = b.startTime ? new Date(b.startTime).getTime() : 0;
    return tB - tA;
  });

  return groups;
}

/**
 * Main dashboard render entry point.
 */
function render(data) {
  if (!data) return;
  const { config = {}, sessions = [] } = data;
  currentSessions = sessions;
  currentConfig = {
    ...currentConfig,
    ...config
  };

  // Update header count
  if (countBadge) {
    const activeCount = sessions.filter(s => !s.isDead && s.state !== 'dead').length;
    countBadge.textContent = activeCount === 1 ? '1 agent active' : `${activeCount} agents active`;
  }

  // Update always-on-top toggle if not focused
  if (pinCheckbox && document.activeElement !== pinCheckbox) {
    pinCheckbox.checked = Boolean(currentConfig.alwaysOnTop);
  }

  // Update Settings tab controls if not currently being interacted with
  updateSettingsTab();

  // If no live sessions, render empty state in sessions container
  if (sessions.length === 0) {
    rowCache.clear();
    editingSessionKey = null;
    const emptyMsg = data.emptyStateMessage || 'No agents running. Start one with: agentwatch <agent>  (for example: agentwatch agy)';
    if (container) {
      container.innerHTML = `
        <div id="empty-state" class="empty-state">
          ${escapeHtml(emptyMsg)}
        </div>
      `;
    }
  } else {
    // If empty state exists, remove it now that sessions exist
    if (container) {
      const emptyEl = container.querySelector('#empty-state');
      if (emptyEl) {
        emptyEl.remove();
      }
    }

    // If currently dragging, queue update
    if (draggedKey !== null) {
      pendingData = data;
      return;
    }

    // Remove rows for sessions that no longer exist
    const liveKeys = new Set(sessions.map(s => s.sessionKey));
    for (const [key, entry] of rowCache.entries()) {
      if (!liveKeys.has(key)) {
        if (key === editingSessionKey) {
          editingSessionKey = null;
        }
        if (entry.row && entry.row.parentNode === container) {
          container.removeChild(entry.row);
        }
        rowCache.delete(key);
      }
    }

    // Update existing rows in place or insert new rows keyed by sessionKey
    sessions.forEach(session => {
      const key = session.sessionKey;

      if (editingSessionKey === key) {
        return;
      }

      let entry = rowCache.get(key);
      if (!entry) {
        entry = createRow(session);
        rowCache.set(key, entry);
        if (container) {
          container.appendChild(entry.row);
        }
      } else {
        updateRow(entry, session);
      }
    });

    // Reorder existing DOM rows to match session order in place
    if (editingSessionKey === null && draggedKey === null && container) {
      sessions.forEach(session => {
        const entry = rowCache.get(session.sessionKey);
        if (entry && entry.row && entry.row.parentNode === container) {
          container.appendChild(entry.row);
        }
      });
    }
  }

  // Refresh past agents from history
  refreshKnownAgents();

  // Refresh history view if an agent is selected, or ensure unselected state is cleanly displayed
  if (selectedAgentKey) {
    updateSelectionHighlight();
    if (historyEvents && historyEvents.length > 0) {
      renderHistory(historyEvents);
    }
  } else {
    updateSelectionHighlight();
    renderHistory([]);
  }
}

function createRow(session) {
  const key = session.sessionKey;
  const isAsking = Boolean(session.isAsking);
  const isSelected = selectedAgentKey === key;

  const row = document.createElement('div');
  row.className = `session-row ${isAsking ? 'asking' : ''} ${isSelected ? 'selected' : ''}`.trim();
  row.dataset.sessionKey = key;
  row.draggable = true;

  // Clicking row selects agent to show its history, or unselects if already selected
  row.addEventListener('click', (e) => {
    if (editingSessionKey === key) return;
    if (selectedAgentKey === key) {
      unselectAgent();
    } else {
      selectAgent(key);
    }
  });

  // Main line
  const mainLine = document.createElement('div');
  mainLine.className = 'session-main-line';

  // Alert marker
  const alertMarker = document.createElement('span');
  alertMarker.className = `alert-marker ${isAsking ? '' : 'hidden'}`;
  alertMarker.textContent = '[!]';

  // State badge
  const stateBadge = document.createElement('span');
  stateBadge.className = `state-badge ${session.state}`;
  const stateCircle = document.createElement('span');
  stateCircle.className = 'state-circle';
  stateCircle.textContent = '●';
  const stateWord = document.createElement('span');
  stateWord.className = 'state-word';
  stateWord.textContent = (session.state || '').toUpperCase();
  stateBadge.appendChild(stateCircle);
  stateBadge.appendChild(document.createTextNode(' '));
  stateBadge.appendChild(stateWord);

  // Session info container
  const info = document.createElement('div');
  info.className = 'session-info';

  // Display Name
  const nameEl = document.createElement('span');
  nameEl.className = 'session-name';
  nameEl.textContent = session.displayName;
  nameEl.title = 'Double-click to rename';
  nameEl.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRename(key);
  });

  // Small fallback edit pencil button (single-click rename)
  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'edit-btn';
  editBtn.title = 'Rename';
  editBtn.setAttribute('aria-label', `Rename ${session.displayName}`);
  editBtn.textContent = '✎';
  editBtn.setAttribute('draggable', 'false');
  editBtn.addEventListener('mousedown', (e) => {
    e.stopPropagation();
  });
  editBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    startRename(key);
  });

  // Agent badge
  const agentEl = document.createElement('span');
  agentEl.className = 'session-agent';
  agentEl.textContent = session.agent || 'agent';
  agentEl.title = `Agent: ${session.agent || 'agent'}`;

  // Folder
  const folderEl = document.createElement('span');
  folderEl.className = 'session-folder';
  folderEl.textContent = session.folder;
  folderEl.title = session.folder;

  // Duration
  const durationEl = document.createElement('span');
  durationEl.className = 'session-duration';
  durationEl.textContent = session.duration;

  info.appendChild(nameEl);
  info.appendChild(editBtn);
  info.appendChild(agentEl);
  info.appendChild(folderEl);
  info.appendChild(durationEl);

  mainLine.appendChild(alertMarker);
  mainLine.appendChild(stateBadge);
  mainLine.appendChild(info);
  row.appendChild(mainLine);

  // Summary line
  const summaryEl = document.createElement('div');
  summaryEl.className = 'session-summary-line';
  if (session.summary) {
    summaryEl.textContent = session.summary;
    summaryEl.style.display = '';
  } else {
    summaryEl.textContent = '';
    summaryEl.style.display = 'none';
  }
  row.appendChild(summaryEl);

  // ASKING prompt line
  const promptEl = document.createElement('div');
  promptEl.className = 'session-prompt-line';
  if (isAsking && session.prompt) {
    const cmdText = session.prompt.command || 'unknown command';
    const decisionText = session.prompt.decision || 'needs you';
    promptEl.innerHTML = `<span class="prompt-arrow">↳</span> <span class="prompt-cmd">${escapeHtml(cmdText)}</span> <span class="prompt-decision">(${escapeHtml(decisionText)})</span>`;
    promptEl.style.display = '';
  } else {
    promptEl.innerHTML = '';
    promptEl.style.display = 'none';
  }
  row.appendChild(promptEl);

  setupDragAndDrop(row, key);

  return {
    row,
    mainLine,
    alertMarker,
    stateBadge,
    stateCircle,
    stateWord,
    info,
    nameEl,
    editBtn,
    agentEl,
    folderEl,
    durationEl,
    summaryEl,
    promptEl,
    inputEl: null
  };
}

function updateRow(entry, session) {
  const isAsking = Boolean(session.isAsking);
  const isDragging = draggedKey === session.sessionKey;
  const isSelected = selectedAgentKey === session.sessionKey;

  entry.row.className = `session-row ${isAsking ? 'asking' : ''} ${isDragging ? 'dragging' : ''} ${isSelected ? 'selected' : ''}`.trim();

  // Alert marker
  entry.alertMarker.className = `alert-marker ${isAsking ? '' : 'hidden'}`;

  // State badge
  entry.stateBadge.className = `state-badge ${session.state}`;
  entry.stateWord.textContent = (session.state || '').toUpperCase();

  // Display Name (only if not editing)
  if (editingSessionKey !== session.sessionKey && entry.nameEl) {
    entry.nameEl.textContent = session.displayName;
    if (entry.editBtn) {
      entry.editBtn.setAttribute('aria-label', `Rename ${session.displayName}`);
    }
  }

  // Agent badge
  if (entry.agentEl) {
    entry.agentEl.textContent = session.agent || 'agent';
    entry.agentEl.title = `Agent: ${session.agent || 'agent'}`;
  }

  // Folder
  if (entry.folderEl) {
    entry.folderEl.textContent = session.folder;
    entry.folderEl.title = session.folder;
  }

  // Duration
  if (entry.durationEl) {
    entry.durationEl.textContent = session.duration;
  }

  // Summary line
  if (session.summary) {
    entry.summaryEl.textContent = session.summary;
    entry.summaryEl.style.display = '';
  } else {
    entry.summaryEl.textContent = '';
    entry.summaryEl.style.display = 'none';
  }

  // ASKING prompt line
  if (isAsking && session.prompt) {
    const cmdText = session.prompt.command || 'unknown command';
    const decisionText = session.prompt.decision || 'needs you';
    entry.promptEl.innerHTML = `<span class="prompt-arrow">↳</span> <span class="prompt-cmd">${escapeHtml(cmdText)}</span> <span class="prompt-decision">(${escapeHtml(decisionText)})</span>`;
    entry.promptEl.style.display = '';
  } else {
    entry.promptEl.innerHTML = '';
    entry.promptEl.style.display = 'none';
  }
}

function startRename(sessionKey) {
  if (editingSessionKey && editingSessionKey !== sessionKey) {
    cancelRename();
  }

  const entry = rowCache.get(sessionKey);
  if (!entry) return;

  editingSessionKey = sessionKey;
  entry.row.draggable = false;

  entry.nameEl.style.display = 'none';
  entry.editBtn.style.display = 'none';

  const session = currentSessions.find(s => s.sessionKey === sessionKey);
  const currentName = session ? session.displayName : entry.nameEl.textContent;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = currentName;
  entry.inputEl = input;

  entry.info.insertBefore(input, entry.agentEl);

  let finished = false;
  const finish = (save, val) => {
    if (finished) return;
    finished = true;
    if (save) {
      saveRename(sessionKey, val);
    } else {
      cancelRename();
    }
  };

  input.addEventListener('click', (e) => {
    if (e.stopPropagation) e.stopPropagation();
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      finish(true, input.value);
    } else if (e.key === 'Escape' || e.key === 'Esc') {
      if (e.stopPropagation) e.stopPropagation();
      finish(false);
    }
  });

  input.addEventListener('blur', () => {
    if (editingSessionKey === sessionKey) {
      finish(false);
    }
  });

  setTimeout(() => {
    if (input.focus) input.focus();
    if (input.select) input.select();
  }, 10);
}

function saveRename(sessionKey, newName) {
  const trimmed = String(newName || '').trim();
  if (window.agentwatch && window.agentwatch.renameSession) {
    window.agentwatch.renameSession(sessionKey, trimmed);
  }

  const entry = rowCache.get(sessionKey);
  const session = currentSessions.find(s => s.sessionKey === sessionKey);
  if (session && trimmed) {
    session.displayName = trimmed;
  }

  if (entry) {
    if (entry.inputEl && entry.inputEl.parentNode) {
      entry.inputEl.parentNode.removeChild(entry.inputEl);
    }
    entry.inputEl = null;
    entry.nameEl.textContent = trimmed || (session ? session.displayName : '');
    entry.nameEl.style.display = '';
    entry.editBtn.style.display = '';
    entry.row.draggable = true;
  }

  editingSessionKey = null;

  if (pendingData) {
    const dataToApply = pendingData;
    pendingData = null;
    render(dataToApply);
  }
}

function cancelRename() {
  if (!editingSessionKey) return;
  const sessionKey = editingSessionKey;
  editingSessionKey = null;

  const entry = rowCache.get(sessionKey);
  if (entry) {
    if (entry.inputEl && entry.inputEl.parentNode) {
      entry.inputEl.parentNode.removeChild(entry.inputEl);
    }
    entry.inputEl = null;
    entry.nameEl.style.display = '';
    entry.editBtn.style.display = '';
    entry.row.draggable = true;
  }

  if (pendingData) {
    const dataToApply = pendingData;
    pendingData = null;
    render(dataToApply);
  }
}

function setupDragAndDrop(row, sessionKey) {
  row.addEventListener('dragstart', (e) => {
    if (editingSessionKey !== null) {
      e.preventDefault();
      return;
    }
    draggedKey = sessionKey;
    row.classList.add('dragging');
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', sessionKey);
    }
  });

  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    row.classList.add('drag-over');
  });

  row.addEventListener('dragleave', () => {
    row.classList.remove('drag-over');
  });

  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drag-over');
    if (!draggedKey || draggedKey === sessionKey) {
      draggedKey = null;
      return;
    }

    const fromKey = draggedKey;
    draggedKey = null;

    const keys = currentSessions.map(s => s.sessionKey);
    const fromIdx = keys.indexOf(fromKey);
    const toIdx = keys.indexOf(sessionKey);

    if (fromIdx !== -1 && toIdx !== -1) {
      keys.splice(fromIdx, 1);
      keys.splice(toIdx, 0, fromKey);

      const reordered = keys.map(k => currentSessions.find(s => s.sessionKey === k)).filter(Boolean);
      currentSessions = reordered;

      if (window.agentwatch && window.agentwatch.reorderSessions) {
        window.agentwatch.reorderSessions(keys);
      }
    }

    if (pendingData) {
      const dataToApply = pendingData;
      pendingData = null;
      render(dataToApply);
    }
  });

  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    if (container) {
      container.querySelectorAll('.session-row').forEach(r => r.classList.remove('drag-over'));
    }
    draggedKey = null;

    if (pendingData) {
      const dataToApply = pendingData;
      pendingData = null;
      render(dataToApply);
    }
  });
}

/**
 * Selects an agent and loads its history.
 */
function selectAgent(sessionKey) {
  if (!sessionKey) {
    unselectAgent();
    return;
  }
  selectedAgentKey = sessionKey;
  updateSelectionHighlight();
  loadHistory(sessionKey, true);
}

/**
 * Unselects any currently selected agent and resets history view to placeholder.
 */
function unselectAgent() {
  selectedAgentKey = null;
  historyEvents = [];
  historyHasOlder = false;
  historyNextOffset = 0;
  updateSelectionHighlight();
  renderHistory([]);
}

function updateSelectionHighlight() {
  if (container) {
    container.querySelectorAll('.session-row').forEach(r => {
      if (selectedAgentKey && r.dataset.sessionKey === selectedAgentKey) {
        r.classList.add('selected');
      } else {
        r.classList.remove('selected');
      }
    });
  }
  if (pastAgentsList) {
    pastAgentsList.querySelectorAll('.past-agent-row').forEach(r => {
      if (selectedAgentKey && r.dataset.sessionKey === selectedAgentKey) {
        r.classList.add('selected');
      } else {
        r.classList.remove('selected');
      }
    });
  }
}

/**
 * Loads history for the selected agent using the ONE fixed read function.
 */
function loadHistory(sessionKey, reset = true) {
  if (!sessionKey) {
    renderHistory([]);
    return;
  }

  // Find agent display name
  let displayName = sessionKey;
  const live = currentSessions.find(s => s.sessionKey === sessionKey);
  if (live) {
    displayName = live.displayName;
  } else if (currentConfig.names && currentConfig.names[sessionKey]) {
    displayName = currentConfig.names[sessionKey];
  } else {
    const known = knownAgents.find(a => a.sessionKey === sessionKey);
    if (known) displayName = known.displayName || known.folder;
  }

  if (historyAgentName) {
    historyAgentName.textContent = displayName;
  }
  if (historyHeader) {
    historyHeader.style.display = 'flex';
  }

  if (window.agentwatch && window.agentwatch.readHistory) {
    const reqOffset = reset ? undefined : historyNextOffset;
    window.agentwatch.readHistory({
      key: sessionKey,
      limit: 200,
      offset: reqOffset
    }).then(res => {
      if (!res) return;
      if (reset) {
        historyEvents = res.events || [];
      } else {
        historyEvents = historyEvents.concat(res.events || []);
      }
      historyHasOlder = Boolean(res.hasOlder);
      historyNextOffset = res.nextOffset || 0;

      if (res.knownAgents) {
        knownAgents = res.knownAgents;
        renderPastAgents();
      }

      renderHistory(historyEvents);
    });
  }
}

/**
 * Refreshes known agents from history.
 */
function refreshKnownAgents() {
  if (window.agentwatch && window.agentwatch.readHistory) {
    window.agentwatch.readHistory({
      key: null,
      scanAllAgents: true
    }).then(res => {
      if (res && res.knownAgents) {
        knownAgents = res.knownAgents;
        renderPastAgents();
      }
    });
  }
}

/**
 * Renders the collapsed Past Agents section.
 */
function renderPastAgents() {
  if (!pastAgentsList || !pastAgentsCount) return;

  const liveKeys = new Set(currentSessions.map(s => s.sessionKey));
  const past = knownAgents.filter(a => !liveKeys.has(a.sessionKey));

  pastAgentsCount.textContent = String(past.length);

  pastAgentsList.innerHTML = '';
  if (past.length === 0) {
    const emptyEl = document.createElement('div');
    emptyEl.className = 'empty-session-prompts';
    emptyEl.textContent = 'No past agents in history';
    pastAgentsList.appendChild(emptyEl);
    return;
  }

  past.forEach(agent => {
    const row = document.createElement('div');
    const isSelected = selectedAgentKey === agent.sessionKey;
    row.className = `past-agent-row ${isSelected ? 'selected' : ''}`.trim();
    row.dataset.sessionKey = agent.sessionKey;

    const nameSpan = document.createElement('span');
    nameSpan.className = 'past-agent-name';
    const customName = (currentConfig.names && currentConfig.names[agent.sessionKey]) || agent.displayName || agent.folder;
    nameSpan.textContent = customName;

    const agentSpan = document.createElement('span');
    agentSpan.className = 'past-agent-badge';
    agentSpan.textContent = agent.agent || 'agent';

    const folderSpan = document.createElement('span');
    folderSpan.className = 'past-agent-folder';
    folderSpan.textContent = agent.folder || '';

    row.appendChild(nameSpan);
    row.appendChild(agentSpan);
    row.addEventListener('click', () => {
      if (selectedAgentKey === agent.sessionKey) {
        unselectAgent();
      } else {
        selectAgent(agent.sessionKey);
      }
    });

    pastAgentsList.appendChild(row);
  });
}

/**
 * Renders the History pane content grouped by session.
 */
function renderHistory(events) {
  if (!historyGroups || !historyPlaceholder) return;

  if (!selectedAgentKey) {
    historyPlaceholder.style.display = 'block';
    historyPlaceholder.textContent = 'Select an agent to see its history';
    historyGroups.innerHTML = '';
    if (historyHeader) historyHeader.style.display = 'none';
    if (loadOlderContainer) loadOlderContainer.style.display = 'none';
    return;
  }

  historyPlaceholder.style.display = 'none';
  if (historyHeader) historyHeader.style.display = 'flex';

  const timeFormat = currentConfig.timeFormat || '24-hour';
  const activeIds = new Set();
  currentSessions.forEach(s => {
    if (!s.isDead && s.state !== 'dead') {
      if (s.sessionId) activeIds.add(s.sessionId);
      if (s.sessionKey) activeIds.add(s.sessionKey);
    }
  });
  const groups = groupHistoryBySession(events, activeIds);

  historyGroups.innerHTML = '';

  if (groups.length === 0) {
    const emptyMsg = document.createElement('div');
    emptyMsg.className = 'empty-state';
    emptyMsg.textContent = 'No recorded events for this agent';
    historyGroups.appendChild(emptyMsg);
    if (loadOlderContainer) loadOlderContainer.style.display = 'none';
    return;
  }

  groups.forEach(group => {
    const groupEl = document.createElement('div');
    groupEl.className = 'session-group';

    // Header with start stamp and session length
    const headerEl = document.createElement('div');
    headerEl.className = 'session-group-header';

    const titleEl = document.createElement('span');
    titleEl.className = 'session-group-title';
    titleEl.textContent = formatDisplayTime(group.startTime, timeFormat, true);

    const lengthEl = document.createElement('span');
    lengthEl.className = 'session-group-length';
    lengthEl.textContent = `Session length: ${group.sessionLength}`;

    headerEl.appendChild(titleEl);
    headerEl.appendChild(lengthEl);
    groupEl.appendChild(headerEl);

    // Prompt cards container
    const cardsEl = document.createElement('div');
    cardsEl.className = 'session-group-cards';

    if (group.prompts.length === 0) {
      const noPromptsEl = document.createElement('div');
      noPromptsEl.className = 'empty-session-prompts';
      noPromptsEl.textContent = 'No permission prompts in this session';
      cardsEl.appendChild(noPromptsEl);
    } else {
      group.prompts.forEach(prompt => {
        const card = createHistoryCard(prompt, timeFormat);
        cardsEl.appendChild(card);
      });
    }

    groupEl.appendChild(cardsEl);
    historyGroups.appendChild(groupEl);
  });

  if (loadOlderContainer) {
    loadOlderContainer.style.display = historyHasOlder ? 'flex' : 'none';
  }
}

/**
 * Creates a readable History Card for a prompt.
 */
function createHistoryCard(prompt, timeFormat) {
  const card = document.createElement('div');
  card.className = 'history-card';

  // Card header (Time and duration on screen)
  const header = document.createElement('div');
  header.className = 'card-header';

  const timeEl = document.createElement('span');
  timeEl.className = 'card-time';
  timeEl.textContent = formatDisplayTime(prompt.time, timeFormat, false);

  const durationEl = document.createElement('span');
  durationEl.className = 'card-duration';
  durationEl.textContent = `On screen: ${prompt.durationStr}`;

  header.appendChild(timeEl);
  header.appendChild(durationEl);
  card.appendChild(header);

  // Question
  const questionEl = document.createElement('div');
  questionEl.className = 'card-question';
  questionEl.textContent = prompt.question || 'Permission request';
  card.appendChild(questionEl);

  // Masked Command
  const commandEl = document.createElement('div');
  commandEl.className = 'card-command';
  commandEl.textContent = prompt.command;
  card.appendChild(commandEl);

  // Options list with small classification badges
  const optionsEl = document.createElement('div');
  optionsEl.className = 'card-options';

  (prompt.options || []).forEach(opt => {
    const optRow = document.createElement('div');
    optRow.className = 'card-option';

    const textSpan = document.createElement('span');
    textSpan.className = 'option-text';
    textSpan.textContent = opt.text;

    const badgeSpan = document.createElement('span');
    const badgeClass = `badge-${(opt.classification || 'unknown').replace(/_/g, '-')}`;
    badgeSpan.className = `option-badge ${badgeClass}`;
    badgeSpan.textContent = opt.label || getClassificationLabel(opt.classification);

    optRow.appendChild(textSpan);
    optRow.appendChild(badgeSpan);
    optionsEl.appendChild(optRow);
  });
  card.appendChild(optionsEl);

  // Card footer (Dry-run decision and Answer: not recorded)
  const footer = document.createElement('div');
  footer.className = 'card-footer';

  const decisionEl = document.createElement('span');
  decisionEl.className = 'card-decision';
  decisionEl.textContent = `Dry-run: ${prompt.plainDecision || formatPlainDecision(prompt.decision)}`;

  const answerEl = document.createElement('span');
  answerEl.className = 'card-answer';
  answerEl.textContent = 'Answer: not recorded';

  footer.appendChild(decisionEl);
  footer.appendChild(answerEl);
  card.appendChild(footer);

  return card;
}

/**
 * Updates the Settings tab input values.
 */
function updateSettingsTab() {
  if (settingAutoOpen && document.activeElement !== settingAutoOpen) {
    settingAutoOpen.checked = currentConfig.autoOpenWindow !== false;
  }
  if (settingPinTop && document.activeElement !== settingPinTop) {
    settingPinTop.checked = Boolean(currentConfig.alwaysOnTop);
  }
  if (settingNotifications && document.activeElement !== settingNotifications) {
    settingNotifications.checked = currentConfig.notifications !== false;
  }
  if (settingTimeFormat && document.activeElement !== settingTimeFormat) {
    settingTimeFormat.value = currentConfig.timeFormat || '24-hour';
  }
}

// -------------------------------------------------------------
// Event Listeners
// -------------------------------------------------------------

// Tabs Navigation
if (tabBtnAgents && tabBtnSettings && agentsView && settingsView) {
  tabBtnAgents.addEventListener('click', () => {
    tabBtnAgents.classList.add('active');
    tabBtnSettings.classList.remove('active');
    agentsView.style.display = 'flex';
    settingsView.style.display = 'none';
  });

  tabBtnSettings.addEventListener('click', () => {
    tabBtnSettings.classList.add('active');
    tabBtnAgents.classList.remove('active');
    agentsView.style.display = 'none';
    settingsView.style.display = 'flex';
    updateSettingsTab();
  });
}

// Clear History Button
if (clearHistoryBtn) {
  clearHistoryBtn.addEventListener('click', () => {
    if (!selectedAgentKey) return;
    const ok = window.confirm("Are you sure you want to clear this agent's history?");
    if (!ok) return;

    if (window.agentwatch && window.agentwatch.clearAgentHistory) {
      window.agentwatch.clearAgentHistory(selectedAgentKey).then(() => {
        historyEvents = [];
        historyHasOlder = false;
        historyNextOffset = 0;
        renderHistory([]);
        refreshKnownAgents();
      });
    }
  });
}

// Load Older History Button
if (loadOlderBtn) {
  loadOlderBtn.addEventListener('click', () => {
    if (!selectedAgentKey || !historyHasOlder) return;
    loadHistory(selectedAgentKey, false);
  });
}

// Quick Pin Checkbox
if (pinCheckbox) {
  pinCheckbox.addEventListener('change', (e) => {
    if (window.agentwatch && window.agentwatch.setAlwaysOnTop) {
      window.agentwatch.setAlwaysOnTop(e.target.checked);
    }
    currentConfig.alwaysOnTop = e.target.checked;
    updateSettingsTab();
  });
}

// Settings tab listeners
if (settingAutoOpen) {
  settingAutoOpen.addEventListener('change', (e) => {
    currentConfig.autoOpenWindow = e.target.checked;
    if (window.agentwatch && window.agentwatch.setSetting) {
      window.agentwatch.setSetting('autoOpenWindow', e.target.checked);
    }
  });
}

if (settingPinTop) {
  settingPinTop.addEventListener('change', (e) => {
    currentConfig.alwaysOnTop = e.target.checked;
    if (pinCheckbox) pinCheckbox.checked = e.target.checked;
    if (window.agentwatch && window.agentwatch.setAlwaysOnTop) {
      window.agentwatch.setAlwaysOnTop(e.target.checked);
    }
  });
}

if (settingNotifications) {
  settingNotifications.addEventListener('change', (e) => {
    currentConfig.notifications = e.target.checked;
    if (window.agentwatch && window.agentwatch.setSetting) {
      window.agentwatch.setSetting('notifications', e.target.checked);
    }
  });
}

if (settingTimeFormat) {
  settingTimeFormat.addEventListener('change', (e) => {
    currentConfig.timeFormat = e.target.value;
    if (window.agentwatch && window.agentwatch.setSetting) {
      window.agentwatch.setSetting('timeFormat', e.target.value);
    }
    // Re-render history with new time format immediately
    if (selectedAgentKey && historyEvents.length > 0) {
      renderHistory(historyEvents);
    }
  });
}

// Helper to find closest ancestor matching selector (browser native or mock DOM)
function findClosest(el, selector) {
  if (!el) return null;
  if (typeof el.closest === 'function') {
    return el.closest(selector);
  }
  let curr = el;
  while (curr) {
    if (curr.classList && selector.startsWith('.') && curr.classList.contains(selector.slice(1))) {
      return curr;
    }
    if (curr.id && selector.startsWith('#') && curr.id === selector.slice(1)) {
      return curr;
    }
    curr = curr.parentNode;
  }
  return null;
}

// Clicking empty space in the sessions list unselects
if (container) {
  container.addEventListener('click', (e) => {
    if (findClosest(e.target, '.session-row')) {
      return;
    }
    unselectAgent();
  });
}

const liveAgentsSection = typeof document !== 'undefined' && document.querySelector ? document.querySelector('.live-agents-section') : null;
if (liveAgentsSection) {
  liveAgentsSection.addEventListener('click', (e) => {
    if (findClosest(e.target, '.session-row')) {
      return;
    }
    unselectAgent();
  });
}

if (pastAgentsList) {
  pastAgentsList.addEventListener('click', (e) => {
    if (findClosest(e.target, '.past-agent-row')) {
      return;
    }
    unselectAgent();
  });
}

// Global keydown listener: Pressing Esc unselects it, except while a name is being edited
function handleKeyDown(e) {
  if (!e) return;
  if (e.key === 'Escape' || e.key === 'Esc') {
    if (editingSessionKey !== null) {
      cancelRename();
      return;
    }
    if (selectedAgentKey !== null) {
      unselectAgent();
    }
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('keydown', handleKeyDown);
} else if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('keydown', handleKeyDown);
}

// Setup IPC listeners in Electron environment
if (typeof window !== 'undefined' && window.agentwatch) {
  if (window.agentwatch.onUpdate) {
    window.agentwatch.onUpdate(render);
  }
  if (window.agentwatch.getState) {
    window.agentwatch.getState().then(render);
  }
}

// Export for unit tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    render,
    createRow,
    updateRow,
    startRename,
    saveRename,
    cancelRename,
    setupDragAndDrop,
    selectAgent,
    unselectAgent,
    handleKeyDown,
    renderPastAgents,
    renderHistory,
    createHistoryCard,
    formatDisplayTime,
    formatSessionLength,
    formatPlainDecision,
    getClassificationLabel,
    groupHistoryBySession,
    getRowCache: () => rowCache,
    getCurrentSessions: () => currentSessions,
    getEditingSessionKey: () => editingSessionKey,
    getDraggedKey: () => draggedKey,
    getSelectedAgentKey: () => selectedAgentKey,
    getPendingData: () => pendingData,
    getCurrentConfig: () => currentConfig,
    setKnownAgents: (agents) => { knownAgents = agents; },
    getKnownAgents: () => knownAgents,
    resetState: () => {
      rowCache.clear();
      currentSessions = [];
      editingSessionKey = null;
      draggedKey = null;
      pendingData = null;
      selectedAgentKey = null;
      knownAgents = [];
      historyEvents = [];
      historyHasOlder = false;
      historyNextOffset = 0;
      if (container) container.innerHTML = '';
      if (pastAgentsList) pastAgentsList.innerHTML = '';
      if (historyGroups) historyGroups.innerHTML = '';
    }
  };
}
