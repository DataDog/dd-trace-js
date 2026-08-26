import fs from 'node:fs'

import { defineConfig } from 'cypress'
import ddTracePlugin from 'dd-trace/ci/cypress/plugin.js'

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

export default defineConfig({
  defaultCommandTimeout: 1000,
  e2e: {
    async setupNodeEvents (on, config) {
      if (process.env.CYPRESS_ENABLE_AFTER_RUN_CUSTOM) {
        const { default: ddAfterRun } = await import('dd-trace/ci/cypress/after-run.js')
        on('after:run', (...args) => ddAfterRun(...args))
      }
      if (process.env.CYPRESS_ENABLE_AFTER_SPEC_CUSTOM) {
        const { default: ddAfterSpec } = await import('dd-trace/ci/cypress/after-spec.js')
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
