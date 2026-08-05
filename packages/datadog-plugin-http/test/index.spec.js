'use strict'

const assert = require('node:assert/strict')
const path = require('node:path')

const { describe, it, beforeEach, afterEach } = require('mocha')

require('../../dd-trace/test/setup/core')

const pubsubPluginPath = require.resolve(
  '../../datadog-plugin-google-cloud-pubsub/src/pubsub-push-subscription'
)
const httpPluginPath = require.resolve('../src')

function freshHttpPlugin () {
  delete require.cache[httpPluginPath]
  delete require.cache[pubsubPluginPath]
  return require('../src')
}

describe('HttpPlugin composite plugins', () => {
  const originalKService = process.env.K_SERVICE
  const originalGcpPubsubPush = process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED

  beforeEach(() => {
    delete require.cache[pubsubPluginPath]
  })

  afterEach(() => {
    if (originalKService === undefined) delete process.env.K_SERVICE
    else process.env.K_SERVICE = originalKService
    if (originalGcpPubsubPush === undefined) delete process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED
    else process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED = originalGcpPubsubPush
  })

  it('does not load the pubsub push-subscription plugin when GCP push is disabled', () => {
    delete process.env.K_SERVICE
    const HttpPlugin = freshHttpPlugin()

    const names = Object.keys(HttpPlugin.plugins)

    assert.deepStrictEqual(names, ['server', 'client'])
    assert.strictEqual(
      require.cache[pubsubPluginPath],
      undefined,
      'the pubsub push-subscription module must not be required when the GCP push gate is off'
    )
  })

  it('loads the pubsub push-subscription plugin first when GCP push is enabled', () => {
    process.env.K_SERVICE = 'svc'
    process.env.DD_TRACE_GCP_PUBSUB_PUSH_ENABLED = 'true'
    const HttpPlugin = freshHttpPlugin()

    const names = Object.keys(HttpPlugin.plugins)

    assert.strictEqual(names[0], 'pubsub-push-subscription')
    assert.deepStrictEqual(names, ['pubsub-push-subscription', 'server', 'client'])
    assert.strictEqual(path.isAbsolute(pubsubPluginPath), true)
    assert.notStrictEqual(require.cache[pubsubPluginPath], undefined)
  })
})
