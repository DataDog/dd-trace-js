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
      'remoteConfig',
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

  it('should configure the direct debugger intake in agentless mode', function () {
    const tracerConfig = getConfig()
    tracerConfig.DD_AGENTLESS_ENABLED = true
    tracerConfig.DD_API_KEY = 'test-api-key'
    tracerConfig.site = 'us3.datadoghq.com'
    tracerConfig.remoteConfig.pollInterval = 0.1

    const config = getDebuggerConfig(tracerConfig)

    assert.strictEqual(config.agentless, true)
    assert.strictEqual(config.apiKey, 'test-api-key')
    assert.strictEqual(config.url, 'https://debugger-intake.us3.datadoghq.com')
    assertObjectContains(config.remoteConfig, {
      runtimeId: tracerConfig.tags['runtime-id'],
      service: tracerConfig.service,
      env: tracerConfig.env ?? '',
      appVersion: tracerConfig.version ?? '',
      language: 'node',
      url: 'https://us3.datadoghq.com',
      timeoutMs: 5000,
      retryIntervalMs: 100,
      apiKey: 'test-api-key',
    })
    assert.ok(config.remoteConfig.tags.includes(`git.commit.sha:${COMMIT_SHA}`))
    assert.ok(config.remoteConfig.tags.includes(`git.repository_url:${REPOSITORY_URL}`))
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
