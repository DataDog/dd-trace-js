/* eslint-disable */
const coverage = require('../../ci-visibility/fixtures/istanbul-map-fixture.json')

const TEST_PAGE_URL = 'http://test-page.dd-trace.invalid/'

const TEST_PAGE_HTML = `<!DOCTYPE html>
<html>
  <head><title>Hello World</title></head>
  <body>
    <div class="hello-world">Hello World</div>
  </body>
  <script>
    window.DD_RUM = {
      getInternalContext: () => true,
      stopSession: () => true,
    }
    window.__coverage__ = ${JSON.stringify(coverage)}
  </script>
</html>`

// Stub the page response inside the Cypress proxy so the navigation never
// leaves Cypress' Node process. Removes the localhost HTTP round trip whose
// `cy.visit()` flake is documented at https://github.com/cypress-io/cypress/issues/27119.
Cypress.Commands.add('visitTestPage', () => {
  cy.intercept('GET', `${TEST_PAGE_URL}**`, {
    headers: { 'Content-Type': 'text/html' },
    body: TEST_PAGE_HTML,
  })
  return cy.visit(TEST_PAGE_URL)
})

if (Cypress.env('ENABLE_INCOMPATIBLE_PLUGIN')) {
  require('cypress-fail-fast')
}
require('dd-trace/ci/cypress/support')
