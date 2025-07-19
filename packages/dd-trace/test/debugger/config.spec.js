'use strict'

require('../setup/mocha')

const assert = require('node:assert')
const getDebuggerConfig = require('../../src/debugger/config')
const Config = require('../../src/config')

describe('getDebuggerConfig', function () {
  it('should only contain the allowed properties', function () {
    const tracerConfig = new Config({
      url: new URL('http://example.com:1234')
    })
    const config = getDebuggerConfig(tracerConfig)
    assert.deepStrictEqual(Object.keys(config), [
      'commitSHA',
      'debug',
      'dynamicInstrumentation',
      'hostname',
      'logLevel',
      'port',
      'repositoryUrl',
      'runtimeId',
      'service',
      'url',
    ])
    assert.strictEqual(config.commitSHA, tracerConfig.commitSHA)
    assert.strictEqual(config.debug, tracerConfig.debug)
    assert.deepStrictEqual(config.dynamicInstrumentation, tracerConfig.dynamicInstrumentation)
    assert.strictEqual(config.hostname, tracerConfig.hostname)
    assert.strictEqual(config.logLevel, tracerConfig.logLevel)
    assert.strictEqual(config.port, tracerConfig.port)
    assert.strictEqual(config.repositoryUrl, tracerConfig.repositoryUrl)
    assert.strictEqual(config.runtimeId, tracerConfig.tags['runtime-id'])
    assert.strictEqual(config.service, tracerConfig.service)
    assert.strictEqual(config.url, tracerConfig.url.toString())
  })

  it('should be able to send the config over a MessageChannel', function () {
    const config = getDebuggerConfig(new Config())
    const channel = new MessageChannel()
    channel.port1.on('message', (message) => {
      assert.deepStrictEqual(message, config)
    })
    channel.port2.postMessage(config)
  })
})
