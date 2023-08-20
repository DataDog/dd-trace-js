import cypress from 'cypress'

await cypress.run({
  config: {
    defaultCommandTimeout: 100,
    e2e: {
      setupNodeEvents (on, config) {
        import('../ci/cypress/plugin.js').then(module => {
          module.default(on, config)
        })
      }
    },
    video: false
  },
  quiet: true
})
