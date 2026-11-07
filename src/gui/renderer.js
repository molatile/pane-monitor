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

// DOM references helper for environment safety (browser or Node)
const getEl = (id) => typeof document !== 'undefined' ? document.getElementById(id) : null;

const countBadge = getEl('agent-count-badge');
const pinCheckbox = getEl('always-on-top-checkbox');
const pauseCheckbox = getEl('pause-auto-checkbox');
const container = getEl('sessions-container');

// Tabs
const tabBtnAgents = getEl('tab-btn-agents');
const tabBtnRules = getEl('tab-btn-rules');
const tabBtnSettings = getEl('tab-btn-settings');
const agentsView = getEl('agents-view');
const rulesView = getEl('rules-view');
const settingsView = getEl('settings-view');

// Past Agents
const pastAgentsDetails = getEl('past-agents-details');
const pastAgentsCount = getEl('past-agents-count');
const pastAgentsList = getEl('past-agents-list');

// History Pane
const historyHeader = getEl('history-header');
const historyAgentName = getEl('history-agent-name');
const clearHistoryBtn = getEl('clear-history-btn');
const clearAllHistoryBtn = getEl('clear-all-history-btn');
const historyPlaceholder = getEl('history-placeholder');
const historySummary = getEl('history-summary');
const historyGroups = getEl('history-groups');
const loadOlderContainer = getEl('load-older-container');
const loadOlderBtn = getEl('load-older-btn');

// Settings Controls
const settingAutoOpen = getEl('setting-auto-open');
const settingAutoPaused = getEl('setting-auto-paused');
const settingAutoAcceptDefault = getEl('setting-auto-accept-default');
const settingKeepAcceptingNoWindow = getEl('setting-keep-accepting-no-window');
const settingAllowTurnOn = getEl('setting-allow-turn-on');
const settingUnlockBuiltinDeny = getEl('setting-unlock-builtin-deny');
const settingPinTop = getEl('setting-pin-top');
const settingNotifications = getEl('setting-notifications');
const settingTimeFormat = getEl('setting-time-format');
const settingLogDirVal = getEl('setting-log-dir-val');
const settingLogDirBrowseBtn = getEl('setting-log-dir-browse-btn');
const settingLogDirDefaultBtn = getEl('setting-log-dir-default-btn');

// Turn on confirmation modal elements (Stage 6)
const turnOnModal = getEl('turn-on-modal');
const turnOnRulesList = getEl('turn-on-rules-list');
const turnOnStartInput = getEl('turn-on-start-input');
const turnOnConfirmBtn = getEl('turn-on-confirm-btn');
const turnOnCancelBtn = getEl('turn-on-cancel-btn');
let turnOnTargetSession = null;

// Nested folder banner elements
const nestedFolderBanner = getEl('nested-folder-banner');
const nestedBannerText = getEl('nested-banner-text');
const nestedBannerYesBtn = getEl('nested-banner-yes-btn');
const nestedBannerNoBtn = getEl('nested-banner-no-btn');
const nestedBannerDismissBtn = getEl('nested-banner-dismiss-btn');
const nestedFeedbackBanner = getEl('nested-feedback-banner');

// Camera Notch & Ambient Alert references (Stage 10)
const cameraNotchZone = getEl('camera-notch-zone');
const ambientTopShade = getEl('ambient-top-shade');
const cameraNotchPill = getEl('camera-notch-pill');
const notchTrafficLights = getEl('notch-traffic-lights');
const notchDropdownHud = getEl('notch-dropdown-hud');
const notchHudStatusText = getEl('notch-hud-status-text');
const notchHudList = getEl('notch-hud-list');
const settingCameraNotch = getEl('setting-camera-notch');
const settingFloatingNotch = getEl('setting-floating-notch');

// Rules folder selector elements
const rulesTargetSelect = getEl('rules-target-select');
const resetFolderRulesBtn = getEl('reset-folder-rules-btn');
let currentRulesTarget = 'default';
let currentTargetHasOwnRules = false;

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

function showNestedFolderBanner(pq) {
  if (!nestedFolderBanner || !nestedBannerText) return;
  nestedBannerText.textContent = `This folder, '${pq.folderName}', is inside '${pq.ancestorName}', which has its own accepting rules. Would you like this folder to have the same accepting rules as '${pq.ancestorName}'?`;
  nestedFolderBanner.style.display = 'flex';

  if (nestedBannerYesBtn) {
    nestedBannerYesBtn.onclick = () => {
      if (window.agentwatch && window.agentwatch.copyAncestorRules) {
        window.agentwatch.copyAncestorRules(pq.folderKey, pq.ancestorKey).then(res => {
          hideNestedFolderBanner();
          if (res && res.success) {
            let msg = `Successfully copied ${res.copiedCount} rules from '${pq.ancestorName}'.`;
            if (res.skippedPersistCount > 0) {
              msg += ` (${res.skippedPersistCount} rules with allowPersist skipped)`;
            }
            showNestedFeedback(msg);
          }
        });
      }
    };
  }

  if (nestedBannerNoBtn) {
    nestedBannerNoBtn.onclick = () => {
      if (window.agentwatch && window.agentwatch.setFolderChoice) {
        window.agentwatch.setFolderChoice(pq.folderKey, 'declined', pq.ancestorKey).then(() => {
          hideNestedFolderBanner();
        });
      }
    };
  }

  if (nestedBannerDismissBtn) {
    nestedBannerDismissBtn.onclick = () => {
      if (window.agentwatch && window.agentwatch.dismissFolderQuestion) {
        window.agentwatch.dismissFolderQuestion(pq.folderKey).then(() => {
          hideNestedFolderBanner();
        });
      }
    };
  }
}

function hideNestedFolderBanner() {
  if (nestedFolderBanner) {
    nestedFolderBanner.style.display = 'none';
  }
}

function showNestedFeedback(msg) {
  if (!nestedFeedbackBanner) return;
  nestedFeedbackBanner.textContent = msg;
  nestedFeedbackBanner.style.display = 'block';
  setTimeout(() => {
    if (nestedFeedbackBanner) nestedFeedbackBanner.style.display = 'none';
  }, 5000);
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

  // Check for pending nested folder question
  const pendingSession = sessions.find(s => s.pendingQuestion && s.pendingQuestion.type === 'nested_folder_rules');
  if (pendingSession && pendingSession.pendingQuestion) {
    showNestedFolderBanner(pendingSession.pendingQuestion);
  } else {
    hideNestedFolderBanner();
  }

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

  // Update Camera Notch & Ambient Glow alert
  updateCameraNotch(sessions, currentConfig);

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

function getStateIcon(state) {
  switch (state) {
    case 'idle':
      return '✓';
    case 'busy':
      return '⟳';
    case 'asking':
      return '!';
    case 'dead':
      return '✕';
    default:
      return '●';
  }
}

function showToast(message) {
  if (typeof document === 'undefined' || !document) return;
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    if (document.body && typeof document.body.appendChild === 'function') {
      document.body.appendChild(container);
    }
  }
  const toast = document.createElement('div');
  toast.className = 'toast-item';
  toast.textContent = message;
  if (container && typeof container.appendChild === 'function') {
    container.appendChild(toast);
  }
  setTimeout(() => {
    if (toast.classList && typeof toast.classList.add === 'function') {
      toast.classList.add('toast-fadeout');
    }
    setTimeout(() => {
      if (toast.parentNode && typeof toast.parentNode.removeChild === 'function') {
        toast.parentNode.removeChild(toast);
      }
    }, 400);
  }, 3000);
}

function openTurnOnModal(session) {
  if (!turnOnModal) return;
  turnOnTargetSession = session;

  if (turnOnRulesList) {
    turnOnRulesList.innerHTML = '<li>Loading rules...</li>';
  }
  if (turnOnStartInput) {
    turnOnStartInput.value = '';
  }
  if (turnOnConfirmBtn) {
    turnOnConfirmBtn.disabled = true;
  }

  turnOnModal.classList.remove('hidden');

  // Load rules for this session
  const fetchPromise = (window.agentwatch && window.agentwatch.getFolderRules)
    ? window.agentwatch.getFolderRules(session.sessionKey)
    : (window.agentwatch && window.agentwatch.getRules ? window.agentwatch.getRules() : Promise.resolve({}));

  fetchPromise.then(res => {
    if (!turnOnRulesList) return;
    turnOnRulesList.innerHTML = '';
    const rulesObj = (res && res.rules) || savedRules || {};
    const optionRules = Array.isArray(rulesObj.optionRules) ? rulesObj.optionRules : [];

    if (optionRules.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'No option rules defined (will use default allow list)';
      turnOnRulesList.appendChild(li);
    } else {
      optionRules.forEach((rule, idx) => {
        if (!rule || !rule.name) return;
        const li = document.createElement('li');
        const persistText = rule.allowPersist ? 'allowed' : 'not allowed';
        li.innerHTML = `<strong>${escapeHtml(rule.name)}</strong> (priority ${idx + 1}, persist: ${persistText})`;
        turnOnRulesList.appendChild(li);
      });
    }

    if (Array.isArray(rulesObj.allow) && rulesObj.allow.length > 0) {
      const li = document.createElement('li');
      li.innerHTML = `<em>Command allow list:</em> ${escapeHtml(rulesObj.allow.join(', '))} (persist: not allowed)`;
      turnOnRulesList.appendChild(li);
    }
  }).catch(() => {
    if (turnOnRulesList) {
      turnOnRulesList.innerHTML = '<li>(Could not load rules list)</li>';
    }
  });

  if (turnOnStartInput) {
    setTimeout(() => {
      try { turnOnStartInput.focus(); } catch (e) {}
    }, 50);
  }
}

