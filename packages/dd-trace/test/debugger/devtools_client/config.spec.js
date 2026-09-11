'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')
const sinon = require('sinon')

require('../../setup/mocha')

/**
 * @typedef {{
 *   url: string,
 *   dynamicInstrumentation: { DD_DYNAMIC_INSTRUMENTATION_CAPTURE_TIMEOUT_MS: number }
 * }} WorkerConfig
 */

describe('Debugger worker config', () => {
  it('converts the canonical capture timeout to nanoseconds on initialization and update', () => {
    /** @type {((config: WorkerConfig) => void) | undefined} */
    let onMessage
    const configPort = {
      on: sinon.spy((event, listener) => {
        if (event === 'message') onMessage = listener
      }),
    }
    const processTags = {
      initialize: sinon.spy(),
      '@noCallThru': true,
    }
    const config = proxyquire('../../../src/debugger/devtools_client/config', {
      'node:worker_threads': {
        workerData: {
          config: {
            url: 'http://localhost:8126',
            dynamicInstrumentation: {
              DD_DYNAMIC_INSTRUMENTATION_CAPTURE_TIMEOUT_MS: 15,
            },
          },
          parentThreadId: 42,
          configPort,
        },
      },
      '../../process-tags': processTags,
      './log': {
        error: sinon.spy(),
        '@noCallThru': true,
      },
    })

    assert.strictEqual(config.dynamicInstrumentation.captureTimeoutNs, 15_000_000n)
    assert.ok(onMessage)
    onMessage({
      url: 'http://localhost:8126',
      dynamicInstrumentation: {
        DD_DYNAMIC_INSTRUMENTATION_CAPTURE_TIMEOUT_MS: 30,
      },
    })
    assert.strictEqual(config.dynamicInstrumentation.captureTimeoutNs, 30_000_000n)
    sinon.assert.calledOnce(processTags.initialize)
  })
})
