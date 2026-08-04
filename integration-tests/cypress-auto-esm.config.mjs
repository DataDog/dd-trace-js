import { defineConfig } from 'cypress'

export default defineConfig({
  defaultCommandTimeout: 1000,
  e2e: {
    ...(process.env.CYPRESS_TEST_ISOLATION === undefined
      ? {}
      : { testIsolation: process.env.CYPRESS_TEST_ISOLATION !== 'false' }),
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js',
  },
  video: false,
  screenshotOnRunFailure: false,
})
