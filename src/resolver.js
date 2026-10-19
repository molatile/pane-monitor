const fs = require('fs');
const path = require('path');

/**
 * Resolves a command string to an executable path on the system.
 * On Windows, handles PATHEXT (.exe, .cmd, .bat, etc.) and PATH lookup.
 */
function resolveExecutable(command) {
  if (!command) return null;

  // Direct absolute path check
  if (path.isAbsolute(command)) {
    if (fs.existsSync(command) && !fs.statSync(command).isDirectory()) {
      return command;
    }
  }

  const isWin = process.platform === 'win32';
  const pathext = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
    .map(ext => ext.toLowerCase());

  const hasExt = isWin && pathext.includes(path.extname(command).toLowerCase());
  const extensionsToTry = isWin
    ? (hasExt ? [''] : ['', ...pathext])
    : [''];

  // Relative path with directory separator
  if (command.includes('/') || command.includes('\\')) {
    for (const ext of extensionsToTry) {
      const candidate = path.resolve(process.cwd(), command + ext);
      try {
        if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch (e) {}
    }
    return command;
  }

  // Look up in PATH
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const ext of extensionsToTry) {
      const candidate = path.join(dir, command + ext);
      try {
        if (fs.existsSync(candidate) && !fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch (e) {}
    }
  }

  // Fallback to command as provided
  return command;
}

module.exports = {
  resolveExecutable
};
