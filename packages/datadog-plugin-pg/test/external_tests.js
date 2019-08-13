'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'pg',
  repo: 'https://github.com/brianc/node-postgres',
  testType: 'custom',
  testFn: function (tracerSetupPath, options) {
    const connectionString = 'postgres://'
    const nodeCmd = `xargs -n 1 -I file node -r '${tracerSetupPath}' file ${connectionString}`
    try {
      execSync(`find test/unit -name "*-tests.js" | ${nodeCmd}`, options)
    } catch (error) {} // eslint-disable-line no-empty
  }
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
