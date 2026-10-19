'use strict'

/* global Cypress */

before(function () {
  if (Cypress.env('ROOT_SETUP_MODE') === 'skip') {
    // Exercise a user root hook registered before Datadog's support hooks.
    this.skip()
  }
  throw new Error('root setup failed before Datadog setup')
})

require('dd-trace/ci/cypress/support')
