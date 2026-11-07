/**
 * AgentWatch Floating Notch Island Renderer
 * Controls Dynamic Island appearance, auto-adjustment, agent scrolling,
 * pop-up lifecycle, bobbing animation, and live decision updates.
 */

const doc = (typeof document !== 'undefined') ? document : null;
const notchIsland = doc ? doc.getElementById('notch-island') : null;
const islandGlow = doc ? doc.getElementById('island-glow') : null;
const islandDot = doc ? doc.getElementById('island-dot') : null;
const islandAgentName = doc ? doc.getElementById('island-agent-name') : null;
const islandTag = doc ? doc.getElementById('island-tag') : null;
const islandStatusText = doc ? doc.getElementById('island-status-text') : null;
const islandPager = doc ? doc.getElementById('island-pager') : null;
const pagerPrevBtn = doc ? doc.getElementById('pager-prev-btn') : null;
const pagerCounter = doc ? doc.getElementById('pager-counter') : null;
const pagerNextBtn = doc ? doc.getElementById('pager-next-btn') : null;
const islandHideBtn = doc ? doc.getElementById('island-hide-btn') : null;

const expandedTitle = doc ? doc.getElementById('expanded-title') : null;
const expandedAgentBadge = doc ? doc.getElementById('expanded-agent-badge') : null;
const expandedHideBtn = doc ? doc.getElementById('expanded-hide-btn') : null;
const expandedTargetIcon = doc ? doc.getElementById('expanded-target-icon') : null;
const expandedCommand = doc ? doc.getElementById('expanded-command') : null;
const expandedSubtext = doc ? doc.getElementById('expanded-subtext') : null;
const expandedOpenBtn = doc ? doc.getElementById('expanded-open-btn') : null;

let currentState = 'hidden'; // 'green', 'red', 'orange', 'hidden'
let isHovered = false;
let isBobbing = false;
let isSnoozed = false;
let hideTimeout = null;
let greenBobTimer = null;
let currentTopSession = null;

let activeSessionsList = [];
let currentSessionIndex = 0;
const previousSessionStates = new Map();
const recentlyCompletedSessions = new Set();

/**
 * Computes dominant state from sessions list.
 */
function computeNotchState(sessions = [], config = {}) {
  // If explicitly disabled in config, always hide
  if (config.floatingNotch === false || config.cameraNotch === false) {
    return { state: 'hidden', session: null };
  }

  const activeSessions = (sessions || []).filter(s => !s.isDead && s.state !== 'dead');
  if (activeSessions.length === 0) {
    return { state: 'hidden', session: null };
  }

  // Priority 1: ASKING (Red Alert)
  const askingSession = activeSessions.find(s => s.isAsking || s.state === 'asking');
  if (askingSession) {
    return { state: 'red', session: askingSession };
  }

  // Priority 2: COUNTDOWN (Orange Alert)
  const countdownSession = activeSessions.find(s => s.state === 'countdown');
  if (countdownSession) {
    return { state: 'orange', session: countdownSession };
  }

  // Priority 3: ACTIVE (Green - Busy or Idle)
  const busySession = activeSessions.find(s => s.state === 'busy');
  const topActive = busySession || activeSessions[0];
  return { state: 'green', session: topActive };
}

/**
 * Formats display name for the agent in the notch.
 */
function getAgentDisplayName(session) {
  if (!session) return 'agentwatch';
  return session.displayName || session.folder || session.agent || 'agentwatch';
}

/**
 * Convenience switcher: next agent in list
 */
function nextAgent() {
  if (activeSessionsList.length <= 1) return;
  currentSessionIndex = (currentSessionIndex + 1) % activeSessionsList.length;
  currentTopSession = activeSessionsList[currentSessionIndex];
  renderCurrentAgent();
}

/**
 * Convenience switcher: previous agent in list
 */
function prevAgent() {
  if (activeSessionsList.length <= 1) return;
  currentSessionIndex = (currentSessionIndex - 1 + activeSessionsList.length) % activeSessionsList.length;
  currentTopSession = activeSessionsList[currentSessionIndex];
  renderCurrentAgent();
}

/**
 * Snoozes the notch until a new permission request or task completion occurs.
 */
function hideForNow(e) {
  if (e) e.stopPropagation();
  isSnoozed = true;
  if (greenBobTimer) {
    clearTimeout(greenBobTimer);
    greenBobTimer = null;
  }
  applyNotchState('hidden', null);
}

/**
 * Opens main pane monitor and jumps to the actual decision window/agent.
 */
