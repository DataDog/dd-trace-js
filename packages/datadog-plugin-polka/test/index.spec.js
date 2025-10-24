'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/integration-test-helpers')
const TestSetup = require('./test-setup')

createIntegrationTestSuite('polka', 'polka', TestSetup, {
  category: 'web-server'
}, (meta) => {
  // meta.helpers contains the test helpers for this integration type
  // Standard operations are tested automatically based on the test helper
  // TODO: Add custom test cases for non-standard operations here
})
