'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

suiteTest({
  modName: 'graphql',
  repoUrl: 'graphql/graphql-js',
  commitish: 'latest',
  testCmd: 'npm run testonly'
})
