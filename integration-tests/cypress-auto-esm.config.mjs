import { defineConfig } from 'cypress'

export default defineConfig({
  defaultCommandTimeout: 1000,
  e2e: {
    testIsolation: process.env.CYPRESS_TEST_ISOLATION !== 'false',
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js',
  },
  video: false,
  screenshotOnRunFailure: false,
})
