'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('graphql test suite', () => {
    suiteTest({
      modName: 'graphql',
      repoUrl: 'graphql/graphql-js',
      commitish: 'latest',
      testCmd: 'npm run testonly'
    })
  })
})
