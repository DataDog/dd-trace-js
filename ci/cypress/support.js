'use strict'

/* global Cypress */

const root = Cypress.mocha.getRootSuite()
const installed = Symbol.for('dd-trace.cypress.support-installed')

if (!root[installed]) {
  require('../../packages/datadog-plugin-cypress/src/support')
  root[installed] = true
}
