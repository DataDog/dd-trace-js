'use strict'

const suiteTest = require('../../dd-trace/test/plugins/suite')

suiteTest({
  modName: 'tedious',
  repoUrl: 'tediousjs/tedious',
  commitish: 'latest',
  testCmd: 'npm run test'
})
