#!/usr/bin/env node

const { startAgentwatch } = require('./src/agentwatch');
const { getProfileForCommand } = require('./src/profile');

function printUsage() {
  console.error('Usage: spike [--record] [--log-dir <dir>] <command> [args...]');
  console.error('Example: spike agy');
  console.error('         spike --log-dir ./logs agy');
  console.error('         spike powershell');
  console.error('         spike cmd /c dir');
  process.exit(1);
}

let args = process.argv.slice(2);
let record = true; // Enabled by default when invoked via spike for full backwards compatibility
let logDir = undefined;
let promptsLogPath = undefined;
let snapshotsPath = undefined;
let rawSessionPath = undefined;
const filteredArgs = [];

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--no-record') {
    record = false;
  } else if (arg === '--record') {
    record = true;
  } else if (arg === '--log-dir' || arg === '--output-dir' || arg === '--out-dir') {
    if (i + 1 < args.length) logDir = args[++i];
  } else if (arg.startsWith('--log-dir=')) {
    logDir = arg.slice('--log-dir='.length);
  } else if (arg.startsWith('--output-dir=')) {
    logDir = arg.slice('--output-dir='.length);
  } else if (arg.startsWith('--out-dir=')) {
    logDir = arg.slice('--out-dir='.length);
  } else if (arg === '--prompts-log' || arg === '--log-file' || arg === '--log') {
    if (i + 1 < args.length) promptsLogPath = args[++i];
  } else if (arg.startsWith('--prompts-log=')) {
    promptsLogPath = arg.slice('--prompts-log='.length);
  } else if (arg.startsWith('--log-file=')) {
    promptsLogPath = arg.slice('--log-file='.length);
  } else if (arg.startsWith('--log=')) {
    promptsLogPath = arg.slice('--log='.length);
  } else if (arg === '--snapshots' || arg === '--snapshots-file' || arg === '--screen-snapshots') {
    if (i + 1 < args.length) snapshotsPath = args[++i];
  } else if (arg.startsWith('--snapshots=')) {
    snapshotsPath = arg.slice('--snapshots='.length);
  } else if (arg.startsWith('--snapshots-file=')) {
    snapshotsPath = arg.slice('--snapshots-file='.length);
  } else if (arg.startsWith('--screen-snapshots=')) {
    snapshotsPath = arg.slice('--screen-snapshots='.length);
  } else if (arg === '--raw-session' || arg === '--record-file') {
    if (i + 1 < args.length) rawSessionPath = args[++i];
  } else if (arg.startsWith('--raw-session=')) {
    rawSessionPath = arg.slice('--raw-session='.length);
  } else if (arg.startsWith('--record-file=')) {
    rawSessionPath = arg.slice('--record-file='.length);
  } else {
    filteredArgs.push(arg);
  }
}

if (filteredArgs.length === 0) {
  printUsage();
}

const command = filteredArgs[0];
const commandArgs = filteredArgs.slice(1);

const instance = startAgentwatch({
  command,
  args: commandArgs,
  profile: getProfileForCommand(command) || getProfileForCommand('agy'),
  record,
  logDir,
  promptsLogPath,
  snapshotsPath,
  rawSessionPath
});

module.exports = {
  isScreenStable: () => true,
  saveScreenSnapshot: () => instance && instance.saveScreenSnapshot && instance.saveScreenSnapshot(),
  inspectScreenForPrompts: () => instance && instance.inspectScreenForPrompts && instance.inspectScreenForPrompts()
};
