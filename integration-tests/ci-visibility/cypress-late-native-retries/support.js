'use strict'

/* global Cypress */
const { getTestEnvironment } = require('../../cypress/support/test-environment')
if (getTestEnvironment('LATE_MODE') === 'browser-partial-before-support') {
  Cypress.config('retries', { openMode: 1 })
}
require('dd-trace/ci/cypress/support')
