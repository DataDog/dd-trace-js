'use strict'

const execSync = require('child_process').execSync
const fs = require('fs')
const path = require('path')

const base = path.join(__dirname, '..', 'packages')
const globs = [
  'packages/dd-trace/test/setup/*.js'
].map(glob => `'${glob}'`).join(' ')

let target
const args = process.argv.slice(2).map((arg) => {
  if (fs.existsSync(path.join(base, `datadog-plugin-${arg}`))) {
    target = arg
    return `'packages/datadog-plugin-${arg}/test/**/*.spec.js'`
  }
  return arg
}).join(' ')

const options = { stdio: [0, 1, 2] }
const command = `yarn services && NO_DEPRECATION=* mocha --watch`

if (target) {
  execSync(`PLUGINS=${target} ${command} ${globs} ${args}`, options)
} else {
  execSync(`${command} ${globs} ${args}`, options)
}
