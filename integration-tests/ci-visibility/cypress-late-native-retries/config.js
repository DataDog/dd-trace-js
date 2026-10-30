'use strict'

const { join } = require('node:path')
const { defineConfig } = require('cypress')
const getCypressTestEnvironment = require('../../cypress-test-environment')

module.exports = defineConfig({
  ...getCypressTestEnvironment({ LATE_MODE: process.env.CYPRESS_LATE_NATIVE_RETRIES_MODE }),
  retries: process.env.CYPRESS_LATE_NATIVE_RETRIES_MODE?.startsWith('node-saved-options')
    ? {
        runMode: true,
        openMode: false,
        experimentalStrategy: 'detect-flake-but-always-fail',
        experimentalOptions: { maxRetries: 2, stopIfAnyPassed: false },
      }
    : process.env.CYPRESS_LATE_NATIVE_RETRIES_MODE === 'numeric-open'
      ? 2
      : {
          runMode: [
            'during-init-partial', 'freeze-during-init', 'readonly-before-init',
            'getter-before-init', 'getter-during-init',
          ]
            .includes(process.env.CYPRESS_LATE_NATIVE_RETRIES_MODE)
            ? 2
            : 0,
          openMode: 0,
        },
  video: false,
  screenshotOnRunFailure: false,
  e2e: {
    specPattern: process.env.CYPRESS_LATE_NATIVE_RETRIES_MODE?.includes('-reuse')
      ? [join(__dirname, 'retries.cy.js'), join(__dirname, 'support-reuse.cy.js')]
      : join(__dirname, 'retries.cy.js'),
    supportFile: join(__dirname, process.env.CYPRESS_LATE_NATIVE_RETRIES_MODE?.includes('indirect')
      ? 'support-indirect.js'
      : 'support.js'),
    async setupNodeEvents (on, config) {
      const plugin = require('dd-trace/ci/cypress/plugin')
      const mode = process.env.CYPRESS_LATE_NATIVE_RETRIES_MODE
      if (mode === 'readonly-before-init') {
        Object.defineProperty(config, 'retries', { writable: false, configurable: false })
      }
      if (mode === 'getter-before-init') {
        const native = config.retries
        Object.defineProperty(config, 'retries', { get: () => native, enumerable: true, configurable: false })
      }
      const pending = plugin(on, config)
      if (mode === 'getter-during-init') {
        const native = config.retries
        Object.defineProperty(config, 'retries', { get: () => native, enumerable: true, configurable: false })
      }
      if (mode === 'during-init') config.retries.runMode = 2
      if (mode === 'during-init-partial') config.retries = { openMode: 1 }
      if (mode === 'freeze-during-init') Object.freeze(config)
      const result = await pending
      if (mode === 'freeze-during-init' || mode === 'readonly-before-init' || mode?.startsWith('getter-')) return result
      if (mode === 'freeze-retries' || mode === 'seal-retries') {
        if (mode === 'freeze-retries') Object.freeze(result.retries)
        else Object.seal(result.retries)
        return result
      }
      if (mode?.startsWith('node-saved-options')) {
        const saved = result.retries.experimentalOptions
        result.retries.experimentalOptions = { maxRetries: 1, stopIfAnyPassed: false }
        if (mode.endsWith('-descriptor')) Object.defineProperty(result.retries, 'experimentalOptions', { value: saved })
        else result.retries.experimentalOptions = saved
        return result
      }
      if (mode?.startsWith('returned-getter')) {
        let reads = 0
        on('before:run', () => {
          require('node:fs').writeFileSync(join(config.projectRoot, 'returned-retry-getter-reads.json'),
            JSON.stringify({ reads }))
        })
        return { get retries () { return ++reads } }
      }
      if (mode === 'indirect-returned-support') return { retries: 2 }
      if (mode === 'numeric-open') {
        if (typeof result.retries === 'number') {
          result.retries = { runMode: result.retries, openMode: result.retries }
        }
        result.retries.openMode = 1
      } else if (mode === 'raw-reference') {
        const raw = { runMode: 1, openMode: 0 }
        result.retries = raw
        raw.runMode = 2
      } else if (mode === 'equal-object' || mode === 'browser-partial-before-support') {
        result.retries = { runMode: 2, openMode: 0 }
      } else if (mode === 'root-deleted-alias') {
        const saved = result.retries
        delete result.retries
        result.retries = saved
        saved.runMode = 2
      } else if (mode?.startsWith('root-deleted') || mode === 'root-redefined') {
        result.retries = 2
        delete result.retries
        if (mode === 'root-deleted-returned') return { retries: 2 }
        if (mode === 'root-deleted-partial') return { retries: { openMode: 1 } }
        if (mode === 'root-redefined') {
          Object.defineProperty(result, 'retries', { value: 2, writable: true, configurable: true, enumerable: true })
        }
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
