'use strict'

const { describe, it, beforeEach } = require('mocha')
const sinon = require('sinon')

const RemoteConfigCapabilities = require('../../src/remote_config/capabilities')
const { enable } = require('../../src/config/remote_config')

require('../setup/core')

describe('Tracing Remote Config', () => {
  let rc
  let config
  let onConfigUpdated
  let batchHandlers

  beforeEach(() => {
    batchHandlers = new Map()

    rc = {
      updateCapabilities: sinon.spy(),
      subscribeProducts: sinon.spy(),
      setBatchHandler: sinon.spy((products, handler) => {
        batchHandlers.set(products[0], handler)
      }),
    }

    config = {
      service: 'test-service',
      env: 'test-env',
      setRemoteConfig: sinon.spy(),
    }

    onConfigUpdated = sinon.spy()
  })

  describe('enable', () => {
    it('should register all APM tracing capabilities', () => {
      enable(rc, config, onConfigUpdated)

      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.APM_TRACING_MULTICONFIG, true)
      sinon.assert.calledWithExactly(rc.updateCapabilities, RemoteConfigCapabilities.SDK_CONFIGURATION, true)
    })

    it('should register a single APM_TRACING batch handler', () => {
      enable(rc, config, onConfigUpdated)

      sinon.assert.calledOnceWithExactly(rc.subscribeProducts, 'APM_TRACING')
      sinon.assert.calledOnceWithExactly(rc.setBatchHandler, ['APM_TRACING'], sinon.match.func)
    })

    describe('SDK_CONFIGURATION handler', () => {
      it('should configure tracer on apply action', () => {
        enable(rc, config, onConfigUpdated)

        const handler = batchHandlers.get('APM_TRACING')
        const sdkConfig = { DD_TRACE_SAMPLE_RATE: '0.5' }

        const transaction = createTransaction([
          { id: 'config-1', file: { sdk_config: sdkConfig } },
        ])

        handler(transaction)

        sinon.assert.calledOnceWithExactly(config.setRemoteConfig, sdkConfig)
        sinon.assert.calledOnce(onConfigUpdated)
      })

      it('should reset config on unapply action', () => {
        enable(rc, config, onConfigUpdated)

        const handler = batchHandlers.get('APM_TRACING')

        // First apply a config
        let transaction = createTransaction([
          { id: 'config-1', file: { sdk_config: { DD_TRACE_ENABLED: 'true' } } },
        ])
        handler(transaction)

        config.setRemoteConfig.resetHistory()
        onConfigUpdated.resetHistory()

        // Then unapply it
        transaction = createTransaction([], [], [
          { id: 'config-1', file: { sdk_config: { DD_TRACE_ENABLED: 'true' } } },
        ])
        handler(transaction)

        // When all configs are removed, null is passed to reset
        sinon.assert.calledWithExactly(config.setRemoteConfig, null)
        sinon.assert.calledOnce(onConfigUpdated)
      })

      it('should call setRemoteConfig only once per batch', () => {
        enable(rc, config, onConfigUpdated)

        const handler = batchHandlers.get('APM_TRACING')

        // Apply multiple configs in a single batch
        const transaction = createTransaction([
          { id: 'config-1', file: { sdk_config: { DD_TRACE_SAMPLE_RATE: '0.5' } } },
          { id: 'config-2', file: { sdk_config: { DD_LOGS_INJECTION: 'true' } } },
          { id: 'config-3', file: { sdk_config: { DD_TRACE_ENABLED: 'true' } } },
        ])

        handler(transaction)

        // Should be called exactly once, not three times
        sinon.assert.calledOnce(config.setRemoteConfig)
        sinon.assert.calledOnce(onConfigUpdated)
      })

      it('should ignore items with no sdk_config field', () => {
        enable(rc, config, onConfigUpdated)

        const handler = batchHandlers.get('APM_TRACING')

        const transaction = createTransaction([
          { id: 'config-1', file: { some_other_shape: { foo: 'bar' } } },
        ])

        handler(transaction)

        sinon.assert.calledOnceWithExactly(config.setRemoteConfig, null)
        sinon.assert.calledOnce(onConfigUpdated)
      })

      it('should filter out unsupported keys without affecting allowlisted ones', () => {
        enable(rc, config, onConfigUpdated)

        const handler = batchHandlers.get('APM_TRACING')
        const sdkConfig = buildPayloadWithKeyCount(1000)

        const transaction = createTransaction([
          { id: 'config-1', file: { sdk_config: sdkConfig } },
        ])

        handler(transaction)

        // A large number of unsupported keys must not crowd out an allowlisted one
        sinon.assert.calledOnceWithExactly(config.setRemoteConfig, { DD_TRACE_ENABLED: 'true' })
      })
    })
  })

  describe('SDK_CONFIGURATION multiconfig', () => {
    it('should merge multiple configs by priority', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Apply both an org-level and a service-level config in one batch
      const transaction = createTransaction([
        {
          id: 'config-org',
          file: {
            service_target: { service: '*', env: '*' },
            sdk_config: { DD_TRACE_SAMPLE_RATE: '0.5' },
          },
        },
        {
          id: 'config-service',
          file: {
            service_target: { service: 'test-service', env: '*' },
            sdk_config: { DD_TRACE_SAMPLE_RATE: '0.8' },
          },
        },
      ])

      handler(transaction)

      // Service config should win
      sinon.assert.calledOnceWithExactly(config.setRemoteConfig, { DD_TRACE_SAMPLE_RATE: '0.8' })
    })

    it('should handle config removal', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Add two configs
      let transaction = createTransaction([{
        id: 'config-1',
        file: {
          service_target: { service: '*', env: '*' },
          sdk_config: { DD_TRACE_SAMPLE_RATE: '0.5' },
        },
      }, {
        id: 'config-2',
        file: {
          service_target: { service: 'test-service', env: '*' },
          sdk_config: { DD_TRACE_SAMPLE_RATE: '0.8' },
        },
      }])
      handler(transaction)

      config.setRemoteConfig.resetHistory()

      // Remove higher priority config
      transaction = createTransaction([], [], [
        {
          id: 'config-2',
          file: {
            service_target: { service: 'test-service', env: '*' },
            sdk_config: { DD_TRACE_SAMPLE_RATE: '0.8' },
          },
        },
      ])
      handler(transaction)

      // Lower priority should now apply
      sinon.assert.calledOnceWithExactly(config.setRemoteConfig, { DD_TRACE_SAMPLE_RATE: '0.5' })
    })

    it('should filter configs by service/env', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Apply config for different service
      const transaction = createTransaction([{
        id: 'config-other',
        file: {
          service_target: { service: 'other-service', env: '*' },
          sdk_config: { DD_TRACE_SAMPLE_RATE: '0.9' },
        },
      }])

      handler(transaction)

      // Should be ignored, so null is passed to reset all RC fields
      sinon.assert.calledWithExactly(config.setRemoteConfig, null)
    })

    it('should return null when configs have no sdk_config field', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Apply a config that has sdk_config set to null
      const transaction = createTransaction([
        {
          id: 'config-1',
          file: {
            service_target: { service: 'test-service', env: '*' },
            sdk_config: null,
          },
        },
      ])

      handler(transaction)

      sinon.assert.calledOnceWithExactly(config.setRemoteConfig, null)
      sinon.assert.calledOnce(onConfigUpdated)
    })

    it('should merge fields from multiple configs', () => {
      enable(rc, config, onConfigUpdated)
      const handler = batchHandlers.get('APM_TRACING')

      // Apply both an org-level and a service-level config in one batch
      const transaction = createTransaction([{
        id: 'config-org',
        file: {
          service_target: { service: '*', env: '*' },
          sdk_config: {
            DD_TRACE_SAMPLE_RATE: '0.5',
            DD_LOGS_INJECTION: 'true',
          },
        },
      }, {
        id: 'config-service',
        file: {
          service_target: { service: 'test-service', env: '*' },
          sdk_config: {
            DD_TRACE_SAMPLE_RATE: '0.8',
          },
        },
      }])

      handler(transaction)

      // Service config sample rate should win, but logs injection should come from org
      sinon.assert.calledOnceWithExactly(config.setRemoteConfig, {
        DD_TRACE_SAMPLE_RATE: '0.8',
        DD_LOGS_INJECTION: 'true',
      })
    })
  })
})

function buildPayloadWithKeyCount (keyCount) {
  const payload = { DD_TRACE_ENABLED: 'true' }
  for (let i = 1; i < keyCount; i++) {
    payload[`KEY_${i}`] = 'value'
  }
  return payload
}

function createTransaction (toApply = [], toModify = [], toUnapply = []) {
  const addDefaults = (item) => ({
    product: 'APM_TRACING',
    path: `datadog/1/APM_TRACING/${item.id}`,
    ...item,
  })

  return {
    toApply: toApply.map(addDefaults),
    toModify: toModify.map(addDefaults),
    toUnapply: toUnapply.map(addDefaults),
    ack: () => {},
    error: () => {},
  }
}
