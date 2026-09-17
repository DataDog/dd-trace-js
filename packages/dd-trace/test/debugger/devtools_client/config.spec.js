'use strict'

const assert = require('node:assert/strict')

const { beforeEach, describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/mocha')

const QUEUE_MAX_BYTES = 64 * 1024

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

  it('should get the queue limit from constants', function () {
    const config = loadConfig()

    assert.strictEqual(config.queueMaxBytes, QUEUE_MAX_BYTES)
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
      '../../process-tags': {
        initialize: sinon.stub(),
        '@noCallThru': true,
      },
      '../constants': {
        DEFAULT_QUEUE_MAX_BYTES: QUEUE_MAX_BYTES,
        '@noCallThru': true,
      },
      './log': {
        error: sinon.stub(),
        '@noCallThru': true,
      },
    })
  }
})
