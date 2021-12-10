'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

suiteTest({
  modName: 'pino',
  repoUrl: 'pinojs/pino',
  commitish: 'latest',
  testCmd: 'node_modules/.bin/tap test/*test.js test/*/*test.js --no-coverage',
  parallel: false
})
