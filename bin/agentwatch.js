#!/usr/bin/env node

const { startAgentwatch } = require('../src/agentwatch');
const { startDashboard } = require('../src/dashboard');
const { startGui } = require('../src/gui');

function printUsage() {
  console.error('Usage: agentwatch [--record] [--quiet] <command> [args...]');
  console.error('       agentwatch dash [--quiet]');
  console.error('       agentwatch gui [--quiet]');
  console.error('Example: agentwatch agy');
  console.error('         agentwatch dash');
  console.error('         agentwatch gui');
  console.error('         agentwatch gui --quiet');
  process.exit(1);
}

function parseArgs(argv = process.argv.slice(2)) {
  let record = false;
  let quiet = false;
  const filteredArgs = [];

  for (const arg of argv) {
    if (arg === '--record') {
      record = true;
    } else if (arg === '--quiet' || arg === '-q') {
      quiet = true;
    } else {
      filteredArgs.push(arg);
    }
  }

  return {
    record,
    quiet,
    command: filteredArgs[0] || null,
    commandArgs: filteredArgs.slice(1)
  };
}

const { record, quiet, command, commandArgs } = parseArgs();

if (require.main === module) {
  if (!command) {
    printUsage();
  }

  if (command === 'dash') {
    startDashboard({ quiet });
  } else if (command === 'gui') {
    startGui({ quiet, focus: true });
  } else {
    startAgentwatch({
      command,
      args: commandArgs,
      record,
      quiet,
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
