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

/**
 * @param {Function} on Cypress event registration function
 * @param {object} config Cypress configuration
 * @returns {object|Promise<object>} resolved Cypress configuration
 */
function registerPlugin (on, config) {
  if (!process.env.CYPRESS_SIMULATE_OLD_MANUAL_PLUGIN) return ddTracePlugin(on, config)

  return ddTracePlugin((event, handler) => {
    if (event === 'after:screenshot' && process.env.CYPRESS_SIMULATE_PRE_SCREENSHOT_MANUAL_PLUGIN) {
      // Versions before failure-screenshot support did not register this handler.
    } else if (event === 'after:spec') {
      on(event, (spec, results) => handler(spec, results))
    } else if (event === 'after:run') {
      on(event, results => handler(results))
    } else {
      on(event, handler)
    }
  }, config)
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
      if (process.env.CYPRESS_REJECT_AFTER_SPEC_BEFORE_PLUGIN) {
        on('after:spec', () => Promise.reject(new Error('manual after:spec failed before Datadog')))
      }
      const resolvedConfig = registerPlugin(on, config)
      if (process.env.CYPRESS_REJECT_AFTER_RUN_AFTER_PLUGIN) {
        on('after:run', () => Promise.reject(new Error('manual after:run failed after Datadog')))
      }
      if (process.env.CYPRESS_REJECT_AFTER_SPEC_AFTER_PLUGIN) {
        on('after:spec', () => Promise.reject(new Error('manual after:spec failed after Datadog')))
      }
      if (process.env.CYPRESS_ENABLE_AFTER_SPEC_USER) {
        on('after:spec', () => {
          // eslint-disable-next-line no-console
          console.log('[custom:after:spec:manual]')
        })
      }
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
