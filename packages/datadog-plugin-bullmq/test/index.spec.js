'use strict'

const { createIntegrationTestSuite } = require('../../dd-trace/test/setup/helpers/integration')
const TestSetup = require('./test-setup')

createIntegrationTestSuite('bullmq', 'bullmq', TestSetup, {
  pluginType: 'messaging'
}, (meta) => {
  // meta.helpers contains the test helpers for this integration type
  // TODO: Add any custom test cases here.
})
