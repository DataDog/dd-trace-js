'use strict'

const assert = require('node:assert/strict')
const { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const log = require('../../dd-trace/src/log')
const { wrapCliConfigFileOptions } = require('../src/cypress-config')

describe('Cypress config', () => {
  it('loads and wraps an ESM config', async () => {
    const project = mkdtempSync(join(tmpdir(), 'dd-cypress-config-'))
    const configFile = join(project, 'cypress.config.mjs')
    writeFileSync(configFile, `
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
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('loads and wraps a CommonJS config', () => {
    const project = mkdtempSync(join(tmpdir(), 'dd-cypress-config-'))
    const configFile = join(project, 'cypress.config.cjs')
    writeFileSync(configFile, `
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
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('reports every failed config-wrapper location', () => {
    const project = mkdtempSync(join(tmpdir(), 'dd-cypress-config-'))
    const configDirectory = join(project, 'config')
    const configFile = join(configDirectory, 'cypress.config.cjs')
    const options = { project, configFile }
    mkdirSync(configDirectory)
    writeFileSync(configFile, 'module.exports = {}')
    const warn = sinon.stub(log, 'warn')

    try {
      chmodSync(configDirectory, 0o500)
      chmodSync(project, 0o500)

      const wrapped = wrapCliConfigFileOptions(options)

      assert.strictEqual(wrapped.options, options)
      assert.match(warn.firstCall.args[2], /; /)
    } finally {
      chmodSync(project, 0o700)
      chmodSync(configDirectory, 0o700)
      warn.restore()
      rmSync(project, { recursive: true, force: true })
    }
  })
})
