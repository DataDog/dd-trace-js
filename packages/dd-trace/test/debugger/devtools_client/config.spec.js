'use strict'

const assert = require('node:assert/strict')
const { MessageChannel } = require('node:worker_threads')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')

require('../../setup/mocha')

describe('devtools_client/config', () => {
  function loadConfig (parentConfig = {}) {
    const configChannel = new MessageChannel()
    const config = proxyquire('../../../src/debugger/devtools_client/config', {
      'node:worker_threads': {
        workerData: {
          config: {
            url: 'http://localhost:8126',
            dynamicInstrumentation: { captureTimeoutMs: 100 },
            runtimeId: 'initial-id',
            ...parentConfig,
          },
          parentThreadId: 1,
          configPort: configChannel.port1,
        },
      },
    })
    return { config, configChannel }
  }

  it('seeds the config from the worker data snapshot', () => {
    const { config } = loadConfig()

    assert.strictEqual(config.url.toString(), 'http://localhost:8126/')
    assert.strictEqual(config.dynamicInstrumentation.captureTimeoutNs, 100_000_000n)
    assert.strictEqual(config.runtimeId, 'initial-id')
  })

  it('applies url, captureTimeoutNs and runtimeId from an update received over the config port', (done) => {
    const { config, configChannel } = loadConfig()

    // Registered after the module's own `configPort.on('message', updateConfig)` listener, so it
    // runs after `updateConfig` has already applied the update.
    configChannel.port1.on('message', () => {
      assert.strictEqual(config.url.toString(), 'http://updated:8126/')
      assert.strictEqual(config.dynamicInstrumentation.captureTimeoutNs, 5_000_000n)
      assert.strictEqual(config.runtimeId, 'reseeded-id')
      done()
    })

    configChannel.port2.postMessage({
      url: 'http://updated:8126',
      dynamicInstrumentation: { captureTimeoutMs: 5 },
      runtimeId: 'reseeded-id',
    })
  })
})
