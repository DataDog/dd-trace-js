'use strict'

const assert = require('node:assert')
const { MessageChannel } = require('node:worker_threads')

const getDebuggerConfig = require('../../src/debugger/config')
const getConfig = require('../../src/config')

require('../setup/mocha')
const { assertObjectContains } = require('../../../../integration-tests/helpers')

describe('getDebuggerConfig', function () {
  it('should only contain the allowed properties', function () {
    const tracerConfig = getConfig({
      url: new URL('http://example.com:1234'),
    })
    const config = getDebuggerConfig(tracerConfig)
    assert.deepStrictEqual(Object.keys(config), [
      'commitSHA',
      'debug',
      'dynamicInstrumentation',
      'hostname',
      'logLevel',
      'port',
      'propagateProcessTags',
      'repositoryUrl',
      'runtimeId',
      'service',
      'url',
    ])
    assertObjectContains(config, {
      commitSHA: tracerConfig.commitSHA,
      debug: tracerConfig.debug,
      dynamicInstrumentation: tracerConfig.dynamicInstrumentation,
      hostname: tracerConfig.hostname,
      logLevel: tracerConfig.logLevel,
      port: tracerConfig.port,
      repositoryUrl: tracerConfig.repositoryUrl,
      runtimeId: tracerConfig.tags['runtime-id'],
      service: tracerConfig.service,
      url: tracerConfig.url.toString(),
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
