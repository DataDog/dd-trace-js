'use strict'
const suiteTest = require('../../dd-trace/test/plugins/suite')

describe('Plugin', () => {
  describe('graphql test suite', () => {
    suiteTest('graphql', 'graphql/graphql-js', 'latest')
  })
})
