'use strict'

const assert = require('node:assert/strict')

const { describe, it, beforeEach } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/mocha')

describe('devtools_client/config', () => {
  let config
  let onConfigPortMessage
  let parentConfig

  beforeEach(() => {
    parentConfig = {
      url: 'http://localhost:8126',
      dynamicInstrumentation: { captureTimeoutMs: 100 },
      runtimeId: 'initial-id',
    }

    const configPort = {
      on: sinon.stub().callsFake((event, handler) => {
        if (event === 'message') onConfigPortMessage = handler
      }),
    }

    config = proxyquire('../../../src/debugger/devtools_client/config', {
      'node:worker_threads': {
        workerData: {
          config: parentConfig,
          parentThreadId: 1,
          configPort,
        },
      },
      '../../process-tags': { initialize: sinon.stub() },
      './log': { error: sinon.stub() },
    })
  })

  it('should apply the runtime id received in the initial config snapshot', () => {
    assert.strictEqual(config.runtimeId, 'initial-id')
  })

  it('should apply an updated runtime id from a later config-port message', () => {
    // Simulates `debugger/index.js#configure()` pushing a fresh config after a MicroVM
    // clone resume regenerates `config.tags['runtime-id']`.
    onConfigPortMessage({
      url: 'http://localhost:8126',
      dynamicInstrumentation: { captureTimeoutMs: 200 },
      runtimeId: 'refreshed-id',
    })

    assert.strictEqual(config.runtimeId, 'refreshed-id')
  })
})
