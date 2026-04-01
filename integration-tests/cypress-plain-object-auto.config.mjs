// Plain object config without defineConfig and without manual plugin.
// Relies solely on the CLI wrapper to inject setupNodeEvents.
export default {
  defaultCommandTimeout: 1000,
  e2e: {
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js',
    supportFile: 'cypress/support/e2e.js',
  },
  video: false,
  screenshotOnRunFailure: false,
}
