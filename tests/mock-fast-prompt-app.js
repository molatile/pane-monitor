// Simulated CLI app that displays a permission prompt and dismisses it within 500 ms

console.log('Requesting permission for:');
console.log('   echo fast-test-command');
console.log('');
console.log('Run this command?');
console.log('> 1. Yes, run command');
console.log('  2. No, cancel');
console.log('');
console.log('  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command');
console.log('esc to cancel');

// The prompt appears at t = 0 ms.
// Make it disappear at t = 200 ms (well within 500 ms).
setTimeout(() => {
  // Clear screen so the prompt is no longer visible
  process.stdout.write('\x1b[2J\x1b[H');
  console.log('[INFO] Fast prompt dismissed after 200 ms.');

  // Exit at t = 350 ms (total lifetime under 500 ms)
  setTimeout(() => {
    process.exit(0);
  }, 150);
}, 200);
