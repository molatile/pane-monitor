const { spawn } = require('child_process');
const path = require('path');

let electronPath = null;
try {
  electronPath = require('electron');
} catch (e) {}

/**
 * Spawns the agentwatch GUI window using Electron.
 */
function startGui(options = {}) {
  const quiet = Boolean(options.quiet);
  const focus = Boolean(options.focus);
  const autoOpen = Boolean(options.autoOpen);
  const extraArgs = options.args || [];
  const mainScript = path.join(__dirname, 'main.js');

  const execPath = options.electronPath !== undefined ? options.electronPath : electronPath;
  if (!execPath) {
    if (!options.silent && !autoOpen) {
      console.error('Error: Electron is not installed. Run "npm install" to install devDependencies.');
    }
    if (options.onExit) options.onExit(1);
    return null;
  }

  const spawnArgs = [mainScript];
  if (quiet) {
    spawnArgs.push('--quiet');
  }
  if (focus) {
    spawnArgs.push('--focus');
  }
  if (autoOpen) {
    spawnArgs.push('--auto-open');
  }
  spawnArgs.push(...extraArgs);

  const isDetached = Boolean(options.detached);
  const stdio = options.stdio || (isDetached ? 'ignore' : 'inherit');

  let child;
  try {
    child = spawn(execPath, spawnArgs, {
      stdio,
      detached: isDetached,
      env: {
        ...process.env,
        ...options.env
      }
    });
  } catch (err) {
    if (options.onLaunchError) {
      options.onLaunchError(err);
    } else if (!options.silent) {
      console.error(`Failed to launch agentwatch GUI: ${err.message}`);
    }
    if (options.onExit) options.onExit(1);
    return null;
  }

  child.on('error', (err) => {
    if (options.onLaunchError) {
      options.onLaunchError(err);
    } else if (!options.silent) {
      console.error(`Failed to launch agentwatch GUI: ${err.message}`);
    }
    if (options.onExit) options.onExit(1);
  });

  child.on('exit', (code) => {
    if (options.onExit) options.onExit(code ?? 0);
  });

  if (isDetached && child.unref) {
    child.unref();
  }

  return {
    child,
    mainScript,
    electronPath: execPath
  };
}

module.exports = {
  startGui
};
