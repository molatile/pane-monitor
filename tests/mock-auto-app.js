// Simulated CLI app that displays an Antigravity permission prompt
// and terminates immediately upon receiving an option key on stdin.

const fs = require('fs');

if (process.env.MOCK_AGENT_ARGS_FILE) {
  try {
    fs.writeFileSync(process.env.MOCK_AGENT_ARGS_FILE, JSON.stringify(process.argv.slice(2)), 'utf8');
  } catch (e) {}
}

console.log('Requesting permission for:');
console.log('   echo test-mock-auto-accept');
console.log('');
console.log('Run this command?');
console.log('> 1. Yes, run command');
console.log('  2. No, cancel');
console.log('');
console.log('  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command');
console.log('esc to cancel');

if (process.stdin.isTTY && process.stdin.setRawMode) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

let closed = false;

process.stdin.on('data', (chunk) => {
  if (closed) return;
  const str = chunk.toString();
  if (str.includes('1')) {
    closed = true;
    console.log('\n[INFO] Mock prompt app accepted via key 1!');
    process.exit(0);
  } else if (str.includes('2') || str.includes('\x1b')) {
    closed = true;
    console.log('\n[INFO] Mock prompt app cancelled.');
    process.exit(0);
  }
});

// Fallback timeout
setTimeout(() => {
  if (!closed) {
    closed = true;
    console.log('\n[WARN] Mock prompt app timed out.');
    process.exit(1);
  }
}, 8000);