function openDecisionWindow(session) {
  const target = session || currentTopSession;
  if (typeof window !== 'undefined' && window.notchApi && typeof window.notchApi.openMainApp === 'function') {
    window.notchApi.openMainApp({
      sessionKey: target ? target.sessionKey : undefined,
      pid: target ? target.pid : undefined
    });
  }
}

/**
 * Rerenders current agent details without changing overall active sessions list.
 */
function renderCurrentAgent() {
  if (!currentTopSession && activeSessionsList.length > 0) {
    currentTopSession = activeSessionsList[0];
  }
  if (!currentTopSession) return;

  const session = currentTopSession;
  const isAsking = Boolean(session.isAsking || session.state === 'asking');
  const isCountdown = Boolean(session.state === 'countdown');
  const specificState = isAsking ? 'red' : (isCountdown ? 'orange' : 'green');

  applyNotchState(specificState, session);
}

/**
 * Auto-adjusts size and updates DOM based on state and hover.
 */
function applyNotchState(newState, session) {
  currentTopSession = session;
  currentState = newState;

  if (newState === 'hidden') {
    if (notchIsland) {
      notchIsland.classList.remove('visible');
      notchIsland.classList.remove('expanded');
      notchIsland.classList.remove('bobbing');
    }
    if (islandGlow) islandGlow.className = 'island-glow glow-hidden';
    if (islandDot) islandDot.className = 'island-dot dot-off';

    if (greenBobTimer) {
      clearTimeout(greenBobTimer);
      greenBobTimer = null;
    }

    // Delay before telling main process to hide window to let slide-up finish
    if (hideTimeout) clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      if (currentState === 'hidden' && typeof window !== 'undefined' && window.notchApi && typeof window.notchApi.setVisibility === 'function') {
        window.notchApi.setVisibility(false);
      }
    }, 320);

    return;
  }

  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }

  // Ensure window is visible
  if (typeof window !== 'undefined' && window.notchApi && typeof window.notchApi.setVisibility === 'function') {
    window.notchApi.setVisibility(true);
  }

  // Handle green pop-up once and bobbing lifecycle:
  if (newState === 'red') {
    // Red alert MUST stay visible, never bob or auto-hide
    if (greenBobTimer) {
      clearTimeout(greenBobTimer);
      greenBobTimer = null;
    }
    isBobbing = false;
  } else if (newState === 'orange') {
    // Countdown alert stays visible
    if (greenBobTimer) {
      clearTimeout(greenBobTimer);
      greenBobTimer = null;
    }
    isBobbing = false;
  } else if (newState === 'green') {
    // Green state: pops up once and then enters bobbing mode
    if (!isBobbing && !isHovered && !greenBobTimer) {
      greenBobTimer = setTimeout(() => {
        greenBobTimer = null;
        if (currentState === 'green' && !isHovered) {
          isBobbing = true;
          if (notchIsland) {
            notchIsland.classList.add('bobbing');
          }
          adjustDimensions();
        }
      }, 4000);
    }
  }

  const agentName = getAgentDisplayName(session);
  if (islandAgentName) {
    islandAgentName.textContent = agentName;
  }

  // Live decision & file details
  const prompt = session && session.prompt;
  const isFileEdit = Boolean(prompt && (prompt.type === 'file_edit' || prompt.label === 'file edit' || prompt.fileName || prompt.targetFile));
  
  let targetText = '';
  let targetIcon = '⚡';
  let decisionDetail = '';

  if (isFileEdit) {
    targetIcon = '📄';
    const fileName = prompt.fileName || (prompt.targetFile ? prompt.targetFile.split(/[/\\]/).pop() : (prompt.command || 'File edit'));
    targetText = fileName;
    decisionDetail = prompt.decision ? `Decision: ${prompt.decision}` : 'Reviewing file modification';
  } else if (prompt && prompt.command) {
    targetIcon = '💻';
    targetText = prompt.command;
    decisionDetail = prompt.decision ? `Decision: ${prompt.decision}` : (prompt.question || 'Reviewing terminal command');
  } else {
    targetIcon = (session && session.state === 'busy') ? '⚡' : '✨';
    targetText = (session && session.state === 'busy') ? 'Running tasks...' : 'Ready for instructions';
    decisionDetail = (session && session.state === 'busy') ? `${agentName} is executing background work` : `${agentName} is idle & calm`;
  }

  let tagText = '';
  let tagClass = 'island-tag tag-hidden';
  let statusText = 'Ready';
  let commandHint = targetText;

  if (newState === 'red') {
    statusText = isFileEdit ? 'File Edit' : 'Permission';
    tagText = '[!]';
    tagClass = 'island-tag tag-red';
    commandHint = isFileEdit ? `Permission: ${targetText}` : (prompt && prompt.command ? prompt.command : 'Action requested by agent');
  } else if (newState === 'orange') {
    const secs = (session && session.countdown !== undefined && session.countdown !== null) ? `${session.countdown}s` : '3s';
    statusText = `${secs} Auto`;
    tagText = secs;
    tagClass = 'island-tag tag-orange';
    commandHint = `Auto-approving: ${targetText}`;
  } else {
    // Green: accurately report Ready vs Completed vs Working
    tagClass = 'island-tag tag-hidden';
    const isBusy = Boolean(session && session.state === 'busy');
    if (isBusy) {
      statusText = 'Working...';
      commandHint = `${agentName} is running tasks`;
    } else if (session && recentlyCompletedSessions.has(session.sessionId)) {
      statusText = 'Completed';
      commandHint = `${agentName} finished task · Ready`;
    } else {
      statusText = 'Ready';
      commandHint = `${agentName} is ready`;
    }
  }

  if (islandStatusText) islandStatusText.textContent = statusText;
  if (islandTag) {
    islandTag.textContent = tagText;
    islandTag.className = tagClass;
  }

  // Pager UI update
  if (islandPager && pagerCounter) {
    if (activeSessionsList.length > 1) {
      islandPager.classList.remove('pager-hidden');
      pagerCounter.textContent = `${currentSessionIndex + 1}/${activeSessionsList.length}`;
    } else {
      islandPager.classList.add('pager-hidden');
    }
  }

  // Expanded HUD updates
  if (expandedTargetIcon) expandedTargetIcon.textContent = targetIcon;
  if (expandedCommand) expandedCommand.textContent = commandHint;
  if (expandedSubtext) expandedSubtext.textContent = decisionDetail;
  if (expandedAgentBadge) expandedAgentBadge.textContent = session ? (session.agent || 'agent') : 'agent';

  if (expandedTitle) {
    expandedTitle.textContent = newState === 'red' ? '⚠️ Permission Request'
      : (newState === 'orange' ? '⏱️ Auto-Accept Countdown' : 'Active Agent');
  }

  if (expandedOpenBtn) {
    if (newState === 'red' || newState === 'orange') {
      expandedOpenBtn.textContent = 'Open Decision ↗';
      expandedOpenBtn.classList.add('btn-alert');
    } else {
      expandedOpenBtn.textContent = 'Open Monitor ↗';
      expandedOpenBtn.classList.remove('btn-alert');
    }
  }

  // Update glows and dots
  if (islandGlow) islandGlow.className = `island-glow glow-${newState}`;
  if (islandDot) islandDot.className = `island-dot dot-${newState}`;

  // Make visible & set appropriate mode class
  if (notchIsland) {
    notchIsland.classList.add('visible');
    if (isHovered) {
      notchIsland.classList.add('expanded');
      notchIsland.classList.remove('bobbing');
    } else if (isBobbing && newState === 'green') {
      notchIsland.classList.add('bobbing');
      notchIsland.classList.remove('expanded');
    } else {
      notchIsland.classList.remove('expanded');
      notchIsland.classList.remove('bobbing');
    }
  }

  adjustDimensions();
}

