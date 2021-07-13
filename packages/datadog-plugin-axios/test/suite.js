'use strict'

const suiteTest = require('../../dd-trace/test/plugins/suite')

suiteTest({
  modName: 'axios',
  repoUrl: 'axios/axios',
  commitish: 'latest',
  testCmd: 'node_modules/.bin/grunt mochaTest',
  parallel: false
})
