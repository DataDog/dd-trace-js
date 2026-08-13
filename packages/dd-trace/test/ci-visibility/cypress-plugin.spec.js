'use strict'

const assert = require('node:assert/strict')

const { afterEach, describe, it } = require('mocha')
const sinon = require('sinon')

require('../setup/core')

const cypressPlugin = require('../../../datadog-plugin-cypress/src/cypress-plugin')

describe('Cypress plugin run lifecycle', () => {
  const originalState = {
    cypressConfig: cypressPlugin.cypressConfig,
    isInit: cypressPlugin._isInit,
    libraryConfigurationPromise: cypressPlugin.libraryConfigurationPromise,
    hasOriginalCypressRetries: cypressPlugin.hasOriginalCypressRetries,
    originalCypressRetries: cypressPlugin.originalCypressRetries,
    tracer: cypressPlugin.tracer,
  }

  afterEach(() => {
    cypressPlugin.cypressConfig = originalState.cypressConfig
    cypressPlugin._isInit = originalState.isInit
    cypressPlugin.libraryConfigurationPromise = originalState.libraryConfigurationPromise
    cypressPlugin.hasOriginalCypressRetries = originalState.hasOriginalCypressRetries
    cypressPlugin.originalCypressRetries = originalState.originalCypressRetries
    cypressPlugin.tracer = originalState.tracer
    sinon.restore()
  })

  it('waits for the existing initialization before the first run', async () => {
    const initializationError = new Error('stop after existing initialization')
    cypressPlugin._isInit = true
    cypressPlugin.libraryConfigurationPromise = Promise.reject(initializationError)
    const init = sinon.stub(cypressPlugin, 'init')

    await assert.rejects(cypressPlugin.beforeRun({}), error => {
      assert.strictEqual(error, initializationError)
      return true
    })

    sinon.assert.notCalled(init)
  })

  it('reinitializes before a subsequent interactive run', async () => {
    const initializationError = new Error('stop after reinitialization')
    const tracer = {}
    const cypressConfig = {}
    cypressPlugin._isInit = false
    cypressPlugin.tracer = tracer
    cypressPlugin.cypressConfig = cypressConfig
    const init = sinon.stub(cypressPlugin, 'init').rejects(initializationError)

    await assert.rejects(cypressPlugin.beforeRun({}), error => {
      assert.strictEqual(error, initializationError)
      return true
    })

    sinon.assert.calledOnceWithExactly(init, tracer, cypressConfig)
  })

  it('restores user retries before requesting configuration for a subsequent run', async () => {
    const cypressConfig = { retries: { openMode: 1, runMode: 2 }, version: '12.0.0' }
    cypressPlugin.cypressConfig = cypressConfig
    cypressPlugin.hasOriginalCypressRetries = true
    cypressPlugin.originalCypressRetries = { openMode: 1, runMode: 2 }
    cypressConfig.retries.runMode = 5

    const tracer = {
      _tracer: {
        _config: { isServiceUserProvided: false },
      },
    }

    const result = await cypressPlugin.init(tracer, cypressConfig)

    assert.strictEqual(result.retries.openMode, 1)
    assert.strictEqual(result.retries.runMode, 2)
  })
})
