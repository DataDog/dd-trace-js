/* eslint-disable */
const coverage = require('../../../fixtures/istanbul-map-fixture.json')

const TEST_PAGE_URL = 'http://test-page.dd-trace.invalid/'

const TEST_PAGE_HTML = `<!DOCTYPE html>
<html>
  <head><title>Hello World</title></head>
  <body>
    <div class="hello-world">Hello World</div>
  </body>
  <script>
    window.__coverage__ = ${JSON.stringify(coverage)}
  </script>
</html>`

// Stub the page response inside the Cypress proxy so the navigation never
// leaves Cypress' Node process. Mirrors the main sandbox `cy.visitTestPage()`
// without dragging in its `cypress-fail-fast` branch, which the subproject
// does not install.
Cypress.Commands.add('visitTestPage', () => {
  cy.intercept('GET', `${TEST_PAGE_URL}**`, {
    headers: { 'Content-Type': 'text/html' },
    body: TEST_PAGE_HTML,
  })
  return cy.visit(TEST_PAGE_URL)
})

require('dd-trace/ci/cypress/support')
