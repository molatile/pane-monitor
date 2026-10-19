#!/usr/bin/env node

const { startAgentwatch } = require('./src/agentwatch');
const { getProfileForCommand } = require('./src/profile');

function printUsage() {
  console.error('Usage: spike [--record] <command> [args...]');
  console.error('Example: spike agy');
  console.error('         spike powershell');
  console.error('         spike cmd /c dir');
  process.exit(1);
}

let args = process.argv.slice(2);
let record = true; // Enabled by default when invoked via spike for full backwards compatibility
if (args[0] === '--no-record') {
  record = false;
  args = args.slice(1);
} else if (args[0] === '--record') {
  record = true;
  args = args.slice(1);
}

if (args.length === 0) {
  printUsage();
}

const command = args[0];
const commandArgs = args.slice(1);

const instance = startAgentwatch({
  command,
  args: commandArgs,
  profile: getProfileForCommand(command) || getProfileForCommand('agy'),
  record
});

module.exports = {
  isScreenStable: () => true,
  saveScreenSnapshot: () => instance && instance.saveScreenSnapshot && instance.saveScreenSnapshot(),
  inspectScreenForPrompts: () => instance && instance.inspectScreenForPrompts && instance.inspectScreenForPrompts()
};
