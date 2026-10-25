const bcrypt = require('bcryptjs');

function readHiddenPassword() {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
    throw new Error('Run this command in an interactive terminal so the password can be entered privately.');
  }

  return new Promise((resolve, reject) => {
    let password = '';
    process.stdout.write('Enter an admin password (at least 12 characters): ');
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    function finish(error) {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      process.stdout.write('\n');
      if (error) reject(error);
      else resolve(password);
    }

    function onData(character) {
      if (character === '\u0003') {
        finish(new Error('Password generation cancelled.'));
      } else if (character === '\r' || character === '\n') {
        finish();
      } else if (character === '\u007f' || character === '\b') {
        password = password.slice(0, -1);
      } else if (character >= ' ') {
        password += character;
      }
    }

    process.stdin.on('data', onData);
  });
}

async function main() {
  const password = await readHiddenPassword();
  if (password.length < 12) {
    throw new Error('Use an admin password with at least 12 characters.');
  }
  const hash = await bcrypt.hash(password, 12);
  process.stdout.write(`ADMIN_PASSWORD_HASH=${hash}\n`);
  process.stdout.write('Copy this hash into .env. The password itself was not saved.\n');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
