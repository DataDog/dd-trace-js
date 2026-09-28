'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const { channel } = require('dc-polyfill')
const { afterEach, beforeEach, describe, it } = require('mocha')
const sinon = require('sinon')

const log = require('../../dd-trace/src/log')
const { wrapCliConfigFileOptions, wrapConfig } = require('../src/cypress-config')

describe('Cypress before:run handlers', () => {
  const setupChannel = channel('ci:cypress:setup-node-events')
  let project, resolved, handlers, register, cleanup

  beforeEach(() => {
    project = fs.mkdtempSync(join(tmpdir(), 'dd-cypress-before-run-'))
    resolved = { projectRoot: project, supportFile: false, isInteractive: false }
    handlers = {}
    register = cleanup = undefined
  })

  afterEach(async () => {
    if (register) setupChannel.unsubscribe(register)
    resolved.isInteractive = false
    try {
      if (cleanup) cleanup()
      else await handlers['after:run']?.({})
    } finally {
      fs.rmSync(project, { recursive: true, force: true })
    }
  })

  /**
   * Register the same hooks through the automatic or manual plugin entry point.
   * @param {string} mode
   * @param {(details: object) => unknown} first
   * @param {(details: object) => unknown} datadog
   * @param {(details: object) => unknown} [last]
   */
  function setupHandlers (mode, first, datadog, last = () => {}) {
    if (mode === 'auto') {
      register = payload => {
        payload.registerBeforeRun(datadog)
        payload.on('after:run', payload.cleanupWrapper)
        cleanup = payload.cleanupWrapper
        payload.registered = true
      }
      setupChannel.subscribe(register)
    }
    const config = wrapConfig({
      e2e: {
        setupNodeEvents (on) {
          on('before:run', first)
          if (mode === 'manual') {
            on('before:run', datadog)
            on('after:spec', () => {})
            on('after:run', () => {})
            on('task', {
              'dd:testSuiteStart': () => {},
              'dd:beforeEach': () => {},
              'dd:afterEach': () => {},
              'dd:addTags': () => {},
            })
          }
          on('before:run', last)
        },
      },
    })
    config.e2e.setupNodeEvents((event, handler) => { handlers[event] = handler }, resolved)
  }

  for (const mode of ['disabled', 'auto', 'manual']) {
    for (const failure of [false, 'first', 'second']) {
      it(`preserves before:run ordering and errors (mode=${mode}, failure=${failure})`, async () => {
        const calls = []
        const details = { cypressVersion: '14.5.4' }
        const rejection = new Error('before-run rejected')
        const datadogHandler = runDetails => {
          assert.strictEqual(runDetails, details)
          calls.push('datadog')
        }
        const userHandler = name => async runDetails => {
          assert.strictEqual(runDetails, details)
          await Promise.resolve()
          calls.push(name)
          if (failure === name) throw rejection
        }
        setupHandlers(mode, userHandler('first'), datadogHandler, userHandler('second'))

        if (failure) {
          await assert.rejects(handlers['before:run'](details), error => error === rejection)
          assert.deepStrictEqual(calls, failure === 'first' ? ['first'] : ['first', 'second'])
        } else {
          await handlers['before:run'](details)
          assert.deepStrictEqual(calls, mode === 'disabled' ? ['first', 'second'] : ['first', 'second', 'datadog'])
        }
      })
    }
  }

  for (const mode of ['auto', 'manual']) {
    for (const isInteractive of [false, true]) {
      for (const failingHandler of ['user', 'datadog']) {
        it(`retains interactive support after setup fails (${mode}, interactive=${isInteractive}, ${failingHandler})`,
          async () => {
            const rejection = new Error('before-run rejected')
            let shouldFail = true
            const datadogHandler = sinon.spy(() => {
              if (shouldFail && failingHandler === 'datadog') throw rejection
            })
            resolved.isInteractive = isInteractive
            setupHandlers(mode, () => {
              if (shouldFail && failingHandler === 'user') throw rejection
            }, datadogHandler)

            assert.ok(fs.existsSync(resolved.supportFile))
            await assert.rejects(handlers['before:run']({}), error => error === rejection)
            assert.strictEqual(fs.existsSync(resolved.supportFile), isInteractive)
            if (isInteractive) {
              shouldFail = false
              datadogHandler.resetHistory()
              await handlers['before:run']({})
              sinon.assert.calledOnce(datadogHandler)
              await handlers['after:run']({})
              assert.ok(fs.existsSync(resolved.supportFile))
            }
          })
      }
    }
  }
})

describe('Cypress config', () => {
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
