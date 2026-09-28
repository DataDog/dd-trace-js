'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const { channel } = require('dc-polyfill')
const { describe, it } = require('mocha')
const sinon = require('sinon')

const log = require('../../dd-trace/src/log')
const { wrapCliConfigFileOptions, wrapConfig } = require('../src/cypress-config')

describe('Cypress config', () => {
  for (const enabled of [false, true]) {
    for (const failure of [false, true]) {
      it(`preserves before:run ordering and errors (enabled=${enabled}, failure=${failure})`, async () => {
        const project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-before-run-'))
        const setupChannel = channel('ci:cypress:setup-node-events')
        const calls = []
        const details = { cypressVersion: '14.5.4' }
        const rejection = new Error('before-run rejected')
        let cleanup
        const register = payload => {
          payload.registerBeforeRun(runDetails => {
            assert.strictEqual(runDetails, details)
            calls.push('datadog')
          })
          cleanup = payload.cleanupWrapper
          payload.registered = true
        }
        if (enabled) setupChannel.subscribe(register)
        const config = wrapConfig({
          e2e: {
            setupNodeEvents (on) {
              on('before:run', async runDetails => {
                assert.strictEqual(runDetails, details)
                await Promise.resolve()
                calls.push('first')
                if (failure) throw rejection
              })
              on('before:run', runDetails => {
                assert.strictEqual(runDetails, details)
                calls.push('second')
              })
            },
          },
        })
        const handlers = {}
        try {
          config.e2e.setupNodeEvents((event, handler) => { handlers[event] = handler }, {
            projectRoot: project, supportFile: false,
          })
          if (failure) {
            await assert.rejects(handlers['before:run'](details), error => error === rejection)
            assert.deepStrictEqual(calls, ['first'])
          } else {
            await handlers['before:run'](details)
            assert.deepStrictEqual(calls, enabled ? ['first', 'second', 'datadog'] : ['first', 'second'])
          }
        } finally {
          if (enabled) setupChannel.unsubscribe(register)
          if (cleanup) cleanup()
          else await handlers['after:run']({})
          fs.rmSync(project, { recursive: true, force: true })
        }
      })
    }
  }

  it('loads and wraps an ESM config', async () => {
    const project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-config-'))
    const configFile = join(project, 'cypress.config.mjs')
    fs.writeFileSync(configFile, `
      const setupNodeEvents = () => {}
      export default {
        marker: 'esm',
        e2e: { setupNodeEvents, originalSetupNodeEvents: setupNodeEvents },
      }
    `)

    const wrapped = wrapCliConfigFileOptions({ project, configFile })
    try {
      const { default: config } = await import(pathToFileURL(wrapped.options.configFile))

      assert.strictEqual(config.marker, 'esm')
      assert.notStrictEqual(config.e2e.setupNodeEvents, config.e2e.originalSetupNodeEvents)
      assert.strictEqual(config.e2e.setupNodeEvents.name, 'ddSetupNodeEvents')
    } finally {
      wrapped.cleanup()
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('loads and wraps a CommonJS config', () => {
    const project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-config-'))
    const configFile = join(project, 'cypress.config.cjs')
    fs.writeFileSync(configFile, `
      const setupNodeEvents = () => {}
      module.exports = {
        marker: 'commonjs',
        e2e: { setupNodeEvents, originalSetupNodeEvents: setupNodeEvents },
      }
    `)

    const wrapped = wrapCliConfigFileOptions({ project, configFile })
    try {
      const config = require(wrapped.options.configFile)

      assert.strictEqual(config.marker, 'commonjs')
      assert.notStrictEqual(config.e2e.setupNodeEvents, config.e2e.originalSetupNodeEvents)
      assert.strictEqual(config.e2e.setupNodeEvents.name, 'ddSetupNodeEvents')
    } finally {
      wrapped.cleanup()
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  it('reports every failed config-wrapper location', () => {
    const project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-config-'))
    const configDirectory = join(project, 'config')
    const configFile = join(configDirectory, 'cypress.config.cjs')
    const options = { project, configFile }
    fs.mkdirSync(configDirectory)
    fs.writeFileSync(configFile, 'module.exports = {}')
    const warn = sinon.stub(log, 'warn')
    const openSync = sinon.stub(fs, 'openSync').throws()

    try {
      const wrapped = wrapCliConfigFileOptions(options)

      assert.strictEqual(wrapped.options, options)
      assert.match(warn.firstCall.args[2], /; /)
    } finally {
      openSync.restore()
      warn.restore()
      fs.rmSync(project, { recursive: true, force: true })
    }
  })
})
