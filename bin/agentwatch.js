#!/usr/bin/env node

const { startAgentwatch } = require('../src/agentwatch');
const { startDashboard } = require('../src/dashboard');
const { startGui } = require('../src/gui');

function printUsage() {
  console.error('Usage: agentwatch [--auto] [--record] [--quiet] [--log-dir <dir>] <command> [args...]');
  console.error('       agentwatch dash [--quiet]');
  console.error('       agentwatch gui [--quiet] [--restart]');
  console.error('       agentwatch clear-history [sessionKey]');
  console.error('Example: agentwatch agy');
  console.error('         agentwatch --log-dir ./logs agy');
  console.error('         agentwatch --auto agy');
  console.error('         agentwatch dash');
  console.error('         agentwatch gui');
  console.error('         agentwatch gui --restart');
  console.error('         agentwatch clear-history');
  console.error('         agentwatch clear-history agy:7cfa67ecd72da468');
  process.exit(1);
}

function parseArgs(argv = process.argv.slice(2)) {
  let record = false;
  let quiet = false;
  let auto = undefined;
  let restart = false;
  let logDir = undefined;
  let promptsLogPath = undefined;
  let snapshotsPath = undefined;
  let rawSessionPath = undefined;
  const filteredArgs = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--record') {
      record = true;
    } else if (arg === '--no-record') {
      record = false;
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else if (arg === '--auto') {
      auto = true;
    } else if (arg === '--no-auto') {
      auto = false;
    } else if (arg === '--restart') {
      restart = true;
    } else if (arg === '--log-dir' || arg === '--output-dir' || arg === '--out-dir') {
      if (i + 1 < argv.length) {
        logDir = argv[++i];
      }
    } else if (arg.startsWith('--log-dir=')) {
      logDir = arg.slice('--log-dir='.length);
    } else if (arg.startsWith('--output-dir=')) {
      logDir = arg.slice('--output-dir='.length);
    } else if (arg.startsWith('--out-dir=')) {
      logDir = arg.slice('--out-dir='.length);
    } else if (arg === '--prompts-log' || arg === '--log-file' || arg === '--log') {
      if (i + 1 < argv.length) {
        promptsLogPath = argv[++i];
      }
    } else if (arg.startsWith('--prompts-log=')) {
      promptsLogPath = arg.slice('--prompts-log='.length);
    } else if (arg.startsWith('--log-file=')) {
      promptsLogPath = arg.slice('--log-file='.length);
    } else if (arg.startsWith('--log=')) {
      promptsLogPath = arg.slice('--log='.length);
    } else if (arg === '--snapshots' || arg === '--snapshots-file' || arg === '--screen-snapshots') {
      if (i + 1 < argv.length) {
        snapshotsPath = argv[++i];
      }
    } else if (arg.startsWith('--snapshots=')) {
      snapshotsPath = arg.slice('--snapshots='.length);
    } else if (arg.startsWith('--snapshots-file=')) {
      snapshotsPath = arg.slice('--snapshots-file='.length);
    } else if (arg.startsWith('--screen-snapshots=')) {
      snapshotsPath = arg.slice('--screen-snapshots='.length);
    } else if (arg === '--raw-session' || arg === '--record-file') {
      if (i + 1 < argv.length) {
        rawSessionPath = argv[++i];
      }
    } else if (arg.startsWith('--raw-session=')) {
      rawSessionPath = arg.slice('--raw-session='.length);
    } else if (arg.startsWith('--record-file=')) {
      rawSessionPath = arg.slice('--record-file='.length);
    } else {
      filteredArgs.push(arg);
    }
  }

  return {
    record,
    quiet,
    auto,
    restart,
    logDir,
    promptsLogPath,
    snapshotsPath,
    rawSessionPath,
    command: filteredArgs[0] || null,
    commandArgs: filteredArgs.slice(1)
  };
}

if (require.main === module) {
  const {
    record,
    quiet,
    auto,
    restart,
    logDir,
    promptsLogPath,
    snapshotsPath,
    rawSessionPath,
    command,
    commandArgs
  } = parseArgs();

  if (!command) {
    printUsage();
  }

  if (command === 'dash') {
    startDashboard({ quiet });
  } else if (command === 'gui') {
    startGui({ quiet, focus: true, restart });
  } else if (command === 'clear-history') {
    const { clearAgentHistory } = require('../src/history');
    const targetKey = commandArgs[0] || '*';
    const res = clearAgentHistory(targetKey);
    if (res.success) {
      console.log(`Successfully cleared ${res.removedCount} history events.`);
    } else {
      console.error(`Failed to clear history: ${res.error}`);
      process.exit(1);
    }
    process.exit(0);
  } else {
    startAgentwatch({
      command,
      args: commandArgs,
      record,
      quiet,
      auto,
      autoOpenWindow: true,
      logDir,
      promptsLogPath,
      snapshotsPath,
      rawSessionPath
    });
  }
}

module.exports = {
  startAgentwatch,
  startDashboard,
  startGui,
  parseArgs
};
