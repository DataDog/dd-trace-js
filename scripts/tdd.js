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
const command = `yarn services && NO_DEPRECATION=* mocha --watch --inspect`

if (fs.existsSync(path.join(base, `datadog-plugin-${target}`))) {
  execSync(`PLUGINS=${target} ${command} ${globs} 'packages/datadog-plugin-${target}/test/**/*.spec.js'`, options)
} else {
  execSync(`${command} ${globs} '${target}'`, options)
}
