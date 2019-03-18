'use strict'

const execSync = require('child_process').execSync

if (process.env.DD_NATIVE_METRICS === 'true') {
  try {
    execSync('npm run rebuild --scripts-prepend-node-path', { stdio: [0, 1, 2] })
  } catch (e) {
    /* eslint-disable no-console */
    console.log()
    console.log([
      'Compilation of native modules failed.',
      'Falling back to JavaScript only.',
      'Some functionalities may not be available.'
    ].join(' '))
    console.log()
    /* eslint-enable no-console */
  }
}
