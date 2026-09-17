'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

const { DEFAULT_QUEUE_MAX_BYTES } = require('../../../src/debugger/constants')

require('../../setup/mocha')

describe('worker thread config', function () {
  let configPort
  let parentConfig

  beforeEach(function () {
    configPort = { on: sinon.stub() }
    parentConfig = {
      dynamicInstrumentation: {
        captureTimeoutMs: 15,
        uploadIntervalSeconds: 1,
      },
      url: 'http://localhost:8126',
    }
  })

  it('should use the default queue limit', function () {
    const config = loadConfig()

    assert.strictEqual(config.queueMaxBytes, DEFAULT_QUEUE_MAX_BYTES)
    assert.strictEqual(config.dynamicInstrumentation.captureTimeoutNs, 15_000_000n)
    assert.strictEqual(parentConfig.queueMaxBytes, undefined)
  })

  function loadConfig () {
    const load = proxyquire.noPreserveCache()
    return load('../../../src/debugger/devtools_client/config', {
      'node:worker_threads': {
        workerData: { config: parentConfig, parentThreadId: 1, configPort },
        '@noCallThru': true,
      },
      '../../config/helper': {
        getEnvironmentVariable: sinon.stub(),
        '@noCallThru': true,
      },
      '../../process-tags': {
        initialize: sinon.stub(),
        '@noCallThru': true,
      },
      './log': {
        error: sinon.stub(),
        '@noCallThru': true,
      },
    })
  }
})
