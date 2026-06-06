'use strict'

const assert = require('node:assert')
const { MessageChannel } = require('node:worker_threads')

const proxyquire = require('proxyquire')

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

  it('should resolve url from host/port when CI Visibility agentless leaves it empty', function () {
    const previous = process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED
    process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED = 'true'
    let tracerConfig
    try {
      // Fresh config module so the singleton does not leak a `url` from another test.
      tracerConfig = proxyquire.noPreserveCache()('../../src/config', {})()
    } finally {
      if (previous === undefined) {
        delete process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED
      } else {
        process.env.DD_CIVISIBILITY_AGENTLESS_ENABLED = previous
      }
    }

    assert.strictEqual(tracerConfig.url, '')
    const config = getDebuggerConfig(tracerConfig)
    assert.strictEqual(config.url, `http://${tracerConfig.hostname}:${tracerConfig.port}`)
    assert.strictEqual(new URL(config.url).href, `http://${tracerConfig.hostname}:${tracerConfig.port}/`)
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
