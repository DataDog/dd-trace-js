// eslint-disable-next-line
if (Cypress.env('ENABLE_INCOMPATIBLE_PLUGIN')) {
  require('cypress-fail-fast')
}
require('dd-trace/ci/cypress/support')