function createRow(session) {
  const key = session.sessionKey;
  const isAsking = Boolean(session.isAsking);
  const state = String(session.state || (isAsking ? 'asking' : 'idle')).toLowerCase();
  const isSelected = selectedAgentKey === key;

  const row = document.createElement('div');
  row.className = `session-row state-${state} ${isAsking ? 'asking' : ''} ${isSelected ? 'selected' : ''}`.trim();
  row.dataset.sessionKey = key;
  row.dataset.state = state;
  row.draggable = true;

  // Clicking row selects agent to show its history, or unselects if already selected
  row.addEventListener('click', (e) => {
    if (editingSessionKey === key) return;
    if (e.target && typeof e.target.closest === 'function' && (e.target.closest('.card-copy-btn') || e.target.closest('.prompt-copy-btn'))) return;
    if (typeof window !== 'undefined' && window.getSelection && window.getSelection().toString().trim().length > 0) return;
    if (selectedAgentKey === key) {
      unselectAgent();
    } else {
      selectAgent(key);
    }
  });

  // Main line
  const mainLine = document.createElement('div');
  mainLine.className = 'session-main-line';

  const isCountdown = state === 'countdown';
  const isPromptActive = (isAsking || isCountdown) && !session.isDead;

  // Alert marker
  const alertMarker = document.createElement('span');
  alertMarker.className = `alert-marker ${isPromptActive ? '' : 'hidden'}`;
  alertMarker.textContent = isCountdown ? '[~]' : '[!]';

  // State badge
  const stateBadge = document.createElement('span');
  stateBadge.className = `state-badge ${state}`;
  const stateCircle = document.createElement('span');
  stateCircle.className = `state-icon state-circle ${state === 'busy' ? 'spinner' : ''}`;
  stateCircle.textContent = getStateIcon(state);
  const stateWord = document.createElement('span');
  stateWord.className = 'state-word';
  const ruleName = session.rule || (session.prompt && session.prompt.rule);
  const ruleText = (isCountdown && ruleName) ? ` (${ruleName})` : '';
  stateWord.textContent = isCountdown ? ('COUNTDOWN' + (session.countdown ? ` ${session.countdown}s` : '') + ruleText) : state.toUpperCase();
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

  // AUTO ON marker badge (clicking turns auto OFF at once)
  const autoEl = document.createElement('span');
  autoEl.className = `session-auto-badge ${session.auto ? '' : 'hidden'}`;
  autoEl.textContent = 'AUTO ON';
  autoEl.title = 'Auto-accept is ON. Click to turn off.';
  autoEl.setAttribute('role', 'button');
  autoEl.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!session.sessionId) return;
    if (window.agentwatch && window.agentwatch.setSessionAuto) {
      window.agentwatch.setSessionAuto({ sessionId: session.sessionId, state: 'off' }).then(res => {
        if (res && res.success) {
          showToast(`Auto-accept turned off for ${session.folder || 'session'}`);
        }
      }).catch(() => {});
    }
  });

  // Turn on auto-accept button
  const turnOnAutoBtn = document.createElement('button');
  turnOnAutoBtn.type = 'button';
  turnOnAutoBtn.className = `btn-turn-on-auto ${session.auto ? 'hidden' : ''}`.trim();
  turnOnAutoBtn.textContent = 'Turn on auto-accept';
  const isAllowed = Boolean(currentConfig.allowTurnOnFromWindow);
  turnOnAutoBtn.disabled = !isAllowed;
  if (!isAllowed) {
    turnOnAutoBtn.classList.add('disabled');
    turnOnAutoBtn.title = 'Turning on auto-accept from the window is disabled in Settings';
  } else {
    turnOnAutoBtn.classList.remove('disabled');
    turnOnAutoBtn.title = 'Click to configure and enable auto-accept for this session';
  }
  turnOnAutoBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!currentConfig.allowTurnOnFromWindow) return;
    openTurnOnModal(session);
  });

  // Rule set indicator ("default rules" or "own rules")
  const ruleSetEl = document.createElement('span');
  ruleSetEl.className = 'session-ruleset-tag';
  const ruleSetText = session.ruleSet || (session.hasOwnRules ? 'own rules' : 'default rules');
  ruleSetEl.textContent = ruleSetText;
  ruleSetEl.title = `Using ${ruleSetText}. Click to view rules.`;
  ruleSetEl.setAttribute('role', 'button');
  ruleSetEl.addEventListener('click', (e) => {
    e.stopPropagation();
    switchTab('rules');
    currentRulesTarget = session.sessionKey || 'default';
    if (rulesTargetSelect) {
      rulesTargetSelect.value = currentRulesTarget;
    }
    loadRulesView();
  });

  // PERSIST ALLOWED marker badge
  const persistEl = document.createElement('span');
  persistEl.className = `session-persist-badge ${session.allowPersist ? '' : 'hidden'}`;
  persistEl.textContent = 'PERSIST ALLOWED';
  persistEl.title = 'Rules allow persisting permission';

  // Agent badge
  const agentEl = document.createElement('span');
  agentEl.className = 'session-agent';
  agentEl.textContent = (session.agent || 'agent') + (session.auto ? ' (auto)' : '');
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
  info.appendChild(autoEl);
  info.appendChild(turnOnAutoBtn);
  info.appendChild(ruleSetEl);
  info.appendChild(persistEl);
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

  // ASKING / COUNTDOWN prompt line
  const promptEl = document.createElement('div');
  promptEl.className = 'session-prompt-line';
  if (isPromptActive && session.prompt) {
    let typeLabel = 'command';
    let targetText = session.prompt.command || 'unknown command';
    const pType = session.prompt.type || 'command';
    if (pType === 'file_edit' || pType === 'file edit') {
      typeLabel = 'file edit';
      targetText = session.prompt.fileName || (session.prompt.targetFile ? session.prompt.targetFile.split(/[/\\]/).pop() : (session.prompt.command || 'file'));
    } else if (pType === 'unrecognized' || session.prompt.label === 'unrecognized prompt' || session.prompt.label === 'prompt') {
      typeLabel = 'unrecognized';
      targetText = 'prompt';
    }
    let decisionText = session.prompt.decision || 'needs you';
    if (typeof decisionText === 'string') {
      if (decisionText.startsWith('DANGER: matched ')) {
        decisionText = decisionText.replace(/^DANGER:\s*matched\s*/i, 'needs you because: danger word ');
      } else if (decisionText === 'needs you') {
        decisionText = 'needs you because: no rule matched';
      } else if (decisionText.includes('tie between options')) {
        const tieM = decisionText.match(/(tie between options \d+(?: and \d+)+)/i);
        decisionText = `needs you because: ${tieM ? tieM[1] : decisionText}`;
      } else if (pType === 'unrecognized' && (decisionText === 'needs you' || decisionText.includes('unrecognized prompt') || decisionText === 'needs you because: no rule matched')) {
        decisionText = 'needs you because: unrecognized prompt';
      }
    }
    promptEl.innerHTML = `<span class="prompt-arrow">↳</span> <span class="prompt-type-tag">[${escapeHtml(typeLabel)}]</span> <span class="prompt-cmd">${escapeHtml(targetText)}</span> <button type="button" class="prompt-copy-btn" title="Copy prompt command to clipboard">Copy</button> <span class="prompt-decision">(${escapeHtml(decisionText)})</span>`;
    promptEl.style.display = '';
  } else {
    promptEl.innerHTML = '';
    promptEl.style.display = 'none';
  }
  promptEl.addEventListener('click', (e) => {
    const btn = e.target && typeof e.target.closest === 'function' ? e.target.closest('.prompt-copy-btn') : null;
    if (btn) {
      e.stopPropagation();
      const cmdSpan = typeof promptEl.querySelector === 'function' ? promptEl.querySelector('.prompt-cmd') : null;
      const textToCopy = cmdSpan ? cmdSpan.textContent : '';
      copyTextToClipboard(textToCopy);
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    }
  });
  row.appendChild(promptEl);

  setupDragAndDrop(row, key);

  return {
    row,
    mainLine,
    alertMarker,
    stateBadge,
    stateCircle,
    stateIcon: stateCircle,
    stateWord,
    info,
    nameEl,
    editBtn,
    autoEl,
    turnOnAutoBtn,
    ruleSetEl,
    persistEl,
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
  const state = String(session.state || (isAsking ? 'asking' : 'idle')).toLowerCase();
  const isCountdown = state === 'countdown';
  const isPromptActive = (isAsking || isCountdown) && !session.isDead;
  const isDragging = draggedKey === session.sessionKey;
  const isSelected = selectedAgentKey === session.sessionKey;

  entry.row.className = `session-row state-${state} ${isAsking ? 'asking' : ''} ${isDragging ? 'dragging' : ''} ${isSelected ? 'selected' : ''}`.trim();
  entry.row.dataset.state = state;

  // Alert marker
  entry.alertMarker.className = `alert-marker ${isPromptActive ? '' : 'hidden'}`;
  entry.alertMarker.textContent = isCountdown ? '[~]' : '[!]';

  // State badge
  entry.stateBadge.className = `state-badge ${state}`;
  const iconEl = entry.stateIcon || entry.stateCircle;
  if (iconEl) {
    iconEl.className = `state-icon state-circle ${state === 'busy' ? 'spinner' : ''}`;
    iconEl.textContent = getStateIcon(state);
  }
  const ruleName = session.rule || (session.prompt && session.prompt.rule);
  const ruleText = (isCountdown && ruleName) ? ` (${ruleName})` : '';
  entry.stateWord.textContent = isCountdown ? ('COUNTDOWN' + (session.countdown ? ` ${session.countdown}s` : '') + ruleText) : state.toUpperCase();

  // Display Name (only if not editing)
  if (editingSessionKey !== session.sessionKey && entry.nameEl) {
    entry.nameEl.textContent = session.displayName;
    if (entry.editBtn) {
      entry.editBtn.setAttribute('aria-label', `Rename ${session.displayName}`);
    }
  }

  // AUTO ON marker badge
  if (entry.autoEl) {
    entry.autoEl.className = `session-auto-badge ${session.auto ? '' : 'hidden'}`;
  }

  // Turn on auto-accept button
  if (entry.turnOnAutoBtn) {
    entry.turnOnAutoBtn.className = `btn-turn-on-auto ${session.auto ? 'hidden' : ''}`.trim();
    const isAllowed = Boolean(currentConfig.allowTurnOnFromWindow);
    entry.turnOnAutoBtn.disabled = !isAllowed;
    if (!isAllowed) {
      entry.turnOnAutoBtn.classList.add('disabled');
      entry.turnOnAutoBtn.title = 'Turning on auto-accept from the window is disabled in Settings';
    } else {
      entry.turnOnAutoBtn.classList.remove('disabled');
      entry.turnOnAutoBtn.title = 'Click to configure and enable auto-accept for this session';
    }
  }

  // Rule set indicator
  if (entry.ruleSetEl) {
    const ruleSetText = session.ruleSet || (session.hasOwnRules ? 'own rules' : 'default rules');
    entry.ruleSetEl.textContent = ruleSetText;
    entry.ruleSetEl.title = `Using ${ruleSetText}. Click to view rules.`;
  }

  // PERSIST ALLOWED marker badge
  if (entry.persistEl) {
    entry.persistEl.className = `session-persist-badge ${session.allowPersist ? '' : 'hidden'}`;
  }

  // Agent badge
  if (entry.agentEl) {
    entry.agentEl.textContent = (session.agent || 'agent') + (session.auto ? ' (auto)' : '');
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

  // ASKING / COUNTDOWN prompt line
  if (isPromptActive && session.prompt) {
    let typeLabel = 'command';
    let targetText = session.prompt.command || 'unknown command';
    const pType = session.prompt.type || 'command';
    if (pType === 'file_edit' || pType === 'file edit') {
      typeLabel = 'file edit';
      targetText = session.prompt.fileName || (session.prompt.targetFile ? session.prompt.targetFile.split(/[/\\]/).pop() : (session.prompt.command || 'file'));
    } else if (pType === 'unrecognized' || session.prompt.label === 'unrecognized prompt' || session.prompt.label === 'prompt') {
      typeLabel = 'unrecognized';
      targetText = 'prompt';
    }
    let decisionText = session.prompt.decision || 'needs you';
    if (typeof decisionText === 'string') {
      if (decisionText.startsWith('DANGER: matched ')) {
        decisionText = decisionText.replace(/^DANGER:\s*matched\s*/i, 'needs you because: danger word ');
      } else if (decisionText === 'needs you') {
        decisionText = 'needs you because: no rule matched';
      } else if (decisionText.includes('tie between options')) {
        const tieM = decisionText.match(/(tie between options \d+(?: and \d+)+)/i);
        decisionText = `needs you because: ${tieM ? tieM[1] : decisionText}`;
      } else if (pType === 'unrecognized' && (decisionText === 'needs you' || decisionText.includes('unrecognized prompt') || decisionText === 'needs you because: no rule matched')) {
        decisionText = 'needs you because: unrecognized prompt';
      }
    }
    entry.promptEl.innerHTML = `<span class="prompt-arrow">↳</span> <span class="prompt-type-tag">[${escapeHtml(typeLabel)}]</span> <span class="prompt-cmd">${escapeHtml(targetText)}</span> <button type="button" class="prompt-copy-btn" title="Copy prompt command to clipboard">Copy</button> <span class="prompt-decision">(${escapeHtml(decisionText)})</span>`;
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
    if (typeof window !== 'undefined' && window.getSelection && window.getSelection().toString().trim().length > 0) {
      e.preventDefault();
      return;
    }
    if (e.target && typeof e.target.closest === 'function' && (e.target.closest('.card-copy-btn') || e.target.closest('.prompt-copy-btn') || e.target.closest('.session-prompt-line'))) {
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
  if (historySummary) {
    historySummary.textContent = '';
    historySummary.style.display = 'none';
  }
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
    if (historySummary) historySummary.style.display = 'none';
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
    if (historySummary) historySummary.style.display = 'none';
    if (loadOlderContainer) loadOlderContainer.style.display = 'none';
    return;
  }

  // Calculate summary counts across all prompts of the selected agent
  let knownAnswerCount = 0;
  let agreedCount = 0;
  let persistCount = 0;
  let needsYouCount = 0;

  groups.forEach(group => {
    (group.prompts || []).forEach(p => {
      const isKnown = p.answer_key !== undefined && p.answer_key !== null && p.answer_key !== 'unknown';
      if (isKnown) {
        knownAnswerCount++;
        if (p.agreement === 'agrees') {
          agreedCount++;
        }
      }

      if (p.answer_class === 'yes_persist') {
        persistCount++;
      }

      const isNeedsUser = (p.decision && p.decision.action === 'needs_user') ||
                          (typeof p.plainDecision === 'string' && p.plainDecision.toLowerCase().includes('needs you'));
      if (isNeedsUser) {
        needsYouCount++;
      }
    });
  });

  if (historySummary) {
    historySummary.textContent = `Out of ${knownAnswerCount} prompts, the dry run would have handled ${agreedCount} the same way you did. Persist options chosen: ${persistCount} · Needs you prompts: ${needsYouCount}`;
    historySummary.style.display = 'block';
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
 * Helper to safely copy text to system clipboard
 */
function copyTextToClipboard(text) {
  if (!text) return;
  if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    navigator.clipboard.writeText(text).catch(() => {
      fallbackExecCopy(text);
    });
    return;
  }
  fallbackExecCopy(text);
}

function fallbackExecCopy(text) {
  if (typeof document === 'undefined' || !document.body) return;
  try {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.position = 'fixed';
    el.style.opacity = '0';
    document.body.appendChild(el);
    if (typeof el.select === 'function') {
      el.select();
    }
    if (typeof document.execCommand === 'function') {
      document.execCommand('copy');
    }
    document.body.removeChild(el);
  } catch (e) {}
}

/**
 * Creates a readable History Card for a prompt.
 */
function createHistoryCard(prompt, timeFormat) {
  const card = document.createElement('div');
  card.className = 'history-card';

  // Card header (Time, Copy button, and duration on screen)
  const header = document.createElement('div');
  header.className = 'card-header';

  const timeEl = document.createElement('span');
  timeEl.className = 'card-time';
  timeEl.textContent = formatDisplayTime(prompt.time, timeFormat, false);

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.className = 'card-copy-btn';
  copyBtn.title = 'Copy prompt or command to clipboard';
  copyBtn.textContent = 'Copy';
  copyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const toCopy = prompt.command || prompt.question || '';
    copyTextToClipboard(toCopy);
    copyBtn.textContent = 'Copied!';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
  });

  const durationEl = document.createElement('span');
  durationEl.className = 'card-duration';
  durationEl.textContent = `On screen: ${prompt.durationStr}`;

  header.appendChild(timeEl);
  header.appendChild(copyBtn);
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

  const decisionLine = document.createElement('div');
  decisionLine.className = 'card-decision-line';

  const decisionEl = document.createElement('span');
  decisionEl.className = 'card-decision';
  if (prompt.answered_by === 'auto' || prompt.answeredBy === 'auto') {
    const opt = prompt.answer_key || (prompt.decision && prompt.decision.optionKey) || '1';
    const r = prompt.rule || (prompt.decision && prompt.decision.rule) || 'unknown';
    decisionEl.textContent = `Auto-approved option ${opt} (rule: ${r})`;
  } else {
    decisionEl.textContent = `Dry-run: ${prompt.plainDecision || formatPlainDecision(prompt.decision)}`;
  }
  decisionLine.appendChild(decisionEl);

  if (prompt.agreement === 'agrees') {
    const agreeBadge = document.createElement('span');
    agreeBadge.className = 'agreement-badge badge-agrees';
    agreeBadge.textContent = 'Tool would have agreed';
    decisionLine.appendChild(agreeBadge);
  } else if (prompt.agreement === 'differs') {
    const differBadge = document.createElement('span');
    differBadge.className = 'agreement-badge badge-differs';
    differBadge.textContent = 'Tool would have differed';
    decisionLine.appendChild(differBadge);
  }

  const answerEl = document.createElement('span');
  answerEl.className = 'card-answer';
  answerEl.textContent = prompt.answer || 'Answer: not recorded';

  footer.appendChild(decisionLine);
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
  if (pauseCheckbox && document.activeElement !== pauseCheckbox) {
    pauseCheckbox.checked = Boolean(currentConfig.autoPaused);
  }
  if (settingAutoPaused && document.activeElement !== settingAutoPaused) {
    settingAutoPaused.checked = Boolean(currentConfig.autoPaused);
  }
  if (settingAutoAcceptDefault && document.activeElement !== settingAutoAcceptDefault) {
    settingAutoAcceptDefault.checked = Boolean(currentConfig.autoAcceptDefault);
  }
  if (settingKeepAcceptingNoWindow && document.activeElement !== settingKeepAcceptingNoWindow) {
    settingKeepAcceptingNoWindow.checked = Boolean(currentConfig.keepAcceptingWhenNoWindow);
  }
  if (settingAllowTurnOn && document.activeElement !== settingAllowTurnOn) {
    settingAllowTurnOn.checked = Boolean(currentConfig.allowTurnOnFromWindow);
  }
  if (settingUnlockBuiltinDeny && document.activeElement !== settingUnlockBuiltinDeny) {
    settingUnlockBuiltinDeny.checked = Boolean(currentConfig.unlockBuiltinDenyRules);
  }
  if (settingTimeFormat && document.activeElement !== settingTimeFormat) {
    settingTimeFormat.value = currentConfig.timeFormat || '24-hour';
  }
  if (settingCameraNotch && document.activeElement !== settingCameraNotch) {
    settingCameraNotch.checked = currentConfig.cameraNotch !== false;
  }
  if (settingFloatingNotch && document.activeElement !== settingFloatingNotch) {
    settingFloatingNotch.checked = currentConfig.floatingNotch !== false;
  }
  if (settingLogDirVal) {
    settingLogDirVal.textContent = (currentConfig && currentConfig.logDir && currentConfig.logDir.trim())
      ? currentConfig.logDir.trim()
      : 'Default: the folder the agent was started in';
  }
}

// -------------------------------------------------------------
// Camera Notch & Ambient Graphic Alert (Stage 10)
// -------------------------------------------------------------

/**
 * Updates the Camera Notch & Ambient Glow alert at the top of the window directly below webcam.
 * Computes individual traffic lights for each active agent, plus dominant alert shade.
 */
function updateCameraNotch(sessions = [], config = {}) {
  const notchZone = getEl('camera-notch-zone') || cameraNotchZone;
  const shade = getEl('ambient-top-shade') || ambientTopShade;
  const pill = getEl('camera-notch-pill') || cameraNotchPill;
  const lightsContainer = getEl('notch-traffic-lights') || notchTrafficLights;

  if (!notchZone || !lightsContainer) return;

  // Honor setting if explicitly disabled
  if (config.cameraNotch === false) {
    notchZone.classList.add('hidden');
    if (shade) shade.className = 'ambient-top-shade shade-off';
    return;
  } else {
    notchZone.classList.remove('hidden');
  }

  const activeSessions = (sessions || []).filter(s => !s.isDead && s.state !== 'dead');

  // Determine dominant state across all agents for ambient shade
  let dominantState = 'off';
  if (activeSessions.length > 0) {
    if (activeSessions.some(s => s.isAsking || s.state === 'asking')) {
      dominantState = 'asking';
    } else if (activeSessions.some(s => s.state === 'countdown')) {
      dominantState = 'countdown';
    } else if (activeSessions.some(s => s.state === 'busy')) {
      dominantState = 'busy';
    } else {
      dominantState = 'idle';
    }
  } else if ((sessions || []).length > 0) {
    dominantState = 'dead';
  }

  // Update ambient top glow shade
  if (shade) {
    shade.className = `ambient-top-shade shade-${dominantState}`;
  }

  // Update central notch pill dominant state
  if (pill) {
    pill.dataset.dominant = dominantState;
  }

  // Render traffic lights
  lightsContainer.innerHTML = '';

  if (activeSessions.length === 0) {
    const offDot = document.createElement('span');
    offDot.className = 'notch-dot dot-off';
    const offLabel = document.createElement('span');
    offLabel.className = 'notch-label';
    offLabel.textContent = (sessions && sessions.length > 0) ? 'inactive' : 'ready';
    lightsContainer.appendChild(offDot);
    lightsContainer.appendChild(offLabel);
  } else {
    activeSessions.forEach((sess, idx) => {
      if (idx > 0) {
        const divider = document.createElement('span');
        divider.className = 'notch-pod-divider';
        lightsContainer.appendChild(divider);
      }

      const isAsking = Boolean(sess.isAsking || sess.state === 'asking');
      const isCountdown = sess.state === 'countdown';
      const state = isAsking ? 'asking' : (sess.state || 'idle');

      const pod = document.createElement('div');
      pod.className = `notch-pod state-${state}`;
      pod.dataset.sessionKey = sess.sessionKey || '';

      const dot = document.createElement('span');
      dot.className = `notch-dot dot-${state}`;
      pod.appendChild(dot);

      const nameSpan = document.createElement('span');
      nameSpan.className = 'notch-agent-name';
      const name = sess.displayName || sess.folder || sess.agent || 'agent';
      nameSpan.textContent = name;
      pod.appendChild(nameSpan);

      if (isCountdown && sess.countdown !== null && sess.countdown !== undefined) {
        const cdSpan = document.createElement('span');
        cdSpan.className = 'notch-countdown-tag';
        cdSpan.textContent = `${sess.countdown}s`;
        pod.appendChild(cdSpan);
      } else if (isAsking) {
        const askSpan = document.createElement('span');
        askSpan.className = 'notch-asking-tag';
        askSpan.textContent = '!';
        pod.appendChild(askSpan);
      }

      // Tooltip description
      let title = `${name} [${state.toUpperCase()}]`;
      if (sess.prompt && (sess.prompt.command || sess.prompt.question)) {
        title += `: ${sess.prompt.command || sess.prompt.question}`;
      }
      pod.title = title;

      // Click on a pod to jump directly to that agent
      pod.addEventListener('click', (e) => {
        e.stopPropagation();
        jumpToAgent(sess.sessionKey);
      });

      lightsContainer.appendChild(pod);
    });
  }

  // Update HUD contents if present
  updateNotchHud(sessions, activeSessions, dominantState);
}

/**
 * Updates the contents of the dropdown HUD under the notch.
 */
function updateNotchHud(sessions = [], activeSessions = [], dominantState = 'off') {
  const hudStatus = getEl('notch-hud-status-text') || notchHudStatusText;
  const hudList = getEl('notch-hud-list') || notchHudList;
  if (!hudList) return;

  if (hudStatus) {
    const askingCount = activeSessions.filter(s => s.isAsking || s.state === 'asking').length;
    if (askingCount > 0) {
      hudStatus.textContent = `🔴 ${askingCount} agent${askingCount === 1 ? '' : 's'} need approval`;
      hudStatus.style.color = '#ef4444';
    } else if (dominantState === 'countdown') {
      hudStatus.textContent = '🟠 Auto-accept countdown active';
      hudStatus.style.color = '#f59e0b';
    } else if (dominantState === 'busy') {
      hudStatus.textContent = `🟡 ${activeSessions.length} agent${activeSessions.length === 1 ? '' : 's'} busy`;
      hudStatus.style.color = '#eab308';
    } else if (dominantState === 'idle') {
      hudStatus.textContent = `🟢 All ${activeSessions.length} active agent${activeSessions.length === 1 ? '' : 's'} calm & idle`;
      hudStatus.style.color = '#22c55e';
    } else {
      hudStatus.textContent = '⚪ No active agents running';
      hudStatus.style.color = 'var(--text-secondary)';
    }
  }

  hudList.innerHTML = '';
  if (!sessions || sessions.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'notch-hud-empty';
    empty.textContent = 'No agents running. Launch agentwatch <agent> in a terminal.';
    hudList.appendChild(empty);
    return;
  }

  sessions.forEach(sess => {
    const isAsking = Boolean(sess.isAsking || sess.state === 'asking');
    const isDead = sess.isDead || sess.state === 'dead';
    const state = isDead ? 'dead' : (isAsking ? 'asking' : (sess.state || 'idle'));

    const item = document.createElement('div');
    item.className = 'notch-hud-item';
    item.title = 'Click to focus this agent';
    item.addEventListener('click', () => {
      jumpToAgent(sess.sessionKey);
    });

    const left = document.createElement('div');
    left.className = 'notch-hud-item-left';

    const dot = document.createElement('span');
    dot.className = `notch-dot dot-${state}`;
    left.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'notch-hud-item-name';
    name.textContent = sess.displayName || sess.folder || sess.agent || 'agent';
    left.appendChild(name);

    if (sess.prompt) {
      const preview = document.createElement('span');
      preview.className = 'notch-hud-item-preview';
      preview.textContent = sess.prompt.command || sess.prompt.question || sess.prompt.decision || '';
      left.appendChild(preview);
    }
    item.appendChild(left);

    const badge = document.createElement('span');
    badge.className = `notch-hud-item-badge badge-${state}-hud`;
    if (state === 'countdown' && sess.countdown) {
      badge.textContent = `${sess.countdown}s`;
    } else {
      badge.textContent = state;
    }
    item.appendChild(badge);

    hudList.appendChild(item);
  });
}

function toggleNotchHud() {
  const hud = getEl('notch-dropdown-hud') || notchDropdownHud;
  const pill = getEl('camera-notch-pill') || cameraNotchPill;
  if (!hud) return;
  const isShown = hud.style.display !== 'none';
  if (isShown) {
    closeNotchHud();
  } else {
    hud.style.display = 'block';
    if (pill) pill.classList.add('hud-open');
  }
}

function closeNotchHud() {
  const hud = getEl('notch-dropdown-hud') || notchDropdownHud;
  const pill = getEl('camera-notch-pill') || cameraNotchPill;
  if (hud) hud.style.display = 'none';
  if (pill) pill.classList.remove('hud-open');
}

function jumpToAgent(sessionKey) {
  if (!sessionKey) return;
  if (tabBtnAgents && !tabBtnAgents.classList.contains('active')) {
    switchTab('agents');
  }
  selectAgent(sessionKey);
  if (container) {
    const row = container.querySelector(`[data-session-key="${sessionKey}"]`);
    if (row && typeof row.scrollIntoView === 'function') {
      row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }
  closeNotchHud();
}

// -------------------------------------------------------------
// Event Listeners
// -------------------------------------------------------------

// Tabs Navigation
function switchTab(activeTab) {
  if (tabBtnAgents) {
    if (activeTab === 'agents') tabBtnAgents.classList.add('active');
    else tabBtnAgents.classList.remove('active');
  }
  if (tabBtnRules) {
    if (activeTab === 'rules') tabBtnRules.classList.add('active');
    else tabBtnRules.classList.remove('active');
  }
  if (tabBtnSettings) {
    if (activeTab === 'settings') tabBtnSettings.classList.add('active');
    else tabBtnSettings.classList.remove('active');
  }

  if (agentsView) agentsView.style.display = activeTab === 'agents' ? 'flex' : 'none';
  if (rulesView) rulesView.style.display = activeTab === 'rules' ? 'flex' : 'none';
  if (settingsView) settingsView.style.display = activeTab === 'settings' ? 'flex' : 'none';

  if (activeTab === 'rules') {
    loadRulesView();
  } else if (activeTab === 'settings') {
    updateSettingsTab();
  }
}

if (tabBtnAgents) {
  tabBtnAgents.addEventListener('click', () => switchTab('agents'));
}
if (tabBtnRules) {
  tabBtnRules.addEventListener('click', () => switchTab('rules'));
}
if (tabBtnSettings) {
  tabBtnSettings.addEventListener('click', () => switchTab('settings'));
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

// Clear All History Button
if (clearAllHistoryBtn) {
  clearAllHistoryBtn.addEventListener('click', () => {
    const ok = window.confirm("Are you sure you want to clear ALL history across all agents?");
    if (!ok) return;

    if (window.agentwatch && window.agentwatch.clearAllHistory) {
      window.agentwatch.clearAllHistory().then(() => {
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
    const val = e.target.checked;
    currentConfig.autoOpenWindow = val;
    if (typeof window !== 'undefined' && window.agentwatch && window.agentwatch.setSetting) {
      Promise.resolve(window.agentwatch.setSetting('autoOpenWindow', val)).then((res) => {
        if (!res || res.success) showToast('Saved');
        else {
          currentConfig.autoOpenWindow = !val;
          settingAutoOpen.checked = !val;
          showToast((res && res.error) ? `Error: ${res.error}` : 'Failed to save setting');
        }
      }).catch((err) => {
        currentConfig.autoOpenWindow = !val;
        settingAutoOpen.checked = !val;
        showToast(`Error: ${err.message || 'Failed to save setting'}`);
      });
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
    const val = e.target.checked;
    currentConfig.notifications = val;
    if (typeof window !== 'undefined' && window.agentwatch && window.agentwatch.setSetting) {
      Promise.resolve(window.agentwatch.setSetting('notifications', val)).then((res) => {
        if (!res || res.success) showToast('Saved');
        else {
          currentConfig.notifications = !val;
          settingNotifications.checked = !val;
          showToast((res && res.error) ? `Error: ${res.error}` : 'Failed to save setting');
        }
      }).catch((err) => {
        currentConfig.notifications = !val;
        settingNotifications.checked = !val;
        showToast(`Error: ${err.message || 'Failed to save setting'}`);
      });
    }
  });
}

// Pause auto-accept checkboxes (global toggle in header and setting item)
if (pauseCheckbox) {
  pauseCheckbox.addEventListener('change', (e) => {
    const val = e.target.checked;
    currentConfig.autoPaused = val;
    if (settingAutoPaused) settingAutoPaused.checked = val;
    if (typeof window !== 'undefined' && window.agentwatch && window.agentwatch.setSetting) {
      Promise.resolve(window.agentwatch.setSetting('autoPaused', val)).then((res) => {
        if (!res || res.success) showToast('Saved');
        else {
          currentConfig.autoPaused = !val;
          pauseCheckbox.checked = !val;
          if (settingAutoPaused) settingAutoPaused.checked = !val;
          showToast((res && res.error) ? `Error: ${res.error}` : 'Failed to save setting');
        }
      }).catch((err) => {
        currentConfig.autoPaused = !val;
        pauseCheckbox.checked = !val;
        if (settingAutoPaused) settingAutoPaused.checked = !val;
        showToast(`Error: ${err.message || 'Failed to save setting'}`);
      });
    }
  });
}

if (settingAutoPaused) {
  settingAutoPaused.addEventListener('change', (e) => {
    const val = e.target.checked;
    currentConfig.autoPaused = val;
    if (pauseCheckbox) pauseCheckbox.checked = val;
    if (typeof window !== 'undefined' && window.agentwatch && window.agentwatch.setSetting) {
      Promise.resolve(window.agentwatch.setSetting('autoPaused', val)).then((res) => {
        if (!res || res.success) showToast('Saved');
        else {
          currentConfig.autoPaused = !val;
          settingAutoPaused.checked = !val;
          if (pauseCheckbox) pauseCheckbox.checked = !val;
          showToast((res && res.error) ? `Error: ${res.error}` : 'Failed to save setting');
        }
      }).catch((err) => {
        currentConfig.autoPaused = !val;
        settingAutoPaused.checked = !val;
        if (pauseCheckbox) pauseCheckbox.checked = !val;
        showToast(`Error: ${err.message || 'Failed to save setting'}`);
      });
    }
  });
}

if (settingKeepAcceptingNoWindow) {
  settingKeepAcceptingNoWindow.addEventListener('change', (e) => {
    const val = e.target.checked;
    currentConfig.keepAcceptingWhenNoWindow = val;
    if (typeof window !== 'undefined' && window.agentwatch && window.agentwatch.setKeepAcceptingWhenNoWindow) {
      Promise.resolve(window.agentwatch.setKeepAcceptingWhenNoWindow(val)).then((res) => {
        if (!res || res.success) showToast('Saved');
        else {
          currentConfig.keepAcceptingWhenNoWindow = !val;
          settingKeepAcceptingNoWindow.checked = !val;
          showToast((res && res.error) ? `Error: ${res.error}` : 'Failed to save setting');
        }
      }).catch((err) => {
        currentConfig.keepAcceptingWhenNoWindow = !val;
        settingKeepAcceptingNoWindow.checked = !val;
        showToast(`Error: ${err.message || 'Failed to save setting'}`);
      });
    }
  });
}

if (settingTimeFormat) {
  settingTimeFormat.addEventListener('change', (e) => {
    const val = e.target.value;
    currentConfig.timeFormat = val;
    if (typeof window !== 'undefined' && window.agentwatch && window.agentwatch.setSetting) {
      Promise.resolve(window.agentwatch.setSetting('timeFormat', val)).then((res) => {
        if (!res || res.success) showToast('Saved');
        else showToast((res && res.error) ? `Error: ${res.error}` : 'Failed to save setting');
      }).catch((err) => {
        showToast(`Error: ${err.message || 'Failed to save setting'}`);
      });
    }
    // Re-render history with new time format immediately
    if (selectedAgentKey && historyEvents.length > 0) {
      renderHistory(historyEvents);
    }
  });
}

// Stage 6: Auto-accept settings listeners
if (settingAutoAcceptDefault) {
  settingAutoAcceptDefault.addEventListener('change', (e) => {
    const val = e.target.checked;
    currentConfig.autoAcceptDefault = val;
    if (typeof window !== 'undefined' && window.agentwatch && window.agentwatch.setSetting) {
      Promise.resolve(window.agentwatch.setSetting('autoAcceptDefault', val)).then((res) => {
        if (!res || res.success) {
          showToast('Saved');
        } else {
          currentConfig.autoAcceptDefault = !val;
          settingAutoAcceptDefault.checked = !val;
          showToast((res && res.error) ? `Error: ${res.error}` : 'Failed to save setting');
        }
      }).catch((err) => {
        currentConfig.autoAcceptDefault = !val;
        settingAutoAcceptDefault.checked = !val;
        showToast(`Error: ${err.message || 'Failed to save setting'}`);
      });
    }
  });
}

if (settingAllowTurnOn) {
  settingAllowTurnOn.addEventListener('change', (e) => {
    const val = e.target.checked;
    currentConfig.allowTurnOnFromWindow = val;
    if (typeof window !== 'undefined' && window.agentwatch && window.agentwatch.setSetting) {
      Promise.resolve(window.agentwatch.setSetting('allowTurnOnFromWindow', val)).then((res) => {
        if (!res || res.success) {
          showToast('Saved');
        } else {
          currentConfig.allowTurnOnFromWindow = !val;
          settingAllowTurnOn.checked = !val;
          showToast((res && res.error) ? `Error: ${res.error}` : 'Failed to save setting');
        }
      }).catch((err) => {
        currentConfig.allowTurnOnFromWindow = !val;
        settingAllowTurnOn.checked = !val;
        showToast(`Error: ${err.message || 'Failed to save setting'}`);
      });
    }
    // Update enabled/disabled state of Turn On buttons for all live session rows
    if (currentSessions && currentSessions.length > 0) {
      currentSessions.forEach(session => {
        const entry = rowCache.get(session.sessionKey);
        if (entry) updateRow(entry, session);
      });
    }
  });
}

if (settingUnlockBuiltinDeny) {
  settingUnlockBuiltinDeny.addEventListener('change', (e) => {
    const val = e.target.checked;
    currentConfig.unlockBuiltinDenyRules = val;
    if (typeof window !== 'undefined' && window.agentwatch && window.agentwatch.setSetting) {
      Promise.resolve(window.agentwatch.setSetting('unlockBuiltinDenyRules', val)).then((res) => {
        if (!res || res.success) {
          showToast('Saved');
        } else {
          currentConfig.unlockBuiltinDenyRules = !val;
          settingUnlockBuiltinDeny.checked = !val;
          showToast((res && res.error) ? `Error: ${res.error}` : 'Failed to save setting');
        }
      }).catch((err) => {
        currentConfig.unlockBuiltinDenyRules = !val;
        settingUnlockBuiltinDeny.checked = !val;
        showToast(`Error: ${err.message || 'Failed to save setting'}`);
      });
    }
    renderDenyList();
  });
}

// Log folder settings listeners
if (settingLogDirBrowseBtn) {
  settingLogDirBrowseBtn.addEventListener('click', async () => {
    if (window.agentwatch && window.agentwatch.pickLogFolder) {
      try {
        const res = await window.agentwatch.pickLogFolder();
        if (res && res.canceled) {
          return;
        }
        if (res && res.success) {
          if (res.logDir) {
            currentConfig.logDir = res.logDir;
          }
          updateSettingsTab();
          showToast('Saved');
        } else {
          showToast((res && res.error) ? `Error: ${res.error}` : 'Failed to save log folder');
        }
      } catch (err) {
        showToast(`Error: ${err.message || 'Failed to select folder'}`);
      }
    }
  });
}

if (settingLogDirDefaultBtn) {
  settingLogDirDefaultBtn.addEventListener('click', async () => {
    if (typeof window !== 'undefined' && window.agentwatch && window.agentwatch.setSetting) {
      try {
        const res = await window.agentwatch.setSetting('logDir', '');
        if (res && res.success) {
          currentConfig.logDir = '';
          updateSettingsTab();
          showToast('Saved');
        } else {
          showToast((res && res.error) ? `Error: ${res.error}` : 'Failed to clear log folder');
        }
      } catch (err) {
        showToast(`Error: ${err.message || 'Failed to clear log folder'}`);
      }
    }
  });
}

// Stage 6: Turn on confirmation modal listeners
if (turnOnStartInput && turnOnConfirmBtn) {
  turnOnStartInput.addEventListener('input', () => {
    turnOnConfirmBtn.disabled = (turnOnStartInput.value.trim() !== 'START');
  });
}

if (turnOnCancelBtn) {
  turnOnCancelBtn.addEventListener('click', () => {
    if (turnOnModal) turnOnModal.classList.add('hidden');
    turnOnTargetSession = null;
  });
}

if (turnOnConfirmBtn) {
  turnOnConfirmBtn.addEventListener('click', () => {
    if (!turnOnTargetSession || !turnOnTargetSession.sessionId) return;
    if (turnOnStartInput && turnOnStartInput.value.trim() !== 'START') return;

    const sess = turnOnTargetSession;
    if (window.agentwatch && window.agentwatch.setSessionAuto) {
      window.agentwatch.setSessionAuto({
        sessionId: sess.sessionId,
        state: 'on'
      }).then(res => {
        if (res && res.success) {
          showToast(`Auto-accept turned on for ${sess.folder || 'session'}`);
        }
      }).catch(() => {});
    }

    if (turnOnModal) turnOnModal.classList.add('hidden');
    turnOnTargetSession = null;
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

// Camera Notch & HUD event listeners
if (cameraNotchPill) {
  cameraNotchPill.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleNotchHud();
  });
  cameraNotchPill.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleNotchHud();
    } else if (e.key === 'Escape') {
      closeNotchHud();
    }
  });
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('click', (e) => {
    const zone = getEl('camera-notch-zone') || cameraNotchZone;
    const hud = getEl('notch-dropdown-hud') || notchDropdownHud;
    if (hud && hud.style.display !== 'none' && zone && !zone.contains(e.target)) {
      closeNotchHud();
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' || e.key === 'Esc') {
      closeNotchHud();
    }
  });
}

if (settingCameraNotch) {
  settingCameraNotch.addEventListener('change', (e) => {
    const val = e.target.checked;
    currentConfig.cameraNotch = val;
    if (typeof window !== 'undefined' && window.agentwatch && window.agentwatch.setSetting) {
      Promise.resolve(window.agentwatch.setSetting('cameraNotch', val)).then((res) => {
        if (!res || res.success) {
          showToast('Saved');
        } else {
          currentConfig.cameraNotch = !val;
          settingCameraNotch.checked = !val;
          showToast((res && res.error) ? `Error: ${res.error}` : 'Failed to save setting');
        }
      }).catch((err) => {
        currentConfig.cameraNotch = !val;
        settingCameraNotch.checked = !val;
        showToast(`Error: ${err.message || 'Failed to save setting'}`);
      });
    }
    updateCameraNotch(currentSessions, currentConfig);
  });
}

if (settingFloatingNotch) {
  settingFloatingNotch.addEventListener('change', (e) => {
    const val = e.target.checked;
    currentConfig.floatingNotch = val;
    if (typeof window !== 'undefined' && window.agentwatch && window.agentwatch.setSetting) {
      Promise.resolve(window.agentwatch.setSetting('floatingNotch', val)).then((res) => {
        if (!res || res.success) {
          showToast('Saved');
        } else {
          currentConfig.floatingNotch = !val;
          settingFloatingNotch.checked = !val;
          showToast((res && res.error) ? `Error: ${res.error}` : 'Failed to save setting');
        }
      }).catch((err) => {
        currentConfig.floatingNotch = !val;
        settingFloatingNotch.checked = !val;
        showToast(`Error: ${err.message || 'Failed to save setting'}`);
      });
    }
  });
}

// Setup IPC listeners in Electron environment
if (typeof window !== 'undefined' && window.agentwatch) {
  if (window.agentwatch.onUpdate) {
    window.agentwatch.onUpdate(render);
  }
  if (window.agentwatch.getState) {
    window.agentwatch.getState().then(render);
  }
  if (window.agentwatch.onJumpToAgent) {
    window.agentwatch.onJumpToAgent((data) => {
      if (data && data.sessionKey) {
        jumpToAgent(data.sessionKey);
        if (container) {
          const row = container.querySelector(`[data-session-key="${data.sessionKey}"]`);
          if (row) {
            row.classList.add('jump-highlight');
            setTimeout(() => row.classList.remove('jump-highlight'), 2500);
          }
        }
      }
    });
  }
}

// =============================================================
// RULES TAB CONTROLLER
// =============================================================

let savedRules = null;
let workingRules = null;
let rulesBackups = [];
let pendingLooseningSave = null;

// Rules Tab DOM Elements
const rulesUnsavedBadge = getEl('rules-unsaved-badge');
const rulesPersistBadge = getEl('rules-persist-badge');
const rulesSaveBtn = getEl('rules-save-btn');
const rulesDiscardBtn = getEl('rules-discard-btn');
const rulesRestoreBtn = getEl('rules-restore-btn');
const rulesResetDangerBtn = getEl('rules-reset-danger-btn');

// Option Rules Elements
const addOptionRuleBtn = getEl('add-option-rule-btn');
const optionRulesContainer = getEl('option-rules-container');

// Danger List Elements
const dangerListTbody = getEl('danger-list-tbody');
const newDangerText = getEl('new-danger-text');
const newDangerWord = getEl('new-danger-word');
const newDangerLevel = getEl('new-danger-level');
const newDangerDelay = getEl('new-danger-delay');
const addDangerBtn = getEl('add-danger-btn');

// Deny List Elements
const denyListContainer = getEl('deny-list-container');
const newDenyPattern = getEl('new-deny-pattern');
const addDenyBtn = getEl('add-deny-btn');

// Locked & Unlock Deny Modal Elements
const lockedDenyModal = getEl('locked-deny-modal');
const lockedDenyRuleName = getEl('locked-deny-rule-name');
const lockedDenyCloseBtn = getEl('locked-deny-close-btn');

const unlockDenyModal = getEl('unlock-deny-modal');
const unlockDenyEntryName = getEl('unlock-deny-entry-name');
const unlockDenyInput = getEl('unlock-deny-input');
const unlockDenyConfirmBtn = getEl('unlock-deny-confirm-btn');
const unlockDenyCancelBtn = getEl('unlock-deny-cancel-btn');

// Allow List Elements
const tier1AllowList = getEl('tier1-allow-list');
const tier2AllowList = getEl('tier2-allow-list');

// Try It Tester Elements
const samplePromptSelect = getEl('sample-prompt-select');
const testerCmd = getEl('tester-cmd');
const testerQuestion = getEl('tester-question');
const testerOptions = getEl('tester-options');
const testerEvalBtn = getEl('tester-eval-btn');
const testerDecisionBadge = getEl('tester-decision-badge');
const testerDecisionDetails = getEl('tester-decision-details');

// Modals
const looseningModal = getEl('loosening-modal');
const looseningItemsList = getEl('loosening-items-list');
const persistWarningBox = getEl('persist-warning-box');
const looseningWarningText = getEl('loosening-warning-text');
const looseningTypePrompt = getEl('loosening-type-prompt');
const looseningPersistInput = getEl('loosening-persist-input');
const looseningConfirmBtn = getEl('loosening-confirm-btn');
const looseningCancelBtn = getEl('loosening-cancel-btn');
let currentRequiredLooseningWord = null;

const restoreModal = getEl('restore-modal');
const restoreBackupSelect = getEl('restore-backup-select');
const restoreConfirmBtn = getEl('restore-confirm-btn');
const restoreCancelBtn = getEl('restore-cancel-btn');

/**
 * Generates a plain-language preview of an option rule.
 * Example: "Presses the option that starts with 'Yes, and always' for commands that start with 'git'"
 */
function generateRulePreview(rule) {
  if (!rule) return '';
  const starts = rule.startsWith ? `starts with "${rule.startsWith}"` : 'any text';
  const ends = rule.endsWith ? ` and ends with "${rule.endsWith}"` : '';
  let types = '';
  if (rule.promptTypes && Array.isArray(rule.promptTypes) && rule.promptTypes.length > 0) {
    const formattedTypes = rule.promptTypes.map(t => String(t).replace('_', ' ')).join(', ');
    types = ` for ${formattedTypes} prompts`;
  }
  const cmd = rule.commandStartsWith ? ` for commands that start with "${rule.commandStartsWith}"` : (types ? '' : ' for all commands');
  const persist = rule.allowPersist ? ' (allows persist)' : '';
  const trunc = rule.allowTruncatedCommand ? ' (allows truncated command)' : '';
  const disabled = rule.enabled === false ? ' [Disabled]' : '';
  return `Presses the option that ${starts}${ends}${types}${cmd}${persist}${trunc}${disabled}.`;
}

/**
 * Validates a single option rule draft, returning error message or null.
 */
function validateOptionRuleDraft(rule) {
  if (!rule) return 'Rule is undefined';
  if (!rule.name || rule.name.trim() === '') return 'Rule name cannot be empty';
  if (!rule.startsWith || rule.startsWith.trim().length < 3) return 'Starts with must be at least 3 characters';
  if (/^(?:no\b|cancel\b|abort\b|reject\b)/i.test(rule.startsWith.trim())) {
    return 'Cannot match "No" options';
  }
  if (rule.endsWith !== undefined && rule.endsWith.trim() === '') return 'Ends with cannot be empty';
  if (rule.commandStartsWith !== undefined && rule.commandStartsWith.trim() === '') return 'Command starts with cannot be empty';
  return null;
}

/**
 * Checks if working draft has unsaved changes compared to savedRules.
 */
function hasUnsavedChanges() {
  if (!savedRules || !workingRules) return false;
  return JSON.stringify(savedRules) !== JSON.stringify(workingRules);
}

/**
 * Checks all working rules for inline validation errors.
 */
function getWorkingRulesValidationErrors() {
  const errors = [];
  if (!workingRules) return errors;

  if (Array.isArray(workingRules.optionRules)) {
    workingRules.optionRules.forEach((rule, idx) => {
      const err = validateOptionRuleDraft(rule);
      if (err) errors.push(`Option rule #${idx + 1} (${rule.name || 'unnamed'}): ${err}`);
    });
  }

  if (Array.isArray(workingRules.danger)) {
    workingRules.danger.forEach((entry, idx) => {
      if (!entry.text || entry.text.trim().length < 2) {
        errors.push(`Danger entry #${idx + 1}: text must be at least 2 characters`);
      }
      if (entry.level === 'slow' && (typeof entry.delay !== 'number' || entry.delay <= 0)) {
        errors.push(`Danger entry #${idx + 1}: delay must be a positive number`);
      }
    });
  }

  return errors;
}

/**
 * Updates top action bar indicators (unsaved badge, persist allowed badge, save button disabled).
 */
function updateRulesTopBar() {
  const unsaved = hasUnsavedChanges();
  if (rulesUnsavedBadge) {
    rulesUnsavedBadge.classList.toggle('hidden', !unsaved);
  }

  const hasPersistAllowed = workingRules && Array.isArray(workingRules.optionRules) &&
    workingRules.optionRules.some(r => r && r.allowPersist === true);
  if (rulesPersistBadge) {
    rulesPersistBadge.classList.toggle('hidden', !hasPersistAllowed);
  }

  const errors = getWorkingRulesValidationErrors();
  if (rulesSaveBtn) {
    rulesSaveBtn.disabled = errors.length > 0;
    rulesSaveBtn.title = errors.length > 0 ? errors.join('\n') : (unsaved ? 'Save changes' : 'No unsaved changes');
  }
}

function refreshRulesFolderSelect() {
  if (!rulesTargetSelect || !window.agentwatch || !window.agentwatch.getRulesFolders) return;
  window.agentwatch.getRulesFolders().then(res => {
    if (!res || !res.success || !Array.isArray(res.folders)) return;
    const currentVal = rulesTargetSelect.value || currentRulesTarget || 'default';
    rulesTargetSelect.innerHTML = '';

    const defaultOpt = document.createElement('option');
    defaultOpt.value = 'default';
    defaultOpt.textContent = 'Default rules';
    rulesTargetSelect.appendChild(defaultOpt);

    for (const f of res.folders) {
      const opt = document.createElement('option');
      opt.value = f.folderKey;
      opt.textContent = `${f.agent} in ${f.folderName}`;
      rulesTargetSelect.appendChild(opt);
    }

    if (Array.from(rulesTargetSelect.options).some(o => o.value === currentVal)) {
      rulesTargetSelect.value = currentVal;
    } else {
      rulesTargetSelect.value = 'default';
      currentRulesTarget = 'default';
    }
  }).catch(() => {});
}

/**
 * Loads rules from the main process.
 */
function loadRulesView() {
  refreshRulesFolderSelect();
  if (!window.agentwatch) return;

  if (currentRulesTarget === 'default') {
    if (resetFolderRulesBtn) resetFolderRulesBtn.style.display = 'none';
    if (window.agentwatch.getRules) {
      window.agentwatch.getRules().then(res => {
        if (res && res.success) {
          savedRules = res.rules;
          workingRules = JSON.parse(JSON.stringify(res.rules));
          rulesBackups = res.backups || [];
          renderRulesView();
        }
      }).catch(() => {});
    }
  } else {
    if (window.agentwatch.getFolderRules) {
      window.agentwatch.getFolderRules(currentRulesTarget).then(res => {
        if (res && res.success) {
          currentTargetHasOwnRules = Boolean(res.hasOwnRules);
          if (resetFolderRulesBtn) {
            resetFolderRulesBtn.style.display = currentTargetHasOwnRules ? 'inline-block' : 'none';
          }
          savedRules = res.rules;
          workingRules = JSON.parse(JSON.stringify(res.rules));
          rulesBackups = res.backups || [];
          renderRulesView();
        }
      }).catch(() => {});
    }
  }
}

if (rulesTargetSelect) {
  rulesTargetSelect.addEventListener('change', () => {
    if (hasUnsavedChanges()) {
      const ok = window.confirm('You have unsaved changes. Discard them and switch rules view?');
      if (!ok) {
        rulesTargetSelect.value = currentRulesTarget;
        return;
      }
    }
    currentRulesTarget = rulesTargetSelect.value;
    loadRulesView();
  });
}

if (resetFolderRulesBtn) {
  resetFolderRulesBtn.addEventListener('click', () => {
    if (currentRulesTarget === 'default') return;
    const ok = window.confirm('Reset this folder to default rules? This will delete this folder\'s custom rule list.');
    if (!ok) return;

    if (window.agentwatch && window.agentwatch.deleteFolderRules) {
      window.agentwatch.deleteFolderRules(currentRulesTarget).then(res => {
        if (res && res.success) {
          currentTargetHasOwnRules = false;
          if (resetFolderRulesBtn) resetFolderRulesBtn.style.display = 'none';
          loadRulesView();
        } else {
          alert(`Error resetting folder rules: ${res ? res.error : 'Unknown error'}`);
        }
      });
    }
  });
}

/**
 * Renders the entire Rules tab.
 */
function renderRulesView() {
  if (!workingRules) return;
  renderOptionRules();
  renderDangerList();
  renderDenyList();
  renderAllowList();
  updateRulesTopBar();
}

/**
 * Renders the ordered Option Rules list with drag-to-reorder, inputs, and preview.
 */
function renderOptionRules() {
  if (!optionRulesContainer || !workingRules) return;
  optionRulesContainer.innerHTML = '';

  const rules = workingRules.optionRules || [];
  if (rules.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-rules-msg';
    empty.textContent = 'No option rules configured. Click "+ Add Option Rule" to create one.';
    optionRulesContainer.appendChild(empty);
    return;
  }

  rules.forEach((rule, index) => {
    const card = document.createElement('div');
    card.className = `option-rule-item ${rule.enabled === false ? 'disabled' : ''}`;
    card.draggable = true;
    card.dataset.index = String(index);

    // Header
    const header = document.createElement('div');
    header.className = 'option-rule-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'rule-header-left';

    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.innerHTML = '⋮⋮';
    dragHandle.title = 'Drag to reorder priority';

    const priorityPill = document.createElement('span');
    priorityPill.className = 'priority-pill';
    priorityPill.textContent = `#${index + 1}`;

    const enabledCheckbox = document.createElement('input');
    enabledCheckbox.type = 'checkbox';
    enabledCheckbox.checked = rule.enabled !== false;
    enabledCheckbox.title = 'Toggle rule enabled';
    enabledCheckbox.addEventListener('change', () => {
      rule.enabled = enabledCheckbox.checked;
      renderRulesView();
    });

    const nameTitle = document.createElement('span');
    nameTitle.className = 'rule-name-title';
    nameTitle.textContent = rule.name || 'Unnamed Rule';

    headerLeft.appendChild(dragHandle);
    headerLeft.appendChild(priorityPill);
    headerLeft.appendChild(enabledCheckbox);
    headerLeft.appendChild(nameTitle);

    const headerRight = document.createElement('div');
    headerRight.className = 'rule-header-right';

    // Move up button
    if (index > 0) {
      const upBtn = document.createElement('button');
      upBtn.type = 'button';
      upBtn.className = 'btn btn-secondary btn-sm';
      upBtn.textContent = '↑';
      upBtn.title = 'Move higher priority';
      upBtn.addEventListener('click', () => {
        const temp = workingRules.optionRules[index];
        workingRules.optionRules[index] = workingRules.optionRules[index - 1];
        workingRules.optionRules[index - 1] = temp;
        renderRulesView();
      });
      headerRight.appendChild(upBtn);
    }

    // Move down button
    if (index < rules.length - 1) {
      const downBtn = document.createElement('button');
      downBtn.type = 'button';
      downBtn.className = 'btn btn-secondary btn-sm';
      downBtn.textContent = '↓';
      downBtn.title = 'Move lower priority';
      downBtn.addEventListener('click', () => {
        const temp = workingRules.optionRules[index];
        workingRules.optionRules[index] = workingRules.optionRules[index + 1];
        workingRules.optionRules[index + 1] = temp;
        renderRulesView();
      });
      headerRight.appendChild(downBtn);
    }

    // Delete button
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn btn-danger btn-sm';
    deleteBtn.textContent = 'Delete';
    deleteBtn.addEventListener('click', () => {
      workingRules.optionRules.splice(index, 1);
      renderRulesView();
    });
    headerRight.appendChild(deleteBtn);

    header.appendChild(headerLeft);
    header.appendChild(headerRight);
    card.appendChild(header);

    // Plain-language preview
    const previewEl = document.createElement('div');
    previewEl.className = 'rule-preview';
    previewEl.textContent = generateRulePreview(rule);
    card.appendChild(previewEl);

    // Inline error message container
    const errorEl = document.createElement('div');
    errorEl.className = 'rule-error-msg';
    const errorMsg = validateOptionRuleDraft(rule);
    if (errorMsg) {
      errorEl.textContent = errorMsg;
    }
    card.appendChild(errorEl);

    // Fields Grid
    const fieldsGrid = document.createElement('div');
    fieldsGrid.className = 'rule-fields-grid';

    // Name field
    const nameGroup = document.createElement('div');
    nameGroup.className = 'form-group';
    const nameLabel = document.createElement('label');
    nameLabel.className = 'form-label';
    nameLabel.textContent = 'Rule Name:';
    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.className = 'form-input';
    nameInput.value = rule.name || '';
    nameInput.addEventListener('input', () => {
      rule.name = nameInput.value;
      nameTitle.textContent = rule.name || 'Unnamed Rule';
      previewEl.textContent = generateRulePreview(rule);
      const err = validateOptionRuleDraft(rule);
      errorEl.textContent = err || '';
      updateRulesTopBar();
    });
    nameGroup.appendChild(nameLabel);
    nameGroup.appendChild(nameInput);
    fieldsGrid.appendChild(nameGroup);

    // Starts with field
    const startsGroup = document.createElement('div');
    startsGroup.className = 'form-group';
    const startsLabel = document.createElement('label');
    startsLabel.className = 'form-label';
    startsLabel.textContent = 'Starts with (min 3 chars):';
    const startsInput = document.createElement('input');
    startsInput.type = 'text';
    startsInput.className = 'form-input';
    startsInput.value = rule.startsWith || '';
    startsInput.addEventListener('input', () => {
      rule.startsWith = startsInput.value;
      previewEl.textContent = generateRulePreview(rule);
      const err = validateOptionRuleDraft(rule);
      errorEl.textContent = err || '';
      updateRulesTopBar();
    });
    startsGroup.appendChild(startsLabel);
    startsGroup.appendChild(startsInput);
    fieldsGrid.appendChild(startsGroup);

    // Ends with field
    const endsGroup = document.createElement('div');
    endsGroup.className = 'form-group';
    const endsLabel = document.createElement('label');
    endsLabel.className = 'form-label';
    endsLabel.textContent = 'Ends with (optional):';
    const endsInput = document.createElement('input');
    endsInput.type = 'text';
    endsInput.className = 'form-input';
    endsInput.value = rule.endsWith || '';
    endsInput.placeholder = 'None';
    endsInput.addEventListener('input', () => {
      rule.endsWith = endsInput.value.trim() !== '' ? endsInput.value : undefined;
      previewEl.textContent = generateRulePreview(rule);
      const err = validateOptionRuleDraft(rule);
      errorEl.textContent = err || '';
      updateRulesTopBar();
    });
    endsGroup.appendChild(endsLabel);
    endsGroup.appendChild(endsInput);
    fieldsGrid.appendChild(endsGroup);

    // Advanced section (contains optional commandStartsWith)
    const advDetails = document.createElement('details');
    advDetails.className = 'advanced-section';
    advDetails.style.gridColumn = '1 / -1';
    advDetails.style.marginTop = '4px';
    const advSummary = document.createElement('summary');
    advSummary.textContent = 'Advanced';
    advSummary.style.cursor = 'pointer';
    advSummary.style.fontSize = '12px';
    advSummary.style.color = 'var(--color-text-muted, #94a3b8)';
    advDetails.appendChild(advSummary);

    // Command starts with field (optional, under Advanced)
    const cmdGroup = document.createElement('div');
    cmdGroup.className = 'form-group';
    cmdGroup.style.marginTop = '8px';
    const cmdLabel = document.createElement('label');
    cmdLabel.className = 'form-label';
    cmdLabel.textContent = 'Only for commands starting with (optional):';
    const cmdInput = document.createElement('input');
    cmdInput.type = 'text';
    cmdInput.className = 'form-input';
    cmdInput.value = rule.commandStartsWith || '';
    cmdInput.placeholder = 'Any command (empty by default)';
    cmdInput.addEventListener('input', () => {
      rule.commandStartsWith = cmdInput.value.trim() !== '' ? cmdInput.value : undefined;
      previewEl.textContent = generateRulePreview(rule);
      const err = validateOptionRuleDraft(rule);
      errorEl.textContent = err || '';
      updateRulesTopBar();
    });
    cmdGroup.appendChild(cmdLabel);
    cmdGroup.appendChild(cmdInput);
    advDetails.appendChild(cmdGroup);

    // Allow Truncated Command field (optional, under Advanced)
    const truncGroup = document.createElement('div');
    truncGroup.className = 'form-group';
    truncGroup.style.marginTop = '8px';

    const truncLabel = document.createElement('label');
    truncLabel.className = 'checkbox-label';
    truncLabel.style.display = 'flex';
    truncLabel.style.alignItems = 'center';
    truncLabel.style.gap = '6px';
    truncLabel.style.cursor = 'pointer';

    const truncCheckbox = document.createElement('input');
    truncCheckbox.type = 'checkbox';
    truncCheckbox.checked = Boolean(rule.allowTruncatedCommand);
    truncCheckbox.addEventListener('change', () => {
      rule.allowTruncatedCommand = truncCheckbox.checked;
      previewEl.textContent = generateRulePreview(rule);
      updateRulesTopBar();
    });

    const truncText = document.createElement('span');
    truncText.textContent = 'Allow Truncated Command';
    truncText.style.fontWeight = '500';

    truncLabel.appendChild(truncCheckbox);
    truncLabel.appendChild(truncText);
    truncGroup.appendChild(truncLabel);

    const truncDesc = document.createElement('p');
    truncDesc.className = 'field-help-text';
    truncDesc.style.fontSize = '11px';
    truncDesc.style.color = 'var(--color-text-muted, #94a3b8)';
    truncDesc.style.margin = '2px 0 0 20px';
    truncDesc.textContent = 'Apply this rule even if the command text was cut off on screen and cannot be fully checked.';
    truncGroup.appendChild(truncDesc);

    advDetails.appendChild(truncGroup);

    if (rule.commandStartsWith || rule.allowTruncatedCommand) {
      advDetails.open = true;
    }
    fieldsGrid.appendChild(advDetails);

    // Prompt types field
    const ptGroup = document.createElement('div');
    ptGroup.className = 'form-group';
    const ptLabel = document.createElement('label');
    ptLabel.className = 'form-label';
    ptLabel.textContent = 'Prompt types (comma-separated, default all):';
    const ptInput = document.createElement('input');
    ptInput.type = 'text';
    ptInput.className = 'form-input';
    ptInput.value = Array.isArray(rule.promptTypes) ? rule.promptTypes.join(', ') : (rule.promptTypes || '');
    ptInput.placeholder = 'All types (default)';
    ptInput.addEventListener('input', () => {
      const val = ptInput.value.trim();
      rule.promptTypes = val ? val.split(',').map(s => s.trim()).filter(Boolean) : undefined;
      previewEl.textContent = generateRulePreview(rule);
      const err = validateOptionRuleDraft(rule);
      errorEl.textContent = err || '';
      updateRulesTopBar();
    });
    ptGroup.appendChild(ptLabel);
    ptGroup.appendChild(ptInput);
    fieldsGrid.appendChild(ptGroup);

    // Allow persist checkbox
    const persistGroup = document.createElement('div');
    persistGroup.className = 'form-group';
    persistGroup.style.justifyContent = 'flex-end';
    const persistLabel = document.createElement('label');
    persistLabel.className = 'checkbox-inline';
    const persistCheckbox = document.createElement('input');
    persistCheckbox.type = 'checkbox';
    persistCheckbox.checked = Boolean(rule.allowPersist);
    persistCheckbox.addEventListener('change', () => {
      rule.allowPersist = persistCheckbox.checked;
      previewEl.textContent = generateRulePreview(rule);
      updateRulesTopBar();
    });
    persistLabel.appendChild(persistCheckbox);
    persistLabel.appendChild(document.createTextNode(' Allow Persist'));
    persistGroup.appendChild(persistLabel);
    fieldsGrid.appendChild(persistGroup);

    card.appendChild(fieldsGrid);

    // Drag and drop event listeners
    card.addEventListener('dragstart', (e) => {
      if (e.dataTransfer && e.dataTransfer.setData) {
        e.dataTransfer.setData('text/plain', String(index));
      }
      card.classList.add('dragging');
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromData = e.dataTransfer ? e.dataTransfer.getData('text/plain') : null;
      const fromIndex = parseInt(fromData, 10);
      const toIndex = index;
      if (!isNaN(fromIndex) && fromIndex !== toIndex && fromIndex >= 0 && fromIndex < rules.length) {
        const movedRule = workingRules.optionRules.splice(fromIndex, 1)[0];
        workingRules.optionRules.splice(toIndex, 0, movedRule);
        renderRulesView();
      }
    });

    optionRulesContainer.appendChild(card);
  });
}

/**
 * Renders the danger list table.
 */
function renderDangerList() {
  if (!dangerListTbody || !workingRules) return;
  dangerListTbody.innerHTML = '';

  const danger = workingRules.danger || [];
  danger.forEach((entry, index) => {
    const tr = document.createElement('tr');

    // Pattern Text
    const tdText = document.createElement('td');
    tdText.textContent = entry.text;
    tr.appendChild(tdText);

    // Whole Word checkbox
    const tdWord = document.createElement('td');
    const wordCb = document.createElement('input');
    wordCb.type = 'checkbox';
    wordCb.checked = Boolean(entry.wholeWord);
    wordCb.addEventListener('change', () => {
      entry.wholeWord = wordCb.checked;
      updateRulesTopBar();
    });
    tdWord.appendChild(wordCb);
    tr.appendChild(tdWord);

    // Level select
    const tdLevel = document.createElement('td');
    const levelSelect = document.createElement('select');
    levelSelect.className = 'form-select form-select-sm';
    const optHard = document.createElement('option');
    optHard.value = 'hard';
    optHard.textContent = 'Hard stop';
    const optSlow = document.createElement('option');
    optSlow.value = 'slow';
    optSlow.textContent = 'Slow down';
    levelSelect.appendChild(optHard);
    levelSelect.appendChild(optSlow);
    levelSelect.value = entry.level === 'slow' ? 'slow' : 'hard';
    tdLevel.appendChild(levelSelect);
    tr.appendChild(tdLevel);

    // Delay
    const tdDelay = document.createElement('td');
    const delayInput = document.createElement('input');
    delayInput.type = 'number';
    delayInput.min = '1';
    delayInput.max = '60';
    delayInput.className = 'form-input form-input-sm delay-input';
    delayInput.value = entry.delay || 5;
    delayInput.disabled = entry.level !== 'slow';
    delayInput.addEventListener('input', () => {
      const val = parseFloat(delayInput.value);
      if (!isNaN(val) && val > 0) {
        entry.delay = val;
      }
      updateRulesTopBar();
    });
    levelSelect.addEventListener('change', () => {
      entry.level = levelSelect.value;
      delayInput.disabled = entry.level !== 'slow';
      if (entry.level === 'slow' && !entry.delay) {
        entry.delay = 5;
      }
      updateRulesTopBar();
    });
    tdDelay.appendChild(delayInput);
    tr.appendChild(tdDelay);

    // Remove action
    const tdAction = document.createElement('td');
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn btn-danger btn-sm';
    removeBtn.textContent = 'Remove';
    removeBtn.addEventListener('click', () => {
      workingRules.danger.splice(index, 1);
      renderDangerList();
      updateRulesTopBar();
    });
    tdAction.appendChild(removeBtn);
    tr.appendChild(tdAction);

    dangerListTbody.appendChild(tr);
  });
}

const BUILTIN_DENY_PATTERNS = new Set([
  'rm -rf',
  'rmdir /s',
  'del /f',
  'Remove-Item -Recurse',
  'format',
  'git push --force',
  'git reset --hard',
  'curl.*\\|.*(?:sh|bash|zsh|powershell|cmd|pwsh)',
  'wget.*\\|.*(?:sh|bash|zsh|powershell|cmd|pwsh)',
  'powershell -enc',
  'sudo',
  'chmod 777',
  '.env',
  'settings.json',
  '.ssh',
  'credentials'
].map(s => s.toLowerCase()));

function isBuiltinDenyRule(pattern) {
  if (!pattern || typeof pattern !== 'string') return false;
  return BUILTIN_DENY_PATTERNS.has(pattern.trim().toLowerCase());
}

function getLockedDenyExplanation(pattern) {
  return `Built-in deny rule "${pattern}" is locked to protect against critical or destructive operations. If it is too broad, the entry can be switched to whole-word matching or a narrow allow rule can be added for a specific command. To remove or edit built-in deny rules, turn on "Unlock built-in deny rules" in Settings.`;
}

let pendingUnlockEntryIndex = -1;
let pendingUnlockEntryPattern = '';

function showLockedDenyDialog(pattern) {
  const nameEl = lockedDenyRuleName || getEl('locked-deny-rule-name');
  if (nameEl) nameEl.textContent = `"${pattern}"`;
  const modalEl = lockedDenyModal || getEl('locked-deny-modal');
  if (modalEl) {
    modalEl.classList.remove('hidden');
  } else if (typeof alert === 'function') {
    alert(getLockedDenyExplanation(pattern));
  }
}

if (lockedDenyCloseBtn && lockedDenyModal) {
  lockedDenyCloseBtn.addEventListener('click', () => {
    lockedDenyModal.classList.add('hidden');
  });
}

function showUnlockConfirmationDialog(pattern, index) {
  pendingUnlockEntryIndex = index;
  pendingUnlockEntryPattern = pattern;
  const nameEl = unlockDenyEntryName || getEl('unlock-deny-entry-name');
  if (nameEl) nameEl.textContent = `"${pattern}"`;
  const inputEl = unlockDenyInput || getEl('unlock-deny-input');
  if (inputEl) {
    inputEl.value = '';
  }
  const btnEl = unlockDenyConfirmBtn || getEl('unlock-deny-confirm-btn');
  if (btnEl) {
    btnEl.disabled = true;
  }
  const modalEl = unlockDenyModal || getEl('unlock-deny-modal');
  if (modalEl) {
    modalEl.classList.remove('hidden');
    if (inputEl && typeof inputEl.focus === 'function') {
      inputEl.focus();
    }
  }
}

if (unlockDenyInput && unlockDenyConfirmBtn) {
  unlockDenyInput.addEventListener('input', () => {
    unlockDenyConfirmBtn.disabled = (unlockDenyInput.value.trim() !== 'UNLOCK');
  });
}

if (unlockDenyConfirmBtn) {
  unlockDenyConfirmBtn.addEventListener('click', () => {
    if (!unlockDenyInput || unlockDenyInput.value.trim() !== 'UNLOCK') return;
    if (pendingUnlockEntryIndex >= 0 && workingRules && Array.isArray(workingRules.deny)) {
      const removed = workingRules.deny.splice(pendingUnlockEntryIndex, 1)[0];
      if (unlockDenyModal) unlockDenyModal.classList.add('hidden');
      pendingUnlockEntryIndex = -1;
      pendingUnlockEntryPattern = '';
      renderDenyList();
      updateRulesTopBar();
      if (typeof window !== 'undefined' && window.agentwatch && window.agentwatch.logRuleChange) {
        window.agentwatch.logRuleChange(`Removed built-in deny rule "${removed}" (unlocked)`);
      }
    }
  });
}

if (unlockDenyCancelBtn && unlockDenyModal) {
  unlockDenyCancelBtn.addEventListener('click', () => {
    unlockDenyModal.classList.add('hidden');
    pendingUnlockEntryIndex = -1;
    pendingUnlockEntryPattern = '';
  });
}

/**
 * Renders the deny list tags.
 */
function renderDenyList() {
  if (!denyListContainer || !workingRules) return;
  denyListContainer.innerHTML = '';

  const deny = workingRules.deny || [];

  deny.forEach((pattern, index) => {
    const isBuiltin = isBuiltinDenyRule(pattern);
    const tag = document.createElement('span');
    tag.className = isBuiltin ? 'deny-tag builtin' : 'deny-tag';

    if (isBuiltin) {
      const lockIcon = document.createElement('span');
      lockIcon.className = 'lock-badge';
      lockIcon.textContent = '🔒';
      lockIcon.title = currentConfig.unlockBuiltinDenyRules ? 'Built-in deny rule (unlocked in settings)' : 'Built-in deny rule (locked)';
      tag.appendChild(lockIcon);
    }

    const textSpan = document.createElement('span');
    textSpan.textContent = pattern;
    tag.appendChild(textSpan);

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'btn btn-danger btn-sm';
    delBtn.style.padding = '1px 4px';
    delBtn.style.fontSize = '10px';
    delBtn.textContent = '✕';
    delBtn.title = isBuiltin
      ? (currentConfig.unlockBuiltinDenyRules ? 'Remove built-in deny entry (requires UNLOCK)' : 'Locked built-in deny entry')
      : 'Remove deny entry';

    delBtn.addEventListener('click', () => {
      if (isBuiltin) {
        if (!currentConfig.unlockBuiltinDenyRules) {
          showLockedDenyDialog(pattern);
          return;
        }
        showUnlockConfirmationDialog(pattern, index);
        return;
      }
      workingRules.deny.splice(index, 1);
      renderDenyList();
      updateRulesTopBar();
    });
    tag.appendChild(delBtn);

    denyListContainer.appendChild(tag);
  });
}

/**
 * Renders the command allow list (Tier 1 read-only, Tier 2 toggles).
 */
function renderAllowList() {
  if (!workingRules) return;
  const allow = workingRules.allow || [];

  const tier1Names = new Set(['git-readonly', 'file-list', 'version-check', 'echo-safe']);
  const tier1Rules = allow.filter(r => tier1Names.has(r.name));
  const tier2Rules = allow.filter(r => !tier1Names.has(r.name));

  if (tier1AllowList) {
    tier1AllowList.innerHTML = '';
    tier1Rules.forEach(r => {
      const item = document.createElement('div');
      item.className = 'allow-rule-item';

      const left = document.createElement('div');
      const name = document.createElement('span');
      name.className = 'allow-rule-name';
      name.textContent = r.name;
      const pattern = document.createElement('span');
      pattern.className = 'allow-rule-pattern';
      pattern.textContent = r.pattern;
      left.appendChild(name);
      left.appendChild(pattern);

      const right = document.createElement('div');
      const delayBadge = document.createElement('span');
      delayBadge.className = 'priority-pill';
      delayBadge.textContent = `${r.delay || 3}s delay (read-only)`;
      right.appendChild(delayBadge);

      item.appendChild(left);
      item.appendChild(right);
      tier1AllowList.appendChild(item);
    });
  }

  if (tier2AllowList) {
    tier2AllowList.innerHTML = '';
    tier2Rules.forEach(r => {
      const item = document.createElement('div');
      item.className = 'allow-rule-item';

      const left = document.createElement('div');
      const name = document.createElement('span');
      name.className = 'allow-rule-name';
      name.textContent = r.name;
      const pattern = document.createElement('span');
      pattern.className = 'allow-rule-pattern';
      pattern.textContent = r.pattern;
      left.appendChild(name);
      left.appendChild(pattern);

      const right = document.createElement('div');
      const toggleLabel = document.createElement('label');
      toggleLabel.className = 'checkbox-inline';
      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = r.enabled === true;
      toggle.addEventListener('change', () => {
        r.enabled = toggle.checked;
        updateRulesTopBar();
      });
      toggleLabel.appendChild(toggle);
      toggleLabel.appendChild(document.createTextNode(toggle.checked ? ' Enabled' : ' Disabled'));
      right.appendChild(toggleLabel);

      item.appendChild(left);
      item.appendChild(right);
      tier2AllowList.appendChild(item);
    });
  }
}

// Attach event listeners for buttons in Rules tab
if (addOptionRuleBtn) {
  addOptionRuleBtn.addEventListener('click', () => {
    if (!workingRules) return;
    if (!workingRules.optionRules) workingRules.optionRules = [];
    const count = workingRules.optionRules.length + 1;
    workingRules.optionRules.push({
      name: `custom-rule-${count}`,
      startsWith: 'Yes, allow',
      commandStartsWith: '',
      allowPersist: false,
      allowTruncatedCommand: false,
      enabled: true
    });
    renderRulesView();
  });
}

if (addDangerBtn && newDangerText) {
  addDangerBtn.addEventListener('click', () => {
    const text = (newDangerText.value || '').trim();
    if (text.length < 2) {
      alert('Danger text must be at least 2 characters');
      return;
    }
    const isWholeWord = newDangerWord ? newDangerWord.checked : false;
    const level = newDangerLevel ? newDangerLevel.value : 'hard';
    const delay = newDangerDelay ? parseFloat(newDangerDelay.value) || 5 : 5;

    if (!workingRules.danger) workingRules.danger = [];
    workingRules.danger.push({
      text,
      wholeWord: isWholeWord,
      level,
      delay,
      enabled: true
    });

    newDangerText.value = '';
    renderDangerList();
    updateRulesTopBar();
  });

  if (newDangerLevel && newDangerDelay) {
    newDangerLevel.addEventListener('change', () => {
      newDangerDelay.style.display = newDangerLevel.value === 'slow' ? 'inline-block' : 'none';
    });
  }
}

if (addDenyBtn && newDenyPattern) {
  addDenyBtn.addEventListener('click', () => {
    const pattern = (newDenyPattern.value || '').trim();
    if (pattern.length < 2) {
      alert('Deny pattern must be at least 2 characters');
      return;
    }
    if (!workingRules.deny) workingRules.deny = [];
    workingRules.deny.push(pattern);
    newDenyPattern.value = '';
    renderDenyList();
    updateRulesTopBar();
  });
}

if (rulesDiscardBtn) {
  rulesDiscardBtn.addEventListener('click', () => {
    if (!savedRules) return;
    workingRules = JSON.parse(JSON.stringify(savedRules));
    renderRulesView();
  });
}

if (rulesSaveBtn) {
  rulesSaveBtn.addEventListener('click', () => {
    if (!workingRules) return;
    const errors = getWorkingRulesValidationErrors();
    if (errors.length > 0) {
      alert(`Cannot save rules due to errors:\n${errors.join('\n')}`);
      return;
    }

    if (currentRulesTarget === 'default') {
      if (window.agentwatch && window.agentwatch.saveRules) {
        window.agentwatch.saveRules({ rules: workingRules, confirmedLoosening: false }).then(res => {
          if (!res) return;
          if (res.needsConfirmation) {
            // Open loosening confirmation modal!
            pendingLooseningSave = workingRules;
            openLooseningModal(res.loosening);
          } else if (res.success) {
            savedRules = res.rules;
            workingRules = JSON.parse(JSON.stringify(res.rules));
            rulesBackups = res.backups || [];
            renderRulesView();
          } else {
            alert(`Error saving rules: ${res.error || (res.errors && res.errors.join(', '))}`);
          }
        });
      }
    } else {
      if (window.agentwatch && window.agentwatch.saveFolderRules) {
        window.agentwatch.saveFolderRules({
          folderKey: currentRulesTarget,
          rules: workingRules,
          confirmedLoosening: false
        }).then(res => {
          if (!res) return;
          if (res.needsConfirmation) {
            // Open loosening confirmation modal!
            pendingLooseningSave = workingRules;
            openLooseningModal(res.loosening);
          } else if (res.success) {
            savedRules = res.rules;
            workingRules = JSON.parse(JSON.stringify(res.rules));
            rulesBackups = res.backups || [];
            currentTargetHasOwnRules = true;
            if (resetFolderRulesBtn) resetFolderRulesBtn.style.display = 'inline-block';
            renderRulesView();
          } else {
            alert(`Error saving folder rules: ${res.error || (res.errors && res.errors.join(', '))}`);
          }
        });
      }
    }
  });
}

function openLooseningModal(loosening) {
  if (!looseningModal || !looseningItemsList) return;
  looseningItemsList.innerHTML = '';
  (loosening.items || []).forEach(item => {
    const li = document.createElement('li');
    li.textContent = item;
    looseningItemsList.appendChild(li);
  });

  const requiredWord = loosening.requiredWord || (loosening.requiresPersistConfirmation ? 'PERSIST' : (loosening.requiresTruncatedConfirmation ? 'TRUNCATED' : null));
  currentRequiredLooseningWord = requiredWord;

  if (requiredWord) {
    if (persistWarningBox) persistWarningBox.classList.remove('hidden');
    if (looseningWarningText) {
      if (requiredWord === 'TRUNCATED') {
        looseningWarningText.innerHTML = '<strong>Warning:</strong> One or more rules allow truncated commands that cannot be fully verified.';
      } else {
        looseningWarningText.innerHTML = '<strong>Warning:</strong> One or more rules allow persisting permissions or match persist options.';
      }
    }
    if (looseningTypePrompt) {
      looseningTypePrompt.innerHTML = `To confirm, type <strong>${requiredWord}</strong> below:`;
    }
    if (looseningPersistInput) {
      looseningPersistInput.value = '';
      looseningPersistInput.placeholder = `Type ${requiredWord} to confirm`;
      looseningPersistInput.focus();
    }
    if (looseningConfirmBtn) {
      looseningConfirmBtn.disabled = true;
    }
  } else {
    if (persistWarningBox) persistWarningBox.classList.add('hidden');
    if (looseningConfirmBtn) {
      looseningConfirmBtn.disabled = false;
    }
  }

  looseningModal.classList.remove('hidden');
}

if (looseningPersistInput && looseningConfirmBtn) {
  looseningPersistInput.addEventListener('input', () => {
    if (!currentRequiredLooseningWord) {
      looseningConfirmBtn.disabled = false;
      return;
    }
    looseningConfirmBtn.disabled = looseningPersistInput.value.trim() !== currentRequiredLooseningWord;
  });
}

if (looseningConfirmBtn) {
  looseningConfirmBtn.addEventListener('click', () => {
    if (!pendingLooseningSave) return;
    if (currentRulesTarget === 'default') {
      if (window.agentwatch && window.agentwatch.saveRules) {
        window.agentwatch.saveRules({ rules: pendingLooseningSave, confirmedLoosening: true }).then(res => {
          if (res && res.success) {
            savedRules = res.rules;
            workingRules = JSON.parse(JSON.stringify(res.rules));
            rulesBackups = res.backups || [];
            if (looseningModal) looseningModal.classList.add('hidden');
            pendingLooseningSave = null;
            currentRequiredLooseningWord = null;
            renderRulesView();
          } else {
            alert(`Error saving rules: ${res ? res.error : 'Unknown error'}`);
          }
        });
      }
    } else {
      if (window.agentwatch && window.agentwatch.saveFolderRules) {
        window.agentwatch.saveFolderRules({
          folderKey: currentRulesTarget,
          rules: pendingLooseningSave,
          confirmedLoosening: true
        }).then(res => {
          if (res && res.success) {
            savedRules = res.rules;
            workingRules = JSON.parse(JSON.stringify(res.rules));
            rulesBackups = res.backups || [];
            currentTargetHasOwnRules = true;
            if (resetFolderRulesBtn) resetFolderRulesBtn.style.display = 'inline-block';
            if (looseningModal) looseningModal.classList.add('hidden');
            pendingLooseningSave = null;
            currentRequiredLooseningWord = null;
            renderRulesView();
          } else {
            alert(`Error saving folder rules: ${res ? res.error : 'Unknown error'}`);
          }
        });
      }
    }
  });
}

if (looseningCancelBtn && looseningModal) {
  looseningCancelBtn.addEventListener('click', () => {
    looseningModal.classList.add('hidden');
    pendingLooseningSave = null;
    currentRequiredLooseningWord = null;
  });
}

// Restore Modal
if (rulesRestoreBtn && restoreModal && restoreBackupSelect) {
  rulesRestoreBtn.addEventListener('click', () => {
    restoreBackupSelect.innerHTML = '';
    if (rulesBackups.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = 'No previous backups found';
      opt.disabled = true;
      restoreBackupSelect.appendChild(opt);
    } else {
      rulesBackups.forEach(b => {
        const opt = document.createElement('option');
        opt.value = b.name;
        opt.textContent = `${b.name} (${formatDisplayTime(b.time, currentConfig.timeFormat)})`;
        restoreBackupSelect.appendChild(opt);
      });
    }
    restoreModal.classList.remove('hidden');
  });
}

if (restoreConfirmBtn && restoreBackupSelect) {
  restoreConfirmBtn.addEventListener('click', () => {
    const selectedBackup = restoreBackupSelect.value;
    if (!selectedBackup) return;
    if (window.agentwatch && window.agentwatch.restoreRules) {
      window.agentwatch.restoreRules(selectedBackup).then(res => {
        if (res && res.success) {
          savedRules = res.rules;
          workingRules = JSON.parse(JSON.stringify(res.rules));
          rulesBackups = res.backups || [];
          if (restoreModal) restoreModal.classList.add('hidden');
          renderRulesView();
        } else {
          alert(`Error restoring backup: ${res ? res.error : 'Unknown error'}`);
        }
      });
    }
  });
}

if (restoreCancelBtn && restoreModal) {
  restoreCancelBtn.addEventListener('click', () => {
    restoreModal.classList.add('hidden');
  });
}

if (rulesResetDangerBtn) {
  rulesResetDangerBtn.addEventListener('click', () => {
    const ok = window.confirm('Reset danger list to factory defaults?');
    if (!ok) return;
    if (window.agentwatch && window.agentwatch.resetDangerRules) {
      window.agentwatch.resetDangerRules().then(res => {
        if (res && res.success) {
          savedRules = res.rules;
          workingRules = JSON.parse(JSON.stringify(res.rules));
          rulesBackups = res.backups || [];
          renderRulesView();
        }
      });
    }
  });
}

const rulesResetDenyBtn = getEl('rules-reset-deny-btn');
if (rulesResetDenyBtn) {
  rulesResetDenyBtn.addEventListener('click', () => {
    if (!workingRules) return;
    const ok = window.confirm('Reset deny list to factory defaults?');
    if (!ok) return;
    workingRules.deny = [
      'rm -rf', 'rmdir /s', 'del /f', 'Remove-Item -Recurse', 'format',
      'git push --force', 'git reset --hard',
      'curl.*\\|.*(?:sh|bash|zsh|powershell|cmd|pwsh)',
      'wget.*\\|.*(?:sh|bash|zsh|powershell|cmd|pwsh)',
      'powershell -enc', 'sudo', 'chmod 777', '.env', 'settings.json', '.ssh', 'credentials'
    ];
    renderDenyList();
    updateRulesTopBar();
  });
}

const rulesResetAllBtn = getEl('rules-reset-all-btn');
if (rulesResetAllBtn) {
  rulesResetAllBtn.addEventListener('click', () => {
    if (!workingRules) return;
    const ok = window.confirm('Restore all rules to factory defaults? This will restore default deny, danger, allow, and option rules.');
    if (!ok) return;
    workingRules.defaultDelaySeconds = 3;
    workingRules.deny = [
      'rm -rf', 'rmdir /s', 'del /f', 'Remove-Item -Recurse', 'format',
      'git push --force', 'git reset --hard',
      'curl.*\\|.*(?:sh|bash|zsh|powershell|cmd|pwsh)',
      'wget.*\\|.*(?:sh|bash|zsh|powershell|cmd|pwsh)',
      'powershell -enc', 'sudo', 'chmod 777', '.env', 'settings.json', '.ssh', 'credentials'
    ];
    workingRules.optionRules = [];
    if (window.agentwatch && window.agentwatch.resetDangerRules) {
      window.agentwatch.resetDangerRules().then(() => {
        renderRulesView();
        updateRulesTopBar();
      });
    } else {
      renderRulesView();
      updateRulesTopBar();
    }
  });
}

// Try-It Tester Logic
const SAMPLE_PROMPTS = {
  'git-status': {
    cmd: 'git status',
    question: 'Allow command to run?',
    options: '1. Yes, once\n2. Yes, and always allow in this conversation\n3. No, cancel'
  },
  'npm-build': {
    cmd: 'npm run build',
    question: 'Allow command to run?',
    options: '1. Yes, once\n2. Yes, and always allow in this conversation\n3. No, cancel'
  },
  'rm-rf': {
    cmd: 'rm -rf node_modules',
    question: 'Allow dangerous delete command?',
    options: '1. Yes, once\n2. No, cancel'
  },
  'danger-delete': {
    cmd: 'git push --delete origin feature',
    question: 'Allow remote branch delete?',
    options: '1. Yes, once\n2. No, cancel'
  },
  'option-always': {
    cmd: 'git commit -m "feat: adds feature"',
    question: 'Allow git commit command?',
    options: '1. Yes, once\n2. Yes, and always allow in this conversation\n3. No, cancel'
  },
  'option-persist': {
    cmd: 'git diff',
    question: 'Allow git diff command?',
    options: '1. Yes, once\n2. Yes, and persist in settings.json\n3. No, cancel'
  },
  'choice-which': {
    cmd: 'git checkout',
    question: 'Which branch would you like to checkout?',
    options: '1. main\n2. feature\n3. bugfix'
  }
};

if (samplePromptSelect) {
  samplePromptSelect.addEventListener('change', () => {
    const key = samplePromptSelect.value;
    const sample = SAMPLE_PROMPTS[key];
    if (sample) {
      if (testerCmd) testerCmd.value = sample.cmd;
      if (testerQuestion) testerQuestion.value = sample.question;
      if (testerOptions) testerOptions.value = sample.options;
    }
  });
}

if (testerEvalBtn) {
  testerEvalBtn.addEventListener('click', () => {
    const cmd = (testerCmd ? testerCmd.value : '').trim();
    const question = (testerQuestion ? testerQuestion.value : '').trim();
    const optionsRaw = (testerOptions ? testerOptions.value : '');

    const lines = optionsRaw.split('\n').map(l => l.trim()).filter(Boolean);
    const options = lines.map((text, idx) => {
      const num = idx + 1;
      const cleanText = text.replace(/^\s*(?:>\s*)?\d+[\s.)-]+/, '').trim();
      let classification = 'custom';
      if (/^(?:yes|allow|approve)\b/i.test(cleanText)) {
        classification = /persist|settings\.json/i.test(cleanText)
          ? 'yes_persist'
          : (/always/i.test(cleanText) ? 'yes_session' : 'yes_once');
      } else if (/^(?:no|cancel|abort|reject)\b/i.test(cleanText)) {
        classification = 'no';
      }
      return {
        number: num,
        key: String(num),
        text,
        classification
      };
    });

    const promptObj = {
      command: cmd,
      commandSpaced: cmd,
      commandCompact: cmd.replace(/\s+/g, ''),
      question,
      options
    };

    if (window.agentwatch && window.agentwatch.evaluatePromptTest) {
      const rulesToTest = workingRules || savedRules;
      const customRules = currentRulesTarget !== 'default'
        ? { ...rulesToTest, isFolderRuleSet: true, folderKey: currentRulesTarget }
        : rulesToTest;
      window.agentwatch.evaluatePromptTest({
        prompt: promptObj,
        customRules
      }).then(res => {
        if (!res || !res.success) {
          if (testerDecisionBadge) {
            testerDecisionBadge.className = 'decision-badge badge-neutral';
            testerDecisionBadge.textContent = 'Error';
          }
          if (testerDecisionDetails) {
            testerDecisionDetails.textContent = res ? res.error : 'Evaluation failed';
          }
          return;
        }

        const decision = res.decision;
        if (testerDecisionBadge) {
          if (decision.action === 'would_approve') {
            testerDecisionBadge.className = 'decision-badge badge-approved';
            testerDecisionBadge.textContent = 'WOULD APPROVE';
          } else if (decision.action === 'blocked') {
            testerDecisionBadge.className = 'decision-badge badge-blocked';
            testerDecisionBadge.textContent = 'BLOCKED';
          } else {
            testerDecisionBadge.className = 'decision-badge badge-needs-user';
            testerDecisionBadge.textContent = 'NEEDS USER';
          }
        }

        if (testerDecisionDetails) {
          testerDecisionDetails.innerHTML = '';
          const infoP = document.createElement('p');
          infoP.style.margin = '0 0 6px 0';
          if (decision.action === 'would_approve') {
            const winRule = decision.winningRule || decision.rule;
            infoP.innerHTML = `<strong>Winning Rule:</strong> ${escapeHtml(winRule)} (${decision.ruleType})<br>` +
              (decision.skippedRules && decision.skippedRules.length > 0 ? `<strong>Skipped Higher-Priority Rules:</strong> ${escapeHtml(decision.skippedRules.join(', '))}<br>` : '') +
              `<strong>Option to press:</strong> Option ${escapeHtml(decision.optionKey)} ("${escapeHtml(decision.optionText)}")<br>` +
              `<strong>Delay:</strong> ${decision.delay}s`;
          } else if (decision.action === 'blocked') {
            infoP.innerHTML = `<strong>Blocked by Deny Rule:</strong> "${escapeHtml(decision.rule)}"`;
          } else {
            let reasonHtml = `<strong>Reason:</strong> ${escapeHtml(decision.reason)}`;
            if (decision.winningRule) {
              reasonHtml += `<br><strong>Winning Rule:</strong> ${escapeHtml(decision.winningRule)}`;
            }
            if (decision.skippedRules && decision.skippedRules.length > 0) {
              reasonHtml += `<br><strong>Skipped Higher-Priority Rules:</strong> ${escapeHtml(decision.skippedRules.join(', '))}`;
            }
            infoP.innerHTML = reasonHtml;
          }
          testerDecisionDetails.appendChild(infoP);

          // Step trace breakdown
          const traceDiv = document.createElement('div');
          traceDiv.className = 'step-trace';

          const denyItem = document.createElement('div');
          denyItem.className = `step-trace-item ${decision.action === 'blocked' ? 'hit' : 'pass'}`;
          denyItem.textContent = decision.action === 'blocked' ? `✕ Deny Rule hit: ${decision.rule}` : '✓ Deny check passed';
          traceDiv.appendChild(denyItem);

          const dangerItem = document.createElement('div');
          const isDangerHit = decision.danger || (decision.reason && decision.reason.startsWith('DANGER:'));
          dangerItem.className = `step-trace-item ${isDangerHit ? 'hit' : 'pass'}`;
          dangerItem.textContent = isDangerHit ? `✕ Danger hit: ${decision.entry || decision.reason}` : (decision.slowDanger ? `⚠ Slow danger matched: ${decision.slowDanger}` : '✓ Danger check passed');
          traceDiv.appendChild(dangerItem);

          const choiceItem = document.createElement('div');
          const isChoice = decision.reason && decision.reason.includes('choice question');
          choiceItem.className = `step-trace-item ${isChoice ? 'hit' : 'pass'}`;
          choiceItem.textContent = isChoice ? '✕ Choice question detected' : '✓ Prompt is permission question';
          traceDiv.appendChild(choiceItem);

          if (decision.winningRule || (decision.action === 'would_approve' && decision.rule)) {
            const ruleItem = document.createElement('div');
            ruleItem.className = 'step-trace-item pass';
            ruleItem.textContent = `✓ Winning rule: ${decision.winningRule || decision.rule}`;
            traceDiv.appendChild(ruleItem);
          }
          if (decision.skippedRules && decision.skippedRules.length > 0) {
            const skippedItem = document.createElement('div');
            skippedItem.className = 'step-trace-item';
            skippedItem.textContent = `↷ Skipped higher-priority rules: ${decision.skippedRules.join(', ')}`;
            traceDiv.appendChild(skippedItem);
          }

          const evalItem = document.createElement('div');
          evalItem.className = 'step-trace-item';
          evalItem.textContent = `Log: ${decision.log || decision.reason || decision.action}`;
          traceDiv.appendChild(evalItem);

          testerDecisionDetails.appendChild(traceDiv);

          const optionExpls = (res && res.optionExplanations) || (decision && decision.optionExplanations);
          if (Array.isArray(optionExpls) && optionExpls.length > 0) {
            const optSection = document.createElement('div');
            optSection.className = 'options-eval-breakdown';
            optSection.style.marginTop = '10px';
            optSection.style.borderTop = '1px solid var(--color-border, #334155)';
            optSection.style.paddingTop = '8px';

            const optTitle = document.createElement('div');
            optTitle.style.fontWeight = '600';
            optTitle.style.fontSize = '12px';
            optTitle.style.marginBottom = '6px';
            optTitle.textContent = 'Per-Option Evaluation:';
            optSection.appendChild(optTitle);

            for (const oe of optionExpls) {
              const row = document.createElement('div');
              row.className = `option-eval-row ${oe.matched ? 'matched' : 'not-matched'}`;
              row.style.marginBottom = '6px';
              row.style.padding = '4px 6px';
              row.style.borderRadius = '4px';
              row.style.background = oe.matched ? 'rgba(34, 197, 94, 0.1)' : 'rgba(100, 116, 139, 0.08)';

              const statusTag = oe.matched ? '[MATCHED]' : '[NOT MATCHED]';
              const tagColor = oe.matched ? 'var(--color-success, #22c55e)' : 'var(--color-text-muted, #94a3b8)';

              let html = `<div style="font-size: 11px;"><strong style="color: ${tagColor};">${escapeHtml(statusTag)}</strong> Option ${escapeHtml(oe.key)}: <em>"${escapeHtml(oe.text)}"</em></div>`;
              html += `<div style="font-size: 11px; margin-left: 12px; color: var(--color-text-dim, #cbd5e1);"><strong>Result:</strong> ${escapeHtml(oe.matchResult)}</div>`;
              if (oe.reasons && oe.reasons.length > 0) {
                html += `<div style="font-size: 10px; margin-left: 12px; color: var(--color-text-muted, #94a3b8);">Why rules did not match: ${escapeHtml(oe.reasons.join('; '))}</div>`;
              }
              row.innerHTML = html;
              optSection.appendChild(row);
            }
            testerDecisionDetails.appendChild(optSection);
          }
        }
      });
    }
  });
}

// Export for unit tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    render,
    createRow,
    updateRow,
    getStateIcon,
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
    showToast,
    openTurnOnModal,
    formatDisplayTime,
    formatSessionLength,
    formatPlainDecision,
    getClassificationLabel,
    groupHistoryBySession,
    generateRulePreview,
    validateOptionRuleDraft,
    hasUnsavedChanges,
    loadRulesView,
    renderRulesView,
    renderOptionRules,
    renderDangerList,
    renderDenyList,
    renderAllowList,
    isBuiltinDenyRule,
    getLockedDenyExplanation,
    showLockedDenyDialog,
    showUnlockConfirmationDialog,
    getPendingUnlockEntryPattern: () => pendingUnlockEntryPattern,
    getPendingUnlockEntryIndex: () => pendingUnlockEntryIndex,
    showNestedFolderBanner,
    hideNestedFolderBanner,
    refreshRulesFolderSelect,
    getCurrentRulesTarget: () => currentRulesTarget,
    setCurrentRulesTarget: (t) => { currentRulesTarget = t; },
    getWorkingRules: () => workingRules,
    setWorkingRules: (r) => { workingRules = r; },
    getSavedRules: () => savedRules,
    setSavedRules: (r) => { savedRules = r; },
    getRowCache: () => rowCache,
    getCurrentSessions: () => currentSessions,
    getEditingSessionKey: () => editingSessionKey,
    getDraggedKey: () => draggedKey,
    getSelectedAgentKey: () => selectedAgentKey,
    getPendingData: () => pendingData,
    getCurrentConfig: () => currentConfig,
    setKnownAgents: (agents) => { knownAgents = agents; },
    getKnownAgents: () => knownAgents,
    updateCameraNotch,
    updateNotchHud,
    toggleNotchHud,
    closeNotchHud,
    jumpToAgent,
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
      if (notchTrafficLights) notchTrafficLights.innerHTML = '';
      if (notchHudList) notchHudList.innerHTML = '';
      if (ambientTopShade) ambientTopShade.className = 'ambient-top-shade shade-off';
    }
  };
}
