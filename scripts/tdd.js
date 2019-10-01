'use strict'

const execSync = require('child_process').execSync
const fs = require('fs')
const path = require('path')

const options = { stdio: [0, 1, 2] }
const command = 'yarn services && NO_DEPRECATION=* mocha --watch --expose-gc'

const base = path.join(__dirname, '..', 'packages')
const globs = [
  'packages/dd-trace/test/setup/node.js'
].map(glob => `'${glob}'`).join(' ')

const pluginName = /\/?datadog-plugin-([\w -]+)\/?/
const plugins = []
const args = process.argv.slice(2).map((arg) => {
  if (fs.existsSync(path.join(base, `datadog-plugin-${arg}`))) {
    plugins.push(arg)
    return `'packages/datadog-plugin-${arg}/test/**/*.spec.js'`
  } else if (pluginName.test(arg)) {
    const plugin = arg.match(pluginName)[1]
    plugins.push(plugin)
  }
  return arg
}).join(' ')

const pluginEnvList = plugins.join('|')

if (plugins) {
  execSync(`PLUGINS=${pluginEnvList} ${command} ${globs} ${args}`, options)
} else {
  execSync(`${command} ${globs} ${args}`, options)
}
