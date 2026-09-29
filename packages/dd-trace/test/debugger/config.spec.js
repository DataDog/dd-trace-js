'use strict'

const assert = require('node:assert/strict')
const { MessageChannel } = require('node:worker_threads')

const proxyquire = require('proxyquire')
const sinon = require('sinon')

const getConfig = require('../../src/config')

require('../setup/mocha')
const { assertObjectContains } = require('../../../../integration-tests/helpers')

const COMMIT_SHA = 'b7b5dfa992008c77ab3f8a10eb8711e0092445b0'
const REPOSITORY_URL = 'git@github.com:DataDog/dd-trace-js.git'

const getDebuggerConfig = proxyquire('../../src/debugger/config', {
  '../git_metadata': () => ({ commitSHA: COMMIT_SHA, repositoryUrl: REPOSITORY_URL }),
})

describe('getDebuggerConfig', function () {
  it('should only contain the allowed properties', function () {
    const tracerConfig = getConfig({
      url: new URL('http://example.com:1234'),
    })
    const config = getDebuggerConfig(tracerConfig)
    assert.deepStrictEqual(Object.keys(config), [
      'agentless',
      'apiKey',
      'commitSHA',
      'debug',
      'dynamicInstrumentation',
      'env',
      'hostname',
      'logLevel',
      'port',
      'propagateProcessTags',
      'repositoryUrl',
      'runtimeId',
      'service',
      'url',
      'version',
      'inputPath',
    ])
    assertObjectContains(config, {
      agentless: false,
      commitSHA: COMMIT_SHA,
      debug: tracerConfig.debug,
      dynamicInstrumentation: tracerConfig.dynamicInstrumentation,
      env: tracerConfig.env,
      hostname: tracerConfig.hostname,
      logLevel: tracerConfig.logLevel,
      port: tracerConfig.port,
      repositoryUrl: REPOSITORY_URL,
      runtimeId: tracerConfig.tags['runtime-id'],
      service: tracerConfig.service,
      url: tracerConfig.url.toString(),
      version: tracerConfig.version,
    })
  })

  it('should be able to send the config over a MessageChannel', function () {
    const config = getDebuggerConfig(getConfig())
    const channel = new MessageChannel()
    channel.port1.on('message', (message) => {
      assert.deepStrictEqual(message, config)
    })
    channel.port2.postMessage(config)
  })
})

describe('Debugger worker config', () => {
  it('converts the canonical capture timeout to nanoseconds on initialization and update', () => {
    /** @type {((config: NonNullable<ReturnType<import('../../src/debugger/config')>>) => void) | undefined} */
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
    const config = proxyquire('../../src/debugger/devtools_client/config', {
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
