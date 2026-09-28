'use strict'

const { defineConfig } = require('cypress')

module.exports = defineConfig({
  video: false,
  screenshotOnRunFailure: false,
  e2e: {
    specPattern: 'cypress/e2e/before-run.js',
    setupNodeEvents (on, config) {
      const calls = []
      on('before:run', details => {
        if (!details.cypressVersion) throw new Error('Missing Cypress run details')
        calls.push('first')
      })
      on('before:run', async details => {
        await new Promise(resolve => setImmediate(resolve))
        if (!details.cypressVersion) throw new Error('Missing Cypress run details')
        if (process.env.CYPRESS_REJECT_BEFORE_RUN) throw new Error('custom before:run failed')
        calls.push('second')
      })
      on('task', { beforeRunOrder: () => calls })
      if (process.env.CYPRESS_MANUAL_PLUGIN) {
        const createPlugin = require('dd-trace/ci/cypress/plugin')
        return createPlugin(on, config)
      }
      return config
    },
  },
})
