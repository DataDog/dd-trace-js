'use strict'

/* global Cypress */

const { getTestEnvironment } = require('../../cypress/support/test-environment')

if (getTestEnvironment('LATE_MODE') === 'browser-equal-before-support-reuse-preloaded') {
  Cypress.config('retries', { runMode: 2, openMode: 0 })
}
require('dd-trace/ci/cypress/support')
