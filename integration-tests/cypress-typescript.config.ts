import { defineConfig } from 'cypress'

export default defineConfig({
  defaultCommandTimeout: 1000,
  e2e: {
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js',
    supportFile: 'cypress/support/e2e.js',
  },
  video: false,
  screenshotOnRunFailure: false,
})
