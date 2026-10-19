// Simulated CLI app that displays real Antigravity permission prompt

console.log('Requesting permission for:');
console.log('   echo');
console.log('this-is-a-long-test-message-to-check-how-wrapping-works-in-the-permission-prompt-one-two-three-four-five-six');
console.log('-seven-eight-nine-ten-eleven-twelve-thirteen-fourteen-fifteen');
console.log('');
console.log('Run this command?');
console.log('> 1. Yes, run command');
console.log("  2. Yes, and always allow in this conversation for commands that start with 'echo");
console.log('this-is-a-long-test-message-to-');
console.log("  check-how-wrapping-works-in-the-permission-p...'");
console.log("  3. Yes, and always allow for commands that start with 'echo");
console.log('this-is-a-long-test-message-to-check-how-wrapping-');
console.log("  works-in-the-permission-p...' (Persist to settings.json)");
console.log('  4. No, cancel');
console.log('');
console.log('  ↑/↓ Navigate · tab Amend · ctrl+g edit/expand command');
console.log('esc to cancel                         Gemini 3.8 Flash · high');

// Wait 3.5 seconds to give spike's 1-second interval timer time to inspect the rebuilt screen
setTimeout(() => {
  console.log('\n\x1b[36m[INFO] Mock CLI completed.\x1b[0m');
  process.exit(0);
}, 3500);
