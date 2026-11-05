'use strict'

const { join } = require('node:path')
const { defineConfig } = require('cypress')
const getCypressTestEnvironment = require('../../cypress-test-environment')

const mode = process.env.CYPRESS_LATE_NATIVE_RETRIES_MODE
const reuse = mode === 'browser-equal-before-support-reuse-preloaded'

module.exports = defineConfig({
  ...getCypressTestEnvironment({ LATE_MODE: mode }),
  retries: { runMode: 0, openMode: 0 },
  video: false,
  screenshotOnRunFailure: false,
  e2e: {
    specPattern: reuse
      ? [join(__dirname, 'retries.cy.js'), join(__dirname, 'support-reuse.cy.js')]
      : join(__dirname, 'retries.cy.js'),
    supportFile: join(__dirname, mode === 'indirect-returned-support' ? 'support-indirect.js' : 'support.js'),
    async setupNodeEvents (on, config) {
      const plugin = require('dd-trace/ci/cypress/plugin')
      await plugin(on, config)
      if (mode === 'returned-json') {
        let reads = 0
        on('before:run', () => {
          require('node:fs').writeFileSync(join(config.projectRoot, 'returned-retry-json-reads.json'),
            JSON.stringify({ reads }))
        })
        return { retries: { toJSON () { reads++; return { runMode: 3 + reads } } } }
      }
      return { retries: reuse ? { openMode: 0 } : 2 }
    },
  },
})
