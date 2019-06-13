'use strict'

const execSync = require('child_process').execSync

const arg = process.argv[2]
const target = arg ? `datadog-plugin-${arg}` : 'dd-trace'
const globs = [
  'packages/dd-trace/test/setup/**/*.js',
  `packages/${target}/test/**/*.spec.js`
].map(glob => `'${glob}'`)

const options = { stdio: [0, 1, 2] }
const command = `yarn services && NO_DEPRECATION=* mocha --watch ${globs.join(' ')}`

execSync(command, options)
