'use strict'

const fs = require('node:fs')

// Backwards compatibility config: uses defineConfig AND the old manual plugin.
// When NODE_OPTIONS is set, the instrumentation wraps defineConfig and injects
// setupNodeEvents. The manual plugin call sets cypressPlugin._isInit = true,
// so the instrumentation skips its own registration to avoid double hooks.
const { defineConfig } = require('cypress')
const ddTracePlugin = require('dd-trace/ci/cypress/plugin')

function renameScreenshot (details) {
  const renamedPath = details.path.replace(/\.png$/, ' datadog-renamed.png')
  try {
    fs.unlinkSync(renamedPath)
  } catch {}
  fs.renameSync(details.path, renamedPath)
  return { path: renamedPath }
}

module.exports = defineConfig({
  defaultCommandTimeout: 1000,
  e2e: {
    setupNodeEvents (on, config) {
      if (process.env.CYPRESS_ENABLE_AFTER_RUN_CUSTOM) {
        const ddAfterRun = require('dd-trace/ci/cypress/after-run')
        on('after:run', (...args) => ddAfterRun(...args))
      }
      if (process.env.CYPRESS_ENABLE_AFTER_SPEC_CUSTOM) {
        const ddAfterSpec = require('dd-trace/ci/cypress/after-spec')
        on('after:spec', (...args) => ddAfterSpec(...args))
      }
      const resolvedConfig = ddTracePlugin(on, config)
      if (process.env.CYPRESS_ENABLE_AFTER_SCREENSHOT_CUSTOM) {
        on('after:screenshot', renameScreenshot)
      }
      return resolvedConfig
    },
    specPattern: process.env.SPEC_PATTERN || 'cypress/e2e/**/*.cy.js',
  },
  video: false,
  screenshotOnRunFailure: process.env.CYPRESS_ENABLE_FAILURE_SCREENSHOTS === 'true',
})
