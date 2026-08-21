'use strict'

const assert = require('node:assert/strict')
const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')

const { describe, it } = require('mocha')
const sinon = require('sinon')

const log = require('../../dd-trace/src/log')
const { wrapCliConfigFileOptions } = require('../src/cypress-config')

describe('Cypress config', () => {
  it('creates an ESM wrapper', () => {
    const project = mkdtempSync(join(tmpdir(), 'dd-cypress-config-'))
    const configFile = join(project, 'cypress.config.mjs')
    const cypressConfigPath = require.resolve('../src/cypress-config')
    writeFileSync(configFile, 'export default {}')

    const wrapped = wrapCliConfigFileOptions({ project, configFile })
    try {
      assert.strictEqual(
        readFileSync(wrapped.options.configFile, 'utf8'),
        `import originalConfig from ${JSON.stringify(pathToFileURL(configFile).href)}\n` +
        `import cypressConfig from ${JSON.stringify(pathToFileURL(cypressConfigPath).href)}\n\n` +
        'export default cypressConfig.wrapConfig(originalConfig)\n'
      )
    } finally {
      wrapped.cleanup()
      rmSync(project, { recursive: true, force: true })
    }
  })

  it('creates a CommonJS wrapper', () => {
    const project = mkdtempSync(join(tmpdir(), 'dd-cypress-config-'))
    const configFile = join(project, 'cypress.config.cjs')
    const cypressConfigPath = require.resolve('../src/cypress-config')
    writeFileSync(configFile, 'module.exports = {}')

    const wrapped = wrapCliConfigFileOptions({ project, configFile })
    try {
      assert.strictEqual(
        readFileSync(wrapped.options.configFile, 'utf8'),
        `const cypressConfig = require(${JSON.stringify(cypressConfigPath)})\n` +
        `const originalExports = require(${JSON.stringify(configFile)})\n` +
        'const originalConfig = originalExports && originalExports.__esModule\n' +
        '  ? originalExports.default\n' +
        '  : originalExports\n' +
        'module.exports = cypressConfig.wrapConfig(originalConfig)\n'
      )
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
