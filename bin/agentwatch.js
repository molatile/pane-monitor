#!/usr/bin/env node

const { startAgentwatch } = require('../src/agentwatch');
const { startDashboard } = require('../src/dashboard');
const { startGui } = require('../src/gui');

function printUsage() {
  console.error('Usage: agentwatch [--auto] [--record] [--quiet] <command> [args...]');
  console.error('       agentwatch dash [--quiet]');
  console.error('       agentwatch gui [--quiet] [--restart]');
  console.error('Example: agentwatch agy');
  console.error('         agentwatch --auto agy');
  console.error('         agentwatch dash');
  console.error('         agentwatch gui');
  console.error('         agentwatch gui --restart');
  process.exit(1);
}

function parseArgs(argv = process.argv.slice(2)) {
  let record = false;
  let quiet = false;
  let auto = undefined;
  let restart = false;
  const filteredArgs = [];

  for (const arg of argv) {
    if (arg === '--record') {
      record = true;
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else if (arg === '--auto') {
      auto = true;
    } else if (arg === '--no-auto') {
      auto = false;
    } else if (arg === '--restart') {
      restart = true;
    } else {
      filteredArgs.push(arg);
    }
  }

  return {
    record,
    quiet,
    auto,
    restart,
    command: filteredArgs[0] || null,
    commandArgs: filteredArgs.slice(1)
  };
}

if (require.main === module) {
  const { record, quiet, auto, restart, command, commandArgs } = parseArgs();

  if (!command) {
    printUsage();
  }

  if (command === 'dash') {
    startDashboard({ quiet });
  } else if (command === 'gui') {
    startGui({ quiet, focus: true, restart });
  } else {
    startAgentwatch({
      command,
      args: commandArgs,
      record,
      quiet,
      auto,
      autoOpenWindow: true
    });
  }
}

module.exports = {
  startAgentwatch,
  startDashboard,
  startGui,
  parseArgs
};
