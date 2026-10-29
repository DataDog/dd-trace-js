'use strict'

const { join } = require('node:path')
const { defineConfig } = require('cypress')
const getCypressTestEnvironment = require('../../cypress-test-environment')

module.exports = defineConfig({
  ...getCypressTestEnvironment({ LATE_MODE: process.env.CYPRESS_LATE_NATIVE_RETRIES_MODE }),
  retries: {
    runMode: process.env.CYPRESS_LATE_NATIVE_RETRIES_MODE === 'during-init-partial' ? 2 : 0,
    openMode: 0,
  },
  video: false,
  screenshotOnRunFailure: false,
  e2e: {
    specPattern: process.env.CYPRESS_LATE_NATIVE_RETRIES_MODE?.includes('-reuse')
      ? [join(__dirname, 'retries.cy.js'), join(__dirname, 'support-reuse.cy.js')]
      : join(__dirname, 'retries.cy.js'),
    supportFile: join(__dirname, 'support.js'),
    async setupNodeEvents (on, config) {
      const plugin = require('dd-trace/ci/cypress/plugin')
      const mode = process.env.CYPRESS_LATE_NATIVE_RETRIES_MODE
      const pending = plugin(on, config)
      if (mode === 'during-init') config.retries.runMode = 2
      if (mode === 'during-init-partial') config.retries = { openMode: 1 }
      const result = await pending
      if (mode === 'equal-object' || mode === 'browser-partial-before-support') {
        result.retries = { runMode: 2, openMode: 0 }
      } else if (mode === 'saved-reference' || mode === 'saved-reference-changed') {
        const saved = result.retries
        result.retries = 1
        if (mode === 'saved-reference-changed') saved.runMode = 2
        result.retries = saved
      } else if (mode?.startsWith('returned-experimental')) {
        return {
          retries: {
            runMode: true,
            openMode: false,
            experimentalStrategy: 'detect-flake-but-always-fail',
            experimentalOptions: { maxRetries: 2, stopIfAnyPassed: false },
          },
        }
      } else if (mode?.startsWith('browser-equal-before-support-returned')) {
        return {
          retries: { openMode: 0 },
          ...(mode.includes('-alternate') && { supportFile: join(__dirname, 'support-alternate.js') }),
        }
      } else if (mode?.startsWith('after-handoff')) {
        on('before:run', () => { result.retries.runMode = 2 })
      } else if (mode === 'equal-nested') result.retries.runMode = 2
      else if (mode === 'open-only') result.retries.openMode = 1
      else if (mode?.startsWith('returned-open')) return { retries: { openMode: 1 } }
      else if (mode === 'spread-open') {
        result.retries.openMode = 1
        return { ...result }
      } else if (mode?.startsWith('returned-object')) return { retries: { runMode: 2, openMode: 0 } }
      else if (!['unchanged', 'during-init', 'during-init-partial'].includes(mode) &&
        !mode?.startsWith('browser-equal-before-support') &&
        mode !== 'browser-queued-native-before-support') result.retries = 2
      return result
    },
  },
})
