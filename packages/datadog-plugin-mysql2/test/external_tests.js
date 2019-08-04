'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'mysql2',
  repo: 'https://github.com/sidorares/node-mysql2',
  testType: 'custom',
  testFn: function (tracerSetupPath, options) {
    try {
      execSync(`npm run env --silent -- node -r '${tracerSetupPath}' test/run.js`, options)
    } catch (error) {} // eslint-disable-line no-empty
  },
  testEnv: {
    'CI': 1,
    'MYSQL_DATABASE': 'db',
    'MYSQL_HOST': 'localhost',
    'MYSQL_PORT': 3306,
    'MYSQL_USER': 'root',
    'MYSQL_PASSWORD': '',
    '_DD_PATCH_SPAWN': true
  }
}

const testConfigs = []

module.exports = {
  defaultConfig,
  testConfigs
}
