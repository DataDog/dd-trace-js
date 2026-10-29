'use strict'

/* global Cypress */
const { getTestEnvironment } = require('../../cypress/support/test-environment')
if (getTestEnvironment('LATE_MODE') === 'browser-partial-before-support') {
  Cypress.config('retries', { openMode: 1 })
}
if (String(getTestEnvironment('LATE_MODE')).startsWith('browser-equal-before-support')) {
  Cypress.config('retries', { runMode: 2, openMode: 0 })
}
require('dd-trace/ci/cypress/support')
