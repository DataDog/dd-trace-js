'use strict'

const { getTestEnvironment } = require('../../cypress/support/test-environment')

before(function () {
  if (getTestEnvironment('ROOT_SETUP_MODE') === 'skip') {
    // Exercise a user root hook registered before Datadog's support hooks.
    this.skip()
  }
  throw new Error('root setup failed before Datadog setup')
})

require('dd-trace/ci/cypress/support')