/**
 * Calculates responsive width and height and synchronizes Electron window size.
 */
function adjustDimensions() {
  let targetWidth = 220;
  let targetHeight = 38;

  if (isHovered) {
    targetWidth = 420;
    targetHeight = 92;
  } else if (isBobbing && currentState === 'green') {
    targetWidth = 190;
    targetHeight = 34;
  } else {
    // Compact Popped bar
    const agentName = currentTopSession ? getAgentDisplayName(currentTopSession) : 'agentwatch';
    const statusText = islandStatusText ? (islandStatusText.textContent || '') : 'Ready';
    const textLen = agentName.length + statusText.length;

    if (currentState === 'red') {
      targetWidth = Math.max(280, Math.min(380, 210 + textLen * 5));
    } else if (currentState === 'orange') {
      targetWidth = Math.max(260, Math.min(360, 190 + textLen * 5));
    } else {
      targetWidth = Math.max(200, Math.min(320, 160 + textLen * 5));
    }
    targetHeight = 38;
  }

  if (notchIsland) {
    notchIsland.style.width = `${targetWidth}px`;
  }

  // Request window resize to tightly fit island + padding
  if (typeof window !== 'undefined' && window.notchApi && typeof window.notchApi.resize === 'function') {
    window.notchApi.resize({ width: targetWidth + 24, height: targetHeight + 14 });
  }
}

// -------------------------------------------------------------
// Interactive Event Listeners
// -------------------------------------------------------------

