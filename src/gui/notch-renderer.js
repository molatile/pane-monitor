/**
 * AgentWatch Floating Notch Island Renderer
 * Controls Dynamic Island appearance, auto-adjustment, and visibility.
 */

const doc = (typeof document !== 'undefined') ? document : null;
const notchIsland = doc ? doc.getElementById('notch-island') : null;
const islandGlow = doc ? doc.getElementById('island-glow') : null;
const islandDot = doc ? doc.getElementById('island-dot') : null;
const islandAgentName = doc ? doc.getElementById('island-agent-name') : null;
const islandTag = doc ? doc.getElementById('island-tag') : null;
const islandStatusText = doc ? doc.getElementById('island-status-text') : null;
const expandedCommand = doc ? doc.getElementById('expanded-command') : null;
const expandedTitle = doc ? doc.getElementById('expanded-title') : null;
const expandedOpenBtn = doc ? doc.getElementById('expanded-open-btn') : null;

let currentState = 'hidden'; // 'green', 'red', 'orange', 'hidden'
let isHovered = false;
let hideTimeout = null;
let currentTopSession = null;

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
 * Auto-adjusts size and updates DOM based on state and hover.
 */
function applyNotchState(newState, session) {
  currentTopSession = session;
  currentState = newState;

  if (newState === 'hidden') {
    if (notchIsland) {
      notchIsland.classList.remove('visible');
      notchIsland.classList.remove('expanded');
    }
    if (islandGlow) islandGlow.className = 'island-glow glow-hidden';
    if (islandDot) islandDot.className = 'island-dot dot-off';

    // Delay before telling main process to hide window to let slide-up finish
    if (hideTimeout) clearTimeout(hideTimeout);
    hideTimeout = setTimeout(() => {
      if (currentState === 'hidden' && window.notchApi && typeof window.notchApi.setVisibility === 'function') {
        window.notchApi.setVisibility(false);
      }
    }, 320);

    return;
  }

  if (hideTimeout) {
    clearTimeout(hideTimeout);
    hideTimeout = null;
  }

  // Ensure window is shown
  if (window.notchApi && typeof window.notchApi.setVisibility === 'function') {
    window.notchApi.setVisibility(true);
  }

  const agentName = getAgentDisplayName(session);
  if (islandAgentName) {
    islandAgentName.textContent = agentName;
  }

  let tagText = '';
  let tagClass = 'island-tag tag-hidden';
  let statusText = 'calm';
  let commandHint = '';

  if (newState === 'red') {
    statusText = 'Permission';
    tagText = '[!]';
    tagClass = 'island-tag tag-red';
    commandHint = (session && session.prompt && session.prompt.command)
      ? session.prompt.command
      : 'Action requested by agent';
  } else if (newState === 'orange') {
    statusText = 'Countdown';
    const secs = (session && session.countdown !== undefined && session.countdown !== null) ? `${session.countdown}s` : '3s';
    tagText = secs;
    tagClass = 'island-tag tag-orange';
    commandHint = (session && session.prompt && session.prompt.command)
      ? `Auto-approving: ${session.prompt.command}`
      : 'Auto-approving option';
  } else {
    // Green
    const isBusy = Boolean(session && session.state === 'busy');
    statusText = isBusy ? 'Working...' : 'Calm';
    tagClass = 'island-tag tag-hidden';
    commandHint = isBusy ? `${agentName} is running tasks` : `${agentName} is ready`;
  }

  if (islandStatusText) islandStatusText.textContent = statusText;
  if (islandTag) {
    islandTag.textContent = tagText;
    islandTag.className = tagClass;
  }

  if (expandedCommand) expandedCommand.textContent = commandHint;
  if (expandedTitle) {
    expandedTitle.textContent = newState === 'red' ? '⚠️ Permission Request'
      : (newState === 'orange' ? '⏱️ Auto-Accept Countdown' : 'Active Agent');
  }

  // Update glows and dots
  if (islandGlow) islandGlow.className = `island-glow glow-${newState}`;
  if (islandDot) islandDot.className = `island-dot dot-${newState}`;

  // Make visible
  if (notchIsland) {
    notchIsland.classList.add('visible');
    if (isHovered) {
      notchIsland.classList.add('expanded');
    } else {
      notchIsland.classList.remove('expanded');
    }
  }

  // Compute auto-adjusted dimensions
  let targetWidth = 200;
  let targetHeight = 44;

  if (isHovered) {
    targetWidth = 360;
    targetHeight = 72;
  } else {
    // Calculate width based on text lengths
    const textLen = (agentName.length + statusText.length);
    if (newState === 'red') {
      targetWidth = Math.max(280, Math.min(360, 200 + textLen * 6));
    } else if (newState === 'orange') {
      targetWidth = Math.max(250, Math.min(340, 180 + textLen * 6));
    } else {
      targetWidth = Math.max(180, Math.min(270, 140 + textLen * 6));
    }
    targetHeight = 44;
  }

  if (notchIsland) {
    notchIsland.style.width = `${targetWidth}px`;
  }

  // Request window resize to tightly fit island + padding
  if (window.notchApi && typeof window.notchApi.resize === 'function') {
    window.notchApi.resize({ width: targetWidth + 16, height: targetHeight + 10 });
  }
}

// Hover interactions
if (notchIsland) {
  notchIsland.addEventListener('mouseenter', () => {
    isHovered = true;
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

  // Clicking on island opens the main app
  notchIsland.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.notchApi && typeof window.notchApi.openMainApp === 'function') {
      window.notchApi.openMainApp();
    }
  });
}

if (expandedOpenBtn) {
  expandedOpenBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (window.notchApi && typeof window.notchApi.openMainApp === 'function') {
      window.notchApi.openMainApp();
    }
  });
}

// Subscribe to updates from main process
if (typeof window !== 'undefined' && window.notchApi && typeof window.notchApi.onUpdate === 'function') {
  window.notchApi.onUpdate((data = {}) => {
    const { state, session } = computeNotchState(data.sessions, data.config);
    applyNotchState(state, session);
  });
}

// Export for unit tests
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    computeNotchState,
    getAgentDisplayName,
    applyNotchState
  };
}
