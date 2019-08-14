'use strict'

const execSync = require('child_process').execSync

const defaultConfig = {
  integration: 'pg',
  repo: 'https://github.com/brianc/node-postgres',
  testType: 'custom',
  testFn: function (tracerSetupPath, options) {
    const connectionString = 'pg://postgres:postgres@127.0.0.1:5432/postgres?application_name=test'
    const nodeCmd = `xargs -n 1 -I file node -r '${tracerSetupPath}' file ${connectionString}`

    try {
      // Create test tables
      execSync(`npm run env -- node -r ${tracerSetupPath} script/create-test-tables.js ${connectionString}`, options)

      // Run tests
      execSync(`find test/ -name "*-tests.js" -not -path "test/native/*" | ${nodeCmd}`, options)
    } catch (error) {} // eslint-disable-line no-empty
  },
  testEnv: {
    'PGUSER': 'postgres',
    'PGPASSWORD': 'postgres',
    'PGDATABASE': 'postgres',
    'PGAPPNAME': 'test'
  }
}

module.exports = {
  defaultConfig
}