if (notchIsland) {
  // Hover interactions
  notchIsland.addEventListener('mouseenter', () => {
    isHovered = true;
    if (greenBobTimer) {
      clearTimeout(greenBobTimer);
      greenBobTimer = null;
    }
    if (currentState !== 'hidden') {
      applyNotchState(currentState, currentTopSession);
    }
  });

  notchIsland.addEventListener('mouseleave', () => {
    isHovered = false;
    if (currentState !== 'hidden') {
      applyNotchState(currentState, currentTopSession);
    }
  });

  // Mouse wheel cycling through agents
  notchIsland.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (activeSessionsList.length <= 1) return;
    if (e.deltaY > 0 || e.deltaX > 0) {
      nextAgent();
    } else if (e.deltaY < 0 || e.deltaX < 0) {
      prevAgent();
    }
  }, { passive: false });

  // Clicking on island opens the decision window if expanded, or expands it
  notchIsland.addEventListener('click', (e) => {
    // If clicking on buttons, don't trigger general island click
    if (e.target && typeof e.target.closest === 'function' &&
        (e.target.closest('.pager-btn') || e.target.closest('.island-quick-hide') || e.target.closest('.expanded-hide-btn') || e.target.closest('.expanded-btn'))) {
      return;
    }
    e.stopPropagation();
    openDecisionWindow(currentTopSession);
  });

  // Keyboard navigation
  notchIsland.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      nextAgent();
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      prevAgent();
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      openDecisionWindow(currentTopSession);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      hideForNow(e);
    }
  });
}

// Pager button interactions
if (pagerPrevBtn) {
  pagerPrevBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    prevAgent();
  });
}

if (pagerNextBtn) {
  pagerNextBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    nextAgent();
  });
}

// Snooze / Hide for now buttons
if (islandHideBtn) {
  islandHideBtn.addEventListener('click', hideForNow);
}

if (expandedHideBtn) {
  expandedHideBtn.addEventListener('click', hideForNow);
}

// Open Decision action button
if (expandedOpenBtn) {
  expandedOpenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openDecisionWindow(currentTopSession);
  });
}

// Subscribe to updates from main process
if (typeof window !== 'undefined' && window.notchApi && typeof window.notchApi.onUpdate === 'function') {
  window.notchApi.onUpdate((data = {}) => {
    const rawSessions = data.sessions || [];
    const activeSessions = rawSessions.filter(s => !s.isDead && s.state !== 'dead');

    // Check for wake-up triggers
    let hasAsking = false;
    let hasCountdown = false;
    let hasCompletedTask = false;

    activeSessions.forEach(s => {
      if (s.isAsking || s.state === 'asking') hasAsking = true;
      if (s.state === 'countdown') hasCountdown = true;

      const prevState = previousSessionStates.get(s.sessionId);
      if (prevState === 'busy' && s.state === 'idle') {
        hasCompletedTask = true;
        recentlyCompletedSessions.add(s.sessionId);
        setTimeout(() => recentlyCompletedSessions.delete(s.sessionId), 10000);
      }
      previousSessionStates.set(s.sessionId, s.state);
    });

    // If snoozed, check if a wake-up condition is met
    if (isSnoozed) {
      if (hasAsking || hasCountdown || hasCompletedTask) {
        isSnoozed = false; // Wake up!
      } else {
        applyNotchState('hidden', null);
        return;
      }
    }

    activeSessionsList = activeSessions;

    if (activeSessions.length === 0) {
      currentSessionIndex = 0;
      currentTopSession = null;
      applyNotchState('hidden', null);
      return;
    }

    // Auto-focus asking agent if one exists and user is not already looking at one
    const askingIdx = activeSessions.findIndex(s => s.isAsking || s.state === 'asking');
    if (askingIdx !== -1) {
      const currentIsAsking = currentTopSession && (currentTopSession.isAsking || currentTopSession.state === 'asking');
      if (!currentIsAsking) {
        currentSessionIndex = askingIdx;
      }
    }

    // Clamp currentSessionIndex
    if (currentSessionIndex >= activeSessions.length) {
      currentSessionIndex = 0;
    }

    currentTopSession = activeSessions[currentSessionIndex];

    const { state } = computeNotchState(data.sessions, data.config);
    if (state === 'hidden') {
      applyNotchState('hidden', null);
    } else {
      renderCurrentAgent();
    }
  });
}

// Export for unit tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    computeNotchState,
    getAgentDisplayName,
    applyNotchState,
    nextAgent,
    prevAgent,
    hideForNow,
    openDecisionWindow,
    isSnoozed: () => isSnoozed
  };
}
