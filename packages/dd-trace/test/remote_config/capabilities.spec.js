'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')

const { RemoteConfigFetcher } = require('@datadog/libdatadog/remote-config')

require('../setup/core')

const capabilities = require('../../src/remote_config/capabilities')

describe('remote config capabilities', () => {
  // Agentless mode forwards capability names to libdatadog, which reports the ones it does not know.
  it('are recognised by the libdatadog fetcher', () => {
    const fetcher = new RemoteConfigFetcher({
      clientId: 'client-id',
      runtimeId: 'runtime-id',
      service: 'service',
      env: '',
      appVersion: '',
      tags: [],
      processTags: [],
      language: 'node',
      tracerVersion: '0.0.0',
      url: 'https://config.invalid',
      timeoutMs: 1000,
      apiKey: 'dummy',
      hostname: 'hostname',
    })

    try {
      const unrecognized = fetcher.setProductCapabilities([], Object.keys(capabilities))

      // SDK_CONFIGURATION is not in libdatadog's enum yet; it may be added later.
      assert.deepStrictEqual(unrecognized.filter(name => name !== 'SDK_CONFIGURATION'), [])
      assert.deepStrictEqual(fetcher.setProductCapabilities([], ['APM_TRACING_DATA_STREAMS_ENABLED']), [])
    } finally {
      fetcher.free()
    }
  })
})
