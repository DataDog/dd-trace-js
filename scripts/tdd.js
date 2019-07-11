'use strict'

const execSync = require('child_process').execSync
const fs = require('fs')
const path = require('path')

const target = process.argv[2]
const base = path.join(__dirname, '..', 'packages')
const globs = [
  'packages/dd-trace/test/setup/*.js'
].map(glob => `'${glob}'`).join(' ')

const options = { stdio: [0, 1, 2] }
const command = `yarn services && NO_DEPRECATION=* mocha --watch --inspect-brk=9229`

if (fs.existsSync(path.join(base, `datadog-plugin-${target}`))) {
  execSync(`PLUGINS=${target} ${command} ${globs} 'packages/datadog-plugin-${target}/test/**/*.spec.js'`, options)
} else if (target) {
  execSync(`${command} ${globs} '${target}'`, options)
} else {
  execSync(`${command} ${globs} 'packages/dd-trace/test/**/*.spec.js'`, options)
}
