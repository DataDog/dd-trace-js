'use strict'

const assert = require('node:assert/strict')

const { describe, it } = require('mocha')
const proxyquire = require('proxyquire')

require('./setup/core')

describe('tracer_metadata', () => {
  let storeConfig
  let TracerMetadata
  let storeMetadata
  let maybeLoad

  function makeStoreConfig (options = {}) {
    TracerMetadata = function (...args) { this.args = args }
    storeMetadata = function (metadata) { return metadata }
    maybeLoad = function () { return { TracerMetadata, storeMetadata } }

    return proxyquire('../src/tracer_metadata', {
      '@datadog/libdatadog': { maybeLoad },
      './exporters/common/docker': { containerId: options.containerId ?? undefined },
    })
  }

  describe('with propagateProcessTags enabled', () => {
    beforeEach(() => {
      storeConfig = makeStoreConfig()
    })

    it('should pass process tags as the 7th argument', () => {
      const config = {
        tags: { 'runtime-id': 'test-rid' },
        hostname: 'localhost',
        service: 'my-service',
        env: 'production',
        version: '1.0.0',
        propagateProcessTags: { enabled: true },
      }

      const result = storeConfig(config)
      const processTags = result.args[6]

      assert.ok(typeof processTags === 'string', 'process tags should be a string')
      assert.ok(processTags.includes('entrypoint.type:script'), 'should include entrypoint.type:script')
    })

    it('should pass empty string for process tags when disabled', () => {
      const config = {
        tags: { 'runtime-id': 'test-rid' },
        hostname: 'localhost',
        service: 'my-service',
        env: 'production',
        version: '1.0.0',
        propagateProcessTags: { enabled: false },
      }

      const result = storeConfig(config)
      assert.strictEqual(result.args[6], '')
    })

    it('should pass empty string for process tags when propagateProcessTags is not set', () => {
      const config = {
        tags: { 'runtime-id': 'test-rid' },
        hostname: 'localhost',
        service: 'my-service',
        env: 'production',
        version: '1.0.0',
      }

      const result = storeConfig(config)
      assert.strictEqual(result.args[6], '')
    })
  })

  describe('with container ID', () => {
    it('should pass container ID as the 8th argument', () => {
      const id = '34dc0b5e626f2c5c4c5170e34b10e7654ce36f0fcd532739f4445baabea03376'
      storeConfig = makeStoreConfig({ containerId: id })

      const config = {
        tags: { 'runtime-id': 'test-rid' },
        hostname: 'localhost',
        service: null,
        env: null,
        version: null,
      }

      const result = storeConfig(config)
      assert.strictEqual(result.args[7], id)
    })

    it('should pass empty string for container ID when not in a container', () => {
      storeConfig = makeStoreConfig({ containerId: undefined })

      const config = {
        tags: { 'runtime-id': 'test-rid' },
        hostname: 'localhost',
        service: null,
        env: null,
        version: null,
      }

      const result = storeConfig(config)
      assert.strictEqual(result.args[7], '')
    })
  })

  describe('when process-discovery is unavailable', () => {
    it('should return undefined without throwing', () => {
      const storeConfigNoBinding = proxyquire('../src/tracer_metadata', {
        '@datadog/libdatadog': { maybeLoad: () => undefined },
        './exporters/common/docker': { containerId: undefined },
      })

      const config = {
        tags: { 'runtime-id': 'test-rid' },
        hostname: 'localhost',
        service: null,
        env: null,
        version: null,
      }

      storeConfigNoBinding(config)
    })
  })
})
